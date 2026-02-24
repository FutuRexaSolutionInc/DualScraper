const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('../utils/logger');
const { createCustomerRecord, delay } = require('../utils/helpers');

puppeteer.use(StealthPlugin());

/**
 * Facebook Scraper — FREE, Puppeteer-based (headless Chrome + stealth)
 *
 * Uses a real headless browser to navigate Facebook public pages.
 * Targets mbasic.facebook.com (lightweight HTML, easier to parse, less JS).
 *
 * Approach:
 *   1. Launch stealth browser
 *   2. Navigate to mbasic.facebook.com/{pageId} for post listings
 *   3. Visit individual posts to extract commenters
 *   4. Falls back to www.facebook.com if mbasic is blocked
 *   5. Apify fallback only if token provided AND Puppeteer got 0
 */
class FacebookScraper {
  constructor(apifyToken = null) {
    this.apifyToken = apifyToken;
    this.apifyClient = null;
    if (apifyToken) {
      try {
        const { ApifyClient } = require('apify-client');
        this.apifyClient = new ApifyClient({ token: apifyToken });
      } catch (_) {
        logger.debug('apify-client not available; Apify fallback disabled');
      }
    }
    this.MAX_POSTS = 10;       // max posts to check per page
    this.MAX_COMMENTS = 30;    // max commenters per post
    this.BROWSER_PATH = this._findBrowser();
  }

  _findBrowser() {
    const fs = require('fs');
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

  async _launchBrowser() {
    const opts = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US,en',
      ],
      defaultViewport: { width: 1920, height: 1080 },
    };
    if (this.BROWSER_PATH) opts.executablePath = this.BROWSER_PATH;
    return puppeteer.launch(opts);
  }

  /* ================================================================
     Main public API
     ================================================================ */

  /**
   * Scrape commenters/engagers from a brand's Facebook pages
   */
  async scrapePageCommenters(brandName, config) {
    const allCustomers = [];
    const pageIds = config.pageIds || [];

    logger.info(`[Facebook] Scraping ${brandName} Facebook (Puppeteer free mode)...`);

    for (const pageId of pageIds) {
      try {
        const customers = await this._scrapeFacebookPage(pageId, brandName);
        allCustomers.push(...customers);
        logger.info(`[Facebook] ${pageId}: found ${customers.length} customers`);
      } catch (err) {
        logger.warn(`[Facebook] Error scraping ${pageId}: ${err.message}`);
      }
      await delay(2000 + Math.random() * 3000);
    }

    // Apify fallback if Puppeteer got 0
    if (allCustomers.length === 0 && this.apifyClient) {
      logger.info('[Facebook] Puppeteer found 0, trying Apify fallback...');
      for (const pageId of pageIds) {
        try {
          const apifyCustomers = await this._apifyFallback(pageId, brandName);
          allCustomers.push(...apifyCustomers);
        } catch (err) {
          logger.warn(`[FB-Apify] Fallback failed: ${err.message}`);
        }
      }
    }

    logger.info(`[Facebook] Found ${allCustomers.length} customers from Facebook`);
    return allCustomers;
  }

  /* ================================================================
     mbasic.facebook.com scraping — Puppeteer
     ================================================================ */

  async _scrapeFacebookPage(pageId, brandName) {
    logger.info(`[FB-Puppeteer] Scraping page: ${pageId}`);
    let browser;
    try {
      browser = await this._launchBrowser();
      const page = await browser.newPage();

      // Strategy 1: mbasic.facebook.com (lightweight, easier to parse)
      let customers = await this._scrapeMbasic(page, pageId, brandName);

      // Strategy 2: www.facebook.com if mbasic got few results
      if (customers.length < 3) {
        logger.info(`[FB-Puppeteer] mbasic got ${customers.length}, trying www...`);
        const wwwCustomers = await this._scrapeWww(page, pageId, brandName);
        customers.push(...wwwCustomers);
      }

      await browser.close();
      return customers;
    } catch (err) {
      logger.warn(`[FB-Puppeteer] Page scrape failed for ${pageId}: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
      return [];
    }
  }

  /**
   * Scrape using mbasic.facebook.com (lightweight HTML)
   */
  async _scrapeMbasic(page, pageId, brandName) {
    const customers = [];
    const seen = new Set();

    try {
      const url = `https://mbasic.facebook.com/${pageId}`;
      logger.info(`[FB-Puppeteer] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(1500 + Math.random() * 1500);

      const content = await page.content();

      // Check for login wall
      if (content.includes('You must log in') || content.includes('Log in to Facebook')) {
        logger.info('[FB-Puppeteer] mbasic login wall detected, trying to extract any visible content...');
      }

      // Extract post links from the page
      const postLinks = await page.evaluate(() => {
        const links = [];
        const anchors = document.querySelectorAll('a[href*="/story.php"], a[href*="/photo.php"], a[href*="/permalink"]');
        anchors.forEach((a) => {
          const href = a.getAttribute('href');
          if (href && !links.includes(href)) {
            links.push(href);
          }
        });
        // Also look for post divs with comment links
        const commentLinks = document.querySelectorAll('a[href*="comment"]');
        commentLinks.forEach((a) => {
          const href = a.getAttribute('href');
          if (href && !links.includes(href)) {
            links.push(href);
          }
        });
        return links;
      });

      logger.info(`[FB-Puppeteer] Found ${postLinks.length} post links on mbasic`);

      // Also extract any visible profile links on the timeline (people who liked/commented)
      const timelineProfiles = await this._extractProfileLinks(page, pageId);
      for (const prof of timelineProfiles) {
        if (!seen.has(prof.username)) {
          seen.add(prof.username);
          customers.push(
            createCustomerRecord({
              name: prof.name,
              username: prof.username,
              profileUrl: prof.profileUrl,
              source: 'facebook',
              brand: brandName,
              comment: prof.comment || null,
              engagement: { type: 'comment' },
            })
          );
        }
      }

      // Visit each post for comments
      const postsToCheck = postLinks.slice(0, this.MAX_POSTS);
      for (const postLink of postsToCheck) {
        try {
          const fullUrl = postLink.startsWith('http')
            ? postLink
            : `https://mbasic.facebook.com${postLink}`;
          await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 20000 });
          await delay(1000 + Math.random() * 1500);

          const profiles = await this._extractProfileLinks(page, pageId);
          for (const prof of profiles) {
            if (!seen.has(prof.username)) {
              seen.add(prof.username);
              customers.push(
                createCustomerRecord({
                  name: prof.name,
                  username: prof.username,
                  profileUrl: prof.profileUrl,
                  source: 'facebook',
                  brand: brandName,
                  comment: prof.comment || null,
                  engagement: { type: 'comment' },
                })
              );
            }
          }
        } catch (err) {
          logger.debug(`[FB-Puppeteer] Error on post: ${err.message}`);
        }
        await delay(1000 + Math.random() * 1500);
      }
    } catch (err) {
      logger.warn(`[FB-Puppeteer] mbasic scrape error: ${err.message}`);
    }

    return customers;
  }

  /**
   * Scrape using www.facebook.com (full site, renders JS)
   */
  async _scrapeWww(page, pageId, brandName) {
    const customers = [];
    const seen = new Set();

    try {
      const url = `https://www.facebook.com/${pageId}/`;
      logger.info(`[FB-Puppeteer] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(3000 + Math.random() * 2000);

      // Scroll down to load more content
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await delay(2000);
      }

      // Extract profiles from visible comments/reactions
      const profiles = await page.evaluate((pid) => {
        const results = [];
        const seen = new Set();

        // Find all profile links in the page
        const links = document.querySelectorAll('a[href*="facebook.com/"], a[role="link"]');
        links.forEach((link) => {
          const href = link.getAttribute('href') || '';
          const text = link.textContent?.trim() || '';

          // Extract username/profile ID from the URL
          const profileMatch = href.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
          if (profileMatch) {
            const username = profileMatch[1];
            // Filter out non-profile links
            if (
              username &&
              username !== pid &&
              username.length > 1 &&
              username.length < 50 &&
              !['pages', 'groups', 'events', 'marketplace', 'watch', 'gaming',
                'login', 'help', 'policies', 'privacy', 'ads', 'settings',
                'profile.php', 'photo', 'video', 'reel', 'hashtag', 'share',
                'sharer', 'dialog', 'story'].includes(username.toLowerCase()) &&
              !username.startsWith('share') &&
              !username.startsWith('plugins') &&
              !seen.has(username)
            ) {
              seen.add(username);
              // Only include if the link text looks like a name (not a page/navigation link)
              if (text && text.length > 1 && text.length < 60 && !text.includes('\n')) {
                results.push({
                  username,
                  name: text,
                  profileUrl: `https://www.facebook.com/${username}`,
                });
              }
            }
          }
        });

        return results;
      }, pageId);

      for (const prof of profiles) {
        if (!seen.has(prof.username)) {
          seen.add(prof.username);
          customers.push(
            createCustomerRecord({
              name: prof.name,
              username: prof.username,
              profileUrl: prof.profileUrl,
              source: 'facebook',
              brand: brandName,
              engagement: { type: 'engagement' },
            })
          );
        }
      }

      logger.info(`[FB-Puppeteer] www.facebook.com extracted ${customers.length} profiles`);
    } catch (err) {
      logger.warn(`[FB-Puppeteer] www scrape error: ${err.message}`);
    }

    return customers;
  }

  /**
   * Extract profile links from the current page (mbasic)
   */
  async _extractProfileLinks(page, excludePageId) {
    try {
      return await page.evaluate((excludeId) => {
        const profiles = [];
        const seen = new Set();

        // Blocklist of non-profile usernames/IDs
        const blocklist = new Set([
          'home.php', 'login', 'login.php', 'story.php', 'photo.php', 'photo',
          'ufi', 'composer', 'privacy', 'help', 'pages', 'groups', 'a', 'comment',
          'mbasic', 'watch', 'marketplace', 'events', 'gaming', 'bookmarks',
          'settings', 'notifications', 'messages', 'friends', 'ads', 'policies',
          'hashtag', 'share', 'sharer', 'dialog', 'plugins', 'video', 'videos',
          'reel', 'reels', 'stories', 'permalink.php', 'feed', 'menu', 'legal',
          'about', 'terms', 'cookies', 'recover', 'signup', 'reg', 'checkpoint',
        ]);

        // Helper: check if text looks like a real person's name
        const looksLikeName = (text) => {
          if (!text || text.length < 2 || text.length > 60) return false;
          if (text.includes('\n') || text.includes('\t')) return false;
          // Skip common UI elements
          const uiWords = ['like', 'reply', 'share', 'comment', 'view', 'more',
            'sign up', 'log in', 'follow', 'write', 'see more', 'photo', 'video',
            'create', 'menu', 'search', 'home', 'page', 'watch'];
          const lower = text.toLowerCase();
          if (uiWords.includes(lower)) return false;
          // Must contain at least one letter
          if (!/[a-zA-Z]/.test(text)) return false;
          return true;
        };

        // Find all links that point to profiles
        const links = document.querySelectorAll('a[href]');
        links.forEach((el) => {
          const href = el.getAttribute('href') || '';
          const text = el.textContent?.trim() || '';

          let username = null;
          let profileUrl = '';

          // Match /profile.php?id=123456
          const idMatch = href.match(/profile\.php\?id=(\d+)/);
          if (idMatch) {
            username = idMatch[1];
            profileUrl = `https://www.facebook.com/profile.php?id=${username}`;
          }

          // Match /username or facebook.com/username (single path segment)
          if (!username) {
            const usernameMatch = href.match(/(?:mbasic|www|m)\.facebook\.com\/([a-zA-Z0-9._]{2,50})\/?(?:\?.*)?$/);
            if (usernameMatch) {
              username = usernameMatch[1];
              profileUrl = `https://www.facebook.com/${username}`;
            }
          }

          // Also match relative links like /username on mbasic
          if (!username) {
            const relMatch = href.match(/^\/([a-zA-Z0-9._]{2,50})\/?(?:\?.*)?$/);
            if (relMatch) {
              username = relMatch[1];
              profileUrl = `https://www.facebook.com/${username}`;
            }
          }

          if (
            username &&
            username.toLowerCase() !== excludeId.toLowerCase() &&
            !blocklist.has(username.toLowerCase()) &&
            !username.includes('.php') &&
            looksLikeName(text) &&
            !seen.has(username)
          ) {
            seen.add(username);

            // Try to get associated comment text
            let comment = '';
            const parentDiv = el.closest('div');
            if (parentDiv) {
              const textNodes = parentDiv.querySelectorAll('div > div');
              textNodes.forEach((node) => {
                const t = node.textContent?.trim() || '';
                if (t.length > 5 && t !== text && !t.match(/^(Like|Reply|Share|Comment|\\d+\\s*(h|m|d|w|y))/i)) {
                  comment = t.substring(0, 200);
                }
              });
            }

            profiles.push({
              username,
              name: text,
              profileUrl,
              comment,
            });
          }
        });

        return profiles;
      }, excludePageId);
    } catch {
      return [];
    }
  }

  /* ================================================================
     Apify fallback (last resort)
     ================================================================ */

  async _apifyFallback(pageId, brandName) {
    if (!this.apifyClient) return [];
    logger.info(`[FB-Apify] Using Apify for ${pageId} (max 15 posts to save credits)`);
    try {
      const run = await this.apifyClient.actor('apify/facebook-posts-scraper').call({
        startUrls: [{ url: `https://www.facebook.com/${pageId}` }],
        maxPosts: 15,
        maxComments: 30,
      });
      const { items } = await this.apifyClient.dataset(run.defaultDatasetId).listItems();
      const customers = [];
      for (const post of items || []) {
        const comments = [
          ...(post.topLevelComments || []),
          ...(post.latestComments || []),
          ...(post.comments || []),
        ];
        for (const comment of comments) {
          const name = comment.profileName || comment.name || '';
          const profileUrl = comment.profileUrl || comment.profileLink || '';
          if (name) {
            customers.push(
              createCustomerRecord({
                name,
                username: name.replace(/\s+/g, '.').toLowerCase(),
                profileUrl,
                source: 'facebook',
                brand: brandName,
                comment: comment.text || null,
                engagement: { type: 'comment', likes: comment.likesCount },
              })
            );
          }
        }
      }
      return customers;
    } catch (err) {
      logger.error(`[FB-Apify] Failed for ${pageId}: ${err.message}`);
      return [];
    }
  }
}

module.exports = FacebookScraper;

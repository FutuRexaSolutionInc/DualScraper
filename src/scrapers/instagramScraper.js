const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('../utils/logger');
const { createCustomerRecord, delay } = require('../utils/helpers');

puppeteer.use(StealthPlugin());

/**
 * Instagram Scraper — FREE, Puppeteer-based (headless Chrome + stealth)
 *
 * Uses a real headless browser to navigate Instagram like a human.
 * No API key, no login required — extracts from public profiles/posts.
 *
 * Approach:
 *   1. Launch stealth Chromium browser
 *   2. Navigate to profile page → extract post shortcodes
 *   3. For each post → navigate to post page → extract commenters
 *   4. Also scrape hashtag explore pages for additional customers
 *   5. Falls back to Apify only if token is provided AND Puppeteer found 0
 */
class InstagramScraper {
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
    this.MAX_POSTS = 12;      // max posts to check per profile
    this.MAX_COMMENTS = 30;   // max comments to extract per post
    this.BROWSER_PATH = this._findBrowser();
  }

  /**
   * Detect installed Chrome or Edge on Windows
   */
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
    // Fallback: try default puppeteer Chromium
    return undefined;
  }

  /**
   * Launch a stealth browser instance
   */
  async _launchBrowser() {
    const launchOpts = {
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
    if (this.BROWSER_PATH) {
      launchOpts.executablePath = this.BROWSER_PATH;
    }
    return puppeteer.launch(launchOpts);
  }

  /* ================================================================
     Main public API
     ================================================================ */

  /**
   * Scrape commenters/engagers from a brand's Instagram profiles and hashtags
   */
  async scrapeCommenters(brandName, config) {
    const allCustomers = [];
    const handles = config.handles || [];
    const hashtags = config.hashtags || [];

    logger.info(`[Instagram] Scraping ${brandName} Instagram (Puppeteer free mode)...`);

    // Scrape each profile handle
    for (const handle of handles) {
      try {
        const customers = await this._scrapeProfile(handle, brandName);
        allCustomers.push(...customers);
        logger.info(`[Instagram] @${handle}: found ${customers.length} customers`);
      } catch (err) {
        logger.warn(`[Instagram] Error scraping @${handle}: ${err.message}`);
      }
      await delay(2000 + Math.random() * 3000);
    }

    // Scrape hashtags
    for (const tag of hashtags) {
      try {
        const customers = await this._scrapeHashtag(tag, brandName);
        allCustomers.push(...customers);
        logger.info(`[Instagram] #${tag}: found ${customers.length} customers`);
      } catch (err) {
        logger.warn(`[Instagram] Error scraping #${tag}: ${err.message}`);
      }
      await delay(2000 + Math.random() * 3000);
    }

    // If Puppeteer got 0 and Apify is available, try Apify as last resort
    if (allCustomers.length === 0 && this.apifyClient) {
      logger.info('[Instagram] Puppeteer found 0, trying Apify fallback...');
      for (const handle of handles) {
        try {
          const apifyCustomers = await this._apifyProfileFallback(handle, brandName);
          allCustomers.push(...apifyCustomers);
        } catch (err) {
          logger.warn(`[IG-Apify] Fallback failed: ${err.message}`);
        }
      }
    }

    logger.info(`[Instagram] Found ${allCustomers.length} customers from Instagram`);
    return allCustomers;
  }

  /* ================================================================
     Profile scraping — Puppeteer
     ================================================================ */

  async _scrapeProfile(username, brandName) {
    logger.info(`[IG-Puppeteer] Scraping profile @${username}`);
    let browser;
    try {
      browser = await this._launchBrowser();
      const page = await browser.newPage();

      // Set cookies to dismiss login prompts
      await page.setCookie({
        name: 'ig_did',
        value: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
        domain: '.instagram.com',
      });

      // Navigate to profile
      const url = `https://www.instagram.com/${username}/`;
      logger.info(`[IG-Puppeteer] Navigating to ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000 + Math.random() * 2000);

      // Check for login wall / page not found
      const pageContent = await page.content();
      if (pageContent.includes('Page Not Found') || pageContent.includes("this page isn't available")) {
        logger.warn(`[IG-Puppeteer] Profile @${username} not found`);
        await browser.close();
        return [];
      }

      // Extract shortcodes from the page
      const shortcodes = await this._extractShortcodes(page);
      logger.info(`[IG-Puppeteer] Found ${shortcodes.length} post shortcodes for @${username}`);

      if (shortcodes.length === 0) {
        // Try extracting from page source JSON
        const jsonShortcodes = await this._extractShortcodesFromSource(page);
        shortcodes.push(...jsonShortcodes);
        logger.info(`[IG-Puppeteer] Found ${jsonShortcodes.length} shortcodes from page source`);
      }

      // Limit posts to check
      const postsToCheck = shortcodes.slice(0, this.MAX_POSTS);
      const customers = [];

      // Scrape comments from each post
      for (const shortcode of postsToCheck) {
        try {
          const postCustomers = await this._scrapePostComments(page, shortcode, username, brandName);
          customers.push(...postCustomers);
        } catch (err) {
          logger.debug(`[IG-Puppeteer] Error on post ${shortcode}: ${err.message}`);
        }
        await delay(1500 + Math.random() * 2500);
      }

      await browser.close();
      return customers;
    } catch (err) {
      logger.warn(`[IG-Puppeteer] Profile scrape failed for @${username}: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
      return [];
    }
  }

  /**
   * Extract post shortcodes from Instagram profile grid links
   */
  async _extractShortcodes(page) {
    try {
      const shortcodes = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        const codes = [];
        links.forEach((link) => {
          const href = link.getAttribute('href');
          const match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
          if (match && match[2] && !codes.includes(match[2])) {
            codes.push(match[2]);
          }
        });
        return codes;
      });
      return shortcodes;
    } catch {
      return [];
    }
  }

  /**
   * Try extracting shortcodes from embedded JSON in page source
   */
  async _extractShortcodesFromSource(page) {
    try {
      const html = await page.content();
      const codes = [];
      // Match shortcodes from various JSON patterns
      const patterns = [
        /"shortcode"\s*:\s*"([A-Za-z0-9_-]+)"/g,
        /\/p\/([A-Za-z0-9_-]+)\//g,
        /\/reel\/([A-Za-z0-9_-]+)\//g,
      ];
      for (const pattern of patterns) {
        let m;
        while ((m = pattern.exec(html)) !== null) {
          if (m[1] && !codes.includes(m[1]) && m[1].length > 5) {
            codes.push(m[1]);
          }
        }
      }
      return codes;
    } catch {
      return [];
    }
  }

  /**
   * Navigate to a post page and extract commenters
   */
  async _scrapePostComments(page, shortcode, profileUsername, brandName) {
    const postUrl = `https://www.instagram.com/p/${shortcode}/`;
    logger.debug(`[IG-Puppeteer] Checking post ${shortcode}`);

    try {
      await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 25000 });
      await delay(2000 + Math.random() * 2000);

      // Try to click "Load more comments" / "View all comments" buttons
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const loadMoreSelectors = [
            'button[aria-label*="Load more comments"]',
            'button[aria-label*="View all"]',
            'span[aria-label*="Load more"]',
            'button span:not(:empty)',
          ];
          let clicked = false;
          for (const sel of loadMoreSelectors) {
            const btns = await page.$$(sel);
            for (const btn of btns) {
              const text = await btn.evaluate((el) => el.textContent || '');
              if (text.match(/view|load|more|all.*comment/i)) {
                await btn.click();
                await delay(2000);
                clicked = true;
                break;
              }
            }
            if (clicked) break;
          }
          if (!clicked) break;
        } catch { break; }
      }

      // ── Strategy 1: Intercept embedded JSON data from page source ──
      // Instagram embeds post data (including comments) as JSON in the HTML
      const jsonCustomers = await page.evaluate((pUser) => {
        const results = [];
        const seen = new Set();

        // Instagram valid username regex: 1-30 chars, letters, numbers, dots, underscores
        const isValidUsername = (u) =>
          u &&
          /^[a-zA-Z0-9._]{1,30}$/.test(u) &&
          u !== pUser &&
          !['instagram', 'explore', 'reels', 'stories', 'accounts', 'about',
            'developer', 'legal', 'privacy', 'terms', 'help', 'press',
            'api', 'blog', 'jobs', 'nametag', 'session', 'login',
            'signup', 'sign_up', 'direct'].includes(u.toLowerCase());

        // Try to find comment data in embedded JSON (shared_data, additional_data, etc.)
        const scripts = document.querySelectorAll('script[type="application/json"]');
        scripts.forEach((script) => {
          try {
            const json = JSON.parse(script.textContent);
            const jsonStr = JSON.stringify(json);

            // Find username patterns in the JSON
            const usernameMatches = jsonStr.matchAll(/"username"\s*:\s*"([^"]+)"/g);
            for (const m of usernameMatches) {
              const username = m[1];
              if (isValidUsername(username) && !seen.has(username)) {
                seen.add(username);
                // Try to find associated full_name
                const nameRegex = new RegExp(`"username"\\s*:\\s*"${username}"[^}]*"full_name"\\s*:\\s*"([^"]*)"`, 'g');
                const nameMatch = nameRegex.exec(jsonStr);
                const name = nameMatch ? nameMatch[1] : username;
                results.push({ username, name: name || username, comment: '' });
              }
            }

            // Also try text/comment patterns
            const commentMatches = jsonStr.matchAll(/"text"\s*:\s*"([^"]{3,200})"/g);
            // (comments are paired with owners in the JSON structure)
          } catch { /* not valid JSON */ }
        });

        return results;
      }, profileUsername);

      // ── Strategy 2: DOM-based extraction of commenter usernames ──
      const domCustomers = await page.evaluate((pUser) => {
        const results = [];
        const seen = new Set();

        const isValidUsername = (u) =>
          u &&
          /^[a-zA-Z0-9._]{1,30}$/.test(u) &&
          u !== pUser &&
          !['instagram', 'explore', 'reels', 'stories', 'accounts', 'about',
            'developer', 'legal', 'privacy', 'terms', 'help', 'press',
            'api', 'blog', 'jobs', 'nametag', 'session', 'login',
            'signup', 'sign_up', 'direct', 'p', 'reel', 'tv',
            'Sign Up', 'Log In', 'Clip'].includes(u);

        // Find all <a> links on the page
        const allLinks = document.querySelectorAll('a[href]');

        allLinks.forEach((el) => {
          const href = el.getAttribute('href') || '';

          // Only match direct profile links: /username/ (single segment, no sub-paths)
          const profileMatch = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
          if (!profileMatch) return;

          const username = profileMatch[1];
          if (!isValidUsername(username) || seen.has(username)) return;

          const text = (el.textContent || '').trim();
          // Skip if the link text is generic navigation
          if (['Sign Up', 'Log In', 'Log in', 'Sign up', 'Clip', 'View',
               'More', 'Share', 'Save', 'Like', 'Reply', 'Follow',
               'Following', 'Message', 'Options', ''].includes(text)) return;

          // Only keep if the link text looks like a username or real name
          // (not a post title, not a multi-line string, not too long)
          if (text.length > 50 || text.includes('\n')) return;

          seen.add(username);

          // Try to find comment text near this element
          let commentText = '';
          const listItem = el.closest('li') || el.closest('div[role="button"]')?.parentElement;
          if (listItem) {
            const spans = listItem.querySelectorAll('span[dir="auto"]');
            spans.forEach((s) => {
              const t = (s.textContent || '').trim();
              if (t.length > 3 && t.length < 300 && t !== text && t !== username) {
                commentText = t;
              }
            });
          }

          results.push({
            username,
            name: text || username,
            comment: commentText,
          });
        });

        return results;
      }, profileUsername);

      // Merge both strategies, deduplicating by username
      const seen = new Set();
      const allCustomers = [];
      for (const c of [...jsonCustomers, ...domCustomers]) {
        if (!seen.has(c.username)) {
          seen.add(c.username);
          allCustomers.push(c);
        }
      }

      logger.debug(`[IG-Puppeteer] Post ${shortcode}: ${allCustomers.length} real commenters (JSON: ${jsonCustomers.length}, DOM: ${domCustomers.length})`);

      // Convert to customer records
      return allCustomers.slice(0, this.MAX_COMMENTS).map((c) =>
        createCustomerRecord({
          name: c.name,
          username: c.username,
          profileUrl: `https://www.instagram.com/${c.username}/`,
          source: 'instagram',
          brand: brandName,
          comment: c.comment || null,
          engagement: { type: 'comment', postCode: shortcode },
        })
      );
    } catch (err) {
      logger.debug(`[IG-Puppeteer] Failed to scrape post ${shortcode}: ${err.message}`);
      return [];
    }
  }

  /* ================================================================
     Hashtag scraping — Puppeteer
     ================================================================ */

  async _scrapeHashtag(hashtag, brandName) {
    logger.info(`[IG-Puppeteer] Scraping hashtag #${hashtag}`);
    let browser;
    try {
      browser = await this._launchBrowser();
      const page = await browser.newPage();

      const url = `https://www.instagram.com/explore/tags/${hashtag}/`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(2000 + Math.random() * 2000);

      // Check if we hit a login wall
      const content = await page.content();
      if (content.includes('Log in') && content.includes('Sign up') && !content.includes('/p/')) {
        logger.info(`[IG-Puppeteer] Login wall for #${hashtag}, trying to extract what we can...`);
      }

      // Extract post shortcodes
      const shortcodes = await this._extractShortcodes(page);
      if (shortcodes.length === 0) {
        const jsonShortcodes = await this._extractShortcodesFromSource(page);
        shortcodes.push(...jsonShortcodes);
      }

      logger.info(`[IG-Puppeteer] Found ${shortcodes.length} posts for #${hashtag}`);
      const postsToCheck = shortcodes.slice(0, this.MAX_POSTS);
      const customers = [];

      for (const shortcode of postsToCheck) {
        try {
          const postCustomers = await this._scrapePostComments(page, shortcode, '', brandName);
          customers.push(...postCustomers);
        } catch (err) {
          logger.debug(`[IG-Puppeteer] Error on hashtag post ${shortcode}: ${err.message}`);
        }
        await delay(1500 + Math.random() * 2500);
      }

      await browser.close();
      return customers;
    } catch (err) {
      logger.warn(`[IG-Puppeteer] Hashtag scrape failed for #${hashtag}: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
      return [];
    }
  }

  /* ================================================================
     Apify fallback (last resort when Puppeteer gets 0)
     ================================================================ */

  async _apifyProfileFallback(username, brandName) {
    if (!this.apifyClient) return [];
    logger.info(`[IG-Apify] Falling back to Apify for @${username}`);
    try {
      const run = await this.apifyClient.actor('apify/instagram-profile-scraper').call({
        usernames: [username],
        resultsLimit: 20,
      });
      const { items } = await this.apifyClient.dataset(run.defaultDatasetId).listItems();
      return (items || [])
        .filter((item) => item.ownerUsername && item.ownerUsername !== username)
        .map((item) =>
          createCustomerRecord({
            name: item.ownerFullName || item.ownerUsername,
            username: item.ownerUsername,
            profileUrl: `https://www.instagram.com/${item.ownerUsername}/`,
            source: 'instagram',
            brand: brandName,
            comment: item.text || null,
          })
        );
    } catch (err) {
      logger.warn(`[IG-Apify] Fallback failed: ${err.message}`);
      return [];
    }
  }

  /* ================================================================
     Custom Instagram scraping (single username, used by API)
     ================================================================ */

  async scrapeCustom(username) {
    logger.info(`[Instagram] Custom scrape for @${username}`);
    const customers = await this._scrapeProfile(username, 'Custom');
    return customers;
  }
}

module.exports = InstagramScraper;

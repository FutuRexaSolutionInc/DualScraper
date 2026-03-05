const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('../utils/logger');
const { createCustomerRecord, delay } = require('../utils/helpers');

puppeteer.use(StealthPlugin());

/**
 * Instagram Scraper — FREE, Apify-style (GraphQL API + Puppeteer session)
 *
 * Strategy (same as Apify internally):
 *   1. Launch stealth Chromium to establish a valid Instagram session
 *   2. Use Instagram's internal REST API for profile info + post list
 *   3. Use REST v1 API for paginated comments on each post
 *   4. Fallback cascade: REST v1 → GraphQL → XHR interception → DOM
 *   5. Single browser session shared across all handles (session reuse)
 *
 * No API key, no login, no Apify — 100% free.
 */
class InstagramScraper {
  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';
    this.MAX_POSTS = isProduction ? 15 : 30;               // scrape more posts for better client coverage
    this.MAX_COMMENTS_PER_POST = isProduction ? 80 : 200;  // fewer comments in prod
    this.IG_APP_ID = '936619743392459'; // Instagram's public web app ID
    this.BROWSER_PATH = this._findBrowser();
    this.isProduction = isProduction;
    this._discoveredLikers = new Map(); // shortcode -> [{username, fullName}] — likers found during comment extraction
    this._sessionCookie = null; // Optional Instagram session cookie for authenticated features
  }

  /* ================================================================
     Session Cookie Management (optional login)
     ================================================================ */

  /**
   * Set the Instagram session cookie for authenticated requests.
   * This enables follower/following list extraction and full liker lists.
   * @param {string} sessionId - The sessionid cookie value from browser DevTools
   */
  setSessionCookie(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Invalid session ID');
    }
    this._sessionCookie = sessionId.trim();
    logger.info('[IG-Auth] Session cookie set — authenticated features enabled');
  }

  /**
   * Clear the session cookie, reverting to unauthenticated mode.
   */
  clearSessionCookie() {
    this._sessionCookie = null;
    logger.info('[IG-Auth] Session cookie cleared — back to unauthenticated mode');
  }

  /**
   * Check if the scraper is in authenticated mode.
   */
  isAuthenticated() {
    return !!this._sessionCookie;
  }

  /**
   * Log in to Instagram with username + password via Puppeteer.
   * Extracts the session cookie on success and stores it.
   * @param {string} username - Instagram username or email
   * @param {string} password - Instagram password
   * @returns {{ success: boolean, message: string }}
   */
  /**
   * Open a visible browser window so the user can log in to Instagram manually.
   * Polls for the sessionid cookie and returns once detected.
   * @returns {{ success: boolean, message: string }}
   */
  async openLoginBrowser() {
    logger.info('[IG-Login] Opening Instagram login page for manual login...');

    // Prevent multiple login windows
    if (this._loginBrowser) {
      logger.warn('[IG-Login] Login browser already open');
      return { success: false, message: 'A login window is already open. Please complete login there.' };
    }

    let browser;
    try {
      browser = await this._launchBrowser({ headless: false, forLogin: true });
      this._loginBrowser = browser;
      const page = await browser.newPage();

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      await page.goto('https://www.instagram.com/accounts/login/', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
      logger.info('[IG-Login] Login page opened — waiting for user to log in...');

      // Poll for sessionid cookie (user logs in manually)
      const maxWaitMs = 180000; // 3 minutes
      const pollInterval = 2000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        // Check if browser was closed by user
        if (!browser.isConnected()) {
          this._loginBrowser = null;
          return { success: false, message: 'Login window was closed before completing login.' };
        }

        try {
          const cookies = await page.cookies('https://www.instagram.com');
          const sessionCookie = cookies.find((c) => c.name === 'sessionid' && c.value);
          if (sessionCookie) {
            this._sessionCookie = sessionCookie.value;
            logger.info('[IG-Login] Session cookie obtained! Closing login window...');
            await browser.close().catch(() => {});
            this._loginBrowser = null;
            return { success: true, message: 'Instagram connected successfully.' };
          }
        } catch {
          // Page might be navigating, ignore
        }

        await delay(pollInterval);
      }

      // Timeout
      await browser.close().catch(() => {});
      this._loginBrowser = null;
      logger.warn('[IG-Login] Login timed out after 3 minutes');
      return { success: false, message: 'Login timed out. Please try again.' };
    } catch (err) {
      logger.error(`[IG-Login] Error: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
      this._loginBrowser = null;
      return { success: false, message: `Login error: ${err.message}` };
    }
  }

  /* ================================================================
     Browser setup
     ================================================================ */

  _findBrowser() {
    const fs = require('fs');
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;

    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

  async _launchBrowser(opts = {}) {
    const isLogin = opts.forLogin || false;
    const headlessMode = opts.headless !== undefined ? opts.headless : 'new';
    const launchOpts = {
      headless: headlessMode,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US,en',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--disable-component-extensions-with-background-pages',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--disable-hang-monitor',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process',
        '--window-size=1280,900',
      ],
      defaultViewport: { width: 1280, height: 900 },
    };
    // Memory-saving flags only for headless/non-login mode
    if (!isLogin) {
      launchOpts.args.push(
        '--single-process',
        '--no-zygote',
        '--js-flags=--max-old-space-size=128'
      );
    }
    if (this.BROWSER_PATH) {
      launchOpts.executablePath = this.BROWSER_PATH;
    }
    return puppeteer.launch(launchOpts);
  }

  /* ================================================================
     Main public API
     ================================================================ */

  /**
   * Scrape commenters from a brand's Instagram profiles + hashtags.
   * Uses a single browser session for all handles (Apify-style).
   */
  async scrapeCommenters(brandName, config) {
    const allCustomers = [];
    const handles = config.handles || [];
    const hashtags = config.hashtags || [];

    logger.info(`[Instagram] Scraping ${brandName} (Puppeteer + internal API)...`);

    let browser;
    try {
      const memBefore = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.info(`[Instagram] Memory before browser launch: ${memBefore}MB`);

      browser = await this._launchBrowser();
      const page = await browser.newPage();

      const memAfter = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.info(`[Instagram] Memory after browser launch: ${memAfter}MB (+${memAfter - memBefore}MB)`);

      // Establish session (cookies, CSRF token)
      await this._initSession(page);

      // Scrape each profile
      for (const handle of handles) {
        try {
          const customers = await this._scrapeProfileViaAPI(page, handle, brandName);
          allCustomers.push(...customers);
          logger.info(`[Instagram] @${handle}: ${customers.length} customers`);
        } catch (err) {
          logger.warn(`[Instagram] Error scraping @${handle}: ${err.message}`);
        }
        // Clear caches between profiles to reclaim memory
        try {
          const client = await page.createCDPSession();
          await client.send('Network.clearBrowserCache');
          await client.detach();
        } catch {}
        await delay(3000 + Math.random() * 4000);
      }

      // Scrape hashtags
      for (const tag of hashtags) {
        try {
          const customers = await this._scrapeHashtagViaAPI(page, tag, brandName);
          allCustomers.push(...customers);
          logger.info(`[Instagram] #${tag}: ${customers.length} customers`);
        } catch (err) {
          logger.warn(`[Instagram] Error scraping #${tag}: ${err.message}`);
        }
        await delay(3000 + Math.random() * 4000);
      }

      await browser.close();
    } catch (err) {
      logger.error(`[Instagram] Browser session error: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
    }

    // Deduplicate by username
    const seen = new Set();
    const unique = allCustomers.filter((c) => {
      const key = (c.username || '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    logger.info(`[Instagram] Total: ${unique.length} unique customers for ${brandName}`);
    return unique;
  }

  /* ================================================================
     Session management
     ================================================================ */

  async _initSession(page) {
    logger.info('[IG-Session] Establishing Instagram session...');

    // ── Block heavy resources to save memory ──
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'texttrack', 'eventsource'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Visit homepage to get cookies (csrftoken, ig_did, mid)
    await page.goto('https://www.instagram.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await delay(3000 + Math.random() * 2000);

    // Dismiss cookie / consent popups
    try {
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const text = await btn.evaluate((el) => (el.textContent || '').trim());
        if (/accept|allow|got it|agree|only allow/i.test(text)) {
          await btn.click();
          await delay(1000);
          break;
        }
      }
    } catch {}

    // Dismiss login prompt if it covers the page (click elsewhere)
    try {
      const closeButtons = await page.$$('[aria-label="Close"], [role="button"]');
      for (const btn of closeButtons) {
        const text = await btn.evaluate((el) => (el.textContent || '').trim());
        if (/not now|close|dismiss/i.test(text)) {
          await btn.click();
          await delay(500);
          break;
        }
      }
    } catch {}

    // ── Inject session cookie if provided (optional login) ──
    if (this._sessionCookie) {
      await page.setCookie({
        name: 'sessionid',
        value: this._sessionCookie,
        domain: '.instagram.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      });
      logger.info('[IG-Session] Session cookie injected — authenticated mode');

      // Reload to apply the session cookie
      await page.goto('https://www.instagram.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await delay(2000);
    }

    const cookies = await page.cookies();
    const hasCsrf = cookies.some((c) => c.name === 'csrftoken');
    const hasSession = cookies.some((c) => c.name === 'sessionid');
    logger.info(`[IG-Session] Session ready — CSRF: ${hasCsrf ? 'YES' : 'NO'}, SessionID: ${hasSession ? 'YES' : 'NO'}, Cookies: ${cookies.length}`);

    // Clear navigation memory before scraping
    await page.evaluate(() => {
      if (window.gc) window.gc();
    });
  }

  /* ================================================================
     Profile scraping via internal API
     ================================================================ */

  async _scrapeProfileViaAPI(page, username, brandName) {
    logger.info(`[IG-API] Fetching profile @${username}...`);

    // Step 1: Get profile + posts via internal API
    const profileData = await this._fetchProfileInfo(page, username);

    if (!profileData) {
      logger.warn(`[IG-API] Profile API failed for @${username}, trying DOM fallback...`);
      return this._scrapeProfileDOM(page, username, brandName);
    }

    const userId = profileData.id;
    const followerCount = profileData.edge_followed_by?.count || 0;
    const mediaCount = profileData.edge_owner_to_timeline_media?.count || 0;
    logger.info(`[IG-API] @${username}: ${followerCount} followers, ${mediaCount} posts`);

    // Step 2: Extract posts (first 12 come with profile)
    let posts = this._extractPostsFromProfile(profileData);
    logger.info(`[IG-API] ${posts.length} posts from profile data`);

    // Step 3: Paginate for more posts
    const pageInfo = profileData.edge_owner_to_timeline_media?.page_info;
    if (pageInfo?.has_next_page && posts.length < this.MAX_POSTS) {
      try {
        const morePosts = await this._fetchMorePosts(page, userId, pageInfo.end_cursor);
        posts.push(...morePosts);
        logger.info(`[IG-API] Total posts after pagination: ${posts.length}`);
      } catch (err) {
        logger.debug(`[IG-API] Post pagination failed: ${err.message}`);
      }
    }

    // Step 3b: Fetch reels separately (they have high engagement)
    try {
      const reels = await this._fetchReels(page, userId, username);
      if (reels.length > 0) {
        logger.info(`[IG-API] @${username}: ${reels.length} reels fetched`);
        posts.push(...reels);
      }
    } catch (err) {
      logger.debug(`[IG-API] Reels fetch failed: ${err.message}`);
    }

    // Step 4: Sort by engagement (most comments + likes first)
    posts.sort((a, b) => (b.commentCount + b.likeCount) - (a.commentCount + a.likeCount));
    const postsToScrape = posts.slice(0, this.MAX_POSTS);
    logger.info(`[IG-API] Scraping ${postsToScrape.length} posts/reels (${postsToScrape.filter(p => p.isReel).length} reels)`);

    // Step 5: Extract tagged users and caption @mentions from post metadata (no auth needed)
    const allCustomers = [];
    let taggedCount = 0;
    let mentionCount = 0;
    const seenTagged = new Set();

    for (const post of postsToScrape) {
      // Tagged users in photos (usertags)
      for (const tag of (post.taggedUsers || [])) {
        if (!tag.username || tag.username === username || seenTagged.has(tag.username)) continue;
        if (!this._isValidUsername(tag.username)) continue;
        seenTagged.add(tag.username);
        taggedCount++;
        allCustomers.push(
          createCustomerRecord({
            name: tag.fullName || tag.username,
            username: tag.username,
            profileUrl: `https://www.instagram.com/${tag.username}/`,
            source: 'instagram',
            brand: brandName,
            comment: null,
            engagement: { type: 'tagged', postCode: post.shortcode },
          })
        );
      }
      // @mentions in captions
      for (const mentioned of (post.captionMentions || [])) {
        if (!mentioned || mentioned === username || seenTagged.has(mentioned)) continue;
        if (!this._isValidUsername(mentioned)) continue;
        seenTagged.add(mentioned);
        mentionCount++;
        allCustomers.push(
          createCustomerRecord({
            name: mentioned,
            username: mentioned,
            profileUrl: `https://www.instagram.com/${mentioned}/`,
            source: 'instagram',
            brand: brandName,
            comment: null,
            engagement: { type: 'mentioned', postCode: post.shortcode },
          })
        );
      }
    }
    if (taggedCount > 0 || mentionCount > 0) {
      logger.info(`[IG-API] @${username}: ${taggedCount} tagged users + ${mentionCount} caption mentions extracted from post metadata`);
    }

    // Step 6: Fetch comments and likers for each post/reel
    let workingStrategy = null;

    for (const post of postsToScrape) {
      // Always try to fetch commenters — don't trust commentCount from profile API
      try {
        const { commenters, strategy } = await this._fetchPostCommenters(
          page, post, username, brandName, workingStrategy
        );
        if (strategy) workingStrategy = strategy;
        allCustomers.push(...commenters);

        // Extract @mentions from comment text (people tagged in comments are potential clients)
        for (const c of commenters) {
          if (!c.comment) continue;
          const commentMentions = (c.comment.match(/@([a-zA-Z0-9._]{1,30})/g) || []).map(m => m.slice(1));
          for (const mentioned of commentMentions) {
            if (!mentioned || mentioned === username || seenTagged.has(mentioned)) continue;
            if (!this._isValidUsername(mentioned)) continue;
            seenTagged.add(mentioned);
            allCustomers.push(
              createCustomerRecord({
                name: mentioned,
                username: mentioned,
                profileUrl: `https://www.instagram.com/${mentioned}/`,
                source: 'instagram',
                brand: brandName,
                comment: null,
                engagement: { type: 'mentioned_in_comment', postCode: post.shortcode },
              })
            );
          }
        }

        logger.debug(
          `[IG-API] Post ${post.shortcode}: ${commenters.length} commenters via ${strategy || 'none'}`
        );
      } catch (err) {
        logger.debug(`[IG-API] Comment fetch failed for ${post.shortcode}: ${err.message}`);
      }
      await delay(1500 + Math.random() * 2500);

      // Always try to fetch likers
      try {
        const likers = await this._fetchPostLikers(page, post, username, brandName);
        allCustomers.push(...likers);
        logger.debug(`[IG-API] Post ${post.shortcode}: ${likers.length} likers`);
      } catch (err) {
        logger.debug(`[IG-API] Likers fetch failed for ${post.shortcode}: ${err.message}`);
      }
      await delay(1500 + Math.random() * 2500);
    }

    return allCustomers;
  }

  /**
   * Fetch profile info via Instagram's internal REST API
   */
  async _fetchProfileInfo(page, username) {
    const appId = this.IG_APP_ID;
    return page.evaluate(
      async (username, appId) => {
        try {
          const resp = await fetch(
            `/api/v1/users/web_profile_info/?username=${username}`,
            {
              headers: {
                'x-ig-app-id': appId,
                'x-requested-with': 'XMLHttpRequest',
              },
              credentials: 'include',
            }
          );
          if (!resp.ok) return null;
          const data = await resp.json();
          return data.data?.user || null;
        } catch {
          return null;
        }
      },
      username,
      appId
    );
  }

  /**
   * Extract post metadata from profile API response
   */
  _extractPostsFromProfile(profileData) {
    const edges = profileData.edge_owner_to_timeline_media?.edges || [];
    const posts = edges.map((edge) => ({
      shortcode: edge.node.shortcode,
      id: edge.node.id,
      commentCount: edge.node.edge_media_to_comment?.count || 0,
      likeCount:
        edge.node.edge_liked_by?.count ||
        edge.node.edge_media_preview_like?.count ||
        0,
      caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
      timestamp: edge.node.taken_at_timestamp,
      isVideo: edge.node.is_video || false,
      isReel: edge.node.is_video && edge.node.product_type === 'clips',
    }));

    // Also extract reels from edge_felix_video_timeline if available
    const reelEdges = profileData.edge_felix_video_timeline?.edges || [];
    for (const edge of reelEdges) {
      const sc = edge.node?.shortcode;
      if (sc && !posts.some(p => p.shortcode === sc)) {
        posts.push({
          shortcode: sc,
          id: edge.node.id,
          commentCount: edge.node.edge_media_to_comment?.count || 0,
          likeCount:
            edge.node.edge_liked_by?.count ||
            edge.node.edge_media_preview_like?.count ||
            0,
          caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
          timestamp: edge.node.taken_at_timestamp,
          isVideo: true,
          isReel: true,
        });
      }
    }

    return posts;
  }

  /**
   * Paginate through more posts via REST API + GraphQL fallback
   */
  async _fetchMorePosts(page, userId, endCursor) {
    const appId = this.IG_APP_ID;
    const maxPosts = this.MAX_POSTS;

    return page.evaluate(
      async (userId, endCursor, appId, maxPosts) => {
        const allPosts = [];

        // Strategy 1: REST API v1 user feed (more reliable than GraphQL)
        try {
          let maxId = '';
          let hasMore = true;
          while (hasMore && allPosts.length < maxPosts) {
            const params = new URLSearchParams({ count: '12' });
            if (maxId) params.set('max_id', maxId);
            const resp = await fetch(`/api/v1/feed/user/${userId}/?${params}`, {
              headers: {
                'x-ig-app-id': appId,
                'x-requested-with': 'XMLHttpRequest',
              },
              credentials: 'include',
            });
            if (!resp.ok) break;
            const data = await resp.json();
            const items = data.items || [];
            if (items.length === 0) break;
            for (const item of items) {
              if (item.code || item.shortcode) {
                // Extract tagged users and caption @mentions (available without auth)
                const tagged = (item.usertags?.in || []).map(t => ({
                  username: t.user?.username,
                  fullName: t.user?.full_name || t.user?.username,
                })).filter(t => t.username);
                const captionText = item.caption?.text || '';
                const mentions = [];
                const mentionRegex = /@([a-zA-Z0-9._]{1,30})/g;
                let mm;
                while ((mm = mentionRegex.exec(captionText)) !== null) mentions.push(mm[1]);
                // Also check carousel items for tags
                for (const cm of (item.carousel_media || [])) {
                  for (const t of (cm.usertags?.in || [])) {
                    if (t.user?.username && !tagged.some(x => x.username === t.user.username)) {
                      tagged.push({ username: t.user.username, fullName: t.user.full_name || t.user.username });
                    }
                  }
                }
                allPosts.push({
                  shortcode: item.code || item.shortcode,
                  id: item.pk?.toString() || item.id?.toString() || null,
                  commentCount: item.comment_count || 0,
                  likeCount: item.like_count || 0,
                  timestamp: item.taken_at,
                  isVideo: item.media_type === 2 || item.is_video || false,
                  isReel: item.product_type === 'clips',
                  taggedUsers: tagged,
                  captionMentions: mentions,
                });
              }
            }
            hasMore = data.more_available || false;
            maxId = data.next_max_id || '';
            if (!maxId) hasMore = false;
            await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1500));
          }
        } catch {}

        if (allPosts.length > 0) return allPosts;

        // Strategy 2: GraphQL fallback
        let cursor = endCursor;
        let hasNext = true;

        const hashes = [
          'e769aa130647d2354c40ea6a439bfc08',
          '69cba40317214236af40e7efa697781d',
          '003056d32c2554def87228bc3fd9668a',
        ];

        while (hasNext && allPosts.length < maxPosts) {
          const variables = JSON.stringify({ id: userId, first: 12, after: cursor });
          let data = null;

          for (const hash of hashes) {
            try {
              const resp = await fetch(
                `/graphql/query/?query_hash=${hash}&variables=${encodeURIComponent(variables)}`,
                {
                  headers: {
                    'x-ig-app-id': appId,
                    'x-requested-with': 'XMLHttpRequest',
                  },
                  credentials: 'include',
                }
              );
              if (resp.ok) {
                data = await resp.json();
                if (data.data?.user?.edge_owner_to_timeline_media) break;
                data = null;
              }
            } catch {
              data = null;
            }
          }

          if (!data) break;

          const timeline = data.data.user.edge_owner_to_timeline_media;
          for (const edge of timeline?.edges || []) {
            allPosts.push({
              shortcode: edge.node.shortcode,
              id: edge.node.id,
              commentCount: edge.node.edge_media_to_comment?.count || 0,
              likeCount:
                edge.node.edge_liked_by?.count ||
                edge.node.edge_media_preview_like?.count ||
                0,
              timestamp: edge.node.taken_at_timestamp,
              isVideo: edge.node.is_video || false,
            });
          }

          hasNext = timeline?.page_info?.has_next_page || false;
          cursor = timeline?.page_info?.end_cursor || null;
          await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1500));
        }

        return allPosts;
      },
      userId,
      endCursor,
      appId,
      maxPosts
    );
  }

  /**
   * Get the correct Instagram URL for a post or reel
   */
  _getPostUrl(post) {
    if (post.isReel) {
      return `https://www.instagram.com/reel/${post.shortcode}/`;
    }
    return `https://www.instagram.com/p/${post.shortcode}/`;
  }

  /**
   * Fetch reels via Instagram clips API
   */
  async _fetchReels(page, userId, username) {
    const appId = this.IG_APP_ID;
    const maxPosts = this.MAX_POSTS;

    const reels = await page.evaluate(
      async (userId, appId, maxPosts) => {
        const allReels = [];

        // Strategy 1: Clips API (v1)
        try {
          const resp = await fetch('/api/v1/clips/user/', {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-ig-app-id': appId,
              'x-requested-with': 'XMLHttpRequest',
            },
            credentials: 'include',
            body: `target_user_id=${userId}&page_size=${Math.min(maxPosts, 12)}&include_feed_video=true`,
          });
          if (resp.ok) {
            const data = await resp.json();
            const items = data.items || [];
            for (const item of items) {
              const media = item.media || item;
              if (media.code || media.shortcode) {
                const tagged = (media.usertags?.in || []).map(t => ({
                  username: t.user?.username,
                  fullName: t.user?.full_name || t.user?.username,
                })).filter(t => t.username);
                const capText = media.caption?.text || '';
                const mentions = [];
                const mReg = /@([a-zA-Z0-9._]{1,30})/g;
                let mx;
                while ((mx = mReg.exec(capText)) !== null) mentions.push(mx[1]);
                allReels.push({
                  shortcode: media.code || media.shortcode,
                  id: media.pk?.toString() || media.id?.toString() || null,
                  commentCount: media.comment_count || 0,
                  likeCount: media.like_count || 0,
                  caption: capText,
                  timestamp: media.taken_at,
                  isVideo: true,
                  isReel: true,
                  taggedUsers: tagged,
                  captionMentions: mentions,
                });
              }
            }
          }
        } catch {}

        if (allReels.length > 0) return allReels;

        // Strategy 2: GraphQL reels tray
        try {
          const hashes = [
            'bc78b344a68ed16dd5d7f264681c4c76',
            'd4d88dc1500312af6f937f7b804c68c3',
          ];
          const variables = JSON.stringify({ id: userId, first: Math.min(maxPosts, 12) });
          for (const hash of hashes) {
            try {
              const resp = await fetch(
                `/graphql/query/?query_hash=${hash}&variables=${encodeURIComponent(variables)}`,
                {
                  headers: {
                    'x-ig-app-id': appId,
                    'x-requested-with': 'XMLHttpRequest',
                  },
                  credentials: 'include',
                }
              );
              if (!resp.ok) continue;
              const data = await resp.json();
              const edges =
                data.data?.user?.edge_felix_video_timeline?.edges ||
                [];
              if (edges.length > 0) {
                for (const edge of edges) {
                  allReels.push({
                    shortcode: edge.node.shortcode,
                    id: edge.node.id,
                    commentCount: edge.node.edge_media_to_comment?.count || 0,
                    likeCount:
                      edge.node.edge_liked_by?.count ||
                      edge.node.edge_media_preview_like?.count ||
                      0,
                    caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                    timestamp: edge.node.taken_at_timestamp,
                    isVideo: true,
                    isReel: true,
                  });
                }
                break;
              }
            } catch {}
          }
        } catch {}

        return allReels;
      },
      userId,
      appId,
      maxPosts
    );

    // Deduplicate reels that might already be in posts
    return reels;
  }

  /* ================================================================
     Comment fetching — 4-strategy cascade
     ================================================================ */

  async _fetchPostCommenters(page, post, profileUsername, brandName, preferredStrategy = null) {
    let comments = [];
    let strategy = null;

    // Strategy 1: REST v1 comments API
    if (!preferredStrategy || preferredStrategy === 'v1') {
      comments = await this._fetchCommentsV1(page, post.id);
      if (comments.length > 0) {
        strategy = 'v1';
      } else {
        logger.info(`[IG-Comments] Post ${post.shortcode}: V1 API returned 0 comments`);
      }
    }

    // Strategy 2: GraphQL comments query
    if (comments.length === 0 && (!preferredStrategy || preferredStrategy === 'graphql')) {
      comments = await this._fetchCommentsGraphQL(page, post.shortcode);
      if (comments.length > 0) {
        strategy = 'graphql';
      } else {
        logger.info(`[IG-Comments] Post ${post.shortcode}: GraphQL returned 0 comments`);
      }
    }

    // Strategy 3: XHR interception (navigate to post page)
    if (comments.length === 0) {
      comments = await this._fetchCommentsViaInterception(page, post);
      if (comments.length > 0) {
        strategy = 'intercept';
      } else {
        logger.info(`[IG-Comments] Post ${post.shortcode}: XHR interception returned 0 comments`);
      }
    }

    // Strategy 4: DOM fallback
    if (comments.length === 0) {
      comments = await this._fetchCommentsDOMFallback(page, post, profileUsername);
      if (comments.length > 0) {
        strategy = 'dom';
      } else {
        logger.info(`[IG-Comments] Post ${post.shortcode}: DOM fallback returned 0 comments`);
      }
    }

    logger.info(`[IG-API] Post ${post.shortcode}: ${comments.length} raw comments via strategy=${strategy || 'none'}`);

    // Convert to customer records — keep ALL comments (no per-post dedup)
    // Global dedup happens later in helpers.deduplicateCustomers
    const validCustomers = [];
    const seen = new Set();

    for (const comment of comments) {
      const username = comment.username;
      if (!username || username === profileUsername || seen.has(username)) continue;
      if (!this._isValidUsername(username)) continue;
      seen.add(username);

      // Preserve comment text — use the raw text, keep empty strings as-is
      const commentText = (comment.text && comment.text.trim()) ? comment.text.trim() : null;

      validCustomers.push(
        createCustomerRecord({
          name: comment.fullName || username,
          username,
          profileUrl: `https://www.instagram.com/${username}/`,
          source: 'instagram',
          brand: brandName,
          comment: commentText,
          engagement: { type: 'comment', postCode: post.shortcode },
        })
      );
    }

    return { commenters: validCustomers, strategy };
  }

  /* ================================================================
     Likes fetching — multi-strategy (REST API + Post page DOM/JSON)
     ================================================================ */

  /**
   * Fetch users who liked a post.
   * Strategy cascade:
   *   1. REST v1 likers API (requires auth — may return empty without login)
   *   2. GraphQL shortcode_media query (edge_media_preview_like)
   *   3. Navigate to post page and extract likers from embedded JSON + DOM
   */
  async _fetchPostLikers(page, post, profileUsername, brandName) {
    let likers = [];

    // Strategy 0: Check likers discovered during comment extraction (XHR interception)
    const discovered = this._discoveredLikers.get(post.shortcode) || [];
    if (discovered.length > 0) {
      likers = discovered;
      logger.info(`[IG-Likes] Post ${post.shortcode}: ${likers.length} likers from comment-phase discovery`);
      this._discoveredLikers.delete(post.shortcode);
    }

    // Strategy 1: REST v1 likers API
    if (likers.length === 0 && post.id) {
      likers = await this._fetchLikersV1(page, post.id);
      if (likers.length > 0) {
        logger.info(`[IG-Likes] Post ${post.shortcode}: ${likers.length} likers via REST API`);
      }
    }

    // Strategy 2: GraphQL shortcode query — get preview likers
    if (likers.length === 0) {
      likers = await this._fetchLikersGraphQL(page, post.shortcode);
      if (likers.length > 0) {
        logger.info(`[IG-Likes] Post ${post.shortcode}: ${likers.length} likers via GraphQL`);
      }
    }

    // Strategy 3: Navigate to post page and extract from embedded JSON + DOM
    if (likers.length === 0) {
      likers = await this._fetchLikersFromPostPage(page, post, profileUsername);
      if (likers.length > 0) {
        logger.info(`[IG-Likes] Post ${post.shortcode}: ${likers.length} likers via post page DOM`);
      }
    }

    // Convert to customer records
    const validCustomers = [];
    const seen = new Set();

    for (const liker of likers) {
      const username = liker.username;
      if (!username || username === profileUsername || seen.has(username)) continue;
      if (!this._isValidUsername(username)) continue;
      seen.add(username);

      validCustomers.push(
        createCustomerRecord({
          name: liker.fullName || username,
          username,
          profileUrl: `https://www.instagram.com/${username}/`,
          source: 'instagram',
          brand: brandName,
          comment: null,
          engagement: { type: 'like', postCode: post.shortcode },
        })
      );
    }

    logger.info(`[IG-API] Post ${post.shortcode}: ${validCustomers.length} likers fetched`);
    return validCustomers;
  }

  /**
   * Strategy 1: REST v1 likers API (works best with auth session)
   */
  async _fetchLikersV1(page, mediaId) {
    const appId = this.IG_APP_ID;
    const isAuth = this.isAuthenticated();
    if (isAuth) {
      logger.debug(`[IG-Likes] Using authenticated likers API for media ${mediaId}`);
    }
    return page.evaluate(
      async (mediaId, appId) => {
        try {
          // Get CSRF token from cookie
          const csrfMatch = (document.cookie || '').match(/csrftoken=([^;]+)/);
          const csrfToken = csrfMatch ? csrfMatch[1] : '';

          const headers = {
            'x-ig-app-id': appId,
            'x-requested-with': 'XMLHttpRequest',
          };
          if (csrfToken) headers['x-csrftoken'] = csrfToken;

          const resp = await fetch(`/api/v1/media/${mediaId}/likers/`, {
            headers,
            credentials: 'include',
          });
          if (!resp.ok) {
            console.log(`[IG-Likes] V1 likers API returned ${resp.status} for ${mediaId}`);
            return [];
          }
          const data = await resp.json();
          const users = data.users || [];
          return users.map((u) => ({
            username: u.username,
            fullName: u.full_name || u.username,
          }));
        } catch (e) {
          console.log(`[IG-Likes] V1 likers API error for ${mediaId}: ${e.message}`);
          return [];
        }
      },
      mediaId,
      appId
    );
  }

  /**
   * Strategy 2: GraphQL query for shortcode_media — extract preview likers
   */
  async _fetchLikersGraphQL(page, shortcode) {
    const appId = this.IG_APP_ID;
    return page.evaluate(
      async (shortcode, appId) => {
        const hashes = [
          'bc3296d1ce80a24b1b6e40b1e72903f5',
          '97b41c52301f77ce508f55e66d17620e',
          '477b65a610463740ccdb83135b2014db',
        ];
        // Get CSRF token from cookie
        const csrfMatch = (document.cookie || '').match(/csrftoken=([^;]+)/);
        const csrfToken = csrfMatch ? csrfMatch[1] : '';

        const variables = JSON.stringify({ shortcode, first: 50 });
        for (const hash of hashes) {
          try {
            const headers = {
              'x-ig-app-id': appId,
              'x-requested-with': 'XMLHttpRequest',
            };
            if (csrfToken) headers['x-csrftoken'] = csrfToken;

            const resp = await fetch(
              `/graphql/query/?query_hash=${hash}&variables=${encodeURIComponent(variables)}`,
              {
                headers,
                credentials: 'include',
              }
            );
            if (!resp.ok) continue;
            const data = await resp.json();
            const media = data?.data?.shortcode_media;
            if (!media) continue;

            const likers = [];
            // Check all possible liker edge fields
            const likerSources = [
              media.edge_media_preview_like,
              media.edge_liked_by,
              media.edge_media_liked_by,
            ].filter(Boolean);

            for (const src of likerSources) {
              if (src?.edges) {
                for (const edge of src.edges) {
                  if (edge.node?.username) {
                    likers.push({
                      username: edge.node.username,
                      fullName: edge.node.full_name || edge.node.username,
                    });
                  }
                }
              }
              if (likers.length > 0) break;
            }
            if (likers.length > 0) return likers;
          } catch {}
        }
        return [];
      },
      shortcode,
      appId
    );
  }

  /**
   * Strategy 3: Navigate to post page, click likes section, and extract likers from XHR + embedded JSON + DOM
   */
  async _fetchLikersFromPostPage(page, post, profileUsername) {
    const shortcode = typeof post === 'string' ? post : post.shortcode;
    const isReel = typeof post === 'object' && post.isReel;
    const likerResults = [];

    // Set up XHR interception to catch liker API responses
    const handleResponse = async (response) => {
      try {
        const url = response.url();
        if (!url.includes('likers') && !url.includes('graphql') && !url.includes('liked_by')) return;
        if (response.status() !== 200) return;
        const data = await response.json().catch(() => null);
        if (!data) return;

        // REST likers format
        if (data.users && Array.isArray(data.users)) {
          for (const u of data.users) {
            if (u.username) {
              likerResults.push({ username: u.username, fullName: u.full_name || u.username });
            }
          }
        }

        // GraphQL format — check all possible liker paths
        const media = data?.data?.shortcode_media || data?.data?.xdt_shortcode_media;
        if (media) {
          const likeEdge = media.edge_media_preview_like || media.edge_liked_by;
          if (likeEdge?.edges) {
            for (const edge of likeEdge.edges) {
              if (edge.node?.username) {
                likerResults.push({ username: edge.node.username, fullName: edge.node.full_name || edge.node.username });
              }
            }
          }
          if (media.facepile_top_likers && Array.isArray(media.facepile_top_likers)) {
            for (const u of media.facepile_top_likers) {
              const uname = typeof u === 'string' ? u : u?.username;
              if (uname) likerResults.push({ username: uname, fullName: u?.full_name || uname });
            }
          }
        }
      } catch {}
    };

    page.on('response', handleResponse);

    try {
      // Navigate to post/reel page (skip if already there from comment extraction)
      const currentUrl = page.url();
      const postPath = isReel ? `/reel/${shortcode}` : `/p/${shortcode}`;
      const needsNavigation = !currentUrl.includes(postPath);
      if (needsNavigation) {
        const postUrl = isReel
          ? `https://www.instagram.com/reel/${shortcode}/`
          : `https://www.instagram.com/p/${shortcode}/`;
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await delay(2000);
      }

      // ── Phase 1: Deep JSON extraction ──
      // Parse ALL embedded JSON and recursively find liker data
      const jsonLikers = await page.evaluate((pUser) => {
        const likers = [];
        const seen = new Set();
        const blocked = new Set([
          'instagram', 'explore', 'reels', 'stories', 'accounts', 'about',
          'developer', 'legal', 'privacy', 'terms', 'help', 'press',
          'api', 'blog', 'jobs', 'nametag', 'session', 'login',
          'signup', 'sign_up', 'direct', 'p', 'reel', 'tv',
        ]);
        const isValid = (u) =>
          u && /^[a-zA-Z0-9._]{1,30}$/.test(u) && u !== pUser && !blocked.has(u.toLowerCase());

        const addUser = (username, fullName) => {
          if (isValid(username) && !seen.has(username)) {
            seen.add(username);
            likers.push({ username, fullName: fullName || username });
          }
        };

        // Recursive deep search through parsed JSON
        function deepSearch(obj, depth) {
          if (depth > 20 || !obj || typeof obj !== 'object') return;

          // top_likers: array of username strings
          if (Array.isArray(obj.top_likers)) {
            for (const u of obj.top_likers) {
              if (typeof u === 'string') addUser(u, u);
              else if (u?.username) addUser(u.username, u.full_name || u.username);
            }
          }

          // facepile_top_likers: array of objects or strings
          if (Array.isArray(obj.facepile_top_likers)) {
            for (const u of obj.facepile_top_likers) {
              if (typeof u === 'string') addUser(u, u);
              else if (u?.username) addUser(u.username, u.full_name || u.username);
            }
          }

          // edge_media_preview_like / edge_liked_by with edges
          const likeEdge = obj.edge_media_preview_like || obj.edge_liked_by;
          if (likeEdge?.edges && Array.isArray(likeEdge.edges)) {
            for (const edge of likeEdge.edges) {
              if (edge?.node?.username) addUser(edge.node.username, edge.node.full_name || edge.node.username);
            }
          }

          // social_context with usernames (sometimes used for likers)
          if (obj.social_context && typeof obj.social_context === 'string') {
            const contextUsers = obj.social_context.matchAll(/@?([a-zA-Z0-9._]{1,30})/g);
            for (const m of contextUsers) addUser(m[1], m[1]);
          }

          // Recurse
          if (Array.isArray(obj)) {
            for (let i = 0; i < Math.min(obj.length, 200); i++) deepSearch(obj[i], depth + 1);
          } else {
            for (const key of Object.keys(obj)) {
              if (key === '__typename' || key === 'csrf_token') continue;
              try { deepSearch(obj[key], depth + 1); } catch {}
            }
          }
        }

        // Parse all JSON script tags
        document.querySelectorAll('script[type="application/json"]').forEach((script) => {
          try {
            const data = JSON.parse(script.textContent);
            deepSearch(data, 0);
          } catch {}
        });

        // Also check window.__additionalDataLoaded, _sharedData
        try {
          if (window._sharedData) deepSearch(window._sharedData, 0);
        } catch {}
        try {
          if (window.__additionalDataLoaded) {
            for (const key of Object.keys(window.__additionalDataLoaded)) {
              deepSearch(window.__additionalDataLoaded[key], 0);
            }
          }
        } catch {}

        // Also search non-JSON scripts for top_likers/facepile patterns via regex
        document.querySelectorAll('script:not([type="application/json"])').forEach((script) => {
          try {
            const text = script.textContent || '';
            // top_likers: ["user1","user2"]
            const tlPattern = /"top_likers"\s*:\s*\[([^\]]*)\]/g;
            let m;
            while ((m = tlPattern.exec(text)) !== null) {
              for (const um of m[1].matchAll(/"([^"]+)"/g)) addUser(um[1], um[1]);
            }
            // facepile_top_likers with username fields
            const fpPattern = /"facepile_top_likers"\s*:\s*\[(.*?)\]/gs;
            while ((m = fpPattern.exec(text)) !== null) {
              for (const um of m[1].matchAll(/"username"\s*:\s*"([^"]+)"/g)) addUser(um[1], um[1]);
            }
          } catch {}
        });

        return likers;
      }, profileUsername);

      // ── Phase 2: Click to open likers dialog ──
      let dialogOpened = false;
      try {
        dialogOpened = await page.evaluate(() => {
          // Strategy A: Look for "liked_by" links
          const likedByLink = document.querySelector('a[href*="liked_by"]');
          if (likedByLink) { likedByLink.click(); return true; }

          // Strategy B: Look for various likes text patterns
          const patterns = [
            /^\d[\d,.\s]*(likes?|others)\s*$/i,
            /^liked by/i,
            /others$/i,
            /^view\s+\d+\s+likes?$/i,
          ];
          const candidates = document.querySelectorAll(
            'a[href], button, span[role="button"], span[role="link"], section span, section a, div[role="button"]'
          );
          for (const el of candidates) {
            const text = (el.textContent || '').trim();
            if (patterns.some(p => p.test(text))) {
              el.click();
              return true;
            }
          }

          // Strategy C: Find the likes section near the heart icon
          // Instagram structure: section > ... > heart-icon + like count
          const heartSvgs = document.querySelectorAll('svg[aria-label*="Like"], svg[aria-label*="like"], svg[aria-label*="Unlike"]');
          for (const svg of heartSvgs) {
            const section = svg.closest('section');
            if (!section) continue;
            // Find clickable elements in same section that aren't the heart button itself
            const clickable = section.querySelectorAll('a[href], span[role="button"], button');
            for (const el of clickable) {
              const text = (el.textContent || '').trim();
              if (/\d/.test(text) && /like|other/i.test(text)) {
                el.click();
                return true;
              }
              // Also try if parent has like-related href
              if (el.tagName === 'A' && (el.href || '').includes('liked_by')) {
                el.click();
                return true;
              }
            }
          }

          return false;
        });

        if (dialogOpened) {
          await delay(3000); // Wait for likers dialog to fully load

          // ── Phase 3: Scroll the likers dialog to load more ──
          for (let scroll = 0; scroll < 3; scroll++) {
            await page.evaluate(() => {
              // Find the scrollable dialog container
              const dialog = document.querySelector('[role="dialog"]');
              if (dialog) {
                const scrollContainer = dialog.querySelector('[style*="overflow"]') ||
                  dialog.querySelector('[class*="scroll"]') ||
                  dialog;
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
              }
            });
            await delay(1500);
          }
        }
      } catch {}

      // ── Phase 4: Extract likers from dialog DOM ──
      const dialogLikers = await page.evaluate((pUser) => {
        const likers = [];
        const seen = new Set();
        const blocked = new Set([
          'instagram', 'explore', 'reels', 'stories', 'accounts', 'about',
          'developer', 'legal', 'privacy', 'terms', 'help', 'press',
          'api', 'blog', 'jobs', 'nametag', 'session', 'login',
          'signup', 'sign_up', 'direct', 'p', 'reel', 'tv',
        ]);
        const isValid = (u) =>
          u && /^[a-zA-Z0-9._]{1,30}$/.test(u) && u !== pUser && !blocked.has(u.toLowerCase());

        // Check for an open dialog — Instagram puts likers in a role="dialog" element
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          // Each liker row has: <a href="/username/">username</a> and <span>Full Name</span>
          // Also look for "Follow" buttons next to usernames (indicates liker list)
          const userLinks = dialog.querySelectorAll('a[href]');
          for (const link of userLinks) {
            const href = link.getAttribute('href') || '';
            const match = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
            if (!match) continue;
            const username = match[1];
            if (!isValid(username) || seen.has(username)) continue;
            seen.add(username);

            // Try to get the display name from the link or sibling elements
            let fullName = username;
            const linkText = (link.textContent || '').trim();
            if (linkText && linkText !== username) {
              // Link text might be the display name, or might be the username
              fullName = linkText;
            }
            // Check for a nearby span with the full name (Instagram puts it after username)
            const row = link.closest('div[role="button"]') || link.closest('li') || link.parentElement?.parentElement;
            if (row) {
              const spans = row.querySelectorAll('span');
              for (const span of spans) {
                const t = (span.textContent || '').trim();
                if (t && t !== username && t !== 'Follow' && t !== 'Following' && !seen.has(t) && t.length < 50) {
                  fullName = t;
                  break;
                }
              }
            }

            likers.push({ username, fullName });
          }
        }

        // Also check "Liked by [username] and [N] others" section outside dialog
        document.querySelectorAll('a[href]').forEach((el) => {
          const href = el.getAttribute('href') || '';
          const match = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
          if (!match) return;
          const username = match[1];
          if (!isValid(username) || seen.has(username)) return;

          // Check 5 levels of ancestor context for like indicators
          let ancestor = el.parentElement;
          let foundLikeContext = false;
          for (let i = 0; i < 5 && ancestor; i++) {
            const text = (ancestor.textContent || '').toLowerCase();
            if ((/liked|like|others/i.test(text)) && !/comment|reply|tagged/i.test(text)) {
              foundLikeContext = true;
              break;
            }
            // Also check data attributes and aria labels
            const aria = ancestor.getAttribute?.('aria-label') || '';
            if (/like/i.test(aria)) { foundLikeContext = true; break; }
            ancestor = ancestor.parentElement;
          }

          if (!foundLikeContext) return;
          seen.add(username);
          likers.push({ username, fullName: (el.textContent || '').trim() || username });
        });

        return likers;
      }, profileUsername);

      page.off('response', handleResponse);

      // ── Phase 5: Try navigating to /liked_by/ URL if we got nothing so far ──
      const allSoFar = [...likerResults, ...jsonLikers, ...dialogLikers];
      if (allSoFar.length === 0) {
        try {
          const likedByUrl = isReel
            ? `https://www.instagram.com/reel/${shortcode}/liked_by/`
            : `https://www.instagram.com/p/${shortcode}/liked_by/`;
          await page.goto(likedByUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await delay(2500);

          const likedByPageLikers = await page.evaluate((pUser) => {
            const likers = [];
            const seen = new Set();
            const blocked = new Set([
              'instagram', 'explore', 'reels', 'stories', 'accounts', 'about',
              'developer', 'legal', 'privacy', 'terms', 'help', 'press',
              'api', 'blog', 'jobs', 'nametag', 'session', 'login',
              'signup', 'sign_up', 'direct', 'p', 'reel', 'tv',
            ]);
            const isValid = (u) =>
              u && /^[a-zA-Z0-9._]{1,30}$/.test(u) && u !== pUser && !blocked.has(u.toLowerCase());

            // On the liked_by page, likers are listed with profile links
            document.querySelectorAll('a[href]').forEach((link) => {
              const href = link.getAttribute('href') || '';
              const match = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
              if (!match) return;
              const username = match[1];
              if (!isValid(username) || seen.has(username)) return;
              // Extra check: must have a "Follow" button nearby (confirms it's a user row)
              const row = link.closest('div') || link.parentElement;
              if (row) {
                const hasFollowBtn = row.querySelector('button');
                if (hasFollowBtn) {
                  seen.add(username);
                  likers.push({ username, fullName: (link.textContent || '').trim() || username });
                }
              }
            });
            return likers;
          }, profileUsername);

          allSoFar.push(...likedByPageLikers);
        } catch {}
      }

      // Close any dialog
      try {
        await page.evaluate(() => {
          const closeBtns = document.querySelectorAll('[aria-label="Close"], button svg[aria-label="Close"]');
          for (const closeBtn of closeBtns) {
            const btn = closeBtn.closest('button') || closeBtn;
            btn.click();
          }
        });
      } catch {}

      // Combine all sources: XHR + JSON + dialog DOM + liked_by page
      return [...likerResults, ...jsonLikers, ...dialogLikers, ...allSoFar.slice(likerResults.length + jsonLikers.length + dialogLikers.length)];
    } catch {
      page.off('response', handleResponse);
      return [];
    }
  }

  /**
   * Strategy 1: REST v1 comments API (highest yield, paginated)
   */
  async _fetchCommentsV1(page, mediaId) {
    if (!mediaId) return [];
    const appId = this.IG_APP_ID;
    const maxComments = this.MAX_COMMENTS_PER_POST;

    return page.evaluate(
      async (mediaId, appId, maxComments) => {
        const allComments = [];
        let minId = '';
        let hasMore = true;

        while (hasMore && allComments.length < maxComments) {
          try {
            const params = new URLSearchParams({
              can_support_threading: 'true',
              permalink_enabled: 'false',
            });
            if (minId) params.set('min_id', minId);

            const resp = await fetch(`/api/v1/media/${mediaId}/comments/?${params}`, {
              headers: {
                'x-ig-app-id': appId,
                'x-requested-with': 'XMLHttpRequest',
              },
              credentials: 'include',
            });

            if (!resp.ok) break;
            const data = await resp.json();
            const comments = data.comments || [];

            for (const c of comments) {
              if (c.user?.username) {
                allComments.push({
                  username: c.user.username,
                  fullName: c.user.full_name || c.user.username,
                  text: c.text || '',
                });
              }
              // Nested replies
              const children = c.preview_child_comments || c.child_comments || [];
              for (const reply of children) {
                if (reply.user?.username) {
                  allComments.push({
                    username: reply.user.username,
                    fullName: reply.user.full_name || reply.user.username,
                    text: reply.text || '',
                  });
                }
              }
            }

            hasMore = data.has_more_comments || data.has_more_headload_comments || false;
            minId = data.next_min_id || data.next_max_id || '';
            if (!minId) hasMore = false;
          } catch {
            break;
          }
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
        }

        return allComments;
      },
      mediaId,
      appId,
      maxComments
    );
  }

  /**
   * Strategy 2: GraphQL comments query
   */
  async _fetchCommentsGraphQL(page, shortcode) {
    const appId = this.IG_APP_ID;
    const maxComments = this.MAX_COMMENTS_PER_POST;

    return page.evaluate(
      async (shortcode, appId, maxComments) => {
        const allComments = [];
        let endCursor = null;
        let hasNext = true;

        const hashes = [
          'bc3296d1ce80a24b1b6e40b1e72903f5',
          '97b41c52301f77ce508f55e66d17620e',
          '477b65a610463740ccdb83135b2014db',
        ];

        while (hasNext && allComments.length < maxComments) {
          const variables = { shortcode, first: 50 };
          if (endCursor) variables.after = endCursor;

          let data = null;
          for (const hash of hashes) {
            try {
              const resp = await fetch(
                `/graphql/query/?query_hash=${hash}&variables=${encodeURIComponent(JSON.stringify(variables))}`,
                {
                  headers: {
                    'x-ig-app-id': appId,
                    'x-requested-with': 'XMLHttpRequest',
                  },
                  credentials: 'include',
                }
              );
              if (resp.ok) {
                data = await resp.json();
                if (data.data?.shortcode_media) break;
              }
              data = null;
            } catch {
              data = null;
            }
          }

          if (!data) break;

          const media = data.data.shortcode_media;
          const commentEdge =
            media.edge_media_to_parent_comment || media.edge_media_to_comment;
          if (!commentEdge) break;

          for (const edge of commentEdge.edges || []) {
            const node = edge.node;
            if (node?.owner?.username) {
              allComments.push({
                username: node.owner.username,
                fullName: node.owner.full_name || node.owner.username,
                text: node.text || '',
              });
            }
            // Threaded replies
            if (node?.edge_threaded_comments?.edges) {
              for (const reply of node.edge_threaded_comments.edges) {
                if (reply.node?.owner?.username) {
                  allComments.push({
                    username: reply.node.owner.username,
                    fullName: reply.node.owner.full_name || reply.node.owner.username,
                    text: reply.node.text || '',
                  });
                }
              }
            }
          }

          hasNext = commentEdge.page_info?.has_next_page || false;
          endCursor = commentEdge.page_info?.end_cursor || null;
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
        }

        return allComments;
      },
      shortcode,
      appId,
      maxComments
    );
  }

  /**
   * Strategy 3: Navigate to post & intercept XHR responses
   */
  async _fetchCommentsViaInterception(page, post) {
    const shortcode = typeof post === 'string' ? post : post.shortcode;
    const isReel = typeof post === 'object' && post.isReel;
    const postUrl = isReel
      ? `https://www.instagram.com/reel/${shortcode}/`
      : `https://www.instagram.com/p/${shortcode}/`;
    const comments = [];

    const handleResponse = async (response) => {
      try {
        const url = response.url();
        if (!url.includes('graphql') && !url.includes('/comments')) return;
        if (response.status() !== 200) return;

        const data = await response.json().catch(() => null);
        if (!data) return;

        // GraphQL format
        const media = data?.data?.shortcode_media || data?.data?.xdt_shortcode_media;
        if (media) {
          const commentEdge =
            media.edge_media_to_parent_comment || media.edge_media_to_comment;
          if (commentEdge?.edges) {
            for (const edge of commentEdge.edges) {
              if (edge.node?.owner?.username) {
                comments.push({
                  username: edge.node.owner.username,
                  fullName: edge.node.owner.full_name || '',
                  text: edge.node.text || '',
                });
              }
              if (edge.node?.edge_threaded_comments?.edges) {
                for (const reply of edge.node.edge_threaded_comments.edges) {
                  if (reply.node?.owner?.username) {
                    comments.push({
                      username: reply.node.owner.username,
                      fullName: reply.node.owner.full_name || '',
                      text: reply.node.text || '',
                    });
                  }
                }
              }
            }
          }
        }

        // REST v1 format
        if (data.comments && Array.isArray(data.comments)) {
          for (const c of data.comments) {
            if (c.user?.username) {
              comments.push({
                username: c.user.username,
                fullName: c.user.full_name || '',
                text: c.text || '',
              });
            }
          }
        }

        // ── Also extract liker data from GraphQL responses ──
        if (media) {
          const likeEdge = media.edge_media_preview_like || media.edge_liked_by;
          if (likeEdge?.edges) {
            const likers = [];
            for (const edge of likeEdge.edges) {
              if (edge.node?.username) {
                likers.push({ username: edge.node.username, fullName: edge.node.full_name || edge.node.username });
              }
            }
            if (likers.length > 0) {
              const prev = this._discoveredLikers.get(shortcode) || [];
              this._discoveredLikers.set(shortcode, [...prev, ...likers]);
            }
          }
          // facepile_top_likers
          if (media.facepile_top_likers && Array.isArray(media.facepile_top_likers)) {
            const likers = [];
            for (const u of media.facepile_top_likers) {
              const uname = typeof u === 'string' ? u : u?.username;
              if (uname) likers.push({ username: uname, fullName: u?.full_name || uname });
            }
            if (likers.length > 0) {
              const prev = this._discoveredLikers.get(shortcode) || [];
              this._discoveredLikers.set(shortcode, [...prev, ...likers]);
            }
          }
        }
        // REST likers format (in case a likers API fires during page load)
        if (data.users && Array.isArray(data.users)) {
          const likers = data.users
            .filter(u => u.username)
            .map(u => ({ username: u.username, fullName: u.full_name || u.username }));
          if (likers.length > 0) {
            const prev = this._discoveredLikers.get(shortcode) || [];
            this._discoveredLikers.set(shortcode, [...prev, ...likers]);
          }
        }
      } catch {}
    };

    page.on('response', handleResponse);

    try {
      await page.goto(postUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await delay(3000);

      // Scroll down to trigger comment loading
      await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
      await delay(1500);

      // Click "View all comments" / "Load more" multiple times
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const buttons = await page.$$('button, span[role="button"]');
          let clicked = false;
          for (const btn of buttons) {
            const text = await btn.evaluate((el) => (el.textContent || '').trim());
            if (/view all|load more|more comment/i.test(text)) {
              await btn.click();
              await delay(2000);
              clicked = true;
              break;
            }
          }
          if (!clicked) break;
        } catch {
          break;
        }
      }
    } catch {}

    page.off('response', handleResponse);

    // Also extract comments from embedded page JSON if XHR interception got nothing
    if (comments.length === 0) {
      try {
        const pageComments = await page.evaluate(() => {
          const extracted = [];
          document.querySelectorAll('script[type="application/json"]').forEach((script) => {
            try {
              const jsonStr = script.textContent;
              // Look for comment structures with user+text in V1 format
              const p1 = /\{[^{}]*"user"\s*:\s*\{[^{}]*"username"\s*:\s*"([^"]+)"[^{}]*\}[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/g;
              let m;
              while ((m = p1.exec(jsonStr)) !== null) {
                extracted.push({ username: m[1], fullName: m[1], text: m[2] || '' });
              }
              // GraphQL owner format
              const p2 = /\{[^{}]*"owner"\s*:\s*\{[^{}]*"username"\s*:\s*"([^"]+)"[^{}]*\}[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/g;
              while ((m = p2.exec(jsonStr)) !== null) {
                extracted.push({ username: m[1], fullName: m[1], text: m[2] || '' });
              }
            } catch {}
          });
          return extracted;
        });
        comments.push(...pageComments);
      } catch {}
    }

    return comments;
  }

  /**
   * Strategy 4: DOM fallback — extract commenters + comment text from embedded JSON & page DOM
   */
  async _fetchCommentsDOMFallback(page, post, profileUsername) {
    const shortcode = typeof post === 'string' ? post : post.shortcode;
    const isReel = typeof post === 'object' && post.isReel;
    const postUrl = isReel
      ? `https://www.instagram.com/reel/${shortcode}/`
      : `https://www.instagram.com/p/${shortcode}/`;
    try {
      await page.goto(postUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await delay(2000);

      const commentResults = await page.evaluate((pUser) => {
        const results = [];
        const seen = new Set();
        const blocked = new Set([
          'instagram', 'explore', 'reels', 'stories', 'accounts', 'about',
          'developer', 'legal', 'privacy', 'terms', 'help', 'press',
          'api', 'blog', 'jobs', 'nametag', 'session', 'login',
          'signup', 'sign_up', 'direct', 'p', 'reel', 'tv',
        ]);
        const isValid = (u) =>
          u && /^[a-zA-Z0-9._]{1,30}$/.test(u) && u !== pUser && !blocked.has(u.toLowerCase());

        // ── Deep JSON parsing: extract comment objects with username + text ──
        document.querySelectorAll('script[type="application/json"]').forEach((script) => {
          try {
            const jsonStr = script.textContent;

            // Method A: Find comment-like structures with both username and text
            // Pattern: {..."user":{"username":"X",...},"text":"Y",...}
            // OR:      {..."owner":{"username":"X",...},"text":"Y",...}
            const commentBlockPatterns = [
              /\{[^{}]*"user"\s*:\s*\{[^{}]*"username"\s*:\s*"([^"]+)"[^{}]*(?:"full_name"\s*:\s*"([^"]*)")?[^{}]*\}[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/g,
              /\{[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*"user"\s*:\s*\{[^{}]*"username"\s*:\s*"([^"]+)"[^{}]*(?:"full_name"\s*:\s*"([^"]*)")?[^{}]*\}[^{}]*\}/g,
              /\{[^{}]*"owner"\s*:\s*\{[^{}]*"username"\s*:\s*"([^"]+)"[^{}]*\}[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/g,
            ];

            // Pattern 1: user.username comes first, then text
            let m;
            const p1 = /\{[^{}]*"user"\s*:\s*\{[^{}]*"username"\s*:\s*"([^"]+)"[^{}]*\}[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/g;
            while ((m = p1.exec(jsonStr)) !== null) {
              const username = m[1];
              const text = m[2];
              if (isValid(username) && !seen.has(username)) {
                seen.add(username);
                results.push({ username, fullName: username, text: text || '' });
              }
            }

            // Pattern 2: owner.username format (GraphQL style)
            const p2 = /\{[^{}]*"owner"\s*:\s*\{[^{}]*"username"\s*:\s*"([^"]+)"[^{}]*\}[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/g;
            while ((m = p2.exec(jsonStr)) !== null) {
              const username = m[1];
              const text = m[2];
              if (isValid(username) && !seen.has(username)) {
                seen.add(username);
                results.push({ username, fullName: username, text: text || '' });
              }
            }

            // Fallback: plain username extraction if above found nothing
            if (results.length === 0) {
              for (const um of jsonStr.matchAll(/"username"\s*:\s*"([^"]+)"/g)) {
                if (isValid(um[1]) && !seen.has(um[1])) {
                  seen.add(um[1]);
                  const nameRe = new RegExp(
                    `"username"\\s*:\\s*"${um[1]}"[^}]*"full_name"\\s*:\\s*"([^"]*)"`
                  );
                  const nameMatch = nameRe.exec(jsonStr);
                  // Try to find nearby text field
                  const textRe = new RegExp(
                    `"username"\\s*:\\s*"${um[1]}"[^}]*?"text"\\s*:\\s*"([^"]*)"`
                  );
                  const textMatch = textRe.exec(jsonStr);
                  results.push({
                    username: um[1],
                    fullName: nameMatch ? nameMatch[1] : um[1],
                    text: textMatch ? textMatch[1] : '',
                  });
                }
              }
            }
          } catch {}
        });

        // ── DOM comment elements: try to extract visible comments ──
        // Instagram renders comments as <ul> with <li> containing username + text
        document.querySelectorAll('ul li, div[role="button"]').forEach((el) => {
          try {
            const links = el.querySelectorAll('a[href]');
            links.forEach((link) => {
              const href = link.getAttribute('href') || '';
              const match = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
              if (!match) return;
              const username = match[1];
              if (!isValid(username) || seen.has(username)) return;

              // The comment text is usually the text content of the parent element
              // minus the username itself
              const parentEl = link.closest('li') || link.closest('div') || link.parentElement;
              let commentText = '';
              if (parentEl) {
                commentText = (parentEl.textContent || '').trim();
                // Remove the username from start
                commentText = commentText.replace(new RegExp(`^${username}\\s*`), '').trim();
                // Skip if it's a UI element, not a comment
                if (commentText.length > 500 || /^(Follow|Like|Reply|View|Load|Sign|Log)\b/i.test(commentText)) {
                  commentText = '';
                }
              }

              seen.add(username);
              results.push({
                username,
                fullName: (link.textContent || '').trim() || username,
                text: commentText,
              });
            });
          } catch {}
        });

        // ── Fallback: plain profile links ──
        if (results.length === 0) {
          document.querySelectorAll('a[href]').forEach((el) => {
            const match = (el.getAttribute('href') || '').match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
            if (!match) return;
            const username = match[1];
            if (!isValid(username) || seen.has(username)) return;
            const text = (el.textContent || '').trim();
            if (text.length > 50 || text.includes('\n') || !text) return;
            if (/^(Sign Up|Log In|Clip|View|More|Share|Save|Like|Reply|Follow|Following|Message|Options)$/i.test(text))
              return;
            seen.add(username);
            results.push({ username, fullName: text || username, text: '' });
          });
        }

        return results;
      }, profileUsername);

      // Also extract liker data from the page we just visited
      try {
        const pageLikers = await page.evaluate((pUser) => {
          const likers = [];
          const seen = new Set();
          const blocked = new Set([
            'instagram', 'explore', 'reels', 'stories', 'accounts', 'about',
            'developer', 'legal', 'privacy', 'terms', 'help', 'press',
            'api', 'blog', 'jobs', 'nametag', 'session', 'login',
            'signup', 'sign_up', 'direct', 'p', 'reel', 'tv',
          ]);
          const isValid = (u) =>
            u && /^[a-zA-Z0-9._]{1,30}$/.test(u) && u !== pUser && !blocked.has(u.toLowerCase());

          // Deep search all JSON for liker data
          function deepSearch(obj, depth) {
            if (depth > 15 || !obj || typeof obj !== 'object') return;
            if (Array.isArray(obj.top_likers)) {
              for (const u of obj.top_likers) {
                const uname = typeof u === 'string' ? u : u?.username;
                if (uname && isValid(uname) && !seen.has(uname)) {
                  seen.add(uname);
                  likers.push({ username: uname, fullName: u?.full_name || uname });
                }
              }
            }
            if (Array.isArray(obj.facepile_top_likers)) {
              for (const u of obj.facepile_top_likers) {
                const uname = typeof u === 'string' ? u : u?.username;
                if (uname && isValid(uname) && !seen.has(uname)) {
                  seen.add(uname);
                  likers.push({ username: uname, fullName: u?.full_name || uname });
                }
              }
            }
            const likeEdge = obj.edge_media_preview_like || obj.edge_liked_by;
            if (likeEdge?.edges && Array.isArray(likeEdge.edges)) {
              for (const edge of likeEdge.edges) {
                if (edge?.node?.username && isValid(edge.node.username) && !seen.has(edge.node.username)) {
                  seen.add(edge.node.username);
                  likers.push({ username: edge.node.username, fullName: edge.node.full_name || edge.node.username });
                }
              }
            }
            if (Array.isArray(obj)) {
              for (let i = 0; i < Math.min(obj.length, 200); i++) deepSearch(obj[i], depth + 1);
            } else {
              for (const key of Object.keys(obj)) {
                if (key === '__typename' || key === 'csrf_token') continue;
                try { deepSearch(obj[key], depth + 1); } catch {}
              }
            }
          }

          document.querySelectorAll('script[type="application/json"]').forEach((script) => {
            try { deepSearch(JSON.parse(script.textContent), 0); } catch {}
          });
          try { if (window._sharedData) deepSearch(window._sharedData, 0); } catch {}

          return likers;
        }, profileUsername);

        if (pageLikers.length > 0) {
          const prev = this._discoveredLikers.get(shortcode) || [];
          this._discoveredLikers.set(shortcode, [...prev, ...pageLikers]);
        }
      } catch {}

      return commentResults;
    } catch {
      return [];
    }
  }

  /* ================================================================
     Hashtag scraping
     ================================================================ */

  async _scrapeHashtagViaAPI(page, hashtag, brandName) {
    logger.info(`[IG-API] Scraping hashtag #${hashtag}...`);

    const appId = this.IG_APP_ID;
    let posts = await page.evaluate(
      async (hashtag, appId) => {
        try {
          const resp = await fetch(`/api/v1/tags/web_info/?tag_name=${hashtag}`, {
            headers: {
              'x-ig-app-id': appId,
              'x-requested-with': 'XMLHttpRequest',
            },
            credentials: 'include',
          });
          if (!resp.ok) return [];
          const data = await resp.json();
          const edges =
            data.data?.hashtag?.edge_hashtag_to_media?.edges ||
            data.data?.recent?.sections?.flatMap(
              (s) => (s.layout_content?.medias || []).map((m) => ({ node: m.media }))
            ) ||
            [];
          return edges
            .map((edge) => ({
              shortcode: edge.node?.shortcode || edge.node?.code,
              id: edge.node?.id || edge.node?.pk?.toString(),
              commentCount: edge.node?.edge_media_to_comment?.count || edge.node?.comment_count || 0,
              likeCount: edge.node?.edge_liked_by?.count || edge.node?.edge_media_preview_like?.count || edge.node?.like_count || 0,
            }))
            .filter((p) => p.shortcode);
        } catch {
          return [];
        }
      },
      hashtag,
      appId
    );

    // GraphQL fallback for hashtags
    if (posts.length === 0) {
      posts = await this._fetchHashtagPostsGraphQL(page, hashtag);
    }

    // DOM fallback
    if (posts.length === 0) {
      return this._scrapeHashtagDOM(page, hashtag, brandName);
    }

    logger.info(`[IG-API] ${posts.length} posts for #${hashtag}`);
    posts.sort((a, b) => b.commentCount - a.commentCount);

    const customers = [];
    for (const post of posts.slice(0, 8)) {
      // Fetch commenters
      if (post.commentCount > 0) {
        try {
          const { commenters } = await this._fetchPostCommenters(page, post, '', brandName);
          customers.push(...commenters);
        } catch {}
        await delay(1500 + Math.random() * 2500);
      }

      // Fetch likers
      if (post.likeCount > 0) {
        try {
          const likers = await this._fetchPostLikers(page, post, '', brandName);
          customers.push(...likers);
        } catch {}
        await delay(1500 + Math.random() * 2500);
      }
    }

    return customers;
  }

  async _fetchHashtagPostsGraphQL(page, hashtag) {
    const appId = this.IG_APP_ID;
    return page.evaluate(
      async (hashtag, appId) => {
        const hashes = [
          '174a21c41c5b3b30c84f4a9189e13e8b',
          'f92f56d47dc7a55b606908374b43a314',
        ];
        for (const hash of hashes) {
          try {
            const variables = JSON.stringify({ tag_name: hashtag, first: 20 });
            const resp = await fetch(
              `/graphql/query/?query_hash=${hash}&variables=${encodeURIComponent(variables)}`,
              {
                headers: {
                  'x-ig-app-id': appId,
                  'x-requested-with': 'XMLHttpRequest',
                },
                credentials: 'include',
              }
            );
            if (!resp.ok) continue;
            const data = await resp.json();
            const edges = data.data?.hashtag?.edge_hashtag_to_media?.edges || [];
            if (edges.length > 0) {
              return edges.map((edge) => ({
                shortcode: edge.node.shortcode,
                id: edge.node.id,
                commentCount: edge.node.edge_media_to_comment?.count || 0,
                likeCount: edge.node.edge_liked_by?.count || edge.node.edge_media_preview_like?.count || 0,
              }));
            }
          } catch {}
        }
        return [];
      },
      hashtag,
      appId
    );
  }

  /* ================================================================
     DOM Fallbacks
     ================================================================ */

  async _scrapeProfileDOM(page, username, brandName) {
    logger.info(`[IG-DOM] DOM fallback for @${username}`);
    try {
      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await delay(2000 + Math.random() * 2000);

      const content = await page.content();
      if (content.includes('Page Not Found') || content.includes("this page isn't available")) {
        logger.warn(`[IG-DOM] @${username} not found`);
        return [];
      }

      const shortcodes = await this._extractShortcodesFromPage(page);
      logger.info(`[IG-DOM] ${shortcodes.length} posts for @${username}`);

      const customers = [];
      for (const shortcode of shortcodes.slice(0, this.MAX_POSTS)) {
        try {
          const post = { shortcode, id: null, commentCount: 1, likeCount: 1, isReel: false };
          const { commenters } = await this._fetchPostCommenters(page, post, username, brandName);
          customers.push(...commenters);
        } catch {}
        await delay(1500 + Math.random() * 2500);

        try {
          const post = { shortcode, id: null, commentCount: 1, likeCount: 1, isReel: false };
          const likers = await this._fetchPostLikers(page, post, username, brandName);
          customers.push(...likers);
        } catch {}
        await delay(1500 + Math.random() * 2500);
      }

      return customers;
    } catch (err) {
      logger.warn(`[IG-DOM] Failed for @${username}: ${err.message}`);
      return [];
    }
  }

  async _scrapeHashtagDOM(page, hashtag, brandName) {
    logger.info(`[IG-DOM] DOM fallback for #${hashtag}`);
    try {
      await page.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await delay(2000 + Math.random() * 2000);

      const shortcodes = await this._extractShortcodesFromPage(page);
      logger.info(`[IG-DOM] ${shortcodes.length} posts for #${hashtag}`);

      const customers = [];
      for (const shortcode of shortcodes.slice(0, 8)) {
        try {
          const post = { shortcode, id: null, commentCount: 1 };
          const { commenters } = await this._fetchPostCommenters(page, post, '', brandName);
          customers.push(...commenters);
        } catch {}
        await delay(1500 + Math.random() * 2500);
      }

      return customers;
    } catch (err) {
      logger.warn(`[IG-DOM] Failed for #${hashtag}: ${err.message}`);
      return [];
    }
  }

  async _extractShortcodesFromPage(page) {
    try {
      const domCodes = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        const codes = [];
        links.forEach((link) => {
          const match = (link.getAttribute('href') || '').match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
          if (match && match[2] && !codes.includes(match[2])) codes.push(match[2]);
        });
        return codes;
      });

      const html = await page.content();
      const srcCodes = [];
      for (const pattern of [
        /"shortcode"\s*:\s*"([A-Za-z0-9_-]+)"/g,
        /\/p\/([A-Za-z0-9_-]+)\//g,
        /\/reel\/([A-Za-z0-9_-]+)\//g,
      ]) {
        let m;
        while ((m = pattern.exec(html)) !== null) {
          if (m[1] && m[1].length > 5 && !domCodes.includes(m[1]) && !srcCodes.includes(m[1])) {
            srcCodes.push(m[1]);
          }
        }
      }

      return [...domCodes, ...srcCodes];
    } catch {
      return [];
    }
  }

  /* ================================================================
     Username validation
     ================================================================ */

  _isValidUsername(username) {
    if (!username) return false;
    if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) return false;

    const blocklist = new Set([
      'instagram', 'explore', 'reels', 'stories', 'accounts', 'about',
      'developer', 'legal', 'privacy', 'terms', 'help', 'press',
      'api', 'blog', 'jobs', 'nametag', 'session', 'login',
      'signup', 'sign_up', 'direct', 'p', 'reel', 'tv',
      'facebook', 'meta', 'threads', 'whatsapp',
    ]);

    return !blocklist.has(username.toLowerCase());
  }

  /* ================================================================
     Follower / Following extraction (requires authenticated session)
     ================================================================ */

  /**
   * Scrape the follower list of an Instagram account.
   * Requires a session cookie to be set (authenticated mode).
   * @param {string} username - The Instagram handle to get followers for
   * @param {string} brandName - Brand name for customer records
   * @returns {Array} Array of customer records with engagement type 'follower'
   */
  async scrapeFollowers(username, brandName) {
    if (!this._sessionCookie) {
      throw new Error('Session cookie required. Connect your Instagram account first.');
    }

    logger.info(`[IG-Followers] Starting follower extraction for @${username}...`);
    let browser;
    try {
      browser = await this._launchBrowser();
      const page = await browser.newPage();
      await this._initSession(page);

      // Get user ID from profile info
      const profileData = await this._fetchProfileInfo(page, username);
      if (!profileData || !profileData.id) {
        throw new Error(`Could not fetch profile info for @${username}`);
      }

      const userId = profileData.id;
      const followerCount = profileData.edge_followed_by?.count || 0;
      logger.info(`[IG-Followers] @${username} has ${followerCount} followers, fetching list...`);

      const followers = await this._fetchFollowerList(page, userId, username);
      logger.info(`[IG-Followers] Fetched ${followers.length} followers for @${username}`);

      await browser.close();

      // Convert to customer records
      return followers
        .filter(f => f.username && this._isValidUsername(f.username) && f.username !== username)
        .map(f => createCustomerRecord({
          name: f.fullName || f.username,
          username: f.username,
          profileUrl: `https://www.instagram.com/${f.username}/`,
          source: 'instagram',
          brand: brandName || username,
          comment: null,
          engagement: { type: 'follower', postCode: null },
        }));
    } catch (err) {
      logger.error(`[IG-Followers] Failed: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Scrape the following list of an Instagram account.
   * Requires a session cookie to be set (authenticated mode).
   * @param {string} username - The Instagram handle to get following for
   * @param {string} brandName - Brand name for customer records
   * @returns {Array} Array of customer records with engagement type 'following'
   */
  async scrapeFollowing(username, brandName) {
    if (!this._sessionCookie) {
      throw new Error('Session cookie required. Connect your Instagram account first.');
    }

    logger.info(`[IG-Following] Starting following extraction for @${username}...`);
    let browser;
    try {
      browser = await this._launchBrowser();
      const page = await browser.newPage();
      await this._initSession(page);

      // Get user ID from profile info
      const profileData = await this._fetchProfileInfo(page, username);
      if (!profileData || !profileData.id) {
        throw new Error(`Could not fetch profile info for @${username}`);
      }

      const userId = profileData.id;
      const followingCount = profileData.edge_follow?.count || 0;
      logger.info(`[IG-Following] @${username} follows ${followingCount} accounts, fetching list...`);

      const following = await this._fetchFollowingList(page, userId, username);
      logger.info(`[IG-Following] Fetched ${following.length} following for @${username}`);

      await browser.close();

      // Convert to customer records
      return following
        .filter(f => f.username && this._isValidUsername(f.username) && f.username !== username)
        .map(f => createCustomerRecord({
          name: f.fullName || f.username,
          username: f.username,
          profileUrl: `https://www.instagram.com/${f.username}/`,
          source: 'instagram',
          brand: brandName || username,
          comment: null,
          engagement: { type: 'following', postCode: null },
        }));
    } catch (err) {
      logger.error(`[IG-Following] Failed: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Fetch follower list using Instagram REST API (paginated).
   * Endpoint: /api/v1/friendships/{userId}/followers/
   */
  async _fetchFollowerList(page, userId, username) {
    const appId = this.IG_APP_ID;
    const maxUsers = 1000; // Safety limit

    return page.evaluate(
      async (userId, appId, maxUsers) => {
        const allUsers = [];
        let maxId = '';
        let hasMore = true;

        while (hasMore && allUsers.length < maxUsers) {
          try {
            const params = new URLSearchParams({ count: '50', search_surface: 'follow_list_page' });
            if (maxId) params.set('max_id', maxId);

            const resp = await fetch(`/api/v1/friendships/${userId}/followers/?${params}`, {
              headers: {
                'x-ig-app-id': appId,
                'x-requested-with': 'XMLHttpRequest',
              },
              credentials: 'include',
            });

            if (!resp.ok) {
              if (resp.status === 401 || resp.status === 403) break; // Auth expired
              break;
            }

            const data = await resp.json();
            const users = data.users || [];
            if (users.length === 0) break;

            for (const u of users) {
              if (u.username) {
                allUsers.push({
                  username: u.username,
                  fullName: u.full_name || u.username,
                });
              }
            }

            hasMore = !!data.next_max_id;
            maxId = data.next_max_id || '';
            if (!maxId) hasMore = false;

            // Rate limit delay
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
          } catch {
            break;
          }
        }

        return allUsers;
      },
      userId,
      appId,
      maxUsers
    );
  }

  /**
   * Fetch following list using Instagram REST API (paginated).
   * Endpoint: /api/v1/friendships/{userId}/following/
   */
  async _fetchFollowingList(page, userId, username) {
    const appId = this.IG_APP_ID;
    const maxUsers = 1000; // Safety limit

    return page.evaluate(
      async (userId, appId, maxUsers) => {
        const allUsers = [];
        let maxId = '';
        let hasMore = true;

        while (hasMore && allUsers.length < maxUsers) {
          try {
            const params = new URLSearchParams({ count: '50' });
            if (maxId) params.set('max_id', maxId);

            const resp = await fetch(`/api/v1/friendships/${userId}/following/?${params}`, {
              headers: {
                'x-ig-app-id': appId,
                'x-requested-with': 'XMLHttpRequest',
              },
              credentials: 'include',
            });

            if (!resp.ok) {
              if (resp.status === 401 || resp.status === 403) break;
              break;
            }

            const data = await resp.json();
            const users = data.users || [];
            if (users.length === 0) break;

            for (const u of users) {
              if (u.username) {
                allUsers.push({
                  username: u.username,
                  fullName: u.full_name || u.username,
                });
              }
            }

            hasMore = !!data.next_max_id;
            maxId = data.next_max_id || '';
            if (!maxId) hasMore = false;

            // Rate limit delay
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
          } catch {
            break;
          }
        }

        return allUsers;
      },
      userId,
      appId,
      maxUsers
    );
  }

  /* ================================================================
     Custom scraping (single handle, used by API route)
     ================================================================ */

  async scrapeCustom(username) {
    logger.info(`[Instagram] Custom scrape for @${username}`);
    let browser;
    try {
      const memBefore = Math.round(process.memoryUsage().rss / 1024 / 1024);
      logger.info(`[Instagram] Memory before browser launch: ${memBefore}MB`);

      browser = await this._launchBrowser();
      const page = await browser.newPage();
      await this._initSession(page);
      const customers = await this._scrapeProfileViaAPI(page, username, 'Custom');
      await browser.close();
      return customers;
    } catch (err) {
      logger.warn(`[Instagram] Custom scrape failed: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
      return [];
    }
  }
}

module.exports = InstagramScraper;

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
    this.MAX_POSTS = isProduction ? 8 : 15;                // fewer posts in prod to save memory/time
    this.MAX_COMMENTS_PER_POST = isProduction ? 80 : 200;  // fewer comments in prod
    this.IG_APP_ID = '936619743392459'; // Instagram's public web app ID
    this.BROWSER_PATH = this._findBrowser();
    this.isProduction = isProduction;
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

  async _launchBrowser() {
    const launchOpts = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US,en',
        // ── Memory-saving flags (critical for 512MB environments) ──
        '--single-process',               // run browser in one process (~150MB saved)
        '--no-zygote',                     // skip zygote process
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
        '--js-flags=--max-old-space-size=128',  // limit Chromium V8 heap
        '--window-size=800,600',
      ],
      defaultViewport: { width: 800, height: 600 },
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

    const cookies = await page.cookies();
    const hasCsrf = cookies.some((c) => c.name === 'csrftoken');
    logger.info(`[IG-Session] Session ready — CSRF: ${hasCsrf ? 'YES' : 'NO'}, Cookies: ${cookies.length}`);

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

    // Step 4: Sort by engagement (most comments first)
    posts.sort((a, b) => b.commentCount - a.commentCount);
    const postsToScrape = posts.slice(0, this.MAX_POSTS);

    // Step 5: Fetch comments for each post
    const allCustomers = [];
    let workingStrategy = null;

    for (const post of postsToScrape) {
      if (post.commentCount === 0) continue;

      try {
        const { commenters, strategy } = await this._fetchPostCommenters(
          page, post, username, brandName, workingStrategy
        );
        if (strategy) workingStrategy = strategy;
        allCustomers.push(...commenters);
        logger.debug(
          `[IG-API] Post ${post.shortcode}: ${commenters.length} commenters via ${strategy || 'none'}`
        );
      } catch (err) {
        logger.debug(`[IG-API] Comment fetch failed for ${post.shortcode}: ${err.message}`);
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
    return edges.map((edge) => ({
      shortcode: edge.node.shortcode,
      id: edge.node.id,
      commentCount: edge.node.edge_media_to_comment?.count || 0,
      likeCount:
        edge.node.edge_liked_by?.count ||
        edge.node.edge_media_preview_like?.count ||
        0,
      timestamp: edge.node.taken_at_timestamp,
      isVideo: edge.node.is_video || false,
    }));
  }

  /**
   * Paginate through more posts via GraphQL
   */
  async _fetchMorePosts(page, userId, endCursor) {
    const appId = this.IG_APP_ID;
    const maxPosts = this.MAX_POSTS;

    return page.evaluate(
      async (userId, endCursor, appId, maxPosts) => {
        const allPosts = [];
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

  /* ================================================================
     Comment fetching — 4-strategy cascade
     ================================================================ */

  async _fetchPostCommenters(page, post, profileUsername, brandName, preferredStrategy = null) {
    let comments = [];
    let strategy = null;

    // Strategy 1: REST v1 comments API
    if (!preferredStrategy || preferredStrategy === 'v1') {
      comments = await this._fetchCommentsV1(page, post.id);
      if (comments.length > 0) strategy = 'v1';
    }

    // Strategy 2: GraphQL comments query
    if (comments.length === 0 && (!preferredStrategy || preferredStrategy === 'graphql')) {
      comments = await this._fetchCommentsGraphQL(page, post.shortcode);
      if (comments.length > 0) strategy = 'graphql';
    }

    // Strategy 3: XHR interception (navigate to post page)
    if (comments.length === 0) {
      comments = await this._fetchCommentsViaInterception(page, post.shortcode);
      if (comments.length > 0) strategy = 'intercept';
    }

    // Strategy 4: DOM fallback
    if (comments.length === 0) {
      comments = await this._fetchCommentsDOMFallback(page, post.shortcode, profileUsername);
      if (comments.length > 0) strategy = 'dom';
    }

    // Filter + convert to customer records
    const validCustomers = [];
    const seen = new Set();

    for (const comment of comments) {
      const username = comment.username;
      if (!username || username === profileUsername || seen.has(username)) continue;
      if (!this._isValidUsername(username)) continue;
      seen.add(username);

      validCustomers.push(
        createCustomerRecord({
          name: comment.fullName || username,
          username,
          profileUrl: `https://www.instagram.com/${username}/`,
          source: 'instagram',
          brand: brandName,
          comment: comment.text || null,
          engagement: { type: 'comment', postCode: post.shortcode },
        })
      );
    }

    return { commenters: validCustomers, strategy };
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
  async _fetchCommentsViaInterception(page, shortcode) {
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
      } catch {}
    };

    page.on('response', handleResponse);

    try {
      await page.goto(`https://www.instagram.com/p/${shortcode}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await delay(3000);

      // Click "View all comments" / "Load more"
      for (let attempt = 0; attempt < 3; attempt++) {
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
    return comments;
  }

  /**
   * Strategy 4: DOM fallback — embedded JSON + page links
   */
  async _fetchCommentsDOMFallback(page, shortcode, profileUsername) {
    try {
      await page.goto(`https://www.instagram.com/p/${shortcode}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await delay(2000);

      return page.evaluate((pUser) => {
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

        // Embedded JSON
        document.querySelectorAll('script[type="application/json"]').forEach((script) => {
          try {
            const jsonStr = script.textContent;
            for (const m of jsonStr.matchAll(/"username"\s*:\s*"([^"]+)"/g)) {
              if (isValid(m[1]) && !seen.has(m[1])) {
                seen.add(m[1]);
                const nameRe = new RegExp(
                  `"username"\\s*:\\s*"${m[1]}"[^}]*"full_name"\\s*:\\s*"([^"]*)"`
                );
                const nameMatch = nameRe.exec(jsonStr);
                results.push({
                  username: m[1],
                  fullName: nameMatch ? nameMatch[1] : m[1],
                  text: '',
                });
              }
            }
          } catch {}
        });

        // DOM links
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

        return results;
      }, profileUsername);
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
      if (post.commentCount === 0) continue;
      try {
        const { commenters } = await this._fetchPostCommenters(page, post, '', brandName);
        customers.push(...commenters);
      } catch {}
      await delay(1500 + Math.random() * 2500);
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
          const post = { shortcode, id: null, commentCount: 1 };
          const { commenters } = await this._fetchPostCommenters(page, post, username, brandName);
          customers.push(...commenters);
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

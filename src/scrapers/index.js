const InstagramScraper = require('./instagramScraper');
const { getBrand, getAllBrands } = require('../config/brands');
const { deduplicateCustomers } = require('../utils/helpers');
const { exportToJson, exportToCsv } = require('../utils/exporters');
const logger = require('../utils/logger');

/**
 * Scraper Orchestrator — Instagram Only
 * Coordinates all scraping operations via Puppeteer + Instagram internal APIs.
 * 100% free, no API keys required.
 */
class ScraperOrchestrator {
  constructor() {
    this.instagramScraper = new InstagramScraper();
    this.activeJobs = new Map();
  }

  /* ================================================================
     Instagram Session Management (optional login)
     ================================================================ */

  /**
   * Set the Instagram session cookie for authenticated features.
   * @param {string} sessionId - The sessionid cookie value
   */
  setIgSession(sessionId) {
    this.instagramScraper.setSessionCookie(sessionId);
  }

  /**
   * Clear the Instagram session cookie.
   */
  clearIgSession() {
    this.instagramScraper.clearSessionCookie();
  }

  /**
   * Check if the Instagram scraper is in authenticated mode.
   */
  isIgAuthenticated() {
    return this.instagramScraper.isAuthenticated();
  }

  /**
   * Open a visible browser window for the user to log in to Instagram manually.
   * @returns {{ success: boolean, message: string }}
   */
  async loginIg() {
    return this.instagramScraper.openLoginBrowser();
  }

  /* ================================================================
     Follower / Following extraction (requires auth)
     ================================================================ */

  /**
   * Scrape followers of an Instagram account.
   * @param {string} handle - Instagram username
   * @param {string} brandName - Brand name for records
   */
  async scrapeFollowers(handle, brandName) {
    const jobId = `followers-${handle}-${Date.now()}`;
    const job = {
      id: jobId,
      brand: brandName || handle,
      brandSlug: (brandName || handle).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      sources: ['instagram'],
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: { followers: { status: 'running', found: 0 } },
      customers: [],
      errors: [],
    };
    this.activeJobs.set(jobId, job);

    try {
      const customers = await this.instagramScraper.scrapeFollowers(handle, brandName || handle);
      const uniqueCustomers = deduplicateCustomers(customers);

      // Export
      const slug = (brandName || handle).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const jsonFile = exportToJson(`${slug}-followers`, uniqueCustomers);
      let csvFile = null;
      if (uniqueCustomers.length > 0) {
        csvFile = exportToCsv(`${slug}-followers`, uniqueCustomers);
      }

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.customers = uniqueCustomers;
      job.totalFound = customers.length;
      job.totalUnique = uniqueCustomers.length;
      job.progress.followers = { status: 'completed', found: uniqueCustomers.length };
      job.exports = { json: jsonFile, csv: csvFile };

      return job;
    } catch (err) {
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.errors.push({ source: 'instagram-followers', error: err.message });
      job.progress.followers = { status: 'failed', found: 0 };
      throw err;
    }
  }

  /**
   * Scrape following list of an Instagram account.
   * @param {string} handle - Instagram username
   * @param {string} brandName - Brand name for records
   */
  async scrapeFollowing(handle, brandName) {
    const jobId = `following-${handle}-${Date.now()}`;
    const job = {
      id: jobId,
      brand: brandName || handle,
      brandSlug: (brandName || handle).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      sources: ['instagram'],
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: { following: { status: 'running', found: 0 } },
      customers: [],
      errors: [],
    };
    this.activeJobs.set(jobId, job);

    try {
      const customers = await this.instagramScraper.scrapeFollowing(handle, brandName || handle);
      const uniqueCustomers = deduplicateCustomers(customers);

      // Export
      const slug = (brandName || handle).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const jsonFile = exportToJson(`${slug}-following`, uniqueCustomers);
      let csvFile = null;
      if (uniqueCustomers.length > 0) {
        csvFile = exportToCsv(`${slug}-following`, uniqueCustomers);
      }

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.customers = uniqueCustomers;
      job.totalFound = customers.length;
      job.totalUnique = uniqueCustomers.length;
      job.progress.following = { status: 'completed', found: uniqueCustomers.length };
      job.exports = { json: jsonFile, csv: csvFile };

      return job;
    } catch (err) {
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.errors.push({ source: 'instagram-following', error: err.message });
      job.progress.following = { status: 'failed', found: 0 };
      throw err;
    }
  }

  /**
   * Scrape a single brand's Instagram
   * @param {string} brandSlug - Brand identifier
   * @param {string[]} sources - Reserved for future use (always ['instagram'])
   * @param {Function} progressCallback - Optional callback for progress updates
   */
  async scrapeBrand(brandSlug, sources = ['instagram'], progressCallback = null, includeFollowers = false) {
    const brandConfig = getBrand(brandSlug);
    if (!brandConfig) {
      throw new Error(`Unknown brand: ${brandSlug}. Available: ${getAllBrands().map((b) => b.slug).join(', ')}`);
    }

    const jobId = `${brandSlug}-${Date.now()}`;
    const job = {
      id: jobId,
      brand: brandConfig.name,
      brandSlug,
      sources: ['instagram'],
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: {},
      customers: [],
      errors: [],
    };
    this.activeJobs.set(jobId, job);

    const report = (msg) => {
      if (progressCallback) progressCallback(msg);
      logger.info(msg);
    };

    report(`Starting Instagram scrape for ${brandConfig.name}...`);

    job.progress.instagram = { status: 'running', found: 0 };
    let allCustomers = [];

    try {
      allCustomers = await this.instagramScraper.scrapeCommenters(
        brandConfig.name,
        brandConfig.instagram
      );
      job.progress.instagram = { status: 'completed', found: allCustomers.length };
      report(`[Instagram] Found ${allCustomers.length} customers for ${brandConfig.name}`);
    } catch (error) {
      job.progress.instagram = { status: 'failed', found: 0 };
      job.errors.push({ source: 'instagram', error: error.message });
      report(`[Instagram] Error: ${error.message}`);
    }

    // Scrape followers if requested and authenticated
    if (includeFollowers && this.isIgAuthenticated()) {
      const handle = brandConfig.instagram?.handles?.[0];
      if (handle) {
        try {
          report(`[Instagram] Extracting followers for @${handle}...`);
          job.progress.followers = { status: 'running', found: 0 };
          const followers = await this.instagramScraper.scrapeFollowers(handle, brandConfig.name);
          allCustomers.push(...followers);
          job.progress.followers = { status: 'completed', found: followers.length };
          report(`[Instagram] Found ${followers.length} followers for @${handle}`);
        } catch (err) {
          job.progress.followers = { status: 'failed', found: 0 };
          job.errors.push({ source: 'instagram-followers', error: err.message });
          report(`[Instagram] Followers extraction failed: ${err.message}`);
        }
      }
    }

    // Deduplicate
    const uniqueCustomers = deduplicateCustomers(allCustomers);
    report(`Scrape complete for ${brandConfig.name}. Unique customers: ${uniqueCustomers.length}`);

    // Export results
    const jsonFile = exportToJson(brandSlug, uniqueCustomers);
    let csvFile = null;
    if (uniqueCustomers.length > 0) {
      csvFile = exportToCsv(brandSlug, uniqueCustomers);
    }

    // Update job
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.customers = uniqueCustomers;
    job.totalFound = allCustomers.length;
    job.totalUnique = uniqueCustomers.length;
    job.exports = { json: jsonFile, csv: csvFile };

    return job;
  }

  /**
   * Scrape all configured brands
   */
  async scrapeAllBrands(sources = ['instagram'], progressCallback = null) {
    const brands = getAllBrands();
    const results = [];

    for (const brand of brands) {
      try {
        const result = await this.scrapeBrand(brand.slug, sources, progressCallback);
        results.push(result);
      } catch (error) {
        logger.error(`Failed to scrape brand ${brand.name}: ${error.message}`);
        results.push({
          brand: brand.name,
          brandSlug: brand.slug,
          status: 'failed',
          error: error.message,
        });
      }

      // Force garbage collection between brands to reclaim memory
      if (global.gc) {
        global.gc();
        logger.info(`[Memory] GC after ${brand.name} — heap: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
      }
    }

    return results;
  }

  /**
   * Scrape followers for all configured brands (auto-extract after login).
   * Iterates each brand and scrapes followers for its first Instagram handle.
   */
  async scrapeAllBrandFollowers(progressCallback = null) {
    const brands = getAllBrands();
    const results = [];

    for (const brand of brands) {
      const handles = brand.instagram?.handles || [];
      if (!handles.length) {
        logger.info(`[AutoScrape] Skipping ${brand.name} — no Instagram handle configured`);
        continue;
      }

      const handle = handles[0];
      const report = (msg) => {
        if (progressCallback) progressCallback(msg);
        logger.info(msg);
      };

      report(`[AutoScrape] Extracting followers for ${brand.name} (@${handle})...`);

      try {
        const result = await this.scrapeFollowers(handle, brand.name);
        results.push(result);
        report(`[AutoScrape] Got ${result.totalUnique || 0} followers for ${brand.name}`);
      } catch (error) {
        logger.error(`[AutoScrape] Failed followers for ${brand.name}: ${error.message}`);
        results.push({
          brand: brand.name,
          brandSlug: brand.slug,
          status: 'failed',
          error: error.message,
        });
      }

      // Force garbage collection between brands
      if (global.gc) {
        global.gc();
      }
    }

    return results;
  }

  /**
   * Scrape a custom Instagram handle (not in config)
   */
  async scrapeCustomInstagram(handle, brandName) {
    const customers = await this.instagramScraper.scrapeCustom(handle);
    const uniqueCustomers = deduplicateCustomers(customers);

    if (uniqueCustomers.length > 0) {
      const slug = (brandName || handle).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      exportToJson(`${slug}-instagram`, uniqueCustomers);
      exportToCsv(`${slug}-instagram`, uniqueCustomers);
    }

    return {
      brand: brandName || handle,
      handle,
      totalFound: customers.length,
      totalUnique: uniqueCustomers.length,
      customers: uniqueCustomers,
    };
  }

  /**
   * Get job status
   */
  getJob(jobId) {
    return this.activeJobs.get(jobId) || null;
  }

  /**
   * Get all jobs
   */
  getAllJobs() {
    return Array.from(this.activeJobs.values());
  }
}

module.exports = ScraperOrchestrator;

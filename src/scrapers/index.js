const WebsiteScraper = require('./websiteScraper');
const InstagramScraper = require('./instagramScraper');
const FacebookScraper = require('./facebookScraper');
const { getBrand, getAllBrands } = require('../config/brands');
const { deduplicateCustomers } = require('../utils/helpers');
const { exportToJson, exportToCsv } = require('../utils/exporters');
const logger = require('../utils/logger');

/**
 * Scraper Orchestrator
 * Coordinates all scraping operations across different platforms
 *
 * Instagram & Facebook use FREE direct scraping by default.
 * Apify token is optional — used only as a fallback when direct scraping
 * returns 0 results. Website scraping is always free (Cheerio-based).
 */
class ScraperOrchestrator {
  constructor(apifyToken) {
    this.apifyToken = apifyToken;
    this.websiteScraper = new WebsiteScraper();

    // Instagram & Facebook work WITHOUT Apify token (free direct scraping)
    // Apify token is passed as optional fallback
    this.instagramScraper = new InstagramScraper(apifyToken || null);
    this.facebookScraper = new FacebookScraper(apifyToken || null);

    // Track active jobs
    this.activeJobs = new Map();
  }

  /**
   * Scrape a single brand across specified sources
   * @param {string} brandSlug - Brand identifier
   * @param {string[]} sources - Array of sources: ['website', 'instagram', 'facebook']
   * @param {Function} progressCallback - Optional callback for progress updates
   */
  async scrapeBrand(brandSlug, sources = ['website', 'instagram'], progressCallback = null) {
    const brandConfig = getBrand(brandSlug);
    if (!brandConfig) {
      throw new Error(`Unknown brand: ${brandSlug}. Available: ${getAllBrands().map((b) => b.slug).join(', ')}`);
    }

    const jobId = `${brandSlug}-${Date.now()}`;
    const job = {
      id: jobId,
      brand: brandConfig.name,
      brandSlug,
      sources,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: {},
      customers: [],
      errors: [],
    };
    this.activeJobs.set(jobId, job);

    const allCustomers = [];
    const report = (msg) => {
      if (progressCallback) progressCallback(msg);
      logger.info(msg);
    };

    report(`Starting scrape for ${brandConfig.name} from sources: ${sources.join(', ')}`);

    // ---- Website scraping (always free — Cheerio) ----
    if (sources.includes('website')) {
      job.progress.website = { status: 'running', found: 0 };
      report(`[Website] Scraping ${brandConfig.name} website...`);
      try {
        const websiteCustomers = await this.websiteScraper.scrapeBrand(brandConfig);
        allCustomers.push(...websiteCustomers);
        job.progress.website = { status: 'completed', found: websiteCustomers.length };
        report(`[Website] Found ${websiteCustomers.length} customers from website`);
      } catch (error) {
        job.progress.website = { status: 'failed', found: 0 };
        job.errors.push({ source: 'website', error: error.message });
        report(`[Website] Error: ${error.message}`);
      }
    }

    // ---- Instagram scraping (FREE direct + optional Apify fallback) ----
    if (sources.includes('instagram')) {
      job.progress.instagram = { status: 'running', found: 0 };
      report(`[Instagram] Scraping ${brandConfig.name} Instagram (free mode)...`);
      try {
        const igCustomers = await this.instagramScraper.scrapeCommenters(brandConfig.name, brandConfig.instagram);
        allCustomers.push(...igCustomers);
        job.progress.instagram = { status: 'completed', found: igCustomers.length };
        report(`[Instagram] Found ${igCustomers.length} customers from Instagram`);
      } catch (error) {
        job.progress.instagram = { status: 'failed', found: 0 };
        job.errors.push({ source: 'instagram', error: error.message });
        report(`[Instagram] Error: ${error.message}`);
      }
    }

    // ---- Facebook scraping (FREE direct + optional Apify fallback) ----
    if (sources.includes('facebook')) {
      job.progress.facebook = { status: 'running', found: 0 };
      report(`[Facebook] Scraping ${brandConfig.name} Facebook...`);
      try {
        const fbCustomers = await this.facebookScraper.scrapePageCommenters(brandConfig.name, { pageIds: brandConfig.facebook?.pages || [] });
        allCustomers.push(...fbCustomers);
        job.progress.facebook = { status: 'completed', found: fbCustomers.length };
        report(`[Facebook] Found ${fbCustomers.length} customers from Facebook`);
      } catch (error) {
        job.progress.facebook = { status: 'failed', found: 0 };
        job.errors.push({ source: 'facebook', error: error.message });
        report(`[Facebook] Error: ${error.message}`);
      }
    }

    // Deduplicate customers
    const uniqueCustomers = deduplicateCustomers(allCustomers);

    report(`Scraping complete for ${brandConfig.name}. Total unique customers: ${uniqueCustomers.length}`);

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
  async scrapeAllBrands(sources = ['website', 'instagram'], progressCallback = null) {
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
    }

    return results;
  }

  /**
   * Scrape a custom URL (not in config)
   */
  async scrapeCustomUrl(url, brandName) {
    const customers = await this.websiteScraper.scrapeUrl(url, brandName);
    const uniqueCustomers = deduplicateCustomers(customers);

    if (uniqueCustomers.length > 0) {
      const slug = (brandName || 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      exportToJson(slug, uniqueCustomers);
      exportToCsv(slug, uniqueCustomers);
    }

    return {
      brand: brandName || 'Custom',
      url,
      totalFound: customers.length,
      totalUnique: uniqueCustomers.length,
      customers: uniqueCustomers,
    };
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

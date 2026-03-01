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

  /**
   * Scrape a single brand's Instagram
   * @param {string} brandSlug - Brand identifier
   * @param {string[]} sources - Reserved for future use (always ['instagram'])
   * @param {Function} progressCallback - Optional callback for progress updates
   */
  async scrapeBrand(brandSlug, sources = ['instagram'], progressCallback = null) {
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

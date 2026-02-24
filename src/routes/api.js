const express = require('express');
const { getAllBrands, getBrand } = require('../config/brands');
const { loadResults, listExports, exportToJson, exportToCsv, DATA_DIR } = require('../utils/exporters');
const logger = require('../utils/logger');
const path = require('path');

/**
 * Create API router
 * @param {import('../scrapers/index')} orchestrator - The scraper orchestrator instance
 */
function createApiRouter(orchestrator) {
  const router = express.Router();

  // ============================================================
  // GET /api/brands - List all configured brands
  // ============================================================
  router.get('/brands', (req, res) => {
    const brands = getAllBrands().map((b) => ({
      name: b.name,
      slug: b.slug,
      instagram: b.instagram?.handles || [],
      facebook: b.facebook?.pages || [],
      websiteUrls: b.website?.urls || [],
    }));
    res.json({ success: true, brands });
  });

  // ============================================================
  // POST /api/scrape - Start scraping a brand
  // Body: { brand: "slug", sources: ["website","instagram","facebook"] }
  // ============================================================
  router.post('/scrape', async (req, res) => {
    const { brand, sources = ['website', 'instagram'] } = req.body;

    if (!brand) {
      return res.status(400).json({ success: false, error: 'Brand slug is required' });
    }

    const brandConfig = getBrand(brand);
    if (!brandConfig) {
      return res.status(404).json({
        success: false,
        error: `Brand "${brand}" not found`,
        available: getAllBrands().map((b) => b.slug),
      });
    }

    // Start scraping asynchronously
    const jobId = `${brand}-${Date.now()}`;
    res.json({
      success: true,
      message: `Scraping started for ${brandConfig.name}`,
      jobId,
      brand: brandConfig.name,
      sources,
    });

    // Run in background
    orchestrator.scrapeBrand(brand, sources).catch((error) => {
      logger.error(`Background scrape failed for ${brand}: ${error.message}`);
    });
  });

  // ============================================================
  // POST /api/scrape-sync - Synchronous scraping (waits for result)
  // Body: { brand: "slug", sources: ["website","instagram","facebook"] }
  // ============================================================
  router.post('/scrape-sync', async (req, res) => {
    const { brand, sources = ['website', 'instagram'] } = req.body;

    if (!brand) {
      return res.status(400).json({ success: false, error: 'Brand slug is required' });
    }

    const brandConfig = getBrand(brand);
    if (!brandConfig) {
      return res.status(404).json({
        success: false,
        error: `Brand "${brand}" not found`,
        available: getAllBrands().map((b) => b.slug),
      });
    }

    try {
      const result = await orchestrator.scrapeBrand(brand, sources);
      res.json({
        success: true,
        brand: result.brand,
        totalFound: result.totalFound,
        totalUnique: result.totalUnique,
        sources: result.progress,
        errors: result.errors,
        customers: result.customers,
        exports: result.exports,
      });
    } catch (error) {
      logger.error(`Sync scrape failed: ${error.message}`);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================
  // POST /api/scrape-all - Scrape all brands
  // Body: { sources: ["website","instagram"] }
  // ============================================================
  router.post('/scrape-all', async (req, res) => {
    const { sources = ['website', 'instagram'] } = req.body;

    res.json({
      success: true,
      message: 'Scraping all brands started',
      brands: getAllBrands().map((b) => b.name),
      sources,
    });

    orchestrator.scrapeAllBrands(sources).catch((error) => {
      logger.error(`Scrape-all failed: ${error.message}`);
    });
  });

  // ============================================================
  // POST /api/scrape-url - Scrape a custom URL
  // Body: { url: "https://...", brand: "Brand Name" }
  // ============================================================
  router.post('/scrape-url', async (req, res) => {
    const { url, brand } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    try {
      const result = await orchestrator.scrapeCustomUrl(url, brand);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================
  // POST /api/scrape-instagram - Scrape a custom Instagram handle
  // Body: { handle: "username", brand: "Brand Name" }
  // ============================================================
  router.post('/scrape-instagram', async (req, res) => {
    const { handle, brand } = req.body;
    if (!handle) {
      return res.status(400).json({ success: false, error: 'Instagram handle is required' });
    }

    try {
      const result = await orchestrator.scrapeCustomInstagram(handle, brand);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================
  // GET /api/results/:brand - Get latest results for a brand
  // ============================================================
  router.get('/results/:brand', (req, res) => {
    const { brand } = req.params;
    const results = loadResults(brand);

    if (!results) {
      return res.status(404).json({
        success: false,
        error: `No results found for ${brand}. Run a scrape first.`,
      });
    }

    res.json({ success: true, ...results });
  });

  // ============================================================
  // GET /api/exports - List all export files
  // ============================================================
  router.get('/exports', (req, res) => {
    const exports = listExports();
    res.json({ success: true, exports });
  });

  // ============================================================
  // GET /api/download/:filename - Download an export file
  // ============================================================
  router.get('/download/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(DATA_DIR, filename);

    try {
      if (!require('fs').existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
      }
      res.download(filePath);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================
  // GET /api/jobs - List all scraping jobs
  // ============================================================
  router.get('/jobs', (req, res) => {
    const jobs = orchestrator.getAllJobs().map((j) => ({
      id: j.id,
      brand: j.brand,
      status: j.status,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      totalFound: j.totalFound,
      totalUnique: j.totalUnique,
      progress: j.progress,
      errors: j.errors,
    }));
    res.json({ success: true, jobs });
  });

  // ============================================================
  // GET /api/status - Overall status
  // ============================================================
  router.get('/status', (req, res) => {
    const jobs = orchestrator.getAllJobs();
    const running = jobs.filter((j) => j.status === 'running').length;
    const completed = jobs.filter((j) => j.status === 'completed').length;
    const exports = listExports();

    res.json({
      success: true,
      status: {
        apifyConfigured: !!orchestrator.apifyToken,
        freeMode: true,
        runningJobs: running,
        completedJobs: completed,
        totalExports: exports.length,
        configuredBrands: getAllBrands().length,
      },
    });
  });

  return router;
}

module.exports = createApiRouter;

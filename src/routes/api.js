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

  const getRunningJob = () =>
    orchestrator
      .getAllJobs()
      .filter((j) => j.status === 'running')
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null;

  // ============================================================
  // GET /api/brands - List all configured brands
  // ============================================================
  router.get('/brands', (req, res) => {
    const brands = getAllBrands().map((b) => ({
      name: b.name,
      slug: b.slug,
      instagram: b.instagram?.handles || [],
    }));
    res.json({ success: true, brands });
  });

  // ============================================================
  // POST /api/scrape - Start scraping a brand
  // Body: { brand: "slug" }
  // ============================================================
  router.post('/scrape', async (req, res) => {
    const { brand, includeFollowers } = req.body;
    const sources = ['instagram'];

    const runningJob = getRunningJob();
    if (runningJob) {
      return res.status(409).json({
        success: false,
        error: `Another scrape is already running for ${runningJob.brand}. Please wait for it to finish.`,
        runningJob: {
          id: runningJob.id,
          brand: runningJob.brand,
          brandSlug: runningJob.brandSlug,
          startedAt: runningJob.startedAt,
        },
      });
    }

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
    orchestrator.scrapeBrand(brand, sources, null, includeFollowers).catch((error) => {
      logger.error(`Background scrape failed for ${brand}: ${error.message}`);
    });
  });

  // ============================================================
  // POST /api/scrape-sync - Synchronous scraping (waits for result)
  // Body: { brand: "slug" }
  // ============================================================
  router.post('/scrape-sync', async (req, res) => {
    const { brand } = req.body;
    const sources = ['instagram'];

    const runningJob = getRunningJob();
    if (runningJob) {
      return res.status(409).json({
        success: false,
        error: `Another scrape is already running for ${runningJob.brand}. Please wait for it to finish.`,
        runningJob: {
          id: runningJob.id,
          brand: runningJob.brand,
          brandSlug: runningJob.brandSlug,
          startedAt: runningJob.startedAt,
        },
      });
    }

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
  // ============================================================
  router.post('/scrape-all', async (req, res) => {
    const runningJob = getRunningJob();
    if (runningJob) {
      return res.status(409).json({
        success: false,
        error: `Another scrape is already running for ${runningJob.brand}. Please wait for it to finish.`,
        runningJob: {
          id: runningJob.id,
          brand: runningJob.brand,
          brandSlug: runningJob.brandSlug,
          startedAt: runningJob.startedAt,
        },
      });
    }

    res.json({
      success: true,
      message: 'Scraping all brands started',
      brands: getAllBrands().map((b) => b.name),
      sources: ['instagram'],
    });

    orchestrator.scrapeAllBrands().catch((error) => {
      logger.error(`Scrape-all failed: ${error.message}`);
    });
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
  // POST /api/ig-session - Connect Instagram session (optional login)
  // Body: { sessionId: "..." }
  // ============================================================
  router.post('/ig-session', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'A valid session ID is required (paste from browser DevTools)' });
    }

    try {
      orchestrator.setIgSession(sessionId.trim());
      res.json({ success: true, message: 'Instagram session connected. Authenticated features enabled.' });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // POST /api/ig-login - Open browser window for manual Instagram login
  // ============================================================
  router.post('/ig-login', async (req, res) => {
    try {
      const result = await orchestrator.loginIg();
      if (result.success) {
        res.json({ success: true, message: result.message });
      } else {
        res.status(401).json({ success: false, error: result.message });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // POST /api/ig-logout - Disconnect Instagram session
  // ============================================================
  router.post('/ig-logout', (req, res) => {
    orchestrator.clearIgSession();
    res.json({ success: true, message: 'Instagram session disconnected.' });
  });

  // ============================================================
  // POST /api/scrape-followers-all - Auto-scrape followers for all brands
  // ============================================================
  router.post('/scrape-followers-all', async (req, res) => {
    if (!orchestrator.isIgAuthenticated()) {
      return res.status(401).json({ success: false, error: 'Instagram session required. Connect your account first.' });
    }

    const brands = getAllBrands().filter((b) => (b.instagram?.handles || []).length > 0);
    if (!brands.length) {
      return res.status(400).json({ success: false, error: 'No brands with Instagram handles configured.' });
    }

    res.json({
      success: true,
      message: 'Auto-extracting followers for all brands',
      brands: brands.map((b) => b.name),
    });

    // Run in background
    orchestrator.scrapeAllBrandFollowers().catch((error) => {
      logger.error(`scrape-followers-all failed: ${error.message}`);
    });
  });

  // ============================================================
  // POST /api/scrape-followers - Scrape follower list (requires auth)
  // Body: { handle: "username", brand: "Brand Name" }
  // ============================================================
  router.post('/scrape-followers', async (req, res) => {
    const { handle, brand } = req.body;
    if (!handle) {
      return res.status(400).json({ success: false, error: 'Instagram handle is required' });
    }
    if (!orchestrator.isIgAuthenticated()) {
      return res.status(401).json({ success: false, error: 'Instagram session required. Connect your account first.' });
    }

    try {
      const result = await orchestrator.scrapeFollowers(handle.trim().replace(/^@/, ''), brand);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // POST /api/scrape-following - Scrape following list (requires auth)
  // Body: { handle: "username", brand: "Brand Name" }
  // ============================================================
  router.post('/scrape-following', async (req, res) => {
    const { handle, brand } = req.body;
    if (!handle) {
      return res.status(400).json({ success: false, error: 'Instagram handle is required' });
    }
    if (!orchestrator.isIgAuthenticated()) {
      return res.status(401).json({ success: false, error: 'Instagram session required. Connect your account first.' });
    }

    try {
      const result = await orchestrator.scrapeFollowing(handle.trim().replace(/^@/, ''), brand);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
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
      brandSlug: j.brandSlug,
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
    const mem = process.memoryUsage();

    res.json({
      success: true,
      status: {
        mode: 'instagram-only',
        runningJobs: running,
        completedJobs: completed,
        totalExports: exports.length,
        configuredBrands: getAllBrands().length,
        igAuthenticated: orchestrator.isIgAuthenticated(),
        memory: {
          rssMB: Math.round(mem.rss / 1024 / 1024),
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          externalMB: Math.round(mem.external / 1024 / 1024),
        },
      },
    });
  });

  return router;
}

module.exports = createApiRouter;

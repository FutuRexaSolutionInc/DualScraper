require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const logger = require('./src/utils/logger');
const ScraperOrchestrator = require('./src/scrapers/index');
const createApiRouter = require('./src/routes/api');

// ============================================================
// Configuration
// ============================================================
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost');

// Ensure required directories exist
const dirs = ['data', 'logs'];
for (const dir of dirs) {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ============================================================
// Initialize Scraper
// ============================================================
const orchestrator = new ScraperOrchestrator();

// ============================================================
// Express App
// ============================================================
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    logger.info(`${req.method} ${req.path}`);
  }
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', createApiRouter(orchestrator));

// Serve frontend for all other routes (SPA)
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ============================================================
// Start Server
// ============================================================
app.listen(PORT, HOST, () => {
  logger.info('========================================================');
  logger.info(`  DualScraper is running!`);
  logger.info(`  Local:   http://${HOST}:${PORT}`);
  logger.info(`  API:     http://${HOST}:${PORT}/api`);
  logger.info(`  Mode:    Instagram-only (free, Puppeteer + internal API)`);
  logger.info('========================================================');
});

module.exports = app;

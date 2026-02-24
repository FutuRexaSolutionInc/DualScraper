const fs = require('fs');
const path = require('path');
const { Parser: CsvParser } = require('json2csv');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '../../data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Export customer data to JSON file
 */
function exportToJson(brand, customers, filename) {
  const filePath = path.join(DATA_DIR, filename || `${brand}-customers-${Date.now()}.json`);
  const output = {
    brand,
    totalCustomers: customers.length,
    exportedAt: new Date().toISOString(),
    customers,
  };
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf-8');
  logger.info(`Exported ${customers.length} customers to ${filePath}`);
  return filePath;
}

/**
 * Export customer data to CSV file
 */
function exportToCsv(brand, customers, filename) {
  const filePath = path.join(DATA_DIR, filename || `${brand}-customers-${Date.now()}.csv`);

  const fields = [
    'id', 'name', 'username', 'profileUrl', 'source',
    'brand', 'comment', 'date', 'engagement', 'scrapedAt',
  ];

  const parser = new CsvParser({ fields });
  const csv = parser.parse(customers);

  fs.writeFileSync(filePath, csv, 'utf-8');
  logger.info(`Exported ${customers.length} customers to CSV at ${filePath}`);
  return filePath;
}

/**
 * Load previously saved results
 */
function loadResults(brand) {
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(brand) && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const filePath = path.join(DATA_DIR, files[0]);
  const data = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(data);
}

/**
 * List all export files
 */
function listExports() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') || f.endsWith('.csv'))
    .map((f) => ({
      filename: f,
      path: path.join(DATA_DIR, f),
      size: fs.statSync(path.join(DATA_DIR, f)).size,
      created: fs.statSync(path.join(DATA_DIR, f)).birthtime,
    }));
}

module.exports = { exportToJson, exportToCsv, loadResults, listExports, DATA_DIR };

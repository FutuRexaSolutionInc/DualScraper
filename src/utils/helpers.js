const { v4: uuidv4 } = require('uuid');

/**
 * Normalize and deduplicate customer records
 */
function deduplicateCustomers(customers) {
  const seen = new Map();
  for (const c of customers) {
    const key = (c.username || c.name || c.email || '').toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.set(key, c);
    } else if (key && seen.has(key)) {
      // Merge extra info
      const existing = seen.get(key);
      seen.set(key, { ...existing, ...c, sources: mergeArrays(existing.sources, c.sources) });
    }
  }
  return Array.from(seen.values());
}

/**
 * Merge two arrays, deduplicating values
 */
function mergeArrays(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

/**
 * Create a standardized customer record
 */
function createCustomerRecord({ name, username, profileUrl, source, brand, comment, date, engagement }) {
  return {
    id: uuidv4(),
    name: name || null,
    username: username || null,
    profileUrl: profileUrl || null,
    source: source || 'unknown',
    brand: brand || null,
    comment: comment || null,
    date: date || null,
    engagement: engagement || null,
    scrapedAt: new Date().toISOString(),
    sources: [source],
  };
}

/**
 * Delay utility for rate limiting
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safe JSON parse
 */
function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Clean text: remove extra whitespace, newlines
 */
function cleanText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract usernames from text (e.g., @username mentions)
 */
function extractMentions(text) {
  if (!text) return [];
  const mentionRegex = /@([a-zA-Z0-9_.]+)/g;
  const mentions = [];
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}

/**
 * Truncate string for display
 */
function truncate(str, maxLen = 100) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
}

module.exports = {
  deduplicateCustomers,
  mergeArrays,
  createCustomerRecord,
  delay,
  safeJsonParse,
  cleanText,
  extractMentions,
  truncate,
};

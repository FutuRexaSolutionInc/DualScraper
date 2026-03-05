const { v4: uuidv4 } = require('uuid');

/**
 * Normalize and deduplicate customer records.
 * When a user appears in both comments and likes, merge their engagement
 * records and keep all comments. Ensures no duplicate entries per username.
 */
function deduplicateCustomers(customers) {
  const seen = new Map();
  for (const c of customers) {
    const key = (c.username || c.name || c.email || '').toLowerCase().trim();
    if (!key) continue;

    if (!seen.has(key)) {
      // First occurrence — store with engagements array
      const record = { ...c };
      record.engagements = [];
      if (c.engagement) {
        record.engagements.push({
          type: c.engagement.type,
          postCode: c.engagement.postCode,
          comment: c.comment || null,
        });
      }
      seen.set(key, record);
    } else {
      // Merge: accumulate engagement records, prefer richer name
      const existing = seen.get(key);
      if (c.name && (!existing.name || existing.name === existing.username)) {
        existing.name = c.name;
      }
      existing.sources = mergeArrays(existing.sources, c.sources);

      // Add new engagement if not already tracked
      if (c.engagement) {
        const isDupe = existing.engagements.some(
          (e) => e.type === c.engagement.type && e.postCode === c.engagement.postCode
        );
        if (!isDupe) {
          existing.engagements.push({
            type: c.engagement.type,
            postCode: c.engagement.postCode,
            comment: c.comment || null,
          });
        }
      }

      // Keep the first non-null comment as the primary display comment
      if (!existing.comment && c.comment) {
        existing.comment = c.comment;
      }

      // Derive a combined engagement summary
      const types = [...new Set(existing.engagements.map((e) => e.type))];
      existing.engagement = {
        type: types.join(', '),
        postCode: existing.engagements.map((e) => e.postCode).filter(Boolean).join(', '),
      };

      seen.set(key, existing);
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
 * Decode unicode escape sequences (\uXXXX) into actual characters.
 * Instagram API sometimes returns emoji as raw escape sequences.
 */
function decodeUnicodeEscapes(text) {
  if (!text || typeof text !== 'string' || !text.includes('\\u')) return text;
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/**
 * Create a standardized customer record
 */
function createCustomerRecord({ name, username, profileUrl, source, brand, comment, date, engagement }) {
  return {
    id: uuidv4(),
    name: decodeUnicodeEscapes(name) || null,
    username: username || null,
    profileUrl: profileUrl || null,
    source: source || 'unknown',
    brand: brand || null,
    comment: decodeUnicodeEscapes(comment) || null,
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
  decodeUnicodeEscapes,
  delay,
  safeJsonParse,
  cleanText,
  extractMentions,
  truncate,
};

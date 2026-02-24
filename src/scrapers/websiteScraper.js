const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../utils/logger');
const { createCustomerRecord, delay, cleanText } = require('../utils/helpers');

/**
 * Website Scraper
 * Scrapes brand websites to extract:
 * - Product review authors (customers who reviewed products)
 * - Testimonial names
 * - Contact/mention names
 */
class WebsiteScraper {
  constructor() {
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];
  }

  _getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  /**
   * Fetch page HTML with retry logic
   */
  async fetchPage(url, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': this._getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
          },
          timeout: 30000,
          maxRedirects: 5,
        });
        return response.data;
      } catch (error) {
        logger.warn(`Attempt ${attempt}/${retries} failed for ${url}: ${error.message}`);
        if (attempt < retries) {
          await delay(2000 * attempt);
        }
      }
    }
    return null;
  }

  /**
   * Extract review/customer data from a page using selectors
   */
  extractCustomersFromHtml(html, brandConfig, url) {
    const customers = [];
    const $ = cheerio.load(html);
    const brandName = brandConfig.name;

    // ---- Strategy 1: Known review selectors ----
    const reviewSelectors = brandConfig.website.reviewSelectors || [];
    const customerSelectors = brandConfig.website.customerSelectors || [];

    for (const selector of reviewSelectors) {
      $(selector).each((_, el) => {
        const reviewEl = $(el);

        // Try to find customer name within or near the review
        let name = null;
        for (const nameSelector of customerSelectors) {
          const nameEl = reviewEl.find(nameSelector).first();
          if (nameEl.length) {
            name = cleanText(nameEl.text());
            break;
          }
        }

        // Fallback: look for generic name patterns
        if (!name) {
          const authorEl = reviewEl.find('[class*="author"], [class*="name"], [class*="user"], [itemprop="author"]').first();
          if (authorEl.length) {
            name = cleanText(authorEl.text());
          }
        }

        const commentEl = reviewEl.find('[class*="body"], [class*="content"], [class*="text"], [itemprop="reviewBody"]').first();
        const comment = commentEl.length ? cleanText(commentEl.text()) : cleanText(reviewEl.text());

        const dateEl = reviewEl.find('[class*="date"], time, [datetime], [itemprop="datePublished"]').first();
        const date = dateEl.length ? cleanText(dateEl.attr('datetime') || dateEl.text()) : null;

        if (name && name.length > 1 && name.length < 100) {
          customers.push(createCustomerRecord({
            name,
            username: null,
            profileUrl: null,
            source: 'website',
            brand: brandName,
            comment: comment ? comment.substring(0, 500) : null,
            date,
            engagement: 'review',
          }));
        }
      });
    }

    // ---- Strategy 2: Schema.org structured data ----
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const jsonLd = JSON.parse($(el).html());
        const reviews = jsonLd.review || jsonLd.reviews ||
          (Array.isArray(jsonLd) ? jsonLd.filter((i) => i['@type'] === 'Review') : []);

        const reviewArray = Array.isArray(reviews) ? reviews : [reviews];
        for (const review of reviewArray) {
          if (review && review.author) {
            const authorName = typeof review.author === 'string'
              ? review.author
              : review.author.name || review.author['@value'] || null;

            if (authorName && authorName.length > 1 && authorName.length < 100) {
              customers.push(createCustomerRecord({
                name: cleanText(authorName),
                username: null,
                profileUrl: null,
                source: 'website',
                brand: brandName,
                comment: review.reviewBody ? review.reviewBody.substring(0, 500) : null,
                date: review.datePublished || null,
                engagement: 'review',
              }));
            }
          }
        }
      } catch {
        // skip invalid JSON-LD
      }
    });

    // ---- Strategy 3: Testimonials / generic patterns ----
    $('[class*="testimonial"], [class*="Testimonial"], [id*="testimonial"]').each((_, el) => {
      const testimonialEl = $(el);
      const nameEl = testimonialEl.find('[class*="name"], [class*="author"], cite, strong').first();
      const name = nameEl.length ? cleanText(nameEl.text()) : null;
      const text = cleanText(testimonialEl.text());

      if (name && name.length > 1 && name.length < 100) {
        customers.push(createCustomerRecord({
          name,
          username: null,
          profileUrl: null,
          source: 'website',
          brand: brandName,
          comment: text ? text.substring(0, 500) : null,
          date: null,
          engagement: 'testimonial',
        }));
      }
    });

    // ---- Strategy 4: Check for Yotpo / Judge.me / Stamped widget containers ----
    const widgetContainers = [
      '.yotpo-review', '.jdgm-rev', '.stamped-review', '.spr-review',
      '.loox-review', '.rivyo-review', '.ali-review',
    ];
    for (const wSelector of widgetContainers) {
      $(wSelector).each((_, el) => {
        const rev = $(el);
        const nameEl = rev.find('[class*="name"], [class*="author"]').first();
        const name = nameEl.length ? cleanText(nameEl.text()) : null;
        if (name && name.length > 1 && name.length < 100) {
          customers.push(createCustomerRecord({
            name,
            source: 'website',
            brand: brandName,
            engagement: 'review-widget',
          }));
        }
      });
    }

    logger.info(`Extracted ${customers.length} customers from ${url}`);
    return customers;
  }

  /**
   * Scrape all configured URLs for a brand
   */
  async scrapeBrand(brandConfig) {
    const allCustomers = [];
    const urls = brandConfig.website.urls || [];

    for (const url of urls) {
      try {
        logger.info(`Scraping website: ${url}`);
        const html = await this.fetchPage(url);
        if (html) {
          const customers = this.extractCustomersFromHtml(html, brandConfig, url);
          allCustomers.push(...customers);
        } else {
          logger.warn(`Could not fetch: ${url}`);
        }
        // Rate limit between pages
        await delay(1500);
      } catch (error) {
        logger.error(`Error scraping ${url}: ${error.message}`);
      }
    }

    return allCustomers;
  }

  /**
   * Scrape a custom URL
   */
  async scrapeUrl(url, brandName) {
    const genericConfig = {
      name: brandName || 'Unknown Brand',
      website: {
        reviewSelectors: [
          '.product-review', '.review', '.testimonial', '.customer-review',
          '[data-review]', '.spr-review', '.yotpo-review', '.judge-me-review',
          '.stamped-review', '.bv-content-review',
        ],
        customerSelectors: [
          '.review-author', '.reviewer-name', '.customer-name',
          '.spr-review-header-byline', '.yotpo-user-name', '.bv-author',
        ],
      },
    };

    const html = await this.fetchPage(url);
    if (!html) return [];
    return this.extractCustomersFromHtml(html, genericConfig, url);
  }
}

module.exports = WebsiteScraper;

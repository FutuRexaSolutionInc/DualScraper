/**
 * Brand configuration for DualScraper
 * Contains actual brand URLs, social media handles, and scraping targets
 */

const brands = {
  'nabila-shampoo': {
    name: 'Nabila Shampoo',
    slug: 'nabila-shampoo',
    website: {
      urls: [
        'https://www.nabila.pk',
        'https://www.nabila.pk/collections/hair-care',
        'https://www.nabila.pk/collections/shampoo',
      ],
      reviewSelectors: [
        '.product-review', '.review', '.testimonial', '.customer-review',
        '[data-review]', '.spr-review', '.shopify-review', '.yotpo-review',
        '.judge-me-review', '.stamped-review',
      ],
      customerSelectors: [
        '.review-author', '.reviewer-name', '.customer-name',
        '.spr-review-header-byline', '.yotpo-user-name',
      ],
    },
    instagram: {
      handles: ['nabilasalon', 'nabilacosmetics', 'nabilahaircare'],
      hashtags: ['nabilashampoo', 'nabilahaircare', 'nabilacosmetics', 'nabilapk'],
    },
    facebook: {
      pages: ['NabilaSalon', 'NabilaCosmetics'],
    },
  },

  'truly-komal': {
    name: 'Truly Komal',
    slug: 'truly-komal',
    website: {
      urls: [
        'https://trulykomal.com',
        'https://trulykomal.com/collections/all',
        'https://trulykomal.com/pages/reviews',
      ],
      reviewSelectors: [
        '.product-review', '.review', '.testimonial', '.customer-review',
        '[data-review]', '.spr-review', '.yotpo-review', '.judge-me-review',
      ],
      customerSelectors: [
        '.review-author', '.reviewer-name', '.customer-name',
        '.spr-review-header-byline', '.yotpo-user-name',
      ],
    },
    instagram: {
      handles: ['trulykomal', 'trulykomalofficial'],
      hashtags: ['trulykomal', 'trulykomalproducts', 'trulykomalbeauty'],
    },
    facebook: {
      pages: ['TrulyKomal'],
    },
  },

  'conatural': {
    name: 'Conatural',
    slug: 'conatural',
    website: {
      urls: [
        'https://www.conatural.com',
        'https://www.conatural.com/collections/all',
        'https://www.conatural.com/pages/reviews',
      ],
      reviewSelectors: [
        '.product-review', '.review', '.testimonial', '.customer-review',
        '[data-review]', '.spr-review', '.yotpo-review', '.judge-me-review',
        '.stamped-review',
      ],
      customerSelectors: [
        '.review-author', '.reviewer-name', '.customer-name',
        '.spr-review-header-byline', '.yotpo-user-name',
      ],
    },
    instagram: {
      handles: ['conaturalofficial', 'conatural'],
      hashtags: ['conatural', 'conaturalbeauty', 'conaturalproducts', 'conaturalpk'],
    },
    facebook: {
      pages: ['Conatural'],
    },
  },

  'tresemme': {
    name: 'TRESemmé',
    slug: 'tresemme',
    website: {
      urls: [
        'https://www.tresemme.com',
        'https://www.tresemme.com/us/en/products.html',
      ],
      reviewSelectors: [
        '.product-review', '.review', '.testimonial', '.customer-review',
        '[data-review]', '.bv-content-review', '.bazaarvoice',
        '.pr-review', '.ugc-review',
      ],
      customerSelectors: [
        '.review-author', '.reviewer-name', '.bv-author',
        '.pr-review-author-name', '.ugc-author',
      ],
    },
    instagram: {
      handles: ['tresemme', 'tresemmeindia', 'tresemmepakistan'],
      hashtags: ['tresemme', 'tresemmehair', 'tresemmeproducts', 'tresemmeshampoo'],
    },
    facebook: {
      pages: ['TRESemme'],
    },
  },

  'loreal': {
    name: "L'Oréal",
    slug: 'loreal',
    website: {
      urls: [
        'https://www.lorealparis.com',
        'https://www.lorealparisusa.com/hair-care',
        'https://www.lorealparis.co.in',
      ],
      reviewSelectors: [
        '.product-review', '.review', '.testimonial', '.customer-review',
        '[data-review]', '.bv-content-review', '.bazaarvoice',
        '.pr-review', '.ugc-review',
      ],
      customerSelectors: [
        '.review-author', '.reviewer-name', '.bv-author',
        '.pr-review-author-name', '.ugc-author',
      ],
    },
    instagram: {
      handles: ['lorealparis', 'loraborosbeauty', 'lorealparisind'],
      hashtags: ['loreal', 'lorealparis', 'lorealproducts', 'lorealhair'],
    },
    facebook: {
      pages: ['LOrealParis', 'LOrealParisUSA'],
    },
  },

  'toni-and-guy': {
    name: 'Toni & Guy',
    slug: 'toni-and-guy',
    website: {
      urls: [
        'https://www.toniandguy.com',
        'https://www.toniandguy.com/hair-products',
      ],
      reviewSelectors: [
        '.product-review', '.review', '.testimonial', '.customer-review',
        '[data-review]', '.bv-content-review', '.bazaarvoice',
        '.pr-review', '.ugc-review',
      ],
      customerSelectors: [
        '.review-author', '.reviewer-name', '.bv-author',
        '.pr-review-author-name', '.ugc-author',
      ],
    },
    instagram: {
      handles: ['tikiandguy', 'toniandguyworld', 'toniandguyuk'],
      hashtags: ['toniandguy', 'toniandguyhair', 'toniandguyproducts'],
    },
    facebook: {
      pages: ['ToniAndGuy', 'ToniAndGuyWorld'],
    },
  },
};

/**
 * Get brand config by slug
 */
function getBrand(slug) {
  return brands[slug] || null;
}

/**
 * Get all brand slugs
 */
function getAllBrandSlugs() {
  return Object.keys(brands);
}

/**
 * Get all brands as array
 */
function getAllBrands() {
  return Object.values(brands);
}

module.exports = { brands, getBrand, getAllBrandSlugs, getAllBrands };

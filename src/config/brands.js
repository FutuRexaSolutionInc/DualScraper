/**
 * Brand configuration for DualScraper
 * Instagram-only scraping — one official handle per brand
 */

const brands = {
  'nabila-haircare': {
    name: 'Nabila Haircare',
    slug: 'nabila-haircare',
    instagram: {
      handles: ['nabilahaircare'],
      hashtags: ['nabilahaircare', 'nabilashampoo'],
    },
  },

  'truly-komal': {
    name: 'Truly Komal',
    slug: 'truly-komal',
    instagram: {
      handles: ['trulykomalofficial'],
      hashtags: ['trulykomal', 'trulykomalbeauty'],
    },
  },

  'conatural': {
    name: 'Conatural',
    slug: 'conatural',
    instagram: {
      handles: ['conatural'],
      hashtags: ['conatural', 'conaturalbeauty'],
    },
  },

  'tresemme': {
    name: 'TRESemmé',
    slug: 'tresemme',
    instagram: {
      handles: ['tresemme'],
      hashtags: ['tresemme', 'tresemmehair'],
    },
  },

  'loreal': {
    name: "L'Oréal",
    slug: 'loreal',
    instagram: {
      handles: ['lorealparis'],
      hashtags: ['lorealparis', 'loreal'],
    },
  },

  'toni-and-guy': {
    name: 'Toni & Guy',
    slug: 'toni-and-guy',
    instagram: {
      handles: ['toniandguypk'],
      hashtags: ['toniandguy', 'toniandguypk'],
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

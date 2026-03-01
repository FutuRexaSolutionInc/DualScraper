# DualScraper — Brand Customer List Extractor

A fully operational **free** Node.js web-based scraping tool that extracts customer/user lists from brand websites and social media accounts (Instagram, Facebook) using **Puppeteer** (headless Chrome with stealth).

> **100% Free** — No API keys, no paid services, no credit limits. Uses your system's Chrome/Edge browser with stealth anti-detection.

## Supported Brands (Pre-configured)

| Brand | Website | Instagram | Facebook |
|-------|---------|-----------|----------|
| **Nabila Shampoo** | nabila.pk | @nabilasalon, @nabilacosmetics, @nabilahaircare | NabilaSalon, NabilaCosmetics |
| **Truly Komal** | trulykomal.com | @trulykomal, @trulykomalofficial | TrulyKomal |
| **Conatural** | conatural.com | @conaturalofficial, @conatural | Conatural |
| **TRESemmé** | tresemme.com | @tresemme, @tresemmeindia, @tresemmepakistan | TRESemme |
| **L'Oréal** | lorealparis.com | @lorealparis, @loraborosbeauty, @lorealparisind | LOrealParis, LOrealParisUSA |
| **Toni & Guy** | toniandguy.com | @tikiandguy, @toniandguyworld, @toniandguyuk | ToniAndGuy, ToniAndGuyWorld |

## Features

- **Website Scraping** — Extracts reviewers, testimonial authors, and customer names from brand websites using Cheerio (handles reviews, Schema.org data, testimonials, widget-based reviews like Yotpo/Judge.me/Stamped)
- **Instagram Scraping** — Extracts commenters and engagers from public profiles using Puppeteer (headless Chrome + stealth plugin)
- **Facebook Scraping** — Extracts commenters and engagers from public pages using Puppeteer (mbasic + www strategies)
- **Custom Scraping** — Scrape any URL or Instagram handle not in the pre-configured list
- **Web Dashboard** — Beautiful dark-themed UI with real-time progress, results tables, and job management
- **Export** — Download results as JSON or CSV
- **Deduplication** — Automatically deduplicates customer records across all sources
- **Rate Limiting** — Built-in random delays to mimic human browsing behavior
- **Stealth Mode** — Anti-detection plugin to avoid bot blocking

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure (Optional)

Create a `.env` file (or use the default):

```env
PORT=3000
# Optional: Apify token for fallback when Puppeteer can't extract enough data
# APIFY_API_TOKEN=your_token_here
```

> **No API keys needed!** The tool uses your system's Chrome or Edge browser with Puppeteer for all scraping. An Apify token is completely optional (used only as a last-resort fallback).

### 3. Start the Server

```bash
npm start
```

Open **http://localhost:3000** in your browser.

## Requirements

- **Node.js** 18+
- **Google Chrome** or **Microsoft Edge** installed on your system (Puppeteer uses it in headless mode)

## Usage

### Web Dashboard

1. **Dashboard** — View all configured brands, stats, and recent jobs
2. **Scrape Brands** — Select a brand + data sources → click "Start Scraping"
3. **Custom Scrape** — Enter any website URL or Instagram handle to extract customers
4. **Results** — View previously scraped data by brand
5. **Exports** — Download JSON/CSV files of scraped customer lists

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/brands` | List all configured brands |
| `POST` | `/api/scrape-sync` | Scrape a brand (synchronous, waits for result) |
| `POST` | `/api/scrape` | Scrape a brand (async, returns job ID) |
| `POST` | `/api/scrape-all` | Scrape all brands |
| `POST` | `/api/scrape-url` | Scrape a custom website URL |
| `POST` | `/api/scrape-instagram` | Scrape a custom Instagram handle |
| `GET` | `/api/results/:brand` | Get latest results for a brand |
| `GET` | `/api/exports` | List all export files |
| `GET` | `/api/download/:filename` | Download an export file |
| `GET` | `/api/jobs` | List all scraping jobs |
| `GET` | `/api/status` | System status |

### API Examples

```bash
# Scrape Truly Komal from website + Instagram
curl -X POST http://localhost:3000/api/scrape-sync \
  -H "Content-Type: application/json" \
  -d '{"brand": "truly-komal", "sources": ["website", "instagram"]}'

# Scrape a custom URL
curl -X POST http://localhost:3000/api/scrape-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.example.com/reviews", "brand": "Example Brand"}'

# Scrape a custom Instagram handle
curl -X POST http://localhost:3000/api/scrape-instagram \
  -H "Content-Type: application/json" \
  -d '{"handle": "brandname", "brand": "Brand Name"}'
```

## Project Structure

```
DualScraper/
├── server.js                      # Express server entry point
├── .env                           # Environment config (optional Apify token)
├── package.json
├── public/                        # Web dashboard
│   ├── index.html
│   ├── css/styles.css
│   └── js/app.js
├── src/
│   ├── config/
│   │   └── brands.js              # Brand configurations (URLs, handles, selectors)
│   ├── scrapers/
│   │   ├── index.js               # Scraper orchestrator
│   │   ├── websiteScraper.js      # Website review/testimonial scraper (Cheerio)
│   │   ├── instagramScraper.js    # Instagram scraper (Puppeteer + stealth)
│   │   └── facebookScraper.js     # Facebook scraper (Puppeteer + stealth)
│   ├── routes/
│   │   └── api.js                 # REST API routes
│   └── utils/
│       ├── helpers.js             # Deduplication, record creation, etc.
│       ├── exporters.js           # JSON/CSV export
│       └── logger.js              # Winston logger
├── data/                          # Scraped data output (JSON/CSV)
└── logs/                          # Application logs
```

## How It Works

### Data Extraction Strategy

1. **Website Scraper** (Cheerio — always free):
   - Fetches brand website HTML with randomized User-Agents
   - Parses reviews using CSS selectors for popular review widgets (Yotpo, Judge.me, Stamped, Shopify SPR, BazaarVoice)
   - Extracts Schema.org/JSON-LD structured review data
   - Finds testimonial sections
   - Retries failed requests with progressive backoff

2. **Instagram Scraper** (Puppeteer — free):
   - Launches headless Chrome with stealth anti-detection plugin
   - Navigates to brand profile pages
   - Extracts post shortcodes from the profile grid
   - Visits each post page to extract commenters and engagers
   - Scrapes hashtag explore pages for additional customers
   - Falls back to Apify only if token is configured AND Puppeteer found 0 results

3. **Facebook Scraper** (Puppeteer — free):
   - Launches headless Chrome with stealth anti-detection
   - Primary: Navigates to mbasic.facebook.com (lightweight HTML, easier to parse)
   - Secondary: Falls back to www.facebook.com with JS rendering
   - Extracts profile links, commenter names, and engagement data
   - Falls back to Apify only if token is configured AND Puppeteer found 0 results

### Customer Record Format

Each extracted customer record contains:
```json
{
  "id": "uuid",
  "name": "Customer Name",
  "username": "social_handle",
  "profileUrl": "https://instagram.com/handle",
  "source": "instagram",
  "brand": "Truly Komal",
  "comment": "Love this product!",
  "date": "2025-01-15",
  "engagement": { "type": "comment", "postCode": "ABC123" },
  "scrapedAt": "2026-02-23T12:00:00.000Z"
}
```

## Adding New Brands

Edit `src/config/brands.js` to add new brands:

```javascript
'new-brand': {
  name: 'New Brand',
  slug: 'new-brand',
  website: {
    urls: ['https://www.newbrand.com', 'https://www.newbrand.com/reviews'],
    reviewSelectors: ['.review', '.product-review'],
    customerSelectors: ['.review-author', '.reviewer-name'],
  },
  instagram: {
    handles: ['newbrand'],
    hashtags: ['newbrand', 'newbrandproducts'],
  },
  facebook: {
    pages: ['NewBrand'],
  },
},
```

## Known Limitations

- **Instagram hashtag pages** require login — profile scraping works without login, but hashtag explore pages may show a login wall
- **Facebook login walls** — mbasic.facebook.com may redirect to login for some content; the scraper extracts what's visible without login
- **Rate limiting** — Instagram and Facebook may temporarily block access if too many requests are made in a short time. The scraper includes random delays to mitigate this.

## License

ISC

## Deploy on Render (Frontend + Backend Together)

This project can run as a **single Render Web Service** because Express serves both API and frontend from `public/`.

### 1) Push latest code to GitHub

Make sure these files are in your repo:

- `Dockerfile`
- `render.yaml`

### 2) Create Web Service on Render

1. Log in to Render
2. Click **New +** → **Blueprint** (recommended)
3. Connect your GitHub repo: `FutuRexaSolutionInc/DualScraper`
4. Render will auto-detect `render.yaml`
5. Click **Apply** to create the service

> If you use **Web Service** instead of Blueprint, select **Docker** environment manually.

### 3) Environment Variables

Set (or confirm) these in Render service settings:

- `NODE_ENV=production`
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` (already set in Dockerfile, but safe to keep explicit)

### 4) Deploy

Render will build Docker image and start:

- Command: `node server.js`
- Port: Render injects `PORT` automatically

### 5) Verify

After deploy completes, open:

- `https://<your-render-service>.onrender.com`

Then verify:

- `https://<your-render-service>.onrender.com/api/status`
- Start one brand scrape from dashboard to confirm Puppeteer works in cloud

### Notes

- Free Render instances can sleep when idle and may start slowly.
- Instagram may rate-limit cloud IPs, so scrape in moderate batches.

/**
 * Verify Instagram handles for all brands using Puppeteer
 * Checks if each profile exists and is accessible
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const allHandles = {
  'Nabila Shampoo': ['nabilasalon', 'nabilacosmetics', 'nabilahaircare'],
  'Truly Komal': ['trulykomal', 'trulykomalofficial'],
  'Conatural': ['conaturalofficial', 'conatural'],
  'TRESemmé': ['tresemme', 'tresemmeindia', 'tresemmepakistan'],
  "L'Oréal": ['lorealparis', 'loraborosbeauty', 'lorealparisind'],
  'Toni & Guy': ['tikiandguy', 'toniandguyworld', 'toniandguyuk'],
};

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const page = await browser.newPage();

  console.log('\n=== INSTAGRAM HANDLE VERIFICATION ===\n');

  for (const [brand, handles] of Object.entries(allHandles)) {
    console.log(`\n--- ${brand} ---`);
    for (const handle of handles) {
      try {
        const url = `https://www.instagram.com/${handle}/`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2000));

        const result = await page.evaluate(() => {
          const html = document.documentElement.innerHTML;
          const title = document.title;

          // Check for "page not found"
          if (html.includes("this page isn't available") || 
              html.includes('Page Not Found') ||
              title.includes('Page not found')) {
            return { status: 'NOT_FOUND', title, followers: null, posts: null, bio: null };
          }

          // Try to get follower count and post count from meta or page content
          let followers = null;
          let posts = null;
          let bio = null;
          let fullName = null;

          // From meta description
          const metaDesc = document.querySelector('meta[name="description"]');
          if (metaDesc) {
            const content = metaDesc.getAttribute('content') || '';
            const followersMatch = content.match(/([\d,.]+[KMkm]?)\s*Followers/i);
            const postsMatch = content.match(/([\d,.]+)\s*Posts/i);
            if (followersMatch) followers = followersMatch[1];
            if (postsMatch) posts = postsMatch[1];
            // Bio is usually after the dash
            const bioMatch = content.match(/- (.+)/);
            if (bioMatch) bio = bioMatch[1].substring(0, 100);
          }

          // Try JSON-LD / embedded data
          const scripts = document.querySelectorAll('script[type="application/json"]');
          scripts.forEach(s => {
            try {
              const json = JSON.parse(s.textContent);
              const str = JSON.stringify(json);
              const nameMatch = str.match(/"full_name"\s*:\s*"([^"]+)"/);
              if (nameMatch) fullName = nameMatch[1];
            } catch {}
          });

          // Check if it's a private account
          const isPrivate = html.includes('This account is private') || html.includes('"is_private":true');

          return { 
            status: isPrivate ? 'PRIVATE' : 'EXISTS',
            title,
            followers,
            posts,
            bio,
            fullName,
          };
        });

        if (result.status === 'NOT_FOUND') {
          console.log(`  ❌ @${handle} — NOT FOUND (page doesn't exist)`);
        } else if (result.status === 'PRIVATE') {
          console.log(`  🔒 @${handle} — PRIVATE | ${result.fullName || ''} | ${result.followers || '?'} followers`);
        } else {
          console.log(`  ✅ @${handle} — OK | ${result.fullName || result.title} | ${result.followers || '?'} followers | ${result.posts || '?'} posts`);
          if (result.bio) console.log(`     Bio: ${result.bio}`);
        }
      } catch (err) {
        console.log(`  ⚠️  @${handle} — ERROR: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  await browser.close();
  console.log('\n=== VERIFICATION COMPLETE ===\n');
})();

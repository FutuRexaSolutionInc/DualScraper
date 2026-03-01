/* ============================================================
   DualScraper — Frontend Application
   ============================================================ */
(function () {
  'use strict';

  // ── SVG Icon Templates ──────────────────────────────────────
  const SVG = {
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    fileDoc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    externalLink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };

  // ── Helpers ──────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function icon(name, cls) {
    const svg = SVG[name] || '';
    if (!cls) return svg;
    return svg.replace('<svg ', `<svg class="${cls}" `);
  }

  // ── State ───────────────────────────────────────────────────
  let brands = [];
  let currentPage = 1;
  const PAGE_SIZE = 25;

  // ── Init ────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupTabs();
    setupButtons();
    loadBrands();
    checkStatus();
    setInterval(checkStatus, 30000);
  });

  // ── Navigation ──────────────────────────────────────────────
  function setupNavigation() {
    $$('.nav-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.dataset.view;
        $$('.nav-item').forEach((n) => n.classList.remove('active'));
        item.classList.add('active');
        $$('.view').forEach((v) => v.classList.remove('active'));
        $(`#view-${view}`).classList.add('active');
      });
    });
  }

  // ── Tabs ────────────────────────────────────────────────────
  function setupTabs() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.tab-content').forEach((c) => c.classList.remove('active'));
        $(`#tab-${btn.dataset.tab}`).classList.add('active');
      });
    });
  }

  // ── Button Handlers ─────────────────────────────────────────
  function setupButtons() {
    $('#btnScrape').addEventListener('click', startScrape);
    $('#btnScrapeAll').addEventListener('click', scrapeAll);
    $('#btnScrapeIg').addEventListener('click', scrapeCustomInstagram);
    $('#btnLoadResults').addEventListener('click', loadSavedResults);
  }

  // ── Load Brands ─────────────────────────────────────────────
  async function loadBrands() {
    try {
      const res = await fetch('/api/brands');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      brands = data.brands;

      // Populate selects
      const selects = [$('#brandSelect'), $('#resultsBrandSelect')];
      selects.forEach((sel) => {
        brands.forEach((b) => {
          const opt = document.createElement('option');
          opt.value = b.slug;
          opt.textContent = b.name;
          sel.appendChild(opt);
        });
      });

      // Stat
      $('#statBrands').textContent = brands.length;

      // Brand cards
      renderBrandCards();
    } catch (err) {
      showToast('Failed to load brands: ' + err.message, 'error');
    }
  }

  // ── Brand Cards ─────────────────────────────────────────────
  function renderBrandCards() {
    const container = $('#brandCards');
    container.innerHTML = brands
      .map((b) => {
        const handles = (b.instagram || []).map((h) => `@${h}`).join(', ');

        return `
          <div class="brand-card">
            <div class="brand-card-name">${b.name}</div>
            <div class="brand-card-tags">
              <span class="brand-tag">${icon('instagram', 'brand-tag-icon')} ${handles || 'Instagram'}</span>
            </div>
            <div class="brand-card-actions">
              <button class="btn btn-primary btn-sm" onclick="window.__scrape('${b.slug}')">
                ${icon('play', 'btn-icon')} Scrape
              </button>
              <button class="btn btn-outline btn-sm" onclick="window.__viewResults('${b.slug}')">
                ${icon('eye', 'btn-icon')} Results
              </button>
            </div>
          </div>`;
      })
      .join('');
  }

  // Expose card-button handlers
  window.__scrape = function (slug) {
    $('#brandSelect').value = slug;
    $$('.nav-item').forEach((n) => n.classList.remove('active'));
    $$('.nav-item')[1].classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $('#view-scraper').classList.add('active');
    startScrape();
  };

  window.__viewResults = function (slug) {
    $('#resultsBrandSelect').value = slug;
    $$('.nav-item').forEach((n) => n.classList.remove('active'));
    $$('.nav-item')[3].classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $('#view-results').classList.add('active');
    loadSavedResults();
  };

  // ── Check Status ────────────────────────────────────────────
  async function checkStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      const s = data.status;
      const dot = $('.status-dot');
      const txt = $('.status-text');

      dot.className = 'status-dot online';
      txt.textContent = 'Engine Ready (Instagram)';

      $('#statJobs').textContent = s.completedJobs;
      $('#statExports').textContent = s.totalExports;
      $('#statEngine').textContent = 'Online';

      loadJobs();
      loadExports();
    } catch {
      $('.status-dot').className = 'status-dot offline';
      $('.status-text').textContent = 'Server Offline';
      $('#statEngine').textContent = 'Offline';
    }
  }

  // ── Load Jobs ───────────────────────────────────────────────
  async function loadJobs() {
    try {
      const res = await fetch('/api/jobs');
      const data = await res.json();
      if (!data.success) return;

      const container = $('#recentJobs');
      if (!data.jobs.length) {
        container.innerHTML = '<p class="empty-state">No jobs yet. Start a scrape to see results here.</p>';
        return;
      }

      container.innerHTML = data.jobs
        .slice(-10)
        .reverse()
        .map(
          (j) => `
          <div class="job-item">
            <div class="job-status ${j.status}"></div>
            <div class="job-info">
              <div class="job-brand">${j.brand}</div>
              <div class="job-meta">${j.status} &middot; ${formatTime(j.startedAt)}</div>
            </div>
            <div class="job-count">${j.totalUnique || 0} customers</div>
          </div>`
        )
        .join('');
    } catch {
      /* silent */
    }
  }

  // ── Load Exports ────────────────────────────────────────────
  async function loadExports() {
    try {
      const res = await fetch('/api/exports');
      const data = await res.json();
      if (!data.success) return;

      const container = $('#exportsList');
      if (!data.exports.length) {
        container.innerHTML = '<p class="empty-state">No exports yet. Run a scrape to generate export files.</p>';
        return;
      }

      container.innerHTML = data.exports
        .map((file) => {
          const filename = typeof file === 'string' ? file : file.filename;
          const ext = (filename || '').split('.').pop();
          const isJson = ext === 'json';
          return `
            <div class="export-item">
              <div class="export-info">
                <div class="export-icon ${isJson ? 'json' : 'csv'}">
                  ${icon('fileDoc')}
                </div>
                <span class="export-name">${filename}</span>
              </div>
              <a href="/api/download/${filename}" class="btn btn-sm btn-success" download>
                ${icon('download', 'btn-icon')} Download
              </a>
            </div>`;
        })
        .join('');
    } catch {
      /* silent */
    }
  }

  // ── Start Scrape ────────────────────────────────────────────
  async function startScrape() {
    const brand = $('#brandSelect').value;
    if (!brand) {
      showToast('Please select a brand first', 'error');
      return;
    }

    const sources = ['instagram'];

    const progress = $('#scrapeProgress');
    const results = $('#scrapeResults');
    progress.classList.remove('hidden');
    results.classList.add('hidden');

    const log = $('#progressLog');
    const bar = $('#progressBar');
    const scrapeBtn = $('#btnScrape');
    log.innerHTML = '';
    bar.style.width = '0%';
    scrapeBtn.disabled = true;

    addLog(log, `Starting scrape for ${brand}...`, 'info');
    addLog(log, `Sources: ${sources.join(', ')}`, 'info');
    addLog(log, 'This can take 2-15 minutes for large brands while Instagram pages are processed.', 'info');
    bar.style.width = '10%';

    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand, sources }),
      });
      const data = await parseJsonResponse(res);

      if (!res.ok) {
        const message = data?.error || `Request failed (${res.status})`;
        addLog(log, `Error: ${message}`, 'error');
        showToast(message, 'error');
        return;
      }

      if (!data.success) {
        addLog(log, `Error: ${data.error}`, 'error');
        showToast(data.error, 'error');
        return;
      }

      bar.style.width = '25%';
      addLog(log, 'Scrape job started. Waiting for completion...', 'info');
      const finalData = await waitForBrandCompletion(brand, log, bar);

      if (!finalData) {
        addLog(log, 'Timed out waiting for completion. Open Results tab to check saved output.', 'error');
        showToast('Scrape is taking longer than expected. Check Results tab.', 'error');
        return;
      }

      bar.style.width = '100%';
      addLog(log, `Completed — ${finalData.totalCustomers || finalData.customers?.length || 0} unique customers found`, 'success');
      showToast(`Found ${finalData.totalCustomers || finalData.customers?.length || 0} unique customers`, 'success');

      displayResults(
        {
          brand: finalData.brand,
          customers: finalData.customers || [],
          totalUnique: finalData.totalCustomers || finalData.customers?.length || 0,
        },
        '#resultsSummary',
        '#resultsTable',
        '#scrapeResults'
      );
      checkStatus();
    } catch (err) {
      addLog(log, `Request failed: ${err.message}`, 'error');
      showToast('Scrape failed: ' + err.message, 'error');
    } finally {
      scrapeBtn.disabled = false;
    }
  }

  async function waitForBrandCompletion(brandSlug, log, bar) {
    const maxChecks = 180; // ~15 minutes at 5s interval

    for (let i = 1; i <= maxChecks; i++) {
      await sleep(5000);

      try {
        const jobsRes = await fetch('/api/jobs');
        const jobsData = await parseJsonResponse(jobsRes);
        if (!jobsRes.ok || !jobsData?.success) continue;

        const brandJobs = (jobsData.jobs || [])
          .filter((j) => j.brandSlug === brandSlug)
          .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

        const latest = brandJobs[0];
        if (!latest) continue;

        const pct = Math.min(25 + i, 95);
        bar.style.width = `${pct}%`;

        if (latest.status === 'completed') {
          const resultsRes = await fetch(`/api/results/${brandSlug}`);
          const resultsData = await parseJsonResponse(resultsRes);
          if (resultsRes.ok && resultsData?.success) return resultsData;
          return { brand: latest.brand, customers: [], totalCustomers: latest.totalUnique || 0 };
        }

        if (latest.status === 'failed') {
          addLog(log, `Scrape failed for ${brandSlug}.`, 'error');
          return null;
        }
      } catch {
        // keep polling
      }
    }

    return null;
  }

  // ── Scrape All ──────────────────────────────────────────────
  async function scrapeAll() {
    const progress = $('#scrapeProgress');
    progress.classList.remove('hidden');
    const log = $('#progressLog');
    const bar = $('#progressBar');
    log.innerHTML = '';
    bar.style.width = '5%';

    addLog(log, 'Starting scrape for ALL brands...', 'info');
    addLog(log, 'Source: Instagram', 'info');

    try {
      const res = await fetch('/api/scrape-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await parseJsonResponse(res);

      if (!res.ok) {
        const message = data?.error || `Failed to start (${res.status})`;
        addLog(log, message, 'error');
        showToast(message, 'error');
        return;
      }

      bar.style.width = '30%';
      addLog(log, `Scraping started for: ${data.brands.join(', ')}`, 'info');
      showToast('Scraping all brands started — check back shortly', 'info');

      // Poll for completion
      pollJobs(log, bar);
    } catch (err) {
      addLog(log, `Failed: ${err.message}`, 'error');
      showToast('Failed to start scrape: ' + err.message, 'error');
    }
  }

  async function pollJobs(log, bar) {
    let done = false;
    let ticks = 0;
    while (!done && ticks < 60) {
      await sleep(5000);
      ticks++;
      try {
        const res = await fetch('/api/status');
        const data = await parseJsonResponse(res);
        if (!res.ok || !data?.success) continue;
        const s = data.status;
        const pct = Math.min(30 + ticks * 2, 95);
        bar.style.width = `${pct}%`;

        if (s.runningJobs === 0) {
          done = true;
          bar.style.width = '100%';
          addLog(log, `All scrapes completed — ${s.completedJobs} jobs done`, 'success');
          showToast('All brands scraped!', 'success');
          checkStatus();
        }
      } catch {
        /* retry */
      }
    }
  }

  // ── Custom Instagram ───────────────────────────────────────
  async function scrapeCustomInstagram() {
    const handle = $('#customIgHandle').value.trim().replace(/^@/, '');
    if (!handle) {
      showToast('Please enter an Instagram handle', 'error');
      return;
    }

    const brand = $('#customIgBrand').value.trim() || handle;
    showToast('Scraping Instagram...', 'info');

    try {
      const res = await fetch('/api/scrape-instagram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle, brand }),
      });
      const data = await res.json();

      if (!data.success) {
        showToast(data.error, 'error');
        return;
      }

      showToast(`Found ${data.customers?.length || 0} customers`, 'success');
      displayResults(
        { customers: data.customers || [], totalUnique: data.customers?.length || 0, brand },
        '#customResultsSummary',
        '#customResultsTable',
        '#customResults'
      );
    } catch (err) {
      showToast('Scrape failed: ' + err.message, 'error');
    }
  }

  // ── Load Saved Results ──────────────────────────────────────
  async function loadSavedResults() {
    const brand = $('#resultsBrandSelect').value;
    if (!brand) {
      showToast('Please select a brand', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/results/${brand}`);
      const data = await res.json();

      if (!data.success) {
        showToast(data.error, 'error');
        return;
      }

      displayResults(data, '#savedResultsSummary', '#savedResultsTable', '#savedResults');
    } catch (err) {
      showToast('Failed to load results: ' + err.message, 'error');
    }
  }

  // ── Display Results ─────────────────────────────────────────
  function displayResults(data, summarySelector, tableSelector, containerSelector) {
    const container = $(containerSelector);
    container.classList.remove('hidden');

    const customers = data.customers || [];
    currentPage = 1;

    // Summary badges
    const summary = $(summarySelector);
    const sources = {};
    customers.forEach((c) => {
      sources[c.source] = (sources[c.source] || 0) + 1;
    });

    let summaryHtml = `<span class="summary-badge">${icon('users', 'btn-icon')} ${customers.length} unique customers</span>`;
    Object.entries(sources).forEach(([src, count]) => {
      const srcIcon = 'instagram';
      summaryHtml += `<span class="summary-badge">${icon(srcIcon, 'btn-icon')} ${count} from ${src}</span>`;
    });
    summary.innerHTML = summaryHtml;

    // Table
    renderTable(customers, tableSelector);
  }

  function renderTable(customers, selector) {
    const container = $(selector);
    const totalPages = Math.ceil(customers.length / PAGE_SIZE) || 1;

    if (!customers.length) {
      container.innerHTML = '<p class="empty-state">No customer records found.</p>';
      return;
    }

    const start = (currentPage - 1) * PAGE_SIZE;
    const page = customers.slice(start, start + PAGE_SIZE);

    let html = `
      <div class="results-table-container">
        <table class="results-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name / Username</th>
              <th>Source</th>
              <th>Engagement</th>
              <th>Content</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>`;

    page.forEach((c, i) => {
      const profileHtml = c.profileUrl
        ? `<a href="${c.profileUrl}" target="_blank" class="profile-link">${icon('externalLink', 'btn-icon')} View</a>`
        : '—';
      const engagementType = c.engagement?.type || c.engagementType || '—';
      const content = c.comment || c.content || '—';

      html += `
            <tr>
              <td>${start + i + 1}</td>
              <td><strong>${escHtml(c.name || c.username || 'Unknown')}</strong></td>
              <td><span class="source-badge instagram">${icon('instagram')} instagram</span></td>
              <td>${escHtml(engagementType)}</td>
              <td title="${escHtml(content)}">${truncate(content, 60)}</td>
              <td>${profileHtml}</td>
            </tr>`;
    });

    html += '</tbody></table></div>';

    // Pagination
    if (totalPages > 1) {
      html += '<div class="pagination">';
      if (currentPage > 1) {
        html += `<button class="btn btn-outline btn-sm" data-pg="${currentPage - 1}">&laquo; Prev</button>`;
      }
      for (let p = 1; p <= totalPages; p++) {
        if (totalPages > 7 && Math.abs(p - currentPage) > 2 && p !== 1 && p !== totalPages) {
          if (p === currentPage - 3 || p === currentPage + 3) html += '<span style="color:var(--text-muted)">...</span>';
          continue;
        }
        html += `<button class="btn btn-sm ${p === currentPage ? 'btn-primary active' : 'btn-outline'}" data-pg="${p}">${p}</button>`;
      }
      if (currentPage < totalPages) {
        html += `<button class="btn btn-outline btn-sm" data-pg="${currentPage + 1}">Next &raquo;</button>`;
      }
      html += '</div>';
    }

    container.innerHTML = html;

    // Pagination events
    container.querySelectorAll('[data-pg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentPage = parseInt(btn.dataset.pg);
        renderTable(customers, selector);
      });
    });
  }

  // ── Utilities ───────────────────────────────────────────────
  function addLog(container, msg, type) {
    const el = document.createElement('div');
    el.className = `log-entry ${type || ''}`;
    const prefix = type === 'success' ? icon('check') : type === 'error' ? icon('alert') : icon('clock');
    el.innerHTML = `<span style="display:inline-flex;width:14px;height:14px;vertical-align:middle;margin-right:6px">${prefix}</span>${escHtml(msg)}`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function showToast(msg, type) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.className = `toast ${type || 'info'}`;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 4000);
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, len) {
    return str.length > len ? escHtml(str.slice(0, len)) + '...' : escHtml(str);
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function parseJsonResponse(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid server response (${res.status}). The service may have restarted; please retry.`);
    }
  }
})();

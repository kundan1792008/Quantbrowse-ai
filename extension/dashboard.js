/**
 * dashboard.js — Quantbrowse AI Dashboard Controller
 *
 * Handles:
 *  1. Tab/page navigation in the single-page dashboard
 *  2. Loading and rendering usage statistics
 *  3. Smart tab grouping controls
 *  4. Daily digest article list
 *  5. AI surprise bookmark list
 *  6. Productivity score ring and history chart
 *  7. Ecosystem redirect statistics
 *  8. Settings persistence
 */

// ─── Navigation ────────────────────────────────────────────────────────────

const navItems = document.querySelectorAll(".nav-item");
const pages = document.querySelectorAll(".page");

/**
 * Activates the page matching the given id and updates the nav.
 * @param {string} pageId  e.g. "usage", "tabs", "digest" …
 */
function showPage(pageId) {
  navItems.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageId);
  });
  pages.forEach((p) => {
    p.classList.toggle("active", p.id === `page-${pageId}`);
  });
  loadPage(pageId);
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
});

// Handle hash-based deep links (e.g. dashboard.html#digest)
function checkHashRoute() {
  const hash = location.hash.replace("#", "");
  const valid = ["usage", "tabs", "digest", "surprises", "score", "redirect", "settings"];
  if (valid.includes(hash)) showPage(hash);
}
window.addEventListener("hashchange", checkHashRoute);
checkHashRoute();

// ─── Message helper ────────────────────────────────────────────────────────

/**
 * Sends a message to the background service worker and returns the response.
 * @param {object} msg
 * @returns {Promise<object>}
 */
function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response ?? {});
      }
    });
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────

/**
 * Formats milliseconds as a human-readable string: "1h 23m" or "45m" or "< 1m".
 * @param {number} ms
 * @returns {string}
 */
function fmtMs(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return "< 1m";
  const minutes = Math.floor(totalSec / 60) % 60;
  const hours = Math.floor(totalSec / 3600);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Formats an epoch timestamp as "2 hours ago" / "Yesterday" etc.
 * @param {number} epochMs
 * @returns {string}
 */
function timeAgo(epochMs) {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Returns a favicon URL for a given domain.
 * @param {string} domain
 * @returns {string}
 */
function faviconUrl(domain) {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
}

// ─── Page loaders ──────────────────────────────────────────────────────────

/** Track which pages have already been loaded to avoid redundant fetches */
const loaded = new Set();

function loadPage(pageId) {
  switch (pageId) {
    case "usage":     loadUsagePage(); break;
    case "tabs":      loadTabsPage(); break;
    case "digest":    loadDigestPage(); break;
    case "surprises": loadSurprisesPage(); break;
    case "score":     loadScorePage(); break;
    case "redirect":  loadRedirectPage(); break;
    case "settings":  loadSettingsPage(); break;
  }
}

// ── 1. Usage Page ───────────────────────────────────────────────────────────

async function loadUsagePage() {
  // Always reload usage data (it changes frequently)
  document.getElementById("usage-loading").style.display = "block";
  document.getElementById("usage-table").style.display = "none";
  document.getElementById("usage-empty").style.display = "none";

  try {
    const [summaryResp, usageResp, ratioResp] = await Promise.all([
      send({ type: "GET_TODAY_SUMMARY" }),
      send({ type: "GET_TODAY_USAGE" }),
      send({ type: "GET_DISTRACTION_RATIO" }),
    ]);

    // Summary banner
    document.getElementById("usage-summary-text").textContent =
      summaryResp.message ?? "No data yet.";

    const usage = usageResp.usage ?? [];
    const totalMs = usage.reduce((s, r) => s + r.todayMs, 0);
    const totalVisits = usage.reduce((s, r) => s + r.todayVisits, 0);
    const totalSaved = usage.reduce((s, r) => s + r.savedMs, 0);
    const distraction = Math.round((ratioResp.ratio ?? 0) * 100);

    document.getElementById("stat-total-time").textContent = fmtMs(totalMs);
    document.getElementById("stat-total-visits").textContent = `${totalVisits} visits`;
    document.getElementById("stat-saved-time").textContent = fmtMs(totalSaved);
    document.getElementById("stat-distraction").textContent = `${distraction}%`;
    document.getElementById("stat-distraction-sub").textContent =
      distraction > 40 ? "⚠️ High distraction day" : "of today's browsing";

    document.getElementById("usage-loading").style.display = "none";

    if (usage.length === 0) {
      document.getElementById("usage-empty").style.display = "block";
      return;
    }

    const maxMs = usage[0]?.todayMs ?? 1;
    const tbody = document.getElementById("usage-tbody");
    tbody.innerHTML = "";

    for (const row of usage.slice(0, 30)) {
      const pct = Math.round((row.todayMs / maxMs) * 100);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <div class="domain-cell">
            <img class="domain-favicon" src="${faviconUrl(row.domain)}" alt="" loading="lazy" onerror="this.style.display='none'"/>
            <div>
              <div class="domain-name">${row.domain}</div>
              <div style="margin-top:4px;">
                <div class="progress-wrap" style="width:120px;">
                  <div class="progress-fill ${row.isDistraction ? "distraction" : ""}" style="width:${pct}%;"></div>
                </div>
              </div>
            </div>
          </div>
        </td>
        <td>${fmtMs(row.todayMs)}</td>
        <td>${row.todayVisits}</td>
        <td><span class="tag saved">-${fmtMs(row.savedMs)}</span></td>
        <td>${row.isDistraction ? '<span class="tag distraction">Distraction</span>' : '<span class="tag">Productive</span>'}</td>
      `;
      tbody.appendChild(tr);
    }

    document.getElementById("usage-table").style.display = "table";
  } catch (err) {
    document.getElementById("usage-loading").style.display = "none";
    document.getElementById("usage-empty").style.display = "block";
    console.error("[Dashboard] Usage load error:", err);
  }
}

// ── 2. Tabs Page ────────────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  work:          "#3b82f6",
  social:        "#ef4444",
  news:          "#f97316",
  shopping:      "#eab308",
  research:      "#a855f7",
  entertainment: "#ec4899",
  other:         "#64748b",
};

async function loadTabsPage() {
  document.getElementById("tab-breakdown-loading").style.display = "block";
  document.getElementById("tab-breakdown").style.display = "none";

  try {
    const resp = await send({ type: "GET_TAB_SUMMARY" });
    const summary = resp.summary ?? { total: 0, byCategory: {} };
    const total = summary.total;
    const cats = summary.byCategory;

    document.getElementById("tab-count").textContent = total;
    document.getElementById("tab-categories").textContent = Object.keys(cats).length;

    if (total >= 30) {
      document.getElementById("tab-overload-hint").textContent = "⚠️ Tab overload!";
      document.getElementById("tab-overload-hint").style.color = "var(--red)";
    } else {
      document.getElementById("tab-overload-hint").textContent = "tabs open";
      document.getElementById("tab-overload-hint").style.color = "";
    }

    const container = document.getElementById("tab-breakdown");
    container.innerHTML = "";

    for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / total) * 100);
      const color = CATEGORY_COLORS[cat] ?? "#64748b";
      const label = cat.charAt(0).toUpperCase() + cat.slice(1);
      const row = document.createElement("div");
      row.style.cssText = "margin-bottom:14px;";
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:5px;font-size:13px;">
          <span style="font-weight:500;">${label}</span>
          <span style="color:var(--text-muted);">${count} tab${count !== 1 ? "s" : ""} · ${pct}%</span>
        </div>
        <div class="progress-wrap">
          <div class="progress-fill" style="width:${pct}%;background:${color};"></div>
        </div>
      `;
      container.appendChild(row);
    }

    if (Object.keys(cats).length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🗂️</div><div class="empty-title">No tabs open</div></div>`;
    }

    document.getElementById("tab-breakdown-loading").style.display = "none";
    container.style.display = "block";
  } catch (err) {
    document.getElementById("tab-breakdown-loading").style.display = "none";
    console.error("[Dashboard] Tabs load error:", err);
  }
}

document.getElementById("btn-auto-group").addEventListener("click", async () => {
  const btn = document.getElementById("btn-auto-group");
  const result_el = document.getElementById("tab-action-result");
  btn.disabled = true;
  btn.textContent = "⏳ Grouping…";
  try {
    const resp = await send({ type: "AUTO_GROUP_TABS" });
    result_el.textContent = `✓ Grouped ${resp.grouped ?? 0} tabs into ${Object.keys(resp.categories ?? {}).length} categories.`;
    loadTabsPage();
  } catch {
    result_el.textContent = "⚠️ Could not group tabs.";
  } finally {
    btn.disabled = false;
    btn.textContent = "🗂️ Auto-Group Tabs";
  }
});

document.getElementById("btn-collapse-groups").addEventListener("click", async () => {
  const btn = document.getElementById("btn-collapse-groups");
  btn.disabled = true;
  btn.textContent = "⏳ Collapsing…";
  try {
    await send({ type: "COLLAPSE_INACTIVE_GROUPS" });
    document.getElementById("tab-action-result").textContent = "✓ Inactive groups collapsed.";
  } catch {
    document.getElementById("tab-action-result").textContent = "⚠️ Could not collapse groups.";
  } finally {
    btn.disabled = false;
    btn.textContent = "📦 Collapse Inactive Groups";
  }
});

// ── 3. Digest Page ──────────────────────────────────────────────────────────

async function loadDigestPage() {
  document.getElementById("digest-loading").style.display = "block";
  document.getElementById("digest-articles").style.display = "none";
  document.getElementById("digest-empty").style.display = "none";

  try {
    const resp = await send({ type: "GET_DIGEST_ARTICLES" });
    const articles = resp.articles ?? [];

    document.getElementById("digest-loading").style.display = "none";

    if (articles.length === 0) {
      document.getElementById("digest-empty").style.display = "block";
      return;
    }

    const list = document.getElementById("digest-articles");
    list.innerHTML = "";

    for (const art of articles) {
      const card = document.createElement("a");
      card.className = "article-card";
      card.href = art.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.innerHTML = `
        <div class="article-icon">📰</div>
        <div class="article-body">
          <div class="article-title">${escHtml(art.title)}</div>
          <div class="article-meta">${escHtml(art.domain)} · ${timeAgo(art.savedAt)}</div>
        </div>
      `;
      list.appendChild(card);
    }

    list.style.display = "flex";
  } catch (err) {
    document.getElementById("digest-loading").style.display = "none";
    document.getElementById("digest-empty").style.display = "block";
    console.error("[Dashboard] Digest load error:", err);
  }
}

document.getElementById("btn-clear-digest").addEventListener("click", async () => {
  await send({ type: "CLEAR_DIGEST_ARTICLES" });
  loadDigestPage();
});

// ── 4. Surprises Page ───────────────────────────────────────────────────────

async function loadSurprisesPage() {
  document.getElementById("surprises-loading").style.display = "block";
  document.getElementById("surprises-list").style.display = "none";
  document.getElementById("surprises-empty").style.display = "none";

  try {
    const resp = await send({ type: "GET_SURPRISE_BOOKMARKS" });
    const bookmarks = resp.bookmarks ?? [];

    document.getElementById("surprises-loading").style.display = "none";

    if (bookmarks.length === 0) {
      document.getElementById("surprises-empty").style.display = "block";
      return;
    }

    const list = document.getElementById("surprises-list");
    list.innerHTML = "";

    const icons = ["🤖", "🌟", "✨", "💡", "🔍", "📌"];

    for (const bm of bookmarks.slice(0, 20)) {
      const card = document.createElement("a");
      card.className = "article-card";
      card.href = bm.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      const icon = icons[Math.floor(Math.random() * icons.length)];
      card.innerHTML = `
        <div class="article-icon">${icon}</div>
        <div class="article-body">
          <div class="article-title">${escHtml(bm.title)}</div>
          <div class="article-meta">${escHtml(bm.domain)} · ${escHtml(bm.reason)} · ${timeAgo(bm.savedAt)}</div>
        </div>
        ${bm.shown ? '<span class="tag" style="flex-shrink:0;align-self:center;">Shown</span>' : ""}
      `;
      list.appendChild(card);
    }

    list.style.display = "flex";
  } catch (err) {
    document.getElementById("surprises-loading").style.display = "none";
    document.getElementById("surprises-empty").style.display = "block";
    console.error("[Dashboard] Surprises load error:", err);
  }
}

document.getElementById("btn-trigger-surprise").addEventListener("click", async () => {
  const btn = document.getElementById("btn-trigger-surprise");
  btn.disabled = true;
  btn.textContent = "⏳ Looking for a surprise…";
  try {
    const resp = await send({ type: "TRIGGER_SURPRISE" });
    if (resp.shown) {
      btn.textContent = "✓ Check your notifications!";
    } else {
      btn.textContent = "😴 No surprises right now. Come back later!";
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "✨ Trigger Surprise Now";
    }, 3000);
    loadSurprisesPage();
  } catch {
    btn.disabled = false;
    btn.textContent = "✨ Trigger Surprise Now";
  }
});

// ── 5. Score Page ───────────────────────────────────────────────────────────

async function loadScorePage() {
  document.getElementById("score-loading").style.display = "block";
  document.getElementById("score-content").style.display = "none";
  document.getElementById("score-history-loading").style.display = "block";
  document.getElementById("score-history").style.display = "none";
  document.getElementById("score-history-empty").style.display = "none";

  try {
    const [estimateResp, historyResp] = await Promise.all([
      send({ type: "GET_CURRENT_ESTIMATE" }),
      send({ type: "GET_WEEKLY_SCORES" }),
    ]);

    // Score ring
    const score = estimateResp.score ?? 0;
    const bd = estimateResp.breakdown ?? {};
    const circumference = 2 * Math.PI * 60; // 377
    const offset = circumference - (score / 100) * circumference;

    document.getElementById("score-number").textContent = score;
    const ring = document.getElementById("score-ring-fill");
    ring.style.strokeDashoffset = offset;

    const breakdown = document.getElementById("score-breakdown");
    breakdown.innerHTML = `
      <div class="score-row">
        <div class="score-row-label">Productive time <span class="score-row-pts">${bd.productive ?? 0}/35</span></div>
        <div class="progress-wrap"><div class="progress-fill" style="width:${((bd.productive??0)/35*100).toFixed(0)}%;"></div></div>
      </div>
      <div class="score-row">
        <div class="score-row-label">Low distraction <span class="score-row-pts">${bd.lowDistraction ?? 0}/25</span></div>
        <div class="progress-wrap"><div class="progress-fill" style="width:${((bd.lowDistraction??0)/25*100).toFixed(0)}%;"></div></div>
      </div>
      <div class="score-row">
        <div class="score-row-label">Diversity <span class="score-row-pts">${bd.diversity ?? 0}/20</span></div>
        <div class="progress-wrap"><div class="progress-fill" style="width:${((bd.diversity??0)/20*100).toFixed(0)}%;"></div></div>
      </div>
      <div class="score-row">
        <div class="score-row-label">Consistency <span class="score-row-pts">${bd.consistency ?? 0}/10</span></div>
        <div class="progress-wrap"><div class="progress-fill" style="width:${((bd.consistency??0)/10*100).toFixed(0)}%;"></div></div>
      </div>
      <div class="score-row" style="grid-column:1/-1;">
        <div class="score-row-label">AI feature usage <span class="score-row-pts">${bd.aiUsage ?? 0}/10</span></div>
        <div class="progress-wrap"><div class="progress-fill" style="width:${((bd.aiUsage??0)/10*100).toFixed(0)}%;"></div></div>
      </div>
      <div style="grid-column:1/-1;font-size:12px;color:var(--text-muted);margin-top:8px;">
        Browsing: ${bd.totalBrowsingHours ?? 0}h total · 
        ${bd.productivePercent ?? 0}% productive · 
        ${bd.distractionPercent ?? 0}% distraction
      </div>
    `;

    document.getElementById("score-loading").style.display = "none";
    document.getElementById("score-content").style.display = "block";

    // History chart
    const scores = historyResp.scores ?? [];
    document.getElementById("score-history-loading").style.display = "none";

    if (scores.length === 0) {
      document.getElementById("score-history-empty").style.display = "block";
    } else {
      const container = document.getElementById("score-history");
      container.innerHTML = "";

      // Bar chart
      const barChart = document.createElement("div");
      barChart.className = "bar-chart";
      const displayed = scores.slice(0, 12).reverse();
      const maxScore = Math.max(...displayed.map((s) => s.score), 1);

      for (const s of displayed) {
        const heightPct = (s.score / maxScore) * 100;
        const wrap = document.createElement("div");
        wrap.className = "bar-wrap";
        wrap.title = `Week ${s.week}: ${s.score}/100`;
        wrap.innerHTML = `
          <div class="bar" style="height:${heightPct}%;"></div>
          <div class="bar-label">${s.score}</div>
        `;
        barChart.appendChild(wrap);
      }

      container.appendChild(barChart);

      // Table below
      const table = document.createElement("table");
      table.className = "usage-table";
      table.style.marginTop = "20px";
      table.innerHTML = `
        <thead><tr>
          <th>Week</th><th>Score</th><th>Productive</th><th>Distraction</th><th>AI Usage</th>
        </tr></thead>
      `;
      const tbody = document.createElement("tbody");
      for (const s of scores) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${s.week}</td>
          <td><strong>${s.score}</strong>/100</td>
          <td>${s.breakdown?.productivePercent ?? "—"}%</td>
          <td>${s.breakdown?.distractionPercent ?? "—"}%</td>
          <td>${s.breakdown?.aiUsage ?? "—"}/10</td>
        `;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      container.appendChild(table);
      container.style.display = "block";
    }
  } catch (err) {
    document.getElementById("score-loading").style.display = "none";
    document.getElementById("score-history-loading").style.display = "none";
    console.error("[Dashboard] Score load error:", err);
  }
}

// ── 6. Redirect Page ────────────────────────────────────────────────────────

async function loadRedirectPage() {
  document.getElementById("redirect-loading").style.display = "block";
  document.getElementById("redirect-stats").style.display = "none";
  document.getElementById("redirect-empty").style.display = "none";

  // Load enabled state
  chrome.storage.local.get("redirectEnabled", (r) => {
    document.getElementById("redirect-enabled-toggle").checked = r.redirectEnabled !== false;
  });

  document.getElementById("redirect-enabled-toggle").addEventListener("change", async (e) => {
    await send({ type: "SET_REDIRECT_ENABLED", enabled: e.target.checked });
  });

  try {
    const [statsResp, rulesResp] = await Promise.all([
      send({ type: "GET_REDIRECT_STATS" }),
      send({ type: "GET_REDIRECT_RULES" }),
    ]);

    const stats = statsResp.stats ?? {};
    const rules = rulesResp.rules ?? [];

    document.getElementById("redirect-loading").style.display = "none";

    if (Object.keys(stats).length === 0) {
      document.getElementById("redirect-empty").style.display = "block";
      return;
    }

    const container = document.getElementById("redirect-stats");
    container.innerHTML = "";

    for (const [competitor, stat] of Object.entries(stats)) {
      const rule = rules.find((r) => r.competitor === competitor);
      const row = document.createElement("div");
      row.className = "redirect-row";
      row.innerHTML = `
        <div>
          <div class="redirect-domain">${escHtml(competitor)}</div>
          <div style="font-size:12px;color:var(--text-muted);">${escHtml(rule?.quantApp ?? "")}</div>
        </div>
        <div class="redirect-stat">Nudges <span>${stat.nudges ?? 0}</span></div>
        <div class="redirect-stat">Accepted <span style="color:var(--green);">${stat.accepted ?? 0}</span></div>
        <div class="redirect-stat">Dismissed <span>${stat.dismissed ?? 0}</span></div>
      `;
      container.appendChild(row);
    }

    container.style.display = "block";
  } catch (err) {
    document.getElementById("redirect-loading").style.display = "none";
    document.getElementById("redirect-empty").style.display = "block";
    console.error("[Dashboard] Redirect load error:", err);
  }
}

// ── 7. Settings Page ────────────────────────────────────────────────────────

async function loadSettingsPage() {
  if (loaded.has("settings")) return;

  // Load current settings from storage
  chrome.storage.local.get(
    ["digestSettings", "surpriseSettings"],
    (r) => {
      const digest = r.digestSettings ?? { hourLocal: 8, enabled: true };
      const surprise = r.surpriseSettings ?? { enabled: true, maxPerDay: 3 };

      document.getElementById("digest-enabled").checked = digest.enabled !== false;
      document.getElementById("digest-hour").value = String(digest.hourLocal ?? 8);
      document.getElementById("surprise-enabled").checked = surprise.enabled !== false;
      document.getElementById("surprise-max").value = String(surprise.maxPerDay ?? 3);
    }
  );

  loaded.add("settings");
}

document.getElementById("btn-save-settings").addEventListener("click", async () => {
  const digestEnabled = document.getElementById("digest-enabled").checked;
  const digestHour = parseInt(document.getElementById("digest-hour").value, 10);
  const surpriseEnabled = document.getElementById("surprise-enabled").checked;
  const surpriseMax = parseInt(document.getElementById("surprise-max").value, 10);

  await Promise.all([
    send({ type: "UPDATE_DIGEST_SETTINGS", settings: { enabled: digestEnabled, hourLocal: digestHour } }),
    send({ type: "UPDATE_SURPRISE_SETTINGS", settings: { enabled: surpriseEnabled, maxPerDay: surpriseMax } }),
  ]);

  const saved = document.getElementById("settings-saved");
  saved.style.display = "block";
  setTimeout(() => { saved.style.display = "none"; }, 3000);
});

// ─── Utility ──────────────────────────────────────────────────────────────

/**
 * Minimal HTML entity escaper to prevent XSS from stored data.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Initial load ──────────────────────────────────────────────────────────

// Flush any active tracking session so the dashboard shows fresh numbers
chrome.runtime.sendMessage({ type: "FLUSH_SESSION" });

// Load the default (active) page
loadPage("usage");

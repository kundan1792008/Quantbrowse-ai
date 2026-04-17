const clipListEl = document.getElementById("clipList");
const clipCountEl = document.getElementById("clipCount");
const clipDetailEl = document.getElementById("clipDetail");
const searchInput = document.getElementById("searchInput");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const typeFilter = document.getElementById("typeFilter");
const syncFilter = document.getElementById("syncFilter");
const sortFilter = document.getElementById("sortFilter");
const statTotal = document.getElementById("statTotal");
const statQueued = document.getElementById("statQueued");
const statSynced = document.getElementById("statSynced");
const statFailed = document.getElementById("statFailed");
const statLastSaved = document.getElementById("statLastSaved");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const exportMarkdownBtn = document.getElementById("exportMarkdownBtn");
const refreshBtn = document.getElementById("refreshBtn");
const flushQueueBtn = document.getElementById("flushQueueBtn");
const openOptionsBtn = document.getElementById("openOptionsBtn");
const queueSummaryEl = document.getElementById("queueSummary");

const state = {
  clips: [],
  queue: [],
  stats: null,
  filters: {
    query: "",
    type: "",
    sync: "",
    sort: "newest",
  },
  selectedClipId: null,
};

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function formatReadingTime(minutes) {
  if (!minutes) return "–";
  return `${minutes} min read`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSearchIndex(clip) {
  return [
    clip.title,
    clip.excerpt,
    clip.url,
    clip.shortUrl,
    ...(clip.tags || []).map((tag) => tag.label),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function applyFilters() {
  const query = state.filters.query.toLowerCase().trim();
  let filtered = [...state.clips];

  if (query) {
    filtered = filtered.filter((clip) => {
      const index = clip.searchIndex || buildSearchIndex(clip);
      return index.includes(query);
    });
  }

  if (state.filters.type) {
    filtered = filtered.filter((clip) => clip.type === state.filters.type);
  }

  if (state.filters.sync) {
    filtered = filtered.filter((clip) => clip.syncState === state.filters.sync);
  }

  switch (state.filters.sort) {
    case "oldest":
      filtered.sort((a, b) => a.createdAt - b.createdAt);
      break;
    case "title":
      filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
      break;
    case "reading":
      filtered.sort(
        (a, b) =>
          (b.metadata?.readingTime || 0) - (a.metadata?.readingTime || 0)
      );
      break;
    default:
      filtered.sort((a, b) => b.createdAt - a.createdAt);
      break;
  }

  return filtered;
}

function renderClipList() {
  const filtered = applyFilters();
  clipCountEl.textContent = String(filtered.length);

  if (!filtered.length) {
    clipListEl.innerHTML = `<div class="empty-state">No clips match your filters.</div>`;
    return;
  }

  clipListEl.innerHTML = filtered
    .map((clip) => {
      const isActive = clip.id === state.selectedClipId;
      const tags = (clip.tags || []).slice(0, 3);
      return `
        <div class="clip-card ${isActive ? "active" : ""}" data-id="${
        clip.id
      }">
          <div class="clip-title">${escapeHtml(clip.title)}</div>
          <div class="clip-meta">
            <span>${escapeHtml(clip.type)}</span>
            <span>${formatReadingTime(clip.metadata?.readingTime)}</span>
            <span>${escapeHtml(clip.syncState || "local")}</span>
          </div>
          <div class="tag-list">
            ${tags
              .map(
                (tag) =>
                  `<span class="tag" style="background:${tag.color}">${escapeHtml(
                    tag.label
                  )}</span>`
              )
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");
}

function renderDetail() {
  const clip = state.clips.find((item) => item.id === state.selectedClipId);
  if (!clip) {
    clipDetailEl.innerHTML = `
      <div class="empty-state">
        <h3>Select a clip</h3>
        <p>Pick a clip from the list to see its details, tags, and export options.</p>
      </div>
    `;
    return;
  }

  const tags = (clip.tags || []).map(
    (tag) =>
      `<span class="tag" style="background:${tag.color}">${escapeHtml(
        tag.label
      )}</span>`
  );

  const highlights = clip.content?.highlights || [];

  clipDetailEl.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">${escapeHtml(clip.title)}</div>
      <a class="detail-url" href="${escapeHtml(clip.url)}" target="_blank">${escapeHtml(
    clip.shortUrl || clip.url
  )}</a>
      <div class="detail-actions">
        <button data-action="open">Open</button>
        <button data-action="copy">Copy URL</button>
        <button data-action="retag">Refresh tags</button>
        <button data-action="delete">Delete</button>
      </div>
    </div>

    <div class="detail-section">
      <h3>Tags</h3>
      <div class="tag-list">${tags.join("") || "No tags"}</div>
    </div>

    <div class="detail-section">
      <h3>Summary</h3>
      <div class="detail-text">${escapeHtml(
        clip.content?.summary || clip.excerpt || ""
      )}</div>
    </div>

    <div class="detail-section">
      <h3>Metadata</h3>
      <div class="detail-grid">
        <div class="detail-item"><span>Type</span><strong>${escapeHtml(
          clip.type
        )}</strong></div>
        <div class="detail-item"><span>Saved</span><strong>${formatDate(
          clip.createdAt
        )}</strong></div>
        <div class="detail-item"><span>Sync</span><strong>${escapeHtml(
          clip.syncState || "local"
        )}</strong></div>
        <div class="detail-item"><span>Reading time</span><strong>${formatReadingTime(
          clip.metadata?.readingTime
        )}</strong></div>
        <div class="detail-item"><span>Source</span><strong>${escapeHtml(
          clip.metadata?.siteName || ""
        )}</strong></div>
        <div class="detail-item"><span>Author</span><strong>${escapeHtml(
          clip.metadata?.author || "Unknown"
        )}</strong></div>
      </div>
    </div>

    <div class="detail-section">
      <h3>Highlights</h3>
      ${
        highlights.length
          ? highlights
              .map(
                (highlight) =>
                  `<div class="highlight">${escapeHtml(
                    highlight.text
                  )}</div>`
              )
              .join("")
          : `<div class="detail-text">No highlights captured.</div>`
      }
    </div>

    <div class="detail-section">
      <h3>Excerpt</h3>
      <div class="detail-text">${escapeHtml(
        clip.excerpt || clip.content?.text || ""
      )}</div>
    </div>
  `;

  clipDetailEl.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleDetailAction(button.dataset.action, clip));
  });
}

function renderStats() {
  statTotal.textContent = String(state.clips.length);
  statQueued.textContent = String(state.stats?.clipsQueued || 0);
  statSynced.textContent = String(state.stats?.clipsSynced || 0);
  statFailed.textContent = String(state.stats?.clipsFailed || 0);
  statLastSaved.textContent = formatDate(state.stats?.lastSavedAt);

  if (state.queue.length) {
    queueSummaryEl.textContent = `${state.queue.length} clip(s) waiting to sync`;
  } else {
    queueSummaryEl.textContent = "Queue idle";
  }
}

function handleDetailAction(action, clip) {
  switch (action) {
    case "open":
      window.open(clip.url, "_blank");
      break;
    case "copy":
      navigator.clipboard.writeText(clip.url).catch(() => {
        alert("Unable to copy URL.");
      });
      break;
    case "retag":
      refreshTags(clip.id);
      break;
    case "delete":
      deleteClip(clip.id);
      break;
    default:
      break;
  }
}

function handleListClick(event) {
  const card = event.target.closest(".clip-card");
  if (!card) return;
  state.selectedClipId = card.dataset.id;
  renderClipList();
  renderDetail();
}

function handleSearchInput() {
  state.filters.query = searchInput.value;
  renderClipList();
}

function clearSearch() {
  searchInput.value = "";
  state.filters.query = "";
  renderClipList();
}

function updateFilterState() {
  state.filters.type = typeFilter.value;
  state.filters.sync = syncFilter.value;
  state.filters.sort = sortFilter.value;
  renderClipList();
}

function downloadFile({ content, filename, mime }) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
}

function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    count: state.clips.length,
    clips: state.clips,
  };
  downloadFile({
    content: JSON.stringify(payload, null, 2),
    filename: `quantbrowse-collection-${Date.now()}.json`,
    mime: "application/json",
  });
}

function exportCsv() {
  const rows = [
    [
      "id",
      "title",
      "url",
      "type",
      "excerpt",
      "tags",
      "syncState",
      "createdAt",
    ],
  ];
  state.clips.forEach((clip) => {
    rows.push([
      clip.id,
      clip.title,
      clip.url,
      clip.type,
      clip.excerpt,
      (clip.tags || []).map((tag) => tag.label).join("; "),
      clip.syncState,
      new Date(clip.createdAt).toISOString(),
    ]);
  });

  const content = rows
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  downloadFile({
    content,
    filename: `quantbrowse-collection-${Date.now()}.csv`,
    mime: "text/csv",
  });
}

function exportMarkdown() {
  const content = state.clips
    .map((clip) => {
      const tags = (clip.tags || []).map((tag) => tag.label).join(", ") || "None";
      return `### ${clip.title}\n\n${clip.excerpt}\n\n- URL: ${clip.url}\n- Tags: ${tags}\n- Saved: ${formatDate(clip.createdAt)}\n\n---\n`;
    })
    .join("\n");

  downloadFile({
    content,
    filename: `quantbrowse-collection-${Date.now()}.md`,
    mime: "text/markdown",
  });
}

function refreshTags(clipId) {
  chrome.runtime.sendMessage(
    { type: "COLLECTIONS_REFRESH_TAGS", clipId },
    () => loadState()
  );
}

function deleteClip(clipId) {
  if (!confirm("Delete this clip?")) return;
  chrome.runtime.sendMessage({ type: "COLLECTIONS_DELETE", clipId }, () => {
    if (state.selectedClipId === clipId) {
      state.selectedClipId = null;
    }
    loadState();
  });
}

function flushQueue() {
  chrome.runtime.sendMessage({ type: "QUEUE_FLUSH" }, () => loadState());
}

function openOptions() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
}

function loadState() {
  chrome.runtime.sendMessage({ type: "COLLECTIONS_STATE" }, (response) => {
    if (chrome.runtime.lastError || !response?.success) return;
    state.clips = response.state.collections || [];
    state.queue = response.state.offlineQueue || [];
    state.stats = response.state.stats || null;
    renderStats();
    renderClipList();
    renderDetail();
  });
}

clipListEl.addEventListener("click", handleListClick);
searchInput.addEventListener("input", handleSearchInput);
clearSearchBtn.addEventListener("click", clearSearch);
typeFilter.addEventListener("change", updateFilterState);
syncFilter.addEventListener("change", updateFilterState);
sortFilter.addEventListener("change", updateFilterState);
exportJsonBtn.addEventListener("click", exportJson);
exportCsvBtn.addEventListener("click", exportCsv);
exportMarkdownBtn.addEventListener("click", exportMarkdown);
refreshBtn.addEventListener("click", loadState);
flushQueueBtn.addEventListener("click", flushQueue);
openOptionsBtn.addEventListener("click", openOptions);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.qba_collections || changes.qba_offline_queue || changes.qba_stats) {
    loadState();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CLIP_SAVED") {
    loadState();
  }
});

loadState();

/**
 * clipper.js — Universal Web Clipper runtime (injected content script)
 *
 * This is the compiled / bundled runtime version of ContentClipper.ts
 * that is loaded directly by the Chrome extension.  It implements the
 * same logic without TypeScript-specific syntax so it can run verbatim
 * in the browser without a build step.
 *
 * Exposed message handlers:
 *   CLIP_ELEMENT          — clip the element at given coordinates
 *   CLIP_FULL_PAGE        — clip the full page (with screenshot)
 *   START_REGION_SCREENSHOT — launch drag-select UI and capture region
 *   START_ELEMENT_PICKER  — hover-highlight picker, clip chosen element
 *   SAVE_CLIP             — shortcut Alt+S → save current page
 */

"use strict";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getMetaContent(name) {
  const el =
    document.querySelector(`meta[name="${name}"]`) ||
    document.querySelector(`meta[property="${name}"]`) ||
    document.querySelector(`meta[property="og:${name}"]`) ||
    document.querySelector(`meta[name="twitter:${name}"]`);
  return el?.content?.trim() ?? "";
}

function getFaviconUrl() {
  const link =
    document.querySelector('link[rel="icon"]') ||
    document.querySelector('link[rel="shortcut icon"]') ||
    document.querySelector('link[rel~="icon"]');
  if (link?.href) return link.href;
  return `${location.origin}/favicon.ico`;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Content-type detection ────────────────────────────────────────────────────

function detectContentType(root) {
  root = root || document.documentElement;
  const url = location.href;
  const host = location.hostname;
  const text = root.textContent || "";

  if (/youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d|tiktok\.com\/@.+\/video/.test(url)) {
    return "video";
  }
  if (root.querySelector("video[src], video source[src]")) return "video";

  if (
    /github\.com|gitlab\.com|gist\.github\.com|codepen\.io|jsfiddle\.net|stackblitz\.com/.test(host)
  ) {
    return "code";
  }
  const codeBlocks = root.querySelectorAll("pre code, .highlight, .code-block");
  if (codeBlocks.length >= 2) return "code";

  if (root.querySelector('[itemtype*="schema.org/Recipe"]')) return "recipe";
  if (text.slice(0, 3000).match(/recipe|ingredients|instructions|prep.?time/i)) {
    const ingredientEls = root.querySelectorAll(".ingredients, .ingredient, [itemprop='ingredients']");
    if (ingredientEls.length >= 2) return "recipe";
  }

  if (root.querySelector('[itemtype*="schema.org/Product"]')) return "product";
  if (root.querySelector('[class*="add-to-cart"], [class*="buy-now"], [class*="product-price"]')) {
    return "product";
  }

  if (/\.(jpg|jpeg|png|gif|webp|svg|avif)$/i.test(url)) return "image";

  if (root.querySelector("article, [itemtype*='Article'], .post-content, .article-body")) {
    return "article";
  }
  let longParaCount = 0;
  root.querySelectorAll("p").forEach((p) => {
    if ((p.textContent?.length ?? 0) > 80) longParaCount++;
  });
  if (longParaCount >= 4) return "article";

  return "generic";
}

// ─── Article extractor ────────────────────────────────────────────────────────

const UNLIKELY_CANDIDATES =
  /banner|breadcrumb|combx|comment|community|cover|disqus|extra|foot|header|legends|menu|related|remark|rss|shoutbox|sidebar|skyscraper|sponsor|ad-break|pagination|pager|popup/i;

const POSITIVE_CONTENT =
  /article|body|content|entry|hentry|main|page|pagination|post|text|blog|story/i;

const NEGATIVE_CONTENT =
  /hidden|hid|banner|combx|comment|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|shoutbox|sidebar|sponsor|tags|tool|widget/i;

function getLinkDensity(node) {
  const totalLen = (node.textContent || "").length;
  if (totalLen === 0) return 0;
  let linkLen = 0;
  node.querySelectorAll("a").forEach((a) => {
    linkLen += (a.textContent || "").length;
  });
  return linkLen / totalLen;
}

function getNodeScore(node) {
  const tagName = node.tagName.toLowerCase();
  const combined = `${node.className || ""} ${node.id || ""}`;
  let score = 0;

  if (tagName === "article") score += 30;
  if (tagName === "p") score += 5;
  if (["td", "blockquote"].includes(tagName)) score += 3;
  if (["form", "aside", "nav", "header", "footer"].includes(tagName)) score -= 25;
  if (NEGATIVE_CONTENT.test(combined)) score -= 25;
  if (POSITIVE_CONTENT.test(combined)) score += 25;
  if (UNLIKELY_CANDIDATES.test(combined)) score -= 25;

  const text = node.textContent || "";
  const linkDensity = getLinkDensity(node);
  if (text.length < 25) score -= 10;
  else if (text.length > 500) score += 10;
  if (linkDensity > 0.25) score -= Math.round(score * linkDensity);

  return score;
}

function removeUnlikelyElements(doc) {
  const clone = doc.cloneNode(true);
  const toRemove = [];

  clone.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "iframe", "select", "form"].includes(tag)) {
      toRemove.push(el);
      return;
    }
    const combined = `${el.className || ""} ${el.id || ""}`;
    if (UNLIKELY_CANDIDATES.test(combined) && !POSITIVE_CONTENT.test(combined)) {
      toRemove.push(el);
    }
  });

  toRemove.forEach((el) => el.parentNode?.removeChild(el));
  return clone;
}

function extractArticle() {
  const title =
    getMetaContent("og:title") || getMetaContent("title") || document.title;

  const byline =
    getMetaContent("author") ||
    getMetaContent("article:author") ||
    document.querySelector('[rel="author"], .author, [itemprop="author"]')?.textContent?.trim() ||
    "";

  const publishedDate =
    getMetaContent("article:published_time") ||
    getMetaContent("date") ||
    document.querySelector("time[datetime]")?.dateTime || "";

  const leadImageUrl =
    getMetaContent("og:image") ||
    getMetaContent("image") ||
    document.querySelector("article img, .post-content img")?.src || "";

  const cleaned = removeUnlikelyElements(document);
  const candidates = new Map();

  cleaned.querySelectorAll("p, td, pre").forEach((node) => {
    const innerText = node.textContent || "";
    if (innerText.length < 25) return;

    let parent = node.parentElement;
    let level = 0;
    const ancestors = [];
    while (parent && level < 3) {
      if (["div", "p", "article", "section", "td", "blockquote"].includes(
        parent.tagName.toLowerCase()
      )) {
        ancestors.push(parent);
      }
      parent = parent.parentElement;
      level++;
    }

    const baseScore =
      Math.min(Math.floor(innerText.length / 100), 3) +
      (innerText.match(/,/g) || []).length +
      getNodeScore(node);

    ancestors.forEach((ancestor, idx) => {
      const penalty = idx === 0 ? 1 : idx === 1 ? 2 : 3 * idx;
      candidates.set(ancestor, (candidates.get(ancestor) || 0) + baseScore / penalty);
    });
  });

  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  const topCandidate = sorted[0]?.[0] || document.body;

  const cleanEl = topCandidate.cloneNode(true);
  cleanEl
    .querySelectorAll("script, style, aside, .ad, [class*='share'], [class*='social']")
    .forEach((el) => el.parentNode?.removeChild(el));

  const bodyHtml = cleanEl.innerHTML;
  const bodyText = (cleanEl.textContent || "").replace(/\s+/g, " ").trim();
  const wordCount = countWords(bodyText);

  return {
    title,
    byline,
    publishedDate,
    bodyHtml,
    bodyText,
    leadImageUrl,
    wordCount,
    readingTimeMinutes: Math.ceil(wordCount / 200),
  };
}

// ─── Video extractor ─────────────────────────────────────────────────────────

function extractVideo() {
  const url = location.href;
  let platform = "unknown";
  let embedUrl = "";
  let posterUrl = getMetaContent("og:image");
  let duration = 0;
  let title = document.title;
  let channel = "";

  if (/youtube\.com|youtu\.be/.test(url)) {
    platform = "youtube";
    const videoId =
      new URL(url).searchParams.get("v") ||
      url.match(/youtu\.be\/([^?]+)/)?.[1] || "";
    embedUrl = `https://www.youtube.com/embed/${videoId}`;
    posterUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    title =
      document.querySelector("#title h1, .ytd-video-primary-info-renderer h1")
        ?.textContent?.trim() || title;
    channel =
      document.querySelector("#channel-name a, .ytd-channel-name a")
        ?.textContent?.trim() || "";
  } else if (/vimeo\.com/.test(url)) {
    platform = "vimeo";
    const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1] || "";
    embedUrl = `https://player.vimeo.com/video/${videoId}`;
    title = getMetaContent("og:title") || title;
  } else {
    const videoEl = document.querySelector("video[src], video source[src]");
    if (videoEl) {
      embedUrl = videoEl.src || videoEl.querySelector("source")?.src || "";
      posterUrl = videoEl.poster || posterUrl;
      duration = isNaN(videoEl.duration) ? 0 : Math.round(videoEl.duration);
    }
  }

  return { embedUrl, posterUrl, duration, title, channel, platform };
}

// ─── Image extractor ─────────────────────────────────────────────────────────

function extractImage(target) {
  const img =
    target instanceof HTMLImageElement
      ? target
      : document.querySelector("main img, article img") ||
        document.querySelector("img[src]");

  const figcaption = img?.closest("figure")?.querySelector("figcaption");

  return {
    src: img?.src || "",
    alt: img?.alt || "",
    width: img?.naturalWidth || img?.width || 0,
    height: img?.naturalHeight || img?.height || 0,
    caption: figcaption?.textContent?.trim() || getMetaContent("og:description"),
  };
}

// ─── Code extractor ──────────────────────────────────────────────────────────

const LANGUAGE_MARKERS = {
  typescript: ["tsx", "ts", ".ts", ".tsx", "typescript"],
  javascript: ["jsx", "js", ".js", ".jsx", "javascript"],
  python: [".py", "python"],
  rust: [".rs", "rust"],
  go: [".go", "golang"],
  java: [".java", "java"],
  cpp: [".cpp", ".cxx", "c++"],
  css: [".css", "css"],
  html: [".html", "html"],
  sql: [".sql", "sql"],
};

function detectCodeLanguage(el) {
  const classes = [...el.classList, ...(el.parentElement?.classList || [])].join(" ");
  const lang = el.getAttribute("data-language") ||
    el.getAttribute("lang") ||
    el.getAttribute("data-lang") || "";
  const combined = `${classes} ${lang}`.toLowerCase();

  for (const [language, markers] of Object.entries(LANGUAGE_MARKERS)) {
    if (markers.some((m) => combined.includes(m.toLowerCase()))) return language;
  }
  return "plaintext";
}

function extractCode(target) {
  const codeEl =
    (target ? target.querySelector("code") || target : null) ||
    document.querySelector("pre code, .highlight code, code") ||
    document.body;

  const snippet = (codeEl.textContent || "").trim().slice(0, 50000);
  const language = detectCodeLanguage(codeEl);

  const ghFile = document.querySelector(
    ".file-header-title, .repository-content .final-path"
  );
  const filename = ghFile?.textContent?.trim() || "";
  const ghRepo = document.querySelector('[itemprop="name"] a');
  const repository = ghRepo?.textContent?.trim() || "";

  return { snippet, language, filename, repository };
}

// ─── Screenshot capture ──────────────────────────────────────────────────────

function captureSelectionRegion() {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement("div");
    const selection = document.createElement("div");

    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      cursor: "crosshair",
      background: "rgba(0,0,0,0.35)",
    });

    Object.assign(selection.style, {
      position: "absolute",
      border: "2px solid #6366f1",
      background: "rgba(99,102,241,0.1)",
      display: "none",
    });

    const label = document.createElement("div");
    Object.assign(label.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#6366f1",
      color: "#fff",
      padding: "6px 14px",
      borderRadius: "20px",
      fontSize: "13px",
      fontFamily: "system-ui, sans-serif",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    label.textContent = "Drag to select area — Esc to cancel";

    overlay.appendChild(selection);
    overlay.appendChild(label);
    document.documentElement.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let isDragging = false;

    const onMouseDown = (e) => {
      e.preventDefault();
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      Object.assign(selection.style, {
        display: "block",
        left: `${startX}px`,
        top: `${startY}px`,
        width: "0",
        height: "0",
      });
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      Object.assign(selection.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
    };

    const cleanup = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay.removeEventListener("mousedown", onMouseDown);
      overlay.removeEventListener("mousemove", onMouseMove);
      overlay.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKeyDown);
    };

    const onMouseUp = (e) => {
      if (!isDragging) return;
      isDragging = false;
      const x = clamp(Math.min(e.clientX, startX), 0, window.innerWidth);
      const y = clamp(Math.min(e.clientY, startY), 0, window.innerHeight);
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);
      cleanup();
      if (width < 10 || height < 10) {
        reject(new Error("Selection too small"));
      } else {
        resolve({ x, y, width, height });
      }
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        cleanup();
        reject(new Error("Cancelled by user"));
      }
    };

    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("mousemove", onMouseMove);
    overlay.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);
  });
}

function captureScreenshot(region) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT", region }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || "Screenshot failed"));
        return;
      }
      resolve(response.dataUrl);
    });
  });
}

// ─── Element picker ───────────────────────────────────────────────────────────

function activateElementPicker() {
  return new Promise((resolve, reject) => {
    let highlighted = null;
    const tooltip = document.createElement("div");

    Object.assign(tooltip.style, {
      position: "fixed",
      background: "#6366f1",
      color: "#fff",
      padding: "4px 10px",
      borderRadius: "6px",
      fontSize: "11px",
      fontFamily: "system-ui, sans-serif",
      pointerEvents: "none",
      zIndex: "2147483647",
      whiteSpace: "nowrap",
    });
    tooltip.textContent = "Click to Save";
    document.documentElement.appendChild(tooltip);

    const highlightStyle = document.createElement("style");
    highlightStyle.id = "__qba-picker-style__";
    highlightStyle.textContent = `
      .__qba-pick-hover__ {
        outline: 2px solid #6366f1 !important;
        outline-offset: 2px !important;
        background-color: rgba(99,102,241,0.07) !important;
      }
    `;
    document.head.appendChild(highlightStyle);

    const onMouseMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === tooltip) return;
      if (highlighted) highlighted.classList.remove("__qba-pick-hover__");
      highlighted = el;
      el.classList.add("__qba-pick-hover__");
      Object.assign(tooltip.style, {
        left: `${e.clientX + 12}px`,
        top: `${e.clientY - 28}px`,
        display: "block",
      });
    };

    const cleanup = () => {
      if (highlighted) highlighted.classList.remove("__qba-pick-hover__");
      if (highlightStyle.parentNode) highlightStyle.parentNode.removeChild(highlightStyle);
      if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown);
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      cleanup();
      if (el) resolve(el);
      else reject(new Error("No element found"));
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        cleanup();
        reject(new Error("Cancelled by user"));
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown);
  });
}

// ─── Clip builder ─────────────────────────────────────────────────────────────

async function buildClip(targetEl, withScreenshot) {
  const type = detectContentType(targetEl || document.documentElement);
  const clip = {
    id: generateId(),
    type,
    url: location.href,
    faviconUrl: getFaviconUrl(),
    title: getMetaContent("og:title") || getMetaContent("title") || document.title,
    description: getMetaContent("og:description") || getMetaContent("description") || "",
    timestamp: Date.now(),
  };

  if (type === "article" || type === "recipe") {
    clip.article = extractArticle();
  } else if (type === "video") {
    clip.video = extractVideo();
  } else if (type === "image") {
    clip.image = extractImage(targetEl);
  } else if (type === "code") {
    clip.code = extractCode(targetEl);
  } else {
    clip.rawHtml = document.documentElement.outerHTML.slice(0, 200000);
  }

  if (withScreenshot) {
    try {
      clip.screenshotDataUrl = await captureScreenshot();
    } catch {
      // best-effort
    }
  }

  return clip;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showClipToast(message, isError) {
  const existing = document.getElementById("__qba-clip-toast__");
  if (existing) existing.parentNode?.removeChild(existing);

  const toast = document.createElement("div");
  toast.id = "__qba-clip-toast__";
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%) translateY(20px)",
    background: isError ? "#ef4444" : "#6366f1",
    color: "#fff",
    padding: "10px 20px",
    borderRadius: "10px",
    fontSize: "13px",
    fontFamily: "system-ui, sans-serif",
    zIndex: "2147483647",
    boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
    transition: "transform 0.2s ease, opacity 0.2s ease",
    opacity: "0",
    pointerEvents: "none",
  });
  toast.textContent = isError ? `⚠ ${message}` : `✓ ${message}`;
  document.documentElement.appendChild(toast);

  requestAnimationFrame(() => {
    Object.assign(toast.style, {
      transform: "translateX(-50%) translateY(0)",
      opacity: "1",
    });
  });

  setTimeout(() => {
    Object.assign(toast.style, {
      transform: "translateX(-50%) translateY(20px)",
      opacity: "0",
    });
    setTimeout(() => toast.parentNode?.removeChild(toast), 300);
  }, 2800);
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "CLIP_ELEMENT": {
      (async () => {
        try {
          const el = message.targetInfo
            ? document.elementFromPoint(message.targetInfo.x, message.targetInfo.y) ||
              document.body
            : document.body;
          const clip = await buildClip(el, false);
          sendResponse({ success: true, clip });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    case "CLIP_FULL_PAGE": {
      (async () => {
        try {
          const clip = await buildClip(undefined, true);
          sendResponse({ success: true, clip });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    case "START_REGION_SCREENSHOT": {
      (async () => {
        try {
          const region = await captureSelectionRegion();
          const dataUrl = await captureScreenshot(region);
          sendResponse({ success: true, dataUrl });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    case "START_ELEMENT_PICKER": {
      (async () => {
        try {
          const el = await activateElementPicker();
          const clip = await buildClip(el, false);
          sendResponse({ success: true, clip });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    default:
      return false;
  }
});

// ─── Alt+S keyboard shortcut ──────────────────────────────────────────────────

document.addEventListener("keydown", async (e) => {
  if (e.altKey && e.key === "s") {
    e.preventDefault();
    try {
      const clip = await buildClip(undefined, false);
      chrome.runtime.sendMessage({ type: "SAVE_CLIP", clip }, (response) => {
        if (chrome.runtime.lastError) {
          showClipToast(chrome.runtime.lastError.message, true);
          return;
        }
        if (response?.success) {
          showClipToast(`Saved to ${response.app || "Quant"} ✦`);
        } else {
          showClipToast(response?.error || "Save failed", true);
        }
      });
    } catch (err) {
      showClipToast(String(err), true);
    }
  }
});

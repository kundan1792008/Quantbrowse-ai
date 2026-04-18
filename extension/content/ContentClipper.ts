/// <reference types="chrome"/>
/**
 * ContentClipper.ts — Universal Web Clipper Content Script
 *
 * Responsibilities:
 *  1. Right-click context menu integration — "Save to Quant" on any element
 *  2. Content-type detection — article / video / image / code / recipe / generic
 *  3. Full article extraction using a built-in Readability-like algorithm
 *  4. Interactive screenshot-selection tool (drag to capture area)
 *  5. Full-page screenshot with scroll stitching via the Offscreen Document API
 *  6. Broadcasts clip events to the background service worker
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type ContentType =
  | "article"
  | "video"
  | "image"
  | "code"
  | "recipe"
  | "product"
  | "generic";

export interface ArticleContent {
  title: string;
  byline: string;
  publishedDate: string;
  bodyHtml: string;
  bodyText: string;
  leadImageUrl: string;
  wordCount: number;
  readingTimeMinutes: number;
}

export interface VideoContent {
  embedUrl: string;
  posterUrl: string;
  duration: number;
  title: string;
  channel: string;
  platform: "youtube" | "vimeo" | "twitter" | "tiktok" | "unknown";
}

export interface ImageContent {
  src: string;
  alt: string;
  width: number;
  height: number;
  caption: string;
}

export interface CodeContent {
  snippet: string;
  language: string;
  filename: string;
  repository: string;
}

export interface ClipPayload {
  id: string;
  type: ContentType;
  url: string;
  faviconUrl: string;
  title: string;
  description: string;
  timestamp: number;
  article?: ArticleContent;
  video?: VideoContent;
  image?: ImageContent;
  code?: CodeContent;
  screenshotDataUrl?: string;
  rawHtml?: string;
}

// ─── Utility helpers ───────────────────────────────────────────────────────

function generateId(): string {
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getMetaContent(name: string): string {
  const el =
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`) ??
    document.querySelector<HTMLMetaElement>(`meta[property="${name}"]`) ??
    document.querySelector<HTMLMetaElement>(`meta[property="og:${name}"]`) ??
    document.querySelector<HTMLMetaElement>(`meta[name="twitter:${name}"]`);
  return el?.content?.trim() ?? "";
}

function getFaviconUrl(): string {
  const link =
    document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
    document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]') ??
    document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (link?.href) return link.href;
  return `${location.origin}/favicon.ico`;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Content-type detection ────────────────────────────────────────────────

/**
 * Heuristically determines the dominant content type of a page or element.
 */
export function detectContentType(root: Element | Document = document): ContentType {
  const url = location.href;
  const host = location.hostname;
  const htmlRoot = root instanceof Document ? root.documentElement : root;
  const text = htmlRoot.textContent ?? "";

  // ── Video platforms ────────────────────────────────────────────────────
  if (
    /youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d|tiktok\.com\/@.+\/video|twitter\.com\/.+\/status/.test(url)
  ) {
    return "video";
  }
  if (htmlRoot.querySelector("video[src], video source[src]")) return "video";

  // ── Code / developer content ───────────────────────────────────────────
  if (
    /github\.com|gitlab\.com|gist\.github\.com|codepen\.io|jsfiddle\.net|stackblitz\.com|codesandbox\.io/.test(
      host
    )
  ) {
    return "code";
  }
  const codeBlockCount = htmlRoot.querySelectorAll("pre code, .highlight, .code-block").length;
  if (codeBlockCount >= 2) return "code";

  // ── Recipe pages ───────────────────────────────────────────────────────
  const recipeSchema = htmlRoot.querySelector('[itemtype*="schema.org/Recipe"]');
  if (recipeSchema) return "recipe";
  if (
    /recipe|ingredients|instructions|servings|prep.?time|cook.?time/i.test(text.slice(0, 3000))
  ) {
    const ingredientBlocks = htmlRoot.querySelectorAll(".ingredients, .ingredient, [itemprop='ingredients']");
    if (ingredientBlocks.length >= 2) return "recipe";
  }

  // ── Product / e-commerce ───────────────────────────────────────────────
  const productSchema = htmlRoot.querySelector('[itemtype*="schema.org/Product"]');
  if (productSchema) return "product";
  if (htmlRoot.querySelector('[class*="add-to-cart"], [class*="buy-now"], [class*="product-price"]')) {
    return "product";
  }

  // ── Single image / gallery ─────────────────────────────────────────────
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif)$/i.test(url)) return "image";
  const images = htmlRoot.querySelectorAll("img[src]");
  const mainContent = htmlRoot.querySelector("main, article, [role='main']");
  if (!mainContent && images.length === 1) return "image";

  // ── Article / long-form text ───────────────────────────────────────────
  const articleEl = htmlRoot.querySelector("article, [itemtype*='Article'], .post-content, .article-body");
  if (articleEl) return "article";
  const paragraphs = htmlRoot.querySelectorAll("p");
  let longParaCount = 0;
  paragraphs.forEach((p) => {
    if ((p.textContent?.length ?? 0) > 80) longParaCount++;
  });
  if (longParaCount >= 4) return "article";

  return "generic";
}

// ─── Article extractor (Readability-inspired) ─────────────────────────────

const UNLIKELY_CANDIDATES =
  /banner|breadcrumb|combx|comment|community|cover|disqus|extra|foot|header|legends|menu|related|remark|rss|shoutbox|sidebar|skyscraper|sponsor|ad-break|agegate|pagination|pager|popup|yom-remote/i;

const POSITIVE_CONTENT =
  /article|body|content|entry|hentry|main|page|pagination|post|text|blog|story/i;

const NEGATIVE_CONTENT =
  /hidden|hid|banner|combx|comment|com-|contact|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|shoutbox|sidebar|sponsor|shopping|tags|tool|widget/i;

const BLOCK_ELEMENTS = new Set([
  "blockquote", "div", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "li", "ol", "p", "pre", "section",
  "table", "td", "th", "tr", "ul",
]);

function getNodeScore(node: Element): number {
  const tagName = node.tagName.toLowerCase();
  const className = (node.className ?? "").toString();
  const id = node.id ?? "";
  const combined = `${className} ${id}`;

  let score = 0;

  // Tag-based bonuses
  if (tagName === "article") score += 30;
  if (tagName === "p") score += 5;
  if (["td", "blockquote"].includes(tagName)) score += 3;
  if (["address", "ol", "ul", "dl", "dd", "dt", "li"].includes(tagName)) score -= 3;
  if (["h1", "h2", "h3", "h4", "h5", "h6", "th"].includes(tagName)) score -= 5;
  if (["form", "aside", "nav", "header", "footer"].includes(tagName)) score -= 25;

  // Class / ID heuristics
  if (NEGATIVE_CONTENT.test(combined)) score -= 25;
  if (POSITIVE_CONTENT.test(combined)) score += 25;
  if (UNLIKELY_CANDIDATES.test(combined)) score -= 25;

  // Text density
  const text = node.textContent ?? "";
  const linkDensity = getLinkDensity(node);
  const textLen = text.length;

  if (textLen < 25) score -= 10;
  else if (textLen > 500) score += 10;
  if (linkDensity > 0.25) score -= Math.round(score * linkDensity);

  return score;
}

function getLinkDensity(node: Element): number {
  const totalLen = (node.textContent ?? "").length;
  if (totalLen === 0) return 0;
  let linkLen = 0;
  node.querySelectorAll("a").forEach((a) => {
    linkLen += (a.textContent ?? "").length;
  });
  return linkLen / totalLen;
}

function removeUnlikelyElements(doc: Document): Document {
  const clone = doc.cloneNode(true) as Document;
  const toRemove: Element[] = [];

  clone.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "iframe", "select", "form"].includes(tag)) {
      toRemove.push(el);
      return;
    }
    const combined = `${el.className ?? ""} ${el.id ?? ""}`;
    if (UNLIKELY_CANDIDATES.test(combined) && !POSITIVE_CONTENT.test(combined)) {
      toRemove.push(el);
    }
  });

  toRemove.forEach((el) => el.parentNode?.removeChild(el));
  return clone;
}

function getTopCandidates(doc: Document, topN = 5): Element[] {
  const cleaned = removeUnlikelyElements(doc);
  const candidates: Map<Element, number> = new Map();

  cleaned.querySelectorAll("p, td, pre").forEach((node) => {
    const innerText = node.textContent ?? "";
    if (innerText.length < 25) return;

    const ancestors: Element[] = [];
    let p: Element | null = node.parentElement;
    let level = 0;
    while (p && level < 3) {
      if (BLOCK_ELEMENTS.has(p.tagName.toLowerCase())) ancestors.push(p);
      p = p.parentElement;
      level++;
    }

    const textScore = Math.min(Math.floor(innerText.length / 100), 3);
    const commaScore = (innerText.match(/,/g) ?? []).length;
    const baseScore = textScore + commaScore + getNodeScore(node);

    ancestors.forEach((ancestor, idx) => {
      const penalty = idx === 0 ? 1 : idx === 1 ? 2 : 3 * idx;
      const existing = candidates.get(ancestor) ?? 0;
      candidates.set(ancestor, existing + baseScore / penalty);
    });
  });

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([el]) => el);
}

export function extractArticle(): ArticleContent {
  const title =
    getMetaContent("og:title") ||
    getMetaContent("title") ||
    document.title;

  const byline =
    getMetaContent("author") ||
    getMetaContent("article:author") ||
    (document.querySelector<HTMLElement>('[rel="author"], .author, [itemprop="author"]')
      ?.textContent
      ?.trim() ?? "");

  const publishedDate =
    getMetaContent("article:published_time") ||
    getMetaContent("date") ||
    (document.querySelector<HTMLTimeElement>("time[datetime]")?.dateTime ?? "");

  const leadImageUrl =
    getMetaContent("og:image") ||
    getMetaContent("image") ||
    (document.querySelector<HTMLImageElement>("article img, .post-content img")?.src ?? "");

  const candidates = getTopCandidates(document);
  const topCandidate = candidates[0] ?? document.body;

  // Clean up the candidate element
  const cleanEl = topCandidate.cloneNode(true) as Element;
  cleanEl.querySelectorAll("script, style, aside, .ad, [class*='share'], [class*='social']").forEach(
    (el) => el.parentNode?.removeChild(el)
  );

  const bodyHtml = cleanEl.innerHTML;
  const bodyText = (cleanEl.textContent ?? "").replace(/\s+/g, " ").trim();
  const wordCount = countWords(bodyText);
  const readingTimeMinutes = Math.ceil(wordCount / 200);

  return {
    title,
    byline,
    publishedDate,
    bodyHtml,
    bodyText,
    leadImageUrl,
    wordCount,
    readingTimeMinutes,
  };
}

// ─── Video extractor ────────────────────────────────────────────────────────

export function extractVideo(): VideoContent {
  const url = location.href;
  let platform: VideoContent["platform"] = "unknown";
  let embedUrl = "";
  let posterUrl = "";
  let duration = 0;
  let title = document.title;
  let channel = "";

  if (/youtube\.com|youtu\.be/.test(url)) {
    platform = "youtube";
    const videoId =
      new URL(url).searchParams.get("v") ??
      url.match(/youtu\.be\/([^?]+)/)?.[1] ?? "";
    embedUrl = `https://www.youtube.com/embed/${videoId}`;
    posterUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    title =
      document.querySelector<HTMLElement>("#title h1, .ytd-video-primary-info-renderer h1")
        ?.textContent?.trim() ?? title;
    channel =
      document.querySelector<HTMLAnchorElement>("#channel-name a, .ytd-channel-name a")
        ?.textContent?.trim() ?? "";
    const durationEl = document.querySelector<HTMLElement>(".ytp-time-duration");
    if (durationEl) {
      const parts = durationEl.textContent?.split(":").map(Number) ?? [];
      duration = parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts.length === 2
        ? parts[0] * 60 + parts[1]
        : 0;
    }
  } else if (/vimeo\.com/.test(url)) {
    platform = "vimeo";
    const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1] ?? "";
    embedUrl = `https://player.vimeo.com/video/${videoId}`;
    posterUrl = getMetaContent("og:image");
    title = getMetaContent("og:title") || title;
    channel =
      document.querySelector<HTMLElement>(".creator-name, .byline")?.textContent?.trim() ?? "";
  } else {
    // Generic video element
    const videoEl = document.querySelector<HTMLVideoElement>("video[src], video source[src]");
    if (videoEl) {
      embedUrl = videoEl.src || videoEl.querySelector("source")?.src || "";
      posterUrl = videoEl.poster || getMetaContent("og:image");
      duration = isNaN(videoEl.duration) ? 0 : Math.round(videoEl.duration);
    }
  }

  return { embedUrl, posterUrl, duration, title, channel, platform };
}

// ─── Image extractor ────────────────────────────────────────────────────────

export function extractImage(target?: Element): ImageContent {
  const img =
    target instanceof HTMLImageElement
      ? target
      : document.querySelector<HTMLImageElement>("main img, article img, img[src]") ??
        document.querySelector<HTMLImageElement>("img[src]");

  const figcaption = img?.closest("figure")?.querySelector("figcaption");

  return {
    src: img?.src ?? "",
    alt: img?.alt ?? "",
    width: img?.naturalWidth ?? img?.width ?? 0,
    height: img?.naturalHeight ?? img?.height ?? 0,
    caption: figcaption?.textContent?.trim() ?? getMetaContent("og:description"),
  };
}

// ─── Code extractor ─────────────────────────────────────────────────────────

const LANGUAGE_MARKERS: Record<string, string[]> = {
  typescript: ["tsx", "ts", ".ts", ".tsx", "typescript", "TypeScript"],
  javascript: ["jsx", "js", ".js", ".jsx", "javascript", "JavaScript"],
  python: [".py", "python", "Python"],
  rust: [".rs", "rust", "Rust"],
  go: [".go", "golang", "Go"],
  java: [".java", "java", "Java"],
  cpp: [".cpp", ".cxx", ".cc", "c++", "cpp"],
  css: [".css", "css", "CSS"],
  html: [".html", ".htm", "html", "HTML"],
  sql: [".sql", "sql", "SQL"],
};

function detectCodeLanguage(el: Element): string {
  const classes = [...el.classList, ...(el.parentElement?.classList ?? [])].join(" ");
  const lang = el.getAttribute("data-language") ??
    el.getAttribute("lang") ??
    el.getAttribute("data-lang") ?? "";

  const combined = `${classes} ${lang}`.toLowerCase();

  for (const [language, markers] of Object.entries(LANGUAGE_MARKERS)) {
    if (markers.some((m) => combined.includes(m.toLowerCase()))) return language;
  }
  return "plaintext";
}

export function extractCode(target?: Element): CodeContent {
  const codeEl =
    target instanceof HTMLPreElement || target instanceof HTMLElement
      ? target.querySelector("code") ?? target
      : document.querySelector<HTMLElement>("pre code, .highlight code, code") ?? document.body;

  const snippet = (codeEl.textContent ?? "").trim().slice(0, 50_000);
  const language = detectCodeLanguage(codeEl);

  let filename = "";
  let repository = "";

  // GitHub-specific
  const ghFile = document.querySelector<HTMLElement>(".file-header-title, .repository-content .final-path");
  filename = ghFile?.textContent?.trim() ?? "";
  const ghRepo = document.querySelector<HTMLElement>('[itemprop="name"] a');
  repository = ghRepo?.textContent?.trim() ?? "";

  return { snippet, language, filename, repository };
}

// ─── Screenshot capture ─────────────────────────────────────────────────────

interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Draws an interactive selection overlay so the user can drag a region to
 * capture.  Resolves with the selection rectangle (relative to viewport).
 * Rejects if the user presses Escape.
 */
export function captureSelectionRegion(): Promise<SelectionRect> {
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
      boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
      display: "none",
    });

    // ── Instruction label ──────────────────────────────────────────────
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

    const onMouseDown = (e: MouseEvent) => {
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

    const onMouseMove = (e: MouseEvent) => {
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
      document.documentElement.removeChild(overlay);
      overlay.removeEventListener("mousedown", onMouseDown);
      overlay.removeEventListener("mousemove", onMouseMove);
      overlay.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKeyDown);
    };

    const onMouseUp = (e: MouseEvent) => {
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

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cleanup();
        reject(new Error("Cancelled by user"));
      }
    };

    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("mousemove", onMouseMove);
    overlay.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown, { once: false });
  });
}

/**
 * Requests the background service worker to capture the visible tab, then
 * optionally crops to the selection rectangle.
 */
export async function captureScreenshot(
  region?: SelectionRect
): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "CAPTURE_SCREENSHOT", region },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error ?? "Screenshot failed"));
          return;
        }
        resolve(response.dataUrl as string);
      }
    );
  });
}

// ─── Clip builder ────────────────────────────────────────────────────────────

/**
 * Builds a complete ClipPayload for the current page (or a specific element).
 *
 * @param targetEl  Optional element the user right-clicked on.
 * @param withScreenshot  Whether to capture a screenshot of the current viewport.
 */
export async function buildClip(
  targetEl?: Element,
  withScreenshot = false
): Promise<ClipPayload> {
  const type = detectContentType(targetEl ?? document);
  const clip: ClipPayload = {
    id: generateId(),
    type,
    url: location.href,
    faviconUrl: getFaviconUrl(),
    title:
      getMetaContent("og:title") ||
      getMetaContent("title") ||
      document.title,
    description:
      getMetaContent("og:description") ||
      getMetaContent("description") ||
      "",
    timestamp: Date.now(),
  };

  switch (type) {
    case "article":
    case "recipe":
      clip.article = extractArticle();
      break;
    case "video":
      clip.video = extractVideo();
      break;
    case "image":
      clip.image = extractImage(targetEl);
      break;
    case "code":
      clip.code = extractCode(targetEl);
      break;
    default:
      clip.rawHtml = document.documentElement.outerHTML.slice(0, 200_000);
  }

  if (withScreenshot) {
    try {
      clip.screenshotDataUrl = await captureScreenshot();
    } catch {
      // screenshot is best-effort
    }
  }

  return clip;
}

// ─── Highlight-and-save overlay ─────────────────────────────────────────────

/**
 * Adds a faint hover highlight and "Save" tooltip to any element the user
 * mouses over.  Pressing Escape or clicking outside the tooltip cancels.
 */
export function activateElementPicker(): Promise<Element> {
  return new Promise((resolve, reject) => {
    let highlighted: Element | null = null;
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

    const onMouseMove = (e: MouseEvent) => {
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
      highlightStyle.parentNode?.removeChild(highlightStyle);
      tooltip.parentNode?.removeChild(tooltip);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown);
    };

    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      cleanup();
      if (el) resolve(el);
      else reject(new Error("No element found"));
    };

    const onKeyDown = (e: KeyboardEvent) => {
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

// ─── Context-menu triggered save flow ──────────────────────────────────────

/**
 * Called when the background receives a context-menu "Save to Quant" click
 * and forwards the message to the content script.
 */
chrome.runtime.onMessage.addListener(
  (
    message: { type: string; targetInfo?: { x: number; y: number } },
    _sender,
    sendResponse
  ) => {
    if (message.type === "CLIP_ELEMENT") {
      (async () => {
        try {
          // Try to identify the element at the context-menu coordinates
          const el = message.targetInfo
            ? (document.elementFromPoint(
                message.targetInfo.x,
                message.targetInfo.y
              ) ?? document.body)
            : document.body;

          const clip = await buildClip(el, false);
          sendResponse({ success: true, clip });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    if (message.type === "CLIP_FULL_PAGE") {
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

    if (message.type === "START_REGION_SCREENSHOT") {
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

    if (message.type === "START_ELEMENT_PICKER") {
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

    return false;
  }
);

// ─── Toast notification ─────────────────────────────────────────────────────

export function showClipToast(message: string, isError = false): void {
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
    Object.assign(toast.style, { transform: "translateX(-50%) translateY(0)", opacity: "1" });
  });

  setTimeout(() => {
    Object.assign(toast.style, { transform: "translateX(-50%) translateY(20px)", opacity: "0" });
    setTimeout(() => toast.parentNode?.removeChild(toast), 300);
  }, 2800);
}

// ─── Quick-save keyboard shortcut (Alt+S) ──────────────────────────────────

document.addEventListener("keydown", async (e: KeyboardEvent) => {
  if (e.altKey && e.key === "s") {
    e.preventDefault();
    try {
      const clip = await buildClip(undefined, false);
      chrome.runtime.sendMessage({ type: "SAVE_CLIP", clip }, (response) => {
        if (response?.success) {
          showClipToast("Saved to Quant ✦");
        } else {
          showClipToast(response?.error ?? "Save failed", true);
        }
      });
    } catch (err) {
      showClipToast(String(err), true);
    }
  }
});

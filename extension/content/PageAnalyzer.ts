/**
 * PageAnalyzer.ts - Structured-data extraction & page-type detection.
 *
 * Runs in the content-script context. Extracts JSON-LD, microdata, OpenGraph,
 * Twitter card metadata, contact info, prices and headings. Heuristically
 * classifies the page (article, product, video, search, profile, login,
 * documentation, generic). Exposes a small async API that the AIAssistant
 * and SwarmCoordinator can call without knowing the host page's structure.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type PageType =
  | 'article'
  | 'product'
  | 'video'
  | 'search'
  | 'profile'
  | 'login'
  | 'documentation'
  | 'forum'
  | 'generic';

export interface OpenGraphData {
  title?: string;
  description?: string;
  image?: string;
  type?: string;
  siteName?: string;
  url?: string;
}

export interface TwitterCardData {
  card?: string;
  title?: string;
  description?: string;
  image?: string;
  site?: string;
}

export interface PriceMatch {
  value: number;
  currency: string;
  raw: string;
}

export interface ContactInfo {
  emails: string[];
  phones: string[];
  socialHandles: string[];
}

export interface Heading {
  level: number;
  text: string;
}

export interface LinkRef {
  text: string;
  href: string;
  rel?: string;
  isExternal: boolean;
}

export interface ImageRef {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface PageAnalysisResult {
  url: string;
  title: string;
  pageType: PageType;
  detectedAt: number;
  language: string;
  wordCount: number;
  readingTimeMinutes: number;
  headings: Heading[];
  links: LinkRef[];
  images: ImageRef[];
  contact: ContactInfo;
  prices: PriceMatch[];
  jsonLd: unknown[];
  openGraph: OpenGraphData;
  twitterCard: TwitterCardData;
  canonicalUrl?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  excerpt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Conservative phone regex: 7-15 digits, optional +/space/dash separators.
const PHONE_REGEX =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{1,4})?/g;

const SOCIAL_HANDLE_REGEX = /(?:^|[\s(])@([A-Za-z0-9_]{2,30})\b/g;

// Match common currency symbols followed by a number, or a number followed by a
// 3-letter currency code. Word-boundary-sensitive.
const PRICE_REGEX =
  /(?:([$€£¥₹₽₩])\s?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?))|(?:\b(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?)\s?(USD|EUR|GBP|JPY|INR|RUB|KRW|CAD|AUD|CHF|CNY)\b)/g;

const CURRENCY_SYMBOL_TO_CODE: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₽': 'RUB',
  '₩': 'KRW',
};

const WORDS_PER_MINUTE = 220;
const MAX_LINKS = 100;
const MAX_IMAGES = 50;
const MAX_HEADINGS = 80;
const EXCERPT_CHAR_LIMIT = 320;

// ─── PageAnalyzer ───────────────────────────────────────────────────────────

class PageAnalyzer {
  /**
   * Analyze the current page and return a structured result.
   */
  analyze(doc: Document = document, win: Window = window): PageAnalysisResult {
    const url = doc.location?.href ?? '';
    const title = (doc.title ?? '').trim();
    const text = this.extractVisibleText(doc);
    const wordCount = this.countWords(text);
    const headings = this.extractHeadings(doc);
    const links = this.extractLinks(doc, url);
    const images = this.extractImages(doc, url);
    const contact = this.extractContactInfo(text);
    const prices = this.extractPrices(text);
    const jsonLd = this.extractJsonLd(doc);
    const openGraph = this.extractOpenGraph(doc);
    const twitterCard = this.extractTwitterCard(doc);
    const canonicalUrl = this.getMeta(doc, 'link[rel="canonical"]', 'href');
    const description =
      this.getMetaContent(doc, 'meta[name="description"]') ??
      openGraph.description ??
      twitterCard.description;
    const author =
      this.getMetaContent(doc, 'meta[name="author"]') ??
      this.getMetaContent(doc, 'meta[property="article:author"]');
    const publishedAt =
      this.getMetaContent(doc, 'meta[property="article:published_time"]') ??
      this.getMetaContent(doc, 'meta[name="date"]') ??
      this.getMetaContent(doc, 'meta[itemprop="datePublished"]');
    const language = doc.documentElement?.lang?.trim() || win.navigator?.language || 'unknown';

    const pageType = this.detectPageType({
      url,
      doc,
      jsonLd,
      openGraph,
      headings,
      wordCount,
    });

    return {
      url,
      title,
      pageType,
      detectedAt: Date.now(),
      language,
      wordCount,
      readingTimeMinutes: Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE)),
      headings,
      links,
      images,
      contact,
      prices,
      jsonLd,
      openGraph,
      twitterCard,
      canonicalUrl,
      description,
      author,
      publishedAt,
      excerpt: this.buildExcerpt(text),
    };
  }

  // ─── Text extraction ──────────────────────────────────────────────────────

  private extractVisibleText(doc: Document): string {
    const body = doc.body;
    if (!body) return '';
    // Clone, strip scripts/styles/templates, then read text.
    const clone = body.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('script, style, noscript, template, svg, iframe')
      .forEach((el) => el.remove());
    return clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  private countWords(text: string): number {
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  }

  private buildExcerpt(text: string): string {
    if (!text) return '';
    if (text.length <= EXCERPT_CHAR_LIMIT) return text;
    const truncated = text.slice(0, EXCERPT_CHAR_LIMIT);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '…';
  }

  // ─── Headings, links, images ──────────────────────────────────────────────

  private extractHeadings(doc: Document): Heading[] {
    const out: Heading[] = [];
    const nodes = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    nodes.forEach((node) => {
      if (out.length >= MAX_HEADINGS) return;
      const level = Number(node.tagName.charAt(1));
      const text = (node.textContent ?? '').trim();
      if (text) out.push({ level, text });
    });
    return out;
  }

  private extractLinks(doc: Document, baseUrl: string): LinkRef[] {
    const out: LinkRef[] = [];
    const seen = new Set<string>();
    const baseHost = this.safeHostname(baseUrl);
    const anchors = doc.querySelectorAll('a[href]');
    anchors.forEach((a) => {
      if (out.length >= MAX_LINKS) return;
      const href = (a.getAttribute('href') ?? '').trim();
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;
      const absolute = this.resolveUrl(href, baseUrl);
      if (!absolute || seen.has(absolute)) return;
      seen.add(absolute);
      const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
      const rel = a.getAttribute('rel') ?? undefined;
      const host = this.safeHostname(absolute);
      out.push({
        text: text || absolute,
        href: absolute,
        rel,
        isExternal: Boolean(host && baseHost && host !== baseHost),
      });
    });
    return out;
  }

  private extractImages(doc: Document, baseUrl: string): ImageRef[] {
    const out: ImageRef[] = [];
    const seen = new Set<string>();
    const imgs = doc.querySelectorAll('img[src]');
    imgs.forEach((img) => {
      if (out.length >= MAX_IMAGES) return;
      const src = (img.getAttribute('src') ?? '').trim();
      if (!src || src.startsWith('data:')) return;
      const absolute = this.resolveUrl(src, baseUrl);
      if (!absolute || seen.has(absolute)) return;
      seen.add(absolute);
      const alt = (img.getAttribute('alt') ?? '').trim();
      const widthAttr = img.getAttribute('width');
      const heightAttr = img.getAttribute('height');
      out.push({
        src: absolute,
        alt,
        width: widthAttr ? Number(widthAttr) || undefined : undefined,
        height: heightAttr ? Number(heightAttr) || undefined : undefined,
      });
    });
    return out;
  }

  // ─── Contact info & prices ────────────────────────────────────────────────

  private extractContactInfo(text: string): ContactInfo {
    const emails = this.uniqueMatches(text, EMAIL_REGEX);
    const phones = this.uniqueMatches(text, PHONE_REGEX)
      .map((p) => p.trim())
      .filter((p) => {
        const digits = p.replace(/\D/g, '');
        return digits.length >= 7 && digits.length <= 15;
      });
    const handles: string[] = [];
    let m: RegExpExecArray | null;
    const handleRegex = new RegExp(SOCIAL_HANDLE_REGEX.source, SOCIAL_HANDLE_REGEX.flags);
    while ((m = handleRegex.exec(text)) !== null) {
      const handle = `@${m[1]}`;
      if (!handles.includes(handle)) handles.push(handle);
    }
    return { emails, phones, socialHandles: handles };
  }

  private extractPrices(text: string): PriceMatch[] {
    const out: PriceMatch[] = [];
    const seen = new Set<string>();
    const regex = new RegExp(PRICE_REGEX.source, PRICE_REGEX.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const symbolGroup = m[1];
      const numberAfterSymbol = m[2];
      const numberBeforeCode = m[3];
      const codeAfter = m[4];
      let currency = '';
      let raw = '';
      let numStr = '';
      if (symbolGroup && numberAfterSymbol) {
        currency = CURRENCY_SYMBOL_TO_CODE[symbolGroup] ?? symbolGroup;
        numStr = numberAfterSymbol;
        raw = `${symbolGroup}${numberAfterSymbol}`;
      } else if (numberBeforeCode && codeAfter) {
        currency = codeAfter;
        numStr = numberBeforeCode;
        raw = `${numberBeforeCode} ${codeAfter}`;
      } else {
        continue;
      }
      const value = this.parsePriceNumber(numStr);
      if (Number.isNaN(value)) continue;
      const key = `${currency}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value, currency, raw });
    }
    return out;
  }

  private parsePriceNumber(raw: string): number {
    // Normalise European "1.234,56" → "1234.56" and US "1,234.56" → "1234.56".
    const trimmed = raw.replace(/\s/g, '');
    const lastComma = trimmed.lastIndexOf(',');
    const lastDot = trimmed.lastIndexOf('.');
    let normalised = trimmed;
    if (lastComma > lastDot) {
      normalised = trimmed.replace(/\./g, '').replace(',', '.');
    } else {
      normalised = trimmed.replace(/,/g, '');
    }
    return parseFloat(normalised);
  }

  // ─── Structured metadata ──────────────────────────────────────────────────

  private extractJsonLd(doc: Document): unknown[] {
    const out: unknown[] = [];
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    scripts.forEach((s) => {
      const raw = s.textContent?.trim();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          out.push(...parsed);
        } else {
          out.push(parsed);
        }
      } catch {
        // Ignore malformed JSON-LD blocks.
      }
    });
    return out;
  }

  private extractOpenGraph(doc: Document): OpenGraphData {
    return {
      title: this.getMetaContent(doc, 'meta[property="og:title"]'),
      description: this.getMetaContent(doc, 'meta[property="og:description"]'),
      image: this.getMetaContent(doc, 'meta[property="og:image"]'),
      type: this.getMetaContent(doc, 'meta[property="og:type"]'),
      siteName: this.getMetaContent(doc, 'meta[property="og:site_name"]'),
      url: this.getMetaContent(doc, 'meta[property="og:url"]'),
    };
  }

  private extractTwitterCard(doc: Document): TwitterCardData {
    return {
      card: this.getMetaContent(doc, 'meta[name="twitter:card"]'),
      title: this.getMetaContent(doc, 'meta[name="twitter:title"]'),
      description: this.getMetaContent(doc, 'meta[name="twitter:description"]'),
      image: this.getMetaContent(doc, 'meta[name="twitter:image"]'),
      site: this.getMetaContent(doc, 'meta[name="twitter:site"]'),
    };
  }

  // ─── Page-type detection ──────────────────────────────────────────────────

  private detectPageType(args: {
    url: string;
    doc: Document;
    jsonLd: unknown[];
    openGraph: OpenGraphData;
    headings: Heading[];
    wordCount: number;
  }): PageType {
    const { url, doc, jsonLd, openGraph, wordCount } = args;
    const ogType = (openGraph.type ?? '').toLowerCase();

    // 1. JSON-LD @type is the strongest signal.
    const ldType = this.firstJsonLdType(jsonLd);
    if (ldType) {
      const t = ldType.toLowerCase();
      if (t.includes('product')) return 'product';
      if (t.includes('article') || t.includes('newsarticle') || t.includes('blogposting'))
        return 'article';
      if (t.includes('videoobject')) return 'video';
      if (t.includes('person') || t.includes('profilepage')) return 'profile';
      if (t.includes('discussionforumposting')) return 'forum';
      if (t.includes('searchresultspage')) return 'search';
    }

    // 2. OpenGraph type.
    if (ogType.includes('product')) return 'product';
    if (ogType.includes('article')) return 'article';
    if (ogType.includes('video')) return 'video';
    if (ogType.includes('profile')) return 'profile';

    // 3. Structural / URL heuristics.
    const lowerUrl = url.toLowerCase();
    if (
      doc.querySelector(
        'input[type="password"], form[action*="login"], form[action*="signin"]'
      ) &&
      doc.querySelectorAll('input[type="password"]').length > 0
    ) {
      return 'login';
    }
    if (
      /[?&](q|query|search|s)=/.test(lowerUrl) ||
      doc.querySelector('input[type="search"], [role="search"]')
    ) {
      // Only treat as search if the page is mostly results, not a long article.
      if (wordCount < 1500) return 'search';
    }
    if (
      doc.querySelector(
        'meta[itemprop="price"], [itemtype*="schema.org/Product"], button[name*="add-to-cart" i], [class*="add-to-cart" i]'
      )
    ) {
      return 'product';
    }
    if (doc.querySelector('video') && doc.querySelectorAll('video').length > 0) {
      const v = doc.querySelector('video');
      // Heuristic: if there's a prominent video element and not many words, treat as video page.
      if (v && wordCount < 1500) return 'video';
    }
    if (
      /\/(docs?|documentation|reference|guide|manual|api)\//.test(lowerUrl) ||
      doc.querySelector('nav[class*="docs" i], aside[class*="sidebar" i] nav')
    ) {
      return 'documentation';
    }
    if (doc.querySelector('article') && wordCount > 300) {
      return 'article';
    }
    if (
      /\/(thread|forum|topic|discussion)s?\//.test(lowerUrl) ||
      doc.querySelector('[class*="thread" i], [class*="discussion" i]')
    ) {
      return 'forum';
    }
    return 'generic';
  }

  private firstJsonLdType(jsonLd: unknown[]): string | undefined {
    for (const block of jsonLd) {
      if (!block || typeof block !== 'object') continue;
      const obj = block as Record<string, unknown>;
      const t = obj['@type'];
      if (typeof t === 'string') return t;
      if (Array.isArray(t) && typeof t[0] === 'string') return t[0];
    }
    return undefined;
  }

  // ─── DOM helpers ──────────────────────────────────────────────────────────

  private getMeta(
    doc: Document,
    selector: string,
    attr: string
  ): string | undefined {
    const el = doc.querySelector(selector);
    const v = el?.getAttribute(attr)?.trim();
    return v ? v : undefined;
  }

  private getMetaContent(doc: Document, selector: string): string | undefined {
    return this.getMeta(doc, selector, 'content');
  }

  private uniqueMatches(text: string, regex: RegExp): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const r = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) {
      const v = m[0];
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  private resolveUrl(href: string, base: string): string | null {
    try {
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  }

  private safeHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }
}

// ─── Singleton & Listener ───────────────────────────────────────────────────

const analyzer = new PageAnalyzer();

/**
 * Run an analysis of the current page. Exposed as a named export so that
 * `AIAssistant.ts` and the bundled content script can call it directly.
 */
export function analyzeCurrentPage(): PageAnalysisResult {
  return analyzer.analyze();
}

// When loaded into a Chrome extension content script, listen for analysis
// requests from the SwarmCoordinator. The runtime check keeps the module
// safe to import in tests / other contexts where `chrome` is undefined.
if (
  typeof chrome !== 'undefined' &&
  chrome.runtime &&
  typeof chrome.runtime.onMessage?.addListener === 'function'
) {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (
      message &&
      typeof message === 'object' &&
      (message as { type?: string }).type === 'ANALYZE_PAGE'
    ) {
      try {
        const result = analyzeCurrentPage();
        sendResponse({ success: true, data: result });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }
    return undefined;
  });
}

export { PageAnalyzer, analyzer };

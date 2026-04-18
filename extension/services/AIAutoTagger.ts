/**
 * AIAutoTagger.ts — AI-powered content tagging service
 *
 * Uses Gemma local inference (via chrome.aiOriginTrial / window.ai) for
 * on-device processing, with a graceful fallback to the Quantbrowse API
 * when the local model is unavailable.
 *
 * Generates for every piece of saved content:
 *  - title          — clean, de-clickbaited title
 *  - summary        — ≤50-word plain-text summary
 *  - tags           — up to 5 relevant lowercase tags
 *  - category       — single broad category
 *  - sentiment      — positive / neutral / negative
 *  - language       — BCP-47 language code (e.g. "en", "fr", "zh")
 *  - suggestedApp   — which Quant app is the best fit
 *  - confidence     — 0–1 confidence score for the suggestion
 */

import type { ClipPayload, ContentType } from "../content/ContentClipper";

// ─── Types ──────────────────────────────────────────────────────────────────

export type QuantApp =
  | "quantsink"     // broadcast / newsletters
  | "quanttube"     // video content
  | "quantedits"    // images / design
  | "quantbrowse"   // web links / research
  | "quantdocs"     // long-form documents
  | "quantcode"     // code snippets / repos
  | "quantshop"     // products / e-commerce
  | "quantrecipes"  // food & cooking
  | "quantmind";    // notes / ideas / bookmarks

export type Sentiment = "positive" | "neutral" | "negative";

export interface TagResult {
  title: string;
  summary: string;
  tags: string[];
  category: string;
  sentiment: Sentiment;
  language: string;
  translatedTitle: string;
  translatedSummary: string;
  suggestedApp: QuantApp;
  confidence: number;
  processingMs: number;
}

// ─── Category taxonomy ───────────────────────────────────────────────────────

const CATEGORIES = [
  "technology",
  "science",
  "business",
  "finance",
  "health",
  "sports",
  "entertainment",
  "politics",
  "education",
  "travel",
  "food",
  "fashion",
  "gaming",
  "art",
  "music",
  "news",
  "opinion",
  "tutorial",
  "research",
  "other",
] as const;

type Category = (typeof CATEGORIES)[number];

// ─── Language detection ─────────────────────────────────────────────────────

const LANGUAGE_PATTERNS: Record<string, RegExp> = {
  zh: /[\u4E00-\u9FFF\u3400-\u4DBF]{10,}/,
  ja: /[\u3040-\u309F\u30A0-\u30FF]{5,}/,
  ko: /[\uAC00-\uD7AF]{5,}/,
  ar: /[\u0600-\u06FF]{10,}/,
  he: /[\u0590-\u05FF]{5,}/,
  ru: /[\u0400-\u04FF]{10,}/,
  uk: /[\u0400-\u04FF]{10,}/,
  el: /[\u0370-\u03FF]{5,}/,
  th: /[\u0E00-\u0E7F]{5,}/,
  hi: /[\u0900-\u097F]{5,}/,
};

const LATIN_STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "for", "that", "this", "with", "are", "have", "from"],
  fr: ["les", "des", "une", "que", "qui", "dans", "pour", "est", "sur"],
  de: ["die", "der", "das", "und", "ist", "ein", "mit", "von", "dem"],
  es: ["los", "las", "una", "que", "por", "con", "para", "del", "una"],
  pt: ["dos", "das", "uma", "que", "por", "com", "para", "não", "uma"],
  it: ["gli", "dei", "una", "che", "per", "con", "sono", "del", "una"],
  nl: ["het", "een", "van", "voor", "met", "zijn", "deze", "ook"],
};

export function detectLanguage(text: string): string {
  if (!text || text.length < 20) return "en";

  // Fast path for non-Latin scripts
  for (const [lang, re] of Object.entries(LANGUAGE_PATTERNS)) {
    if (re.test(text)) return lang;
  }

  // Stopword frequency scoring for Latin-script languages
  const lower = text.toLowerCase();
  const words = lower.split(/\W+/).filter(Boolean);
  const scores: Record<string, number> = {};

  for (const [lang, stopwords] of Object.entries(LATIN_STOPWORDS)) {
    let hits = 0;
    for (const word of words) {
      if (stopwords.includes(word)) hits++;
    }
    scores[lang] = hits;
  }

  const bestLang = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (bestLang && bestLang[1] >= 2) return bestLang[0];
  return "en";
}

// ─── Tag extractor (statistical keyword extraction) ──────────────────────────

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "up", "about", "into", "through", "during",
  "before", "after", "above", "below", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "need",
  "dare", "ought", "used", "as", "if", "this", "that", "these", "those",
  "not", "no", "nor", "so", "yet", "both", "either", "neither", "each",
  "few", "more", "most", "other", "some", "such", "than", "too", "very",
  "just", "how", "all", "also", "its", "it", "he", "she", "we", "they",
  "i", "you", "my", "your", "our", "their", "his", "her", "what", "which",
  "who", "whom", "when", "where", "why", "how",
]);

/**
 * Extracts up to `maxTags` high-value keywords from free text using
 * TF-scored n-gram frequency (unigrams + bigrams).
 */
export function extractKeywords(text: string, maxTags = 5): string[] {
  const lower = text.toLowerCase().replace(/[^\w\s-]/g, " ");
  const words = lower.split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));

  // Unigram frequency
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  // Bigram frequency (weighted higher)
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    freq.set(bigram, (freq.get(bigram) ?? 0) + 1.5);
  }

  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([term]) => term.trim());
}

// ─── Category classifier (rule-based) ───────────────────────────────────────

const CATEGORY_SIGNALS: Record<Category, string[]> = {
  technology: [
    "javascript", "python", "react", "node", "api", "algorithm", "database",
    "machine learning", "ai", "cloud", "docker", "kubernetes", "typescript",
    "software", "developer", "programming", "code", "github", "framework",
  ],
  science: [
    "research", "study", "experiment", "hypothesis", "physics", "chemistry",
    "biology", "neuroscience", "quantum", "genome", "evolution", "climate",
    "particle", "scientist", "laboratory", "peer-reviewed",
  ],
  business: [
    "startup", "revenue", "funding", "ipo", "acquisition", "ceo", "founder",
    "market", "enterprise", "b2b", "saas", "investment", "valuation", "strategy",
  ],
  finance: [
    "stock", "crypto", "bitcoin", "ethereum", "defi", "nft", "invest",
    "portfolio", "dividend", "earnings", "forex", "bond", "etf", "wallet",
  ],
  health: [
    "health", "medical", "disease", "treatment", "symptoms", "doctor",
    "hospital", "clinical trial", "vaccine", "mental health", "nutrition",
    "fitness", "wellness", "therapy",
  ],
  sports: [
    "game", "match", "score", "player", "team", "championship", "tournament",
    "league", "season", "goal", "win", "loss", "athlete", "stadium",
  ],
  entertainment: [
    "movie", "film", "series", "episode", "streaming", "netflix", "actor",
    "actress", "director", "box office", "review", "trailer", "celebrity",
  ],
  politics: [
    "election", "vote", "government", "senate", "congress", "policy", "law",
    "president", "prime minister", "democrat", "republican", "campaign", "bill",
  ],
  education: [
    "learn", "course", "tutorial", "university", "lecture", "textbook",
    "curriculum", "student", "teacher", "certification", "bootcamp", "mooc",
  ],
  travel: [
    "destination", "hotel", "flight", "visa", "passport", "itinerary",
    "backpack", "resort", "tour", "sightseeing", "culture", "local",
  ],
  food: [
    "recipe", "ingredient", "cook", "bake", "restaurant", "cuisine", "meal",
    "diet", "vegan", "calories", "nutrition", "chef", "delicious",
  ],
  fashion: [
    "style", "outfit", "brand", "designer", "trend", "clothing", "shoes",
    "accessories", "fashion week", "sustainable fashion", "wardrobe",
  ],
  gaming: [
    "game", "gameplay", "esports", "streamer", "console", "pc gaming",
    "rpg", "fps", "mmorpg", "twitch", "steam", "playstation", "xbox",
  ],
  art: [
    "painting", "sculpture", "gallery", "exhibition", "artist", "artwork",
    "illustration", "photography", "design", "creative", "museum",
  ],
  music: [
    "album", "track", "artist", "concert", "lyrics", "genre", "spotify",
    "playlist", "producer", "beat", "melody", "musician",
  ],
  news: [
    "breaking", "report", "according to", "officials said", "announced",
    "confirmed", "crisis", "incident", "update", "developing",
  ],
  opinion: [
    "i think", "i believe", "in my opinion", "argument", "perspective",
    "editorial", "column", "commentary", "essay", "analysis",
  ],
  tutorial: [
    "how to", "step by step", "guide", "walkthrough", "example", "demo",
    "install", "setup", "configure", "follow along", "tutorial",
  ],
  research: [
    "paper", "journal", "methodology", "findings", "conclusion", "abstract",
    "sample size", "data", "results", "hypothesis", "literature review",
  ],
  other: [],
};

export function classifyCategory(text: string): Category {
  const lower = text.toLowerCase();
  const scores: Partial<Record<Category, number>> = {};

  for (const [cat, signals] of Object.entries(CATEGORY_SIGNALS) as [
    Category,
    string[],
  ][]) {
    if (cat === "other") continue;
    let score = 0;
    for (const signal of signals) {
      if (lower.includes(signal)) score++;
    }
    if (score > 0) scores[cat] = score;
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best ? (best[0] as Category) : "other";
}

// ─── Sentiment analysis ─────────────────────────────────────────────────────

const POSITIVE_WORDS = new Set([
  "good", "great", "excellent", "amazing", "wonderful", "fantastic",
  "love", "best", "beautiful", "perfect", "happy", "success", "win",
  "gain", "positive", "improve", "growth", "breakthrough", "innovative",
  "helpful", "easy", "simple", "fast", "efficient", "powerful", "better",
  "awesome", "outstanding", "impressive", "revolutionary", "boost",
]);

const NEGATIVE_WORDS = new Set([
  "bad", "terrible", "awful", "horrible", "worst", "hate", "fail",
  "failure", "loss", "negative", "decline", "drop", "problem", "issue",
  "bug", "error", "crash", "broken", "difficult", "hard", "slow",
  "vulnerable", "attack", "breach", "exploit", "risk", "threat",
  "dangerous", "harmful", "toxic", "scam", "fraud", "fake", "misleading",
]);

export function analyzeSentiment(text: string): Sentiment {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  let pos = 0;
  let neg = 0;

  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) pos++;
    if (NEGATIVE_WORDS.has(word)) neg++;
  }

  const total = pos + neg;
  if (total === 0) return "neutral";
  if (pos / total > 0.6) return "positive";
  if (neg / total > 0.4) return "negative";
  return "neutral";
}

// ─── Quant app selector ─────────────────────────────────────────────────────

const CONTENT_TYPE_APP_MAP: Record<ContentType, QuantApp> = {
  article: "quantsink",
  video: "quanttube",
  image: "quantedits",
  code: "quantcode",
  recipe: "quantrecipes",
  product: "quantshop",
  generic: "quantbrowse",
};

const CATEGORY_APP_MAP: Partial<Record<Category, QuantApp>> = {
  technology: "quantbrowse",
  science: "quantdocs",
  business: "quantdocs",
  finance: "quantdocs",
  tutorial: "quantbrowse",
  research: "quantdocs",
  food: "quantrecipes",
  art: "quantedits",
  music: "quanttube",
  entertainment: "quanttube",
};

export function suggestApp(
  contentType: ContentType,
  category: Category,
  confidence: number
): QuantApp {
  if (confidence > 0.7) return CONTENT_TYPE_APP_MAP[contentType];
  return CATEGORY_APP_MAP[category] ?? CONTENT_TYPE_APP_MAP[contentType];
}

// ─── Title cleaner ───────────────────────────────────────────────────────────

const SITE_SEPARATOR = /\s*[\|–—-]\s*/;
const TITLE_FLUFF =
  /^\s*(BREAKING|WATCH|VIDEO|PHOTOS?|GALLERY|OPINION|EDITORIAL|SPONSORED|AD):\s*/i;

export function cleanTitle(raw: string): string {
  // Remove "Site Name - Title" or "Title | Site Name" patterns
  const parts = raw.split(SITE_SEPARATOR);
  const cleanParts = parts
    .map((p) => p.replace(TITLE_FLUFF, "").trim())
    .filter((p) => p.length > 5);

  // Return the longest part (usually the actual article title)
  return (cleanParts.sort((a, b) => b.length - a.length)[0] ?? raw).trim();
}

// ─── Summariser ─────────────────────────────────────────────────────────────

/**
 * Extracts a ≤50-word summary from text using a simple extractive approach
 * (first few sentences that are longer than 40 chars and not headings).
 */
export function extractiveSummary(text: string, maxWords = 50): string {
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 40 && s.length < 400)
    .map((s) => s.trim());

  let summary = "";
  for (const sentence of sentences) {
    const words = summary.split(/\s+/).filter(Boolean);
    if (words.length >= maxWords) break;
    const sentWords = sentence.split(/\s+/).filter(Boolean);
    const remaining = maxWords - words.length;
    if (sentWords.length <= remaining) {
      summary += (summary ? " " : "") + sentence;
    } else {
      summary += (summary ? " " : "") + sentWords.slice(0, remaining).join(" ") + "…";
      break;
    }
  }
  return summary || text.slice(0, 250);
}

// ─── Local AI (window.ai / chrome.aiOriginTrial) ────────────────────────────

interface WindowAI {
  createTextSession: () => Promise<{
    prompt: (text: string) => Promise<string>;
  }>;
}

async function runLocalAI(prompt: string): Promise<string | null> {
  try {
    const ai = (window as unknown as { ai?: WindowAI }).ai;
    if (!ai) return null;
    const session = await ai.createTextSession();
    const result = await session.prompt(prompt);
    return result?.trim() ?? null;
  } catch {
    return null;
  }
}

// ─── Fallback API tagger ─────────────────────────────────────────────────────

async function apiTag(
  text: string,
  apiBase: string
): Promise<Partial<TagResult> | null> {
  try {
    const resp = await fetch(`${apiBase}/api/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Partial<TagResult>;
  } catch {
    return null;
  }
}

// ─── AIAutoTagger main class ─────────────────────────────────────────────────

export class AIAutoTagger {
  private readonly apiBase: string;

  constructor(apiBase = "http://localhost:3000") {
    this.apiBase = apiBase;
  }

  /**
   * Tags a ClipPayload and returns a fully populated TagResult.
   * Processing order: local Gemma → remote API → statistical fallback.
   */
  async tag(clip: ClipPayload): Promise<TagResult> {
    const start = performance.now();

    const rawText = this.#extractText(clip);
    const rawTitle =
      clip.article?.title ?? clip.video?.title ?? clip.title ?? "";

    // ── 1. Detect language ─────────────────────────────────────────────
    const language = detectLanguage(rawText);

    // ── 2. Try local Gemma ─────────────────────────────────────────────
    let aiResult: Partial<TagResult> | null = null;
    const localPrompt = this.#buildGemmaPrompt(rawTitle, rawText.slice(0, 1500));
    const localResponse = await runLocalAI(localPrompt);

    if (localResponse) {
      aiResult = this.#parseGemmaResponse(localResponse);
    }

    // ── 3. Fall back to API ─────────────────────────────────────────────
    if (!aiResult || !aiResult.tags?.length) {
      aiResult = await apiTag(rawText, this.apiBase);
    }

    // ── 4. Statistical fallback ─────────────────────────────────────────
    const title = aiResult?.title ?? cleanTitle(rawTitle);
    const tags =
      aiResult?.tags?.slice(0, 5) ?? extractKeywords(rawText, 5);
    const category =
      aiResult?.category ??
      (classifyCategory(rawText) as string) ??
      "other";
    const sentiment = aiResult?.sentiment ?? analyzeSentiment(rawText);
    const summary =
      aiResult?.summary ??
      extractiveSummary(rawText.replace(/<[^>]+>/g, " "), 50);

    // ── 5. Translation titles/summaries ────────────────────────────────
    const needsTranslation = language !== "en";
    let translatedTitle = title;
    let translatedSummary = summary;

    if (needsTranslation) {
      const tPrompt = `Translate the following to English:\nTitle: ${title}\nSummary: ${summary}\nRespond as JSON: {"title":"...","summary":"..."}`;
      const tResponse = await runLocalAI(tPrompt);
      if (tResponse) {
        try {
          const parsed = JSON.parse(
            tResponse.slice(tResponse.indexOf("{"), tResponse.lastIndexOf("}") + 1)
          ) as { title?: string; summary?: string };
          translatedTitle = parsed.title ?? title;
          translatedSummary = parsed.summary ?? summary;
        } catch {
          // ignore parse errors — keep original
        }
      }
    }

    // ── 6. Suggest Quant app ────────────────────────────────────────────
    const confidence = this.#computeConfidence(clip, tags, category as Category);
    const suggestedApp = suggestApp(
      clip.type,
      category as Category,
      confidence
    );

    return {
      title,
      summary,
      tags,
      category,
      sentiment,
      language,
      translatedTitle,
      translatedSummary,
      suggestedApp,
      confidence,
      processingMs: Math.round(performance.now() - start),
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  #extractText(clip: ClipPayload): string {
    if (clip.article?.bodyText) return clip.article.bodyText;
    if (clip.code?.snippet) return clip.code.snippet;
    if (clip.video?.title) return `${clip.video.title} ${clip.video.channel}`;
    if (clip.image?.alt) return `${clip.image.alt} ${clip.image.caption}`;
    return `${clip.title} ${clip.description}`;
  }

  #buildGemmaPrompt(title: string, text: string): string {
    return `You are a web content analyzer. Given the following web content, respond ONLY with valid JSON (no markdown, no extra text).

Title: ${title}
Content: ${text}

Respond with:
{
  "title": "<clean de-clickbaited title, max 80 chars>",
  "summary": "<extractive summary, max 50 words>",
  "tags": ["<tag1>", "<tag2>", "<tag3>", "<tag4>", "<tag5>"],
  "category": "<one of: technology|science|business|finance|health|sports|entertainment|politics|education|travel|food|fashion|gaming|art|music|news|opinion|tutorial|research|other>",
  "sentiment": "<positive|neutral|negative>"
}`;
  }

  #parseGemmaResponse(raw: string): Partial<TagResult> {
    try {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) return {};
      const json = raw.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(json) as Partial<TagResult>;

      return {
        title: typeof parsed.title === "string" ? parsed.title.slice(0, 120) : undefined,
        summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : undefined,
        tags: Array.isArray(parsed.tags)
          ? (parsed.tags as unknown[])
              .filter((t): t is string => typeof t === "string")
              .map((t) => t.toLowerCase().trim())
              .slice(0, 5)
          : undefined,
        category:
          typeof parsed.category === "string" &&
          CATEGORIES.includes(parsed.category as Category)
            ? parsed.category
            : undefined,
        sentiment:
          parsed.sentiment === "positive" ||
          parsed.sentiment === "negative" ||
          parsed.sentiment === "neutral"
            ? parsed.sentiment
            : undefined,
      };
    } catch {
      return {};
    }
  }

  #computeConfidence(
    clip: ClipPayload,
    tags: string[],
    category: Category
  ): number {
    let confidence = 0.5;
    // Boost if content type matches expected category
    if (clip.type === "video" && ["entertainment", "gaming", "music", "education"].includes(category)) {
      confidence += 0.2;
    }
    if (clip.type === "code" && category === "technology") confidence += 0.2;
    if (clip.type === "recipe" && category === "food") confidence += 0.2;
    if (clip.type === "product" && ["business", "finance"].includes(category)) confidence += 0.1;
    // Boost for rich tags
    if (tags.length >= 4) confidence += 0.1;
    if (tags.length >= 5) confidence += 0.05;
    // Boost if article body was extracted
    if (clip.article?.wordCount && clip.article.wordCount > 200) confidence += 0.1;
    return Math.min(1, confidence);
  }
}

// ─── Singleton convenience export ─────────────────────────────────────────

let taggerInstance: AIAutoTagger | null = null;

export function getAutoTagger(apiBase?: string): AIAutoTagger {
  if (!taggerInstance) {
    taggerInstance = new AIAutoTagger(apiBase);
  }
  return taggerInstance;
}

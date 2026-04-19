export const TEXT_LIMITS = {
  title: 180,
  excerpt: 320,
  summary: 640,
  body: 20000,
  selection: 8000,
  metadata: 1200,
};

const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "aren't",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "did",
  "didn't",
  "do",
  "does",
  "doesn't",
  "doing",
  "don't",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "hadn't",
  "has",
  "hasn't",
  "have",
  "haven't",
  "having",
  "he",
  "he'd",
  "he'll",
  "he's",
  "her",
  "here",
  "here's",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "how's",
  "i",
  "i'd",
  "i'll",
  "i'm",
  "i've",
  "if",
  "in",
  "into",
  "is",
  "isn't",
  "it",
  "it's",
  "its",
  "itself",
  "let's",
  "me",
  "more",
  "most",
  "mustn't",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "she",
  "she'd",
  "she'll",
  "she's",
  "should",
  "shouldn't",
  "so",
  "some",
  "such",
  "than",
  "that",
  "that's",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "there's",
  "these",
  "they",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "wasn't",
  "we",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "were",
  "weren't",
  "what",
  "what's",
  "when",
  "when's",
  "where",
  "where's",
  "which",
  "while",
  "who",
  "who's",
  "whom",
  "why",
  "why's",
  "with",
  "won't",
  "would",
  "wouldn't",
  "you",
  "you'd",
  "you'll",
  "you're",
  "you've",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

export function createClipId() {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 9);
  return `clip_${now}_${rand}`;
}

export function truncateText(text, limit) {
  if (!text) return "";
  const trimmed = String(text).trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

export function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[\t\n]+/g, " ")
    .trim();
}

export function slugify(input) {
  return normalizeWhitespace(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function estimateReadingTime(text) {
  const words = normalizeWhitespace(text).split(" ").filter(Boolean);
  const wordCount = words.length;
  const minutes = Math.max(1, Math.round(wordCount / 220));
  return { wordCount, minutes };
}

export function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function uniqueBy(list, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of list || []) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function buildSearchIndex(values) {
  return normalizeWhitespace(values.filter(Boolean).join(" ")).toLowerCase();
}

export function tokenise(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function scoreTokens(text, weight = 1) {
  const scores = new Map();
  for (const token of tokenise(text)) {
    if (STOPWORDS.has(token)) continue;
    const prev = scores.get(token) || 0;
    scores.set(token, prev + weight);
  }
  return scores;
}

export function mergeTokenScores(...maps) {
  const result = new Map();
  for (const map of maps) {
    for (const [token, score] of map.entries()) {
      result.set(token, (result.get(token) || 0) + score);
    }
  }
  return result;
}

export function topTokens(scoreMap, limit = 12) {
  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token, score]) => ({ token, score }));
}

export function safeArray(input) {
  return Array.isArray(input) ? input : [];
}

export function clampNumber(value, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) return min;
  return Math.min(max, Math.max(min, num));
}

export function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function summariseText(text, maxSentences = 3) {
  const sentences = normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  return sentences.slice(0, maxSentences).join(" ");
}

export function deriveExcerpt(text, fallback) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length) {
    return truncateText(normalized, TEXT_LIMITS.excerpt);
  }
  return truncateText(normalizeWhitespace(fallback || ""), TEXT_LIMITS.excerpt);
}

export function listToCsv(rows) {
  const escape = (value) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;
  return rows.map((row) => row.map(escape).join(",")).join("\n");
}

export function capitalizeWords(text) {
  return normalizeWhitespace(text)
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function limitList(list, limit = 12) {
  return safeArray(list).slice(0, limit);
}

export function uniqueList(list) {
  return [...new Set(safeArray(list))];
}

export function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return Boolean(value);
}

export function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num} B`;
  const units = ["KB", "MB", "GB"];
  let unitIndex = -1;
  let value = num;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function toIsoDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

export function buildTagColor(label) {
  const seed = tokenise(label).join("") || label;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 52%)`;
}

export function chunkArray(list, size) {
  const output = [];
  for (let i = 0; i < list.length; i += size) {
    output.push(list.slice(i, i + size));
  }
  return output;
}

export function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    const shortPath = path.split("/").slice(0, 3).join("/");
    return `${parsed.hostname}${shortPath ? `/${shortPath}` : ""}`;
  } catch {
    return url || "";
  }
}

export function pick(obj, keys) {
  const output = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      output[key] = obj[key];
    }
  }
  return output;
}

export function ensureNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function buildMarkdownLink(label, url) {
  if (!url) return label;
  return `[${label}](${url})`;
}

export function shortenText(text, limit = 48) {
  return truncateText(normalizeWhitespace(text), limit);
}

export function deriveTitle(primary, fallback) {
  const cleaned = normalizeWhitespace(primary || "");
  if (cleaned) return truncateText(cleaned, TEXT_LIMITS.title);
  return truncateText(normalizeWhitespace(fallback || ""), TEXT_LIMITS.title);
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function mergeDeep(target, source) {
  const output = { ...target };
  for (const [key, value] of Object.entries(source || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof output[key] === "object" &&
      output[key] !== null
    ) {
      output[key] = mergeDeep(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function safeJsonParse(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function coerceString(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

export function removeEmptyValues(obj) {
  const output = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    output[key] = value;
  }
  return output;
}

export function formatTagLabel(tag) {
  return capitalizeWords(String(tag || "").replace(/[-_]/g, " "));
}

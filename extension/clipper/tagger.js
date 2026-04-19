import {
  buildTagColor,
  capitalizeWords,
  mergeTokenScores,
  scoreTokens,
  topTokens,
  truncateText,
  uniqueBy,
} from "./utils.js";

const TOPIC_MAP = {
  finance: [
    "stock",
    "market",
    "earnings",
    "invest",
    "investment",
    "portfolio",
    "bond",
    "equity",
    "crypto",
    "blockchain",
    "inflation",
    "economy",
    "recession",
    "nasdaq",
    "dow",
    "s&p",
  ],
  technology: [
    "ai",
    "artificial",
    "machine",
    "learning",
    "software",
    "cloud",
    "data",
    "cyber",
    "security",
    "robot",
    "algorithm",
    "api",
    "automation",
  ],
  productivity: [
    "workflow",
    "process",
    "planning",
    "strategy",
    "roadmap",
    "team",
    "execution",
    "goals",
    "tracking",
    "efficiency",
  ],
  design: [
    "design",
    "ui",
    "ux",
    "visual",
    "layout",
    "typography",
    "color",
    "brand",
    "prototype",
  ],
  research: [
    "paper",
    "study",
    "analysis",
    "experiment",
    "dataset",
    "method",
    "results",
    "evidence",
  ],
  media: [
    "video",
    "audio",
    "podcast",
    "music",
    "stream",
    "interview",
    "recording",
    "clip",
  ],
  education: [
    "course",
    "lesson",
    "tutorial",
    "guide",
    "learn",
    "training",
    "class",
    "lecture",
  ],
  product: [
    "launch",
    "pricing",
    "feature",
    "roadmap",
    "release",
    "feedback",
    "customer",
  ],
  operations: [
    "ops",
    "infrastructure",
    "monitoring",
    "deployment",
    "incident",
    "uptime",
    "runbook",
  ],
  health: [
    "health",
    "wellness",
    "medical",
    "clinical",
    "fitness",
    "diet",
    "nutrition",
    "mental",
  ],
  legal: [
    "policy",
    "compliance",
    "law",
    "contract",
    "terms",
    "privacy",
    "regulation",
  ],
  marketing: [
    "campaign",
    "brand",
    "seo",
    "growth",
    "acquisition",
    "conversion",
    "audience",
  ],
};

const ENTITY_HINTS = [
  "inc",
  "corp",
  "llc",
  "ltd",
  "university",
  "institute",
  "lab",
  "agency",
  "studio",
];

const DEFAULT_TAG_LIMIT = 12;

function deriveTopics(text) {
  const topics = [];
  const lower = text.toLowerCase();
  Object.entries(TOPIC_MAP).forEach(([topic, keywords]) => {
    const matched = keywords.some((keyword) => lower.includes(keyword));
    if (matched) topics.push(topic);
  });
  return topics;
}

function guessEntities(text) {
  const entities = [];
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word) continue;
    const normalized = word.replace(/[^a-zA-Z]/g, "");
    if (!normalized) continue;
    if (normalized.length > 2 && normalized[0] === normalized[0].toUpperCase()) {
      const next = words[i + 1] || "";
      if (ENTITY_HINTS.some((hint) => next.toLowerCase().includes(hint))) {
        entities.push(`${normalized} ${next.replace(/[^a-zA-Z]/g, "")}`);
        continue;
      }
      if (normalized.length >= 4) entities.push(normalized);
    }
  }
  return entities;
}

function normalizeTag(label, score, source) {
  const clean = truncateText(capitalizeWords(label), 40);
  return {
    label: clean,
    score: Number(score.toFixed(2)),
    source,
    color: buildTagColor(clean),
  };
}

export class GemmaTagger {
  constructor(options = {}) {
    this.options = {
      maxTags: DEFAULT_TAG_LIMIT,
      minScore: 0.15,
      ...options,
    };
  }

  generateTags(clip) {
    const titleScores = scoreTokens(clip.title || "", 4);
    const excerptScores = scoreTokens(clip.excerpt || "", 2);
    const bodyScores = scoreTokens(clip.content?.text || "", 1);
    const merged = mergeTokenScores(titleScores, excerptScores, bodyScores);

    const top = topTokens(merged, this.options.maxTags * 2);
    const topicTags = deriveTopics(`${clip.title} ${clip.excerpt} ${clip.content?.text}`)
      .map((topic) => ({ token: topic, score: 0.9 }));

    const entityTags = guessEntities(`${clip.title} ${clip.excerpt}`)
      .slice(0, 6)
      .map((entity, index) => ({
        token: entity,
        score: 0.7 - index * 0.05,
      }));

    const combined = [...topicTags, ...entityTags, ...top]
      .filter((tag) => tag.score >= this.options.minScore)
      .map((tag) => normalizeTag(tag.token, tag.score, "gemma"));

    const unique = uniqueBy(combined, (tag) => tag.label.toLowerCase());

    return unique.slice(0, this.options.maxTags);
  }

  describeTags(tags) {
    if (!tags?.length) return "No tags";
    return tags.map((tag) => tag.label).join(", ");
  }
}

import {
  createClipId,
  deriveExcerpt,
  deriveTitle,
  estimateReadingTime,
  extractDomain,
  normalizeWhitespace,
  shortenUrl,
  truncateText,
} from "./utils.js";

const CLIP_TYPES = {
  PAGE: "page",
  SELECTION: "selection",
  LINK: "link",
  IMAGE: "image",
};

const CLIP_REASON = {
  CONTEXT_MENU: "context_menu",
  POPUP: "popup",
  QUICK_SAVE: "quick_save",
};

const CLIP_SOURCE = {
  RIGHT_CLICK: "right_click",
  TOOLBAR: "toolbar",
  AUTOMATION: "automation",
};

function resolveClipType(info) {
  if (info?.mediaType === "image" || info?.srcUrl) return CLIP_TYPES.IMAGE;
  if (info?.linkUrl) return CLIP_TYPES.LINK;
  if (info?.selectionText) return CLIP_TYPES.SELECTION;
  return CLIP_TYPES.PAGE;
}

function buildLinkPayload(info) {
  if (!info?.linkUrl) return null;
  return {
    url: info.linkUrl,
    text: truncateText(info.selectionText || info.linkUrl, 240),
  };
}

function buildImagePayload(info) {
  if (!info?.srcUrl) return null;
  return {
    url: info.srcUrl,
    alt: info.selectionText || "",
  };
}

function mergeSelection(selection, info) {
  if (!selection) return null;
  return {
    ...selection,
    text: truncateText(selection.text || info?.selectionText || "", 8000),
  };
}

export class ContentClipper {
  constructor({ storage }) {
    this.storage = storage;
  }

  async captureFromContextMenu(tab, info) {
    const clipType = resolveClipType(info);
    const context = await this.fetchClipContext(tab?.id);
    return this.buildClip({
      tab,
      info,
      context,
      clipType,
      reason: CLIP_REASON.CONTEXT_MENU,
      source: CLIP_SOURCE.RIGHT_CLICK,
    });
  }

  async captureFromPopup(tab, captureMode) {
    const context = await this.fetchClipContext(tab?.id);
    return this.buildClip({
      tab,
      info: captureMode === "selection" ? { selectionText: context?.selection?.text } : {},
      context,
      clipType: captureMode === "selection" ? CLIP_TYPES.SELECTION : CLIP_TYPES.PAGE,
      reason: CLIP_REASON.POPUP,
      source: CLIP_SOURCE.TOOLBAR,
    });
  }

  async fetchClipContext(tabId) {
    if (!tabId) return null;
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "GET_CLIP_CONTEXT",
      });
      if (response?.success) return response.context;
    } catch {
      // ignore, fallthrough to injection
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "GET_CLIP_CONTEXT",
      });
      return response?.context ?? null;
    } catch {
      return null;
    }
  }

  async buildClip({ tab, info, context, clipType, reason, source }) {
    const now = Date.now();
    const pageUrl = tab?.url || context?.page?.url || "";
    const pageTitle = tab?.title || context?.page?.title || "";
    const selection = mergeSelection(context?.selection, info);
    const clipText = selection?.text || context?.content?.text || "";
    const excerpt = deriveExcerpt(clipText, pageTitle);
    const { wordCount, minutes } = estimateReadingTime(clipText);

    const metadata = {
      description: context?.page?.description || "",
      siteName: context?.page?.siteName || extractDomain(pageUrl),
      author: context?.page?.author || "",
      language: context?.page?.language || "",
      publishedAt: context?.page?.publishedAt || null,
      readingTime: minutes,
      wordCount,
      favicon: context?.page?.favicon || tab?.favIconUrl || "",
      captureReason: reason,
      captureSource: source,
      captureMode: clipType,
      captureDevice: context?.page?.device || "",
      captureViewport: context?.page?.viewport || null,
    };

    const linkPayload = buildLinkPayload(info);
    const imagePayload = buildImagePayload(info);

    const content = {
      text: truncateText(normalizeWhitespace(context?.content?.text || ""), 20000),
      html: context?.content?.html || "",
      headings: context?.content?.headings || [],
      links: context?.content?.links || [],
      images: context?.content?.images || [],
      highlights: context?.content?.highlights || [],
      summary: truncateText(context?.content?.summary || "", 640),
      outline: context?.content?.outline || [],
    };

    const clip = {
      id: createClipId(),
      type: clipType,
      title: deriveTitle(selection?.text || pageTitle, "Untitled Clip"),
      url: pageUrl,
      shortUrl: shortenUrl(pageUrl),
      excerpt,
      createdAt: now,
      updatedAt: now,
      metadata,
      content,
      selection,
      link: linkPayload,
      image: imagePayload,
      tags: [],
      syncState: "idle",
      syncAttempts: 0,
      lastSyncedAt: null,
      collection: "Inbox",
    };

    return clip;
  }
}

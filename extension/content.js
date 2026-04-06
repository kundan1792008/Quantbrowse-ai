/**
 * content.js — Quantbrowse AI DOM Extractor
 *
 * Injected into every page at document_idle. Listens for a message from
 * background.js requesting the page's visible text content, then replies
 * with the extracted DOM text.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "EXTRACT_DOM") return false;

  try {
    const domContent = extractVisibleText();
    sendResponse({ success: true, domContent });
  } catch (err) {
    sendResponse({ success: false, error: String(err) });
  }

  // Return true to keep the message channel open for async sendResponse
  return true;
});

/**
 * Extracts visible, human-readable text from the current page.
 * Skips script/style tags and hidden elements.
 *
 * @returns {string} Up to 12,000 characters of visible page text.
 */
function extractVisibleText() {
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "EMBED",
  ]);

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip nodes inside tags we don't care about
        let parent = node.parentElement;
        while (parent) {
          if (SKIP_TAGS.has(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          // Skip hidden elements
          const style = window.getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (text.length > 0) {
      parts.push(text);
    }
  }

  const fullText = parts.join(" ").replace(/\s{2,}/g, " ").trim();
  // Limit to 12,000 chars to match the API truncation limit
  return fullText.slice(0, 12000);
}

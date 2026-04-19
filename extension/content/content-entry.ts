/**
 * content-entry.ts - Bundled entry for the content-script.
 *
 * Imported by Vite to produce `extension/content/content-bundle.js`,
 * which the manifest auto-injects into every page alongside the legacy
 * `content.js` DOM extractor. This entry composes the Shadow-DOM
 * AIAssistant and the structured PageAnalyzer.
 */

import './AIAssistant';
import './PageAnalyzer';

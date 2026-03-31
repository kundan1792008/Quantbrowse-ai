/**
 * MicroFrontendLoader.jsx
 *
 * Silently loads a micro-frontend inside an isolated <iframe>.
 *
 * Design goals:
 *  • Zero layout shift — the iframe fills its container completely.
 *  • Silent loading — the shell never shows a spinner; the MFE is loaded
 *    in the background so switching is instant once loaded.
 *  • Sandboxed — each MFE runs in its own browsing context; the shell can
 *    still send post-message commands through the ref exposed via onReady.
 *  • BCI-aware — the loader forwards BCI intent-change events into the
 *    MFE iframe via postMessage so each app can react without a direct
 *    dependency on BCITelemetry.
 */
import React, { useEffect, useRef, useState } from "react";
import { subscribe, BCI_EVENTS } from "../bci/BCITelemetry.js";

const styles = {
  wrapper: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
  },
  iframe: {
    width: "100%",
    height: "100%",
    border: "none",
    background: "transparent",
  },
};

/**
 * Derive the trusted origin from a src URL string.
 * Falls back to "/" (same-origin) for relative paths.
 * @param {string} src
 * @returns {string}
 */
function getTargetOrigin(src) {
  try {
    const url = new URL(src, window.location.href);
    // Use explicit origin for cross-origin MFEs; same-origin for relative paths.
    return url.origin !== window.location.origin ? url.origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

/**
 * @param {Object}   props
 * @param {string}   props.src          - URL of the micro-frontend.
 * @param {string}   props.title        - Accessible title for the iframe.
 * @param {boolean}  [props.visible]    - Whether this MFE is the active one.
 * @param {Function} [props.onReady]    - Called with the iframe element once
 *                                        the MFE has loaded.
 */
export default function MicroFrontendLoader({
  src,
  title,
  visible = false,
  onReady,
}) {
  const iframeRef = useRef(null);
  const [loaded, setLoaded] = useState(false);

  // Forward BCI intent events into the MFE even when it is hidden so that
  // background apps can process signals (e.g. Quantchat auto-composing).
  useEffect(() => {
    const targetOrigin = getTargetOrigin(src);
    const unsub = subscribe(BCI_EVENTS.INTENT_CHANGED, (payload) => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: BCI_EVENTS.INTENT_CHANGED, payload },
        targetOrigin
      );
    });
    return unsub;
  }, [src]);

  function handleLoad() {
    setLoaded(true);
    onReady?.(iframeRef.current);
  }

  return (
    <div
      style={{
        ...styles.wrapper,
        // Keep hidden MFEs in the DOM (pre-loaded) but visually absent so
        // switching feels instant.
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
        zIndex: visible ? 1 : 0,
      }}
      data-testid={`mfe-wrapper-${title}`}
      aria-hidden={!visible}
    >
      <iframe
        ref={iframeRef}
        src={src}
        title={title}
        style={styles.iframe}
        onLoad={handleLoad}
        // allow-scripts without allow-same-origin keeps the sandbox effective:
        // scripts cannot elevate their own permissions or access the parent DOM.
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        loading="eager"
        data-loaded={loaded}
        data-testid={`mfe-iframe-${title}`}
      />
    </div>
  );
}

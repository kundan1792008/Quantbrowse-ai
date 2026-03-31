/**
 * OSLayout.jsx
 *
 * The overarching OS layout for the Quantbrowse-ai unified shell.
 *
 * Architecture:
 *  ┌────────────────────────────────────────────┐
 *  │  Navigation bar (shell chrome)             │  ← always visible
 *  ├────────────────────────────────────────────┤
 *  │                                            │
 *  │  MFE viewport (position:relative)          │
 *  │  ┌──────────────────────────────────────┐  │
 *  │  │  Quanttube  (hidden when inactive)   │  │
 *  │  │  Quantchat  (hidden when inactive)   │  │  ← all three pre-loaded
 *  │  │  Quantsink  (hidden when inactive)   │  │    simultaneously
 *  │  └──────────────────────────────────────┘  │
 *  │                                            │
 *  └────────────────────────────────────────────┘
 *
 * Each MFE is loaded once and kept alive in the DOM.  Switching between
 * apps is done by toggling CSS visibility — no reload, no flash.
 *
 * BCI-driven navigation: when the BCI intent changes to "navigate" for
 * a sustained period the shell cycles to the next app automatically.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import Navigation from "./Navigation.jsx";
import MicroFrontendLoader from "./MicroFrontendLoader.jsx";
import { useBCI } from "../bci/BCIProvider.jsx";

// ─── MFE registry ─────────────────────────────────────────────────────────────
// In production these URLs point to separately deployed micro-frontends.
// During development they can point to local Vite dev-server ports.

const MFE_REGISTRY = [
  {
    id: "quanttube",
    title: "Quanttube",
    // Replace with real URL, e.g. "http://localhost:5001" in dev
    src: import.meta.env.VITE_QUANTTUBE_URL ?? "/mfe/quanttube/",
  },
  {
    id: "quantchat",
    title: "Quantchat",
    src: import.meta.env.VITE_QUANTCHAT_URL ?? "/mfe/quantchat/",
  },
  {
    id: "quantsink",
    title: "Quantsink",
    src: import.meta.env.VITE_QUANTSINK_URL ?? "/mfe/quantsink/",
  },
];

// How many consecutive "navigate" intent frames must arrive before the shell
// auto-advances to the next app (prevents accidental switches).
const BCI_NAV_THRESHOLD = 30;

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    width: "100vw",
    height: "100vh",
    overflow: "hidden",
    background: "#0a0a0f",
  },
  viewport: {
    position: "relative",
    flex: 1,
    overflow: "hidden",
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function OSLayout() {
  const [activeApp, setActiveApp] = useState(MFE_REGISTRY[0].id);
  const { intent } = useBCI();
  const navigateCountRef = useRef(0);

  // BCI-driven navigation: sustained "navigate" intent cycles apps.
  useEffect(() => {
    if (intent === "navigate") {
      navigateCountRef.current += 1;
      if (navigateCountRef.current >= BCI_NAV_THRESHOLD) {
        navigateCountRef.current = 0;
        setActiveApp((current) => {
          const idx = MFE_REGISTRY.findIndex((m) => m.id === current);
          return MFE_REGISTRY[(idx + 1) % MFE_REGISTRY.length].id;
        });
      }
    } else {
      navigateCountRef.current = 0;
    }
  }, [intent]);

  const handleSelect = useCallback((appId) => {
    setActiveApp(appId);
  }, []);

  return (
    <div style={styles.root} data-testid="os-layout">
      <Navigation activeApp={activeApp} onSelect={handleSelect} />

      <main style={styles.viewport} role="main">
        {MFE_REGISTRY.map((mfe) => (
          <MicroFrontendLoader
            key={mfe.id}
            src={mfe.src}
            title={mfe.title}
            visible={activeApp === mfe.id}
          />
        ))}
      </main>
    </div>
  );
}

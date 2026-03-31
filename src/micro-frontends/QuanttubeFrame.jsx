/**
 * QuanttubeFrame.jsx
 *
 * Standalone micro-frontend entry for Quanttube — the decentralised video
 * streaming surface within the Quantbrowse-ai super-app.
 *
 * When deployed as its own app this file becomes the React root rendered
 * into its own index.html.  When loaded inside the shell's OSLayout it runs
 * inside a sandboxed iframe and communicates back via postMessage.
 *
 * BCI integration:
 *  The frame listens for bci:intent_changed postMessages forwarded by
 *  MicroFrontendLoader and adjusts the UI accordingly (e.g. auto-play on
 *  "focus" intent, pause on "relaxed").
 */
import React, { useEffect, useState } from "react";
import { BCI_EVENTS, INTENT_LABELS } from "../bci/BCITelemetry.js";

export default function QuanttubeFrame() {
  const [bciIntent, setBciIntent] = useState(INTENT_LABELS.IDLE);

  // Listen for BCI intent messages forwarded by the shell.
  useEffect(() => {
    function handleMessage(event) {
      if (event.data?.type === BCI_EVENTS.INTENT_CHANGED) {
        setBciIntent(event.data.payload?.intent ?? INTENT_LABELS.IDLE);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f0f1a",
        color: "#e2e8f0",
        gap: "1rem",
      }}
      data-testid="quanttube-frame"
    >
      <h1 style={{ fontSize: "2rem", color: "#818cf8" }}>▶ Quanttube</h1>
      <p style={{ color: "#64748b" }}>
        Decentralised video streaming — micro-frontend
      </p>
      <p
        style={{ fontSize: "0.8rem", color: "#475569" }}
        data-testid="bci-intent-display"
      >
        BCI intent: <strong>{bciIntent}</strong>
      </p>
    </div>
  );
}

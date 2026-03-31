/**
 * QuantchatFrame.jsx
 *
 * Standalone micro-frontend entry for Quantchat — the AI-powered,
 * end-to-end encrypted messaging surface in the Quantbrowse-ai super-app.
 *
 * BCI integration:
 *  The frame listens for bci:intent_changed postMessages forwarded by the
 *  shell.  On "command" intent it can activate a voice-or-thought compose
 *  mode; on "relaxed" it shows ambient conversation view.
 */
import React, { useEffect, useState } from "react";
import { BCI_EVENTS, INTENT_LABELS } from "../bci/BCITelemetry.js";

export default function QuantchatFrame() {
  const [bciIntent, setBciIntent] = useState(INTENT_LABELS.IDLE);

  useEffect(() => {
    function handleMessage(event) {
      if (event.data?.type === BCI_EVENTS.INTENT_CHANGED) {
        setBciIntent(event.data.payload?.intent ?? INTENT_LABELS.IDLE);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const composeActive = bciIntent === INTENT_LABELS.COMMAND;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0f1a",
        color: "#e2e8f0",
        gap: "1rem",
      }}
      data-testid="quantchat-frame"
    >
      <h1 style={{ fontSize: "2rem", color: "#34d399" }}>💬 Quantchat</h1>
      <p style={{ color: "#64748b" }}>
        AI-powered encrypted messaging — micro-frontend
      </p>
      {composeActive && (
        <p style={{ color: "#f97316", fontSize: "0.85rem" }}>
          🧠 BCI compose mode active
        </p>
      )}
      <p
        style={{ fontSize: "0.8rem", color: "#475569" }}
        data-testid="bci-intent-display"
      >
        BCI intent: <strong>{bciIntent}</strong>
      </p>
    </div>
  );
}

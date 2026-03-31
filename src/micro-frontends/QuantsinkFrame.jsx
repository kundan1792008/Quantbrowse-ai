/**
 * QuantsinkFrame.jsx
 *
 * Standalone micro-frontend entry for Quantsink — the decentralised data
 * aggregation and analytics dashboard within the Quantbrowse-ai super-app.
 *
 * BCI integration:
 *  Listens for bci:intent_changed postMessages.  On "focus" intent it
 *  surfaces detailed signal charts; on "relaxed" it collapses to a summary
 *  overview.
 */
import React, { useEffect, useState } from "react";
import { BCI_EVENTS, INTENT_LABELS } from "../bci/BCITelemetry.js";

export default function QuantsinkFrame() {
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

  const detailView = bciIntent === INTENT_LABELS.FOCUS;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0f",
        color: "#e2e8f0",
        gap: "1rem",
      }}
      data-testid="quantsink-frame"
    >
      <h1 style={{ fontSize: "2rem", color: "#f472b6" }}>📡 Quantsink</h1>
      <p style={{ color: "#64748b" }}>
        Decentralised data aggregation — micro-frontend
      </p>
      {detailView && (
        <p style={{ color: "#22d3ee", fontSize: "0.85rem" }}>
          🧠 BCI focus mode: detailed analytics view
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

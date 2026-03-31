/**
 * Navigation.jsx
 *
 * The unified shell navigation bar shown across all micro-frontends.
 * Displays app tabs for Quanttube / Quantchat / Quantsink and a live
 * BCI status indicator.
 */
import React from "react";
import { useBCI } from "../bci/BCIProvider.jsx";

const APPS = [
  { id: "quanttube", label: "Quanttube", icon: "▶" },
  { id: "quantchat", label: "Quantchat", icon: "💬" },
  { id: "quantsink", label: "Quantsink", icon: "📡" },
];

const INTENT_COLORS = {
  idle: "#64748b",
  focus: "#22d3ee",
  relaxed: "#4ade80",
  navigate: "#a78bfa",
  command: "#f97316",
};

const styles = {
  nav: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0 0.75rem",
    height: "48px",
    background: "rgba(15, 15, 25, 0.92)",
    backdropFilter: "blur(12px)",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
    flexShrink: 0,
    zIndex: 100,
    userSelect: "none",
  },
  logo: {
    fontWeight: 700,
    fontSize: "0.95rem",
    letterSpacing: "0.05em",
    color: "#818cf8",
    marginRight: "1rem",
    flexShrink: 0,
  },
  tabs: {
    display: "flex",
    gap: "0.25rem",
    flex: 1,
  },
  tab: (active) => ({
    display: "flex",
    alignItems: "center",
    gap: "0.35rem",
    padding: "0.25rem 0.75rem",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    fontSize: "0.85rem",
    fontWeight: active ? 600 : 400,
    background: active ? "rgba(99,102,241,0.25)" : "transparent",
    color: active ? "#c7d2fe" : "#94a3b8",
    transition: "background 0.15s, color 0.15s",
  }),
  bciIndicator: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    marginLeft: "auto",
    fontSize: "0.75rem",
    color: "#94a3b8",
    flexShrink: 0,
  },
  bciDot: (intent) => ({
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: INTENT_COLORS[intent] ?? INTENT_COLORS.idle,
    boxShadow: `0 0 6px ${INTENT_COLORS[intent] ?? INTENT_COLORS.idle}`,
    transition: "background 0.3s, box-shadow 0.3s",
  }),
};

/**
 * @param {Object}   props
 * @param {string}   props.activeApp  - Currently visible MFE id.
 * @param {Function} props.onSelect   - Called with the app id when a tab is clicked.
 */
export default function Navigation({ activeApp, onSelect }) {
  const { intent, connectedDevice } = useBCI();

  return (
    <nav style={styles.nav} role="navigation" aria-label="Quantbrowse shell">
      <span style={styles.logo}>⬡ Quantbrowse</span>

      <div style={styles.tabs} role="tablist">
        {APPS.map((app) => (
          <button
            key={app.id}
            role="tab"
            aria-selected={activeApp === app.id}
            style={styles.tab(activeApp === app.id)}
            onClick={() => onSelect(app.id)}
            data-testid={`nav-tab-${app.id}`}
          >
            <span aria-hidden="true">{app.icon}</span>
            {app.label}
          </button>
        ))}
      </div>

      <div style={styles.bciIndicator} aria-label={`BCI intent: ${intent}`}>
        <span style={styles.bciDot(intent)} role="img" aria-hidden="true" />
        <span>BCI: {intent}</span>
        {connectedDevice && (
          <span style={{ color: "#4ade80", marginLeft: "0.25rem" }}>
            ● {connectedDevice.name}
          </span>
        )}
      </div>
    </nav>
  );
}

/**
 * BCIProvider.jsx
 *
 * React context provider that makes BCI telemetry state available
 * shell-wide — including inside every micro-frontend (Quanttube,
 * Quantchat, Quantsink).
 */
import React, { createContext, useContext, useEffect, useState } from "react";
import {
  subscribe,
  getTelemetryState,
  BCI_EVENTS,
  INTENT_LABELS,
} from "./BCITelemetry.js";

// ─── Context ──────────────────────────────────────────────────────────────────

const BCIContext = createContext(null);

/**
 * @typedef {Object} BCIContextValue
 * @property {string}      intent         - Current classified user intent.
 * @property {Object|null} connectedDevice - Connected BCI device info, or null.
 * @property {number}      sampleCount    - Number of frames ingested so far.
 * @property {Object|null} lastFrame      - Most recent SignalFrame.
 */

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * Wrap the app root (or any subtree) with <BCIProvider> to expose BCI
 * telemetry data to all descendant components.
 */
export function BCIProvider({ children }) {
  const [bciState, setBciState] = useState(() => ({
    intent: INTENT_LABELS.IDLE,
    connectedDevice: null,
    sampleCount: 0,
    lastFrame: null,
  }));

  useEffect(() => {
    // Hydrate from current telemetry state in case the provider mounts
    // after the first samples arrive.
    const snap = getTelemetryState();
    setBciState((prev) => ({
      ...prev,
      intent: snap.lastIntent,
      connectedDevice: snap.connectedDevice,
      sampleCount: snap.sampleCount,
    }));

    const unsubFrame = subscribe(BCI_EVENTS.SIGNAL_FRAME, (frame) => {
      setBciState((prev) => ({
        ...prev,
        sampleCount: frame.sampleIndex,
        lastFrame: frame,
      }));
    });

    const unsubIntent = subscribe(BCI_EVENTS.INTENT_CHANGED, ({ intent }) => {
      setBciState((prev) => ({ ...prev, intent }));
    });

    const unsubConnected = subscribe(
      BCI_EVENTS.DEVICE_CONNECTED,
      (deviceInfo) => {
        setBciState((prev) => ({ ...prev, connectedDevice: deviceInfo }));
      }
    );

    const unsubDisconnected = subscribe(
      BCI_EVENTS.DEVICE_DISCONNECTED,
      () => {
        setBciState((prev) => ({ ...prev, connectedDevice: null }));
      }
    );

    return () => {
      unsubFrame();
      unsubIntent();
      unsubConnected();
      unsubDisconnected();
    };
  }, []);

  return <BCIContext.Provider value={bciState}>{children}</BCIContext.Provider>;
}

/**
 * Hook to consume BCI telemetry state from any component.
 * Must be used inside a <BCIProvider>.
 *
 * @returns {BCIContextValue}
 */
export function useBCI() {
  const ctx = useContext(BCIContext);
  if (!ctx) {
    throw new Error("useBCI must be used within a <BCIProvider>");
  }
  return ctx;
}

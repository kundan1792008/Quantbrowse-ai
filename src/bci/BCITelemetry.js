/**
 * BCITelemetry.js
 *
 * Overarching Brain-Computer Interface (BCI) Telemetry API for the
 * Quantbrowse-ai unified shell.
 *
 * This module provides a platform-agnostic API surface that:
 *  • Collects neural/biometric telemetry signals from connected BCI hardware
 *    (e.g. Emotiv, Muse, OpenBCI, NeuraLink-compatible adapters).
 *  • Normalises raw samples into a consistent SignalFrame schema.
 *  • Emits named events so any micro-frontend (Quanttube, Quantchat,
 *    Quantsink) can subscribe without tight-coupling to a specific device SDK.
 *  • Exposes an intent-classification API that maps real-time EEG/EMG bands
 *    to user-intent labels (focus, relaxation, navigation, command, idle).
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Recognised EEG frequency bands (Hz ranges). */
export const EEG_BANDS = Object.freeze({
  DELTA: { name: "delta", min: 0.5, max: 4 },
  THETA: { name: "theta", min: 4, max: 8 },
  ALPHA: { name: "alpha", min: 8, max: 13 },
  BETA: { name: "beta", min: 13, max: 30 },
  GAMMA: { name: "gamma", min: 30, max: 100 },
});

/** Intent labels produced by the classifier. */
export const INTENT_LABELS = Object.freeze({
  IDLE: "idle",
  FOCUS: "focus",
  RELAXED: "relaxed",
  NAVIGATE: "navigate",
  COMMAND: "command",
});

/** Shell-wide BCI event names. */
export const BCI_EVENTS = Object.freeze({
  SIGNAL_FRAME: "bci:signal_frame",
  INTENT_CHANGED: "bci:intent_changed",
  DEVICE_CONNECTED: "bci:device_connected",
  DEVICE_DISCONNECTED: "bci:device_disconnected",
  TELEMETRY_ERROR: "bci:telemetry_error",
});

// ─── Internal event bus ───────────────────────────────────────────────────────

const _listeners = new Map(); // eventName → Set<callback>

function _emit(eventName, payload) {
  const handlers = _listeners.get(eventName);
  if (handlers) {
    handlers.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[BCITelemetry] handler error for "${eventName}":`, err);
      }
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Subscribe to a BCI event.
 * @param {string} eventName - One of BCI_EVENTS.*
 * @param {Function} callback - Invoked with the event payload.
 * @returns {Function} Unsubscribe function.
 */
export function subscribe(eventName, callback) {
  if (!_listeners.has(eventName)) {
    _listeners.set(eventName, new Set());
  }
  _listeners.get(eventName).add(callback);
  return () => _listeners.get(eventName)?.delete(callback);
}

/**
 * Ingest a raw device sample and broadcast it as a normalised SignalFrame.
 *
 * @param {Object} rawSample
 * @param {number[]} rawSample.channels   - Per-channel µV readings.
 * @param {number}   rawSample.timestamp  - Unix ms timestamp.
 * @param {string}   [rawSample.deviceId] - Optional hardware identifier.
 * @returns {SignalFrame} The normalised frame that was emitted.
 */
export function ingestSample(rawSample) {
  const frame = _normalise(rawSample);
  _emit(BCI_EVENTS.SIGNAL_FRAME, frame);

  const intent = _classify(frame);
  if (intent !== _state.lastIntent) {
    _state.lastIntent = intent;
    _emit(BCI_EVENTS.INTENT_CHANGED, { intent, frame });
  }

  return frame;
}

/**
 * Notify the shell that a BCI device has connected.
 * @param {{ deviceId: string, name: string, channels: number }} deviceInfo
 */
export function notifyDeviceConnected(deviceInfo) {
  _state.connectedDevice = deviceInfo;
  _emit(BCI_EVENTS.DEVICE_CONNECTED, deviceInfo);
}

/**
 * Notify the shell that a BCI device has disconnected.
 * @param {string} deviceId
 */
export function notifyDeviceDisconnected(deviceId) {
  _state.connectedDevice = null;
  _emit(BCI_EVENTS.DEVICE_DISCONNECTED, { deviceId });
}

/**
 * Return a snapshot of the current telemetry state.
 * @returns {{ connectedDevice: Object|null, lastIntent: string, sampleCount: number }}
 */
export function getTelemetryState() {
  return { ..._state };
}

/**
 * Reset telemetry state and remove all event listeners.
 * Useful for testing or hard-reset scenarios.
 */
export function reset() {
  _listeners.clear();
  _state.connectedDevice = null;
  _state.lastIntent = INTENT_LABELS.IDLE;
  _state.sampleCount = 0;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Mutable shell-level telemetry state (single source of truth). */
const _state = {
  connectedDevice: null,
  lastIntent: INTENT_LABELS.IDLE,
  sampleCount: 0,
};

/**
 * Normalise a raw device sample into a consistent SignalFrame.
 * @param {Object} rawSample
 * @returns {SignalFrame}
 */
function _normalise(rawSample) {
  _state.sampleCount += 1;
  return {
    channels: Array.isArray(rawSample.channels) ? rawSample.channels : [],
    timestamp: rawSample.timestamp ?? Date.now(),
    deviceId: rawSample.deviceId ?? "unknown",
    sampleIndex: _state.sampleCount,
    bandPower: _computeBandPower(rawSample.channels ?? []),
  };
}

/**
 * Compute a simplified band-power proxy from raw channel values.
 * In production this would be replaced by a real FFT pipeline.
 *
 * TODO: Replace with proper Welch/FFT windowed band-power estimation.
 *       See: https://github.com/kundan1792008/Quantbrowse-ai/issues — track as
 *       "Implement real-time FFT band-power for BCI signal classification".
 *
 * @param {number[]} channels
 * @returns {{ delta: number, theta: number, alpha: number, beta: number, gamma: number }}
 */
function _computeBandPower(channels) {
  if (channels.length === 0) {
    return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  }
  const mean = channels.reduce((s, v) => s + v, 0) / channels.length;
  // Deterministic stub: real impl uses per-sample FFT windowing.
  return {
    delta: Math.abs(mean) * 0.4,
    theta: Math.abs(mean) * 0.25,
    alpha: Math.abs(mean) * 0.2,
    beta: Math.abs(mean) * 0.1,
    gamma: Math.abs(mean) * 0.05,
  };
}

/**
 * Classify a normalised SignalFrame into a user-intent label.
 * This stub uses band-power ratios; replace with a trained ML model.
 *
 * @param {SignalFrame} frame
 * @returns {string} One of INTENT_LABELS.*
 */
function _classify(frame) {
  const { alpha, beta, theta } = frame.bandPower;
  if (beta > alpha && beta > theta) return INTENT_LABELS.FOCUS;
  if (alpha > beta && alpha > theta) return INTENT_LABELS.RELAXED;
  if (theta > alpha && theta > beta) return INTENT_LABELS.NAVIGATE;
  return INTENT_LABELS.IDLE;
}

/**
 * @typedef {Object} SignalFrame
 * @property {number[]} channels   - Normalised µV readings.
 * @property {number}   timestamp  - Unix ms timestamp.
 * @property {string}   deviceId   - Source device identifier.
 * @property {number}   sampleIndex - Monotonically increasing sample counter.
 * @property {{ delta: number, theta: number, alpha: number, beta: number, gamma: number }} bandPower
 */

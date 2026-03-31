/**
 * BCITelemetry.test.js
 *
 * Unit tests for the overarching BCI Telemetry API.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  subscribe,
  ingestSample,
  notifyDeviceConnected,
  notifyDeviceDisconnected,
  getTelemetryState,
  reset,
  BCI_EVENTS,
  INTENT_LABELS,
  EEG_BANDS,
} from "../bci/BCITelemetry.js";

describe("BCITelemetry", () => {
  beforeEach(() => {
    reset();
  });

  describe("constants", () => {
    it("exports EEG_BANDS with 5 bands", () => {
      expect(Object.keys(EEG_BANDS)).toHaveLength(5);
    });

    it("exports INTENT_LABELS with expected values", () => {
      expect(INTENT_LABELS.IDLE).toBe("idle");
      expect(INTENT_LABELS.FOCUS).toBe("focus");
      expect(INTENT_LABELS.RELAXED).toBe("relaxed");
      expect(INTENT_LABELS.NAVIGATE).toBe("navigate");
      expect(INTENT_LABELS.COMMAND).toBe("command");
    });

    it("exports BCI_EVENTS with expected event names", () => {
      expect(BCI_EVENTS.SIGNAL_FRAME).toBe("bci:signal_frame");
      expect(BCI_EVENTS.INTENT_CHANGED).toBe("bci:intent_changed");
      expect(BCI_EVENTS.DEVICE_CONNECTED).toBe("bci:device_connected");
      expect(BCI_EVENTS.DEVICE_DISCONNECTED).toBe("bci:device_disconnected");
    });
  });

  describe("subscribe / ingestSample", () => {
    it("emits SIGNAL_FRAME event when a sample is ingested", () => {
      const frames = [];
      subscribe(BCI_EVENTS.SIGNAL_FRAME, (f) => frames.push(f));

      ingestSample({ channels: [1, 2, 3], timestamp: 1000 });

      expect(frames).toHaveLength(1);
      expect(frames[0].channels).toEqual([1, 2, 3]);
      expect(frames[0].timestamp).toBe(1000);
    });

    it("increments sampleIndex monotonically", () => {
      const frames = [];
      subscribe(BCI_EVENTS.SIGNAL_FRAME, (f) => frames.push(f));

      ingestSample({ channels: [1], timestamp: 1 });
      ingestSample({ channels: [2], timestamp: 2 });
      ingestSample({ channels: [3], timestamp: 3 });

      expect(frames[0].sampleIndex).toBe(1);
      expect(frames[1].sampleIndex).toBe(2);
      expect(frames[2].sampleIndex).toBe(3);
    });

    it("normalises missing channels to empty array", () => {
      const frames = [];
      subscribe(BCI_EVENTS.SIGNAL_FRAME, (f) => frames.push(f));

      ingestSample({ timestamp: 999 });

      expect(frames[0].channels).toEqual([]);
    });

    it("returns the normalised frame", () => {
      const frame = ingestSample({ channels: [10], timestamp: 500 });
      expect(frame).toHaveProperty("bandPower");
      expect(frame.sampleIndex).toBe(1);
    });

    it("returns unsubscribe function that stops events", () => {
      const frames = [];
      const unsub = subscribe(BCI_EVENTS.SIGNAL_FRAME, (f) => frames.push(f));
      unsub();

      ingestSample({ channels: [1], timestamp: 1 });
      expect(frames).toHaveLength(0);
    });
  });

  describe("intent classification", () => {
    it("emits INTENT_CHANGED when intent transitions", () => {
      const intents = [];
      subscribe(BCI_EVENTS.INTENT_CHANGED, ({ intent }) =>
        intents.push(intent)
      );

      // High beta → focus
      ingestSample({ channels: [100, 100, 100], timestamp: 1 });

      expect(intents.length).toBeGreaterThanOrEqual(1);
    });

    it("does NOT re-emit INTENT_CHANGED when intent stays the same", () => {
      const intents = [];
      subscribe(BCI_EVENTS.INTENT_CHANGED, ({ intent }) =>
        intents.push(intent)
      );

      ingestSample({ channels: [50, 50], timestamp: 1 });
      const countAfterFirst = intents.length;

      // Same data → same classification → no new event
      ingestSample({ channels: [50, 50], timestamp: 2 });
      expect(intents.length).toBe(countAfterFirst);
    });
  });

  describe("device lifecycle", () => {
    it("notifyDeviceConnected emits DEVICE_CONNECTED and updates state", () => {
      const events = [];
      subscribe(BCI_EVENTS.DEVICE_CONNECTED, (e) => events.push(e));

      const deviceInfo = { deviceId: "dev-1", name: "OpenBCI", channels: 8 };
      notifyDeviceConnected(deviceInfo);

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe("OpenBCI");
      expect(getTelemetryState().connectedDevice).toEqual(deviceInfo);
    });

    it("notifyDeviceDisconnected emits DEVICE_DISCONNECTED and clears state", () => {
      const events = [];
      subscribe(BCI_EVENTS.DEVICE_DISCONNECTED, (e) => events.push(e));

      notifyDeviceConnected({ deviceId: "dev-1", name: "OpenBCI", channels: 8 });
      notifyDeviceDisconnected("dev-1");

      expect(events).toHaveLength(1);
      expect(getTelemetryState().connectedDevice).toBeNull();
    });
  });

  describe("reset", () => {
    it("clears sampleCount and connectedDevice", () => {
      notifyDeviceConnected({ deviceId: "dev-1", name: "X", channels: 4 });
      ingestSample({ channels: [1], timestamp: 1 });
      ingestSample({ channels: [1], timestamp: 2 });

      reset();

      const state = getTelemetryState();
      expect(state.sampleCount).toBe(0);
      expect(state.connectedDevice).toBeNull();
    });

    it("removes all listeners after reset", () => {
      const received = [];
      subscribe(BCI_EVENTS.SIGNAL_FRAME, (f) => received.push(f));

      reset();
      ingestSample({ channels: [1], timestamp: 1 });

      expect(received).toHaveLength(0);
    });
  });
});

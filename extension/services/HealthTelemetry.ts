/**
 * HealthTelemetry.ts - Local-only physiological telemetry ingestion and scoring.
 *
 * This service keeps all processing on-device. It accepts BPM/HRV samples from
 * local bridge events (Apple Health / Google Fit companion bridges), optional
 * runtime messages, and a motion-derived fallback estimator when no wearable
 * data is available.
 */

export type HealthTelemetrySource =
  | 'apple_health'
  | 'google_fit'
  | 'runtime_bridge'
  | 'motion_estimate'
  | 'synthetic';

export interface HealthTelemetrySample {
  bpm: number;
  hrv: number;
  movement: number;
  source: HealthTelemetrySource;
  timestamp: number;
  confidence: number;
}

export interface IncomingTelemetryPayload {
  bpm?: unknown;
  heartRate?: unknown;
  hrv?: unknown;
  rmssd?: unknown;
  movement?: unknown;
  timestamp?: unknown;
  confidence?: unknown;
}

export type PhysiologicalTrend = 'calm' | 'engaged' | 'stressed' | 'lethargic';

export interface HealthTelemetrySnapshot {
  current: HealthTelemetrySample | null;
  baselineBpm: number;
  baselineHrv: number;
  movementAverage: number;
  trend: PhysiologicalTrend;
  harmonyScore: number;
  lastUpdated: number;
}

const EXTERNAL_EVENT_NAME = 'quantbrowse:health-telemetry';
const STORAGE_KEY = 'bioRhythmic.latestTelemetry';
const MAX_SAMPLES = 120;
const MAX_MOTION_SAMPLES = 40;
const FALLBACK_SAMPLE_INTERVAL_MS = 5000;
const STALE_TELEMETRY_MS = 15000;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, next) => total + next, 0) / values.length;
}

function estimateBpmAdjustment(movementAverage: number): number {
  if (movementAverage > 0.6) return 5;
  if (movementAverage < 0.2) return -4;
  return 0;
}

function estimateHrvAdjustment(movementAverage: number): number {
  if (movementAverage < 0.2) return -2;
  return 1;
}

function isHealthTelemetrySource(value: unknown): value is HealthTelemetrySource {
  return (
    value === 'apple_health' ||
    value === 'google_fit' ||
    value === 'runtime_bridge' ||
    value === 'motion_estimate' ||
    value === 'synthetic'
  );
}

export function sanitizeIncomingSample(
  payload: IncomingTelemetryPayload,
  source: HealthTelemetrySource
): HealthTelemetrySample | null {
  const bpmRaw = toNumber(payload.bpm) ?? toNumber(payload.heartRate);
  const hrvRaw = toNumber(payload.hrv) ?? toNumber(payload.rmssd);
  if (bpmRaw == null || hrvRaw == null) return null;

  const movementRaw = toNumber(payload.movement) ?? 0;
  const confidenceRaw = toNumber(payload.confidence) ?? 0.85;
  const timestampRaw = toNumber(payload.timestamp) ?? Date.now();

  const bpm = clamp(Math.round(bpmRaw), 35, 220);
  const hrv = clamp(Math.round(hrvRaw), 5, 220);

  return {
    bpm,
    hrv,
    movement: clamp(movementRaw, 0, 1),
    source,
    timestamp: Math.round(timestampRaw),
    confidence: clamp(confidenceRaw, 0.05, 1),
  };
}

export function computeTrend(args: {
  current: HealthTelemetrySample | null;
  baselineBpm: number;
  baselineHrv: number;
  movementAverage: number;
}): PhysiologicalTrend {
  const { current, baselineBpm, baselineHrv, movementAverage } = args;
  if (!current) return 'engaged';

  const bpmDelta = current.bpm - baselineBpm;
  const hrvDelta = current.hrv - baselineHrv;

  if (bpmDelta >= 12 || (bpmDelta >= 8 && hrvDelta <= -10)) return 'stressed';
  if (bpmDelta <= -10 && movementAverage < 0.28) return 'lethargic';
  if (Math.abs(bpmDelta) <= 6 && hrvDelta >= 0) return 'calm';
  return 'engaged';
}

export function computeHarmonyScore(args: {
  current: HealthTelemetrySample | null;
  baselineBpm: number;
  baselineHrv: number;
  movementAverage: number;
  trend: PhysiologicalTrend;
}): number {
  const { current, baselineBpm, baselineHrv, movementAverage, trend } = args;
  if (!current) return 50;

  const bpmDelta = Math.abs(current.bpm - baselineBpm);
  const hrvDelta = Math.max(0, baselineHrv - current.hrv);

  let score = 100;
  score -= bpmDelta * 1.5;
  score -= hrvDelta * 0.55;
  score -= Math.max(0, movementAverage - 0.75) * 25;

  if (trend === 'stressed') score -= 16;
  if (trend === 'lethargic') score -= 9;
  if (trend === 'calm') score += 4;

  return Math.round(clamp(score, 0, 100));
}

function getStorageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return chrome.storage.session ?? chrome.storage.local ?? null;
}

export class HealthTelemetry {
  private readonly listeners = new Set<(snapshot: HealthTelemetrySnapshot) => void>();

  private readonly samples: HealthTelemetrySample[] = [];

  private readonly motionSamples: number[] = [];

  private fallbackTimer: number | null = null;

  private started = false;

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const data = event.data as
      | {
          type?: string;
          provider?: string;
          payload?: IncomingTelemetryPayload;
        }
      | undefined;
    if (data?.type !== 'QB_HEALTH_TELEMETRY' || !data.payload) return;
    const provider = data.provider === 'google_fit' ? 'google_fit' : 'apple_health';
    this.ingestExternalSample(data.payload, provider);
  };

  private readonly onCustomTelemetry = (event: Event): void => {
    const custom = event as CustomEvent<{
      provider?: 'apple_health' | 'google_fit';
      payload?: IncomingTelemetryPayload;
    }>;
    const payload = custom.detail?.payload;
    if (!payload) return;
    const provider = custom.detail?.provider === 'google_fit' ? 'google_fit' : 'apple_health';
    this.ingestExternalSample(payload, provider);
  };

  private readonly onMotion = (event: DeviceMotionEvent): void => {
    const accel = event.accelerationIncludingGravity;
    if (!accel) return;
    const x = accel.x ?? 0;
    const y = accel.y ?? 0;
    const z = accel.z ?? 0;
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    const movement = clamp(Math.abs(magnitude - 9.81) / 14, 0, 1);
    this.motionSamples.push(movement);
    if (this.motionSamples.length > MAX_MOTION_SAMPLES) {
      this.motionSamples.shift();
    }
  };

  private readonly onRuntimeMessage = (message: unknown): void => {
    const msg = message as
      | {
          type?: string;
          provider?: 'apple_health' | 'google_fit';
          payload?: IncomingTelemetryPayload;
        }
      | undefined;
    if (msg?.type !== 'QB_HEALTH_TELEMETRY' || !msg.payload) return;
    const provider = msg.provider === 'google_fit' ? 'google_fit' : 'runtime_bridge';
    this.ingestExternalSample(msg.payload, provider);
  };

  start(): void {
    if (this.started) return;
    this.started = true;

    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.onMessage);
      window.addEventListener(EXTERNAL_EVENT_NAME, this.onCustomTelemetry as EventListener);
      window.addEventListener('devicemotion', this.onMotion);
    }

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
      chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
    }

    void this.hydrateLatestSample();
    this.startFallbackEstimator();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.onMessage);
      window.removeEventListener(EXTERNAL_EVENT_NAME, this.onCustomTelemetry as EventListener);
      window.removeEventListener('devicemotion', this.onMotion);
    }

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.removeListener) {
      chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
    }

    if (this.fallbackTimer != null && typeof window !== 'undefined') {
      window.clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  subscribe(listener: (snapshot: HealthTelemetrySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  ingestExternalSample(
    payload: IncomingTelemetryPayload,
    source: HealthTelemetrySource = 'runtime_bridge'
  ): HealthTelemetrySample | null {
    const sample = sanitizeIncomingSample(payload, source);
    if (!sample) return null;
    this.pushSample(sample);
    return sample;
  }

  getSnapshot(): HealthTelemetrySnapshot {
    const current = this.samples[this.samples.length - 1] ?? null;

    const baselineSlice = this.samples.slice(-40);
    const baselineBpm = Math.round(avg(baselineSlice.map((sample) => sample.bpm)) || 72);
    const baselineHrv = Math.round(avg(baselineSlice.map((sample) => sample.hrv)) || 42);
    const movementAverage = avg(this.motionSamples) || current?.movement || 0;

    const trend = computeTrend({ current, baselineBpm, baselineHrv, movementAverage });
    const harmonyScore = computeHarmonyScore({
      current,
      baselineBpm,
      baselineHrv,
      movementAverage,
      trend,
    });

    return {
      current,
      baselineBpm,
      baselineHrv,
      movementAverage,
      trend,
      harmonyScore,
      lastUpdated: current?.timestamp ?? 0,
    };
  }

  private pushSample(sample: HealthTelemetrySample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    void this.persistLatestSample(sample);
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private startFallbackEstimator(): void {
    if (typeof window === 'undefined') return;
    this.fallbackTimer = window.setInterval(() => {
      const latest = this.samples[this.samples.length - 1];
      const now = Date.now();
      if (latest && now - latest.timestamp < STALE_TELEMETRY_MS) return;

      const baseline = this.getSnapshot();
      const movementAverage = baseline.movementAverage;
      const estimate = sanitizeIncomingSample(
        {
          bpm: baseline.baselineBpm + estimateBpmAdjustment(movementAverage),
          hrv: baseline.baselineHrv + estimateHrvAdjustment(movementAverage),
          movement: movementAverage,
          confidence: 0.25,
          timestamp: now,
        },
        this.motionSamples.length > 0 ? 'motion_estimate' : 'synthetic'
      );

      if (estimate) this.pushSample(estimate);
    }, FALLBACK_SAMPLE_INTERVAL_MS);
  }

  private async hydrateLatestSample(): Promise<void> {
    const storage = getStorageArea();
    if (!storage?.get) return;

    try {
      const stored = (await storage.get(STORAGE_KEY)) as { [STORAGE_KEY]?: HealthTelemetrySample };
      const candidate = stored[STORAGE_KEY];
      if (!candidate) return;

      const restored = sanitizeIncomingSample(
        candidate,
        isHealthTelemetrySource(candidate.source) ? candidate.source : 'synthetic'
      );
      if (!restored) return;

      const tooOld = Date.now() - restored.timestamp > STALE_TELEMETRY_MS * 4;
      if (!tooOld) this.pushSample(restored);
    } catch {
      // Keep telemetry local and fault-tolerant: ignore storage read issues.
    }
  }

  private async persistLatestSample(sample: HealthTelemetrySample): Promise<void> {
    const storage = getStorageArea();
    if (!storage?.set) return;

    try {
      await storage.set({ [STORAGE_KEY]: sample });
    } catch {
      // Ignore persistence failures and continue processing in memory.
    }
  }
}

export function emitLocalHealthTelemetry(args: {
  provider: 'apple_health' | 'google_fit';
  payload: IncomingTelemetryPayload;
}): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(
    new CustomEvent(EXTERNAL_EVENT_NAME, {
      detail: {
        provider: args.provider,
        payload: args.payload,
      },
    })
  );
}

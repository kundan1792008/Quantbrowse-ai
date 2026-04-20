import { describe, expect, it } from 'vitest';
import {
  HealthTelemetry,
  computeHarmonyScore,
  computeTrend,
  sanitizeIncomingSample,
} from '../services/HealthTelemetry';

describe('HealthTelemetry helpers', () => {
  it('sanitizes incoming wearable payloads and clamps ranges', () => {
    const sample = sanitizeIncomingSample(
      {
        heartRate: '241',
        rmssd: 3,
        movement: 2,
        confidence: 4,
        timestamp: '1234',
      },
      'apple_health'
    );

    expect(sample).toEqual({
      bpm: 220,
      hrv: 5,
      movement: 1,
      confidence: 1,
      timestamp: 1234,
      source: 'apple_health',
    });
  });

  it('classifies stressed and lethargic trends', () => {
    const stressed = computeTrend({
      current: {
        bpm: 95,
        hrv: 24,
        movement: 0.4,
        source: 'google_fit',
        timestamp: Date.now(),
        confidence: 0.9,
      },
      baselineBpm: 72,
      baselineHrv: 44,
      movementAverage: 0.3,
    });

    const lethargic = computeTrend({
      current: {
        bpm: 54,
        hrv: 35,
        movement: 0.1,
        source: 'google_fit',
        timestamp: Date.now(),
        confidence: 0.9,
      },
      baselineBpm: 72,
      baselineHrv: 42,
      movementAverage: 0.1,
    });

    expect(stressed).toBe('stressed');
    expect(lethargic).toBe('lethargic');
  });

  it('computes lower harmony score when physiology diverges', () => {
    const highHarmony = computeHarmonyScore({
      current: {
        bpm: 72,
        hrv: 45,
        movement: 0.3,
        source: 'apple_health',
        timestamp: Date.now(),
        confidence: 0.95,
      },
      baselineBpm: 72,
      baselineHrv: 42,
      movementAverage: 0.3,
      trend: 'calm',
    });

    const lowHarmony = computeHarmonyScore({
      current: {
        bpm: 102,
        hrv: 18,
        movement: 0.85,
        source: 'apple_health',
        timestamp: Date.now(),
        confidence: 0.95,
      },
      baselineBpm: 72,
      baselineHrv: 42,
      movementAverage: 0.9,
      trend: 'stressed',
    });

    expect(highHarmony).toBeGreaterThan(lowHarmony);
  });
});

describe('HealthTelemetry service', () => {
  it('builds snapshots with baseline and trend from ingested samples', () => {
    const telemetry = new HealthTelemetry();

    telemetry.ingestExternalSample({ bpm: 70, hrv: 41, movement: 0.2 }, 'apple_health');
    telemetry.ingestExternalSample({ bpm: 73, hrv: 44, movement: 0.25 }, 'google_fit');
    telemetry.ingestExternalSample({ bpm: 91, hrv: 28, movement: 0.5 }, 'runtime_bridge');

    const snapshot = telemetry.getSnapshot();

    expect(snapshot.current?.bpm).toBe(91);
    expect(snapshot.baselineBpm).toBeGreaterThanOrEqual(70);
    expect(snapshot.baselineBpm).toBeLessThanOrEqual(91);
    expect(snapshot.trend).toBe('stressed');
    expect(snapshot.harmonyScore).toBeGreaterThanOrEqual(0);
    expect(snapshot.harmonyScore).toBeLessThanOrEqual(100);
  });
});

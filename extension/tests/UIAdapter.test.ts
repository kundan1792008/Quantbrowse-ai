import { beforeEach, describe, expect, it } from 'vitest';
import {
  UIAdapter,
  deriveUIAdaptationState,
} from '../services/UIAdapter';
import type { HealthTelemetrySnapshot } from '../services/HealthTelemetry';

function makeSnapshot(
  overrides: Partial<HealthTelemetrySnapshot>
): HealthTelemetrySnapshot {
  return {
    current: {
      bpm: 72,
      hrv: 42,
      movement: 0.3,
      source: 'apple_health',
      timestamp: Date.now(),
      confidence: 0.9,
    },
    baselineBpm: 72,
    baselineHrv: 42,
    movementAverage: 0.3,
    trend: 'engaged',
    harmonyScore: 65,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

describe('UIAdapter state derivation', () => {
  it('derives calming mode for stress spikes', () => {
    const state = deriveUIAdaptationState(
      makeSnapshot({
        trend: 'stressed',
        current: {
          bpm: 96,
          hrv: 25,
          movement: 0.5,
          source: 'google_fit',
          timestamp: Date.now(),
          confidence: 0.9,
        },
      })
    );

    expect(state.tone).toBe('calming');
    expect(state.playbackRate).toBeLessThan(1);
  });

  it('derives energizing mode for lethargy', () => {
    const state = deriveUIAdaptationState(
      makeSnapshot({
        trend: 'lethargic',
        current: {
          bpm: 55,
          hrv: 33,
          movement: 0.1,
          source: 'google_fit',
          timestamp: Date.now(),
          confidence: 0.9,
        },
      })
    );

    expect(state.tone).toBe('energizing');
    expect(state.microMovement).toBe(true);
  });
});

describe('UIAdapter DOM effects', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('qb-bio-energized');
    document.documentElement.style.removeProperty('--qb-bio-hue-shift');
    document.documentElement.style.removeProperty('--qb-bio-contrast');

    const stale = document.getElementById('qb-bio-rhythmic-style');
    stale?.remove();

    (document as Document & { getAnimations: () => Animation[] }).getAnimations = () => [];
  });

  it('applies css variables and toggles energized class', () => {
    const adapter = new UIAdapter(document);

    adapter.applySnapshot(
      makeSnapshot({
        trend: 'lethargic',
        current: {
          bpm: 54,
          hrv: 34,
          movement: 0.1,
          source: 'apple_health',
          timestamp: Date.now(),
          confidence: 0.9,
        },
      })
    );

    expect(document.getElementById('qb-bio-rhythmic-style')).toBeTruthy();
    expect(document.documentElement.classList.contains('qb-bio-energized')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--qb-bio-contrast')).toContain('1.13');

    adapter.destroy();
    expect(document.documentElement.classList.contains('qb-bio-energized')).toBe(false);
  });
});

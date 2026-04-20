/**
 * UIAdapter.ts - Applies physiological adaptations to the active document.
 */

import type { HealthTelemetrySnapshot } from './HealthTelemetry';

export type AdaptationTone = 'balanced' | 'calming' | 'energizing';

export interface UIAdaptationState {
  tone: AdaptationTone;
  colorTemperatureDeg: number;
  contrast: number;
  playbackRate: number;
  microMovement: boolean;
}

const STYLE_ID = 'qb-bio-rhythmic-style';

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function deriveUIAdaptationState(snapshot: HealthTelemetrySnapshot): UIAdaptationState {
  const current = snapshot.current;
  if (!current) {
    return {
      tone: 'balanced',
      colorTemperatureDeg: 0,
      contrast: 1,
      playbackRate: 1,
      microMovement: false,
    };
  }

  const bpmDelta = current.bpm - snapshot.baselineBpm;

  if (snapshot.trend === 'stressed' || bpmDelta >= 12) {
    return {
      tone: 'calming',
      colorTemperatureDeg: 16,
      contrast: 0.96,
      playbackRate: 0.84,
      microMovement: false,
    };
  }

  if (snapshot.trend === 'lethargic' || bpmDelta <= -10) {
    return {
      tone: 'energizing',
      colorTemperatureDeg: -8,
      contrast: 1.13,
      playbackRate: 1.08,
      microMovement: true,
    };
  }

  return {
    tone: 'balanced',
    colorTemperatureDeg: 0,
    contrast: 1,
    playbackRate: 1,
    microMovement: false,
  };
}

export class UIAdapter {
  private readonly doc: Document;

  private styleEl: HTMLStyleElement | null = null;

  private state: UIAdaptationState = {
    tone: 'balanced',
    colorTemperatureDeg: 0,
    contrast: 1,
    playbackRate: 1,
    microMovement: false,
  };

  private readonly originalPlaybackRate = new Map<Animation, number>();

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  applySnapshot(snapshot: HealthTelemetrySnapshot): UIAdaptationState {
    this.ensureStyle();
    this.state = deriveUIAdaptationState(snapshot);

    const target = this.doc.body ?? this.doc.documentElement;
    target.classList.add('qb-bio-adaptive');
    target.style.setProperty('--qb-bio-hue-shift', `${this.state.colorTemperatureDeg}deg`);
    target.style.setProperty('--qb-bio-contrast', `${this.state.contrast}`);

    if (this.state.microMovement) {
      target.classList.add('qb-bio-energized');
    } else {
      target.classList.remove('qb-bio-energized');
    }

    this.tuneAnimationPlaybackRate(this.state.playbackRate);
    return this.state;
  }

  getState(): UIAdaptationState {
    return this.state;
  }

  destroy(): void {
    const target = this.doc.body ?? this.doc.documentElement;
    target.classList.remove('qb-bio-adaptive');
    target.classList.remove('qb-bio-energized');
    target.style.removeProperty('--qb-bio-hue-shift');
    target.style.removeProperty('--qb-bio-contrast');

    if (this.styleEl?.parentElement) {
      this.styleEl.parentElement.removeChild(this.styleEl);
    }
    this.styleEl = null;

    for (const animation of this.doc.getAnimations()) {
      const original = this.originalPlaybackRate.get(animation);
      if (original != null) {
        animation.playbackRate = original;
      }
    }
    this.originalPlaybackRate.clear();
  }

  private ensureStyle(): void {
    if (this.styleEl?.isConnected) return;

    const existing = this.doc.getElementById(STYLE_ID);
    if (existing && existing instanceof HTMLStyleElement) {
      this.styleEl = existing;
      return;
    }

    this.styleEl = this.doc.createElement('style');
    this.styleEl.id = STYLE_ID;
    this.styleEl.textContent = `
      body.qb-bio-adaptive {
        --qb-bio-hue-shift: 0deg;
        --qb-bio-contrast: 1;
        filter: hue-rotate(var(--qb-bio-hue-shift)) contrast(var(--qb-bio-contrast));
        transition: filter 700ms ease;
      }

      body.qb-bio-adaptive.qb-bio-energized {
        animation: qb-bio-micro-shift 2.2s ease-in-out infinite;
        transform-origin: center center;
      }

      @keyframes qb-bio-micro-shift {
        0% { transform: translate3d(0, 0, 0); }
        25% { transform: translate3d(0.5px, -0.5px, 0); }
        50% { transform: translate3d(0, 0.5px, 0); }
        75% { transform: translate3d(-0.5px, -0.4px, 0); }
        100% { transform: translate3d(0, 0, 0); }
      }
    `;

    this.doc.head?.appendChild(this.styleEl);
  }

  private tuneAnimationPlaybackRate(playbackRate: number): void {
    if (typeof this.doc.getAnimations !== 'function') return;

    for (const animation of this.doc.getAnimations()) {
      if (!this.originalPlaybackRate.has(animation)) {
        this.originalPlaybackRate.set(animation, animation.playbackRate || 1);
      }

      const baseline = this.originalPlaybackRate.get(animation) ?? 1;
      animation.playbackRate = clamp(baseline * playbackRate, 0.35, 2.5);
    }
  }
}

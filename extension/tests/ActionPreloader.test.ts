import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActionPreloader } from '../services/ActionPreloader';
import type { BehaviorTelemetry, FocusVector } from '../services/BehaviorTelemetry';

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

describe('ActionPreloader', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = `
      <a id="article" href="https://example.com/article">Read</a>
      <input id="search" type="search" />
    `;
  });

  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('predicts likely next action and prefetches predicted navigation', () => {
    const anchor = document.getElementById('article') as HTMLAnchorElement;
    const search = document.getElementById('search') as HTMLInputElement;

    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => makeRect(90, 90, 120, 40),
    });
    Object.defineProperty(search, 'getBoundingClientRect', {
      value: () => makeRect(420, 320, 240, 36),
    });
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });

    const focusVector: FocusVector = {
      cursorVelocity: 0.9,
      hoverHesitation: 0.8,
      rapidSaccades: 0.3,
      scrollRhythm: 0.7,
      confidence: 0.85,
      timestamp: Date.now(),
    };

    const telemetryStub = {
      getFocusVector: () => focusVector,
      getLatestCursorPoint: () => ({ x: 120, y: 100 }),
    } as unknown as BehaviorTelemetry;

    const preloader = new ActionPreloader(telemetryStub);
    const prediction = preloader.evaluateNextAction();

    expect(prediction).not.toBeNull();
    expect(prediction?.element).toBe(anchor);
    expect(anchor.classList.contains('qb-intent-predicted')).toBe(true);

    if (!prediction) throw new Error('Expected prediction to exist');
    preloader.prefetchPredictedAction(prediction);

    const prefetchLink = document.head.querySelector(
      'link[rel="prefetch"][href="https://example.com/article"]'
    );
    expect(prefetchLink).not.toBeNull();

    preloader.clearHighlight();
    expect(anchor.classList.contains('qb-intent-predicted')).toBe(false);
  });
});

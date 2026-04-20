import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BehaviorTelemetry } from '../services/BehaviorTelemetry';

describe('BehaviorTelemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    document.body.innerHTML = '<button id="target">Target</button><div id="other">Other</div>';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('aggregates cursor, hover and scroll signals into a focus vector', () => {
    const telemetry = new BehaviorTelemetry({ hesitationThresholdMs: 100 });
    const target = document.getElementById('target') as HTMLElement;
    const other = document.getElementById('other') as HTMLElement;

    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.setSystemTime(160);
    other.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    vi.setSystemTime(170);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true }));
    vi.setSystemTime(190);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 60, bubbles: true }));
    vi.setSystemTime(220);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 30, bubbles: true }));

    vi.setSystemTime(260);
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    vi.setSystemTime(300);
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 45, bubbles: true }));
    vi.setSystemTime(340);
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 42, bubbles: true }));

    const vector = telemetry.getFocusVector();

    expect(vector.hoverHesitation).toBeGreaterThan(0);
    expect(vector.cursorVelocity).toBeGreaterThan(0);
    expect(vector.scrollRhythm).toBeGreaterThan(0);
    expect(vector.confidence).toBeGreaterThan(0);
    expect(telemetry.getLatestCursorPoint()).toEqual({ x: 20, y: 30 });

    telemetry.dispose();
  });
});

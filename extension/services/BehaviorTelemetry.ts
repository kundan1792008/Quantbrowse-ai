/**
 * BehaviorTelemetry.ts - Tracks micro-behavior signals and derives a focus vector.
 *
 * Signals:
 * - Cursor velocity
 * - Hover hesitation
 * - Rapid saccades (approximated from abrupt direction/acceleration changes)
 * - Scrolling rhythm consistency
 */

export interface FocusVector {
  cursorVelocity: number;
  hoverHesitation: number;
  rapidSaccades: number;
  scrollRhythm: number;
  confidence: number;
  timestamp: number;
}

interface CursorSample {
  x: number;
  y: number;
  timestamp: number;
  speed: number;
}

interface ScrollSample {
  deltaY: number;
  timestamp: number;
}

interface BehaviorTelemetryOptions {
  maxCursorSamples?: number;
  maxScrollSamples?: number;
  hesitationThresholdMs?: number;
}

const DEFAULT_OPTIONS: Required<BehaviorTelemetryOptions> = {
  maxCursorSamples: 36,
  maxScrollSamples: 20,
  hesitationThresholdMs: 450,
};

export class BehaviorTelemetry {
  private readonly options: Required<BehaviorTelemetryOptions>;
  private readonly cursorSamples: CursorSample[] = [];
  private readonly scrollSamples: ScrollSample[] = [];
  private activeHoverElement: Element | null = null;
  private hoverStartTs = 0;
  private hoverHesitationEvents = 0;
  private rapidSaccadeEvents = 0;
  private disposed = false;
  private readonly wheelListenerOptions: AddEventListenerOptions = { passive: true, capture: true };

  constructor(options: BehaviorTelemetryOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.bindListeners();
  }

  getFocusVector(): FocusVector {
    const cursorVelocity = this.computeCursorVelocity();
    const hoverHesitation = this.computeHoverHesitation();
    const rapidSaccades = this.computeRapidSaccades();
    const scrollRhythm = this.computeScrollRhythm();

    // Tuned for interaction prediction: hesitation + scroll rhythm carry slightly
    // more intent signal than raw velocity/saccades on content-heavy pages.
    const confidence =
      clamp01(cursorVelocity * 0.22) +
      clamp01(hoverHesitation * 0.28) +
      clamp01(rapidSaccades * 0.2) +
      clamp01(scrollRhythm * 0.3);

    return {
      cursorVelocity: round2(cursorVelocity),
      hoverHesitation: round2(hoverHesitation),
      rapidSaccades: round2(rapidSaccades),
      scrollRhythm: round2(scrollRhythm),
      confidence: round2(clamp01(confidence)),
      timestamp: Date.now(),
    };
  }

  getLatestCursorPoint(): { x: number; y: number } | null {
    const sample = this.cursorSamples[this.cursorSamples.length - 1];
    if (!sample) return null;
    return { x: sample.x, y: sample.y };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('mousemove', this.onMouseMove, true);
    document.removeEventListener('mouseover', this.onMouseOver, true);
    document.removeEventListener('wheel', this.onWheel, this.wheelListenerOptions);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
  }

  private bindListeners(): void {
    document.addEventListener('mousemove', this.onMouseMove, true);
    document.addEventListener('mouseover', this.onMouseOver, true);
    document.addEventListener('wheel', this.onWheel, this.wheelListenerOptions);
    window.addEventListener('beforeunload', this.onBeforeUnload);
  }

  private readonly onBeforeUnload = (): void => {
    this.dispose();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    const timestamp = Date.now();
    const prev = this.cursorSamples[this.cursorSamples.length - 1];

    let speed = 0;
    if (prev) {
      const dt = Math.max(1, timestamp - prev.timestamp);
      const dx = event.clientX - prev.x;
      const dy = event.clientY - prev.y;
      speed = Math.hypot(dx, dy) / dt;
      this.detectSaccade(prev, { x: event.clientX, y: event.clientY, timestamp, speed });
    }

    this.cursorSamples.push({
      x: event.clientX,
      y: event.clientY,
      timestamp,
      speed,
    });

    if (this.cursorSamples.length > this.options.maxCursorSamples) {
      this.cursorSamples.shift();
    }
  };

  private readonly onMouseOver = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (!target) return;
    const now = Date.now();

    if (this.activeHoverElement && this.hoverStartTs > 0 && this.activeHoverElement !== target) {
      const hoverDuration = now - this.hoverStartTs;
      if (hoverDuration >= this.options.hesitationThresholdMs) {
        this.hoverHesitationEvents += 1;
      }
    }

    this.activeHoverElement = target;
    this.hoverStartTs = now;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    this.scrollSamples.push({ deltaY: event.deltaY, timestamp: Date.now() });
    if (this.scrollSamples.length > this.options.maxScrollSamples) {
      this.scrollSamples.shift();
    }
  };

  private detectSaccade(previous: CursorSample, current: CursorSample): void {
    const prevPrev = this.cursorSamples[this.cursorSamples.length - 2];
    if (!prevPrev) return;

    const v1x = previous.x - prevPrev.x;
    const v1y = previous.y - prevPrev.y;
    const v2x = current.x - previous.x;
    const v2y = current.y - previous.y;

    const mag1 = Math.hypot(v1x, v1y);
    const mag2 = Math.hypot(v2x, v2y);
    if (mag1 < 6 || mag2 < 6) return;

    const dot = v1x * v2x + v1y * v2y;
    const cosine = dot / (mag1 * mag2);
    const directionFlip = cosine < 0.2;
    const speedSpike = current.speed > previous.speed * 1.6 && current.speed > 0.8;
    if (directionFlip || speedSpike) {
      this.rapidSaccadeEvents += 1;
    }
  }

  private computeCursorVelocity(): number {
    if (this.cursorSamples.length < 2) return 0;
    const speeds = this.cursorSamples.slice(1).map((point) => point.speed);
    return average(speeds);
  }

  private computeHoverHesitation(): number {
    const activeDuration =
      this.activeHoverElement && this.hoverStartTs > 0 ? Date.now() - this.hoverStartTs : 0;
    const activeBoost =
      activeDuration >= this.options.hesitationThresholdMs
        ? Math.min(1, activeDuration / (this.options.hesitationThresholdMs * 2))
        : 0;

    return Math.min(1, this.hoverHesitationEvents * 0.15 + activeBoost);
  }

  private computeRapidSaccades(): number {
    return Math.min(1, this.rapidSaccadeEvents / 8);
  }

  private computeScrollRhythm(): number {
    if (this.scrollSamples.length < 3) return 0;
    const intervals: number[] = [];
    for (let i = 1; i < this.scrollSamples.length; i += 1) {
      intervals.push(this.scrollSamples[i].timestamp - this.scrollSamples[i - 1].timestamp);
    }
    const avg = average(intervals);
    const variance = average(intervals.map((i) => (i - avg) ** 2));
    const stdev = Math.sqrt(variance);
    const consistency = 1 - Math.min(1, stdev / Math.max(1, avg));
    return Math.max(0, consistency);
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

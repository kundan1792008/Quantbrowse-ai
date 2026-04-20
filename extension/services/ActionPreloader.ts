/**
 * ActionPreloader.ts - Predicts probable user actions and preloads resources.
 */

import type { BehaviorTelemetry, FocusVector } from './BehaviorTelemetry';

export interface PredictedAction {
  element: HTMLElement;
  type: 'navigate' | 'search' | 'activate';
  score: number;
  reason: string;
}

interface ActionPreloaderOptions {
  minPredictionScore?: number;
  maxCandidates?: number;
  highlightClassName?: string;
}

const DEFAULT_OPTIONS: Required<ActionPreloaderOptions> = {
  minPredictionScore: 0.45,
  maxCandidates: 20,
  highlightClassName: 'qb-intent-predicted',
};

const INTENT_STYLE_ID = 'qb-intent-preloader-style';
// Near-pointer proximity is the strongest indicator of immediate click intent.
const DISTANCE_WEIGHT = 0.48;
// Target size/readability matters, but less than pointer proximity.
const TARGETABILITY_WEIGHT = 0.2;

export class ActionPreloader {
  private readonly telemetry: BehaviorTelemetry;
  private readonly options: Required<ActionPreloaderOptions>;
  private highlightedElement: HTMLElement | null = null;
  private prefetchedUrls = new Set<string>();
  private preconnectOrigins = new Set<string>();

  constructor(telemetry: BehaviorTelemetry, options: ActionPreloaderOptions = {}) {
    this.telemetry = telemetry;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.ensureStyles();
  }

  evaluateNextAction(): PredictedAction | null {
    const focus = this.telemetry.getFocusVector();
    const pointer = this.telemetry.getLatestCursorPoint();
    const candidates = this.collectCandidates(pointer);
    if (candidates.length === 0) {
      this.clearHighlight();
      return null;
    }

    const ranked = candidates
      .map((element) => this.scoreCandidate(element, focus, pointer))
      .sort((a, b) => b.score - a.score);

    const top = ranked[0];
    if (!top || top.score < this.options.minPredictionScore) {
      this.clearHighlight();
      return null;
    }

    this.applyHighlight(top.element);
    return top;
  }

  prefetchPredictedAction(prediction: PredictedAction): void {
    if (prediction.type === 'navigate' && prediction.element instanceof HTMLAnchorElement) {
      const href = prediction.element.href;
      if (!href || this.prefetchedUrls.has(href)) return;
      this.prefetchedUrls.add(href);

      const prefetch = document.createElement('link');
      prefetch.rel = 'prefetch';
      prefetch.href = href;
      document.head?.appendChild(prefetch);
      return;
    }

    const targetUrl = this.inferTargetOrigin(prediction.element);
    if (!targetUrl) return;
    if (this.preconnectOrigins.has(targetUrl)) return;
    this.preconnectOrigins.add(targetUrl);

    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = targetUrl;
    document.head?.appendChild(preconnect);
  }

  clearHighlight(): void {
    if (this.highlightedElement) {
      this.highlightedElement.classList.remove(this.options.highlightClassName);
      this.highlightedElement = null;
    }
  }

  dispose(): void {
    this.clearHighlight();
  }

  private ensureStyles(): void {
    if (document.getElementById(INTENT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = INTENT_STYLE_ID;
    style.textContent = `
      .${this.options.highlightClassName} {
        outline: 2px solid rgba(99, 102, 241, 0.85) !important;
        outline-offset: 2px !important;
        transform: scale(1.01);
        transition: transform 140ms ease, outline-color 140ms ease;
      }
    `;
    document.head?.appendChild(style);
  }

  private collectCandidates(pointer: { x: number; y: number } | null): HTMLElement[] {
    const selector = [
      'a[href]',
      'button',
      '[role="button"]',
      'input[type="search"]',
      'input[type="text"]',
      'textarea',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const all = Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((el) => this.isEligible(el));

    if (!pointer) {
      return all.slice(0, this.options.maxCandidates);
    }

    return all
      .map((el) => ({ el, dist: this.distanceToElement(pointer.x, pointer.y, el) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, this.options.maxCandidates)
      .map((item) => item.el);
  }

  private scoreCandidate(
    element: HTMLElement,
    focus: FocusVector,
    pointer: { x: number; y: number } | null
  ): PredictedAction {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = pointer ? Math.hypot(pointer.x - centerX, pointer.y - centerY) : 400;
    const distanceScore = 1 - Math.min(1, distance / 700);
    const area = Math.max(1, rect.width * rect.height);
    const targetabilityScore = Math.min(1, Math.log10(area + 1) / 4);
    // Focus weights prioritize deliberate pauses and scroll cadence, while still
    // incorporating movement speed as a weaker corroborating signal.
    const focusBoost =
      focus.hoverHesitation * 0.34 + focus.scrollRhythm * 0.24 + focus.cursorVelocity * 0.22;

    const isLink = element instanceof HTMLAnchorElement;
    const isInput =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable;

    const semanticBoost = isLink ? 0.14 : isInput ? 0.18 : 0.1;
    // Distance is primary (near-pointer intent), targetability is secondary.
    // focusBoost and semanticBoost are already pre-weighted aggregates.
    const score = clamp01(
      distanceScore * DISTANCE_WEIGHT +
        targetabilityScore * TARGETABILITY_WEIGHT +
        focusBoost +
        semanticBoost
    );

    return {
      element,
      type: isLink ? 'navigate' : isInput ? 'search' : 'activate',
      score,
      reason: this.buildReason(isLink, isInput, distanceScore, focus),
    };
  }

  private buildReason(
    isLink: boolean,
    isInput: boolean,
    distanceScore: number,
    focus: FocusVector
  ): string {
    if (isInput) {
      return `High typing intent (proximity ${distanceScore.toFixed(2)}, hesitation ${focus.hoverHesitation.toFixed(2)})`;
    }
    if (isLink) {
      return `Likely navigation target (proximity ${distanceScore.toFixed(2)}, rhythm ${focus.scrollRhythm.toFixed(2)})`;
    }
    return `Likely activation target (proximity ${distanceScore.toFixed(2)}, confidence ${focus.confidence.toFixed(2)})`;
  }

  private inferTargetOrigin(element: HTMLElement): string | null {
    if (element instanceof HTMLAnchorElement) {
      try {
        return new URL(element.href).origin;
      } catch {
        return null;
      }
    }
    return location.origin;
  }

  private distanceToElement(x: number, y: number, element: HTMLElement): number {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return Math.hypot(x - centerX, y - centerY);
  }

  private isEligible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (rect.width < 8 || rect.height < 8) return false;
    if (rect.bottom < 0 || rect.right < 0) return false;
    if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
    return true;
  }

  private applyHighlight(element: HTMLElement): void {
    if (this.highlightedElement === element) return;
    if (this.highlightedElement) {
      this.highlightedElement.classList.remove(this.options.highlightClassName);
    }
    this.highlightedElement = element;
    this.highlightedElement.classList.add(this.options.highlightClassName);
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

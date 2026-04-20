/**
 * BioRhythmicSync.ts - Connects physiological telemetry to per-page UI adaptation.
 */

import { HealthTelemetry } from '../services/HealthTelemetry';
import { UIAdapter } from '../services/UIAdapter';

export class BioRhythmicSyncController {
  private readonly telemetry: HealthTelemetry;

  private readonly adapter: UIAdapter;

  private unsubscribe: (() => void) | null = null;

  private started = false;

  constructor(doc: Document = document) {
    this.telemetry = new HealthTelemetry();
    this.adapter = new UIAdapter(doc);
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.telemetry.start();
    this.unsubscribe = this.telemetry.subscribe((snapshot) => {
      this.adapter.applySnapshot(snapshot);
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    this.unsubscribe?.();
    this.unsubscribe = null;
    this.telemetry.stop();
    this.adapter.destroy();
  }
}

const globalScope = window as Window & {
  __qbBioRhythmicSyncController?: BioRhythmicSyncController;
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (!globalScope.__qbBioRhythmicSyncController) {
    const controller = new BioRhythmicSyncController(document);
    controller.start();
    globalScope.__qbBioRhythmicSyncController = controller;

    window.addEventListener(
      'beforeunload',
      () => {
        controller.stop();
        if (globalScope.__qbBioRhythmicSyncController === controller) {
          delete globalScope.__qbBioRhythmicSyncController;
        }
      },
      { once: true }
    );
  }
}

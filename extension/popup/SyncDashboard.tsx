/**
 * SyncDashboard.tsx - Physiological harmony card for the popup dashboard.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  HealthTelemetry,
  type HealthTelemetrySnapshot,
} from '../services/HealthTelemetry';

export interface SyncDashboardProps {
  telemetry?: HealthTelemetry;
}

function trendLabel(snapshot: HealthTelemetrySnapshot): string {
  switch (snapshot.trend) {
    case 'calm':
      return 'Calm flow';
    case 'stressed':
      return 'Cooling down';
    case 'lethargic':
      return 'Re-engaging';
    case 'engaged':
    default:
      return 'Steady focus';
  }
}

function scoreColor(score: number): string {
  if (score >= 80) return '#22c55e';
  if (score >= 60) return '#0ea5e9';
  if (score >= 40) return '#f59e0b';
  return '#ef4444';
}

export function SyncDashboard({ telemetry }: SyncDashboardProps): ReactElement {
  const [snapshot, setSnapshot] = useState<HealthTelemetrySnapshot>({
    current: null,
    baselineBpm: 72,
    baselineHrv: 42,
    movementAverage: 0,
    trend: 'engaged',
    harmonyScore: 50,
    lastUpdated: 0,
  });

  useEffect(() => {
    const service = telemetry ?? new HealthTelemetry();
    service.start();

    const unsubscribe = service.subscribe((next) => {
      setSnapshot(next);
    });

    return () => {
      unsubscribe();
      if (!telemetry) service.stop();
    };
  }, [telemetry]);

  const gauge = useMemo(() => {
    const score = Math.max(0, Math.min(100, snapshot.harmonyScore));
    return {
      score,
      stroke: scoreColor(score),
      offset: 251.2 - (251.2 * score) / 100,
    };
  }, [snapshot.harmonyScore]);

  return (
    <section
      aria-label="Bio-rhythmic sync"
      data-testid="qb-sync-dashboard"
      style={{
        marginBottom: 14,
        borderRadius: 12,
        border: '1px solid #2a2a3c',
        background: 'linear-gradient(160deg,#141826,#0f0f13)',
        padding: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 0.7,
            color: '#9ca3af',
          }}
        >
          Sync Harmony
        </h2>
        <span style={{ color: '#64748b', fontSize: 11 }}>{trendLabel(snapshot)}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg viewBox="0 0 92 92" width="76" height="76" aria-hidden>
          <circle cx="46" cy="46" r="40" stroke="#1f2937" strokeWidth="8" fill="none" />
          <circle
            cx="46"
            cy="46"
            r="40"
            stroke={gauge.stroke}
            strokeWidth="8"
            fill="none"
            strokeLinecap="round"
            strokeDasharray="251.2"
            strokeDashoffset={gauge.offset}
            transform="rotate(-90 46 46)"
          />
          <text
            x="46"
            y="51"
            textAnchor="middle"
            style={{ fill: '#e5e7eb', fontSize: '18px', fontWeight: 700 }}
          >
            {gauge.score}
          </text>
        </svg>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
          <Metric label="BPM" value={snapshot.current?.bpm ?? '—'} />
          <Metric label="HRV" value={snapshot.current?.hrv ?? '—'} />
          <Metric
            label="Motion"
            value={`${Math.round((snapshot.current?.movement ?? snapshot.movementAverage) * 100)}%`}
          />
        </div>
      </div>
    </section>
  );
}

interface MetricProps {
  label: string;
  value: string | number;
}

function Metric({ label, value }: MetricProps): ReactElement {
  return (
    <div
      style={{
        border: '1px solid #263043',
        borderRadius: 8,
        padding: '6px 4px',
        background: '#11182780',
        textAlign: 'center',
      }}
    >
      <div style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 700 }}>{value}</div>
      <div
        style={{
          fontSize: 9,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        }}
      >
        {label}
      </div>
    </div>
  );
}

export default SyncDashboard;

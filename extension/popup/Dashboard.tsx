/**
 * Dashboard.tsx - React 9-app grid dashboard for the popup / side panel.
 *
 * Renders the Quantbrowse AI control surface: a 9-tile grid of quick actions
 * (the "Quant" app launcher), a live queue / activity panel showing the
 * SwarmCoordinator state, and a recent-tasks list pulled from chrome.storage.
 *
 * Communicates with the background SwarmCoordinator via chrome.runtime
 * messages (`GET_QUEUE_STATE`, `GET_TASK_HISTORY`, `EXECUTE_COMMAND`).
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { SyncDashboard } from './SyncDashboard';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AppTile {
  id: string;
  label: string;
  icon: string;
  command: string;
  description: string;
  accent: string;
}

export interface QueueSnapshot {
  running: number;
  queued: number;
  totalProcessed: number;
}

export interface TaskHistoryEntry {
  id: string;
  command: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface DashboardProps {
  /** Override the message transport (used in tests). */
  sendMessage?: (msg: unknown) => Promise<unknown>;
  /** Override the polling interval in ms. */
  pollIntervalMs?: number;
  /** Optional override of the tiles (defaults to the built-in 9). */
  tiles?: AppTile[];
}

// ─── Default tile catalog ───────────────────────────────────────────────────

export const DEFAULT_TILES: AppTile[] = [
  {
    id: 'summarize',
    label: 'Summarize',
    icon: '📝',
    command: 'summarize_page',
    description: 'Condense the current page into key points',
    accent: '#6366f1',
  },
  {
    id: 'extract-emails',
    label: 'Extract Emails',
    icon: '✉️',
    command: 'extract_emails',
    description: 'Pull every email address from the page',
    accent: '#8b5cf6',
  },
  {
    id: 'find-pricing',
    label: 'Find Pricing',
    icon: '💲',
    command: 'find_pricing',
    description: 'Detect prices and currencies in the content',
    accent: '#22c55e',
  },
  {
    id: 'analyze-page',
    label: 'Analyze Page',
    icon: '🔎',
    command: 'analyze_page',
    description: 'Run structured-data + page-type analysis',
    accent: '#0ea5e9',
  },
  {
    id: 'translate',
    label: 'Translate',
    icon: '🌐',
    command: 'translate_page',
    description: 'Translate the page into your default language',
    accent: '#f97316',
  },
  {
    id: 'reading-mode',
    label: 'Reading Mode',
    icon: '📖',
    command: 'reading_mode',
    description: 'Strip clutter and focus on the article body',
    accent: '#facc15',
  },
  {
    id: 'screenshot',
    label: 'Screenshot',
    icon: '📸',
    command: 'capture_screenshot',
    description: 'Capture the visible viewport',
    accent: '#ec4899',
  },
  {
    id: 'history',
    label: 'History',
    icon: '🕘',
    command: 'open_history',
    description: 'Browse previous AI tasks',
    accent: '#a855f7',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: '⚙️',
    command: 'open_settings',
    description: 'Configure API endpoint and preferences',
    accent: '#64748b',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function defaultSendMessage(msg: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('chrome.runtime.sendMessage unavailable'));
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, (response: unknown) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message ?? 'runtime error'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function statusColor(status: TaskHistoryEntry['status']): string {
  switch (status) {
    case 'completed':
      return '#22c55e';
    case 'failed':
      return '#ef4444';
    case 'cancelled':
      return '#94a3b8';
    case 'running':
      return '#0ea5e9';
    case 'queued':
    default:
      return '#facc15';
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function Dashboard(props: DashboardProps = {}): ReactElement {
  const sendMessage = props.sendMessage ?? defaultSendMessage;
  const pollMs = props.pollIntervalMs ?? 2000;
  const tiles = props.tiles ?? DEFAULT_TILES;

  const [queue, setQueue] = useState<QueueSnapshot>({
    running: 0,
    queued: 0,
    totalProcessed: 0,
  });
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyTile, setBusyTile] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  const refresh = useCallback(async () => {
    try {
      const queueResp = (await sendMessage({ type: 'GET_QUEUE_STATE' })) as
        | { success?: boolean; data?: { running?: unknown[]; queued?: unknown[]; totalProcessed?: number } }
        | undefined;
      if (queueResp?.success && queueResp.data) {
        setQueue({
          running: queueResp.data.running?.length ?? 0,
          queued: queueResp.data.queued?.length ?? 0,
          totalProcessed: queueResp.data.totalProcessed ?? 0,
        });
      }
      const histResp = (await sendMessage({ type: 'GET_TASK_HISTORY' })) as
        | { success?: boolean; data?: { tasks?: TaskHistoryEntry[] } }
        | undefined;
      if (histResp?.success && histResp.data?.tasks) {
        setHistory(histResp.data.tasks.slice(0, 5));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sendMessage]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  const onTileClick = useCallback(
    async (tile: AppTile) => {
      setBusyTile(tile.id);
      try {
        await sendMessage({
          type: 'EXECUTE_COMMAND',
          payload: { command: tile.command },
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyTile(null);
      }
    },
    [sendMessage, refresh]
  );

  const containerStyle = useMemo<React.CSSProperties>(
    () => ({
      width: 380,
      minHeight: 480,
      background: '#0f0f13',
      color: '#e8e8f0',
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      padding: 16,
      boxSizing: 'border-box',
    }),
    []
  );

  return (
    <div style={containerStyle} data-testid="qb-dashboard">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          🤖
        </div>
        <h1 style={{ fontSize: 14, fontWeight: 600, color: '#c4c4d4', margin: 0 }}>
          Quantbrowse AI
        </h1>
      </header>

      <SyncDashboard />

      <section
        aria-label="Quant apps"
        data-testid="qb-tiles"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          marginBottom: 16,
        }}
      >
        {tiles.map((tile) => {
          const busy = busyTile === tile.id;
          return (
            <button
              key={tile.id}
              type="button"
              data-testid={`qb-tile-${tile.id}`}
              aria-label={tile.label}
              title={tile.description}
              disabled={busy}
              onClick={() => void onTileClick(tile)}
              style={{
                background: '#1a1a24',
                border: `1px solid ${busy ? tile.accent : '#2a2a3c'}`,
                borderRadius: 10,
                padding: '12px 6px',
                color: '#e8e8f0',
                cursor: busy ? 'progress' : 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontWeight: 500,
                transition: 'border-color 0.15s, transform 0.05s',
              }}
            >
              <span style={{ fontSize: 22, lineHeight: 1 }}>{tile.icon}</span>
              <span>{tile.label}</span>
            </button>
          );
        })}
      </section>

      <section
        data-testid="qb-queue"
        aria-label="Queue status"
        style={{
          display: 'flex',
          gap: 6,
          marginBottom: 14,
        }}
      >
        <Stat label="Running" value={queue.running} accent="#0ea5e9" />
        <Stat label="Queued" value={queue.queued} accent="#facc15" />
        <Stat label="Done" value={queue.totalProcessed} accent="#22c55e" />
      </section>

      <section aria-label="Recent tasks" data-testid="qb-history">
        <h2
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            color: '#7c7c9c',
            marginBottom: 6,
          }}
        >
          Recent Tasks
        </h2>
        {history.length === 0 ? (
          <p style={{ fontSize: 12, color: '#4a4a6a', margin: 0 }}>
            No tasks yet — pick an action above to get started.
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {history.map((task) => (
              <li
                key={task.id}
                data-testid={`qb-history-${task.id}`}
                style={{
                  background: '#1a1a24',
                  border: '1px solid #2a2a3c',
                  borderRadius: 8,
                  padding: '8px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: statusColor(task.status),
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, color: '#d4d4e8' }}>{task.command}</span>
                <span style={{ color: '#7c7c9c', fontSize: 11 }}>
                  {formatRelative(task.completedAt ?? task.createdAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <p
          role="alert"
          data-testid="qb-error"
          style={{
            marginTop: 12,
            color: '#f87171',
            fontSize: 12,
            background: '#1c1010',
            border: '1px solid #3d1a1a',
            borderRadius: 8,
            padding: '8px 10px',
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

interface StatProps {
  label: string;
  value: number;
  accent: string;
}

function Stat({ label, value, accent }: StatProps): ReactElement {
  return (
    <div
      data-testid={`qb-stat-${label.toLowerCase()}`}
      style={{
        flex: 1,
        background: '#1a1a24',
        border: '1px solid #2a2a3c',
        borderRadius: 10,
        padding: '8px 10px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, color: accent }}>{value}</div>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: '#7c7c9c',
        }}
      >
        {label}
      </div>
    </div>
  );
}

export default Dashboard;

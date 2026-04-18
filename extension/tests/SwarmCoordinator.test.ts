/**
 * SwarmCoordinator.test.ts - Unit tests for the SwarmCoordinator background service.
 *
 * Uses Vitest with a JSDOM environment. The `chrome` global is stubbed before
 * the module under test is imported (the module instantiates a singleton in
 * its top-level code, which transitively touches chrome.*).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── chrome.* mock ──────────────────────────────────────────────────────────

interface MockListener<TArgs extends unknown[] = unknown[]> {
  (...args: TArgs): void | boolean | Promise<void>;
}

interface MockEvent<TArgs extends unknown[] = unknown[]> {
  addListener: (listener: MockListener<TArgs>) => void;
  removeListener: (listener: MockListener<TArgs>) => void;
  hasListener: (listener: MockListener<TArgs>) => boolean;
  listeners: Array<MockListener<TArgs>>;
}

function createMockEvent<TArgs extends unknown[] = unknown[]>(): MockEvent<TArgs> {
  const listeners: Array<MockListener<TArgs>> = [];
  return {
    listeners,
    addListener(l) {
      listeners.push(l);
    },
    removeListener(l) {
      const idx = listeners.indexOf(l);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    hasListener(l) {
      return listeners.includes(l);
    },
  };
}

interface StorageArea {
  store: Record<string, unknown>;
  get: (
    keys?: string | string[] | Record<string, unknown> | null
  ) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
  clear: () => Promise<void>;
}

function createStorageArea(): StorageArea {
  const area: StorageArea = {
    store: {},
    async get(keys) {
      if (keys == null) return { ...area.store };
      if (typeof keys === 'string') {
        return keys in area.store ? { [keys]: area.store[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          if (k in area.store) out[k] = area.store[k];
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, def] of Object.entries(keys)) {
        out[k] = k in area.store ? area.store[k] : def;
      }
      return out;
    },
    async set(items) {
      Object.assign(area.store, items);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete area.store[k];
    },
    async clear() {
      area.store = {};
    },
  };
  return area;
}

const localStorageArea = createStorageArea();
const sessionStorageArea = createStorageArea();

const onMessageEvent = createMockEvent();
const onInstalledEvent = createMockEvent();
const onStartupEvent = createMockEvent();
const onContextMenuClickedEvent = createMockEvent();

const tabsSendMessageMock = vi.fn(async () => undefined);
const contextMenusCreateMock = vi.fn();
const contextMenusRemoveAllMock = vi.fn((cb?: () => void) => {
  if (typeof cb === 'function') cb();
});

const chromeMock = {
  runtime: {
    onMessage: onMessageEvent,
    onInstalled: onInstalledEvent,
    onStartup: onStartupEvent,
    lastError: undefined as { message?: string } | undefined,
  },
  storage: {
    local: localStorageArea,
    session: sessionStorageArea,
  },
  tabs: {
    sendMessage: tabsSendMessageMock,
  },
  contextMenus: {
    create: contextMenusCreateMock,
    removeAll: contextMenusRemoveAllMock,
    onClicked: onContextMenuClickedEvent,
  },
};

beforeAll(() => {
  (globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;
});

// ─── Module under test (lazy import) ────────────────────────────────────────

type SwarmModule = typeof import('../background/SwarmCoordinator');
let mod: SwarmModule;

beforeEach(async () => {
  // Reset all transient state between tests by clearing module cache.
  vi.resetModules();
  localStorageArea.store = {};
  sessionStorageArea.store = {};
  onMessageEvent.listeners.length = 0;
  onInstalledEvent.listeners.length = 0;
  onStartupEvent.listeners.length = 0;
  onContextMenuClickedEvent.listeners.length = 0;
  tabsSendMessageMock.mockClear();
  contextMenusCreateMock.mockClear();
  contextMenusRemoveAllMock.mockClear();
  vi.useFakeTimers();
  mod = await import('../background/SwarmCoordinator');
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function createCoordinator() {
  const c = new mod.SwarmCoordinator();
  return c;
}

function makeTask(
  c: InstanceType<SwarmModule['SwarmCoordinator']>,
  overrides: Partial<{
    command: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    payload: unknown;
    tabId: number;
    maxRetries: number;
  }> = {}
) {
  // Use the public createTask flow via enqueue(): we synthesise the task object
  // with the same shape as createTask() produces.
  const t = {
    id: `t-${Math.random().toString(36).slice(2, 10)}`,
    priority: overrides.priority ?? ('medium' as const),
    status: 'queued' as const,
    command: overrides.command ?? 'noop',
    payload: overrides.payload ?? {},
    tabId: overrides.tabId,
    retryCount: 0,
    maxRetries: overrides.maxRetries ?? 3,
    createdAt: Date.now(),
  };
  return t;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SwarmCoordinator - construction & wiring', () => {
  it('exports a singleton coordinator instance', () => {
    expect(mod.coordinator).toBeDefined();
    expect(mod.coordinator).toBeInstanceOf(mod.SwarmCoordinator);
  });

  it('registers a runtime.onMessage listener on construction', () => {
    // The singleton already added one; verify creating another adds a second.
    const before = onMessageEvent.listeners.length;
    createCoordinator();
    expect(onMessageEvent.listeners.length).toBe(before + 1);
  });

  it('registers a runtime.onInstalled listener on construction', () => {
    const before = onInstalledEvent.listeners.length;
    createCoordinator();
    expect(onInstalledEvent.listeners.length).toBe(before + 1);
  });

  it('initial queue state is empty', () => {
    const c = createCoordinator();
    const state = c.getQueueState();
    expect(state.running).toEqual([]);
    expect(state.queued).toEqual([]);
    expect(state.totalProcessed).toBe(0);
  });
});

describe('SwarmCoordinator - enqueue & priority ordering', () => {
  it('starts a task immediately when nothing is running', () => {
    const c = createCoordinator();
    const task = makeTask(c, { command: 'noop' });
    const ok = c.enqueue(task);
    expect(ok).toBe(true);
    // Task should have transitioned to running synchronously.
    expect(c.getRunningCount()).toBe(1);
  });

  it('orders the queue by priority (critical < high < medium < low)', () => {
    const c = createCoordinator();
    // Saturate the runner so subsequent enqueues land in the queue.
    for (let i = 0; i < 50; i++) {
      c.enqueue(makeTask(c, { command: 'fill' }));
    }
    expect(c.getRunningCount()).toBe(50);

    const low = makeTask(c, { command: 'low', priority: 'low' });
    const critical = makeTask(c, { command: 'critical', priority: 'critical' });
    const medium = makeTask(c, { command: 'medium', priority: 'medium' });
    const high = makeTask(c, { command: 'high', priority: 'high' });
    c.enqueue(low);
    c.enqueue(critical);
    c.enqueue(medium);
    c.enqueue(high);

    const queued = c.getQueueState().queued;
    const order = queued.slice(0, 4).map((t) => t.command);
    expect(order).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('runs up to MAX_CONCURRENT_TASKS (50) before queueing', () => {
    const c = createCoordinator();
    for (let i = 0; i < 49; i++) c.enqueue(makeTask(c, { command: `t${i}` }));
    expect(c.getRunningCount()).toBe(49);
    expect(c.getQueueLength()).toBe(0);
    c.enqueue(makeTask(c, { command: 't49' }));
    expect(c.getRunningCount()).toBe(50);
    expect(c.getQueueLength()).toBe(0);
    // Saturated; the next enqueue must go to the queue.
    c.enqueue(makeTask(c, { command: 't50' }));
    expect(c.getRunningCount()).toBe(50);
    expect(c.getQueueLength()).toBe(1);
  });
});

describe('SwarmCoordinator - cancellation', () => {
  it('cancels a queued task and removes it from the queue', () => {
    const c = createCoordinator();
    // Saturate runner.
    for (let i = 0; i < 50; i++) c.enqueue(makeTask(c, { command: 'fill' }));
    const queued = makeTask(c, { command: 'pending' });
    c.enqueue(queued);
    expect(c.getQueueLength()).toBe(1);
    const ok = c.cancelTask(queued.id);
    expect(ok).toBe(true);
    expect(c.getQueueLength()).toBe(0);
  });

  it('marks a running task as cancelled (does not remove from running map)', () => {
    const c = createCoordinator();
    const t = makeTask(c, { command: 'long' });
    c.enqueue(t);
    expect(c.getRunningCount()).toBe(1);
    const ok = c.cancelTask(t.id);
    expect(ok).toBe(true);
    const state = c.getQueueState();
    const running = state.running.find((r) => r.id === t.id);
    expect(running?.status).toBe('cancelled');
  });

  it('returns false when cancelling a non-existent task', () => {
    const c = createCoordinator();
    expect(c.cancelTask('does-not-exist')).toBe(false);
  });
});

describe('SwarmCoordinator - message routing', () => {
  function dispatch(message: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const listener = onMessageEvent.listeners[onMessageEvent.listeners.length - 1];
      const sendResponse = (resp: unknown) => resolve(resp);
      listener(message, { tab: { id: 7 } }, sendResponse);
    });
  }

  it('responds to PING with pong', async () => {
    createCoordinator();
    const resp = (await dispatch({ type: 'PING' })) as { success: boolean; data: string };
    expect(resp.success).toBe(true);
    expect(resp.data).toBe('pong');
  });

  it('returns an error for unknown message types', async () => {
    createCoordinator();
    const resp = (await dispatch({ type: 'WHO_KNOWS' })) as {
      success: boolean;
      error: string;
    };
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/Unknown message type/);
  });

  it('CHAT_MESSAGE enqueues a chat task and returns a taskId', async () => {
    const c = createCoordinator();
    const before = c.getRunningCount() + c.getQueueLength();
    const resp = (await dispatch({
      type: 'CHAT_MESSAGE',
      payload: { message: 'hello' },
    })) as { success: boolean; taskId?: string };
    expect(resp.success).toBe(true);
    expect(typeof resp.taskId).toBe('string');
    expect(c.getRunningCount() + c.getQueueLength()).toBe(before + 1);
  });

  it('GET_QUEUE_STATE returns a snapshot of the queue', async () => {
    createCoordinator();
    const resp = (await dispatch({ type: 'GET_QUEUE_STATE' })) as {
      success: boolean;
      data: { running: unknown[]; queued: unknown[]; totalProcessed: number };
    };
    expect(resp.success).toBe(true);
    expect(Array.isArray(resp.data.running)).toBe(true);
    expect(Array.isArray(resp.data.queued)).toBe(true);
    expect(typeof resp.data.totalProcessed).toBe('number');
  });

  it('CANCEL_TASK with no taskId returns an error', async () => {
    createCoordinator();
    const resp = (await dispatch({ type: 'CANCEL_TASK' })) as {
      success: boolean;
      error: string;
    };
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/No taskId/);
  });
});

describe('SwarmCoordinator - persistence', () => {
  it('persists task history to chrome.storage.local after a task completes', async () => {
    const c = createCoordinator();
    const t = makeTask(c, { command: 'noop' });
    c.enqueue(t);
    // Allow the executeTask delay (50ms) to elapse.
    await vi.advanceTimersByTimeAsync(200);
    // Drain microtasks that resolved persistHistory().
    await Promise.resolve();
    await Promise.resolve();
    const stored = localStorageArea.store.taskHistory as
      | { tasks: Array<{ id: string }>; lastUpdated: number }
      | undefined;
    expect(stored).toBeDefined();
    expect(stored!.tasks.some((x) => x.id === t.id)).toBe(true);
  });

  it('GET_TASK_HISTORY reads from chrome.storage.local', async () => {
    createCoordinator();
    await localStorageArea.set({
      taskHistory: { tasks: [{ id: 'h1', command: 'x' }], lastUpdated: 42 },
    });
    const listener = onMessageEvent.listeners[onMessageEvent.listeners.length - 1];
    const resp: unknown = await new Promise((resolve) => {
      listener({ type: 'GET_TASK_HISTORY' }, { tab: { id: 1 } }, (r: unknown) => resolve(r));
    });
    expect(resp).toMatchObject({
      success: true,
      data: { tasks: [{ id: 'h1', command: 'x' }], lastUpdated: 42 },
    });
  });

  it('CLEAR_HISTORY empties the persisted history', async () => {
    createCoordinator();
    await localStorageArea.set({
      taskHistory: { tasks: [{ id: 'old' }], lastUpdated: 0 },
    });
    const listener = onMessageEvent.listeners[onMessageEvent.listeners.length - 1];
    await new Promise<void>((resolve) => {
      listener({ type: 'CLEAR_HISTORY' }, { tab: { id: 1 } }, () => resolve());
    });
    const stored = localStorageArea.store.taskHistory as { tasks: unknown[] };
    expect(stored.tasks).toEqual([]);
  });
});

describe('SwarmCoordinator - retry & failure handling', () => {
  it('retries a failed task with exponential backoff up to maxRetries', async () => {
    const c = createCoordinator();
    // Inject a failing command by replacing executeTask via prototype patch.
    const proto = Object.getPrototypeOf(c) as Record<string, unknown>;
    const originalExecute = proto.executeTask as (
      this: unknown,
      task: { command: string }
    ) => Promise<unknown>;
    let calls = 0;
    proto.executeTask = async function (task: { command: string }) {
      if (task.command === 'flaky') {
        calls++;
        throw new Error('boom');
      }
      return originalExecute.call(this, task);
    };

    try {
      const t = makeTask(c, { command: 'flaky', maxRetries: 2 });
      c.enqueue(t);
      // Initial attempt resolves.
      await vi.advanceTimersByTimeAsync(50);
      expect(calls).toBe(1);
      // First retry after ~1000ms.
      await vi.advanceTimersByTimeAsync(1100);
      expect(calls).toBe(2);
      // Second retry after ~2000ms.
      await vi.advanceTimersByTimeAsync(2100);
      expect(calls).toBe(3);
      // No further retries.
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(3);
    } finally {
      proto.executeTask = originalExecute as unknown as typeof proto.executeTask;
    }
  });
});

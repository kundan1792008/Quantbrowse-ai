/**
 * SwarmCoordinator.ts - Background service worker for Quantbrowse AI.
 * Manages task queues, message routing, context menu integration, and
 * cross-tab state synchronization.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface Task {
  id: string;
  priority: TaskPriority;
  status: TaskStatus;
  command: string;
  payload: unknown;
  tabId?: number;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
}

interface QueueState {
  running: Task[];
  queued: Task[];
  totalProcessed: number;
  lastUpdated: number;
}

interface MessagePayload {
  [key: string]: unknown;
}

interface ExtensionMessage {
  type: string;
  payload?: MessagePayload;
  taskId?: string;
  tabId?: number;
}

interface MessageSender {
  tab?: chrome.tabs.Tab;
  frameId?: number;
  id?: string;
  url?: string;
  tlsChannelId?: string;
}

type SendResponse = (response: unknown) => void;

interface StorageTaskHistory {
  tasks: Task[];
  lastUpdated: number;
}

interface CrossTabState {
  activeTasks: number;
  queueLength: number;
  lastActivity: number;
  tabStates: Record<string, TabState>;
}

interface TabState {
  tabId: number;
  url: string;
  isAnalyzed: boolean;
  lastActivity: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_CONCURRENT_TASKS = 50;
const MAX_QUEUE_SIZE = 200;
const MAX_HISTORY_SIZE = 1000;
const RETRY_BASE_DELAY_MS = 1000;
const QUEUE_DRAIN_INTERVAL_MS = 250;
const STATE_SYNC_INTERVAL_MS = 5000;

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ─── SwarmCoordinator ────────────────────────────────────────────────────────

class SwarmCoordinator {
  private running: Map<string, Task> = new Map();
  private queue: Task[] = [];
  private history: Task[] = [];
  private totalProcessed = 0;
  private drainIntervalId: ReturnType<typeof setInterval> | null = null;
  private syncIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.init();
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  private init(): void {
    this.registerMessageListener();
    this.registerInstallListener();
    this.registerContextMenus();
    this.startDrainLoop();
    this.startSyncLoop();
    this.loadHistoryFromStorage();
    this.restoreQueueFromStorage();
    console.log('[SwarmCoordinator] Initialized');
  }

  private registerMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (message: ExtensionMessage, sender: MessageSender, sendResponse: SendResponse): boolean => {
        this.handleMessage(message, sender, sendResponse);
        return true; // keep channel open for async responses
      }
    );
  }

  private registerInstallListener(): void {
    chrome.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install') {
        this.setupContextMenus();
        this.initStorage();
      } else if (details.reason === 'update') {
        this.setupContextMenus();
      }
    });
  }

  private registerContextMenus(): void {
    // Chrome fires onInstalled before service worker runs fully, so also set up on startup.
    chrome.runtime.onStartup?.addListener(() => {
      this.setupContextMenus();
    });
  }

  private setupContextMenus(): void {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'qb-summarize',
        title: 'Summarize this page with Quantbrowse AI',
        contexts: ['page'],
      });
      chrome.contextMenus.create({
        id: 'qb-extract-emails',
        title: 'Extract emails from this page',
        contexts: ['page'],
      });
      chrome.contextMenus.create({
        id: 'qb-analyze-selection',
        title: 'Analyze selected text',
        contexts: ['selection'],
      });
      chrome.contextMenus.create({
        id: 'qb-find-pricing',
        title: 'Find pricing info',
        contexts: ['page'],
      });
      chrome.contextMenus.onClicked.addListener((info, tab) => {
        this.handleContextMenuClick(info, tab);
      });
    });
  }

  private async initStorage(): Promise<void> {
    await chrome.storage.local.set({ taskHistory: { tasks: [], lastUpdated: Date.now() } });
    await chrome.storage.session.set({ crossTabState: this.buildCrossTabState() });
  }

  // ─── Message Routing ──────────────────────────────────────────────────────

  private async handleMessage(
    message: ExtensionMessage,
    sender: MessageSender,
    sendResponse: SendResponse
  ): Promise<void> {
    const tabId = sender.tab?.id;
    try {
      switch (message.type) {
        case 'CHAT_MESSAGE':
          await this.handleChatMessage(message, tabId, sendResponse);
          break;
        case 'EXECUTE_COMMAND':
          await this.handleExecuteCommand(message, tabId, sendResponse);
          break;
        case 'GET_QUEUE_STATE':
          sendResponse({ success: true, data: this.getQueueState() });
          break;
        case 'CANCEL_TASK':
          await this.handleCancelTask(message, sendResponse);
          break;
        case 'GET_TASK_HISTORY':
          await this.handleGetTaskHistory(sendResponse);
          break;
        case 'CLEAR_HISTORY':
          await this.clearHistory(sendResponse);
          break;
        case 'PAGE_ANALYSIS_RESULT':
          await this.handlePageAnalysisResult(message, tabId, sendResponse);
          break;
        case 'PING':
          sendResponse({ success: true, data: 'pong', timestamp: Date.now() });
          break;
        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error(`[SwarmCoordinator] Error handling ${message.type}:`, err);
      sendResponse({ success: false, error: String(err) });
    }
  }

  private async handleChatMessage(
    message: ExtensionMessage,
    tabId: number | undefined,
    sendResponse: SendResponse
  ): Promise<void> {
    const task = this.createTask({
      command: 'chat',
      priority: 'high',
      payload: message.payload ?? {},
      tabId,
    });
    this.enqueue(task);
    sendResponse({ success: true, data: `Task ${task.id} queued`, taskId: task.id });
  }

  private async handleExecuteCommand(
    message: ExtensionMessage,
    tabId: number | undefined,
    sendResponse: SendResponse
  ): Promise<void> {
    const cmd = (message.payload as MessagePayload)?.command as string | undefined;
    const priority: TaskPriority = cmd === 'summarize_page' ? 'high' : 'medium';
    const task = this.createTask({
      command: cmd ?? 'unknown',
      priority,
      payload: message.payload ?? {},
      tabId,
    });
    this.enqueue(task);
    sendResponse({ success: true, taskId: task.id });
  }

  private async handleCancelTask(
    message: ExtensionMessage,
    sendResponse: SendResponse
  ): Promise<void> {
    const taskId = message.taskId;
    if (!taskId) { sendResponse({ success: false, error: 'No taskId provided' }); return; }
    const cancelled = this.cancelTask(taskId);
    sendResponse({ success: cancelled, data: cancelled ? 'Task cancelled' : 'Task not found or already complete' });
  }

  private async handleGetTaskHistory(sendResponse: SendResponse): Promise<void> {
    const result = await chrome.storage.local.get('taskHistory') as { taskHistory?: StorageTaskHistory };
    sendResponse({ success: true, data: result.taskHistory ?? { tasks: [], lastUpdated: 0 } });
  }

  private async handlePageAnalysisResult(
    message: ExtensionMessage,
    tabId: number | undefined,
    sendResponse: SendResponse
  ): Promise<void> {
    const task = this.createTask({
      command: 'store_analysis',
      priority: 'low',
      payload: { ...((message.payload as MessagePayload) ?? {}), tabId },
      tabId,
    });
    this.enqueue(task);
    sendResponse({ success: true, taskId: task.id });
    if (tabId != null) {
      await this.updateTabState(tabId, { isAnalyzed: true, lastActivity: Date.now() });
    }
  }

  private handleContextMenuClick(
    info: chrome.contextMenus.OnClickData,
    tab?: chrome.tabs.Tab
  ): void {
    if (!tab?.id) return;
    const commandMap: Record<string, string> = {
      'qb-summarize': 'summarize_page',
      'qb-extract-emails': 'extract_emails',
      'qb-find-pricing': 'find_pricing',
      'qb-analyze-selection': 'analyze_selection',
    };
    const command = commandMap[info.menuItemId as string];
    if (!command) return;
    const task = this.createTask({
      command,
      priority: 'high',
      payload: { selectionText: info.selectionText ?? '', url: info.pageUrl },
      tabId: tab.id,
    });
    this.enqueue(task);
    chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_COMMAND',
      payload: { command, taskId: task.id },
    }).catch(() => {/* tab may not have content script */});
  }

  // ─── Task Management ──────────────────────────────────────────────────────

  private createTask(opts: {
    command: string;
    priority: TaskPriority;
    payload: unknown;
    tabId?: number;
    maxRetries?: number;
  }): Task {
    return {
      id: this.generateId(),
      priority: opts.priority,
      status: 'queued',
      command: opts.command,
      payload: opts.payload,
      tabId: opts.tabId,
      retryCount: 0,
      maxRetries: opts.maxRetries ?? 3,
      createdAt: Date.now(),
    };
  }

  enqueue(task: Task): boolean {
    if (this.running.size >= MAX_CONCURRENT_TASKS) {
      // Try to fit in queue; if full, drop lowest priority
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        const lowestIdx = this.findLowestPriorityIndex();
        if (lowestIdx === -1) return false;
        const dropped = this.queue[lowestIdx];
        if (PRIORITY_ORDER[dropped.priority] <= PRIORITY_ORDER[task.priority]) {
          // Incoming task is lower or equal priority — discard it
          return false;
        }
        // Drop the lowest-priority queued task to make room
        dropped.status = 'cancelled';
        this.addToHistory(dropped);
        this.queue.splice(lowestIdx, 1);
      }
      this.queue.push(task);
      this.sortQueue();
      return true;
    }
    // Can run immediately
    if (this.queue.length === 0) {
      this.startTask(task);
    } else {
      this.queue.push(task);
      this.sortQueue();
    }
    return true;
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pDiff !== 0) return pDiff;
      return a.createdAt - b.createdAt;
    });
  }

  private findLowestPriorityIndex(): number {
    if (this.queue.length === 0) return -1;
    let lowestIdx = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (PRIORITY_ORDER[this.queue[i].priority] > PRIORITY_ORDER[this.queue[lowestIdx].priority]) {
        lowestIdx = i;
      } else if (
        PRIORITY_ORDER[this.queue[i].priority] === PRIORITY_ORDER[this.queue[lowestIdx].priority] &&
        this.queue[i].createdAt < this.queue[lowestIdx].createdAt
      ) {
        lowestIdx = i;
      }
    }
    return lowestIdx;
  }

  private startTask(task: Task): void {
    task.status = 'running';
    task.startedAt = Date.now();
    this.running.set(task.id, task);
    this.executeTask(task).then(result => {
      this.completeTask(task.id, result);
    }).catch(err => {
      this.failTask(task.id, String(err));
    });
  }

  private async executeTask(task: Task): Promise<unknown> {
    switch (task.command) {
      case 'chat':
        return this.executeChatTask(task);
      case 'summarize_page':
        return this.executeSummarizeTask(task);
      case 'extract_emails':
        return this.executeExtractEmailsTask(task);
      case 'find_pricing':
        return this.executeFindPricingTask(task);
      case 'analyze_selection':
        return this.executeAnalyzeSelectionTask(task);
      case 'store_analysis':
        return this.executeStoreAnalysisTask(task);
      default:
        return { message: `Command "${task.command}" executed (no-op)` };
    }
  }

  private async executeChatTask(task: Task): Promise<unknown> {
    const payload = task.payload as MessagePayload;
    const message = payload?.message as string ?? '';
    // In production, this would call an AI API endpoint. Returning a simulated response.
    await this.delay(50);
    return { reply: `Processed: "${message.slice(0, 80)}"`, tabId: task.tabId };
  }

  private async executeSummarizeTask(task: Task): Promise<unknown> {
    if (!task.tabId) return { error: 'No tabId provided' };
    await this.delay(30);
    return { command: 'summarize_page', tabId: task.tabId, status: 'dispatched' };
  }

  private async executeExtractEmailsTask(task: Task): Promise<unknown> {
    if (!task.tabId) return { error: 'No tabId provided' };
    await this.delay(30);
    return { command: 'extract_emails', tabId: task.tabId, status: 'dispatched' };
  }

  private async executeFindPricingTask(task: Task): Promise<unknown> {
    if (!task.tabId) return { error: 'No tabId provided' };
    await this.delay(30);
    return { command: 'find_pricing', tabId: task.tabId, status: 'dispatched' };
  }

  private async executeAnalyzeSelectionTask(task: Task): Promise<unknown> {
    const payload = task.payload as MessagePayload;
    const selectionText = payload?.selectionText as string ?? '';
    await this.delay(30);
    return { analyzed: selectionText.slice(0, 200), wordCount: selectionText.split(/\s+/).filter(Boolean).length };
  }

  private async executeStoreAnalysisTask(task: Task): Promise<unknown> {
    await this.persistAnalysis(task.payload);
    return { stored: true };
  }

  cancelTask(taskId: string): boolean {
    // Cancel from queue
    const queueIdx = this.queue.findIndex(t => t.id === taskId);
    if (queueIdx >= 0) {
      const task = this.queue[queueIdx];
      task.status = 'cancelled';
      task.completedAt = Date.now();
      this.queue.splice(queueIdx, 1);
      this.addToHistory(task);
      return true;
    }
    // Running tasks can be "cancelled" (mark for cancellation; execution continues)
    const running = this.running.get(taskId);
    if (running) {
      running.status = 'cancelled';
      return true;
    }
    return false;
  }

  private completeTask(taskId: string, result: unknown): void {
    const task = this.running.get(taskId);
    if (!task) return;
    if (task.status !== 'cancelled') {
      task.status = 'completed';
    }
    task.result = result;
    task.completedAt = Date.now();
    this.running.delete(taskId);
    this.addToHistory(task);
    this.totalProcessed++;
    this.notifyTaskComplete(task);
    this.drainNext();
  }

  private failTask(taskId: string, error: string): void {
    const task = this.running.get(taskId);
    if (!task) return;
    task.error = error;
    this.running.delete(taskId);

    if (task.retryCount < task.maxRetries) {
      task.retryCount++;
      task.status = 'queued';
      const backoffMs = RETRY_BASE_DELAY_MS * Math.pow(2, task.retryCount - 1);
      console.warn(`[SwarmCoordinator] Task ${task.id} failed, retrying in ${backoffMs}ms (attempt ${task.retryCount}/${task.maxRetries})`);
      setTimeout(() => {
        this.enqueue(task);
      }, backoffMs);
    } else {
      task.status = 'failed';
      task.completedAt = Date.now();
      this.addToHistory(task);
      this.totalProcessed++;
      this.notifyTaskFailed(task);
      this.drainNext();
    }
  }

  private drainNext(): void {
    if (this.queue.length === 0) return;
    if (this.running.size >= MAX_CONCURRENT_TASKS) return;
    const next = this.queue.shift();
    if (next) this.startTask(next);
  }

  private startDrainLoop(): void {
    this.drainIntervalId = setInterval(() => {
      while (this.queue.length > 0 && this.running.size < MAX_CONCURRENT_TASKS) {
        const next = this.queue.shift();
        if (next) this.startTask(next);
      }
    }, QUEUE_DRAIN_INTERVAL_MS);
  }

  // ─── Notifications ────────────────────────────────────────────────────────

  private notifyTaskComplete(task: Task): void {
    if (!task.tabId) return;
    chrome.tabs.sendMessage(task.tabId, {
      type: 'TASK_COMPLETE',
      payload: { taskId: task.id, result: task.result },
    }).catch(() => {/* tab may be closed */});
  }

  private notifyTaskFailed(task: Task): void {
    if (!task.tabId) return;
    chrome.tabs.sendMessage(task.tabId, {
      type: 'TASK_FAILED',
      payload: { taskId: task.id, error: task.error },
    }).catch(() => {/* tab may be closed */});
  }

  // ─── History & Persistence ────────────────────────────────────────────────

  private addToHistory(task: Task): void {
    this.history.unshift(task);
    if (this.history.length > MAX_HISTORY_SIZE) {
      this.history = this.history.slice(0, MAX_HISTORY_SIZE);
    }
    this.persistHistory();
  }

  private async persistHistory(): Promise<void> {
    const historyData: StorageTaskHistory = {
      tasks: this.history.slice(0, MAX_HISTORY_SIZE),
      lastUpdated: Date.now(),
    };
    await chrome.storage.local.set({ taskHistory: historyData });
  }

  private async loadHistoryFromStorage(): Promise<void> {
    try {
      const result = await chrome.storage.local.get('taskHistory') as { taskHistory?: StorageTaskHistory };
      if (result.taskHistory?.tasks) {
        this.history = result.taskHistory.tasks;
      }
    } catch (err) {
      console.warn('[SwarmCoordinator] Failed to load history:', err);
    }
  }

  private async restoreQueueFromStorage(): Promise<void> {
    // On service worker restart, we don't restore running tasks (they're lost).
    // We only restore queued tasks that were persisted.
    try {
      const result = await chrome.storage.local.get('pendingQueue') as { pendingQueue?: Task[] };
      if (result.pendingQueue && Array.isArray(result.pendingQueue)) {
        for (const task of result.pendingQueue) {
          task.status = 'queued';
          task.retryCount = 0;
          this.enqueue(task);
        }
        await chrome.storage.local.remove('pendingQueue');
      }
    } catch (err) {
      console.warn('[SwarmCoordinator] Failed to restore queue:', err);
    }
  }

  private async persistAnalysis(payload: unknown): Promise<void> {
    try {
      const existing = await chrome.storage.local.get('pageAnalyses') as { pageAnalyses?: unknown[] };
      const analyses = existing.pageAnalyses ?? [];
      (analyses as unknown[]).unshift({ ...((payload as Record<string, unknown>) ?? {}), savedAt: Date.now() });
      const trimmed = (analyses as unknown[]).slice(0, 100);
      await chrome.storage.local.set({ pageAnalyses: trimmed });
    } catch (err) {
      console.warn('[SwarmCoordinator] Failed to persist analysis:', err);
    }
  }

  private async clearHistory(sendResponse: SendResponse): Promise<void> {
    this.history = [];
    await chrome.storage.local.set({ taskHistory: { tasks: [], lastUpdated: Date.now() } });
    sendResponse({ success: true });
  }

  // ─── Cross-Tab State Sync ─────────────────────────────────────────────────

  private startSyncLoop(): void {
    this.syncIntervalId = setInterval(() => {
      this.syncCrossTabState().catch(err =>
        console.warn('[SwarmCoordinator] State sync failed:', err)
      );
    }, STATE_SYNC_INTERVAL_MS);
  }

  private async syncCrossTabState(): Promise<void> {
    const state = this.buildCrossTabState();
    await chrome.storage.session.set({ crossTabState: state });
  }

  private buildCrossTabState(): CrossTabState {
    return {
      activeTasks: this.running.size,
      queueLength: this.queue.length,
      lastActivity: Date.now(),
      tabStates: {},
    };
  }

  private async updateTabState(tabId: number, update: Partial<TabState>): Promise<void> {
    try {
      const result = await chrome.storage.session.get('crossTabState') as { crossTabState?: CrossTabState };
      const state: CrossTabState = result.crossTabState ?? this.buildCrossTabState();
      const existing = state.tabStates[tabId] ?? { tabId, url: '', isAnalyzed: false, lastActivity: 0 };
      state.tabStates[tabId] = { ...existing, ...update, tabId };
      await chrome.storage.session.set({ crossTabState: state });
    } catch (err) {
      console.warn('[SwarmCoordinator] Failed to update tab state:', err);
    }
  }

  // ─── Queue State ─────────────────────────────────────────────────────────

  getQueueState(): QueueState {
    return {
      running: Array.from(this.running.values()),
      queued: [...this.queue],
      totalProcessed: this.totalProcessed,
      lastUpdated: Date.now(),
    };
  }

  getRunningCount(): number { return this.running.size; }
  getQueueLength(): number { return this.queue.length; }
  getHistoryLength(): number { return this.history.length; }

  // ─── Utilities ────────────────────────────────────────────────────────────

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  destroy(): void {
    if (this.drainIntervalId) clearInterval(this.drainIntervalId);
    if (this.syncIntervalId) clearInterval(this.syncIntervalId);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

const coordinator = new SwarmCoordinator();

// Export for testing
export { SwarmCoordinator, coordinator };
export type {
  Task,
  TaskPriority,
  TaskStatus,
  QueueState,
  ExtensionMessage,
  CrossTabState,
  TabState,
  MessagePayload,
};

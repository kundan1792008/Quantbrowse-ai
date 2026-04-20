/**
 * AIAssistant.ts - Content script AI chat assistant injected into every page.
 * Uses Shadow DOM for full CSS isolation and communicates with the background
 * service worker via chrome.runtime.sendMessage.
 */

import { ActionPreloader, type PredictedAction } from '../services/ActionPreloader';
import { BehaviorTelemetry } from '../services/BehaviorTelemetry';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  actions?: SuggestedAction[];
}

interface SuggestedAction {
  id: string;
  label: string;
  command: string;
}

interface PageContext {
  url: string;
  title: string;
  summary: string;
  wordCount: number;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  emails: string[];
  prices: string[];
}

interface BackgroundRequest {
  type: string;
  payload: unknown;
}

interface BackgroundResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  initialLeft: number;
  initialTop: number;
}

type PanelState = 'bubble' | 'panel' | 'minimized';

const BUBBLE_SIZE = 56;
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 560;
const Z_INDEX = 2147483647;

const STYLES = `
  :host {
    all: initial;
    position: fixed;
    z-index: ${Z_INDEX};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  #qb-bubble {
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: ${BUBBLE_SIZE}px;
    height: ${BUBBLE_SIZE}px;
    border-radius: 50%;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 20px rgba(99,102,241,0.5);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    user-select: none;
    z-index: ${Z_INDEX};
  }

  #qb-bubble:hover {
    transform: scale(1.1);
    box-shadow: 0 6px 28px rgba(99,102,241,0.7);
  }

  #qb-bubble svg {
    width: 26px;
    height: 26px;
    fill: #fff;
    pointer-events: none;
  }

  #qb-panel {
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: ${PANEL_WIDTH}px;
    height: ${PANEL_HEIGHT}px;
    background: #0f0f11;
    border-radius: 16px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: ${Z_INDEX};
    border: 1px solid rgba(255,255,255,0.08);
    transition: opacity 0.2s ease, transform 0.2s ease;
  }

  #qb-panel.hidden {
    opacity: 0;
    pointer-events: none;
    transform: translateY(12px);
  }

  #qb-header {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    padding: 14px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
  }

  #qb-header:active { cursor: grabbing; }

  #qb-header-title {
    color: #fff;
    font-weight: 700;
    font-size: 15px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  #qb-header-title svg {
    width: 18px;
    height: 18px;
    fill: rgba(255,255,255,0.9);
  }

  #qb-header-controls {
    display: flex;
    gap: 6px;
  }

  .qb-ctrl-btn {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255,255,255,0.15);
    transition: background 0.15s ease;
  }

  .qb-ctrl-btn:hover { background: rgba(255,255,255,0.3); }
  .qb-ctrl-btn svg { width: 14px; height: 14px; fill: #fff; }

  #qb-messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.15) transparent;
  }

  #qb-messages::-webkit-scrollbar { width: 4px; }
  #qb-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }

  .qb-msg {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 13.5px;
    line-height: 1.5;
    word-break: break-word;
  }

  .qb-msg-user {
    align-self: flex-end;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: #fff;
    border-bottom-right-radius: 4px;
  }

  .qb-msg-assistant {
    align-self: flex-start;
    background: #1e1e24;
    color: #e2e2e8;
    border-bottom-left-radius: 4px;
    border: 1px solid rgba(255,255,255,0.06);
  }

  .qb-msg-system {
    align-self: center;
    background: rgba(99,102,241,0.12);
    color: #a5a5b8;
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 20px;
    max-width: 90%;
    text-align: center;
  }

  .qb-msg-time {
    font-size: 10px;
    opacity: 0.5;
    margin-top: 4px;
  }

  .qb-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .qb-action-btn {
    padding: 5px 10px;
    background: rgba(99,102,241,0.2);
    border: 1px solid rgba(99,102,241,0.4);
    border-radius: 20px;
    color: #a5a5ff;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .qb-action-btn:hover { background: rgba(99,102,241,0.4); color: #fff; }

  #qb-suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
  }

  .qb-suggest-btn {
    padding: 6px 12px;
    background: #1e1e24;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px;
    color: #c4c4d4;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .qb-suggest-btn:hover {
    background: rgba(99,102,241,0.2);
    border-color: rgba(99,102,241,0.5);
    color: #fff;
  }

  #qb-input-area {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
  }

  #qb-input {
    flex: 1;
    background: #1e1e24;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    color: #e2e2e8;
    font-size: 13.5px;
    padding: 8px 12px;
    resize: none;
    min-height: 38px;
    max-height: 100px;
    outline: none;
    font-family: inherit;
    line-height: 1.4;
    transition: border-color 0.15s ease;
  }

  #qb-input:focus { border-color: rgba(99,102,241,0.6); }
  #qb-input::placeholder { color: rgba(255,255,255,0.3); }

  #qb-send {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: opacity 0.15s ease;
  }

  #qb-send:hover { opacity: 0.85; }
  #qb-send:disabled { opacity: 0.4; cursor: not-allowed; }
  #qb-send svg { width: 16px; height: 16px; fill: #fff; }

  .qb-typing {
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 10px 14px;
  }

  .qb-typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #6366f1;
    animation: qb-bounce 1.2s infinite;
  }

  .qb-typing span:nth-child(2) { animation-delay: 0.2s; }
  .qb-typing span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes qb-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-4px); opacity: 1; }
  }

  .qb-highlight-pulse {
    outline: 3px solid #6366f1 !important;
    outline-offset: 2px !important;
    animation: qb-pulse 1.5s ease-in-out 3;
  }

  @keyframes qb-pulse {
    0%, 100% { outline-color: #6366f1; }
    50% { outline-color: #a78bfa; }
  }
`;

class AIAssistant {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private bubble: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private messagesContainer: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private state: PanelState = 'bubble';
  private messages: ChatMessage[] = [];
  private dragState: DragState = { isDragging: false, startX: 0, startY: 0, initialLeft: 0, initialTop: 0 };
  private panelLeft = -1;
  private panelTop = -1;
  private highlightedElements: Element[] = [];
  private behaviorTelemetry: BehaviorTelemetry | null = null;
  private actionPreloader: ActionPreloader | null = null;
  private intentLoop: number | null = null;
  private lastPredictionId: string | null = null;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'quantbrowse-ai-host';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    this.injectStyles();
    this.renderBubble();
    document.documentElement.appendChild(this.host);
    this.listenForBackgroundMessages();
    this.initializeIntentPrediction();
  }

  private injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = STYLES;
    this.shadow.appendChild(style);
  }

  private renderBubble(): void {
    this.bubble = document.createElement('div');
    this.bubble.id = 'qb-bubble';
    this.bubble.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2.546 21l3.94-.875A9.953 9.953 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 2a8 8 0 110 16 8 8 0 010-16zm-3 7a1 1 0 100 2 1 1 0 000-2zm3 0a1 1 0 100 2 1 1 0 000-2zm3 0a1 1 0 100 2 1 1 0 000-2z"/>
    </svg>`;
    this.bubble.addEventListener('click', () => this.openPanel());
    this.makeDraggable(this.bubble);
    this.shadow.appendChild(this.bubble);
  }

  private renderPanel(): void {
    if (this.panel) return;
    this.panel = document.createElement('div');
    this.panel.id = 'qb-panel';
    this.panel.classList.add('hidden');

    const header = this.createHeader();
    const messages = this.createMessagesArea();
    const suggestions = this.createSuggestions();
    const inputArea = this.createInputArea();

    this.panel.appendChild(header);
    this.panel.appendChild(messages);
    this.panel.appendChild(suggestions);
    this.panel.appendChild(inputArea);
    this.makeDraggablePanel(header);
    this.shadow.appendChild(this.panel);
  }

  private createHeader(): HTMLElement {
    const header = document.createElement('div');
    header.id = 'qb-header';
    header.innerHTML = `
      <div id="qb-header-title">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2.546 21l3.94-.875A9.953 9.953 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"/></svg>
        Quantbrowse AI
      </div>
      <div id="qb-header-controls">
        <button class="qb-ctrl-btn" id="qb-minimize" title="Minimize">
          <svg viewBox="0 0 24 24"><path d="M20 14H4v-2h16v2z"/></svg>
        </button>
        <button class="qb-ctrl-btn" id="qb-close" title="Close">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
        </button>
      </div>
    `;
    header.querySelector('#qb-minimize')?.addEventListener('click', (e) => { e.stopPropagation(); this.minimizePanel(); });
    header.querySelector('#qb-close')?.addEventListener('click', (e) => { e.stopPropagation(); this.closePanel(); });
    return header;
  }

  private createMessagesArea(): HTMLElement {
    const container = document.createElement('div');
    container.id = 'qb-messages';
    this.messagesContainer = container;
    this.appendSystemMessage('Hello! I\'m Quantbrowse AI. I can help you summarize this page, extract data, and more.');
    return container;
  }

  private createSuggestions(): HTMLElement {
    const suggestions = document.createElement('div');
    suggestions.id = 'qb-suggestions';
    const actions: SuggestedAction[] = [
      { id: 'summarize', label: '📝 Summarize page', command: 'summarize_page' },
      { id: 'emails', label: '✉️ Extract emails', command: 'extract_emails' },
      { id: 'pricing', label: '💰 Find pricing', command: 'find_pricing' },
    ];
    actions.forEach(action => {
      const btn = document.createElement('button');
      btn.className = 'qb-suggest-btn';
      btn.textContent = action.label;
      btn.addEventListener('click', () => this.handleCommand(action.command));
      suggestions.appendChild(btn);
    });
    return suggestions;
  }

  private createInputArea(): HTMLElement {
    const area = document.createElement('div');
    area.id = 'qb-input-area';

    this.inputEl = document.createElement('textarea');
    this.inputEl.id = 'qb-input';
    this.inputEl.placeholder = 'Ask anything about this page…';
    this.inputEl.rows = 1;
    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.inputEl.addEventListener('input', () => this.autoResizeInput());

    this.sendBtn = document.createElement('button');
    this.sendBtn.id = 'qb-send';
    this.sendBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    area.appendChild(this.inputEl);
    area.appendChild(this.sendBtn);
    return area;
  }

  private autoResizeInput(): void {
    if (!this.inputEl) return;
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 100) + 'px';
  }

  private openPanel(): void {
    if (!this.panel) this.renderPanel();
    this.state = 'panel';
    if (this.bubble) this.bubble.style.display = 'none';
    if (this.panel) {
      this.panel.classList.remove('hidden');
      if (this.panelLeft >= 0) {
        this.panel.style.left = this.panelLeft + 'px';
        this.panel.style.top = this.panelTop + 'px';
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
      }
    }
    this.inputEl?.focus();
  }

  private closePanel(): void {
    this.state = 'bubble';
    if (this.panel) this.panel.classList.add('hidden');
    if (this.bubble) this.bubble.style.display = 'flex';
  }

  private minimizePanel(): void {
    this.state = 'minimized';
    if (this.panel) this.panel.classList.add('hidden');
    if (this.bubble) this.bubble.style.display = 'flex';
  }

  private async sendMessage(): Promise<void> {
    if (!this.inputEl || !this.sendBtn) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.addMessage({ id: this.generateId(), role: 'user', content: text, timestamp: Date.now() });
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.sendBtn.disabled = true;

    this.showTypingIndicator();
    const context = this.collectPageContext();

    try {
      const response = await this.sendToBackground({ type: 'CHAT_MESSAGE', payload: { message: text, pageContext: context } }) as BackgroundResponse;
      this.removeTypingIndicator();
      const reply = (response?.data as string) ?? 'I processed your request. The full AI response will appear here once the backend is connected.';
      this.addMessage({ id: this.generateId(), role: 'assistant', content: reply, timestamp: Date.now() });
    } catch {
      this.removeTypingIndicator();
      this.addMessage({ id: this.generateId(), role: 'assistant', content: 'Unable to reach background service. Make sure the extension is properly installed.', timestamp: Date.now() });
    } finally {
      if (this.sendBtn) this.sendBtn.disabled = false;
      this.inputEl?.focus();
    }
  }

  private async handleCommand(command: string): Promise<void> {
    const commandLabels: Record<string, string> = {
      summarize_page: 'Summarize this page',
      extract_emails: 'Extract all emails',
      find_pricing: 'Find pricing info',
    };
    const label = commandLabels[command] ?? command;
    this.addMessage({ id: this.generateId(), role: 'user', content: label, timestamp: Date.now() });
    this.showTypingIndicator();

    try {
      const result = await this.executeCommand(command);
      this.removeTypingIndicator();
      this.addMessage({ id: this.generateId(), role: 'assistant', content: result, timestamp: Date.now() });
    } catch (err) {
      this.removeTypingIndicator();
      this.addMessage({ id: this.generateId(), role: 'assistant', content: `Error executing command: ${String(err)}`, timestamp: Date.now() });
    }
  }

  private async executeCommand(command: string): Promise<string> {
    const context = this.collectPageContext();
    switch (command) {
      case 'summarize_page': {
        const paragraphs = Array.from(document.querySelectorAll('p'))
          .slice(0, 5)
          .map(p => p.textContent?.trim())
          .filter(Boolean)
          .join('\n\n');
        await this.sendToBackground({ type: 'EXECUTE_COMMAND', payload: { command, context } });
        return `**Page Summary**\n\nTitle: ${context.title}\nURL: ${context.url}\nWords: ~${context.wordCount}\n\n${paragraphs || 'No paragraph content found.'}\n\nHeadings: ${context.headings.slice(0, 5).join(', ') || 'None detected'}`;
      }
      case 'extract_emails': {
        const emails = context.emails;
        if (emails.length === 0) return 'No email addresses found on this page.';
        this.highlightEmailsOnPage(emails);
        return `**Found ${emails.length} email address${emails.length > 1 ? 'es' : ''}:**\n\n${emails.map(e => `• ${e}`).join('\n')}`;
      }
      case 'find_pricing': {
        const prices = context.prices;
        if (prices.length === 0) return 'No pricing information found on this page.';
        this.highlightPricesOnPage(prices);
        return `**Found ${prices.length} price mention${prices.length > 1 ? 's' : ''}:**\n\n${prices.slice(0, 20).map(p => `• ${p}`).join('\n')}`;
      }
      default:
        return `Command "${command}" is not recognized.`;
    }
  }

  private collectPageContext(): PageContext {
    const text = document.body?.innerText ?? '';
    const words = text.split(/\s+/).filter(Boolean);
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map(h => h.textContent?.trim() ?? '').filter(Boolean);
    const links = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 30)
      .map(a => ({ text: (a as HTMLAnchorElement).textContent?.trim() ?? '', href: (a as HTMLAnchorElement).href }))
      .filter(l => l.text && l.href);
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const emails = [...new Set(text.match(emailRegex) ?? [])];
    const priceRegex = /[\$£€¥₹][\d,]+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|JPY)/g;
    const prices = [...new Set(text.match(priceRegex) ?? [])];
    const summaryEl = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    const summary = summaryEl?.content ?? text.split(/\s+/).slice(0, 60).join(' ');
    return { url: location.href, title: document.title, summary, wordCount: words.length, headings, links, emails, prices };
  }

  private highlightEmailsOnPage(emails: string[]): void {
    this.clearHighlights();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodesToHighlight: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const txt = node.textContent ?? '';
      if (emails.some(e => txt.includes(e))) nodesToHighlight.push(node as Text);
    }
    nodesToHighlight.slice(0, 10).forEach(textNode => {
      const parent = textNode.parentElement;
      if (parent && !['SCRIPT', 'STYLE'].includes(parent.tagName)) {
        parent.classList.add('qb-highlight-pulse');
        this.highlightedElements.push(parent);
        setTimeout(() => parent.classList.remove('qb-highlight-pulse'), 4500);
      }
    });
    if (nodesToHighlight[0]?.parentElement) {
      nodesToHighlight[0].parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  private highlightPricesOnPage(prices: string[]): void {
    this.clearHighlights();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode()) && found.length < 15) {
      const txt = node.textContent ?? '';
      if (prices.some(p => txt.includes(p))) found.push(node as Text);
    }
    found.forEach(textNode => {
      const parent = textNode.parentElement;
      if (parent && !['SCRIPT', 'STYLE'].includes(parent.tagName)) {
        parent.classList.add('qb-highlight-pulse');
        this.highlightedElements.push(parent);
        setTimeout(() => parent.classList.remove('qb-highlight-pulse'), 4500);
      }
    });
    if (found[0]?.parentElement) {
      found[0].parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  private clearHighlights(): void {
    this.highlightedElements.forEach(el => el.classList.remove('qb-highlight-pulse'));
    this.highlightedElements = [];
  }

  private addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    if (!this.messagesContainer) return;
    const el = document.createElement('div');
    el.className = `qb-msg qb-msg-${msg.role}`;
    el.dataset.id = msg.id;

    const content = document.createElement('div');
    content.className = 'qb-msg-content';
    content.textContent = msg.content;

    const time = document.createElement('div');
    time.className = 'qb-msg-time';
    time.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    el.appendChild(content);
    el.appendChild(time);

    if (msg.actions && msg.actions.length > 0) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'qb-actions';
      msg.actions.forEach(action => {
        const btn = document.createElement('button');
        btn.className = 'qb-action-btn';
        btn.textContent = action.label;
        btn.addEventListener('click', () => this.handleCommand(action.command));
        actionsEl.appendChild(btn);
      });
      el.appendChild(actionsEl);
    }

    this.messagesContainer.appendChild(el);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  private appendSystemMessage(text: string): void {
    if (!this.messagesContainer) return;
    const el = document.createElement('div');
    el.className = 'qb-msg qb-msg-system';
    el.textContent = text;
    this.messagesContainer.appendChild(el);
  }

  private showTypingIndicator(): void {
    if (!this.messagesContainer) return;
    const el = document.createElement('div');
    el.className = 'qb-msg qb-msg-assistant';
    el.id = 'qb-typing-indicator';
    el.innerHTML = `<div class="qb-typing"><span></span><span></span><span></span></div>`;
    this.messagesContainer.appendChild(el);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  private removeTypingIndicator(): void {
    this.shadow.querySelector('#qb-typing-indicator')?.remove();
  }

  private sendToBackground(request: BackgroundRequest): Promise<BackgroundResponse> {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(request, (response: BackgroundResponse) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response ?? { success: true, data: null });
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private listenForBackgroundMessages(): void {
    chrome.runtime.onMessage.addListener((msg: BackgroundRequest, _sender, sendResponse) => {
      if (msg.type === 'PAGE_ANALYSIS_COMPLETE') {
        const data = msg.payload as { summary?: string };
        if (data?.summary) {
          this.addMessage({ id: this.generateId(), role: 'assistant', content: `Analysis complete:\n\n${data.summary}`, timestamp: Date.now() });
        }
        sendResponse({ success: true });
      }
      return false;
    });
  }

  private initializeIntentPrediction(): void {
    this.behaviorTelemetry = new BehaviorTelemetry();
    this.actionPreloader = new ActionPreloader(this.behaviorTelemetry);
    this.intentLoop = window.setInterval(() => {
      const preloader = this.actionPreloader;
      if (!preloader || this.state === 'panel') return;
      const prediction = preloader.evaluateNextAction();
      if (!prediction) {
        this.lastPredictionId = null;
        return;
      }
      this.preloadPrediction(prediction);
    }, 450);
  }

  private preloadPrediction(prediction: PredictedAction): void {
    const key = this.getPredictionKey(prediction);
    if (this.lastPredictionId === key) return;
    this.lastPredictionId = key;
    this.actionPreloader?.prefetchPredictedAction(prediction);
  }

  private getPredictionKey(prediction: PredictedAction): string {
    const el = prediction.element;
    const href = el instanceof HTMLAnchorElement ? el.href : '';
    const id = el.id || el.getAttribute('name') || el.getAttribute('aria-label') || el.tagName;
    return `${prediction.type}:${id}:${href}`;
  }

  private makeDraggable(el: HTMLElement): void {
    let startX = 0, startY = 0, startRight = 0, startBottom = 0;
    let moved = false;

    el.addEventListener('mousedown', (e: MouseEvent) => {
      startX = e.clientX;
      startY = e.clientY;
      startRight = parseInt(el.style.right || '24', 10);
      startBottom = parseInt(el.style.bottom || '24', 10);
      moved = false;

      const onMouseMove = (me: MouseEvent) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        const newRight = Math.max(0, Math.min(window.innerWidth - BUBBLE_SIZE, startRight - dx));
        const newBottom = Math.max(0, Math.min(window.innerHeight - BUBBLE_SIZE, startBottom - dy));
        el.style.right = newRight + 'px';
        el.style.bottom = newBottom + 'px';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (!moved) this.openPanel();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    });
  }

  private makeDraggablePanel(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.qb-ctrl-btn')) return;
      const panel = this.panel;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      this.dragState = { isDragging: true, startX: e.clientX, startY: e.clientY, initialLeft: rect.left, initialTop: rect.top };

      const onMouseMove = (me: MouseEvent) => {
        if (!this.dragState.isDragging) return;
        const dx = me.clientX - this.dragState.startX;
        const dy = me.clientY - this.dragState.startY;
        const newLeft = Math.max(0, Math.min(window.innerWidth - PANEL_WIDTH, this.dragState.initialLeft + dx));
        const newTop = Math.max(0, Math.min(window.innerHeight - PANEL_HEIGHT, this.dragState.initialTop + dy));
        this.panelLeft = newLeft;
        this.panelTop = newTop;
        panel.style.left = newLeft + 'px';
        panel.style.top = newTop + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };

      const onMouseUp = () => {
        this.dragState.isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    });
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  destroy(): void {
    if (this.intentLoop !== null) {
      window.clearInterval(this.intentLoop);
      this.intentLoop = null;
    }
    this.actionPreloader?.dispose();
    this.actionPreloader = null;
    this.behaviorTelemetry?.dispose();
    this.behaviorTelemetry = null;
    this.clearHighlights();
    this.host.remove();
  }
}

// Initialize only once per page
if (!(window as unknown as Record<string, unknown>)['__quantbrowse_ai_loaded__']) {
  (window as unknown as Record<string, unknown>)['__quantbrowse_ai_loaded__'] = true;
  const assistant = new AIAssistant();
  (window as unknown as Record<string, unknown>)['__quantbrowse_ai_instance__'] = assistant;
}

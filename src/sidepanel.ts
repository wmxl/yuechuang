import './sidepanel.css';
import { renderChatMarkdown } from './chat-markdown';
import { CHAT_PORT, MAX_CHAT_INPUT, MAX_CHAT_MESSAGES, MAX_CHAT_QUOTE, chatInputWithQuote, isQuotePassage, type ChatCitation, type ChatCommand, type ChatMessage, type ChatReadingEvent, type ChatResponseDetails, type ChatSearch, type ChatState } from './chat-shared';
import { sanitizeChatCitations, sanitizeChatSearch } from './chat-search';
import { sanitizeChatDetails } from './chat-details';
import { siwcStatusText } from './siwc-shared';
import { siwcDiagnosticText } from './siwc-diagnostics';

type PanelTab = 'chat' | 'research' | 'phrases' | 'settings';
type EmbeddedTab = Exclude<PanelTab, 'chat'>;
const tabNames: PanelTab[] = ['chat', 'research', 'phrases', 'settings'];
const embeddedPages: Record<EmbeddedTab, { page: string; title: string }> = {
  research: { page: 'research.html?panel=1', title: '跨页研究' },
  phrases: { page: 'phrases.html?panel=1', title: '词句收藏' },
  settings: { page: 'options.html?panel=1', title: '模型与阅读设置' },
};
const frames = new Map<EmbeddedTab, HTMLIFrameElement>();
function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`缺少侧栏元素：${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}
const input = element<HTMLTextAreaElement>('chat-input');
const sendButton = element<HTMLButtonElement>('chat-send');
const quoteTerms = element('chat-quote-terms');
const quickActions = [
  { label: '翻译', button: element<HTMLButtonElement>('chat-translate'), prompt: '请翻译所附文本。以中文为主时译成英文，否则译成中文。保留原意和格式。' },
  { label: '解释', button: element<HTMLButtonElement>('chat-explain'), prompt: '请用通俗的中文解释所附文本的含义，必要时举一个简短的例子。' },
];
const stopButton = element<HTMLButtonElement>('chat-stop');
const newButton = element<HTMLButtonElement>('chat-new');
const scroll = element('chat-scroll');
const messages = element('chat-messages');
const feedback = element('chat-feedback');
const clearDialog = element<HTMLDialogElement>('chat-clear-dialog');
const messageNodes = new Map<string, { article: HTMLElement; content: HTMLElement; copy?: HTMLButtonElement; note: HTMLElement; search: HTMLElement; sources: HTMLElement; details?: HTMLDetailsElement; detailsBody?: HTMLElement; renderedDetails?: string; renderedSource?: string; renderedCitations?: string; renderedStatus?: ChatMessage['status'] }>();
let state: ChatState = { type: 'chat:state', messages: [], status: 'idle', hasKey: false, settingsReady: false };
let connected = false;
let loaded = false;
let awaitingSend = false;
let composing = false;
let suggestedDraft: string | undefined;
let currentTab: PanelTab = 'chat';
let port: chrome.runtime.Port | undefined;
let localError = '';
let clearRequestId: string | undefined;
type PageQuote = Extract<ChatReadingEvent, { type: 'chat:page-quote' }>;
let pendingSubmission: { text: string; draft?: string; quote?: PageQuote; previousIds: Set<string>; sawRunning?: boolean } | undefined;
let pageQuote: PageQuote | undefined;
let quoteTermsId: string | undefined;
const readingWindow = chrome.windows.getCurrent().then(window => window.id, () => undefined);
const reconnectDelays = [150, 600, 1600];
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let portVersion = 0;
let reconnecting = false;
let pageClosed = false;
let connectionSnapshot = '';
interface InterruptedFragment { requestId: string; messageId: string; content: string; search?: ChatSearch; citations?: ChatCitation[]; details?: ChatResponseDetails }
let pendingInterruptedFragment: InterruptedFragment | undefined;
const interruptedFragments = new Map<string, InterruptedFragment>();

function switchTab(tab: PanelTab, focus = false): void {
  currentTab = tab;
  subscribeReadingWindow();
  for (const name of tabNames) {
    const selected = name === tab;
    const button = element<HTMLButtonElement>(`tab-${name}`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    element(`panel-${name}`).hidden = !selected;
    if (selected && focus) button.focus();
  }
  if (tab !== 'chat' && !frames.has(tab)) {
    const frame = document.createElement('iframe');
    frame.id = `frame-${tab}`;
    frame.title = embeddedPages[tab].title;
    frame.src = chrome.runtime.getURL(embeddedPages[tab].page);
    frames.set(tab, frame);
    element(`panel-${tab}`).append(frame);
  }
  if (tab === 'settings') frames.get('settings')?.contentWindow?.postMessage({ type: 'reader:settings-visible' }, location.origin);
  if (tab === 'chat') {
    recoverConnection();
    updateControls();
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-panel-tab]').forEach(button => {
  button.addEventListener('click', () => switchTab(button.dataset.panelTab as PanelTab));
  button.addEventListener('keydown', event => {
    const index = tabNames.indexOf(button.dataset.panelTab as PanelTab);
    let next: PanelTab | undefined;
    if (event.key === 'ArrowRight') next = tabNames[(index + 1) % tabNames.length];
    if (event.key === 'ArrowLeft') next = tabNames[(index + tabNames.length - 1) % tabNames.length];
    if (event.key === 'Home') next = tabNames[0];
    if (event.key === 'End') next = tabNames[tabNames.length - 1];
    if (next) { event.preventDefault(); switchTab(next, true); }
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-navigate]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.navigate as PanelTab, true)));
window.addEventListener('message', event => {
  if (event.origin !== location.origin || ![...frames.values()].some(frame => event.source === frame.contentWindow)) return;
  const value: unknown = event.data;
  if (!value || typeof value !== 'object' || !('type' in value)) return;
  if (value.type === 'reader:connection-changed') {
    if (event.source === frames.get('settings')?.contentWindow) recoverConnection();
    return;
  }
  if (value.type !== 'reader:navigate' || !('tab' in value) || !tabNames.includes(value.tab as PanelTab)) return;
  switchTab(value.tab as PanelTab, true);
});

function running(): boolean { return state.status === 'running'; }
function searchStatusText(message: ChatMessage): string {
  const search = sanitizeChatSearch(message.search);
  if (!search) return '';
  const interrupted = message.status === 'cancelled' || message.status === 'error';
  return search.state === 'searching' ? interrupted ? '联网搜索已中断' : '正在联网搜索…'
    : search.state === 'reading' ? interrupted ? '网页读取已中断' : '正在读取网页…'
      : search.state === 'complete' ? interrupted ? '搜索完成 · 回答未完成' : '搜索完成'
        : '联网搜索未完成';
}
function command(value: ChatCommand): boolean {
  if (!connected || !port) return false;
  try { port.postMessage(value); return true; }
  catch { disconnect(); return false; }
}
function inputSize(): void {
  if (input.value !== suggestedDraft) suggestedDraft = undefined;
  element('chat-suggestions').hidden = !!input.value && suggestedDraft === undefined;
  input.style.height = 'auto';
  input.style.height = `${Math.min(180, Math.max(69, input.scrollHeight))}px`;
  element('chat-input-count').textContent = `${chatInputWithQuote(input.value.trim(), pageQuote?.text ?? '').length.toLocaleString('en-US')} / 6,000`;
}
function clearQuoteTerms(): void {
  if (quoteTermsId) {
    quoteTermsId = undefined;
    command({ type: 'chat:cancel-quote-terms' });
  }
  quoteTerms.replaceChildren();
  quoteTerms.hidden = true;
}
function setPageQuote(quote?: PageQuote): void {
  clearQuoteTerms();
  pageQuote = quote;
  element('chat-page-quote-text').textContent = quote?.text ?? '';
  element('chat-page-quote').hidden = !quote;
  inputSize(); updateControls();
  if (quote && isQuotePassage(quote.text)) requestQuoteTerms(quote);
}
function requestQuoteTerms(quote: PageQuote): void {
  if (quoteTermsId || pageQuote !== quote || !connected || !state.settingsReady || !state.hasKey) return;
  quoteTermsId = crypto.randomUUID();
  quoteTerms.textContent = '难词预测中...';
  quoteTerms.hidden = false;
  command({ type: 'chat:quote-terms', id: quoteTermsId, text: quote.text, source: quote.source });
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const source = pageQuote?.source;
  if (source && source.windowId === windowId && source.tabId !== tabId) setPageQuote();
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (pageQuote?.source.tabId === tabId) setPageQuote();
});
function clearNavigatedQuote({ tabId, frameId }: { tabId: number; frameId: number }): void {
  const source = pageQuote?.source;
  if (source?.tabId === tabId && (frameId === 0 || frameId === source.frameId)) setPageQuote();
}
chrome.webNavigation.onCommitted.addListener(clearNavigatedQuote);
chrome.webNavigation.onHistoryStateUpdated.addListener(clearNavigatedQuote);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(clearNavigatedQuote);
function subscribeReadingWindow(): void {
  const target = port;
  if (!target) return;
  void readingWindow.then(windowId => {
    if (windowId === undefined || port !== target || pageClosed) return;
    try { target.postMessage({ type: 'chat:reading-window', windowId, quoteEnabled: currentTab === 'chat' } satisfies ChatCommand); }
    catch { /* The chat Port reconnects independently. */ }
  });
}
function receiveReadingEvent(value: ChatReadingEvent): void {
  if (value.type === 'chat:page-quote' && currentTab === 'chat' && typeof value.text === 'string' && value.text.length <= MAX_CHAT_QUOTE) {
    setPageQuote(value);
  } else if (value.type === 'chat:quote-terms' && value.id === quoteTermsId && pageQuote) {
    quoteTermsId = undefined;
    const quote = pageQuote;
    const { result } = value;
    if (result.status === 'cancelled') {
      clearQuoteTerms();
      return;
    }
    if (result.status === 'error') {
      const retry = node('button', 'quote-term', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => requestQuoteTerms(quote));
      quoteTerms.replaceChildren(document.createTextNode(result.message), retry);
    } else if (!result.terms.length) {
      quoteTerms.textContent = '没有适合推荐的词';
    } else quoteTerms.replaceChildren(...result.terms.map(term => {
      const button = node('button', 'quote-term', term);
      button.type = 'button';
      button.title = `结合网页选区翻译并解释「${term}」`;
      const prompt = `请结合整段网页选区，给出「${term}」在这里的译法或对应说法，再用简明中文解释它在原文中的意思。只处理这个词。原词是中文时可给出对应的英文。`;
      button.addEventListener('click', () => {
        if (!composing && pageQuote === quote) submit({ button, prompt });
      });
      return button;
    }));
    updateControls();
  } else if (value.type === 'chat:follow-up-ready') {
    if (pageQuote?.text === value.quote && pageQuote.source.tabId === value.source.tabId &&
        pageQuote.source.documentId === value.source.documentId && pageQuote.source.url === value.source.url) setPageQuote();
    switchTab('chat');
    input.focus();
  }
}
function submissionText(prompt?: string): string {
  const draft = input.value.trim();
  const quote = pageQuote?.text ?? '';
  if (!prompt) return draft ? chatInputWithQuote(draft, quote) : '';
  if (quote) return chatInputWithQuote(prompt, quote);
  return draft ? `${prompt}\n\n待处理文本：\n${draft}` : '';
}
function fitsInput(text: string): boolean { return !!text && text.length <= MAX_CHAT_INPUT; }
function updateControls(): void {
  const active = running();
  const oauth = state.connection === 'chatgptOAuth';
  const connectionReady = state.settingsReady && state.hasKey;
  const ready = loaded && connected && connectionReady;
  const canSend = ready && !active && !awaitingSend;
  sendButton.hidden = active;
  sendButton.disabled = !canSend || !fitsInput(submissionText());
  for (const { label, button, prompt } of quickActions) {
    button.disabled = !canSend || !fitsInput(submissionText(prompt));
    button.title = pageQuote ? `${label}网页选区，保留输入框草稿` : input.value.trim() ? `${label}输入框里的文字` : `先在网页上划词，或粘贴要${label}的文字`;
  }
  for (const button of quoteTerms.querySelectorAll('button')) button.disabled = !canSend;
  stopButton.hidden = !active;
  stopButton.disabled = !connected || !state.requestId;
  newButton.disabled = !loaded || !connected || (!state.messages.length && !state.error);
  input.disabled = !connected || !loaded;
  input.placeholder = reconnecting ? '正在恢复连接，草稿已保留…' : !loaded ? '正在连接…' : !connected ? '连接暂时不可用，返回「对话」重试' : active ? '可以先写下下一个问题…' : ready ? '输入问题，继续对话…' : '先到设置连接模型，再开始对话…';
  const status = element('chat-status');
  const oauthText = state.siwcStatus ? siwcStatusText(state.siwcStatus) : '等待 ChatGPT 官方登录状态';
  const idleText = oauth ? oauthText : state.hasKey && state.settingsReady ? '模型已配置 · 消息直发所配接口' : '使用你自己的模型接口';
  const latest = state.messages.at(-1);
  const liveSearch = latest?.role === 'assistant' ? sanitizeChatSearch(latest.search) : undefined;
  const generationText = liveSearch?.state === 'searching' || liveSearch?.state === 'reading' ? searchStatusText(latest!) : liveSearch?.state === 'complete' ? '正在整理搜索结果…' : '正在生成回答…';
  const statusText: Record<ChatState['status'], string> = { idle: idleText, running: generationText, cancelled: '已停止 · 可以继续提问', interrupted: '上次回答已中断 · 可以继续提问', error: oauth ? oauthText : '本次回答未完成' };
  status.textContent = reconnecting ? '正在恢复与扩展后台的连接…' : !connected ? pageClosed ? '侧栏已关闭' : '连接暂时不可用，返回「对话」重试' : !loaded ? '正在连接…' : statusText[state.status];
  status.dataset.status = state.status;
  const connection = element('chat-connection');
  connection.hidden = !loaded || !oauth;
  connection.textContent = `${state.connectionLabel || 'ChatGPT 订阅（官方登录）'}${state.accountLabel ? ` · ${state.accountLabel}` : ''}`;
  element('chat-history-note').textContent = '会话仅本次浏览器使用';
  element('chat-clear-description').textContent = '当前会话中的消息会被清空。正在生成的回答也会停止。';
  const setup = element('chat-setup');
  setup.hidden = !loaded || !connected || connectionReady;
  element('chat-setup-heading').textContent = oauth ? '连接 ChatGPT 订阅' : '先连接你的模型';
  element('chat-setup-text').textContent = oauth
    ? state.siwcStatus?.loggedIn && !state.siwcStatus.planAuthorized ? '账号身份已验证。请到设置重新登录并授权 ChatGPT 套餐用量。'
        : state.siwcStatus?.planAuthorized ? '请到设置刷新模型列表，再选择可用模型。选择后会自动保存。'
          : '在设置中选择「ChatGPT 订阅（官方登录）」，直接授权账号和套餐用量。日常聊天无需保留官网标签页。'
    : !state.hasKey ? '在设置中填写接口、模型和 Key，即可开始对话。' : '请在设置中补全模型配置，并授权接口所在的网站。';
  element('chat-empty').hidden = state.messages.length > 0;
  const error = localError || state.error || '';
  const diagnosticText = oauth && !localError && state.siwcStatus?.generation === 'blocked' ? siwcDiagnosticText(state.siwcStatus.diagnostic) : '';
  feedback.textContent = error && diagnosticText ? `${error}（${diagnosticText}）` : error;
  feedback.hidden = !error;
}
function nearBottom(): boolean { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100; }
function scrollToBottom(): void { requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; }); }
function citationLink(citation: ChatCitation, number: number, className: string): HTMLAnchorElement {
  const link = node('a', className, `[${number}]`);
  link.href = citation.url; link.title = citation.title; link.target = '_blank';
  link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
  link.setAttribute('aria-label', `来源 ${number}：${citation.title}`);
  return link;
}
function sourceNumbers(citations: ChatCitation[]): number[] {
  const sources = new Map<string, number>();
  return citations.map(citation => { if (!sources.has(citation.url)) sources.set(citation.url, sources.size + 1); return sources.get(citation.url)!; });
}
function textBoundary(source: string, offset: number): number {
  // A malformed range must never split a UTF-16 surrogate pair in the UI.
  return offset > 0 && offset < source.length && /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset]) ? offset + 1 : offset;
}
function renderCitedMarkdown(target: HTMLElement, source: string, citations: ChatCitation[]): void {
  renderChatMarkdown(target, source);
  if (!citations.length) return;
  const numbers = sourceNumbers(citations);
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const prefix = `READERCITE${nonce}N`;
  const markers = citations.map((citation, index) => ({ offset: textBoundary(source, citation.end), index, token: `${prefix}${index}Z` })).sort((a, b) => a.offset - b.offset || a.index - b.index);
  let markedSource = '', previous = 0;
  for (const marker of markers) { markedSource += source.slice(previous, marker.offset) + marker.token; previous = marker.offset; }
  markedSource += source.slice(previous);
  const probe = document.createElement('div');
  renderChatMarkdown(probe, markedSource);
  const probeText = probe.textContent || '', pattern = new RegExp(`${prefix}(\\d+)Z`, 'g');
  const positions: { offset: number; index: number }[] = [];
  let clean = ''; previous = 0;
  for (const match of probeText.matchAll(pattern)) {
    clean += probeText.slice(previous, match.index);
    positions.push({ offset: clean.length, index: Number(match[1]) });
    previous = match.index! + match[0].length;
  }
  clean += probeText.slice(previous);
  if (positions.length !== citations.length || clean !== target.textContent) {
    // An offset inside Markdown syntax may change how a probe parses. Preserve
    // precise citations as safe text instead of moving links to a guessed span.
    target.textContent = source; target.classList.remove('markdown-body');
    positions.splice(0, positions.length, ...markers.map(marker => ({ offset: marker.offset, index: marker.index })));
  }
  const texts: { text: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let cursor = 0, current: Node | null;
  while ((current = walker.nextNode())) { const text = current as Text; texts.push({ text, start: cursor, end: cursor + text.length }); cursor += text.length; }
  for (const position of positions.sort((a, b) => b.offset - a.offset || b.index - a.index)) {
    const item = texts.find(item => position.offset >= item.start && position.offset <= item.end);
    if (!item || position.index < 0 || position.index >= citations.length) continue;
    const link = citationLink(citations[position.index], numbers[position.index], 'chat-citation');
    const parentLink = item.text.parentElement?.closest('a');
    if (parentLink) { parentLink.after(link); continue; }
    const range = document.createRange(); range.setStart(item.text, position.offset - item.start); range.collapse(true);
    range.insertNode(link);
  }
}
function renderSources(target: HTMLElement, citations: ChatCitation[], incomplete: boolean): void {
  target.replaceChildren(); target.hidden = !citations.length;
  if (!citations.length) return;
  target.append(node('p', 'chat-sources-heading', incomplete ? '参考来源 · 回答未完成' : '参考来源'));
  const list = node('ol', 'chat-sources-list'); list.setAttribute('aria-label', '回答引用来源');
  const numbers = sourceNumbers(citations), seen = new Set<string>();
  citations.forEach((citation, index) => {
    if (seen.has(citation.url)) return; seen.add(citation.url);
    const item = node('li', 'chat-source');
    const link = citationLink(citation, numbers[index], 'chat-source-link');
    link.textContent = `${numbers[index]}. ${citation.title}`;
    item.append(link, node('span', 'chat-source-domain', new URL(citation.url).hostname)); list.append(item);
  });
  target.append(list);
}
function renderResponseDetails(target: HTMLElement, details: ChatResponseDetails | undefined): void {
  target.replaceChildren();
  if (!details) return;
  const list = node('dl', 'chat-details-list');
  const field = (key: string, label: string, value: string, subitem = false): void => {
    const row = node('div', `chat-detail-row${subitem ? ' chat-detail-subitem' : ''}`);
    row.dataset.detailKey = key;
    row.append(node('dt', '', label), node('dd', '', value));
    list.append(row);
  };
  const duration = (value: number): string => value < 1000 ? `${Math.round(value).toLocaleString('zh-CN')} 毫秒` : `${(value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 秒`;
  const tokens = (value: number | undefined): string => value === undefined ? '未返回' : value.toLocaleString('zh-CN');
  if (details.model !== undefined) field('model', '服务端模型', details.model);
  if (details.durationMs !== undefined) field('durationMs', '总耗时', duration(details.durationMs));
  if (details.firstTokenMs !== undefined) field('firstTokenMs', '首字等待', duration(details.firstTokenMs));
  if (details.usage) {
    field('inputTokens', '输入 tokens', tokens(details.usage.inputTokens));
    if (details.usage.cachedInputTokens !== undefined) field('cachedInputTokens', '其中缓存输入', tokens(details.usage.cachedInputTokens), true);
    field('outputTokens', '输出 tokens', tokens(details.usage.outputTokens));
    if (details.usage.reasoningTokens !== undefined) field('reasoningTokens', '其中推理输出', tokens(details.usage.reasoningTokens), true);
    field('totalTokens', '合计 tokens', tokens(details.usage.totalTokens));
  }
  target.append(list);
  if (details.durationMs !== undefined || details.firstTokenMs !== undefined) target.append(node('p', 'chat-details-note', '耗时由本机计时，包含接口响应等待。'));
  if (details.usage) target.append(node('p', 'chat-details-note', 'Token 用量来自本次接口响应，不代表剩余订阅额度；缓存与推理计数已包含在对应输入或输出中。'));
}
function renderMessages(previousCount: number): void {
  const shouldScroll = nearBottom() || state.messages.length > previousCount;
  const ids = new Set(state.messages.map(message => message.id));
  for (const [id, entry] of messageNodes) if (!ids.has(id)) { entry.article.remove(); messageNodes.delete(id); }
  for (const message of state.messages) {
    let entry = messageNodes.get(message.id);
    if (!entry) {
      const article = node('article', 'chat-message');
      article.dataset.messageId = message.id;
      article.dataset.role = message.role;
      const header = node('div', 'chat-message-header');
      header.append(node('span', 'message-author', message.role === 'user' ? '你' : '阅窗'));
      const content = node('div', 'chat-message-content');
      const search = node('p', 'chat-search-status'); search.hidden = true; search.setAttribute('role', 'status'); search.setAttribute('aria-live', 'polite');
      const sources = node('section', 'chat-sources'); sources.hidden = true;
      const note = node('p', 'message-state');
      note.hidden = true;
      let copy: HTMLButtonElement | undefined;
      let details: HTMLDetailsElement | undefined, detailsBody: HTMLElement | undefined;
      if (message.role === 'assistant') {
        copy = node('button', 'chat-copy', '复制');
        copy.type = 'button';
        copy.setAttribute('aria-label', '复制这条回答');
        const button = copy;
        button.addEventListener('click', () => { void copyMessage(message.id, button); });
        header.append(copy);
        details = node('details', 'chat-response-details'); details.hidden = true;
        detailsBody = node('div', 'chat-details-body');
        details.append(node('summary', 'chat-details-summary', '回答详情'), detailsBody);
      }
      article.append(header, search, content, sources, note);
      if (details) article.append(details);
      entry = { article, content, copy, note, search, sources, details, detailsBody };
      messageNodes.set(message.id, entry);
      messages.append(article);
    }
    entry.article.dataset.status = message.status;
    const citations = message.role === 'assistant' ? sanitizeChatCitations(message.citations, message.content.length) : [];
    const citationSnapshot = JSON.stringify(citations);
    const searchText = message.role === 'assistant' ? searchStatusText(message) : '';
    entry.search.textContent = searchText; entry.search.hidden = !searchText;
    entry.search.dataset.state = sanitizeChatSearch(message.search)?.state || '';
    entry.article.dataset.searchActive = String(message.status === 'running' && ['searching', 'reading'].includes(message.search?.state || ''));
    if (entry.renderedSource !== message.content || entry.renderedCitations !== citationSnapshot) {
      if (message.role === 'assistant') renderCitedMarkdown(entry.content, message.content, citations);
      else entry.content.textContent = message.content;
      entry.renderedSource = message.content;
    }
    if (entry.renderedCitations !== citationSnapshot || entry.renderedStatus !== message.status) renderSources(entry.sources, citations, ['cancelled', 'error'].includes(message.status));
    entry.renderedCitations = citationSnapshot; entry.renderedStatus = message.status;
    if (entry.details && entry.detailsBody) {
      const details = sanitizeChatDetails(message.details);
      const detailsSnapshot = JSON.stringify(details);
      if (entry.renderedDetails !== detailsSnapshot) {
        // Keep the native disclosure node so status and stream updates preserve
        // its open state and the summary's keyboard focus for this message.
        renderResponseDetails(entry.detailsBody, details);
        entry.renderedDetails = detailsSnapshot;
      }
      entry.details.hidden = !details;
    }
    if (entry.copy) entry.copy.disabled = !message.content;
    entry.note.hidden = message.status !== 'cancelled' && message.status !== 'error';
    entry.note.textContent = message.status === 'cancelled' ? '生成已停止，保留已收到的内容。' : message.status === 'error' ? '回答未完成，保留已收到的内容。' : '';
  }
  if (shouldScroll) scrollToBottom();
}
async function copyMessage(id: string, button: HTMLButtonElement): Promise<void> {
  const message = state.messages.find(value => value.id === id);
  if (!message?.content) return;
  try {
    await navigator.clipboard.writeText(message.content);
    button.textContent = '已复制';
    window.setTimeout(() => { if (button.isConnected) button.textContent = '复制'; }, 1800);
  } catch {
    localError = '复制失败。可以选中回答文字后手动复制。';
    updateControls();
  }
}
function validState(value: unknown): value is ChatState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ChatState;
  if (candidate.connection !== undefined && !['apiKey', 'chatgptOAuth'].includes(candidate.connection)) return false;
  if (candidate.connectionLabel !== undefined && typeof candidate.connectionLabel !== 'string' || candidate.accountLabel !== undefined && typeof candidate.accountLabel !== 'string') return false;
  if (candidate.siwcStatus !== undefined) {
    const status = candidate.siwcStatus;
    if (!status || typeof status !== 'object' || !['unchecked', 'signedOut', 'ready', 'planDenied', 'reauthRequired', 'permissionRequired', 'error'].includes(status.state)
      || typeof status.loggedIn !== 'boolean' || typeof status.planAuthorized !== 'boolean'
      || !['unchecked', 'working', 'blocked'].includes(status.generation)
      || !Array.isArray(status.models) || !status.models.every(model => model && typeof model.id === 'string' && typeof model.label === 'string')
      || status.loginPending !== undefined && typeof status.loginPending !== 'boolean'
      || status.error !== undefined && typeof status.error !== 'string') return false;
  }
  return candidate.type === 'chat:state' && ['idle', 'running', 'error', 'cancelled', 'interrupted'].includes(candidate.status) && typeof candidate.hasKey === 'boolean' && typeof candidate.settingsReady === 'boolean' && (candidate.requestId === undefined || typeof candidate.requestId === 'string') && (candidate.error === undefined || typeof candidate.error === 'string') && Array.isArray(candidate.messages) && candidate.messages.every((message: ChatMessage) => message && typeof message.id === 'string' && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && ['done', 'running', 'cancelled', 'error'].includes(message.status));
}
function receive(value: unknown): void {
  if (!validState(value)) return;
  const previousCount = state.messages.length;
  state = preserveInterruptedFragments(value);
  loaded = true;
  localError = '';
  if (pendingSubmission) {
    if (state.status === 'running') pendingSubmission.sawRunning = true;
    const accepted = state.messages.some(message => message.role === 'user' && message.content === pendingSubmission!.text && !pendingSubmission!.previousIds.has(message.id));
    if (accepted || state.status !== 'running' && (!!state.error || pendingSubmission.sawRunning)) {
      if (accepted) {
        if (pageQuote === pendingSubmission.quote) setPageQuote();
      } else {
        if (!input.value && pendingSubmission.draft !== undefined) { input.value = pendingSubmission.draft; inputSize(); }
        if (!state.error) localError = '这条消息尚未发送，请重试。';
      }
      pendingSubmission = undefined;
      awaitingSend = false;
    }
  } else awaitingSend = false;
  renderMessages(previousCount);
  updateControls();
  const snapshot = JSON.stringify([state.connection, state.hasKey, state.settingsReady, state.siwcStatus]);
  if (snapshot !== connectionSnapshot) {
    connectionSnapshot = snapshot;
    frames.get('settings')?.contentWindow?.postMessage({ type: 'reader:connection-state' }, location.origin);
  }
}
function preserveInterruptedFragments(next: ChatState): ChatState {
  const pending = pendingInterruptedFragment;
  pendingInterruptedFragment = undefined;
  if (pending && next.requestId === pending.requestId && ['interrupted', 'cancelled', 'error'].includes(next.status)) {
    const message = next.messages.find(item => item.id === pending.messageId);
    if (message?.role === 'assistant' && ['cancelled', 'error'].includes(message.status)
      && pending.content.length >= message.content.length && pending.content.startsWith(message.content)) {
      interruptedFragments.set(pending.messageId, pending);
      if (interruptedFragments.size > MAX_CHAT_MESSAGES / 2) interruptedFragments.delete(interruptedFragments.keys().next().value!);
    }
  }
  const ids = new Set(next.messages.map(message => message.id));
  for (const id of interruptedFragments.keys()) if (!ids.has(id)) interruptedFragments.delete(id);
  let changed = false;
  const nextMessages = next.messages.map(message => {
    // These immutable message IDs were tied to the original request during its
    // first recovery. Keep the failed history fragment across later status and
    // new-turn snapshots; it never becomes a completed answer or model input.
    const fragment = interruptedFragments.get(message.id);
    if (!fragment) return message;
    if (message.role !== 'assistant' || !['cancelled', 'error'].includes(message.status)) { interruptedFragments.delete(message.id); return message; }
    const currentDetails = sanitizeChatDetails(message.details);
    const details = sanitizeChatDetails({ ...fragment.details, ...currentDetails,
      ...(fragment.details?.usage || currentDetails?.usage ? { usage: { ...fragment.details?.usage, ...currentDetails?.usage } } : {}) });
    if (fragment.content.length > message.content.length && fragment.content.startsWith(message.content)) {
      changed = true;
      fragment.details = details;
      return { ...message, content: fragment.content, ...(fragment.search ? { search: fragment.search } : {}), citations: sanitizeChatCitations(fragment.citations, fragment.content.length), ...(details ? { details } : {}) };
    }
    if (message.content.startsWith(fragment.content)) {
      fragment.content = message.content; fragment.details = details;
      if (JSON.stringify(details) !== JSON.stringify(currentDetails)) { changed = true; return { ...message, details }; }
    } else interruptedFragments.delete(message.id);
    return message;
  });
  return changed ? { ...next, messages: nextMessages } : next;
}
function disconnect(): void {
  if (pageClosed) return;
  const previous = port; port = undefined; ++portVersion;
  try { previous?.disconnect(); } catch { /* The worker may already be asleep. */ }
  connected = false;
  loaded = false;
  clearQuoteTerms();
  awaitingSend = false;
  if (pendingSubmission?.draft !== undefined && !input.value) { input.value = pendingSubmission.draft; inputSize(); }
  pendingSubmission = undefined;
  if (running()) {
    const assistant = state.messages.at(-1);
    const details = sanitizeChatDetails(assistant?.details);
    if (state.requestId && assistant?.role === 'assistant' && assistant.status === 'running' && (assistant.content || details)) {
      const search = sanitizeChatSearch(assistant.search);
      pendingInterruptedFragment = { requestId: state.requestId, messageId: assistant.id, content: assistant.content,
        ...(search ? { search: ['searching', 'reading'].includes(search.state) ? { ...search, state: 'failed' } : search } : {}),
        citations: sanitizeChatCitations(assistant.citations, assistant.content.length), ...(details ? { details } : {}) };
    }
    state = { ...state, status: 'interrupted', messages: state.messages.map(message => message.status === 'running' ? { ...message, status: 'error' } : message) };
    renderMessages(state.messages.length);
  }
  if (reconnectAttempt < reconnectDelays.length) {
    reconnecting = true;
    localError = '与扩展后台的连接暂时中断，正在恢复。草稿和已收到的内容已保留，不会自动重发问题。';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connectPort(); }, reconnectDelays[reconnectAttempt++]);
  } else {
    reconnecting = false;
    localError = '暂时无法恢复后台连接。请点击「对话」或返回侧栏后重试；草稿已保留。';
  }
  updateControls();
}
function connectPort(): void {
  if (pageClosed) return;
  const version = ++portVersion;
  connected = false; loaded = false; reconnecting = true; connectionSnapshot = '';
  let next: chrome.runtime.Port | undefined;
  try {
    next = chrome.runtime.connect({ name: CHAT_PORT }); port = next;
    next.onMessage.addListener(value => {
      if (pageClosed || port !== next || portVersion !== version) return;
      if (value?.type === 'chat:page-quote' || value?.type === 'chat:follow-up-ready' || value?.type === 'chat:quote-terms') { receiveReadingEvent(value); return; }
      if (!validState(value)) return;
      clearTimeout(reconnectTimer); reconnectTimer = undefined;
      connected = true; reconnecting = false; reconnectAttempt = 0;
      receive(value);
    });
    next.onDisconnect.addListener(() => {
      if (pageClosed || port !== next || portVersion !== version) return;
      try { void chrome.runtime.lastError; } catch { /* An extension update may retire this document. */ }
      disconnect();
    });
    // A fresh Port restores state only. Questions and destructive commands are
    // sent exclusively by their original trusted controls.
    next.postMessage({ type: 'chat:status' } satisfies ChatCommand);
    subscribeReadingWindow();
  } catch { disconnect(); }
  updateControls();
}
function recoverConnection(): void {
  if (pageClosed) return;
  if (connected && loaded && port) { command({ type: 'chat:status' }); return; }
  if (port) return; // An existing handshake owns the pending state response.
  clearTimeout(reconnectTimer); reconnectTimer = undefined; reconnectAttempt = 0;
  connectPort();
}
function submit(action?: { button: HTMLButtonElement; prompt: string }): void {
  if ((action?.button ?? sendButton).disabled || running() || awaitingSend) return;
  const text = submissionText(action?.prompt);
  if (!fitsInput(text)) return;
  const draft = action && pageQuote ? undefined : input.value;
  awaitingSend = true;
  pendingSubmission = { text, draft, quote: pageQuote, previousIds: new Set(state.messages.map(message => message.id)) };
  localError = '';
  updateControls();
  if (command({ type: 'chat:send', text, quoteSource: pageQuote?.source })) {
    if (draft !== undefined) { input.value = ''; inputSize(); }
    input.focus();
  } else {
    awaitingSend = false;
    pendingSubmission = undefined;
    updateControls();
  }
}
element<HTMLFormElement>('chat-form').addEventListener('submit', event => { event.preventDefault(); submit(); });
for (const action of quickActions) action.button.addEventListener('click', () => { if (!composing) submit(action); });
element('chat-page-quote-remove').addEventListener('click', () => { setPageQuote(); input.focus(); });
input.addEventListener('input', () => { suggestedDraft = undefined; inputSize(); updateControls(); });
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; });
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); submit(); }
});
stopButton.addEventListener('click', () => {
  if (state.requestId && running() && command({ type: 'chat:stop', requestId: state.requestId })) stopButton.disabled = true;
});
newButton.addEventListener('click', () => {
  clearRequestId = state.requestId;
  clearDialog.showModal();
  element('chat-clear-cancel').focus();
});
element('chat-clear-cancel').addEventListener('click', () => clearDialog.close());
element('chat-clear-confirm').addEventListener('click', () => {
  if (command({ type: 'chat:clear', ...(clearRequestId ? { requestId: clearRequestId } : {}) })) {
    input.value = '';
    setPageQuote();
  }
  clearDialog.close();
  input.focus();
});
document.querySelectorAll<HTMLButtonElement>('[data-chat-prompt]').forEach(button => button.addEventListener('click', () => {
  if (input.value && input.value !== suggestedDraft) return;
  suggestedDraft = button.dataset.chatPrompt ?? '';
  input.value = suggestedDraft;
  inputSize(); updateControls(); input.focus();
}));
window.addEventListener('pagehide', () => {
  pageClosed = true; clearTimeout(reconnectTimer); reconnectTimer = undefined; ++portVersion;
  pendingInterruptedFragment = undefined; interruptedFragments.clear();
  const previous = port; port = undefined;
  try { previous?.disconnect(); } catch { /* The document is already closing. */ }
}, { once: true });
window.addEventListener('focus', recoverConnection);
document.addEventListener('visibilitychange', () => { if (!document.hidden) recoverConnection(); });
switchTab(currentTab);
inputSize();
updateControls();

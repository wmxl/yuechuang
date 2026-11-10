import { allowedUrl } from './core';
import { generateContextAnswer, planContextRequest, validateContextSnapshot } from './context-model';
import {
  CONTEXT_MENU_EXPLAIN, CONTEXT_MENU_TRANSLATE, CONTEXT_PANEL_PIN, CONTEXT_PORT, HIDDEN_TOOLBAR_SITES, MAX_CONTEXT_SELECTION,
  detailsEligibility, normalizeContextSelection, type ContextAnswerKind, type ContextMode, type ContextShowMessage,
  type ContextPanelPin, type ContextSnapshot, type ContextState, type ContextSelectionStartMessage, type ContextSelectionDismissMessage
} from './context-shared';
import { readConfig, secureStorage } from './store';
import { savePhrase } from './phrases';
import { getChatConnectionView } from './chat-connection';
import { requestSiwc } from './siwc-background';
import { WEB_ACCESS_ORIGINS } from './shared';
import { trustedPage } from './trusted-page';
import { appendReadingTurn, stageChatPageQuote } from './chat-background';
import { MAX_CHAT_QUOTE } from './chat-shared';

interface ContextJob {
  id: string; tabId: number; frameId: number; documentId?: string; url?: string;
  mode: ContextMode; kind: ContextAnswerKind; snapshot?: ContextSnapshot; coreText: string;
  captureId?: string;
  replacesRequestId?: string;
  controller: AbortController; state: ContextState; shown: boolean; started: boolean;
  port?: chrome.runtime.Port;
}
const jobs = new Map<number, ContextJob>();
interface PendingSelection { captureId: string; frameId: number; documentId: string; url: string }
const pendingSelections = new Map<number, PendingSelection>();
let initialized = false;
let menuRegistration: Promise<void> | undefined;
let beforeRequest: (() => void) | undefined;
let configurationReady: (() => Promise<unknown>) | undefined;
let onUnavailable: ((reason: string) => void) | undefined;
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重新选择后重试。';
let toolbarSitesQueue: Promise<unknown> = Promise.resolve();
let panelPinQueue: Promise<unknown> = Promise.resolve();

function validPanelPin(pin: unknown): pin is ContextPanelPin {
  if (!pin || typeof pin !== 'object' || !('left' in pin) || !('top' in pin)) return false;
  return [pin.left, pin.top].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) &&
    ['width', 'height'].every(key => {
      const value = (pin as Record<string, unknown>)[key];
      return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
    });
}

async function hiddenToolbarSites(): Promise<string[]> {
  await secureStorage;
  const stored = (await chrome.storage.local.get(HIDDEN_TOOLBAR_SITES))[HIDDEN_TOOLBAR_SITES];
  return Array.isArray(stored) ? stored.filter(site => typeof site === 'string') : [];
}

function setToolbarSiteHidden(hostname: string, hidden: boolean): Promise<void> {
  const next = toolbarSitesQueue.then(async () => {
    const sites = await hiddenToolbarSites();
    if (sites.includes(hostname) === hidden) return;
    const updated = hidden ? [...sites, hostname].sort() : sites.filter(site => site !== hostname);
    await chrome.storage.local.set({ [HIDDEN_TOOLBAR_SITES]: updated });
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (tab.id !== undefined) void chrome.tabs.sendMessage(tab.id, { type: 'context:toolbar-site-changed', hostname }).catch(() => {});
    }
  });
  toolbarSitesQueue = next.catch(() => {});
  return next;
}

async function toolbarAllowed(url: string): Promise<boolean> {
  return !(await hiddenToolbarSites()).includes(new URL(url).hostname);
}

function current(job: ContextJob) {
  if (jobs.get(job.tabId) !== job || job.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
}
function emit(job: ContextJob) { try { job.port?.postMessage(job.state); } catch { /* A disconnected document cannot receive output. */ } }
function cancel(job: ContextJob, reason: string) {
  job.controller.abort();
  job.state = { ...job.state, status: 'cancelled', error: reason, canExpand: false };
  emit(job);
}
export function hasActiveContextTask(): boolean {
  return [...jobs.values()].some(job => ['reading', 'running'].includes(job.state.status));
}
/** Called synchronously before configuration/Key changes and connection tests. */
export function cancelContextTasks(reason = '已停止生成。') {
  pendingSelections.clear();
  for (const job of jobs.values()) if (['reading', 'running'].includes(job.state.status)) cancel(job, reason);
}

async function permitted(url: string) {
  try { return await chrome.permissions.contains({ origins: [allowedUrl(url).origin + '/*'] }); }
  catch { return false; }
}
async function verifyDocument(job: ContextJob) {
  current(job);
  if (!job.documentId || !job.url) throw new Error('网页尚未就绪，请重新选择后重试。');
  const frame = await chrome.webNavigation.getFrame({ tabId: job.tabId, frameId: job.frameId });
  current(job);
  if (!frame || frame.documentId !== job.documentId || frame.url !== job.url || frame.errorOccurred) throw new Error('网页已导航，请在当前页面重新选择。');
  if (!(await permitted(frame.url))) throw new Error('缺少当前网页的访问权限，请在 Chrome 的扩展详情中检查网站访问权限后重试。');
  current(job);
  return frame;
}
function freshJob(tabId: number, frameId: number, mode: ContextMode, kind: ContextAnswerKind = 'core', coreText = ''): ContextJob {
  const id = crypto.randomUUID();
  return { id, tabId, frameId, mode, kind, coreText, controller: new AbortController(), shown: false, started: false,
    state: { type: 'context:state', requestId: id, mode, status: 'reading', text: coreText, coreText, detailsText: '', expanded: kind === 'details', canExpand: false } };
}
function replace(job: ContextJob) {
  const previous = jobs.get(job.tabId);
  if (previous) {
    const changedDocument = previous.frameId !== job.frameId ||
      !!previous.documentId && !!job.documentId && previous.documentId !== job.documentId;
    // A replacement in another document cannot remove this document's UI via
    // context:show. Release its Port and close that exact old card explicitly.
    // Same-document retries keep their capture until the replacement is shown.
    if (changedDocument) void close(previous, '已切换到新的选区或回答。');
    else cancel(previous, '已切换到新的选区或回答。');
  }
  jobs.set(job.tabId, job);
}
async function show(job: ContextJob, error?: string) {
  await panelPinQueue;
  const pin = (await chrome.storage.local.get(CONTEXT_PANEL_PIN).catch(() => ({} as Record<string, unknown>)))[CONTEXT_PANEL_PIN];
  await verifyDocument(job); current(job);
  const result = await chrome.tabs.sendMessage(job.tabId, {
    type: 'context:show', requestId: job.id, mode: job.mode, snapshot: job.snapshot,
    error, expanded: job.kind === 'details', captureId: job.captureId, coreText: job.state.coreText,
    detailsText: job.state.detailsText, exampleKind: job.state.exampleKind,
    replacesRequestId: job.replacesRequestId, pin: validPanelPin(pin) ? pin : undefined
  } satisfies ContextShowMessage, { documentId: job.documentId! });
  current(job); await verifyDocument(job); current(job);
  if (!result?.ok) throw new Error(result?.message || result?.error || '回答窗口未能显示，请刷新网页后重试。');
  job.shown = true;
  if (job.port) { emit(job); void run(job); }
}
async function showFailure(job: ContextJob, error: unknown) {
  if (jobs.get(job.tabId) !== job || job.controller.signal.aborted) return;
  job.state = { ...job.state, status: 'error', error: message(error), canExpand: false };
  emit(job);
  // Capture failures have no snapshot. The content UI uses its saved context-menu position.
  try { await show(job, job.state.error); }
  catch {
    // Uninjected/ungranted pages cannot host a nearby answer. Keep the failure visible in the action.
    if (jobs.get(job.tabId) === job && !job.controller.signal.aborted) {
      if (onUnavailable) onUnavailable(job.state.error!);
      else {
        void chrome.action.setBadgeText({ text: '!' }).catch(() => {});
        void chrome.action.setTitle({ title: `阅窗：${job.state.error}` }).catch(() => {});
      }
    }
  }
}
async function startFromMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (tab?.id === undefined) return;
  pendingSelections.delete(tab.id);
  const mode: ContextMode = info.menuItemId === CONTEXT_MENU_TRANSLATE ? 'translate' : 'explain';
  const job = freshJob(tab.id, info.frameId ?? 0, mode);
  replace(job); // Invalidate an older request before the first asynchronous browser lookup.
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId: job.tabId, frameId: job.frameId }); current(job);
    if (!frame?.documentId || frame.errorOccurred) throw new Error('当前文档不可读取，请刷新后重新选择。');
    job.documentId = frame.documentId; job.url = allowedUrl(frame.url).href;
    const menuUrl = job.frameId === 0 ? info.pageUrl : info.frameUrl;
    if (menuUrl && allowedUrl(menuUrl).href !== job.url) throw new Error('右键菜单打开后网页已导航，请在当前页面重新选择。');
    await verifyDocument(job); current(job);
    const selectedText = typeof info.selectionText === 'string' ? info.selectionText : '';
    if (!normalizeContextSelection(selectedText)) throw new Error('选区为空或已消失，请重新选中文字后右键操作。');
    if (selectedText.length > MAX_CONTEXT_SELECTION) throw new Error('选区超过 6,000 字符，请选择较短的句子或段落。本次没有调用模型。');
    const captured = await chrome.tabs.sendMessage(job.tabId, { type: 'context:capture', requestId: job.id, selectedText }, { documentId: job.documentId });
    current(job); await verifyDocument(job); current(job);
    if (!captured?.ok) throw new Error(captured?.message || captured?.error || '选区已消失，请重新选择后重试。');
    job.snapshot = validateContextSnapshot(captured.snapshot, job.url, selectedText);
    if (job.snapshot.capturedAt > Date.now() + 5_000 || job.snapshot.capturedAt < Date.now() - 60_000) throw new Error('选区快照已失效，请重新选择后重试。');
    job.state.exampleKind = detailsEligibility(job.mode, job.snapshot.text);
    await show(job);
  } catch (error) { await showFailure(job, error); }
}
async function authorizedSender(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined || sender.frameId < 0 || !sender.documentId || !sender.url) throw new Error('选区来源无效。');
  const url = allowedUrl(sender.url).href;
  const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: sender.frameId });
  if (!frame || frame.errorOccurred || frame.documentId !== sender.documentId || frame.url !== url || !(await permitted(url))) throw new Error('当前网页已变化或缺少访问权限，请刷新并重新选择。');
  const latest = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: sender.frameId });
  if (!latest || latest.errorOccurred || latest.documentId !== sender.documentId || latest.url !== url) throw new Error('网页已导航，请在当前页面重新选择。');
  return { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId, url };
}
async function startFromSelection(input: ContextSelectionStartMessage, sender: chrome.runtime.MessageSender) {
  if (!['explain', 'translate'].includes(input.mode) || typeof input.captureId !== 'string' || !input.captureId || input.captureId.length > 200) throw new Error('划词请求无效，请重新选择文字。');
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined || !sender.documentId || !sender.url) throw new Error('选区来源无效。');
  const tabId = sender.tab.id;
  const pending: PendingSelection = { captureId: input.captureId, frameId: sender.frameId, documentId: sender.documentId, url: sender.url };
  pendingSelections.set(tabId, pending);
  let job: ContextJob | undefined;
  try {
    const source = await authorizedSender(sender);
    if (!await toolbarAllowed(source.url)) throw new Error('此网站的划词工具条已隐藏。');
    if (pendingSelections.get(tabId) !== pending) throw new DOMException('Aborted', 'AbortError');
    job = freshJob(source.tabId, source.frameId, input.mode);
    job.documentId = source.documentId; job.url = source.url; job.captureId = input.captureId;
    replace(job);
    await verifyDocument(job); current(job);
    const captured = await chrome.tabs.sendMessage(job.tabId, { type: 'context:capture', requestId: job.id, captureId: input.captureId }, { documentId: job.documentId });
    current(job); await verifyDocument(job); current(job);
    if (!captured?.ok) throw new Error(captured?.message || captured?.error || '选区已失效，请重新选择文字。');
    job.snapshot = validateContextSnapshot(captured.snapshot, job.url);
    if (job.snapshot.capturedAt > Date.now() + 5_000 || job.snapshot.capturedAt < Date.now() - 60_000) throw new Error('选区快照已失效，请重新选择文字。');
    job.state.exampleKind = detailsEligibility(job.mode, job.snapshot.text);
    await show(job);
    return { ok: true, requestId: job.id };
  } catch (error) {
    if (job) await showFailure(job, error);
    return { ok: false, error: error instanceof Error && error.name === 'AbortError' ? '选区已变化，当前查阅已取消。' : message(error) };
  } finally { if (pendingSelections.get(tabId) === pending) pendingSelections.delete(tabId); }
}
function dismissSelection(input: ContextSelectionDismissMessage, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined || !sender.documentId || !sender.url || (!input.requestId && !input.captureId)) return;
  const tabId = sender.tab.id, pending = pendingSelections.get(tabId);
  const active = jobs.get(tabId);
  const pendingRequestMatches = !input.requestId || active?.id === input.requestId && active.captureId === pending?.captureId;
  if (pending && pendingRequestMatches && input.captureId === pending.captureId && sender.frameId === pending.frameId && sender.documentId === pending.documentId && sender.url === pending.url) pendingSelections.delete(tabId);
  const job = jobs.get(tabId);
  if (!job || sender.frameId !== job.frameId || sender.documentId !== job.documentId || sender.url !== job.url || (input.requestId && input.requestId !== job.id) || (input.captureId && input.captureId !== job.captureId)) return;
  void close(job, '选区已变化，查阅已关闭。');
}
function combinedText(job: ContextJob, details: string) {
  return job.kind === 'details' ? `${job.coreText}\n\n${job.state.exampleKind === 'bilingual' ? '双语例句：' : '用法示例：'}\n${details}` : details;
}
function answerState(job: ContextJob, answer: string) {
  return { ...job.state, text: combinedText(job, answer), coreText: job.kind === 'core' ? answer : job.coreText, detailsText: job.kind === 'details' ? answer : '' };
}
async function run(job: ContextJob) {
  if (job.started || !job.shown || !job.port || !job.snapshot || job.state.status === 'error') return;
  job.started = true;
  try {
    await verifyDocument(job); current(job);
    await configurationReady?.(); current(job);
    const { config: connection } = await getChatConnectionView(); current(job);
    const config = await readConfig(); current(job);
    if (connection.provider === 'apiKey') {
      if (!config.settings.baseUrl || !config.settings.model || !config.key) throw new Error('请先在阅窗设置中填写接口、模型和 API Key。');
      if (!(await permitted(config.settings.baseUrl))) throw new Error('缺少模型接口域权限，请在 Chrome 的扩展详情中检查网站访问权限。');
      current(job);
    }
    const plan = planContextRequest(config.settings, job.mode, job.snapshot, job.kind, job.coreText);
    beforeRequest?.();
    current(job); await verifyDocument(job); current(job);
    job.state = { ...job.state, status: 'running', text: job.coreText, error: undefined }; emit(job);
    const onText = (text: string) => {
      if (jobs.get(job.tabId) !== job || job.controller.signal.aborted) return;
      job.state = answerState(job, text); emit(job);
    };
    const text = connection.provider === 'chatgptOAuth'
      ? await requestSiwc(plan.messages, job.controller.signal, onText, undefined, 'context')
      : await generateContextAnswer(config.settings, config.key, job.mode, job.snapshot, job.controller.signal, onText, job.kind, job.coreText);
    current(job); await verifyDocument(job); current(job);
    job.state = { ...answerState(job, text), status: 'done', canExpand: job.kind === 'core' && !!job.state.exampleKind }; emit(job);
  } catch (error) {
    if (jobs.get(job.tabId) !== job || job.controller.signal.aborted) return;
    job.state = { ...job.state, status: 'error', error: message(error), canExpand: false }; emit(job);
  }
}
async function close(job: ContextJob, reason: string, notify = true) {
  if (jobs.get(job.tabId) !== job) return;
  cancel(job, reason); jobs.delete(job.tabId);
  job.snapshot = undefined;
  const port = job.port; job.port = undefined; port?.disconnect();
  if (notify && job.documentId) await chrome.tabs.sendMessage(job.tabId, { type: 'context:closed', requestId: job.id }, { documentId: job.documentId }).catch(() => {});
}
async function saveCurrentPhrase(job: ContextJob) {
  if (job.state.status !== 'done' || job.state.saving || job.state.saved || !job.snapshot || !job.state.coreText.trim()) return;
  await verifyDocument(job); current(job);
  if (job.state.saving || job.state.saved) return;
  const input = {
    text: job.snapshot.text, context: job.snapshot.context,
    sourceTitle: job.snapshot.title, sourceUrl: job.snapshot.url, mode: job.mode,
    coreText: job.state.coreText, detailsText: job.state.detailsText,
    ...(job.state.exampleKind ? { exampleKind: job.state.exampleKind } : {})
  };
  job.state = { ...job.state, saving: true, saveError: undefined }; emit(job);
  try {
    const { entry } = await savePhrase(input);
    if (jobs.get(job.tabId) !== job || job.controller.signal.aborted) return;
    job.state = { ...job.state, saving: false, saved: true, savedId: entry.id }; emit(job);
  } catch (error) {
    if (jobs.get(job.tabId) !== job || job.controller.signal.aborted) return;
    job.state = { ...job.state, saving: false, saveError: message(error) }; emit(job);
  }
}
export function forgetSavedPhrase(id: string) {
  for (const job of jobs.values()) {
    if (job.state.savedId !== id) continue;
    job.state = { ...job.state, saved: false, savedId: undefined, saveError: undefined }; emit(job);
  }
}
async function rerun(job: ContextJob, details: boolean) {
  if (!job.snapshot) throw new Error('选区快照已失效，请重新选择。');
  if (details && (!job.state.canExpand || job.state.status !== 'done' || job.kind !== 'core')) return;
  await verifyDocument(job); current(job);
  const next = freshJob(job.tabId, job.frameId, job.mode, details ? 'details' : job.kind, details ? job.state.coreText : job.coreText);
  next.documentId = job.documentId; next.url = job.url; next.snapshot = job.snapshot;
  next.captureId = job.captureId; next.state.exampleKind = job.state.exampleKind;
  next.replacesRequestId = job.id;
  next.state.savedId = job.state.savedId;
  replace(next);
  try { await show(next); } catch (error) { await showFailure(next, error); }
}
function bindPort(connection: chrome.runtime.Port) {
  if (connection.name !== CONTEXT_PORT) return;
  const sender = connection.sender;
  const job = sender?.tab?.id === undefined ? undefined : jobs.get(sender.tab.id);
  let connected = true;
  const bound = (async () => {
    if (!sender || sender.id !== chrome.runtime.id || !job || sender.frameId !== job.frameId || sender.documentId !== job.documentId || sender.url !== job.url) throw new Error('回答窗口来源无效。');
    // Failed/stopped answers may reconnect to show their state, but cannot auto-run.
    const frame = await chrome.webNavigation.getFrame({ tabId: job.tabId, frameId: job.frameId });
    if (!connected || jobs.get(job.tabId) !== job || !frame || frame.documentId !== job.documentId || frame.url !== job.url || !(await permitted(frame.url)) || !connected || jobs.get(job.tabId) !== job) throw new Error('回答文档已变化。');
    const previous = job.port; job.port = connection;
    if (previous && previous !== connection) previous.disconnect();
    emit(job); void run(job);
  })();
  bound.catch(() => connection.disconnect());
  connection.onDisconnect.addListener(() => {
    connected = false;
    if (job?.port === connection) {
      job.port = undefined;
      if (jobs.get(job.tabId) === job) {
        if (['reading', 'running'].includes(job.state.status)) cancel(job, '回答窗口已断开，已停止生成。请重新选择后重试。');
        jobs.delete(job.tabId); job.snapshot = undefined;
      }
    }
  });
  connection.onMessage.addListener(command => {
    void (async () => {
      await bound;
      if (!connected || !job || jobs.get(job.tabId) !== job || job.port !== connection || command?.requestId !== job.id) return;
      if (!['context:stop', 'context:close', 'context:retry', 'context:expand', 'context:status', 'context:save', 'context:open-phrases'].includes(command.type)) return;
      // Every command is tied to the browser's current document, including old-ID retries.
      const frame = await chrome.webNavigation.getFrame({ tabId: job.tabId, frameId: job.frameId });
      if (!connected || jobs.get(job.tabId) !== job || job.port !== connection || !frame || frame.documentId !== job.documentId || frame.url !== job.url || !(await permitted(frame.url)) || jobs.get(job.tabId) !== job || !connected) return;
      if (command.type === 'context:status') emit(job);
      else if (command.type === 'context:save') await saveCurrentPhrase(job);
      else if (command.type === 'context:open-phrases') await chrome.tabs.create({ url: chrome.runtime.getURL('phrases.html') });
      else if (command.type === 'context:close') await close(job, '回答已关闭。');
      else if (command.type === 'context:stop') cancel(job, '已停止生成。');
      else if (command.type === 'context:retry' || command.type === 'context:expand') {
        // UI emits these commands only from trusted click handlers; no page messaging bridge exists.
        if (command.type === 'context:retry' && ['reading', 'running'].includes(job.state.status)) return;
        if (job.controller.signal.aborted) {
          // Retry deliberately starts a new operation with the retained immutable snapshot.
          if (command.type === 'context:expand') return;
          const next = freshJob(job.tabId, job.frameId, job.mode, job.kind, job.coreText);
          next.documentId = job.documentId; next.url = job.url; next.snapshot = job.snapshot;
          next.captureId = job.captureId; next.state.exampleKind = job.state.exampleKind;
          next.replacesRequestId = job.id;
          next.state.savedId = job.state.savedId;
          if (!next.snapshot) return;
          replace(next); await show(next);
        } else await rerun(job, command.type === 'context:expand');
      }
    })().catch(error => { if (job && jobs.get(job.tabId) === job && job.port === connection) { job.state = { ...job.state, status: 'error', error: message(error), canExpand: false }; emit(job); } });
  });
}
function removeMenu(id: string) {
  return new Promise<void>(resolve => chrome.contextMenus.remove(id, () => { void chrome.runtime.lastError; resolve(); }));
}
function createMenu(id: string, title: string) {
  return new Promise<void>((resolve, reject) => {
    chrome.contextMenus.create({ id, title, contexts: ['selection'], documentUrlPatterns: [...WEB_ACCESS_ORIGINS] }, () => {
      const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else resolve();
    });
  });
}
/** One registration per worker lifetime; failure leaves the existing M1 service intact. */
export function initializeContextMenus(options?: { beforeRequest?: () => void; configurationReady?: () => Promise<unknown>; onUnavailable?: (reason: string) => void }): Promise<void> {
  if (options?.beforeRequest) beforeRequest = options.beforeRequest;
  if (options?.configurationReady) configurationReady = options.configurationReady;
  if (options?.onUnavailable) onUnavailable = options.onUnavailable;
  if (menuRegistration) return menuRegistration;
  if (!initialized) {
    initialized = true;
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === CONTEXT_MENU_EXPLAIN || info.menuItemId === CONTEXT_MENU_TRANSLATE) void startFromMenu(info, tab);
    });
    chrome.runtime.onConnect.addListener(bindPort);
    chrome.runtime.onMessage.addListener((input, sender, respond) => {
      if (input?.type === 'context:follow-up') {
        const tab = sender.tab;
        const job = tab?.id === undefined ? undefined : jobs.get(tab.id);
        if (sender.id !== chrome.runtime.id || tab?.id === undefined || !job || job.id !== input.requestId ||
            job.frameId !== sender.frameId || job.documentId !== sender.documentId || job.url !== sender.url ||
            job.state.status !== 'done' || !job.snapshot || !job.state.text.trim()) {
          respond({ ok: false, error: '查阅结果已失效，请重新查阅后再追问。' }); return;
        }
        // Chrome requires the open call to run in the original click's task.
        const opened = chrome.sidePanel.open({ windowId: tab.windowId });
        const selection = job.snapshot.text;
        const prompt = `${job.mode === 'translate' ? '请翻译这段网页选区' : '请结合原文解释这段网页选区'}：\n${selection}`;
        const answer = job.state.text;
        const source = { windowId: tab.windowId, tabId: tab.id, frameId: job.frameId, documentId: job.documentId!, url: job.url! };
        void opened.then(() => appendReadingTurn(source, job.id, prompt, answer, selection))
          .then(() => respond({ ok: true }), error => respond({ ok: false, error: message(error) }));
        return true;
      }
      if (input?.type === 'context:page-quote') {
        if (sender.id === chrome.runtime.id && sender.tab?.active && sender.tab.id !== undefined && sender.frameId !== undefined && sender.documentId && sender.url &&
            /^https?:\/\//u.test(sender.url) && typeof input.url === 'string' && typeof input.text === 'string' && input.text.length <= MAX_CHAT_QUOTE && input.text.trim()) {
          // The sender URL can retain the original address after history.pushState.
          // The chat worker checks the selected URL against the live frame.
          void stageChatPageQuote({ windowId: sender.tab.windowId, tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId, url: input.url }, input.text);
        }
        return;
      }
      if (input?.type === 'context:panel-pin') {
        const pin: unknown = input.pin;
        if (pin !== null && !validPanelPin(pin)) { respond({ ok: false }); return; }
        const write = panelPinQueue.then(async () => {
          await authorizedSender(sender);
          await secureStorage;
          if (pin === null) await chrome.storage.local.remove(CONTEXT_PANEL_PIN);
          else {
            const { left, top, width, height } = pin;
            await chrome.storage.local.set({ [CONTEXT_PANEL_PIN]: { left, top, width, height } });
          }
        });
        panelPinQueue = write.catch(() => {});
        void write.then(() => respond({ ok: true }), () => respond({ ok: false }));
        return true;
      }
      if (input?.type === 'context:selection-eligible') {
        void authorizedSender(sender).then(source => toolbarAllowed(source.url)).then(enabled => respond({ ok: true, enabled }), () => respond({ ok: true, enabled: false }));
        return true;
      }
      if (input?.type === 'context:toolbar-hide-site') {
        void authorizedSender(sender).then(source => setToolbarSiteHidden(new URL(source.url).hostname, true))
          .then(() => respond({ ok: true }), error => respond({ ok: false, error: message(error) }));
        return true;
      }
      if (input?.type === 'context:toolbar-sites' || input?.type === 'context:toolbar-restore-site') {
        if (!trustedPage(sender, 'options.html')) { respond({ ok: false, error: '仅阅窗设置可以管理隐藏网站。' }); return; }
        const update = input.type === 'context:toolbar-restore-site' && typeof input.hostname === 'string'
          ? setToolbarSiteHidden(input.hostname, false) : Promise.resolve();
        void update.then(hiddenToolbarSites).then(sites => respond({ ok: true, sites }), error => respond({ ok: false, error: message(error) }));
        return true;
      }
      if (input?.type === 'context:selection-start') {
        void startFromSelection(input, sender).then(respond, error => respond({ ok: false, error: message(error) }));
        return true;
      }
      if (input?.type === 'context:selection-dismiss') { dismissSelection(input, sender); respond({ ok: true }); return; }
      return;
    });
    chrome.permissions.onRemoved.addListener(() => { pendingSelections.clear(); for (const job of [...jobs.values()]) void close(job, '网站或接口权限已撤销。'); });
    const navigate = (details: { tabId: number; frameId: number; documentId?: string; url: string }) => {
      const pending = pendingSelections.get(details.tabId);
      if (pending && (details.frameId === 0 || details.frameId === pending.frameId)) pendingSelections.delete(details.tabId);
      const job = jobs.get(details.tabId);
      if (!job) return;
      if (details.frameId === 0 && job.frameId !== 0 || details.frameId === job.frameId && (details.documentId && details.documentId !== job.documentId || details.url !== job.url)) void close(job, '网页已导航，回答已关闭。');
    };
    chrome.webNavigation.onCommitted.addListener(navigate);
    chrome.webNavigation.onHistoryStateUpdated?.addListener(navigate);
    chrome.webNavigation.onReferenceFragmentUpdated?.addListener(navigate);
    chrome.tabs.onRemoved.addListener(tabId => { pendingSelections.delete(tabId); const job = jobs.get(tabId); if (job) void close(job, '标签页已关闭。', false); });
  }
  menuRegistration = (async () => {
    await removeMenu(CONTEXT_MENU_EXPLAIN); await removeMenu(CONTEXT_MENU_TRANSLATE);
    await createMenu(CONTEXT_MENU_EXPLAIN, '结合本文解释');
    await createMenu(CONTEXT_MENU_TRANSLATE, '翻译为中文');
  })().catch(error => { menuRegistration = undefined; throw error; });
  return menuRegistration;
}

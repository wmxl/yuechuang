import { allowedUrl, cacheKey, MAX_TEXT, validateSettings } from './core';
import { generate } from './model';
import { planSummary, summarizeArticle, type SummaryTransport } from './summary';
import { clearCache, clearKey, readCache, readConfig, saveConfig, secureStorage, writeCache, type Preview } from './store';
import type { Article, PreviewEvent, SettingsView } from './shared';
import { cancelContextTasks, forgetSavedPhrase, hasActiveContextTask, initializeContextMenus } from './context-background';
import { CONTEXT_PORT } from './context-shared';
import { listPhrases, deletePhrase } from './phrases';
import { cancelResearch, hasActiveResearch, initializeResearch } from './research-background';
import { RESEARCH_PORT } from './research-shared';
import { trustedPage } from './trusted-page';
import { cancelChat, initializeChat } from './chat-background';
import { CHAT_PORT } from './chat-shared';
import { getChatConnectionView, initializeChatConnection } from './chat-connection';
import { clearSiwcAccessToken, initializeSiwc, requestSiwc, requireSiwcModel } from './siwc-background';
import { SIWC_MAX_MESSAGE_CHARACTERS } from './siwc-protocol';

const FRAME_RULE = 870201;
let preview: Preview | undefined;
let port: chrome.runtime.Port | undefined;
let warning = '';
let frameFailure = '';
let previewQueue: Promise<unknown> = Promise.resolve();
let settingsQueue: Promise<unknown> = Promise.resolve();
let scriptsQueue: Promise<unknown> = Promise.resolve();
let operationVersion = 0;
type State = Extract<PreviewEvent, { type: 'summary:state' }>;
interface Task { id: string; previewId: string; identity?: string; usesSubscription?: boolean; controller: AbortController; state: State }
let task: Task | undefined;
let state: State | undefined;
let testController: AbortController | undefined;

void initializeContextMenus({
  beforeRequest: () => { cancel('已切换到选区解释或翻译。'); cancelResearch('已切换到选区解释或翻译。'); testController?.abort(); },
  configurationReady: () => settingsQueue,
  onUnavailable: reason => { void setWarning(reason).catch(() => {}); }
}).catch(() => { /* The existing preview remains usable if menu registration fails. */ });
initializeResearch({ configurationReady: () => settingsQueue, beforeRequest: () => { cancelContextTasks('已开始跨页研究。'); cancel('已开始跨页研究。'); testController?.abort(); } });
void initializeChat({ configurationReady: () => settingsQueue, beforeRequest: () => { testController?.abort(); } });
initializeChatConnection({ onConfigChange: () => {
  clearSiwcAccessToken();
  cancelChat('对话连接已变化，请重新发送。');
  cancelContextTasks('模型连接已变化，当前查阅已停止。');
  cancel('模型连接已变化，当前摘要已停止。');
} });
initializeSiwc({ onConfigChange: () => {
  cancelChat('ChatGPT 授权状态已变化，请重新发送。');
  cancelContextTasks('ChatGPT 授权状态已变化，当前查阅已停止。');
  if (task?.usesSubscription) cancel('ChatGPT 授权状态已变化，当前摘要已停止。');
} });

const ready = (async () => {
  await secureStorage;
  await removeFrameRule();
  const saved = await chrome.storage.session.get<{ preview?: Preview; warning?: string }>(['preview', 'warning']);
  warning = saved.warning || '';
  if (saved.preview?.mode === 'inline') {
    try {
      const tab = await chrome.tabs.get(saved.preview.tabId);
      const source = await chrome.webNavigation.getFrame({ tabId: saved.preview.tabId, frameId: 0 });
      if (tab.url && source?.documentId === saved.preview.sourceDocumentId && await permitted(tab.url)) {
        preview = { ...saved.preview, autoEligible: false, interrupted: !!saved.preview.activeTask, activeTask: false };
        await installFrameRule(tab.url, preview.url, tab.id!);
      }
    } catch { /* Discard stale browser-session metadata. */ }
  }
  await persist();
})();
function send(message: PreviewEvent) { try { port?.postMessage(message); } catch {} }
async function persist() {
  if (preview) await chrome.storage.session.set({ preview });
  else await chrome.storage.session.remove('preview');
}
async function setWarning(value: string) {
  warning = value;
  await chrome.storage.session.set({ warning });
  await chrome.action.setBadgeText({ text: value ? '!' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#b7472a' });
  await chrome.action.setTitle({ title: value || '打开阅窗侧边栏' });
}
async function permitted(url: string): Promise<boolean> {
  try { return await chrome.permissions.contains({ origins: [allowedUrl(url).origin + '/*'] }); } catch { return false; }
}
function trustedSettings(sender: chrome.runtime.MessageSender) {
  return trustedPage(sender, 'options.html');
}
function trustedPhrases(sender: chrome.runtime.MessageSender) {
  return trustedPage(sender, 'phrases.html');
}
async function sourceTab(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined || !sender.documentId || !sender.url) throw new Error('消息来源无效。');
  const [tab, frame] = await Promise.all([chrome.tabs.get(sender.tab.id), chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 })]);
  if (!tab.url || !frame || frame.documentId !== sender.documentId || !(await permitted(tab.url))) throw new Error('来源网页已导航或缺少访问权限，请刷新后重试。');
  if (new URL(sender.url).origin !== new URL(tab.url).origin) throw new Error('来源网页已导航。');
  return tab;
}
async function currentSource(sender: chrome.runtime.MessageSender) {
  const tab = await sourceTab(sender);
  if (!preview || tab.id !== preview.tabId || sender.documentId !== preview.sourceDocumentId) throw new Error('预览已关闭或来源页面已变化。');
  return tab;
}
async function currentFrame(current: Preview) {
  if (current.frameId === undefined || !current.documentId) return undefined;
  const frame = await chrome.webNavigation.getFrame({ tabId: current.tabId, frameId: current.frameId });
  if (!frame || frame.parentFrameId !== 0 || frame.documentId !== current.documentId || frame.url !== current.url || !(await permitted(frame.url))) return undefined;
  return frame;
}
function identity() { return preview ? `${preview.id}:${preview.tabId}:${preview.sourceDocumentId}:${preview.frameId}:${preview.documentId}:${preview.revision}` : ''; }
async function removeFrameRule() { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [FRAME_RULE] }); }
async function installFrameRule(sourceUrl: string, targetUrl: string, tabId: number) {
  await removeFrameRule();
  if (!(await permitted(sourceUrl)) || !(await permitted(targetUrl))) return;
  const rule = {
    id: FRAME_RULE, priority: 1,
    action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }] },
    condition: { tabIds: [tabId], initiatorDomains: [new URL(sourceUrl).hostname], requestDomains: [new URL(targetUrl).hostname], resourceTypes: ['sub_frame'], requestMethods: ['get'] }
  } as chrome.declarativeNetRequest.Rule;
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
}
function cancel(reason = '已停止生成。') {
  operationVersion++;
  if (!task) return;
  const previous = task; task = undefined; previous.controller.abort();
  if (preview?.documentId) chrome.tabs.sendMessage(preview.tabId, { type: 'frame:cancel', requestId: previous.id }, { documentId: preview.documentId }).catch(() => {});
  previous.state = { ...previous.state, status: 'cancelled', error: reason };
  state = previous.state; send(state);
  if (preview) { preview.activeTask = false; void persist(); }
}
async function view(): Promise<SettingsView> {
  const [{ settings, key }, permissions, cache] = await Promise.all([readConfig(), chrome.permissions.getAll(), readCache()]);
  return { settings, hasKey: !!key, permissions: permissions.origins || [], warning, cacheCount: cache.length };
}
async function closePreview(openTab = false) {
  const current = preview;
  if (!current) return;
  if (openTab) await chrome.tabs.create({ url: allowedUrl(current.url).href, windowId: current.sourceWindowId }).catch(() => chrome.tabs.create({ url: current.url }));
  cancel('预览已关闭。');
  const previous = port; port = undefined; previous?.disconnect();
  preview = undefined; state = undefined; frameFailure = '';
  await persist(); await removeFrameRule();
  await chrome.tabs.sendMessage(current.tabId, { type: 'preview:closed', previewId: current.id }, { documentId: current.sourceDocumentId }).catch(() => {});
}
async function openPreview(url: unknown, sender: chrome.runtime.MessageSender) {
  if (typeof url !== 'string' || url.length > 8192) throw new Error('链接无效。');
  const target = allowedUrl(url).href;
  const tab = await sourceTab(sender);
  await closePreview();
  const canRead = await permitted(target);
  await sourceTab(sender);
  const current: Preview = { mode: 'inline', id: crypto.randomUUID(), tabId: tab.id!, sourceDocumentId: sender.documentId!, sourceWindowId: tab.windowId, revision: 0, url: target, autoEligible: canRead, activeTask: false, interrupted: false };
  preview = current;
  try {
    await installFrameRule(tab.url!, target, tab.id!);
    await sourceTab(sender);
    if (preview !== current) throw new Error('来源网页或权限已变化，请重新拖动。');
    await persist();
    await setWarning(canRead ? '' : '目标域尚未授权。预览可尝试加载，读取正文和摘要需要目标域权限。');
    if (preview !== current) throw new Error('来源网页或权限已变化，请重新拖动。');
    return { ok: true, preview: { id: current.id, url: target }, warning };
  } catch (error) {
    if (preview === current) await closePreview();
    else await removeFrameRule();
    throw error;
  }
}
async function bindFrame(message: { name?: unknown }, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || !sender.frameId || !sender.documentId || !sender.url || !preview || sender.tab.id !== preview.tabId) throw new Error('非当前预览目标。');
  const current = preview;
  const [frame, source] = await Promise.all([
    chrome.webNavigation.getFrame({ tabId: current.tabId, frameId: sender.frameId }),
    chrome.webNavigation.getFrame({ tabId: current.tabId, frameId: 0 })
  ]);
  if (preview !== current || source?.documentId !== current.sourceDocumentId || !frame || frame.parentFrameId !== 0 || frame.documentId !== sender.documentId || frame.url !== sender.url || !(await permitted(frame.url)) || preview !== current) throw new Error('目标文档或权限无效。');
  const named = message.name === `local-reader-${current.id}`;
  if (!named && current.frameId !== sender.frameId) throw new Error('非预览 iframe。');
  if (current.frameId === undefined && frame.url !== current.url) throw new Error('初次预览目标已变化，请在标签页打开，或重新拖动最终链接。');
  if (current.frameId !== undefined && current.frameId !== sender.frameId) throw new Error('目标 iframe 已绑定。');
  const changed = current.documentId && (current.documentId !== sender.documentId || current.url !== frame.url);
  if (changed) {
    cancel('目标网页已导航，旧摘要已停止。');
    current.revision++; current.autoEligible = false; current.interrupted = false; state = undefined;
    send({ type: 'preview:reset' });
  }
  current.frameId = sender.frameId; current.documentId = sender.documentId; current.url = frame.url; frameFailure = '';
  await persist();
  if (preview !== current) throw new Error('预览已更换。');
  send({ type: 'preview:page', previewId: current.id, revision: current.revision, url: current.url, status: 'ready' });
  return { ok: true, previewId: current.id };
}
function checkTask(current: Task) {
  if (task !== current || current.controller.signal.aborted || preview?.id !== current.previewId) throw new DOMException('Aborted', 'AbortError');
}
async function waitTarget(current: Task) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    checkTask(current);
    if (frameFailure) throw new Error(frameFailure);
    if (preview && await currentFrame(preview)) return preview;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  throw new Error('目标网页尚未就绪，或站点策略阻止嵌入。请重试，或点击“在标签页打开”阅读。');
}
function validateArticle(value: unknown, url: string): Article {
  const article = value as Article;
  if (!article || typeof article.text !== 'string' || article.text.length < 160 || article.text.length > MAX_TEXT || article.url !== url || typeof article.title !== 'string' || article.title.length > 500 || article.truncated) throw new Error('正文不足、超过安全上限或目标已变化，请重新读取。');
  return { title: article.title, url, text: article.text, originalLength: article.text.length, truncated: false,
    description: typeof article.description === 'string' ? article.description.slice(0, 3000) : undefined,
    headings: Array.isArray(article.headings) ? article.headings.filter((x): x is string => typeof x === 'string').slice(0, 200).map(x => x.slice(0, 300)) : undefined,
    coverage: article.coverage === 'partial' ? 'partial' : 'visible', notice: typeof article.notice === 'string' ? article.notice.slice(0, 1000) : undefined };
}
async function summarize(message: { force?: boolean; automatic?: boolean; allowMultiple?: boolean }, sourcePort: chrome.runtime.Port) {
  await currentSource(sourcePort.sender!);
  if (port !== sourcePort || !preview) return;
  if (task && task.previewId === preview.id && !message.force) { send(task.state); return; }
  if (message.automatic && !preview.autoEligible) { if (state) send(state); return; }
  preview.autoEligible = false;
  if (!message.automatic) {
    cancelResearch('已切换到文章摘要。');
    cancelContextTasks('已切换到文章摘要。');
    cancel(); testController?.abort();
  }
  const current: Task = { id: crypto.randomUUID(), previewId: preview.id, controller: new AbortController(), state: { type: 'summary:state', requestId: '', status: 'reading', text: '' } };
  current.state.requestId = current.id; task = current; state = current.state;
  preview.activeTask = true; await persist(); checkTask(current); send(current.state);
  try {
    const target = await waitTarget(current); checkTask(current);
    current.identity = identity();
    const result = await chrome.tabs.sendMessage(target.tabId, { type: 'frame:extract', previewId: target.id, requestId: current.id }, { documentId: target.documentId! });
    checkTask(current);
    if (identity() !== current.identity || !(await currentFrame(target))) throw new Error('目标网页已变化，请重新读取。');
    if (!result?.ok) throw new Error(result?.message || '未取得足够正文，请稍后重试。');
    const article = validateArticle(result.article, target.url);
    const { text: _text, ...metadata } = article;
    send({ type: 'preview:article', article: metadata });
    await settingsQueue; checkTask(current);
    const { config: connection } = await getChatConnectionView(); checkTask(current);
    current.usesSubscription = connection.provider === 'chatgptOAuth';
    const { settings, key } = await readConfig(); checkTask(current);
    if (!current.usesSubscription) {
      if (!settings.baseUrl || !settings.model || !key) throw new Error('请先在设置中填写接口、模型和 API Key。原网页仍可阅读。');
      if (!(await permitted(settings.baseUrl))) throw new Error('缺少模型接口域权限，请在 Chrome 的扩展详情中检查阅窗的网站访问权限。');
      checkTask(current);
    }
    const subscription = current.usesSubscription ? await requireSiwcModel(current.controller.signal) : undefined;
    checkTask(current);
    const ck = await cacheKey(article.url, JSON.stringify(article), settings, key, subscription); checkTask(current);
    const cached = message.force ? undefined : (await readCache()).find(entry => entry.key === ck); checkTask(current);
    const transport: SummaryTransport | undefined = subscription ? {
      maxMessageCharacters: SIWC_MAX_MESSAGE_CHARACTERS,
      complete: (input, signal, onText) => requestSiwc(input, signal, onText, undefined, 'summary'),
    } : undefined;
    const plan = planSummary(article, settings, transport?.maxMessageCharacters);
    if (cached) {
      send({ type: 'summary:plan', plan: { ...plan, requests: 0 }, needsConfirmation: false });
      state = current.state = { ...current.state, status: 'done', text: cached.text, cached: true }; send(state); return;
    }
    const needsConfirmation = plan.requests > 1 && !message.allowMultiple && !settings.autoLongSummary;
    if (needsConfirmation) {
      state = current.state = { ...current.state, status: 'planned', error: `全文需要预计 ${plan.requests} 次模型调用。确认后按全部已读取正文分段处理。` };
      send(state); send({ type: 'summary:plan', plan, needsConfirmation: true }); return;
    }
    preview!.interrupted = false;
    await persist(); checkTask(current);
    if (message.automatic && (hasActiveResearch() || hasActiveContextTask() || testController && !testController.signal.aborted)) {
      throw new Error('其他模型任务正在进行。任务结束后可点击「总结」。');
    }
    state = current.state = { ...current.state, status: 'running', text: '' }; send(state);
    send({ type: 'summary:plan', plan, needsConfirmation: false });
    const text = await summarizeArticle(settings, key, article, current.controller.signal, text => {
      if (task === current && identity() === current.identity) { state = current.state = { ...current.state, text }; send(state); }
    }, progress => { if (task === current && identity() === current.identity) send({ type: 'summary:progress', progress }); },
    transport);
    checkTask(current);
    if (identity() !== current.identity) return;
    await writeCache(ck, text); checkTask(current);
    state = current.state = { ...current.state, status: 'done', text }; send(state);
  } catch (error) {
    if (task !== current || current.controller.signal.aborted || preview?.id !== current.previewId) return;
    state = current.state = { ...current.state, status: 'error', error: safeError(error) }; send(state);
  } finally {
    if (task === current) { task = undefined; if (preview) { preview.activeTask = false; await persist(); } }
  }
}
function safeError(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试。'; }

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (typeof message?.type === 'string' && (message.type.startsWith('context:') || message.type.startsWith('research:') || message.type.startsWith('chat:') || message.type.startsWith('connection:') || message.type.startsWith('webchat:') || message.type.startsWith('siwc:'))) return;
  void (async () => {
    await ready;
    if (!message || typeof message.type !== 'string') throw new Error('消息格式无效。');
    if (message.type.startsWith('phrases:')) {
      if (!trustedPhrases(sender)) throw new Error('只有扩展收藏夹可以查看或管理词句。');
      if (message.type === 'phrases:list') return { ok: true, entries: await listPhrases() };
      if (message.type === 'phrases:delete') { await deletePhrase(message.id); forgetSavedPhrase(message.id); return { ok: true }; }
      throw new Error('未知的收藏操作。');
    }
    if (message.type === 'settings:open') { if (!trustedSettings(sender)) await currentSource(sender); await chrome.runtime.openOptionsPage(); return { ok: true }; }
    if (message.type.startsWith('settings:')) {
      if (!trustedSettings(sender)) throw new Error('只有扩展设置页可以管理配置。');
      if (message.type === 'settings:get') return { ok: true, ...await view() };
      if (message.type === 'settings:export') return { ok: true, settings: (await readConfig()).settings };
      if (message.type === 'settings:save' || message.type === 'settings:clear-key') {
        cancelChat('配置或 Key 已变化，对话已停止。');
        cancelResearch('配置或 Key 已变化，研究已停止。');
        cancelContextTasks('配置已变化，当前回答已停止。');
        cancel('配置已变化，当前摘要已停止。'); testController?.abort();
        const next = settingsQueue.then(async () => {
          if (message.type === 'settings:save') {
            const settings = validateSettings(message.settings);
            if (message.key !== undefined && typeof message.key !== 'string') throw new Error('Key 格式无效。');
            await saveConfig(settings, message.key);
          } else await clearKey();
          cancelContextTasks('配置已变化，当前回答已停止。');
          cancelChat('配置已变化，对话已停止。');
          cancelResearch('配置已变化，研究已停止。');
          await clearCache(); return { ok: true, ...await view() };
        }); settingsQueue = next.catch(() => {}); return next;
      }
      if (message.type === 'settings:clear-cache') { await clearCache(); return { ok: true, ...await view() }; }
      if (message.type === 'settings:test') {
        cancelChat('连接测试已开始，对话已停止。');
        cancelResearch('连接测试已开始，研究已停止。');
        cancelContextTasks('连接测试已开始，当前回答已停止。');
        await settingsQueue;
        const version = operationVersion;
        const { settings, key } = await readConfig();
        if (!settings.baseUrl || !settings.model || !key) throw new Error('请先填写接口地址、模型和 API Key。');
        if (!(await permitted(settings.baseUrl))) throw new Error('缺少接口域权限，请在 Chrome 的扩展详情中检查网站访问权限。');
        if (version !== operationVersion) throw new Error('配置已变化，请重新测试。');
        cancel('连接测试已开始，摘要任务已停止。'); testController?.abort();
        cancelContextTasks('连接测试已开始，当前回答已停止。');
        cancelChat('连接测试已开始，对话已停止。');
        const controller = new AbortController(); testController = controller;
        try { return { ok: true, text: await generate(settings, key, null, controller.signal, () => {}) }; }
        finally { if (testController === controller) testController = undefined; }
      }
      throw new Error('未知的设置操作。');
    }
    if (message.type === 'page:hello') {
      try { await sourceTab(sender); return { ok: true, enabled: true }; } catch { return { ok: true, enabled: false }; }
    }
    if (message.type === 'frame:hello') return bindFrame(message, sender);
    if (message.type === 'preview:open') {
      const next = previewQueue.then(() => openPreview(message.url, sender)); previewQueue = next.catch(() => {}); return next;
    }
    if (message.type === 'preview:close' || message.type === 'preview:open-tab') {
      await currentSource(sender);
      if (!preview || message.previewId !== preview.id) throw new Error('预览已更换。');
      const id = preview.id;
      const next = previewQueue.then(async () => { if (preview?.id === id) await closePreview(message.type === 'preview:open-tab'); }); previewQueue = next.catch(() => {}); await next;
      return { ok: true };
    }
    throw new Error('不支持的操作。');
  })().then(respond).catch(error => respond({ ok: false, error: safeError(error) }));
  return true;
});

chrome.runtime.onConnect.addListener(connection => {
  if (connection.name === CONTEXT_PORT || connection.name === RESEARCH_PORT || connection.name === CHAT_PORT) return;
  if (connection.name !== 'preview') { connection.disconnect(); return; }
  let connected = true;
  connection.onDisconnect.addListener(() => { connected = false; if (port === connection) { cancel('摘要连接已中断，请手动重试。'); port = undefined; } });
  const bound = (async () => {
    await ready; await currentSource(connection.sender!);
    if (!connected || !preview) throw new Error('非当前预览。');
    const id = preview.id;
    const previous = port; port = undefined; previous?.disconnect(); port = connection;
    connection.postMessage({ type: 'preview:init', previewId: id, revision: preview.revision, url: preview.url, autoSummary: preview.autoEligible && !task && !state, interrupted: preview.interrupted } satisfies PreviewEvent);
    connection.postMessage({ type: 'preview:page', previewId: id, revision: preview.revision, url: preview.url, status: frameFailure ? 'error' : preview.documentId ? 'ready' : 'loading', error: frameFailure || undefined } satisfies PreviewEvent);
    if (state) connection.postMessage(state);
  })();
  bound.catch(() => connection.disconnect());
  connection.onMessage.addListener(message => {
    void (async () => {
      await bound;
      if (!connected || port !== connection || !preview) return;
      const id = preview.id;
      await currentSource(connection.sender!);
      if (!connected || port !== connection || preview?.id !== id) return;
      if (message.type === 'summary:start') await summarize(message, connection);
      else if (message.type === 'summary:stop') cancel();
      else if (message.type === 'summary:status') { if (state) send(state); }
      else if (message.type === 'preview:close' || message.type === 'preview:open-tab') {
        const next = previewQueue.then(async () => { if (preview?.id === id) await closePreview(message.type === 'preview:open-tab'); }); previewQueue = next.catch(() => {}); await next;
      } else if (message.type === 'settings:open') await chrome.runtime.openOptionsPage();
    })().catch(error => { if (port === connection) send({ type: 'summary:state', requestId: task?.id || crypto.randomUUID(), status: 'error', text: state?.text || '', error: safeError(error) }); });
  });
});

async function refreshScripts() {
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = origins.filter(origin => /^https?:\/\//.test(origin));
  await chrome.scripting.unregisterContentScripts().catch(() => {});
  if (matches.length) await chrome.scripting.registerContentScripts([{ id: 'reader', matches, js: ['content.js'], runAt: 'document_idle', allFrames: true, persistAcrossSessions: true }]);
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined) continue;
    if (tab.url && await permitted(tab.url)) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
    chrome.tabs.sendMessage(tab.id, { type: 'permissions:changed' }).catch(() => {});
  }
}
function scheduleScripts() { const next = scriptsQueue.then(() => ready).then(refreshScripts); scriptsQueue = next.catch(() => {}); return next; }
chrome.permissions.onAdded.addListener(() => { void scheduleScripts().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => {
  cancelChat('接口或网站权限已撤销，对话已停止。');
  void (async () => { await ready; testController?.abort(); await closePreview(); await setWarning('网站权限已改变，请在 Chrome 的扩展详情中检查阅窗的网站访问权限。'); await scheduleScripts(); })().catch(() => {});
});
chrome.webNavigation.onCommitted.addListener(details => {
  void (async () => {
    await ready;
    if (!preview || details.tabId !== preview.tabId) return;
    if (details.frameId === 0) { if (details.documentId !== preview.sourceDocumentId) await closePreview(); return; }
    if (details.frameId !== preview.frameId || details.documentId === preview.documentId) return;
    cancel('目标网页已导航，旧摘要已停止。');
    preview.revision++; preview.documentId = undefined; preview.url = details.url; preview.autoEligible = false; preview.interrupted = false; state = undefined; frameFailure = '';
    const current = preview, revision = preview.revision;
    await persist();
    if (preview !== current || current.revision !== revision) return;
    send({ type: 'preview:reset' });
    send({ type: 'preview:page', previewId: current.id, revision, url: current.url, status: 'loading' });
    const canRead = await permitted(details.url);
    if (preview !== current || current.revision !== revision) return;
    if (!canRead) {
      frameFailure = '最终目标域未授权，无法读取正文。可检查 Chrome 的网站访问权限，或在普通标签页阅读。';
      send({ type: 'preview:page', previewId: current.id, revision, url: current.url, status: 'error', error: frameFailure });
    }
  })().catch(() => {});
});
chrome.webNavigation.onErrorOccurred.addListener(details => {
  void ready.then(() => {
    if (!preview || details.tabId !== preview.tabId || details.frameId === 0 || (details.frameId !== preview.frameId && details.url !== preview.url)) return;
    frameFailure = '该网页未能在页内加载，可能被站点 CSP 或访问策略阻止。可在普通标签页打开；扩展不会移除 CSP 或访问限制。';
    send({ type: 'preview:page', previewId: preview.id, revision: preview.revision, url: preview.url, status: 'error', error: frameFailure });
  });
});
chrome.tabs.onRemoved.addListener(tabId => { void ready.then(async () => { if (preview?.tabId === tabId) await closePreview(); }); });
// Chrome handles the toolbar gesture directly, without navigating to settings.
if (chrome.sidePanel) void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => setWarning('侧边栏初始化失败，请重新加载扩展后重试。'));
chrome.runtime.onInstalled.addListener(() => { void scheduleScripts().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void scheduleScripts().catch(() => {}); });

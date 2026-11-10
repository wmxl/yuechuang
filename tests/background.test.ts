import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULT_SETTINGS, type Article, type PreviewEvent, type Settings } from '../src/shared.ts';

type Message = Record<string, unknown>;
type Reply = { ok: boolean; error?: string; [key: string]: unknown };
class EventHub<Args extends unknown[]> {
  listeners: ((...args: Args) => unknown)[] = [];
  addListener(listener: (...args: Args) => unknown) { this.listeners.push(listener); }
  emit(...args: Args) { for (const listener of [...this.listeners]) listener(...args); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function gate() { return { reached: deferred(), release: deferred() }; }
type Gate = ReturnType<typeof gate>;
const ID = 'test-inline-reader', OPTIONS = `chrome-extension://${ID}/options.html`, SOURCE = 'https://source.test/index', TARGET = 'https://article.test/a', NEXT = 'https://article.test/b', API = 'https://model.test/v1', KEY = 'test-only-key-never-real';
const config: Settings = { ...DEFAULT_SETTINGS, baseUrl: API, model: 'mock', inputBudgetTokens: 16000 };
const local: Record<string, unknown> = {}, session: Record<string, unknown> = {};
const granted = new Set<string>();
type Frame = { url: string; documentId: string; parentFrameId: number; errorOccurred: boolean };
const frames = new Map<number, Frame>();
const requests: { url: string; init: RequestInit }[] = [];
const messages: { tabId: number; message: Message; options?: { documentId?: string } }[] = [];
const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
const ruleChanges: { removeRuleIds?: number[]; addRules?: chrome.declarativeNetRequest.Rule[] }[] = [];
const ports: PortMock[] = [], activeGates: Gate[] = [];
const panelBehaviors: { openPanelOnActionClick: boolean }[] = [];
let configGate: Gate | undefined, extractGate: Gate | undefined, sourceGate: Gate | undefined, fetchGate: Gate | undefined, permissionGate: Gate | undefined;
let currentArticle: Article;
const runtimeMessage = new EventHub<[Message, chrome.runtime.MessageSender, (reply: Reply) => void]>(), runtimeConnect = new EventHub<[chrome.runtime.Port]>();
const committed = new EventHub<[{ tabId: number; frameId: number; documentId: string; url: string }]>(), navigationError = new EventHub<[{ tabId: number; frameId: number; url: string; error: string }]>();
const permissionsAdded = new EventHub<[chrome.permissions.Permissions]>(), permissionsRemoved = new EventHub<[chrome.permissions.Permissions]>(), tabsRemoved = new EventHub<[number]>();
function paused() { const value = gate(); activeGates.push(value); return value; }
function area(data: Record<string, unknown>, name: 'local'|'session') {
  return {
    async setAccessLevel(value: { accessLevel: string }) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); },
    async get(keys: string|string[]) {
      const names = Array.isArray(keys) ? keys : [keys];
      const result = structuredClone(Object.fromEntries(names.filter(key => key in data).map(key => [key, data[key]])));
      if (name === 'local' && names.includes('settings') && configGate) { const pause = configGate; configGate = undefined; pause.reached.resolve(); await pause.release.promise; }
      return result;
    },
    async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); },
    async remove(keys: string|string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
}
const mockChrome = {
  runtime: { id: ID, getURL: (path: string) => `chrome-extension://${ID}/${path}`, onMessage: runtimeMessage, onConnect: runtimeConnect, onInstalled: new EventHub<[]>(), onStartup: new EventHub<[]>(), async openOptionsPage() {} },
  storage: { local: area(local, 'local'), session: area(session, 'session') },
  action: { onClicked: new EventHub<[]>(), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  sidePanel: { async setPanelBehavior(behavior: { openPanelOnActionClick: boolean }) { panelBehaviors.push(behavior); } },
  contextMenus: { onClicked: new EventHub<[chrome.contextMenus.OnClickData, chrome.tabs.Tab | undefined]>(),
    create(value: { id: string }, done?: () => void) { done?.(); return value.id; }, remove(_id: string, done?: () => void) { done?.(); } },
  permissions: { onAdded: permissionsAdded, onRemoved: permissionsRemoved,
    async contains({ origins }: { origins: string[] }) { const allowed = origins.every(origin => granted.has(origin) || (origin.startsWith('https:') && granted.has('https://*/*'))); if (permissionGate) { const pause = permissionGate; permissionGate = undefined; pause.reached.resolve(); await pause.release.promise; } return allowed; }, async getAll() { return { origins: [...granted] }; } },
  tabs: { onRemoved: tabsRemoved, onUpdated: new EventHub<[number, chrome.tabs.OnUpdatedInfo]>(),
    async get(tabId: number) { if (tabId !== 1) throw new Error('No tab'); return { id: 1, windowId: 5, url: SOURCE }; },
    async query() { return [{ id: 1, windowId: 5, url: SOURCE }]; }, async create(value: unknown) { return value; },
    async sendMessage(tabId: number, message: Message, options?: { documentId?: string }) {
      messages.push(structuredClone({ tabId, message, options }));
      if (message.type !== 'frame:extract') return undefined;
      assert.equal(tabId, 1); assert.equal(options?.documentId, frames.get(42)?.documentId, 'extract addresses the exact target document');
      const result = structuredClone({ ok: true, article: currentArticle });
      if (extractGate) { const pause = extractGate; extractGate = undefined; pause.reached.resolve(); await pause.release.promise; }
      return result;
    }
  },
  alarms: { onAlarm: new EventHub<[chrome.alarms.Alarm]>(), async clear() { return true; } },
  webNavigation: { onBeforeNavigate: new EventHub<[chrome.webNavigation.WebNavigationBaseCallbackDetails]>(), onCommitted: committed, onErrorOccurred: navigationError,
    async getFrame({ tabId, frameId }: { tabId: number; frameId: number }) {
      if (tabId !== 1) return undefined;
      const snapshot = structuredClone(frames.get(frameId));
      if (frameId === 0 && sourceGate) { const pause = sourceGate; sourceGate = undefined; pause.reached.resolve(); await pause.release.promise; }
      return snapshot;
    }
  },
  declarativeNetRequest: { async updateSessionRules(change: { removeRuleIds?: number[]; addRules?: chrome.declarativeNetRequest.Rule[] }) {
    ruleChanges.push(structuredClone(change)); for (const id of change.removeRuleIds ?? []) rules.delete(id); for (const rule of change.addRules ?? []) rules.set(rule.id, structuredClone(rule));
  } },
  scripting: { async unregisterContentScripts() {}, async registerContentScripts() {}, async executeScript() {} }
};
class PortMock {
  name = 'preview'; sent: PreviewEvent[] = []; disconnected = false;
  onMessage = new EventHub<[Message]>(); onDisconnect = new EventHub<[]>();
  constructor(public sender: chrome.runtime.MessageSender) { ports.push(this); }
  postMessage(message: PreviewEvent) { if (this.disconnected) throw new Error('Disconnected'); this.sent.push(structuredClone(message)); }
  disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } }
  command(message: Message) { this.onMessage.emit(message); }
}
async function settle() { for (let index = 0; index < 6; index++) await nextTurn(); }
async function waitFor(predicate: () => boolean, name: string) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`等待超时：${name}`); await nextTurn(); } }
function settingsSender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender { return { id: ID, url: OPTIONS, frameId: 0, ...overrides }; }
function send(message: Message, sender = settingsSender()): Promise<Reply> { return new Promise(resolve => runtimeMessage.emit(message, sender, resolve)); }
function frameSender(frameId: number, overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  const frame = frames.get(frameId)!; return { id: ID, url: frame.url, frameId, documentId: frame.documentId, tab: { id: 1, windowId: 5, url: SOURCE } as chrome.tabs.Tab, ...overrides };
}
function article(url = TARGET, tail = 'ACTUAL_A_ONLY'): Article { const text = 'Actual visible article facts about browser scheduling and causal evidence. '.repeat(8) + tail; return { title: 'Visible article', url, text, originalLength: text.length, truncated: false, coverage: 'visible' }; }
function livePreview() { return session.preview as { id: string; url: string; tabId: number; activeTask: boolean; autoEligible: boolean }; }
async function open(url = TARGET) { const result = await send({ type: 'preview:open', url }, frameSender(0)); assert.equal(result.ok, true, result.error); return result.preview as { id: string; url: string }; }
async function bind(id: string, url = TARGET, documentId = 'target-document') { frames.set(42, { url, documentId, parentFrameId: 0, errorOccurred: false }); const result = await send({ type: 'frame:hello', name: `local-reader-${id}` }, frameSender(42)); assert.equal(result.ok, true, result.error); }
async function connect(sender = frameSender(0)) { const port = new PortMock(sender); runtimeConnect.emit(port as unknown as chrome.runtime.Port); await waitFor(() => port.disconnected || port.sent.some(event => event.type === 'preview:init'), 'source Port 初始化'); return port; }
async function opened() { const preview = await open(); await bind(preview.id); const port = await connect(); assert.equal(port.disconnected, false); return { preview, port }; }
function states(port: PortMock) { return port.sent.filter((event): event is Extract<PreviewEvent, { type: 'summary:state' }> => event.type === 'summary:state'); }
async function finish(port: PortMock, after = 0) { await waitFor(() => states(port).slice(after).some(event => ['done', 'error', 'planned', 'cancelled'].includes(event.status)), 'summary 终态'); return states(port).at(-1)!; }

before(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = mockChrome;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (fetchGate) { const pause = fetchGate; fetchGate = undefined; pause.reached.resolve(); await new Promise<void>((resolve, reject) => { pause.release.promise.then(resolve); init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }); }
    const body = JSON.parse(init!.body as string), markers = [...new Set((body.messages[1].content as string).match(/ACTUAL_[AB]_ONLY|TAIL_ONLY_[AB]|FINAL_TAIL_SENTINEL/g) ?? [])], text = markers.join(' ') || 'MOCK_NOTE';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  await import('../src/background.ts');
});
beforeEach(async () => {
  for (const value of activeGates) value.release.resolve(); activeGates.length = 0; configGate = extractGate = sourceGate = fetchGate = permissionGate = undefined;
  for (const port of ports) port.disconnect(); committed.emit({ tabId: 1, frameId: 0, documentId: 'cleanup', url: SOURCE }); await settle();
  for (const key of Object.keys(local)) delete local[key]; for (const key of Object.keys(session)) delete session[key]; local.settings = structuredClone(config); session.apiKey = KEY;
  frames.clear(); frames.set(0, { url: SOURCE, documentId: 'source-document', parentFrameId: -1, errorOccurred: false }); frames.set(9, { url: TARGET, documentId: 'ordinary-frame', parentFrameId: 0, errorOccurred: false });
  currentArticle = article(); granted.clear(); for (const url of [SOURCE, TARGET, API]) granted.add(new URL(url).origin + '/*');
  requests.length = 0; messages.length = 0; ruleChanges.length = 0; rules.clear(); ports.length = 0;
});

test('only trusted settings can access configuration; exports and preview events never expose Key', async () => {
  for (const sender of [frameSender(0), frameSender(9), settingsSender({ id: 'other' }), settingsSender({ frameId: 1 })]) for (const type of ['settings:get', 'settings:export', 'settings:save', 'settings:clear-key', 'settings:clear-cache', 'settings:test']) assert.equal((await send({ type, settings: config, key: 'replacement' }, sender)).ok, false);
  assert.equal(session.apiKey, KEY); assert.equal(requests.length, 0);
  const view = await send({ type: 'settings:get' }, settingsSender({ url: OPTIONS + '#top' })); assert.equal(view.ok, true); assert.equal(view.hasKey, true); assert.ok(!JSON.stringify(view).includes(KEY));
  assert.deepEqual(await send({ type: 'settings:export' }), { ok: true, settings: config });
});
test('toolbar opens the native side panel and does not attach a settings-page action listener', () => {
  assert.deepEqual(panelBehaviors, [{ openPanelOnActionClick: true }]);
  assert.equal(mockChrome.action.onClicked.listeners.length, 0);
});
test('packaged panel frames retain narrow roles and never return credentials', async () => {
  const panelSettings = settingsSender({ url: OPTIONS + '?panel=1', frameId: 7, origin: `chrome-extension://${ID}` });
  const view = await send({ type: 'settings:get' }, panelSettings); assert.equal(view.ok, true); assert.equal(view.hasKey, true); assert.ok(!JSON.stringify(view).includes(KEY));
  assert.equal((await send({ type: 'phrases:list' }, panelSettings)).ok, false);
  assert.equal((await send({ type: 'settings:get' }, { ...panelSettings, origin: 'https://source.test' })).ok, false);
  assert.equal((await send({ type: 'settings:get' }, settingsSender({ url: `chrome-extension://${ID}/sidepanel.html` }))).ok, false);
  const library = settingsSender({ url: `chrome-extension://${ID}/phrases.html?panel=1`, frameId: 8, origin: `chrome-extension://${ID}` });
  assert.deepEqual(await send({ type: 'phrases:list' }, library), { ok: true, entries: [] });
  assert.equal((await send({ type: 'settings:get' }, library)).ok, false); assert.equal(requests.length, 0);
});
test('a connection test cancels chat that starts while the test awaits configuration', async () => {
  const reading = paused(); configGate = reading;
  const pendingTest = send({ type: 'settings:test' }); await reading.reached.promise;
  const hold = paused(); fetchGate = hold;
  const chat = {
    name: 'chat', sender: settingsSender({ url: `chrome-extension://${ID}/sidepanel.html`, documentId: 'chat-test-document' }),
    sent: [] as Message[], onMessage: new EventHub<[Message]>(), onDisconnect: new EventHub<[]>(),
    postMessage(message: Message) { this.sent.push(structuredClone(message)); }, disconnect() { this.onDisconnect.emit(); }
  };
  runtimeConnect.emit(chat as unknown as chrome.runtime.Port);
  chat.onMessage.emit({ type: 'chat:send', text: '解释消息队列。' }); await hold.reached.promise;
  assert.equal(requests.length, 1); assert.equal(requests[0].init.signal?.aborted, false);
  reading.release.resolve(); const result = await pendingTest;
  assert.equal(result.ok, true, result.error); assert.equal(requests.length, 2);
  assert.equal(requests[0].init.signal?.aborted, true); assert.ok(chat.sent.some(state => state.status === 'cancelled'));
  hold.release.resolve(); chat.disconnect();
});

test('only the exact top-level collection page can list or delete local phrases, without Key or model calls', async () => {
  const source = { id: ID, url: `chrome-extension://${ID}/phrases.html`, frameId: 0 };
  const entry = { id: 'saved-test', text: 'coherence', context: 'The nearby paragraph.', sourceTitle: 'Article', sourceUrl: TARGET, mode: 'explain', coreText: 'A related concept.', detailsText: '', createdAt: 1, updatedAt: 1 };
  local.savedPhrases = [entry];
  for (const sender of [frameSender(0), frameSender(9), settingsSender(), { ...source, id: 'other' }, { ...source, frameId: 1 }, { ...source, url: source.url + '?forged' }]) {
    for (const type of ['phrases:list', 'phrases:delete']) assert.equal((await send({ type, id: entry.id }, sender)).ok, false);
  }
  assert.deepEqual(local.savedPhrases, [entry]);
  const listed = await send({ type: 'phrases:list' }, { ...source, url: source.url + '#top' });
  assert.deepEqual(listed, { ok: true, entries: [entry] }); assert.ok(!JSON.stringify(listed).includes(KEY));
  assert.equal((await send({ type: 'settings:get' }, source)).ok, false);
  assert.equal((await send({ type: 'phrases:delete', id: entry.id }, source)).ok, true);
  assert.deepEqual(local.savedPhrases, []); assert.equal(requests.length, 0); assert.equal(session.apiKey, KEY);
});
test('preview requires current browser top document; ordinary, stale, and nested frames cannot bind', async () => {
  for (const sender of [frameSender(9), frameSender(0, { documentId: 'stale' }), frameSender(0, { id: 'other' }), frameSender(0, { documentId: undefined })]) assert.equal((await send({ type: 'preview:open', url: TARGET }, sender)).ok, false);
  assert.equal(session.preview, undefined); assert.equal(rules.size, 0); const preview = await open();
  assert.equal((await send({ type: 'frame:hello', name: 'ordinary' }, frameSender(9))).ok, false);
  assert.equal((await send({ type: 'frame:hello', name: `local-reader-${preview.id}` }, frameSender(9, { documentId: 'spoof' }))).ok, false);
  frames.set(10, { url: TARGET, documentId: 'nested', parentFrameId: 9, errorOccurred: false }); assert.equal((await send({ type: 'frame:hello', name: `local-reader-${preview.id}` }, frameSender(10))).ok, false); assert.equal(requests.length, 0);
});
test('summary reads exact target document and ignores a forged Article sent by the source', async () => {
  const { port } = await opened(); for (const sender of [frameSender(42), frameSender(9)]) assert.equal((await connect(sender)).disconnected, true);
  port.command({ type: 'summary:start', article: { ...article(), text: 'FORGED_SOURCE_ARTICLE'.repeat(50) } }); const result = await finish(port);
  assert.equal(result.status, 'done'); assert.match(result.text, /ACTUAL_A_ONLY/); assert.equal(requests.length, 1);
  const extraction = messages.filter(item => item.message.type === 'frame:extract'); assert.equal(extraction.length, 1); assert.deepEqual(extraction[0].options, { documentId: 'target-document' });
  assert.ok(!String(requests[0].init.body).includes('FORGED_SOURCE_ARTICLE')); assert.ok(!JSON.stringify(messages).includes(KEY)); assert.ok(!JSON.stringify(port.sent).includes(KEY)); assert.equal(requests[0].url, API + '/chat/completions');
});

test('a new preview auto-summarizes once even when the old setting was off', async () => {
  local.settings = { ...config, autoSummary: false };
  const { port } = await opened();
  const init = port.sent.find(event => event.type === 'preview:init');
  assert.equal(init?.autoSummary, true);
  assert.deepEqual(await send({ type: 'settings:export' }), { ok: true, settings: config });
  port.command({ type: 'summary:start', automatic: true });
  assert.equal((await finish(port)).status, 'done');
  const reconnect = await connect();
  assert.equal(reconnect.sent.find(event => event.type === 'preview:init')?.autoSummary, false);
  reconnect.command({ type: 'summary:start', automatic: true });
  await settle();
  assert.equal(messages.filter(item => item.message.type === 'frame:extract').length, 1);
  assert.equal(requests.length, 1);
});

test('automatic summary leaves an active connection test running and supports a manual summary afterward', async () => {
  const pending = paused(); fetchGate = pending;
  const connectionTest = send({ type: 'settings:test' }); await pending.reached.promise;
  const { port } = await opened();
  port.command({ type: 'summary:start', automatic: true });
  const skipped = await finish(port);
  assert.equal(skipped.status, 'error'); assert.match(skipped.error!, /其他模型任务正在进行/);
  assert.equal(requests.length, 1); assert.equal(requests[0].init.signal?.aborted, false);
  pending.release.resolve();
  assert.equal((await connectionTest).ok, true);
  const baseline = states(port).length;
  port.command({ type: 'summary:start' });
  assert.equal((await finish(port, baseline)).status, 'done');
  assert.equal(requests.length, 2);
});

test('a copied preview name cannot bind an initial frame at another URL', async () => {
  const preview = await open(); frames.set(9, { url: NEXT, documentId: 'copied-name', parentFrameId: 0, errorOccurred: false });
  const reply = await send({ type: 'frame:hello', name: `local-reader-${preview.id}` }, frameSender(9));
  assert.equal(reply.ok, false); assert.equal(livePreview().url, TARGET); assert.equal(requests.length, 0);
  await bind(preview.id); assert.equal((await connect()).disconnected, false);
});

test('source navigation while opening a preview cannot leave an orphan preview or frame rule', async () => {
  const pending = paused(); permissionGate = pending; const opening = send({ type: 'preview:open', url: TARGET }, frameSender(0)); await pending.reached.promise;
  frames.set(0, { url: SOURCE, documentId: 'new-source', parentFrameId: -1, errorOccurred: false });
  committed.emit({ tabId: 1, frameId: 0, documentId: 'new-source', url: SOURCE }); await settle(); pending.release.resolve();
  assert.equal((await opening).ok, false); assert.equal(session.preview, undefined); assert.equal(rules.size, 0); assert.equal(requests.length, 0);
});

test('an old frame hello resumed after permission lookup cannot bind a replacement preview', async () => {
  const first = await open(); const pending = paused(); permissionGate = pending;
  const hello = send({ type: 'frame:hello', name: `local-reader-${first.id}` }, frameSender(9)); await pending.reached.promise;
  const second = await open(NEXT); pending.release.resolve(); assert.equal((await hello).ok, false); assert.equal(livePreview().id, second.id); assert.equal(livePreview().url, NEXT);
  await bind(second.id, NEXT, 'new-target'); assert.equal((await connect()).disconnected, false); assert.equal(requests.length, 0);
});
test('target response with mismatched URL is rejected before any model request', async () => { const { port } = await opened(); currentArticle = article(NEXT); port.command({ type: 'summary:start' }); assert.equal((await finish(port)).status, 'error'); assert.equal(requests.length, 0); });
test('clearing Key during exact-document extraction cancels pending work before model fetch', async () => {
  const { port } = await opened(), pending = paused(); extractGate = pending; port.command({ type: 'summary:start' }); await pending.reached.promise;
  assert.equal((await send({ type: 'settings:clear-key' })).ok, true); pending.release.resolve(); await settle();
  assert.equal(requests.length, 0); assert.equal(session.apiKey, undefined); assert.equal(local.apiKey, undefined); assert.ok(messages.some(item => item.message.type === 'frame:cancel' && item.options?.documentId === 'target-document')); assert.equal(states(port).at(-1)?.status, 'cancelled');
});
test('configuration changed during saved-config read invalidates old Key and endpoint before fetch', async () => {
  const { port } = await opened(), pending = paused(); configGate = pending; port.command({ type: 'summary:start' }); await pending.reached.promise;
  assert.equal((await send({ type: 'settings:save', settings: { ...config, baseUrl: 'https://second-model.test/v1' }, key: 'new-test-key' })).ok, true);
  pending.release.resolve(); await settle(); assert.equal(requests.length, 0); assert.equal(states(port).at(-1)?.status, 'cancelled');
});
test('stale extracted article cannot overwrite the next target after frame navigation', async () => {
  const { preview, port } = await opened(), pending = paused(); extractGate = pending; port.command({ type: 'summary:start' }); await pending.reached.promise;
  frames.set(42, { url: NEXT, documentId: 'target-B', parentFrameId: 0, errorOccurred: false }); committed.emit({ tabId: 1, frameId: 42, documentId: 'target-B', url: NEXT }); await settle();
  currentArticle = article(NEXT, 'ACTUAL_B_ONLY'); await bind(preview.id, NEXT, 'target-B'); const baseline = states(port).length; port.command({ type: 'summary:start' });
  const result = await finish(port, baseline); assert.equal(result.status, 'done'); assert.match(result.text, /ACTUAL_B_ONLY/); pending.release.resolve(); await settle();
  assert.equal(requests.length, 1); assert.match(states(port).at(-1)!.text, /ACTUAL_B_ONLY/); assert.doesNotMatch(states(port).at(-1)!.text, /ACTUAL_A_ONLY/);
});
test('delayed old close cannot close a replacement preview on the same source document', async () => {
  const { port: first } = await opened(), pending = paused(); sourceGate = pending; first.command({ type: 'preview:close' }); await pending.reached.promise;
  const secondPreview = await open(NEXT); await bind(secondPreview.id, NEXT, 'target-B'); const second = await connect(); pending.release.resolve(); await settle();
  assert.equal(livePreview().id, secondPreview.id); assert.equal(second.disconnected, false); assert.equal(rules.size, 1);
});
test('running duplicates merge, completed content caches, and a tail-only edit invalidates full-content cache', async () => {
  local.settings = { ...config, inputBudgetTokens: 128000 }; const { port } = await opened(); const body = 'Full visible body with ordered evidence. '.repeat(900);
  currentArticle = { ...article(), text: body + 'TAIL_ONLY_A', originalLength: body.length + 11 }; assert.ok(currentArticle.text.length > 24_000);
  const pending = paused(); fetchGate = pending; port.command({ type: 'summary:start' }); await pending.reached.promise; port.command({ type: 'summary:start' }); await settle();
  assert.equal(requests.length, 1); assert.equal(messages.filter(item => item.message.type === 'frame:extract').length, 1); pending.release.resolve(); assert.equal((await finish(port)).status, 'done');
  let baseline = states(port).length; port.command({ type: 'summary:start' }); const cached = await finish(port, baseline); assert.equal(cached.cached, true); assert.equal(requests.length, 1);
  currentArticle = { ...currentArticle, text: body + 'TAIL_ONLY_B' }; baseline = states(port).length; port.command({ type: 'summary:start' }); const changed = await finish(port, baseline);
  assert.equal(changed.status, 'done'); assert.match(changed.text, /TAIL_ONLY_B/); assert.equal(requests.length, 2);
});
test('long text plans zero paid calls, then explicit confirmation re-reads and covers every source character', async () => {
  local.settings = { ...config, inputBudgetTokens: 4096, autoLongSummary: false }; const { port } = await opened();
  const text = ('An ordered body paragraph with facts, causes and counterarguments. '.repeat(10) + '\n\n').repeat(50) + 'FINAL_TAIL_SENTINEL'; currentArticle = { ...article(), text, originalLength: text.length };
  port.command({ type: 'summary:start' }); assert.equal((await finish(port)).status, 'planned'); const plan = port.sent.find(event => event.type === 'summary:plan'); assert.ok(plan?.type === 'summary:plan' && plan.needsConfirmation && plan.plan.requests > 1); assert.equal(requests.length, 0);
  const baseline = states(port).length; port.command({ type: 'summary:start', allowMultiple: true }); const result = await finish(port, baseline); assert.equal(result.status, 'done'); assert.match(result.text, /FINAL_TAIL_SENTINEL/); assert.ok(requests.length > 1);
  assert.equal(messages.filter(item => item.message.type === 'frame:extract').length, 2);
  const supplied = requests.map(item => JSON.parse(item.init.body as string).messages[1].content as string).filter(content => content.includes('全文中的连续一段：\n')).map(content => content.split('全文中的连续一段：\n')[1]); assert.equal(supplied.join(''), text);
});
test('temporary rules remove only X-Frame-Options in one source tab; close and revoked permission clean up', async () => {
  let { preview, port } = await opened(); assert.equal(rules.size, 1); const rule = [...rules.values()][0];
  assert.deepEqual(rule.action.responseHeaders, [{ header: 'x-frame-options', operation: 'remove' }]); assert.deepEqual(rule.condition.tabIds, [1]); assert.deepEqual(rule.condition.initiatorDomains, ['source.test']); assert.deepEqual(rule.condition.requestDomains, ['article.test']); assert.deepEqual(rule.condition.resourceTypes, ['sub_frame']);
  assert.equal((await send({ type: 'preview:close', previewId: preview.id }, frameSender(0))).ok, true); assert.equal(rules.size, 0); assert.equal(session.preview, undefined); assert.equal(port.disconnected, true);
  ({ preview, port } = await opened()); const pending = paused(); fetchGate = pending; port.command({ type: 'summary:start' }); await pending.reached.promise;
  granted.delete(new URL(TARGET).origin + '/*'); permissionsRemoved.emit({ origins: [new URL(TARGET).origin + '/*'] }); await waitFor(() => !session.preview && rules.size === 0, 'revocation closes preview and removes DNR'); await settle();
  assert.equal(port.disconnected, true); assert.equal(requests[0].init.signal?.aborted, true); pending.release.resolve();
  assert.ok(ruleChanges.flatMap(change => change.addRules ?? []).every(added => added.action.responseHeaders?.every(header => header.header.toLowerCase() === 'x-frame-options')));
});
test('ungranted targets and CSP framing failures never call model or modify CSP', async () => {
  granted.delete(new URL(TARGET).origin + '/*'); const preview = await open(); assert.equal(rules.size, 0); assert.equal((await send({ type: 'frame:hello', name: `local-reader-${preview.id}` }, frameSender(9))).ok, false);
  const port = await connect(); navigationError.emit({ tabId: 1, frameId: 42, url: TARGET, error: 'net::ERR_BLOCKED_BY_RESPONSE' }); await settle(); port.command({ type: 'summary:start' }); const result = await finish(port);
  assert.equal(result.status, 'error'); assert.match(result.error!, /CSP|访问策略/); assert.equal(requests.length, 0); assert.equal(messages.filter(item => item.message.type === 'frame:extract').length, 0);
});

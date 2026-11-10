import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULT_SETTINGS } from '../src/shared.ts';
import { CHAT_PORT, CHAT_SESSION_KEY, type ChatState } from '../src/chat-shared.ts';
import { planChat } from '../src/chat-model.ts';
import { estimateTokens } from '../src/summary.ts';

class Hub<Args extends unknown[]> {
  listeners: ((...args: Args) => unknown)[] = [];
  addListener(listener: (...args: Args) => unknown) { this.listeners.push(listener); }
  removeListener(listener: (...args: Args) => unknown) { this.listeners = this.listeners.filter(item => item !== listener); }
  emit(...args: Args) { for (const listener of [...this.listeners]) listener(...args); }
}
type Message = Record<string, unknown>;
const ID = 'chat-test', KEY = 'fake-configured-chat-secret', API = 'https://chat-model.test/v1';
const config = { ...DEFAULT_SETTINGS, baseUrl: API, model: 'test-chat' };
const local: Record<string, unknown> = {}, session: Record<string, unknown> = {};
const connected = new Hub<[chrome.runtime.Port]>();
const calls: { url: string; init: RequestInit; body: { messages: { role: string; content: string }[]; max_tokens: number } }[] = [];
const ports: PortMock[] = [];
let permitted = true, beforeRequests = 0, failWrites = false, failRemove = false;
let output = '这是完整回答。', slow = false, networkError = false, aborted = 0;
let failAfterFetch = false;
let holdWrite: Promise<void> | undefined, releaseWrite: (() => void) | undefined, writeReached = false;
let releaseFetch: (() => void) | undefined;
let holdConfiguration: Promise<void> | undefined, releaseConfiguration: (() => void) | undefined;
let initializeChat: typeof import('../src/chat-background.ts').initializeChat;
let cancelChat: typeof import('../src/chat-background.ts').cancelChat;
const source = (overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: ID, url: `chrome-extension://${ID}/sidepanel.html`, frameId: 0, ...overrides });
class PortMock {
  name = CHAT_PORT; sent: ChatState[] = []; disconnected = false;
  onMessage = new Hub<[Message]>(); onDisconnect = new Hub<[]>();
  constructor(public sender: chrome.runtime.MessageSender) { ports.push(this); }
  postMessage(value: ChatState) { if (this.disconnected) throw new Error('closed'); this.sent.push(structuredClone(value)); }
  command(value: Message) { this.onMessage.emit(value); }
  disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } }
}
function area(data: Record<string, unknown>, sessionArea = false) { return {
  async setAccessLevel(value: unknown) { assert.deepEqual(value, { accessLevel: 'TRUSTED_CONTEXTS' }); },
  async get(names: string | string[]) { return structuredClone(Object.fromEntries((Array.isArray(names) ? names : [names]).filter(name => name in data).map(name => [name, data[name]]))); },
  async set(value: Record<string, unknown>) {
    if (sessionArea && CHAT_SESSION_KEY in value) {
      if (holdWrite) { const pending = holdWrite; holdWrite = undefined; writeReached = true; await pending; }
      if (failWrites) throw new Error('Storage quota exceeded');
    }
    Object.assign(data, structuredClone(value));
  },
  async remove(names: string | string[]) { if (sessionArea && failRemove) throw new Error('Storage unavailable'); for (const name of Array.isArray(names) ? names : [names]) delete data[name]; }
}; }
async function settle() { for (let index = 0; index < 8; index++) await nextTurn(); }
async function waitFor(predicate: () => boolean, description = 'state') { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timeout: ${description}`); await nextTurn(); } }
function last(port: PortMock) { return port.sent.at(-1)!; }
async function connect(sender = source()) { const port = new PortMock(sender); connected.emit(port as unknown as chrome.runtime.Port); await settle(); return port; }
async function send(port: PortMock, text = '你好') {
  const previous = last(port)?.requestId; port.command({ type: 'chat:send', text });
  await waitFor(() => !!last(port)?.requestId && last(port).requestId !== previous && last(port).status !== 'running', 'send terminal');
  await settle(); return last(port);
}
async function clear(port: PortMock) { port.command({ type: 'chat:clear', requestId: last(port)?.requestId }); await settle(); }

before(async () => {
  local.settings = structuredClone(config); session.apiKey = KEY;
  session[CHAT_SESSION_KEY] = { status: 'running', requestId: 'interrupted-request', messages: [
    { id: 'old-user', role: 'user', content: '旧问题', status: 'done', details: { model: 'PRIVATE_USER_METADATA' } },
    { id: 'old-assistant', role: 'assistant', content: '中断片段', status: 'running', details: { model: 'gpt-saved-model', durationMs: 2500, firstTokenMs: 0, usage: { inputTokens: 0, outputTokens: 12, totalTokens: 12, cachedInputTokens: -1, reasoningTokens: 'PRIVATE_INVALID_VALUE', secret: 'PRIVATE_USAGE_SECRET' }, secret: 'PRIVATE_DETAILS_SECRET' }, search: { state: 'searching', calls: 1, query: 'PRIVATE_SEARCH_QUERY' }, citations: [{ start: 0, end: 4, url: 'https://example.test/source', title: '来源', token: 'PRIVATE_CREDENTIAL' }, { start: 0, end: 4, url: 'javascript:alert(1)', title: '无效' }] }
  ] };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: ID, getURL: (path: string) => `chrome-extension://${ID}/${path}`, onConnect: connected },
    storage: { local: area(local), session: area(session, true) },
    permissions: { async contains() { return permitted; } },
    tabs: {
      onUpdated: new Hub<[number, chrome.tabs.OnUpdatedInfo]>(), onRemoved: new Hub<[number]>(),
      async query() { return [{ id: 17, windowId: 1, url: 'https://chatgpt.com/', status: 'complete' }]; },
      async get() { return { id: 17, windowId: 1, url: 'https://chatgpt.com/', status: 'complete' }; },
      connect() { throw new Error('Website transport has been removed'); }
    },
    webNavigation: { onCommitted: new Hub<[chrome.webNavigation.WebNavigationTransitionCallbackDetails]>(), async getFrame() { return { documentId: 'webchat-document', frameId: 0, url: 'https://chatgpt.com/' }; } },
    scripting: { async executeScript() { return [{ frameId: 0, documentId: 'webchat-document' }]; } }
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(init!.body as string) });
    if (failAfterFetch) failWrites = true;
    if (networkError) throw new TypeError('network unavailable');
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const event = (content: string, finish = false) => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, ...(finish ? { finish_reason: 'stop' } : {}) }] })}\n\n${finish ? 'data: [DONE]\n\n' : ''}`);
    return new Response(new ReadableStream({
      start(controller) {
        const abort = () => { aborted++; clearTimeout(timer); try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} };
        init?.signal?.addEventListener('abort', abort, { once: true });
        controller.enqueue(event(slow ? '已收到的片段' : output, !slow));
        if (!slow) controller.close();
        else releaseFetch = () => { if (!init?.signal?.aborted) { controller.enqueue(event('后续内容', true)); controller.close(); } };
      }
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  ({ initializeChat, cancelChat } = await import('../src/chat-background.ts'));
  await initializeChat({ beforeRequest: () => { beforeRequests++; }, configurationReady: async () => { await holdConfiguration; } });
});
let first = true;
beforeEach(async () => {
  releaseWrite?.(); releaseWrite = undefined; holdWrite = undefined; writeReached = false;
  releaseConfiguration?.(); releaseConfiguration = undefined; holdConfiguration = undefined;
  failWrites = failRemove = failAfterFetch = false; permitted = true; slow = networkError = false; output = '这是完整回答。';
  cancelChat(); for (const port of ports) port.disconnect(); await settle();
  if (!first) { const reset = await connect(); await clear(reset); reset.disconnect(); }
  first = false;
  for (const name of Object.keys(local)) delete local[name];
  local.settings = structuredClone(config); session.apiKey = KEY;
  calls.length = 0; beforeRequests = 0; aborted = 0; releaseFetch = undefined;
});

test('session recovery preserves the interrupted fragment and never automatically pays', async () => {
  const port = await connect(); assert.equal(last(port).status, 'interrupted');
  assert.equal(last(port).messages[1].content, '中断片段'); assert.equal(last(port).messages[1].status, 'cancelled');
  assert.deepEqual(last(port).messages[1].search, { state: 'failed', calls: 1 });
  assert.deepEqual(last(port).messages[1].citations, [{ start: 0, end: 4, url: 'https://example.test/source', title: '来源' }]);
  assert.equal(last(port).messages[0].details, undefined);
  assert.deepEqual(last(port).messages[1].details, { model: 'gpt-saved-model', durationMs: 2500, firstTokenMs: 0, usage: { inputTokens: 0, outputTokens: 12, totalTokens: 12 } });
  assert.ok(!JSON.stringify(port.sent).includes('PRIVATE_'));
  assert.equal(calls.length, 0); assert.equal(last(port).hasKey, true); assert.equal(last(port).settingsReady, true);
  assert.ok(!JSON.stringify(port.sent).includes(KEY));
});

test('chat accepts only the exact top-level sidepanel document and initializes idempotently', async () => {
  await initializeChat(); assert.equal(connected.listeners.length, 1);
  for (const sender of [source({ id: 'other' }), source({ frameId: 1 }), source({ url: `chrome-extension://${ID}/options.html` }), source({ url: `chrome-extension://${ID}/research.html` }), source({ url: 'https://article.test/' }), source({ url: `chrome-extension://${ID}/sidepanel.html?fake` })]) {
    const port = await connect(sender); assert.equal(port.disconnected, true); assert.equal(port.sent.length, 0);
  }
  const hash = await connect(source({ url: `chrome-extension://${ID}/sidepanel.html#chat`, frameId: undefined }));
  assert.equal(hash.disconnected, false); assert.equal(calls.length, 0);
});

test('two turns preserve real assistant roles, store only session conversation and do not expose the Key', async () => {
  const port = await connect(); await send(port, '第一个问题'); await send(port, '接着解释');
  assert.equal(calls.length, 2); assert.equal(beforeRequests, 2);
  assert.deepEqual(calls[1].body.messages.map(item => item.role), ['system', 'user', 'assistant', 'user']);
  assert.deepEqual(calls[1].body.messages.slice(1).map(item => item.content), ['第一个问题', output, '接着解释']);
  assert.equal(calls[1].body.max_tokens, 8192); assert.equal(calls[0].url, API + '/chat/completions');
  assert.ok(!JSON.stringify(port.sent).includes(KEY)); assert.ok(!JSON.stringify(session[CHAT_SESSION_KEY]).includes(KEY));
  assert.equal(local[CHAT_SESSION_KEY], undefined); assert.equal(session.apiKey, KEY); assert.equal(last(port).messages.length, 4);
});

test('input, turn-count and complete-history budget limits reject without a paid request', async () => {
  const port = await connect();
  for (const text of ['', 'x'.repeat(6001)]) { assert.equal((await send(port, text)).status, 'error'); }
  (local.settings as typeof config).inputBudgetTokens = 2048;
  await send(port, '预算'.repeat(2500)); assert.match(last(port).error!, /预算/); assert.equal(calls.length, 0); assert.equal(beforeRequests, 0);
  const history = Array.from({ length: 40 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' as const : 'user' as const, content: 'a', status: 'done' as const }));
  assert.throws(() => planChat(config, history, 'next'), /40 条/);
});

test('a smaller context lowers the requested output budget while keeping the full input', async () => {
  const port = await connect();
  (local.settings as typeof config).inputBudgetTokens = 2048;
  assert.equal((await send(port, '你好')).status, 'idle');
  const request = calls[0].body;
  const estimatedInput = request.messages.reduce((sum, item) => sum + estimateTokens(item.content) + 8, 0);
  assert.equal(request.max_tokens, 2048 - estimatedInput - 64);
  (local.settings as typeof config).chatOutputTokens = 512;
  assert.equal((await send(port, '接着解释')).status, 'idle');
  assert.equal(calls[1].body.max_tokens, 512);
});

test('official subscription planning ignores API endpoint settings while enforcing input, complete-history and budget limits', () => {
  const webOnly = { ...config, baseUrl: 'invalid API address', model: '' };
  assert.throws(() => planChat(webOnly, [], 'hello'), /Invalid URL/);
  assert.equal(planChat(webOnly, [], ' hello ', 'chatgptOAuth').text, 'hello');
  assert.throws(() => planChat({ ...webOnly, inputBudgetTokens: 2048 }, [], '预算'.repeat(2500), 'chatgptOAuth'), /预算/);
  assert.throws(() => planChat({ ...webOnly, inputBudgetTokens: 128001 }, [], 'hello', 'chatgptOAuth'), /2048–128000/);
  assert.throws(() => planChat(webOnly, [], 'x'.repeat(6001), 'chatgptOAuth'), /6,000/);
  const history = [
    { id: 'u1', role: 'user' as const, content: '第一个问题', status: 'done' as const },
    { id: 'a1', role: 'assistant' as const, content: '完整的回答', status: 'done' as const },
    { id: 'u2', role: 'user' as const, content: '取消的问题', status: 'done' as const },
    { id: 'a2', role: 'assistant' as const, content: '不完整的回答', status: 'cancelled' as const }
  ];
  assert.deepEqual(planChat(webOnly, history, '继续', 'chatgptOAuth').messages.slice(1).map(item => item.content), ['第一个问题', '完整的回答', '继续']);
  assert.throws(() => planChat(webOnly, Array.from({ length: 40 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' as const : 'user' as const, content: 'a', status: 'done' as const })), 'next', 'chatgptOAuth'), /40 条/);
});

test('missing model configuration, missing Key and revoked API permission reject before fetch', async () => {
  const port = await connect();
  delete session.apiKey; await send(port); assert.match(last(port).error!, /API Key/);
  session.apiKey = KEY; permitted = false; await send(port); assert.match(last(port).error!, /授权/);
  permitted = true; (local.settings as typeof config).model = ''; await send(port); assert.match(last(port).error!, /模型/);
  assert.equal(calls.length, 0); assert.equal(beforeRequests, 0);
});

test('stream status refresh keeps the same assistant reference and stopping preserves partial text', async () => {
  slow = true; const port = await connect(); port.command({ type: 'chat:send', text: '慢速问题' });
  await waitFor(() => last(port)?.messages.at(-1)?.content === '已收到的片段');
  const requestId = last(port).requestId; port.command({ type: 'chat:status' }); await settle();
  releaseFetch!(); await waitFor(() => last(port).status === 'idle');
  assert.equal(last(port).messages.at(-1)?.content, '已收到的片段后续内容');
  port.command({ type: 'chat:send', text: '再一个慢速问题' }); await waitFor(() => last(port).requestId !== requestId && last(port).messages.at(-1)?.content === '已收到的片段');
  port.command({ type: 'chat:stop', requestId: last(port).requestId }); await settle();
  assert.equal(last(port).status, 'cancelled'); assert.equal(last(port).messages.at(-1)?.status, 'cancelled');
  assert.equal(last(port).messages.at(-1)?.content, '已收到的片段'); assert.equal(aborted, 1);
});

test('stale stop and clear commands cannot cancel a newer request; active duplicate sends are ignored', async () => {
  const port = await connect(); await send(port, '先完成'); const previous = last(port).requestId;
  slow = true; port.command({ type: 'chat:send', text: '新问题' }); await waitFor(() => calls.length === 2 && last(port).messages.at(-1)?.content === '已收到的片段');
  port.command({ type: 'chat:stop', requestId: previous }); port.command({ type: 'chat:clear', requestId: previous }); port.command({ type: 'chat:clear' }); port.command({ type: 'chat:send', text: '重复发送' }); await settle();
  assert.equal(last(port).status, 'running'); assert.equal(calls.length, 2); assert.equal(aborted, 0);
  await clear(port); assert.equal(last(port).status, 'idle'); assert.equal(last(port).messages.length, 0); assert.equal(session[CHAT_SESSION_KEY], undefined); assert.equal(aborted, 1);
});

test('cancelled and failed turns remain visible but only complete pairs enter the next request', async () => {
  const port = await connect(); await send(port, '已完成');
  slow = true; port.command({ type: 'chat:send', text: '取消的问题' }); await waitFor(() => last(port).messages.at(-1)?.content === '已收到的片段');
  port.command({ type: 'chat:stop', requestId: last(port).requestId }); await settle();
  slow = false; networkError = true; await send(port, '失败的问题'); networkError = false; await send(port, '继续');
  assert.deepEqual(calls.at(-1)!.body.messages.slice(1).map(item => item.content), ['已完成', output, '继续']);
  assert.equal(last(port).messages.length, 8); assert.equal(calls.length, 4);
});

test('closing another panel leaves generation running; closing the initiating panel aborts transport', async () => {
  const owner = await connect(), observer = await connect(); slow = true; owner.command({ type: 'chat:send', text: '慢速' });
  await waitFor(() => last(owner).messages.at(-1)?.content === '已收到的片段');
  observer.disconnect(); await settle(); assert.equal(last(owner).status, 'running'); assert.equal(aborted, 0);
  owner.disconnect(); await settle(); assert.equal(aborted, 1);
  const reopened = await connect(); assert.equal(last(reopened).status, 'cancelled'); assert.equal(last(reopened).messages.at(-1)?.content, '已收到的片段');
});

test('configuration cancellation while waiting prevents fetch and a late continuation cannot overwrite clear', async () => {
  const port = await connect(); holdConfiguration = new Promise(resolve => { releaseConfiguration = resolve; });
  port.command({ type: 'chat:send', text: '尚未发送' }); await waitFor(() => last(port).status === 'running');
  await clear(port); releaseConfiguration!(); holdConfiguration = undefined; await settle();
  assert.equal(calls.length, 0); assert.equal(last(port).status, 'idle'); assert.equal(last(port).messages.length, 0);
  await send(port, '之后发送'); assert.equal(calls.length, 1);
});

test('checkpoint write failure refuses payment and a later successful save recovers without retry', async () => {
  const port = await connect(); failWrites = true; await send(port, '不能保存');
  assert.equal(calls.length, 0); assert.match(last(port).error!, /保存/);
  failWrites = false; await send(port, '恢复后发送'); assert.equal(calls.length, 1); assert.equal(last(port).status, 'idle');
  assert.deepEqual(calls[0].body.messages.map(item => item.role), ['system', 'user']);
  failRemove = true; await clear(port); assert.equal(last(port).status, 'error'); assert.match(last(port).error!, /清空/);
  failRemove = false; await clear(port); assert.equal(last(port).status, 'idle'); assert.equal(session[CHAT_SESSION_KEY], undefined);
});

test('a late preflight checkpoint cannot restart a cleared task or overwrite the following request', async () => {
  const port = await connect(); holdWrite = new Promise(resolve => { releaseWrite = resolve; });
  port.command({ type: 'chat:send', text: '等待存储' }); await waitFor(() => writeReached);
  await clear(port); assert.equal(last(port).messages.length, 0);
  releaseWrite!(); await settle(); assert.equal(calls.length, 0); assert.equal(session[CHAT_SESSION_KEY], undefined);
  await send(port, '新会话'); assert.equal(calls.length, 1); assert.equal(last(port).messages[0].content, '新会话');
});

test('a terminal checkpoint failure preserves received text as incomplete and never retries payment', async () => {
  const port = await connect(); failAfterFetch = true; await send(port, '输出后存储失败');
  assert.equal(calls.length, 1); assert.equal(last(port).messages.at(-1)?.content, output); assert.equal(last(port).messages.at(-1)?.status, 'error');
  assert.match(last(port).error!, /保存/);
  failAfterFetch = failWrites = false; await send(port, '恢复');
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].body.messages.slice(1).map(item => item.content), ['恢复']);
});

test('configured secret cannot be submitted or echoed into a checkpoint or UI', async () => {
  const port = await connect(); await send(port, `这是我的 ${KEY}`); assert.equal(calls.length, 0); assert.equal(last(port).messages.length, 0);
  output = `模型返回 ${KEY}`; await send(port, '正常问题');
  assert.ok(!JSON.stringify(port.sent).includes(KEY)); assert.ok(!JSON.stringify(session[CHAT_SESSION_KEY]).includes(KEY));
  assert.match(last(port).messages.at(-1)!.content, /Key 已隐藏/);
});


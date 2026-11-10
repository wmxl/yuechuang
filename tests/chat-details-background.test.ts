import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULT_SETTINGS } from '../src/shared';
import { CHAT_PORT, CHAT_SESSION_KEY, type ChatState } from '../src/chat-shared';

class Hub<T extends unknown[]> {
  listeners: ((...args: T) => unknown)[] = [];
  addListener = (listener: (...args: T) => unknown) => { this.listeners.push(listener); };
  emit(...args: T) { for (const listener of this.listeners) listener(...args); }
}
const ID = 'details-background-test', KEY = 'configured-private-key', TOKEN = 'synthetic-details-access-token';
const local: Record<string, unknown> = { settings: { ...DEFAULT_SETTINGS }, webChatConfig: { provider: 'chatgptOAuth', model: 'gpt-selected' } };
const session: Record<string, unknown> = { apiKey: KEY };
const connected = new Hub<[chrome.runtime.Port]>();
const requests: Record<string, unknown>[] = [];
let failed = false;
let lengthLimited = false;
function area(values: Record<string, unknown>) { return {
  async setAccessLevel() {},
  async get(names: string | string[]) { return structuredClone(Object.fromEntries((Array.isArray(names) ? names : [names]).map(name => [name, values[name]]))); },
  async set(value: Record<string, unknown>) { Object.assign(values, structuredClone(value)); },
  async remove(name: string) { delete values[name]; }
}; }
class Port {
  name = CHAT_PORT;
  sender = { id: ID, url: `chrome-extension://${ID}/sidepanel.html`, frameId: 0 };
  onMessage = new Hub<[Record<string, unknown>]>();
  onDisconnect = new Hub<[]>();
  sent: ChatState[] = [];
  postMessage(value: ChatState) { this.sent.push(structuredClone(value)); }
  command(value: Record<string, unknown>) { this.onMessage.emit(value); }
  disconnect() { this.onDisconnect.emit(); }
  get state() { return this.sent.at(-1)!; }
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Details state timed out'); await nextTurn(); }
}
async function connect() {
  const port = new Port(); connected.emit(port as unknown as chrome.runtime.Port);
  await waitFor(() => !!port.state?.settingsReady); return port;
}
async function send(port: Port, text: string) {
  const previous = port.state.requestId;
  port.command({ type: 'chat:send', text });
  await waitFor(() => !!port.state.requestId && port.state.requestId !== previous && port.state.status !== 'running');
  return port.state;
}

before(async () => {
  Object.assign(globalThis, { chrome: {
    runtime: {
      id: ID, getURL: (name: string) => `chrome-extension://${ID}/${name}`, onConnect: connected,

    },
    storage: { local: area(local), session: area(session) },
    permissions: { async contains() { return true; } }
  } });
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://model.test/v1/chat/completions') {
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
      requests.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"未完成片段"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    if (String(url).endsWith('/v1/models')) return Response.json({ models: [{ slug: 'gpt-selected', display_name: 'Selected model', visibility: 'list' }] });
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    requests.push(JSON.parse(String(init?.body)));
    const events = [
      { type: 'response.created', response: { id: `response-${requests.length}`, model: KEY } },
      { type: 'response.output_text.delta', delta: failed || lengthLimited ? '未完成片段' : '完整回答' },
      lengthLimited
        ? { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }
        : failed
        ? { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' }, usage: { input_tokens: 99999 }, model: 'gpt-failed' } }
        : { type: 'response.completed', response: { id: `response-${requests.length}`, object: 'response', created_at: 1, status: 'completed', error: null, output: [], text: { format: { type: 'text' } }, model: 'gpt-server-version', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, private: TOKEN }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120, private: TOKEN }, private: TOKEN } }
    ];
    const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    response.headers.delete('Content-Type');
    return response;
  };
  const { siwcAuth } = await import('../src/siwc-auth');
  siwcAuth.call = async command => command === 'getAccessToken'
    ? { accessToken: TOKEN, expiresAt: Date.now() + 3600_000, accountId: 'synthetic-account' }
    : { state: 'ready', account: { id: 'synthetic-account', label: 'Synthetic account', planAuthorized: true } };
  await (await import('../src/chat-background')).initializeChat();
});

test('a greeting survives metadata-only completion without Content-Type, retains details and enters the next turn once', async () => {
  const port = await connect();
  const first = await send(port, '哈喽');
  assert.equal(first.status, 'idle');
  assert.equal(first.messages[1].content, '完整回答');
  assert.equal(first.messages[1].status, 'done');
  assert.ok(port.sent.every(state => !state.messages[1] || state.messages[1].status === 'running' || state.messages[1].content === '完整回答'));
  const details = first.messages[1].details!;
  assert.equal(details.model, 'gpt-server-version');
  assert.deepEqual(details.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 5, totalTokens: 120 });
  assert.ok(Number.isSafeInteger(details.durationMs) && details.durationMs! >= 0);
  assert.ok(Number.isSafeInteger(details.firstTokenMs) && details.firstTokenMs! >= 0);
  assert.ok(details.firstTokenMs! <= details.durationMs!);
  assert.deepEqual((session[CHAT_SESSION_KEY] as ChatState).messages[1].details, details);
  assert.ok(!JSON.stringify(port.sent).includes(KEY));
  assert.ok(!JSON.stringify([local, session, port.sent]).includes(TOKEN));
  const second = await send(port, '第二问');
  assert.deepEqual(second.messages[1].details, details);
  assert.equal(requests.length, 2);
  const body = requests[1];
  assert.deepEqual(body.input, [{ role: 'user', content: '哈喽' }, { role: 'assistant', content: '完整回答' }, { role: 'user', content: '第二问' }]);
  assert.ok(!JSON.stringify(body).includes('inputTokens'));
  assert.ok(!JSON.stringify(body).includes('durationMs'));
  const reopened = await connect();
  assert.deepEqual(reopened.state.messages[1].details, details);
  assert.equal(requests.length, 2);
  reopened.disconnect(); port.disconnect();
});

test('failed response does not publish unconfirmed usage or overwrite earlier completed details', async () => {
  failed = true;
  const port = await connect();
  const previousDetails = structuredClone(port.state.messages[1].details);
  const state = await send(port, '失败测试');
  assert.equal(state.status, 'error');
  assert.deepEqual(state.messages[1].details, previousDetails);
  const message = state.messages.at(-1)!;
  assert.equal(message.content, '未完成片段');
  assert.equal(message.status, 'error');
  assert.equal(message.details?.usage, undefined);
  assert.ok(!message.details?.model?.includes(KEY));
  assert.ok(Number.isSafeInteger(message.details?.durationMs));
  assert.equal(requests.length, 3);
  assert.ok(!JSON.stringify([local, session, port.sent]).includes(TOKEN));
  port.disconnect();
});

test('both connections keep truncated answers and tell the user to resend the original question', async () => {
  failed = false;
  lengthLimited = true;
  const before = requests.length;
  const oauth = await connect();
  const subscriptionState = await send(oauth, '请翻译成英文');
  oauth.disconnect();
  local.webChatConfig = { provider: 'apiKey', model: '' };
  local.settings = { ...DEFAULT_SETTINGS, baseUrl: 'https://model.test/v1', model: 'test-chat' };
  const api = await connect();
  const apiState = await send(api, '请翻译成英文');
  api.disconnect();
  assert.equal(requests.length, before + 2);
  assert.equal(requests[before].max_output_tokens, undefined);
  assert.equal(requests[before + 1].max_tokens, 8192);
  for (const state of [subscriptionState, apiState]) {
    assert.equal(state.status, 'error');
    assert.equal(state.messages.at(-1)?.content, '未完成片段');
    assert.equal(state.messages.at(-1)?.status, 'error');
    assert.match(state.error!, /长度上限.*已保留收到的片段.*重新发送原问题/);
  }
  assert.equal(subscriptionState.error, apiState.error);
});

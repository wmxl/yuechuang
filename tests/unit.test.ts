import test from 'node:test';
import assert from 'node:assert/strict';
import { apiEndpoint, allowedUrl, cacheKey, httpError, SSEParser, validateSettings } from '../src/core.ts';
import { generate } from '../src/model.ts';
import { DEFAULT_SETTINGS } from '../src/shared.ts';

test('SSE parses every split, CRLF, BOM, comments, multiline and trailing event', () => {
  const source = '\uFEFF: comment\r\ndata: first\r\ndata: second\r\n\r\ndata: [DONE]';
  for (let split = 0; split <= source.length; split++) {
    const result: string[] = []; const parser = new SSEParser(value => result.push(value));
    parser.push(source.slice(0, split)); parser.push(source.slice(split)); parser.push('', true);
    assert.deepEqual(result, ['first\nsecond', '[DONE]']);
  }
});
test('SSE single-character arbitrary chunks and lone CR separators', () => {
  const result: string[] = []; const parser = new SSEParser(value => result.push(value));
  for (const character of 'data: a\r\rdata: b\n\n') parser.push(character);
  parser.push('', true); assert.deepEqual(result, ['a', 'b']);
});
test('endpoint restricts schemes, credentials, queries and preserves complete path', () => {
  assert.equal(apiEndpoint('https://example.test/v1/'), 'https://example.test/v1/chat/completions');
  assert.equal(apiEndpoint('http://127.0.0.1:4317/v1/chat/completions'), 'http://127.0.0.1:4317/v1/chat/completions');
  for (const value of ['http://evil.test/v1', 'javascript:alert(1)', 'file:///secret', 'https://u:p@host/v1', 'https://a.test/v1?key=x', 'https://a.test/#secret']) assert.throws(() => apiEndpoint(value));
  assert.throws(() => allowedUrl('https://chromewebstore.google.com/detail/x'));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, rememberKey: 'yes' }));
});
test('cache identity binds endpoint, key, content and model', async () => {
  const config = { ...DEFAULT_SETTINGS, baseUrl: 'https://one.test/v1', model: 'model' };
  const baseline = await cacheKey('https://article.test', 'article A', config, 'one');
  for (const changed of [await cacheKey('https://article.test', 'article B', config, 'one'), await cacheKey('https://article.test', 'article A', { ...config, baseUrl: 'https://two.test/v1' }, 'one'), await cacheKey('https://article.test', 'article A', config, 'two'), await cacheKey('https://article.test', 'article A', { ...config, model: 'other' }, 'one')]) assert.notEqual(changed, baseline);
});
test('errors map auth, quota, model and compatibility without response echoes', () => {
  assert.match(httpError(401), /Key/); assert.match(httpError(429), /429/); assert.match(httpError(404), /模型/); assert.match(httpError(400), /兼容/);
});

const config = { ...DEFAULT_SETTINGS, baseUrl: 'https://model.test/v1', model: 'mock' };
function sse(text: string) { return `data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`; }
test('model fetch uses only explicit endpoint, auth header, no redirects, and streams UTF8 safely', async () => {
  const original = globalThis.fetch;
  const observed: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://model.test/v1/chat/completions'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer test-key');
    const body = JSON.parse(init!.body as string); assert.equal(body.store, false); assert.equal(body.stream, true); assert.ok(!JSON.stringify(body).includes('test-key'));
    const bytes = new TextEncoder().encode(sse('中文摘要'));
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try { assert.equal(await generate(config, 'test-key', null, new AbortController().signal, text => observed.push(text)), '中文摘要'); assert.deepEqual(observed, ['中文摘要']); }
  finally { globalThis.fetch = original; }
});
test('model handles HTTP failures and rejects incompatible payload', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('sensitive server echo', { status: 401 });
    await assert.rejects(generate(config, 'key', null, new AbortController().signal, () => {}), /401\/403/);
    globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(generate(config, 'key', null, new AbortController().signal, () => {}), /格式不兼容/);
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    await assert.rejects(generate(config, 'key', null, new AbortController().signal, () => {}), /提前结束/);
  } finally { globalThis.fetch = original; }
});
test('header timeout aborts a pending fetch and explicit cancellation stays abort', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled','AbortError')), { once: true }));
  try {
    await assert.rejects(generate(config, 'key', null, new AbortController().signal, () => {}, { headers: 10, idle: 100, total: 100 }), /响应头超时/);
    const controller = new AbortController(); const result = generate(config, 'key', null, controller.signal, () => {}); controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
test('finish_reason length rejects an incomplete result and retains streamed text', async () => {
  const original = globalThis.fetch; const partial: string[] = [];
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"已收到的片段"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await assert.rejects(generate(config, 'key', null, new AbortController().signal, text => partial.push(text)), /长度上限.*尚未完成/);
    assert.deepEqual(partial, ['已收到的片段']);
  } finally { globalThis.fetch = original; }
});
test('stream idle and total deadlines abort an already-open response', async () => {
  const original = globalThis.fetch;
  let interval: ReturnType<typeof setInterval> | undefined;
  const install = (withTraffic: boolean) => {
    globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => { clearInterval(interval); controller.error(new DOMException('aborted','AbortError')); }, { once: true });
        if (withTraffic) interval = setInterval(() => controller.enqueue(new TextEncoder().encode(': keepalive\n\n')), 3);
      }, cancel() { clearInterval(interval); }
    }), { headers: { 'Content-Type':'text/event-stream' } });
  };
  try {
    install(false);
    await assert.rejects(generate(config,'key',null,new AbortController().signal,()=>{}, {headers:100,idle:10,total:100}), /长时间没有数据/);
    install(true);
    await assert.rejects(generate(config,'key',null,new AbortController().signal,()=>{}, {headers:100,idle:50,total:20}), /总时限/);
  } finally { clearInterval(interval); globalThis.fetch = original; }
});
test('storage restricts both areas before writing and migrates / clears key correctly', async () => {
  const calls: string[] = []; const local: Record<string,unknown> = {}; const session: Record<string,unknown> = {};
  const area = (data: Record<string,unknown>, name: string) => ({
    setAccessLevel: async (options: {accessLevel:string}) => { assert.equal(options.accessLevel,'TRUSTED_CONTEXTS'); calls.push(name); },
    get: async () => ({...data}),
    set: async (values: Record<string,unknown>) => { assert.ok(calls.includes('local') && calls.includes('session')); Object.assign(data, values); },
    remove: async (key: string) => { delete data[key]; }
  });
  (globalThis as unknown as {chrome:unknown}).chrome = { storage: { local: area(local,'local'), session: area(session,'session') } };
  const store = await import('../src/store.ts');
  await store.saveConfig(DEFAULT_SETTINGS, 'session-key'); assert.equal(session.apiKey, 'session-key'); assert.equal(local.apiKey, undefined);
  await store.saveConfig({...DEFAULT_SETTINGS,rememberKey:true}); assert.equal(local.apiKey,'session-key'); assert.equal(session.apiKey,undefined);
  await store.saveConfig(DEFAULT_SETTINGS); assert.equal(session.apiKey,'session-key'); assert.equal(local.apiKey,undefined);
  await store.writeCache('1','one'); for (let i=2;i<=25;i++) await store.writeCache(String(i),String(i)); assert.equal((await store.readCache()).length,20);
  await store.clearKey(); assert.equal((await store.readConfig()).key,''); await store.clearCache(); assert.equal((await store.readCache()).length,0);
  await Promise.all([store.writeCache('race','stale'), store.clearCache()]); assert.deepEqual(await store.readCache(),[]);
});

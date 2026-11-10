import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

// This harness exercises the built UI with a deterministic in-page Chrome API
// double. It never loads a native host, opens an authorization page or calls AI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const output = path.join(root, 'test-results', 'siwc-ui');
await fs.mkdir(output, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  for (const entry of ['.cache/ms-playwright', '.browsers']) {
    const candidate = path.join(root, entry);
    try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; break; } } catch {}
  }
}
const { chromium } = await import('playwright');
const manifest = JSON.parse(await fs.readFile(path.join(dist, 'manifest.json'), 'utf8'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const target = path.resolve(dist, '.' + url.pathname);
  if (!target.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
  try { response.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream' }).end(await fs.readFile(target)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { date: new Date().toISOString(), version: manifest.version, mockOnly: true, realAccountVerified: false, realModelVerified: false, nativeHostStarted: false, checks: [], unexpectedNetwork: [] };
report.testedBuild = { fingerprint: buildFingerprint(await hashDirectory(dist)) };
let browser;
async function check(name, action) {
  try { await action(); report.checks.push({ name, result: 'pass' }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.checks.push({ name, result: 'fail', error: error.message }); throw error; }
}
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    report.unexpectedNetwork.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(({ origin, version }) => {
    const emptyStatus = { state: 'unchecked', loggedIn: false, planAuthorized: false, models: [], generation: 'unchecked' };
    const connectionCase = new URLSearchParams(location.search).get('connectionCase');
    const savedOAuth = ['oauthSwitch', 'apiFailure'].includes(connectionCase);
    const mock = globalThis.__siwcUi = {
      calls: [], permissions: [], commands: [], copied: [], config: savedOAuth ? { provider: 'chatgptOAuth', model: 'gpt-6.1-terra' } : connectionCase === 'webMigration' ? { provider: 'chatgptOAuth', model: '' } : { provider: 'apiKey', model: '' },
      migration: connectionCase === 'webMigration' ? 'webModeRemoved' : undefined,
      settings: connectionCase === 'webMigration'
        ? { baseUrl: 'https://example.test/v1', model: 'existing.api-model', rememberKey: true, inputBudgetTokens: 24000, autoLongSummary: false }
        : { baseUrl: '', model: '', rememberKey: false, inputBudgetTokens: 16000, autoLongSummary: false },
      hasKey: connectionCase === 'webMigration', failConnectionSave: connectionCase === 'apiFailure' ? 1 : 0,
      status: savedOAuth ? { state: 'ready', loggedIn: true, planAuthorized: true, models: [{ id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }], generation: 'unchecked', helperVersion: 'mock-1' } : { ...emptyStatus }, loginResolve: undefined, ports: [], failLogout: '', holdStatus: location.search.includes('holdInitial'), failConnections: 0, connectionAttempts: 0,
      chat: { type: 'chat:state', messages: [], status: 'idle', hasKey: false, settingsReady: false, connection: 'chatgptOAuth', siwcStatus: { ...emptyStatus } },
      push(value) { this.chat = value; this.ports.filter(port => !port.closed).forEach(port => port.emit(value)); },
    };
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { mock.copied.push(value); } }, configurable: true });
    const copy = value => JSON.parse(JSON.stringify(value));
    const siwcView = () => ({ ok: true, view: { config: copy(mock.config), status: copy(mock.status) } });
    const connectionView = () => ({ ok: true, view: { config: copy(mock.config), ...(mock.migration ? { migration: mock.migration } : {}) } });
    globalThis.chrome ||= {};
    globalThis.chrome.runtime = {
      id: 'mock-extension-id', getURL: value => origin + '/' + value, getManifest: () => ({ version }),
      async sendMessage(value) {
        mock.calls.push(copy(value));
        if (value.type === 'context:toolbar-sites') return { ok: true, sites: [] };
        if (value.type === 'settings:get') return { ok: true, settings: copy(mock.settings), hasKey: mock.hasKey, permissions: [], cacheCount: 0 };
        if (value.type === 'settings:save') { mock.settings = copy(value.settings); return { ok: true }; }
        if (value.type === 'connection:get') return connectionView();
        if (value.type === 'connection:save') {
          if (mock.failConnectionSave > 0) { mock.failConnectionSave--; return { ok: false, error: '对话连接配置保存失败，请重试。' }; }
          mock.config = value.config.provider === 'apiKey' ? { provider: 'apiKey', model: '' } : copy(value.config);
          mock.migration = undefined;
          return connectionView();
        }
        if (value.type === 'siwc:get' || value.type === 'siwc:refresh') return siwcView();
        if (value.type === 'siwc:save') { mock.config = copy(value.config); return siwcView(); }
        if (value.type === 'siwc:login') {
          mock.status.loginPending = true;
          return await new Promise(resolve => { mock.loginResolve = resolve; });
        }
        if (value.type === 'siwc:cancel') {
          mock.status.loginPending = false;
          mock.loginResolve?.(siwcView());
          mock.loginResolve = undefined;
          return siwcView();
        }
        if (value.type === 'siwc:logout') {
          if (mock.failLogout === 'response') return { ok: false, error: '登录凭证操作失败，请检查扩展存储后重试。' };
          if (mock.failLogout === 'view') { mock.status = { ...emptyStatus, state: 'error', error: '凭证存储读取失败。' }; return siwcView(); }
          mock.status = { ...emptyStatus, state: 'signedOut', remoteRevoked: false }; return siwcView();
        }
        return { ok: false, error: 'Unexpected UI mock message' };
      },
      connect() {
        mock.connectionAttempts++;
        if (mock.failConnections > 0) { mock.failConnections--; throw new Error('Synthetic worker unavailable'); }
        const messages = [], disconnections = [];
        const port = {
          closed: false, onMessage: { addListener(listener) { messages.push(listener); } }, onDisconnect: { addListener(listener) { disconnections.push(listener); } },
          postMessage(value) {
            if (port.closed) throw new Error('Attempting to use a disconnected port');
            mock.commands.push(copy(value));
            if (value.type === 'chat:status' && !mock.holdStatus) queueMicrotask(() => { if (!port.closed) port.emit(mock.chat); });
          },
          emit(value) { messages.forEach(listener => listener(copy(value))); },
          break() { if (!port.closed) { port.closed = true; disconnections.forEach(listener => listener()); } },
          disconnect() { port.closed = true; },
        };
        mock.ports.push(port);
        return port;
      },
    };
    globalThis.chrome.windows = { async getCurrent() { return { id: 1 }; } };
    globalThis.chrome.tabs = { onActivated: { addListener() {} }, onRemoved: { addListener() {} } };
    globalThis.chrome.webNavigation = {
      onCommitted: { addListener() {} },
      onHistoryStateUpdated: { addListener() {} },
      onReferenceFragmentUpdated: { addListener() {} },
    };
    globalThis.chrome.storage = { onChanged: { addListener() {} } };
    globalThis.chrome.permissions = {
      async request(value) { mock.permissions.push(copy(value)); return true; },
      onAdded: { addListener() {} }, onRemoved: { addListener() {} },
    };
  }, { origin, version: manifest.version });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await check('subscription users can save budgets and separate article-summary controls with no API credentials', async () => {
    await page.goto(origin + '/options.html?connectionCase=oauthSwitch');
    await page.waitForFunction(() => !document.querySelector('#save-settings').disabled && document.querySelector('#connection-oauth').checked);
    assert.equal(await page.locator('#chat-output-budget').inputValue(), '8192');
    await page.locator('#input-budget').fill('64000');
    await page.locator('#chat-output-budget').fill('4096');
    const summary = page.getByRole('region', { name: '文章摘要' });
    assert.equal(await page.locator('#auto-summary').count(), 0);
    await summary.locator('#auto-long-summary').check();
    await page.locator('#save-settings').click();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存到本机');
    const saved = await page.evaluate(() => __siwcUi.calls.filter(value => value.type === 'settings:save'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].settings.inputBudgetTokens, 64000);
    assert.equal(saved[0].settings.chatOutputTokens, 4096);
    assert.equal(saved[0].settings.autoLongSummary, true);
    assert.equal(saved[0].settings.baseUrl, '');
    assert.equal(saved[0].settings.model, '');
    assert.equal(saved[0].key, undefined);
  });
  await check('saving API from a saved dotted OAuth model sends canonical neutral config without helper or model requests', async () => {
    await page.goto(origin + '/options.html?connectionCase=oauthSwitch');
    await page.waitForFunction(() => !document.querySelector('#save-connection').disabled);
    assert.equal(await page.locator('#connection-oauth').isChecked(), true);
    assert.equal(await page.locator('#siwc-model').inputValue(), 'gpt-6.1-terra');
    await page.locator('#connection-api').check();
    assert.equal(await page.locator('#connection-save-state').innerText(), '有未保存的更改');
    assert.equal(await page.locator('#connection-save-state').evaluate(element => element.classList.contains('is-dirty')), true);
    await page.locator('#save-connection').click();
    await page.waitForFunction(() => __siwcUi.config.provider === 'apiKey' && !document.querySelector('#save-connection').disabled);
    const saved = await page.evaluate(() => ({ config: __siwcUi.config, saves: __siwcUi.calls.filter(value => value.type === 'connection:save'), calls: __siwcUi.calls, permissions: __siwcUi.permissions, commands: __siwcUi.commands }));
    assert.deepEqual(saved.config, { provider: 'apiKey', model: '' });
    assert.deepEqual(saved.saves, [{ type: 'connection:save', config: { provider: 'apiKey', model: '' } }]);
    assert.equal(saved.calls.every(value => ['settings:get', 'context:toolbar-sites', 'siwc:get', 'connection:get', 'connection:save'].includes(value.type)), true);
    assert.deepEqual(saved.permissions, []);
    assert.deepEqual(saved.commands, []);
    assert.equal(await page.locator('#connection-api').isChecked(), true);
    assert.equal(await page.locator('#siwc-details').isHidden(), true);
    assert.match(await page.locator('#connection-feedback').innerText(), /已切换为模型 API/);
    assert.equal(await page.locator('#connection-feedback').evaluate(element => element.classList.contains('is-error')), false);
    assert.equal(await page.locator('#connection-save-state').innerText(), '已保存到本机');
    assert.equal(await page.locator('#connection-save-state').evaluate(element => element.classList.contains('is-dirty')), false);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#connection-card').screenshot({ path: path.join(output, `api-settings-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 900 });
  });
  await check('removed web configuration shows two supported choices and a neutral migration notice while preserving API settings', async () => {
    await page.goto(origin + '/options.html?connectionCase=webMigration');
    await page.waitForFunction(() => !document.querySelector('#save-connection').disabled);
    assert.equal(await page.locator('input[name="chat-provider"]').count(), 2);
    assert.equal(await page.locator('#connection-web,[id^="webchat-"]').count(), 0);
    assert.equal(await page.locator('#connection-oauth').isChecked(), true);
    assert.equal(await page.locator('#siwc-model').inputValue(), '');
    assert.match(await page.locator('#connection-feedback').innerText(), /ChatGPT 网页模式已移除.*官方订阅.*模型 API/);
    assert.equal(await page.locator('#connection-feedback').evaluate(element => element.classList.contains('is-error')), false);
    assert.equal(await page.locator('#siwc-failure').isHidden(), true);
    assert.doesNotMatch(await page.locator('#connection-card').innerText(), /网页连接配置不完整|官网页面发送|后台网页会话|网页连接失败/);
    const saved = await page.evaluate(() => ({ config: __siwcUi.config, settings: __siwcUi.settings, calls: __siwcUi.calls, hasKey: __siwcUi.hasKey, permissions: __siwcUi.permissions }));
    assert.deepEqual(saved.config, { provider: 'chatgptOAuth', model: '' });
    assert.equal(await page.locator('#base-url').inputValue(), saved.settings.baseUrl);
    assert.equal(await page.locator('#model').inputValue(), saved.settings.model);
    assert.equal(await page.locator('#remember-key').isChecked(), true);
    assert.equal(await page.locator('#input-budget').inputValue(), '24000');
    assert.match(await page.locator('#key-status').innerText(), /已有本机 Key/);
    assert.equal(saved.hasKey, true);
    assert.equal(saved.calls.every(value => ['settings:get', 'context:toolbar-sites', 'siwc:get', 'connection:get'].includes(value.type)), true);
    assert.deepEqual(saved.permissions, []);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#connection-card').screenshot({ path: path.join(output, `migration-settings-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 900 });
  });
  await check('neutral API save failure preserves the selected choice and dirty state until an explicit successful retry', async () => {
    await page.goto(origin + '/options.html?connectionCase=apiFailure');
    await page.waitForFunction(() => !document.querySelector('#save-connection').disabled);
    await page.locator('#connection-api').check();
    await page.locator('#save-connection').click();
    await page.waitForFunction(() => document.querySelector('#connection-feedback').textContent === '对话连接配置保存失败，请重试。' && !document.querySelector('#save-connection').disabled);
    assert.equal(await page.locator('#connection-api').isChecked(), true);
    assert.equal(await page.locator('#connection-oauth').isChecked(), false);
    assert.equal(await page.locator('#connection-save-state').innerText(), '有未保存的更改');
    assert.equal(await page.locator('#connection-feedback').evaluate(element => element.classList.contains('is-error')), true);
    assert.doesNotMatch(await page.locator('#connection-feedback').innerText(), /官方登录|网页连接|ChatGPT|助手/);
    assert.deepEqual(await page.evaluate(() => __siwcUi.config), { provider: 'chatgptOAuth', model: 'gpt-6.1-terra' });
    await page.locator('#save-connection').click();
    await page.waitForFunction(() => __siwcUi.config.provider === 'apiKey' && !document.querySelector('#save-connection').disabled);
    assert.equal(await page.locator('#connection-save-state').innerText(), '已保存到本机');
    assert.equal(await page.locator('#connection-api').isChecked(), true);
    assert.equal(await page.locator('#connection-feedback').evaluate(element => element.classList.contains('is-error')), false);
    const saved = await page.evaluate(() => ({ calls: __siwcUi.calls, permissions: __siwcUi.permissions }));
    assert.deepEqual(saved.calls.filter(value => value.type === 'connection:save'), [
      { type: 'connection:save', config: { provider: 'apiKey', model: '' } },
      { type: 'connection:save', config: { provider: 'apiKey', model: '' } },
    ]);
    assert.equal(saved.calls.every(value => ['settings:get', 'context:toolbar-sites', 'siwc:get', 'connection:get', 'connection:save'].includes(value.type)), true);
    assert.deepEqual(saved.permissions, []);
  });
  await page.goto(origin + '/options.html');
  await check('opening settings preserves API selection and never starts login or helper check', async () => {
    await page.locator('#save-connection').waitFor({ state: 'visible' });
    await assert.doesNotReject(() => page.locator('#connection-oauth').check());
    assert.equal(await page.locator('#siwc-details').isVisible(), true);
    const initial = await page.evaluate(() => ({ calls: __siwcUi.calls.map(value => value.type), permissions: __siwcUi.permissions, config: __siwcUi.config }));
    assert.equal(initial.config.provider, 'apiKey');
    assert.equal(initial.calls.filter(type => ['siwc:login', 'siwc:refresh', 'siwc:save', 'connection:save'].includes(type)).length, 0);
    assert.equal(initial.permissions.length, 0);
    assert.match(await page.locator('#siwc-identity').innerText(), /尚未登录/);
  });
  await check('cancel remains usable while official login is pending', async () => {
    await page.locator('#siwc-login').click();
    await page.locator('#siwc-cancel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#siwc-cancel').isEnabled(), true);
    assert.equal(await page.locator('#save-connection').isDisabled(), true);
    await page.locator('#siwc-cancel').click();
    await page.waitForFunction(() => !__siwcUi.status.loginPending && !document.querySelector('#save-connection').disabled);
    assert.equal((await page.evaluate(() => __siwcUi.calls)).some(value => value.type === 'siwc:cancel'), true);
    assert.deepEqual(await page.evaluate(() => __siwcUi.permissions), []);
  });
  await check('browser-only sign-in has no helper installer or extension registration controls', async () => {
    assert.equal(await page.locator('#siwc-extension-id, #siwc-copy-id, #siwc-helper-help').count(), 0);
    assert.match(await page.locator('.connection-explanation').innerText(), /无需额外安装程序/);
    assert.doesNotMatch(await page.locator('#siwc-details').innerText(), /PowerShell|安装脚本|检查助手/);
  });
  await check('using another account explicitly requests a new authorization client', async () => {
    const regular = await page.evaluate(() => __siwcUi.calls.find(value => value.type === 'siwc:login'));
    assert.equal(regular.newAccount, undefined);
    await page.locator('#siwc-new-account').click();
    await page.locator('#siwc-cancel').waitFor({ state: 'visible' });
    const newLogin = await page.evaluate(() => __siwcUi.calls.filter(value => value.type === 'siwc:login').at(-1));
    assert.deepEqual(newLogin, { type: 'siwc:login', newAccount: true });
    await page.locator('#siwc-cancel').click();
    await page.waitForFunction(() => !__siwcUi.status.loginPending && !document.querySelector('#save-connection').disabled);
  });
  await check('identity-only authorization stays unusable and cannot be saved as a working subscription', async () => {
    await page.evaluate(() => { __siwcUi.status = { state: 'planDenied', loggedIn: true, planAuthorized: false, models: [], generation: 'unchecked', helperVersion: 'mock-1', accountLabel: '本地测试账号' }; });
    await page.locator('#siwc-refresh').click();
    await page.waitForFunction(() => document.querySelector('#siwc-identity').textContent === '已登录');
    assert.match(await page.locator('#siwc-entitlement').innerText(), /尚未授权/);
    assert.equal(await page.locator('#siwc-model').isDisabled(), true);
    assert.equal(await page.locator('#save-connection').isHidden(), true);
    assert.equal(await page.evaluate(() => __siwcUi.config.provider), 'apiKey');
    assert.equal((await page.evaluate(() => __siwcUi.calls)).filter(value => value.type === 'siwc:save').length, 0);
  });
  await check('refresh only loads models and each explicit model change saves once', async () => {
    await page.evaluate(() => { __siwcUi.status = { state: 'ready', loggedIn: true, planAuthorized: true, models: [{ id: 'mock-official-model', label: '模拟订阅模型' }, { id: 'another-model', label: '另一个模型' }], generation: 'unchecked', helperVersion: 'mock-1', accountLabel: '本地测试账号' }; });
    await page.locator('#siwc-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#siwc-model').disabled);
    assert.match(await page.locator('#siwc-status').innerText(), /对话尚未验证/);
    assert.deepEqual(await page.evaluate(() => __siwcUi.config), { provider: 'apiKey', model: '' });
    assert.equal(await page.locator('#siwc-model').inputValue(), '');
    assert.equal(await page.locator('#save-connection').isHidden(), true);
    await page.locator('#siwc-model').selectOption('mock-official-model');
    await page.waitForFunction(() => __siwcUi.config.model === 'mock-official-model' && !document.querySelector('#siwc-model').disabled);
    await page.locator('#siwc-model').selectOption('another-model');
    await page.waitForFunction(() => __siwcUi.config.model === 'another-model' && !document.querySelector('#siwc-model').disabled);
    await page.locator('#siwc-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#siwc-model').disabled);
    assert.deepEqual(await page.evaluate(() => __siwcUi.calls.filter(call => call.type === 'siwc:save').map(call => call.config.model)), ['mock-official-model', 'another-model']);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const actionSizes = await page.locator('#siwc-details .connection-actions .button:visible').evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
      assert.ok(actionSizes.length >= 4);
      assert.ok(actionSizes.every(size => size.width >= 100 && size.height < 80), `official actions must remain readable at ${width}px: ${JSON.stringify(actionSizes)}`);
      await page.locator('#connection-card').screenshot({ path: path.join(output, `official-settings-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 900 });
  });
  await check('copying official diagnostics exposes only fixed structure and makes no request', async () => {
    await page.evaluate(() => {
      __siwcUi.status = { ...__siwcUi.status, generation: 'blocked', accountId: 'SECRET-account', accountLabel: 'SECRET-person', helperVersion: 'SECRET-helper', accessToken: 'SECRET-token',
        diagnostic: { stage: 'event', reason: 'invalidDelta', httpStatus: 200, contentType: 'text/event-stream', eventType: 'response.output_text.delta', jsonType: 'object', deltaType: 'object',
          eventKeys: ['type', 'delta', 'SECRET-key'], responseKeys: ['id', 'SECRET-key'], responseStatus: 'missing', rawBody: 'SECRET-content', message: 'SECRET-message' } };
    });
    await page.locator('#siwc-refresh').click();
    await page.waitForFunction(() => document.querySelector('#siwc-diagnostic').textContent.includes('文本片段结构不符合要求'));
    const before = await page.evaluate(() => ({ calls: __siwcUi.calls.length, copied: __siwcUi.copied.length }));
    await page.locator('#siwc-copy-diagnostics').click();
    await page.waitForFunction(count => __siwcUi.copied.length === count + 1, before.copied);
    const copied = await page.evaluate(() => __siwcUi.copied.at(-1));
    assert.equal(await page.evaluate(() => __siwcUi.calls.length), before.calls);
    assert.doesNotMatch(copied, /SECRET/);
    const snapshot = JSON.parse(copied.slice(copied.indexOf('\n') + 1));
    assert.equal(snapshot.version, manifest.version);
    assert.equal(snapshot.provider, 'chatgptOAuth');
    assert.deepEqual(Object.keys(snapshot), ['version', 'provider', 'state', 'loggedIn', 'planAuthorized', 'generation', 'diagnostic']);
    assert.deepEqual(snapshot.diagnostic.eventKeys, ['type', 'delta']);
    assert.deepEqual(snapshot.diagnostic.responseKeys, ['id']);
    assert.doesNotMatch(await page.locator('#siwc-diagnostic').innerText(), /SECRET/);
  });
  await check('failed credential logout never claims that local credentials were cleared', async () => {
    for (const failure of ['response', 'view']) {
      await page.evaluate(failure => { __siwcUi.failLogout = failure; __siwcUi.status = { state: 'ready', loggedIn: true, planAuthorized: true, models: [{ id: 'mock-official-model', label: '模拟订阅模型' }], generation: 'unchecked', helperVersion: 'mock-1' }; }, failure);
      await page.locator('#siwc-refresh').click();
      await page.waitForFunction(() => !document.querySelector('#siwc-logout').disabled);
      await page.locator('#siwc-logout').click();
      await page.waitForFunction(() => document.querySelector('#connection-feedback').textContent.includes('尚未确认本机凭证已清除'));
      assert.doesNotMatch(await page.locator('#connection-feedback').innerText(), /已退出本机账号并清除本地凭证/);
    }
    await page.evaluate(() => { __siwcUi.failLogout = ''; __siwcUi.status = { state: 'ready', loggedIn: true, planAuthorized: true, models: [{ id: 'mock-official-model', label: '模拟订阅模型' }], generation: 'unchecked', helperVersion: 'mock-1' }; });
    await page.locator('#siwc-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#siwc-logout').disabled);
  });
  await check('logout reports unconfirmed remote revocation and API switching stays explicit', async () => {
    await page.locator('#siwc-logout').click();
    await page.waitForFunction(() => document.querySelector('#connection-feedback').textContent.includes('远端授权撤销尚未确认'));
    assert.equal(await page.locator('#siwc-logout-notice').isVisible(), true);
    assert.equal(await page.evaluate(() => __siwcUi.config.provider), 'chatgptOAuth');
    await page.locator('#connection-api').check();
    await page.locator('#save-connection').click();
    await page.waitForFunction(() => __siwcUi.config.provider === 'apiKey' && !document.querySelector('#save-connection').disabled);
    assert.equal(await page.locator('#siwc-details').isHidden(), true);
  });
  await page.goto(origin + '/sidepanel.html');
  await check('sidebar accepts official status while distinguishing identity from plan permission', async () => {
    await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, siwcStatus: { state: 'planDenied', loggedIn: true, planAuthorized: false, models: [], generation: 'unchecked' } }));
    assert.match(await page.locator('#chat-status').innerText(), /身份已验证.*尚未授权/);
    assert.match(await page.locator('#chat-setup-text').innerText(), /授权 ChatGPT 套餐用量/);
    assert.equal(await page.locator('#chat-send').isDisabled(), true);
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, hasKey: true, settingsReady: true, siwcStatus: { state: 'ready', loggedIn: true, planAuthorized: true, models: [{ id: 'mock-model', label: 'Mock' }], generation: 'unchecked' } }));
    await page.locator('#chat-input').fill('本地界面测试，不发送');
    assert.equal(await page.locator('#chat-send').isEnabled(), true);
    assert.match(await page.locator('#chat-status').innerText(), /对话尚未验证/);
    assert.match(await page.locator('#chat-history-note').innerText(), /会话仅本次浏览器使用/);
    assert.equal(await page.evaluate(() => __siwcUi.commands.some(value => value.type === 'chat:send')), false);
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, error: 'OpenAI 响应格式不符合预期，本次请求已停止。', siwcStatus: { ...__siwcUi.chat.siwcStatus, generation: 'blocked', diagnostic: { stage: 'completion', reason: 'emptyText', rawBody: 'SECRET-body', responseKeys: ['SECRET-key'] } } }));
    assert.match(await page.locator('#chat-feedback').innerText(), /回答完成检查.*未收到可显示的回答文本/);
    assert.doesNotMatch(await page.locator('#chat-feedback').innerText(), /SECRET/);
    await page.screenshot({ path: path.join(output, 'official-sidebar-390.png'), fullPage: true });
  });
  await check('a fresh Port restores state without losing a draft or partial reply and ignores retired Port callbacks', async () => {
    await page.evaluate(() => {
      __siwcUi.push({ ...__siwcUi.chat, status: 'running', requestId: 'synthetic-request', error: undefined, messages: [{ id: 'user-1', role: 'user', content: '已提交的问题', status: 'done' }, { id: 'answer-1', role: 'assistant', content: '已收到的回答片段', status: 'running' }] });
    });
    await page.locator('#chat-input').fill('接下来的草稿');
    const before = await page.evaluate(() => { __siwcUi.holdStatus = true; const port = __siwcUi.ports.at(-1); __siwcUi.retiredPort = port; port.break(); return __siwcUi.ports.length; });
    await page.waitForFunction(count => __siwcUi.ports.length > count, before);
    assert.equal(await page.locator('#chat-send').isDisabled(), true);
    assert.equal(await page.locator('#chat-input').inputValue(), '接下来的草稿');
    assert.match(await page.locator('#chat-messages').innerText(), /已收到的回答片段/);
    assert.equal(await page.locator('.chat-message[data-role="assistant"]').last().getAttribute('data-status'), 'error');
    await page.evaluate(() => __siwcUi.retiredPort.emit({ ...__siwcUi.chat, messages: [], status: 'idle', hasKey: false, settingsReady: false }));
    assert.match(await page.locator('#chat-messages').innerText(), /已收到的回答片段/);
    assert.equal(await page.locator('#chat-send').isDisabled(), true);
    await page.evaluate(() => { __siwcUi.holdStatus = false; __siwcUi.push({ ...__siwcUi.chat, status: 'interrupted', messages: __siwcUi.chat.messages.map(message => message.role === 'assistant' ? { ...message, content: '已收到', status: 'cancelled' } : message) }); });
    await page.waitForFunction(() => !document.querySelector('#chat-send').disabled);
    assert.equal(await page.locator('#chat-input').inputValue(), '接下来的草稿');
    assert.match(await page.locator('#chat-messages').innerText(), /已收到的回答片段/);
    assert.equal(await page.evaluate(() => __siwcUi.commands.filter(value => value.type === 'chat:send').length), 0);
  });
  await check('an older interrupted checkpoint cannot shrink a displayed fragment during later refreshes or a new turn', async () => {
    await page.evaluate(() => __siwcUi.push(__siwcUi.chat));
    assert.match(await page.locator('#chat-messages').innerText(), /已收到的回答片段/);
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'running', requestId: 'next-request' }));
    assert.match(await page.locator('#chat-messages').innerText(), /已收到的回答片段/);
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, messages: [...__siwcUi.chat.messages, { id: 'user-2', role: 'user', content: '新问题', status: 'done' }, { id: 'answer-2', role: 'assistant', content: '', status: 'running' }] }));
    assert.equal(await page.locator('.chat-message[data-message-id="answer-1"] .chat-message-content').innerText(), '已收到的回答片段');
    assert.equal(await page.locator('.chat-message[data-message-id="answer-1"]').getAttribute('data-status'), 'cancelled');
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'idle', messages: __siwcUi.chat.messages.map(message => message.id === 'answer-2' ? { ...message, content: '新回答', status: 'done' } : message) }));
    assert.equal(await page.locator('.chat-message[data-message-id="answer-1"] .chat-message-content').innerText(), '已收到的回答片段');
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, messages: __siwcUi.chat.messages.map(message => message.id === 'answer-1' ? { ...message, content: '最终', status: 'done' } : message) }));
    assert.equal(await page.locator('.chat-message[data-message-id="answer-1"] .chat-message-content').innerText(), '最终', 'a completed canonical answer must not be replaced by a retained partial');
    await page.evaluate(() => {
      __siwcUi.push({ ...__siwcUi.chat, status: 'running', requestId: 'clear-request', messages: [{ id: 'clear-user', role: 'user', content: '待清空的问题', status: 'done' }, { id: 'clear-answer', role: 'assistant', content: '清空前的长片段', status: 'running' }] });
      __siwcUi.holdStatus = true; __siwcUi.ports.at(-1).break();
    });
    await page.waitForFunction(() => __siwcUi.ports.at(-1).closed === false);
    await page.evaluate(() => { __siwcUi.holdStatus = false; __siwcUi.push({ ...__siwcUi.chat, status: 'interrupted', messages: __siwcUi.chat.messages.map(message => message.role === 'assistant' ? { ...message, content: '清空', status: 'cancelled' } : message) }); });
    assert.equal(await page.locator('.chat-message[data-message-id="clear-answer"] .chat-message-content').innerText(), '清空前的长片段');
    const clearedHistory = await page.evaluate(() => __siwcUi.chat.messages);
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, messages: [], requestId: undefined }));
    assert.equal(await page.locator('.chat-message').count(), 0);
    await page.evaluate(history => __siwcUi.push({ ...__siwcUi.chat, requestId: 'unrelated-request', messages: history }), clearedHistory);
    assert.equal(await page.locator('.chat-message[data-message-id="clear-answer"] .chat-message-content').innerText(), '清空', 'clearing the messages must also discard the local fragment overlay');
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'idle', messages: [], requestId: undefined }));
  });
  await check('different-request recovery and diverging text never reuse a retained fragment', async () => {
    await page.evaluate(() => {
      __siwcUi.push({ ...__siwcUi.chat, status: 'running', requestId: 'different-old', messages: [{ id: 'different-user', role: 'user', content: '问题', status: 'done' }, { id: 'different-answer', role: 'assistant', content: '本地较长内容', status: 'running' }] });
      __siwcUi.holdStatus = true; __siwcUi.ports.at(-1).break();
    });
    await page.waitForFunction(() => __siwcUi.ports.at(-1).closed === false);
    await page.evaluate(() => { __siwcUi.holdStatus = false; __siwcUi.push({ ...__siwcUi.chat, status: 'interrupted', requestId: 'different-new', messages: __siwcUi.chat.messages.map(message => message.role === 'assistant' ? { ...message, content: '本地', status: 'cancelled' } : message) }); });
    assert.equal(await page.locator('.chat-message[data-message-id="different-answer"] .chat-message-content').innerText(), '本地');
    await page.evaluate(() => {
      __siwcUi.push({ ...__siwcUi.chat, status: 'running', requestId: 'diverging', messages: __siwcUi.chat.messages.map(message => message.role === 'assistant' ? { ...message, content: '本地较长内容', status: 'running' } : message) });
      __siwcUi.holdStatus = true; __siwcUi.ports.at(-1).break();
    });
    await page.waitForFunction(() => __siwcUi.ports.at(-1).closed === false);
    await page.evaluate(() => { __siwcUi.holdStatus = false; __siwcUi.push({ ...__siwcUi.chat, status: 'interrupted', messages: __siwcUi.chat.messages.map(message => message.role === 'assistant' ? { ...message, content: '不同内容', status: 'cancelled' } : message) }); });
    assert.equal(await page.locator('.chat-message[data-message-id="different-answer"] .chat-message-content').innerText(), '不同内容');
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'idle', messages: [], requestId: undefined }));
  });
  await check('an unacknowledged question returns to the draft after disconnect and is never automatically resent', async () => {
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'idle', messages: [], error: undefined }));
    await page.locator('#chat-input').fill('仅由这次点击提交的问题');
    await page.locator('#chat-send').click();
    assert.equal(await page.locator('#chat-input').inputValue(), '');
    await page.evaluate(() => __siwcUi.ports.at(-1).break());
    await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
    assert.equal(await page.locator('#chat-input').inputValue(), '仅由这次点击提交的问题');
    assert.equal(await page.evaluate(() => __siwcUi.commands.filter(value => value.type === 'chat:send').length), 1);
  });
  await check('settings receives the completed initial account check and refresh can restore its parent chat Port', async () => {
    await page.goto(origin + '/sidepanel.html?holdInitial=1');
    await page.locator('#tab-settings').click();
    const frame = await (await page.locator('#frame-settings').elementHandle()).contentFrame();
    await frame.waitForFunction(() => !document.querySelector('#save-connection').disabled);
    await frame.locator('#connection-oauth').check();
    assert.match(await frame.locator('#siwc-status').innerText(), /尚未检查/);
    await frame.evaluate(() => { __siwcUi.status = { state: 'ready', loggedIn: true, planAuthorized: true, models: [{ id: 'mock-model', label: 'Mock' }], generation: 'unchecked', helperVersion: 'mock-1' }; });
    await page.evaluate(() => {
      __siwcUi.holdStatus = false;
      __siwcUi.push({ ...__siwcUi.chat, hasKey: true, settingsReady: true, siwcStatus: { state: 'ready', loggedIn: true, planAuthorized: true, models: [{ id: 'mock-model', label: 'Mock' }], generation: 'unchecked' } });
    });
    await frame.waitForFunction(() => document.querySelector('#siwc-status').textContent.includes('套餐用量已授权'));
    assert.equal(await frame.evaluate(() => __siwcUi.calls.filter(value => value.type === 'siwc:refresh').length), 0);
    const before = await page.evaluate(() => { __siwcUi.failConnections = 10; __siwcUi.ports.at(-1).break(); return __siwcUi.connectionAttempts; });
    await page.waitForFunction(() => document.querySelector('#chat-feedback').textContent.includes('暂时无法恢复后台连接'));
    assert.equal(await page.evaluate(() => __siwcUi.connectionAttempts), before + 3);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => __siwcUi.connectionAttempts), before + 3);
    await page.evaluate(() => { __siwcUi.failConnections = 0; });
    await frame.locator('#siwc-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
    assert.equal(await page.evaluate(() => __siwcUi.connectionAttempts), before + 4);
    assert.equal(await page.evaluate(() => __siwcUi.commands.some(value => value.type === 'chat:send' || value.type === 'chat:clear')), false);
    const statusBefore = await page.evaluate(() => __siwcUi.commands.length);
    await page.evaluate(() => dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data: { type: 'reader:connection-changed' } })));
    assert.equal(await page.evaluate(() => __siwcUi.commands.length), statusBefore, 'a same-origin message from the wrong source must not refresh the chat');
  });
  await check('automatic search has no manual switch and plain answers never fabricate a search indicator', async () => {
    await page.goto(origin + '/sidepanel.html');
    await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, hasKey: true, settingsReady: true, messages: [
      { id: 'plain-user', role: 'user', content: '解释一个词', status: 'done' },
      { id: 'plain-answer', role: 'assistant', content: '这段文字提到搜索，但没有调用搜索工具。', status: 'done' },
    ] }));
    assert.equal(await page.locator('.chat-search-status:visible').count(), 0);
    assert.equal(await page.locator('.chat-sources:visible').count(), 0);
    assert.equal(await page.getByRole('switch', { name: /联网|搜索/ }).count(), 0);
  });
  await check('actual search metadata renders progress and safe clickable inline citations without changing raw copy', async () => {
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'running', requestId: 'searching-request', messages: [
      { id: 'search-user', role: 'user', content: '查阅最新资料', status: 'done' },
      { id: 'search-answer', role: 'assistant', content: '', status: 'running', search: { state: 'searching', calls: 1 } },
    ] }));
    assert.match(await page.locator('#chat-status').innerText(), /正在联网搜索/);
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, messages: __siwcUi.chat.messages.map(message => message.role === 'assistant' ? { ...message, search: { state: 'reading', calls: 2 } } : message) }));
    assert.match(await page.locator('#chat-status').innerText(), /正在读取网页/);
    const text = '# 当前资料\n\n中文😀**证据**和[文档](https://example.test/doc)。\n\n- 第一项';
    await page.evaluate(text => __siwcUi.push({ ...__siwcUi.chat, status: 'idle', messages: __siwcUi.chat.messages.map(message => message.role === 'assistant' ? {
      ...message, status: 'done', content: text, search: { state: 'complete', calls: 2 }, citations: [
        { start: text.indexOf('证据'), end: text.indexOf('证据') + 2, url: 'https://example.test/source-a', title: '官方资料' },
        { start: text.indexOf('文档'), end: text.indexOf('文档') + 2, url: 'https://example.test/source-b', title: '补充文档' },
      ],
    } : message) }), text);
    const answer = page.locator('[data-message-id="search-answer"]');
    assert.equal(await answer.locator('h1').innerText(), '当前资料');
    assert.equal(await answer.locator('.chat-citation').count(), 2);
    assert.equal(await answer.locator('.chat-sources .chat-source-link').count(), 2);
    assert.equal(await answer.locator('a a').count(), 0);
    assert.equal(await answer.locator('.chat-citation').first().getAttribute('href'), 'https://example.test/source-a');
    assert.equal(await answer.locator('.chat-citation').first().getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await answer.locator('.chat-citation').first().getAttribute('target'), '_blank');
    assert.match(await answer.locator('.chat-search-status').innerText(), /搜索完成/);
    await answer.locator('.chat-copy').click();
    assert.equal(await page.evaluate(() => __siwcUi.copied.at(-1)), text);
    await page.screenshot({ path: path.join(output, 'automatic-search-390.png'), fullPage: true });
  });
  await check('source metadata rejects unsafe URLs and renders hostile titles as text at narrow widths', async () => {
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, messages: [
      { id: 'safe-user', role: 'user', content: '资料', status: 'done' },
      { id: 'safe-answer', role: 'assistant', content: '中文😀资料', status: 'done', search: { state: 'complete', calls: 1 }, citations: [
        { start: 0, end: 3, url: 'https://example.test/safe', title: '<img src=x onerror=alert(1)>资料' },
        { start: 0, end: 2, url: 'javascript:alert(1)', title: '危险' },
        { start: 0, end: 2, url: 'data:text/html,evil', title: '危险' },
      ] },
    ] }));
    const answer = page.locator('[data-message-id="safe-answer"]');
    assert.equal(await answer.locator('.chat-citation').count(), 1);
    assert.equal(await answer.locator('img,script,iframe').count(), 0);
    assert.match(await answer.locator('.chat-sources').innerText(), /<img src=x onerror=alert\(1\)>资料/);
    assert.ok(!(await answer.innerText()).includes('\ufffd'));
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 390, height: 900 });
  });
  await check('search interruption remains explicit and reconnect preserves source metadata without resending', async () => {
    await page.evaluate(() => {
      __siwcUi.push({ ...__siwcUi.chat, status: 'running', requestId: 'search-interrupted', messages: [
        { id: 'interrupt-user', role: 'user', content: '查阅', status: 'done' },
        { id: 'interrupt-answer', role: 'assistant', content: '查到资料片段', status: 'running', search: { state: 'searching', calls: 1 }, citations: [{ start: 0, end: 2, url: 'https://example.test/partial', title: '部分来源' }] },
      ] });
      __siwcUi.holdStatus = true; __siwcUi.ports.at(-1).break();
    });
    await page.waitForFunction(() => __siwcUi.ports.at(-1).closed === false);
    const before = await page.evaluate(() => __siwcUi.commands.filter(value => value.type === 'chat:send').length);
    await page.evaluate(() => { __siwcUi.holdStatus = false; __siwcUi.push({ ...__siwcUi.chat, status: 'interrupted', messages: __siwcUi.chat.messages.map(message => message.role === 'assistant' ? { ...message, content: '查到', status: 'cancelled', search: { state: 'failed', calls: 1 }, citations: [] } : message) }); });
    const answer = page.locator('[data-message-id="interrupt-answer"]');
    assert.match(await answer.innerText(), /查到.*资料片段/s);
    assert.match(await answer.locator('.chat-search-status').innerText(), /未完成|中断/);
    assert.equal(await answer.locator('.chat-citation').count(), 1);
    assert.equal(await page.evaluate(() => __siwcUi.commands.filter(value => value.type === 'chat:send').length), before);
  });
  await check('response details are collapsed by default and show returned model timing and token counters with exact zeros', async () => {
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'idle', messages: [
      { id: 'details-user', role: 'user', content: '说明本次回答', status: 'done', details: { model: 'never-display-user-details' } },
      { id: 'details-answer', role: 'assistant', content: '**本次回答**保留原始 Markdown。', status: 'done', details: { model: 'returned-model-1', durationMs: 1250, firstTokenMs: 0, usage: { inputTokens: 1234, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 7, totalTokens: 1254 } } },
      { id: 'details-zero', role: 'assistant', content: '零用量示例', status: 'done', details: { durationMs: 0, usage: { inputTokens: 0, totalTokens: 0 } } },
    ] }));
    const answer = page.locator('[data-message-id="details-answer"]');
    const disclosure = answer.locator('.chat-response-details');
    assert.equal(await disclosure.evaluate(element => element.open), false);
    assert.equal(await answer.locator('.chat-details-body').isVisible(), false);
    assert.equal(await page.locator('[data-message-id="details-user"] .chat-response-details').count(), 0);
    await answer.locator('summary').focus();
    await answer.locator('summary').press('Enter');
    await disclosure.evaluate(element => { if (!element.open) throw new Error('Keyboard Enter did not expand details'); });
    for (const [key, value] of Object.entries({ model: 'returned-model-1', durationMs: '1.25 秒', firstTokenMs: '0 毫秒', inputTokens: '1,234', outputTokens: '20', cachedInputTokens: '0', reasoningTokens: '7', totalTokens: '1,254' })) {
      assert.equal(await answer.locator(`[data-detail-key="${key}"] dd`).innerText(), value);
    }
    assert.match(await answer.locator('.chat-details-note').last().innerText(), /不代表剩余订阅额度/);
    const zero = page.locator('[data-message-id="details-zero"]');
    await zero.locator('summary').click();
    for (const key of ['durationMs', 'inputTokens', 'totalTokens']) assert.match(await zero.locator(`[data-detail-key="${key}"] dd`).innerText(), /^0(?: 毫秒)?$/);
    assert.equal(await zero.locator('[data-detail-key="outputTokens"] dd').innerText(), '未返回');
    assert.equal(await zero.locator('[data-detail-key="model"],[data-detail-key="firstTokenMs"],[data-detail-key="cachedInputTokens"],[data-detail-key="reasoningTokens"]').count(), 0);
    await answer.locator('.chat-copy').click();
    assert.equal(await page.evaluate(() => __siwcUi.copied.at(-1)), '**本次回答**保留原始 Markdown。');
  });
  await check('old messages have no empty disclosure and hostile or invalid detail fields never reach the UI', async () => {
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, messages: [
      { id: 'details-old', role: 'assistant', content: '历史回答', status: 'done' },
      { id: 'details-hostile', role: 'assistant', content: '安全回答', status: 'done', details: { model: '<img src=x onerror=alert(1)>', durationMs: 'secret-time', firstTokenMs: -1, accessToken: 'secret-token', usage: { inputTokens: '999', outputTokens: -3, totalTokens: null, cachedInputTokens: {}, reasoningTokens: 0.5, unknown: 'secret-usage' } } },
      { id: 'details-safe-subset', role: 'assistant', content: '有效字段保留', status: 'done', details: { model: { secret: 'secret-model' }, usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0, reasoningTokens: 9 } } },
    ] }));
    for (const id of ['details-old', 'details-hostile']) assert.equal(await page.locator(`[data-message-id="${id}"] .chat-response-details`).isVisible(), false);
    const safe = page.locator('[data-message-id="details-safe-subset"]');
    await safe.locator('summary').click();
    assert.equal(await safe.locator('[data-detail-key="inputTokens"] dd').innerText(), '1');
    assert.equal(await safe.locator('[data-detail-key="outputTokens"] dd').innerText(), '0');
    assert.equal(await safe.locator('[data-detail-key="totalTokens"] dd').innerText(), '未返回');
    assert.equal(await safe.locator('[data-detail-key="cachedInputTokens"],[data-detail-key="reasoningTokens"]').count(), 0);
    assert.equal(await page.locator('.chat-response-details img,.chat-response-details script,.chat-response-details iframe,.chat-response-details a').count(), 0);
    assert.doesNotMatch(await page.locator('#chat-messages').textContent(), /secret-|onerror|<img/);
  });
  await check('response details preserve their disclosure node and keyboard expansion across stream and status updates', async () => {
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'running', requestId: 'details-stream', messages: [
      { id: 'details-live', role: 'assistant', content: '初始片段', status: 'running', details: { model: 'returned-stream-model', firstTokenMs: 22 } },
    ] }));
    const answer = page.locator('[data-message-id="details-live"]');
    await answer.locator('summary').focus();
    await answer.locator('summary').press('Space');
    await page.evaluate(() => { globalThis.__detailsDisclosure = document.querySelector('[data-message-id="details-live"] details'); });
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, messages: __siwcUi.chat.messages.map(message => ({ ...message, content: '初始片段，继续输出。', details: { ...message.details, durationMs: 1500, usage: { inputTokens: 9, outputTokens: 4 } } })) }));
    await page.locator('#tab-chat').click();
    assert.equal(await page.evaluate(() => __detailsDisclosure === document.querySelector('[data-message-id="details-live"] details') && __detailsDisclosure.open), true);
    assert.equal(await answer.locator('[data-detail-key="durationMs"] dd').innerText(), '1.5 秒');
    assert.equal(await answer.locator('[data-detail-key="totalTokens"] dd').innerText(), '未返回');
  });
  await check('response details and unsent draft survive an interrupted same-message recovery without automatic resend', async () => {
    await page.locator('#chat-input').fill('尚未发送的草稿');
    await page.evaluate(() => { __siwcUi.holdStatus = true; __siwcUi.ports.at(-1).break(); });
    await page.waitForFunction(() => __siwcUi.ports.at(-1).closed === false);
    const before = await page.evaluate(() => __siwcUi.commands.filter(value => value.type === 'chat:send').length);
    await page.evaluate(() => { __siwcUi.holdStatus = false; __siwcUi.push({ ...__siwcUi.chat, status: 'interrupted', messages: __siwcUi.chat.messages.map(({ details, ...message }) => ({ ...message, status: 'cancelled' })) }); });
    const answer = page.locator('[data-message-id="details-live"]');
    assert.equal(await answer.locator('details').evaluate(element => element.open), true);
    assert.equal(await answer.locator('[data-detail-key="model"] dd').innerText(), 'returned-stream-model');
    assert.equal(await answer.locator('[data-detail-key="outputTokens"] dd').innerText(), '4');
    assert.equal(await page.locator('#chat-input').inputValue(), '尚未发送的草稿');
    assert.equal(await page.evaluate(() => __siwcUi.commands.filter(value => value.type === 'chat:send').length), before);
    await answer.locator('.chat-copy').click();
    assert.equal(await page.evaluate(() => __siwcUi.copied.at(-1)), '初始片段，继续输出。');
  });
  await check('expanded response details retain source placement and wrap long returned model identifiers at 390 and 320 pixels', async () => {
    await page.evaluate(() => __siwcUi.push({ ...__siwcUi.chat, status: 'idle', messages: [
      { id: 'details-narrow', role: 'assistant', content: '回答正文与来源。', status: 'done', citations: [{ start: 0, end: 4, url: 'https://example.test/details-source', title: '官方资料' }], details: { model: 'returned-model-' + 'very-long-identifier-'.repeat(6), durationMs: 2490, firstTokenMs: 347, usage: { inputTokens: 1234567, cachedInputTokens: 123456, outputTokens: 8910, reasoningTokens: 1200, totalTokens: 1243477 } } },
    ] }));
    const answer = page.locator('[data-message-id="details-narrow"]');
    await answer.locator('summary').click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await answer.evaluate(element => {
        const sources = element.querySelector('.chat-sources'), details = element.querySelector('details');
        return !!(sources.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING) && element.scrollWidth <= element.clientWidth && details.scrollWidth <= details.clientWidth && document.documentElement.scrollWidth <= innerWidth;
      }), true);
      await answer.screenshot({ path: path.join(output, `response-details-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 900 });
  });
  await check('pagehide cancels scheduled recovery and later focus cannot restart it', async () => {
    const before = await page.evaluate(() => { __siwcUi.ports.at(-1).break(); dispatchEvent(new Event('pagehide')); dispatchEvent(new Event('focus')); return __siwcUi.connectionAttempts; });
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => __siwcUi.connectionAttempts), before);
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(report.unexpectedNetwork, []);
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  process.stderr.write(error.stack + '\n');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  report.testedBuild.unchangedAfterTest = buildFingerprint(await hashDirectory(dist)) === report.testedBuild.fingerprint;
  if (!report.testedBuild.unchangedAfterTest) { report.error ||= 'Production build changed during UI tests'; process.exitCode = 1; }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

// Real MV3 events, runtime messages, WebCrypto and worker teardown; synthetic
// OAuth/Responses fixtures only. The user's Chrome profile is never opened.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist'), output = path.join(root, 'test-results', 'siwc-auth');
await fs.mkdir(output, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const candidate = path.join(root, '.browsers');
  try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; } catch {}
}
const { chromium } = await import('playwright');
const manifestText = await fs.readFile(path.join(dist, 'manifest.json'), 'utf8'), manifest = JSON.parse(manifestText);
const files = await hashDirectory(dist);
const profile = await fs.mkdtemp(path.join(output, 'isolated-profile-')), extension = path.join(profile, 'extension');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: 'e2e-synthetic', use: 'sig' };
const report = { version: manifest.version, mockOnly: true, realAccountVerified: false, realModelVerified: false, checks: [], unexpectedNetwork: [], actualWorkerStopVerified: false,
  testedBuild: { fingerprint: buildFingerprint(files), files, unchangedAfterTest: false, testCopyRestored: false },
  testHarness: { realChromeApis: true, realWebCrypto: true, syntheticFetchInWorker: true, permissionDialogVerified: false, nativeSidePanelVerified: false, isolatedChromiumProfile: true } };
let context, worker, settings, extensionId, cdp;
const versions = new Map();
async function until(fn, message = 'condition not reached') {
  const end = Date.now() + 15000; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`${message}${last ? ': ' + last.message : ''}`);
}
async function check(name, action) { await action(); report.checks.push({ name, result: 'pass' }); process.stdout.write(`PASS ${name}\n`); }
function tokens(nonce) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_synthetic', sub: 'synthetic-account', email: 'fixture@example.test', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return { access_token: 'e2e-synthetic-access', refresh_token: 'e2e-synthetic-refresh', id_token: `${header}.${payload}.${signature}`, token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' };
}
async function installFixture(target) {
  await target.evaluate(jwk => {
    globalThis.__authFixture = { tokens: undefined, requests: [], refreshCount: 0 };
    // No fallback to the real network. Signatures and state checks are performed
    // by the unmodified production auth module, not by this fixture.
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input)), f = globalThis.__authFixture;
      const form = new URLSearchParams(init.body instanceof URLSearchParams ? init.body : '');
      f.requests.push({ origin: url.origin, path: url.pathname, grant: form.get('grant_type') });
      if (url.origin === 'https://auth.openai.com') {
        if (url.pathname === '/.well-known/openid-configuration') return Response.json({ issuer: url.origin, jwks_uri: url.origin + '/.well-known/jwks.json', revocation_endpoint: url.origin + '/revoke' });
        if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
        if (url.pathname === '/revoke') return new Response(null, { status: 200 });
        if (url.pathname === '/api/accounts/oauth/token') {
          if (form.get('grant_type') === 'refresh_token') { f.refreshCount++; return Response.json({ access_token: 'e2e-synthetic-refreshed', refresh_token: 'e2e-synthetic-rotated', token_type: 'Bearer', expires_in: 3600 }); }
          if (!f.tokens || form.get('client_id') !== 'oaiapp_synthetic' || form.get('redirect_uri') !== 'http://127.0.0.1:1455/auth/callback') throw new Error('Invalid synthetic OAuth exchange');
          return Response.json(f.tokens);
        }
      }
      if (url.origin === 'https://api.openai.com') {
        if (url.pathname === '/v1/models') return Response.json({ models: [{ slug: 'gpt-synthetic', display_name: '合成测试模型', visibility: 'list' }] });
        if (url.pathname === '/v1/responses') {
          const body = JSON.parse(init.body);
          const request = f.requests.at(-1);
          request.body = body;
          request.authorized = init.headers.Authorization === 'Bearer e2e-synthetic-access';
          const answer = body.instructions?.includes('双语例句') ? 'This product is useful. 这个产品很实用。'
            : body.instructions?.includes('将选区完整译为') ? '产品'
              : body.instructions?.includes('中文摘要') ? '纯扩展测试摘要' : '纯扩展测试回答';
          return new Response([
            { type: 'response.output_text.delta', delta: answer },
            { type: 'response.completed', response: { status: 'completed' } },
          ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
        }
      }
      throw new Error('Unexpected fixture endpoint');
    };
  }, jwk);
}
async function currentWorker(previous) {
  return until(async () => {
    for (const candidate of context.serviceWorkers()) {
      if (candidate === previous || candidate.url() !== `chrome-extension://${extensionId}/background.js`) continue;
      try { if (await candidate.evaluate(() => !!chrome.runtime.id)) return candidate; } catch {}
    }
  }, 'production worker unavailable');
}
async function rpc(type) { return settings.evaluate(type => chrome.runtime.sendMessage({ type }), type); }
async function authPage() { return until(() => context.pages().find(p => p.url().startsWith('https://auth.openai.com/api/accounts/authorize')), 'authorization tab absent'); }
async function approve(page) {
  const nonce = new URL(page.url()).searchParams.get('nonce');
  await worker.evaluate(value => { globalThis.__authFixture.tokens = value; }, tokens(nonce));
  await page.locator('#approve').click().catch(e => { if (!page.isClosed()) throw e; });
}
try {
  await fs.cp(dist, extension, { recursive: true });
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 900, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-proxy-server', '--host-resolver-rules=EXCLUDE 127.0.0.1, MAP * ~NOTFOUND'] });
  context.setDefaultTimeout(8000);
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://auth.openai.com' && url.pathname === '/api/accounts/authorize') {
      const callback = new URL('http://127.0.0.1:1455/auth/callback');
      callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'e2e-synthetic-code', client_id: 'oaiapp_synthetic' });
      return route.fulfill({ contentType: 'text/html', body: `<title>Synthetic authorization</title><a id="approve" href="${callback.href.replaceAll('&', '&amp;')}">Approve synthetic account</a>` });
    }
    if (url.origin === 'https://fixture.example') {
      const body = url.pathname === '/article'
        ? '<title>Preview article</title><article><p>' + 'PREVIEW_SUMMARY_FACT: The report describes the results of a reading study and its limitations. '.repeat(8) + '</p></article>'
        : '<title>Reading fixture</title><p>This <span id="selection-word">product</span> helps the reader.</p><p><a id="article-link" href="/article">Open the full reading study report</a></p>';
      return route.fulfill({ contentType: 'text/html', body });
    }
    // A loopback redirect is expected. No real helper or listener is started.
    if (url.origin === 'http://127.0.0.1:1455') return route.abort('connectionrefused');
    report.unexpectedNetwork.push({ origin: url.origin, path: url.pathname }); return route.abort();
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).hostname;
  assert.deepEqual(await hashDirectory(extension), files); report.testedBuild.testCopyRestored = true;
  await installFixture(worker);
  settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/options.html`);
  cdp = await context.newCDPSession(settings);
  cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const v of event.versions) versions.set(v.versionId, v); });
  await cdp.send('ServiceWorker.enable');
  await settings.locator('#connection-oauth').check();
  await check('production package has no native messaging or helper installation UI', async () => {
    assert.equal(manifest.permissions.includes('nativeMessaging'), false);
    assert.equal(await settings.locator('#siwc-helper-help, #siwc-extension-id').count(), 0);
    assert.equal((await rpc('siwc:get')).view.status.state, 'signedOut');
    assert.equal(await worker.evaluate(() => __authFixture.requests.length), 0);
  });
  await check('real login navigation returns through Chrome events with no loopback listener', async () => {
    await settings.locator('#siwc-login').click(); const page = await authPage();
    assert.equal(new URL(page.url()).searchParams.get('agent_name_hint'), '阅窗');
    await approve(page);
    await until(async () => (await rpc('siwc:get')).view.status.state === 'ready', 'login did not complete');
    await until(() => page.isClosed(), 'owned auth tab was not closed');
    await until(() => settings.locator('#siwc-model option[value="gpt-synthetic"]').count(), 'model catalog absent');
    await until(async () => (await rpc('siwc:get')).view.config.provider === 'chatgptOAuth', 'subscription was not saved automatically');
    assert.deepEqual((await rpc('siwc:get')).view.config, { provider: 'chatgptOAuth', model: 'gpt-synthetic' });
    assert.equal(await settings.locator('#save-connection').isHidden(), true);
  });
  await check('actual content-script context cannot read credential storage or invoke login RPC', async () => {
    const page = await context.newPage(); await page.goto('https://fixture.example/');
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://fixture.example/*' }))[0].id);
    const result = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
      let storageDenied = false;
      try { const value = await chrome.storage.local.get('siwcCredentialsV1'); storageDenied = value.siwcCredentialsV1 === undefined; } catch { storageDenied = true; }
      const reply = await chrome.runtime.sendMessage({ type: 'siwc:login' });
      return { storageDenied, rpcDenied: reply.ok === false };
    } }))[0].result, tabId);
    assert.deepEqual(result, { storageDenied: true, rpcDenied: true }); await page.close();
  });
  await check('sidepanel sends a complete two-turn conversation directly through Responses', async () => {
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await until(() => panel.locator('#chat-setup').isHidden());
    for (const [index, text] of ['第一问', '继续回答'].entries()) {
      await panel.locator('#chat-input').fill(text); await panel.locator('#chat-send').click();
      await until(async () => await panel.locator('.chat-message[data-role="assistant"][data-status="done"]').count() === index + 1);
    }
    assert.equal(await worker.evaluate(() => __authFixture.requests.filter(r => r.path === '/v1/responses').length), 2);
    await panel.close();
  });
  await check('real selection toolbar translates and expands examples with ChatGPT subscription and no API Key', async () => {
    assert.equal((await rpc('settings:get')).hasKey, false);
    const before = await worker.evaluate(() => __authFixture.requests.length);
    const page = await context.newPage();
    try {
      await page.goto('https://fixture.example/');
      await page.locator('#selection-word').dblclick();
      const toolbar = page.locator('local-reader-selection-toolbar');
      await toolbar.locator('[data-selection-action="translate"]').click();
      const card = page.locator('local-reader-context');
      await card.locator('.status[data-phase="done"]').waitFor();
      assert.equal(await card.locator('[data-context-core]').innerText(), '产品');
      await card.locator('[data-context-action="expand"]').click();
      await until(async () => await card.locator('[data-context-details]').innerText({ timeout: 500 }) === 'This product is useful. 这个产品很实用。', 'subscription examples missing');
      await card.locator('.status[data-phase="done"]').waitFor();
      const requests = await worker.evaluate(before => __authFixture.requests.slice(before), before);
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.origin, 'https://api.openai.com');
        assert.equal(request.path, '/v1/responses');
        assert.equal(request.authorized, true);
        assert.equal(request.body.model, 'gpt-synthetic');
        assert.equal(request.body.store, false);
        assert.equal(request.body.tools, undefined);
        assert.equal(request.body.tool_choice, undefined);
        assert.equal(JSON.parse(request.body.input[0].content).selection, 'product');
      }
      assert.equal(JSON.parse(requests[1].body.input[0].content).existingCoreAnswer, '产品');
    } finally { await page.close(); }
  });
  await check('link preview automatically generates and reuses a subscription summary without an API Key', async () => {
    assert.equal((await rpc('settings:get')).hasKey, false);
    const before = await worker.evaluate(() => __authFixture.requests.length);
    const page = await context.newPage();
    const preview = page.locator('local-reader-preview');
    const action = name => preview.locator(`[data-reader-action="${name}"]`);
    try {
      await page.goto('https://fixture.example/');
      for (const useCache of [false, true]) {
        const box = await page.locator('#article-link').boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + 20, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 90, box.y + box.height / 2 + 22, { steps: 14 });
        await preview.waitFor();
        await page.mouse.up();
        await preview.locator('.page-status[data-state="ready"]').waitFor();
        const status = preview.locator('.status[data-phase="done"]');
        await status.waitFor();
        assert.equal(await preview.locator('[data-reader-output]').innerText(), '纯扩展测试摘要');
        assert.equal((await status.innerText()).includes('缓存'), useCache);
        await action('close').click();
        await preview.waitFor({ state: 'detached' });
      }
      const requests = await worker.evaluate(before => __authFixture.requests.slice(before), before);
      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request.path, '/v1/responses');
      assert.equal(request.authorized, true);
      assert.equal(request.body.model, 'gpt-synthetic');
      assert.equal(request.body.store, false);
      assert.equal(request.body.tools, undefined);
      assert.match(request.body.input[0].content, /PREVIEW_SUMMARY_FACT/);
    } finally { await page.close(); }
  });
  await check('real worker termination retains pending PKCE and completes the original callback after restart', async () => {
    await settings.locator('#connection-api').check();
    await settings.locator('#save-connection').click();
    await until(async () => (await rpc('siwc:get')).view.config.provider === 'apiKey');
    await settings.evaluate(() => { void chrome.runtime.sendMessage({ type: 'siwc:login', newAccount: true }).catch(() => {}); });
    const page = await authPage(); const nonce = new URL(page.url()).searchParams.get('nonce');
    const before = await worker.evaluate(() => chrome.storage.session.get('siwcPendingAuthV1'));
    const version = await until(() => [...versions.values()].filter(v => v.scriptURL === `chrome-extension://${extensionId}/background.js` && v.runningStatus === 'running' && v.status === 'activated').sort((a, b) => Number(b.versionId) - Number(a.versionId))[0]);
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await until(() => versions.get(version.versionId)?.runningStatus === 'stopped', 'worker did not actually stop');
    // Wake the worker without completing or replacing the authorization.
    await settings.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'siwc:get' }).catch(() => {}); });
    worker = await currentWorker();
    // Chrome 143+ can retain the DevTools worker target across executions. Wait
    // for the old context to be discarded rather than comparing Worker objects
    // or trusting a stopped notification that arrives before context teardown.
    await until(() => worker.evaluate(() => globalThis.__authFixture === undefined), 'old worker execution context was not discarded');
    report.actualWorkerStopVerified = true;
    report.actualExecutionContextResetVerified = true;
    await installFixture(worker);
    const after = await worker.evaluate(() => chrome.storage.session.get('siwcPendingAuthV1'));
    assert.deepEqual(after, before);
    await worker.evaluate(value => { __authFixture.tokens = value; }, tokens(nonce));
    await page.locator('#approve').click().catch(e => { if (!page.isClosed()) throw e; });
    await until(() => page.isClosed());
    await until(async () => { const v = (await rpc('siwc:get')).view; return v.status.state === 'ready' && !v.status.loginPending && v.config.provider === 'chatgptOAuth' && v.config.model === 'gpt-synthetic'; });
    assert.equal(await worker.evaluate(() => __authFixture.requests.filter(r => r.grant === 'authorization_code').length), 1);
  });
  await check('stored credentials renew once after expiration and logout clears tokens', async () => {
    await worker.evaluate(async () => { const { siwcCredentialsV1: saved } = await chrome.storage.local.get('siwcCredentialsV1'); saved.active.expiresAt = 1; await chrome.storage.local.set({ siwcCredentialsV1: saved }); });
    const refreshed = await rpc('siwc:refresh'); assert.equal(refreshed.view.status.state, 'ready');
    assert.equal(await worker.evaluate(() => __authFixture.refreshCount), 1);
    const out = await rpc('siwc:logout'); assert.equal(out.view.status.state, 'signedOut'); assert.equal(out.view.status.remoteRevoked, true);
    const saved = await worker.evaluate(() => chrome.storage.local.get('siwcCredentialsV1'));
    assert.ok(!JSON.stringify(saved).includes('e2e-synthetic-access')); assert.ok(!JSON.stringify(saved).includes('e2e-synthetic-refresh')); assert.equal(saved.siwcCredentialsV1.active, undefined);
    const diagnostics = await settings.locator('.privacy-note').innerText(); assert.match(diagnostics, /扩展存储/);
  });
  report.browser = context.browser().version();
} catch (error) { report.fatal = error.stack || String(error); process.exitCode = 1; }
finally {
  await context?.close();
  report.testedBuild.unchangedAfterTest = JSON.stringify(await hashDirectory(dist)) === JSON.stringify(files);
  report.passed = report.checks.length; report.failed = report.fatal ? 1 : 0;
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.fatal) process.stderr.write(report.fatal + '\n');
}

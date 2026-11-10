import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSidebarFixtures } from './fixtures/sidebar-server.mjs';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results'), dist = path.join(root, 'dist');
const baseline = process.argv.includes('--baseline');
const manifestText = await fs.readFile(path.join(dist, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText), version = manifest.version;
const bootstrapLoopback = !manifest.host_permissions?.length;
const testedFiles = await hashDirectory(dist);
await fs.mkdir(output, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) for (const directory of ['.cache/ms-playwright', '.browsers']) {
  const candidate = path.join(root, directory);
  try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; break; } } catch {}
}
const { chromium } = await import('playwright');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fixtures = await startSidebarFixtures({ port: 0, researchPort: 0 });
const profile = await fs.mkdtemp(path.join(output, `sidebar-reconnect-${version}-profile-`));
const extension = path.join(profile, 'test-extension');
const fakeKey = 'sidebar-reconnect-fixture-key-NOT-REAL';
const report = {
  version, extensionVersion: version, date: new Date().toISOString(), baseline, mockOnly: true, realModelVerified: false,
  checks: [], network: [], networkFailures: [], unexpectedNetwork: [], workerEvents: [], actualWorkerStopVerified: false, actualPortDisconnectVerified: false,
  autoResendRequests: 0,
  testedBuild: { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false },
  testHarness: {
    isolatedChromiumProfile: true, productionWorkerWithoutTestEntry: true, productionSourceModified: false,
    testCopyRestored: false, trustedShellFormsAndButtonClicks: true,
    realRuntimePorts: true, mockedRuntimePorts: false, serviceWorkerStop: 'CDP ServiceWorker.stopWorker, scoped to this isolated extension version ID',
    modelFixture: 'Only deterministic loopback API SSE is mocked. Real Chrome MV3 worker teardown and runtime.Port disconnection are exercised.',
    noRealHelperOrAccount: true, nativeSidePanelSurfaceVerified: false,
    permissionBootstrap: bootstrapLoopback ? 'Legacy build temporarily grants 127.0.0.1 before restoring and reloading the production manifest.' : 'The test copy uses the production manifest and its declared website permissions.',
    networkBoundary: 'All DNS names are blocked by isolated Chromium host-resolver rules. Model traffic is literal 127.0.0.1 only.'
  },
  notes: ['The exact packaged sidepanel.html runs as an extension tab; browser toolbar and docked panel rendering are outside this test.',
    'A separate real chat Port observes Chrome onDisconnect without replacing, wrapping or mocking the production Port.',
    'No ChatGPT login, SIWC helper, native host, user profile, real credential, or external model endpoint is used.']
};
let context, shell, worker, extensionId, settings, cdp, fatal, navigationCount = 0, documentId;
const versions = new Map();
const count = () => fixtures.getStats().count;
const assistants = () => shell.locator('.chat-message[data-role="assistant"]');
async function until(predicate, message, timeout = 16000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await sleep(60);
  }
  throw new Error(message + (last ? `: ${last.message}` : ''));
}
async function check(name, operation) {
  const start = Date.now();
  try { const evidence = await operation(); report.checks.push({ name, result: 'pass', milliseconds: Date.now() - start, ...(evidence ? { evidence } : {}) }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { report.checks.push({ name, result: 'fail', milliseconds: Date.now() - start, error: error.message }); throw error; }
}
async function select(name) {
  await shell.locator(`#tab-${name}`).click();
  if (name === 'chat') return shell;
  settings = await until(async () => (await shell.locator('#frame-settings').elementHandle())?.contentFrame(), 'settings frame absent');
  await until(() => settings.locator('#save-settings').isEnabled(), 'settings form unavailable'); return settings;
}
async function configure(model = 'normal') {
  const frame = await select('settings');
  await frame.locator('#base-url').fill(fixtures.origin + '/v1'); await frame.locator('#model').fill(model);
  await frame.locator('#api-key').fill(fakeKey); await frame.locator('#remember-key').setChecked(false);
  await frame.locator('#auto-long-summary').setChecked(false);
  await frame.locator('#save-settings').click();
  await until(async () => { const result = await frame.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' })); return result.ok && result.hasKey && result.settings.model === model && await frame.locator('#save-settings').isEnabled(); }, 'settings not saved');
  await select('chat'); await until(() => shell.locator('#chat-setup').isHidden(), 'chat config did not refresh');
}
async function send(text, expected = 'done') {
  await select('chat'); const before = await assistants().count();
  await shell.locator('#chat-input').fill(text); await until(() => shell.locator('#chat-send').isEnabled(), 'chat send disabled'); await shell.locator('#chat-send').click();
  await until(async () => await assistants().count() > before && await assistants().last().getAttribute('data-status') === expected, `chat did not become ${expected}`);
  if (expected === 'done') await until(() => shell.locator('#chat-stop').isHidden(), 'completed chat remained busy');
}
async function assertSameDocument(draft) {
  assert.equal(await shell.evaluate(() => window.__reconnectDocumentId), documentId);
  assert.equal(navigationCount, 0, 'reconnection must not reload or navigate the shell');
  assert.equal(await shell.locator('#chat-input').inputValue(), draft);
}
async function stopWorker() {
  // This is a real extra Chrome Port with the same trusted sender boundary. It
  // observes teardown only; no replacement transport or synthetic event exists.
  await shell.evaluate(() => {
    const record = { disconnected: false, messages: 0 };
    const observer = chrome.runtime.connect({ name: 'chat' });
    window.__reconnectObserver = { record, observer };
    observer.onMessage.addListener(() => { record.messages++; });
    observer.onDisconnect.addListener(() => { void chrome.runtime.lastError; record.disconnected = true; });
  });
  await until(() => shell.evaluate(() => window.__reconnectObserver.record.messages > 0), 'real observer Port did not receive background state');
  const current = await until(() => [...versions.values()].find(item => item.scriptURL === `chrome-extension://${extensionId}/background.js` && item.runningStatus === 'running'), 'running extension worker version absent');
  const before = count(), priorEventCount = report.workerEvents.length;
  await cdp.send('ServiceWorker.stopWorker', { versionId: current.versionId });
  await until(() => shell.evaluate(() => window.__reconnectObserver.record.disconnected), 'Chrome did not deliver actual Port onDisconnect');
  await until(() => report.workerEvents.slice(priorEventCount).some(item => item.type === 'version' && item.versionId === current.versionId && item.runningStatus === 'stopped'), 'CDP did not report the exact extension worker stopped');
  report.actualWorkerStopVerified = true; report.actualPortDisconnectVerified = true;
  return { versionId: current.versionId, actualWorkerStopped: true, realPortDisconnected: true, requestsAtStop: before };
}
async function waitForRecovery() {
  await until(async () => await shell.locator('#chat-input').isEnabled() && !(await shell.locator('#chat-status').innerText()).includes('正在连接') && !(await shell.locator('#chat-status').innerText()).includes('断开'), 'same-document chat did not reconnect', 12000);
  worker = await until(() => context.serviceWorkers().find(candidate => candidate.url() === `chrome-extension://${extensionId}/background.js`), 'restarted worker unavailable');
}
try {
  await fs.cp(dist, extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  if (bootstrapLoopback) await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 500, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-proxy-server', '--host-resolver-rules=EXCLUDE 127.0.0.1, EXCLUDE localhost, MAP * ~NOTFOUND'] });
  context.setDefaultTimeout(8000);
  context.on('request', request => { if (request.url().startsWith('http')) report.network.push({ method: request.method(), url: request.url() }); });
  context.on('requestfailed', request => {
    if (!request.url().startsWith('http')) return;
    const failure = { method: request.method(), url: request.url(), failure: request.failure()?.errorText || 'network failure' };
    report.networkFailures.push(failure);
    if (failure.failure !== 'net::ERR_ABORTED' || new URL(failure.url).hostname !== '127.0.0.1') report.unexpectedNetwork.push(failure);
  });
  context.on('serviceworker', value => report.workerEvents.push({ type: 'started', url: value.url(), date: new Date().toISOString() }));
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).hostname;
  report.browser = context.browser().version(); report.fixtureOrigin = fixtures.origin;
  if (bootstrapLoopback) {
    await fs.writeFile(manifestPath, manifestText);
    const extensionManager = await context.newPage(); await extensionManager.goto('chrome://extensions');
    await extensionManager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    await extensionManager.evaluate(id => { void chrome.developerPrivate.reload(id); }, extensionId);
    worker = await until(async () => {
      for (const candidate of context.serviceWorkers()) {
        if (new URL(candidate.url()).hostname !== extensionId) continue;
        try { if (await candidate.evaluate(() => !chrome.runtime.getManifest().host_permissions?.length)) return candidate; } catch {}
      }
    }, 'restored worker missing');
    await extensionManager.close();
  }
  assert.deepEqual(await hashDirectory(extension), testedFiles); report.testHarness.testCopyRestored = true;
  shell = await context.newPage(); await shell.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(() => shell.locator('#chat-input').isEnabled(), 'sidepanel did not initialize');
  documentId = await shell.evaluate(() => window.__reconnectDocumentId = crypto.randomUUID());
  shell.on('framenavigated', frame => { if (frame === shell.mainFrame()) navigationCount++; });
  cdp = await context.newCDPSession(shell);
  cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const value of event.versions) {
    versions.set(value.versionId, value);
    if (value.scriptURL === `chrome-extension://${extensionId}/background.js`) report.workerEvents.push({ type: 'version', versionId: value.versionId, runningStatus: value.runningStatus, date: new Date().toISOString() });
  } });
  await cdp.send('ServiceWorker.enable');
  await check('real controls configure only a loopback API and deliver one completed chat', async () => {
    await configure(); await send('重连测试的已完成消息。'); assert.equal(count(), 1);
    assert.match(await assistants().last().innerText(), /本地模拟回复/);
    assert.equal(await shell.locator('.chat-message').count(), 2);
    return { realButtonClicks: true, completedModelRequests: 1, modelEndpoint: fixtures.origin, helperOrAccountUsed: false };
  });
  await check(baseline ? 'baseline records the actual worker and Port disconnect while the original sidepanel remains unusable' : 'idle worker teardown reconnects the real Port in the original document and retains draft and completed history', async () => {
    const draft = '这段尚未发送的草稿必须保留'; await shell.locator('#chat-input').fill(draft);
    const messagesBefore = await shell.locator('#chat-messages').innerText(), before = count();
    const teardown = await stopWorker();
    if (baseline) {
      await sleep(4500);
      const snapshot = { disabled: await shell.locator('#chat-input').isDisabled(), status: await shell.locator('#chat-status').innerText(), feedback: await shell.locator('#chat-feedback').innerText() };
      assert.equal(snapshot.disabled, true); assert.match(snapshot.status, /断开/);
      assert.match(snapshot.feedback, /连接已断开/); report.observedBaselineBug = true; report.baselineUi = snapshot;
    } else {
      await waitForRecovery(); assert.equal(await shell.locator('#chat-send').isEnabled(), true);
      assert.ok(!(await shell.locator('#chat-feedback').innerText()).includes('重新打开侧栏'));
    }
    await assertSameDocument(draft); assert.equal(await shell.locator('#chat-messages').innerText(), messagesBefore);
    report.autoResendRequests += Math.max(0, count() - before);
    assert.equal(count(), before, 'worker restoration must not automatically resend a model request');
    return { ...teardown, recovered: !baseline, sameDocument: true, draftPreserved: true, historyPreserved: true, automaticModelRetries: 0 };
  });
  if (!baseline) {
    await check('a user sends the retained draft exactly once after recovery', async () => {
      const before = count(); await shell.locator('#chat-send').click();
      await until(async () => count() === before + 1 && await assistants().last().getAttribute('data-status') === 'done', 'manual send after recovery did not finish');
      await sleep(500); assert.equal(count(), before + 1);
      assert.equal(fixtures.getStats().requests.at(-1).body.messages.at(-1).content, '这段尚未发送的草稿必须保留');
      assert.equal(fixtures.getStats().requests.at(-1).body.messages.length, 4);
      return { explicitUserSend: true, newModelRequests: 1, completedContextRestored: true };
    });
    await check('a stopped worker interrupts active SSE without resending and recovers the next unsent draft', async () => {
      await configure('slow'); const before = count(); await send('停止后台时正在生成的测试。', 'running');
      await until(async () => (await assistants().last().innerText()).includes('本地模拟'), 'partial SSE answer did not arrive');
      await until(() => shell.evaluate(async () => { const value = (await chrome.storage.session.get('chatSession')).chatSession; return value?.status === 'running' && value.messages?.at(-1)?.content?.length > 0; }), 'active chat checkpoint did not persist');
      const draft = '回答中断时仍保留的下一条草稿'; await shell.locator('#chat-input').fill(draft);
      const teardown = await stopWorker(); await waitForRecovery(); await assertSameDocument(draft);
      await until(async () => ['cancelled', 'error'].includes(await assistants().last().getAttribute('data-status')), 'unfinished answer did not restore as interrupted');
      assert.match(await shell.locator('#chat-status').innerText(), /中断|停止/);
      await until(() => fixtures.getStats().requests.at(-1).aborted, 'worker termination did not abort real loopback SSE');
      await sleep(700); report.autoResendRequests += Math.max(0, count() - before - 1);
      assert.equal(count(), before + 1, 'interrupted request must not be automatically retried');
      assert.equal(await shell.locator('#chat-send').isEnabled(), true);
      return { ...teardown, recovered: true, activeHttpStreamAborted: true, checkpointRestored: true, nextDraftPreserved: true, automaticModelRetries: 0 };
    });
  }
  await check('production bytes and loopback-only credential boundaries remain intact', async () => {
    assert.deepEqual(await hashDirectory(dist), testedFiles); assert.deepEqual(await hashDirectory(extension), testedFiles);
    assert.ok(report.network.every(item => new URL(item.url).hostname === '127.0.0.1'));
    assert.deepEqual(report.unexpectedNetwork, []);
    assert.ok(!JSON.stringify(report).includes(fakeKey));
    return { productionBytesUnchanged: true, externalHttpRequests: 0, realCredentialUsed: false, mockedPortEvents: 0 };
  });
} catch (error) {
  fatal = error; report.fatal = error.message; process.stdout.write(`FATAL ${error.message}\n`);
  if (shell && !shell.isClosed()) report.failureUi = { status: await shell.locator('#chat-status').innerText().catch(() => ''), feedback: await shell.locator('#chat-feedback').innerText().catch(() => '') };
} finally {
  await cdp?.detach().catch(() => {}); await context?.close().catch(() => {}); await fixtures.close();
  report.testedBuild.unchangedAfterTest = JSON.stringify(await hashDirectory(dist)) === JSON.stringify(testedFiles);
  if (!report.testedBuild.unchangedAfterTest) { report.fatal = 'Production dist changed during reconnect test'; fatal ??= new Error(report.fatal); }
  report.passed = report.checks.filter(item => item.result === 'pass').length; report.failed = report.checks.filter(item => item.result === 'fail').length;
  report.mockModelRequests = fixtures.getStats().count;
  report.testedBuild.testCopyRestored = report.testHarness.testCopyRestored;
  report.coverage = { actualWorkerStop: report.checks.some(item => item.evidence?.realPortDisconnected), sameDocument: report.checks.some(item => item.evidence?.sameDocument),
    automaticReconnect: !baseline && report.checks.some(item => item.evidence?.recovered), draftPreserved: report.checks.some(item => item.evidence?.draftPreserved),
    noAutomaticModelRetry: report.checks.some(item => item.evidence?.automaticModelRetries === 0), interruptedStream: report.checks.some(item => item.evidence?.activeHttpStreamAborted),
    productionBytesUnchanged: report.testedBuild.unchangedAfterTest };
  const reportDirectory = path.join(output, 'sidebar-reconnect'); await fs.mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `${version}${baseline ? '-baseline' : ''}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  const resolved = path.resolve(profile), allowed = path.resolve(output);
  assert.ok(resolved !== allowed && resolved.startsWith(allowed + path.sep), 'refusing profile cleanup outside test-results');
  await fs.rm(resolved, { recursive: true, force: true });
  process.stdout.write(`Sidebar reconnect ${baseline ? 'baseline ' : ''}${version}: ${report.passed} passed, ${report.failed} failed.\n`);
  if (fatal || report.failed) process.exitCode = 1;
}

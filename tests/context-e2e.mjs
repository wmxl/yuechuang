import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from './fixtures/server.mjs';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const screenshots = path.join(output, 'context-' + version);
await fs.mkdir(screenshots, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  for (const directory of ['.cache/ms-playwright', '.browsers']) {
    const candidate = path.join(root, directory);
    try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; break; } } catch {}
  }
}
const { chromium } = await import('playwright');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, message, timeout = 12000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await sleep(60);
  }
  throw new Error(message + (last ? `: ${last.message}` : ''));
}
function assertTestDirectory(directory) {
  const actual = path.resolve(directory), allowed = path.resolve(output);
  assert.ok(actual !== allowed && actual.startsWith(allowed + path.sep), 'refusing to clean outside test-results');
}
const testedFiles = await hashDirectory(path.join(root, 'dist'));
const productionManifest = await fs.readFile(path.join(root, 'dist/manifest.json'), 'utf8');
const manifest = JSON.parse(productionManifest);
assert.equal(manifest.version, version, 'Build the current extension before running context e2e');
assert.ok(manifest.permissions.includes('contextMenus'));
const report = {
  mockOnly: true, realModelVerified: false, nativeMenuSelectionVerified: false,
  extensionVersion: manifest.version, date: new Date().toISOString(), checks: [], network: [],
  testedBuild: { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false },
  testHarness: {
    toolbarFlowProductionWorker: false,
    toolbarUsesProductionWorkerWithoutTestEntry: false,
    toolbarTrustedMouseOrKeyboard: true, toolbarSyntheticClickRejected: false,
    nativeMenuCallbackInstrumented: false, trustedNativeContextMenuEvent: false,
    productionSourceModified: false, testCopyRestored: false,
    permissionBootstrap: 'Website access is declared in the production manifest and is active in a fresh profile.'
  },
  coverage: { automaticToolbarZeroRequests: false, oneClickTranslation: false, mainAndPreviewFrames: false, bilingualPairs: false, usageExamples: false, longTranslationNoExamples: false, selectionLifecycle: false, m1DragSmoke: false },
  notes: [
    'Toolbar cases use real mouse/keyboard selection and real button clicks in a production worker with no test entry. Programmatic selection and DOM.click are separate negative controls.',
    'Only supplemental native-menu cases instrument a temporary worker copy to invoke its registered onClicked listener after a trusted contextmenu event. Native menu item selection remains manual.',
    'All model responses are deterministic local mock SSE. These checks verify data flow, cancellation, prompts and UI partitions; actual model answer quality remains unverified.',
    'Reports and screenshots are stored by extension version.'
  ]
};
const fixtures = await startFixtures({ port: Number(process.env.FIXTURE_PORT || 4327) });
report.fixtureOrigin = fixtures.origin;
const profile = await fs.mkdtemp(path.join(output, 'context-' + version + '-profile-'));
assertTestDirectory(profile);
const testExtension = path.join(profile, 'test-extension');
assertTestDirectory(testExtension);
const fakeKey = 'm2-local-mock-key-do-not-use-with-real-service';
let context, options, source, worker, extensionId, fatal, productionBackground, backgroundPath, nativeProfile;
const host = frame => frame.locator('local-reader-context');
const toolbar = frame => frame.locator('local-reader-selection-toolbar');
const tool = (frame, name) => toolbar(frame).locator(`[data-selection-action="${name}"]`);
const panel = frame => host(frame).locator('.panel');
const status = frame => host(frame).locator('.status[data-phase]');
const answer = frame => host(frame).locator('[data-context-output]');
const core = frame => host(frame).locator('[data-context-core]');
const details = frame => host(frame).locator('[data-context-details]');
const action = (frame, name) => host(frame).locator(`[data-context-action="${name}"]`);
const stats = () => fixtures.getStats();
const count = () => stats().count;
const latest = () => stats().requests.at(-1);
const input = () => JSON.parse(latest().body.messages[1].content);
const prompt = () => latest().body.messages[0].content;
async function check(name, operation, pathKind = 'production-toolbar') {
  const started = Date.now(), before = stats().totalRequestsSinceStart;
  try {
    const evidence = await operation(); const after = stats().totalRequestsSinceStart;
    report.checks.push({ name, path: pathKind, result: 'pass', milliseconds: Date.now() - started, requestsBefore: before, requestsAfter: after, newRequests: after - before, ...(evidence ? { evidence } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    const after = stats().totalRequestsSinceStart;
    report.checks.push({ name, path: pathKind, result: 'fail', milliseconds: Date.now() - started, requestsBefore: before, requestsAfter: after, newRequests: after - before, error: error.message });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    await source?.screenshot({ path: path.join(screenshots, `failure-${report.checks.length}.png`) }).catch(() => {});
  }
}
async function settings(model = 'normal', key) {
  await options.bringToFront(); await until(() => options.locator('#save-settings').isEnabled(), 'settings unavailable');
  await options.locator('#base-url').fill(fixtures.origin + '/v1'); await options.locator('#model').fill(model);
  await options.locator('#remember-key').setChecked(false);
  await options.locator('#input-budget').fill('16000'); await options.locator('#auto-long-summary').setChecked(false);
  if (key !== undefined) await options.locator('#api-key').fill(key);
  await options.locator('#save-settings').click();
  await until(async () => await options.locator('#save-settings').isEnabled() && (await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }))).settings.model === model, 'settings save did not complete');
}
async function gotoContext(foreign = false) {
  await source.bringToFront(); await source.goto(fixtures.origin + (foreign ? '/context-foreign' : '/context-tech'));
  await source.locator(foreign ? '#term-foreign' : '#term-a').waitFor(); await sleep(180); return source;
}
async function selected(frame) { return frame.evaluate(() => getSelection()?.toString() || ''); }
async function realSelect(frame, selector, { paragraph = false, keyboard = false, allowEmpty = false } = {}) {
  const page = typeof frame.page === 'function' ? frame.page() : frame;
  await page.bringToFront(); const term = frame.locator(selector); await term.scrollIntoViewIfNeeded();
  // Deliver the scrolling caused by locating an off-screen target before the
  // trusted selection gesture. A late event would correctly dismiss that UI.
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await term.boundingBox(); assert.ok(box, 'selectable target missing: ' + selector);
  const x = box.x + Math.min(box.width / 2, 70), y = box.y + Math.min(box.height / 2, 14);
  if (paragraph) await page.mouse.click(x, y, { clickCount: 3 });
  else await page.mouse.dblclick(x, y);
  if (keyboard) { await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Control+Shift+ArrowRight'); }
  const text = await selected(frame); if (!allowEmpty) assert.ok(text.trim(), 'real mouse/keyboard did not select text');
  return text;
}
async function selectToolbar(frame, selector, options = {}) {
  const before = count(), text = await realSelect(frame, selector, options);
  await toolbar(frame).waitFor({ state: 'visible' });
  await sleep(120); assert.equal(count(), before, 'showing toolbar must make zero API requests');
  return text;
}
async function clickToolbar(frame, mode = 'explain') {
  const text = await selected(frame), previous = await host(frame).count() ? await panel(frame).getAttribute('data-request-id') : undefined;
  await tool(frame, mode).click();
  assert.equal(await selected(frame), text, 'toolbar click must preserve the real selection');
  await until(async () => await host(frame).count() === 1 && await panel(frame).getAttribute('data-request-id') !== previous, 'context answer did not open');
  return { selectedText: text, requestId: await panel(frame).getAttribute('data-request-id') };
}
async function selectAndInvoke(frame, selector, mode = 'explain', options = {}) {
  await selectToolbar(frame, selector, options); return clickToolbar(frame, mode);
}
async function completed(frame, timeout = 12000) {
  await until(async () => ['done', 'error', 'cancelled', 'interrupted'].includes(await status(frame).getAttribute('data-phase')), 'context response did not finish', timeout);
  assert.equal(await status(frame).getAttribute('data-phase'), 'done', await status(frame).innerText()); return answer(frame).innerText();
}
async function expand(frame) {
  const previous = await panel(frame).getAttribute('data-request-id'); await action(frame, 'expand').click();
  await until(async () => await panel(frame).getAttribute('data-request-id') !== previous, 'expanded response did not replace request');
  return completed(frame);
}
async function closeAnswer(frame) {
  if (await host(frame).count()) { await action(frame, 'close').click(); await host(frame).waitFor({ state: 'detached' }); }
}
async function inViewport(locator) {
  const bounds = await locator.evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.top >= 0 && bounds.bottom <= bounds.height + 1, JSON.stringify(bounds));
  return bounds;
}
async function dragPreview(linkId, expectedPath) {
  await source.bringToFront(); const link = source.locator('#' + linkId); await link.scrollIntoViewIfNeeded(); const box = await link.boundingBox(); assert.ok(box);
  await source.mouse.move(box.x + Math.min(30, box.width / 3), box.y + box.height / 2); await source.mouse.down(); await source.mouse.move(box.x + 95, box.y + box.height / 2 + 22, { steps: 14 });
  await until(async () => (await source.locator('local-reader-preview iframe').getAttribute('src'))?.includes(expectedPath), 'M1 preview iframe did not open');
  assert.equal(await source.locator('local-reader-preview').isVisible(), true, 'M1 preview must appear before mouseup'); await source.mouse.up();
  await until(async () => await source.locator('local-reader-preview .page-status').getAttribute('data-state') === 'ready', 'M1 target frame not ready', 18000);
  const handle = await source.locator('local-reader-preview iframe').elementHandle(); const frame = await handle.contentFrame(); assert.ok(frame); return frame;
}
async function nativeInvoke(frame, selector, mode = 'explain', { clearAfterMenu = false, textOverride } = {}) {
  await source.bringToFront();
  await frame.evaluate(() => {
    window.__contextMenuEvents = [];
    document.addEventListener('contextmenu', event => window.__contextMenuEvents.push({ trusted: event.isTrusted, text: getSelection()?.toString() || '' }), true);
  });
  const text = selector ? await realSelect(frame, selector) : textOverride || '';
  const target = frame.locator(selector || '#ctx-empty'); const box = await target.boundingBox();
  await source.mouse.click(box.x + Math.min(box.width / 2, 60), box.y + Math.min(box.height / 2, 12), { button: 'right' });
  await until(() => frame.evaluate(() => window.__contextMenuEvents.at(-1)?.trusted), 'trusted native contextmenu event missing');
  if (clearAfterMenu) await frame.evaluate(() => getSelection()?.removeAllRanges());
  assert.equal(count(), 0, 'native context menu and capture must not make any API request before the explicit menu action');
  const tab = await options.evaluate(async url => (await chrome.tabs.query({})).find(candidate => candidate.url === url), source.url()); assert.ok(tab?.id);
  const browserFrame = await options.evaluate(async ({ tabId, url }) => (await chrome.webNavigation.getAllFrames({ tabId })).find(candidate => candidate.url === url), { tabId: tab.id, url: frame.url() }); assert.ok(browserFrame?.documentId);
  const info = { menuItemId: mode === 'translate' ? 'contextual-translate' : 'contextual-explain', selectionText: textOverride ?? text, editable: false, frameId: browserFrame.frameId, pageUrl: source.url(), ...(browserFrame.frameId ? { frameUrl: frame.url() } : {}) };
  assert.ok(await worker.evaluate(({ info, tab }) => globalThis.__contextE2EDispatch(info, tab), { info, tab }) >= 1);
  await until(async () => await host(frame).count() === 1, 'native callback did not show UI'); return text;
}

try {
  await fs.cp(path.join(root, 'dist'), testExtension, { recursive: true });
  backgroundPath = path.join(testExtension, manifest.background.service_worker);
  productionBackground = await fs.readFile(backgroundPath, 'utf8');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`, '--no-first-run'] });
  context.setDefaultTimeout(8000);
  context.on('request', request => { if (request.url().startsWith('http')) report.network.push({ method: request.method(), url: request.url() }); });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).hostname;
  assert.equal(await worker.evaluate(() => typeof globalThis.__contextE2EDispatch), 'undefined'); report.testHarness.toolbarUsesProductionWorkerWithoutTestEntry = true; report.testHarness.toolbarFlowProductionWorker = true;
  options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`); await until(() => options.locator('#save-settings').isEnabled(), 'production settings unavailable');
  await check('fresh profile grants HTTP and HTTPS website access without a second prompt', async () => {
    assert.equal(await options.evaluate(() => chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })), true);
    assert.equal(await options.getByRole('button', { name: '授权所有网站' }).count(), 0);
    assert.equal(count(), 0);
  });
  await settings('normal', fakeKey); source = await context.newPage(); await gotoContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixtures.origin }); report.extensionId = extensionId;

  await check('programmatic selection alone creates no toolbar or API call', async () => {
    fixtures.reset(); await source.locator('#term-a').selectText(); await sleep(250); assert.equal(await selected(source), 'coherence');
    assert.equal(await toolbar(source).count(), 0); assert.equal(await host(source).count(), 0); assert.equal(count(), 0);
    await source.evaluate(() => getSelection()?.removeAllRanges());
  });
  await check('trusted selection shows compact toolbar with zero API; DOM.click has no effect', async () => {
    await gotoContext(true); fixtures.reset();
    await source.addStyleTag({ content: 'html > [data-local-reader-root] { visibility: hidden !important; }' });
    assert.equal((await selectToolbar(source, '#term-foreign')).trim(), 'resilience');
    for (const name of ['translate', 'explain', 'close']) await tool(source, name).evaluate(node => node.click());
    await sleep(200); assert.equal(count(), 0); assert.equal(await host(source).count(), 0); assert.equal(await toolbar(source).isVisible(), true);
    assert.equal((await selected(source)).trim(), 'resilience'); report.testHarness.toolbarSyntheticClickRejected = true;
    await inViewport(toolbar(source).locator('.toolbar')); await toolbar(source).locator('.toolbar').screenshot({ path: path.join(screenshots, 'toolbar-desktop.png') });
  });
  await check('translate click makes exactly one request and preserves the real selection', async () => {
    await clickToolbar(source, 'translate'); assert.match(await completed(source), /CONTEXT_TRANSLATION_OUTPUT/); assert.equal(count(), 1);
    assert.equal(await panel(source).isVisible(), true);
    assert.equal(latest().contextMode, 'translate'); assert.equal(input().selection.trim(), 'resilience'); assert.equal((await selected(source)).trim(), 'resilience');
    assert.match(prompt(), /完整译|完整翻译/); assert.match(input().paragraphContext, /FOREIGN_NEAR_BEFORE_SENTINEL/); assert.match(input().paragraphContext, /FOREIGN_NEAR_AFTER_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(latest().body), /CONTEXT_FORM_SECRET|CONTEXT_HIDDEN_SECRET|GLOBAL_NAV_NO_CONTEXT_SECRET/);
    assert.match(await core(source).innerText(), /CONTEXT_TRANSLATION_OUTPUT/); assert.equal(await details(source).isVisible(), false); assert.equal(await action(source, 'expand').innerText(), '双语例句');
    await panel(source).screenshot({ path: path.join(screenshots, 'translate-core-desktop.png') });
  });
  await check('short-English expansion has 1–2 actual English/Chinese pairs in a separate section', async () => {
    const before = await core(source).innerText(); await expand(source); assert.equal(count(), 2); assert.equal(latest().contextAnswerKind, 'details');
    assert.match(prompt(), /1.?2|一.?两|1—2/); assert.match(prompt(), /英文|英语/); assert.match(prompt(), /中文/); assert.match(input().existingCoreAnswer, /CONTEXT_TRANSLATION_OUTPUT/);
    assert.equal(await core(source).innerText(), before); const examples = await details(source).innerText();
    assert.match(examples, /The wetland showed resilience after the drought\.\s*这片湿地在干旱后展现了恢复能力。/);
    assert.match(examples, /The system needs resilience when a server fails\.\s*服务器发生故障时，系统需要具备恢复能力。/);
    assert.equal((examples.match(/^\d\./gm) || []).length, 2); await panel(source).screenshot({ path: path.join(screenshots, 'translate-examples-desktop.png') });
  });
  await check('technical explanation retains nearby context and explicit usage example partition', async () => {
    await gotoContext(); fixtures.reset(); await selectAndInvoke(source, '#term-a'); assert.match(await completed(source), /CONTEXT_A_OUTPUT/); assert.equal(count(), 1); assert.equal(latest().contextMode, 'explain');
    assert.match(input().paragraphContext, /CONTEXT_A_NEAR_SENTINEL/); assert.match(input().paragraphContext, /CONTEXT_A_NEAR_BEFORE_SENTINEL/); assert.match(input().paragraphContext, /CONTEXT_A_NEAR_AFTER_SENTINEL/);
    assert.equal(await action(source, 'expand').innerText(), '用法示例'); const before = await core(source).innerText(); await expand(source); assert.equal(count(), 2);
    assert.match(prompt(), /情境|例子|示例/); assert.match(prompt(), /代码/); assert.equal(await core(source).innerText(), before); assert.match(await details(source).innerText(), /最小代码：const fresh = cached.version === latestVersion;/);
    await panel(source).screenshot({ path: path.join(screenshots, 'explain-usage-desktop.png') });
    await action(source, 'copy').click(); const copied = (await source.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'); assert.ok(copied.includes(before)); assert.match(copied, /最小代码/);
  });
  await check('result controls ignore synthetic page clicks', async () => {
    const before = count(), oldId = await panel(source).getAttribute('data-request-id');
    for (const name of ['retry', 'expand', 'stop', 'pin', 'close']) await action(source, name).evaluate(node => node.click());
    await sleep(180); assert.equal(count(), before); assert.equal(await panel(source).getAttribute('data-request-id'), oldId); assert.equal(await status(source).getAttribute('data-phase'), 'done');
    assert.equal(await action(source, 'pin').getAttribute('aria-pressed'), 'false');
  });
  await check('long paragraph translation sends the complete selection and hides unrelated example action', async () => {
    await gotoContext(true); fixtures.reset(); const text = await selectToolbar(source, '#ctx-long-foreign', { paragraph: true }); assert.ok(text.length > 240);
    await clickToolbar(source, 'translate'); await completed(source); assert.equal(count(), 1); assert.equal(input().selection.trim(), text.trim()); assert.match(input().selection, /LONG_ENGLISH_CONTEXT_SENTINEL/);
    assert.equal(await action(source, 'expand').isVisible(), false); assert.equal(await details(source).isVisible(), false); await panel(source).screenshot({ path: path.join(screenshots, 'translate-long-no-examples.png') });
    const quote = panel(source).locator('.selection');
    const result = panel(source).locator('.result');
    const divider = panel(source).getByRole('separator', { name: '调整原文高度' });
    const originalHeight = (await quote.boundingBox()).height;
    const resultHeight = (await result.boundingBox()).height;
    const panelHeight = (await panel(source).boundingBox()).height;
    assert.equal((await quote.textContent()).trim(), text.trim());
    const handle = await divider.boundingBox();
    await source.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await source.mouse.down();
    await source.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 32, { steps: 6 });
    await source.mouse.up();
    assert.ok((await quote.boundingBox()).height < originalHeight);
    assert.ok((await result.boundingBox()).height > resultHeight);
    assert.equal((await panel(source).boundingBox()).height, panelHeight);
    await divider.focus(); await source.keyboard.press('End');
    assert.ok((await quote.boundingBox()).height > originalHeight);
    assert.ok((await result.boundingBox()).height >= 36);
    assert.equal(count(), 1);
  });
  await check('keyboard selection completion shows toolbar without a request', async () => {
    await gotoContext(); fixtures.reset(); const text = await selectToolbar(source, '#term-a', { keyboard: true }); assert.match(text, /coherence/); assert.equal(count(), 0);
    await source.keyboard.press('Escape'); await toolbar(source).waitFor({ state: 'detached' }); assert.equal(count(), 0);
  });
  await check('HTTP toolbar hides until reload or across tabs until the site is restored in settings', async () => {
    const url = 'http://reading-fixture.test/article';
    await context.route(url, route => route.fulfill({ contentType: 'text/html', body: '<p>Reading builds <span id="term">coherence</span> through practice.</p>' }));
    const second = await context.newPage();
    try {
      await source.goto(url); fixtures.reset();
      assert.equal(await source.evaluate(() => isSecureContext), false);
      await selectToolbar(source, '#term');
      await tool(source, 'close').click();
      await tool(source, 'hide-page').click();
      await toolbar(source).waitFor({ state: 'detached' });
      await realSelect(source, '#term'); await sleep(180);
      assert.equal(await toolbar(source).count(), 0);

      await source.reload(); await selectToolbar(source, '#term');
      await second.goto(url); await selectToolbar(second, '#term');
      await source.bringToFront();
      await tool(source, 'close').click(); await tool(source, 'hide-site').click();
      await toolbar(source).waitFor({ state: 'detached' });
      await toolbar(second).waitFor({ state: 'detached' });
      await source.reload(); await realSelect(source, '#term'); await sleep(180);
      assert.equal(await toolbar(source).count(), 0);

      await options.bringToFront();
      await options.getByRole('button', { name: '恢复在 reading-fixture.test 显示划词工具条' }).click();
      await options.getByText('暂无隐藏的网站', { exact: true }).waitFor();
      await selectToolbar(source, '#term');
      assert.equal(count(), 0);
    } finally { await second.close(); }
  });
  await check('close, new selection, blank click and page scroll clear transient UI without requests', async () => {
    await gotoContext(); fixtures.reset(); await selectToolbar(source, '#term-a'); await source.keyboard.press('Escape'); await toolbar(source).waitFor({ state: 'detached' });
    await selectToolbar(source, '#term-a'); await selectToolbar(source, '#term-b'); assert.equal((await selected(source)).trim(), 'microtasks');
    await source.locator('#ctx-empty').click(); await until(async () => await toolbar(source).count() === 0 && await host(source).count() === 0, 'blank click did not dismiss UI');
    await selectToolbar(source, '#term-a'); await source.evaluate(() => getSelection()?.removeAllRanges()); await until(async () => await toolbar(source).count() === 0, 'disappeared selection left toolbar visible');
    await selectToolbar(source, '#term-a'); await source.mouse.wheel(0, 250); await until(async () => await toolbar(source).count() === 0, 'page scroll left toolbar visible'); assert.equal(count(), 0);
  });
  await check('input, password, editable and form selections never show a toolbar', async () => {
    fixtures.reset();
    for (const selector of ['#ctx-input', '#ctx-password', '#term-editor', '#term-form']) {
      await gotoContext(); await realSelect(source, selector, { allowEmpty: true }); await sleep(180);
      assert.equal(await toolbar(source).count(), 0, selector); assert.equal(await host(source).count(), 0, selector); assert.equal(count(), 0, selector);
    }
  });
  await check('selecting and copying part of the answer keeps it open without another request', async () => {
    await gotoContext(); fixtures.reset(); await selectAndInvoke(source, '#term-a'); await completed(source);
    await source.addStyleTag({ content: 'html, body { user-select: none; }' });
    const box = await core(source).boundingBox();
    await source.mouse.dblclick(box.x + 80, box.y + 12);
    const excerpt = await selected(source);
    assert.ok(excerpt.trim() && (await core(source).innerText()).includes(excerpt) && excerpt !== await core(source).innerText());
    await source.keyboard.press('ControlOrMeta+c');
    assert.equal(await source.evaluate(() => navigator.clipboard.readText()), excerpt);
    await source.evaluate(() => navigator.clipboard.writeText(''));
    await action(source, 'copy').click();
    await until(async () => await source.evaluate(() => navigator.clipboard.readText()) === excerpt, 'copy did not use the selected excerpt');
    assert.equal(await toolbar(source).count(), 0); assert.equal(count(), 1);
    await core(source).click();
    assert.equal(await panel(source).isVisible(), true);
    await source.keyboard.press('Escape'); await host(source).waitFor({ state: 'detached' });
  });
  await check('pinned answer survives outside clicks and reopens at the saved position and size until unpinned', async () => {
    await gotoContext(); fixtures.reset(); await selectAndInvoke(source, '#term-b', 'translate'); await completed(source);
    const bounds = () => panel(source).boundingBox();
    const drag = async (x, y, dx, dy) => {
      await source.mouse.move(x, y); await source.mouse.down();
      await source.mouse.move(x + dx, y + dy, { steps: 8 }); await source.mouse.up();
    };
    const initial = await bounds();
    await drag(initial.x + 80, initial.y + 20, 120, -90);
    const moved = await bounds();
    assert.deepEqual(moved, { ...initial, x: initial.x + 120, y: initial.y - 90 });
    assert.equal(await action(source, 'pin').getAttribute('aria-pressed'), 'false');
    await drag(moved.x + moved.width - 8, moved.y + moved.height - 8, 65, 40);
    const resized = await bounds();
    assert.deepEqual(resized, { ...moved, width: moved.width + 65, height: moved.height + 40 });
    const footer = await panel(source).locator('.foot').boundingBox();
    assert.ok(Math.abs(resized.y + resized.height - footer.y - footer.height) <= 1, 'button bar must stay at the bottom of the resized panel');
    await action(source, 'pin').click();
    try {
      assert.equal(await action(source, 'pin').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await bounds(), resized);
      await drag(resized.x + 80, resized.y + 20, 25, 15);
      const pinnedMoved = await bounds();
      assert.deepEqual(pinnedMoved, { ...resized, x: resized.x + 25, y: resized.y + 15 });
      await drag(pinnedMoved.x + 2, pinnedMoved.y + 65, -30, 0);
      const pinnedAt = await bounds();
      assert.deepEqual(pinnedAt, { ...pinnedMoved, x: pinnedMoved.x - 30, width: pinnedMoved.width + 30 });
      await source.mouse.click(1240, 50);
      await selectToolbar(source, '#term-a');
      assert.deepEqual(await bounds(), pinnedAt);
      await clickToolbar(source, 'translate'); await completed(source);
      assert.deepEqual(await bounds(), pinnedAt);
      await source.keyboard.press('Escape'); await host(source).waitFor({ state: 'detached' });
      await gotoContext(); await selectAndInvoke(source, '#term-a', 'translate'); await completed(source);
      assert.equal(await action(source, 'pin').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await bounds(), pinnedAt);
      await source.mouse.click(1240, 50);
      await expand(source);
      assert.deepEqual(await bounds(), pinnedAt);
      await closeAnswer(source);
      await selectAndInvoke(source, '#term-a', 'translate'); await completed(source);
      await action(source, 'pin').click();
      assert.equal(await action(source, 'pin').getAttribute('aria-pressed'), 'false');
      await source.mouse.click(1240, 50); await host(source).waitFor({ state: 'detached' });
      await until(() => options.evaluate(async () => !(await chrome.storage.local.get('contextPanelPin')).contextPanelPin), 'unpin was not persisted');
    } finally {
      await options.evaluate(() => chrome.storage.local.remove('contextPanelPin'));
    }
  });
  await check('dragging a link never triggers a selection toolbar or model request', async () => {
    await gotoContext(); fixtures.reset(); const link = source.locator('#ctx-drag-link'); await link.scrollIntoViewIfNeeded(); const box = await link.boundingBox();
    await source.mouse.move(box.x + 15, box.y + box.height / 2); await source.mouse.down(); await source.mouse.move(box.x + 110, box.y + box.height / 2 + 22, { steps: 14 }); await source.mouse.up();
    await sleep(300); assert.equal(await toolbar(source).count(), 0); assert.equal(count(), 0);
  });
  await check('follow-up imports a reading turn and sends a new page quote with the next question only', async () => {
    const shell = await context.newPage();
    try {
      await shell.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      const composer = shell.locator('#chat-input');
      await until(() => composer.isEnabled(), 'side panel chat did not connect');
      await gotoContext(); fixtures.reset();
      await selectAndInvoke(source, '#term-a', 'translate'); await completed(source);
      await until(async () => await shell.locator('#chat-page-quote-text').innerText() === 'coherence', 'initial page quote missing');
      await action(source, 'follow-up').click();
      const conversation = shell.locator('#chat-messages .chat-message');
      await until(async () => await conversation.count() === 2, 'follow-up did not import the reading turn');
      assert.match(await conversation.nth(0).innerText(), /coherence/);
      assert.match(await conversation.nth(1).innerText(), /CONTEXT_A_OUTPUT/);
      assert.equal(count(), 1, 'opening a follow-up must not call the model');
      await shell.locator('#chat-page-quote').waitFor({ state: 'hidden' });

      await selectToolbar(source, '#term-b');
      await until(async () => await shell.locator('#chat-page-quote-text').innerText() === 'microtasks', 'new page quote missing');
      assert.equal(count(), 1, 'selecting a quote must not call the model');
      await composer.fill('这两段有什么关系？');
      await shell.locator('#chat-send').click();
      await until(() => count() === 2 && latest().completed, 'follow-up question did not reach the fixture');
      const turns = latest().body.messages.slice(1);
      assert.deepEqual(turns.map(turn => turn.role), ['user', 'assistant', 'user']);
      assert.match(turns[0].content, /coherence/);
      assert.match(turns[1].content, /CONTEXT_A_OUTPUT/);
      assert.equal(turns[2].content, '网页选区引用（仅供参考）：\nmicrotasks\n\n我的问题：\n这两段有什么关系？');
      await shell.locator('#chat-page-quote').waitFor({ state: 'hidden' });

      await selectToolbar(source, '#term-b');
      await shell.locator('#chat-page-quote').waitFor({ state: 'visible' });
      await composer.fill('保留这条问题草稿');
      await options.bringToFront();
      await shell.locator('#chat-page-quote').waitFor({ state: 'hidden' });
      assert.equal(await composer.inputValue(), '保留这条问题草稿');

      await realSelect(source, '#term-a');
      await until(async () => await shell.locator('#chat-page-quote-text').innerText() === 'coherence', 'quote missing before same-document navigation');
      await source.evaluate(() => history.pushState({}, '', '?changed=1'));
      await shell.locator('#chat-page-quote').waitFor({ state: 'hidden' });
      await realSelect(source, '#term-a');
      await until(async () => await shell.locator('#chat-page-quote-text').innerText() === 'coherence', 'quote missing after same-document navigation');
      await gotoContext(true);
      await shell.locator('#chat-page-quote').waitFor({ state: 'hidden' });
      assert.equal(await composer.inputValue(), '保留这条问题草稿');

      await source.evaluate(() => {
        const paragraph = document.createElement('p');
        const word = document.createElement('span');
        word.id = 'short-quote-in-long-paragraph'; word.textContent = 'excerpt';
        paragraph.append(word, ' long'.repeat(2200));
        document.querySelector('article').prepend(paragraph);
      });
      await realSelect(source, '#short-quote-in-long-paragraph');
      await until(async () => await shell.locator('#chat-page-quote-text').innerText() === 'excerpt', 'short quote from an oversized paragraph missing');
      assert.equal(await toolbar(source).count(), 0);
      assert.equal(count(), 2, 'changing the quote must not send a new request');
    } finally {
      await shell.close();
    }
  });
  await check('sidebar quick actions send the quote or pasted text and preserve unrelated drafts', async () => {
    const shell = await context.newPage();
    try {
      await shell.setViewportSize({ width: 300, height: 700 });
      await shell.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      const composer = shell.locator('#chat-input');
      const quote = shell.locator('#chat-page-quote-text');
      const translate = shell.locator('#chat-translate');
      const explain = shell.locator('#chat-explain');
      const stop = shell.locator('#chat-stop');
      await until(() => composer.isEnabled(), 'side panel chat did not connect');
      assert.equal(await translate.isDisabled(), true);
      assert.equal(await explain.isDisabled(), true);
      await gotoContext(); fixtures.reset();
      await selectToolbar(source, '#term-a');
      await until(async () => await quote.innerText() === 'coherence', 'translation quote missing');
      assert.equal(count(), 0, 'selecting text must not call the model');
      assert.equal(await shell.locator('#chat-send').isDisabled(), true);
      await translate.click();
      await stop.waitFor({ state: 'visible' });
      assert.equal(await explain.isDisabled(), true);
      await until(() => count() === 1 && latest().completed, 'translation did not complete');
      await stop.waitFor({ state: 'hidden' });
      await quote.waitFor({ state: 'hidden' });
      assert.match(latest().body.messages.at(-1).content, /^网页选区引用（仅供参考）：\ncoherence\n\n我的问题：\n请翻译/u);

      await selectToolbar(source, '#term-b');
      await until(async () => await quote.innerText() === 'microtasks', 'explanation quote missing');
      await composer.fill('保留这条草稿');
      await explain.click();
      await until(() => count() === 2 && latest().completed, 'explanation did not complete');
      await stop.waitFor({ state: 'hidden' });
      await quote.waitFor({ state: 'hidden' });
      const sent = latest().body.messages.at(-1).content;
      assert.match(sent, /^网页选区引用（仅供参考）：\nmicrotasks\n\n我的问题：\n请用通俗的中文解释/u);
      assert.doesNotMatch(sent, /保留这条草稿/u);
      assert.equal(await composer.inputValue(), '保留这条草稿');

      await composer.fill('The event loop.');
      await translate.click();
      await until(() => count() === 3 && latest().completed, 'pasted text translation did not complete');
      assert.match(latest().body.messages.at(-1).content, /^请翻译[\s\S]*\n待处理文本：\nThe event loop\.$/u);
      assert.equal(await composer.inputValue(), '');
    } finally {
      await shell.close();
    }
  });
  await check('sidebar model recommendations follow the active passage and send one term with the full quote on click', async () => {
    const shell = await context.newPage();
    const secondShell = await context.newPage();
    try {
      await shell.setViewportSize({ width: 320, height: 700 });
      await shell.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await secondShell.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      const composer = shell.locator('#chat-input');
      const chips = shell.locator('#chat-quote-terms button');
      const quote = shell.locator('#chat-page-quote-text');
      const conversation = shell.locator('#chat-messages .chat-message');
      await until(() => composer.isEnabled(), 'side panel chat did not connect');
      await until(() => secondShell.locator('#chat-input').isEnabled(), 'second side panel chat did not connect');
      const messageCount = await conversation.count();
      await composer.fill('这条草稿不能发给推荐模型');
      await gotoContext(); fixtures.reset();
      const first = (await realSelect(source, '#ctx-a', { paragraph: true })).trim();
      await until(async () => (await quote.innerText()) === first, 'first recommendation quote missing');
      await until(() => count() >= 1, 'first recommendation request missing');
      const old = latest();
      assert.deepEqual(old.body.messages.map(message => message.role), ['system', 'user']);
      assert.deepEqual(JSON.parse(old.body.messages[1].content), { quote: first });
      assert.equal(await shell.locator('#chat-translate').isEnabled(), true);

      const second = (await realSelect(source, '#ctx-b', { paragraph: true })).trim();
      await until(() => old.aborted, 'old recommendation request was not cancelled');
      await until(async () => (await chips.count()) === 3, 'recommendations for the new quote missing');
      await until(async () => (await secondShell.locator('#chat-quote-terms button').count()) === 3, 'second panel did not receive the shared result');
      assert.equal(count(), 2);
      assert.deepEqual(JSON.parse(latest().body.messages[1].content), { quote: second });
      assert.deepEqual(await chips.allTextContents(), ['microtasks', 'event loop', 'rendering']);
      assert.equal(await conversation.count(), messageCount, 'recommendations must stay out of the conversation');
      assert.equal(await shell.evaluate(() => document.querySelector('.composer-tools').scrollWidth <= document.querySelector('.composer-tools').clientWidth), true);

      await shell.getByRole('button', { name: 'event loop', exact: true }).click();
      await until(() => count() === 3 && latest().completed, 'term follow-up did not complete');
      const sent = latest().body.messages.at(-1).content;
      assert.ok(sent.startsWith(`网页选区引用（仅供参考）：\n${second}\n\n我的问题：\n`));
      assert.match(sent, /给出「event loop」在这里的译法/);
      assert.doesNotMatch(sent, /这条草稿不能发给推荐模型/);
      assert.equal(await composer.inputValue(), '这条草稿不能发给推荐模型');
      await quote.waitFor({ state: 'hidden' });
      const recommendations = shell.locator('#chat-quote-terms');
      await recommendations.waitFor({ state: 'hidden' });

      const excerpt = 'You will join an AI Application team that is at the forefront of integrating LLMs and intelligent agents into real-world scenarios such as: Smart content generation for creators';
      await source.locator('#ctx-a').evaluate((paragraph, text) => { paragraph.textContent = text; }, excerpt);
      await realSelect(source, '#ctx-a', { paragraph: true });
      const retry = recommendations.getByRole('button', { name: '重试' });
      await retry.waitFor({ state: 'visible' });
      assert.match(await recommendations.innerText(), /模型未返回可用的词语列表/);
      assert.equal(await quote.innerText(), excerpt);
      assert.equal(count(), 4);
      assert.ok(latest().body.max_tokens > 256, 'recommendation budget must allow reasoning before the list');
      await retry.click();
      await until(async () => (await chips.count()) === 3, 'retry did not recover the recommendation');
      assert.deepEqual(await chips.allTextContents(), ['forefront', 'LLMs', 'intelligent agents']);
      assert.equal(count(), 5, 'retry must issue exactly one new request');
    } finally {
      await shell.close();
      await secondShell.close();
    }
  });
  await check('consecutive A/B selections cancel delayed A and isolate B output', async () => {
    await gotoContext(); await settings('slow'); fixtures.reset(); await selectAndInvoke(source, '#term-a'); await until(() => count() === 1, 'slow A request missing'); const old = latest();
    await selectAndInvoke(source, '#term-b'); assert.match(await completed(source), /CONTEXT_B_OUTPUT/); assert.doesNotMatch(await answer(source).innerText(), /CONTEXT_A_OUTPUT/); assert.equal(count(), 2); await until(() => old.aborted, 'A was not cancelled');
    assert.equal(await host(source).count(), 1);
  });
  await check('stop retains partial output and aborts without later appends', async () => {
    await gotoContext(); fixtures.reset(); await selectAndInvoke(source, '#term-a'); await until(async () => (await answer(source).innerText()).includes('CONTEXT_A_OUTPUT'), 'slow stream did not start');
    const request = latest(); await action(source, 'stop').click(); const stopped = await answer(source).innerText(); await sleep(650);
    assert.equal(await status(source).getAttribute('data-phase'), 'cancelled'); assert.equal(await answer(source).innerText(), stopped); assert.equal(count(), 1); await until(() => request.aborted, 'stopped connection did not abort');
  });
  await check('explicit retry after stop creates one replacement ID and request', async () => {
    const oldId = await panel(source).getAttribute('data-request-id'); await action(source, 'retry').click(); await until(async () => await panel(source).getAttribute('data-request-id') !== oldId, 'retry did not replace ID');
    assert.match(await completed(source), /CONTEXT_A_OUTPUT/); assert.equal(count(), 2);
  });
  await check('API error never automatically retries; explicit retry works after config change', async () => {
    await gotoContext(); await settings('401'); fixtures.reset(); await selectAndInvoke(source, '#term-a'); await until(async () => await status(source).getAttribute('data-phase') === 'error', '401 error missing');
    assert.match(await status(source).innerText(), /401|Key/); assert.equal(count(), 1); await sleep(250); assert.equal(count(), 1);
    await settings('normal'); const oldId = await panel(source).getAttribute('data-request-id'); await action(source, 'retry').click(); await until(async () => await panel(source).getAttribute('data-request-id') !== oldId, 'error retry missing'); await completed(source); assert.equal(count(), 2);
  });
  await check('narrow toolbar and result remain inside a 390px viewport', async () => {
    try {
      await gotoContext(true); await source.setViewportSize({ width: 390, height: 844 }); fixtures.reset();
      // The fixture contains deliberately long form fields and sentinel words.
      // Verify our UI adds no overflow instead of requiring the host page to fit.
      const baselineScrollWidth = await source.evaluate(() => document.documentElement.scrollWidth);
      await selectToolbar(source, '#term-foreign');
      const toolbarBounds = await inViewport(toolbar(source).locator('.toolbar')); await toolbar(source).locator('.toolbar').screenshot({ path: path.join(screenshots, 'toolbar-mobile.png') });
      await clickToolbar(source, 'translate'); await completed(source); await expand(source); const panelBounds = await inViewport(panel(source));
      for (const name of ['close', 'copy', 'retry']) assert.equal(await action(source, name).isVisible(), true);
      const finalScrollWidth = await source.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(finalScrollWidth <= Math.max(baselineScrollWidth, 390) + 1, 'reading UI added horizontal overflow');
      await source.screenshot({ path: path.join(screenshots, 'translate-examples-mobile.png') }); return { toolbarBounds, panelBounds, baselineScrollWidth, finalScrollWidth };
    } finally { await source.setViewportSize({ width: 1280, height: 900 }); }
  });
  await check('M1 drag-hover smoke opens before release, blurs on hover and uses no model', async () => {
    await source.goto(fixtures.origin + '/context-index'); await sleep(180); fixtures.reset(); const windows = (await options.evaluate(() => chrome.windows.getAll())).length;
    await dragPreview('context-tech', '/context-tech'); assert.equal(count(), 0); assert.equal((await options.evaluate(() => chrome.windows.getAll())).length, windows);
    await source.locator('local-reader-preview iframe').hover(); await until(async () => await source.locator('local-reader-preview .scrim').evaluate(node => node.classList.contains('active')), 'M1 blur missing');
    await source.mouse.move(3, 3); await until(async () => !(await source.locator('local-reader-preview .scrim').evaluate(node => node.classList.contains('active'))), 'M1 blur did not clear');
    return { visibleBeforeMouseup: true, extraWindows: 0, modelRequests: 0 };
  });
  await check('actual preview iframe toolbar explains its own technical document', async () => {
    await source.goto(fixtures.origin + '/context-index'); await sleep(180); fixtures.reset(); const frame = await dragPreview('context-tech', '/context-tech'); await selectAndInvoke(frame, '#term-a');
    assert.match(await completed(frame), /CONTEXT_A_OUTPUT/); assert.equal(count(), 1); assert.equal(await host(source).count(), 0); assert.equal(input().url, fixtures.origin + '/context-tech'); assert.match(input().paragraphContext, /CONTEXT_A_NEAR_SENTINEL/);
    await source.screenshot({ path: path.join(screenshots, 'explain-preview-frame.png') });
  });
  await check('actual preview iframe toolbar translates and expands bilingual examples', async () => {
    fixtures.reset(); const frame = await dragPreview('context-foreign', '/context-foreign'); await selectAndInvoke(frame, '#term-foreign', 'translate'); await completed(frame);
    assert.equal(input().url, fixtures.origin + '/context-foreign'); assert.match(input().title, /Foreign reading/); assert.match(input().paragraphContext, /FOREIGN_CONTEXT_SENTINEL/); assert.equal(count(), 1);
    await expand(frame); assert.equal(count(), 2); assert.match(await details(frame).innerText(), /The wetland showed resilience/); await source.screenshot({ path: path.join(screenshots, 'translate-preview-frame.png') });
  });
  await check('closing parent preview releases old-frame Port and aborts its request', async () => {
    await settings('slow'); fixtures.reset(); const frame = await dragPreview('context-tech', '/context-tech'); await selectAndInvoke(frame, '#term-a'); await until(() => count() === 1, 'iframe request missing'); const old = latest();
    await source.locator('local-reader-preview [data-reader-action="close"]').click(); await until(() => old.aborted, 'frame detach did not abort'); assert.equal(count(), 1); assert.equal(await source.locator('local-reader-preview').count(), 0);
  });
  await check('navigation cancels old document without contaminating a new answer', async () => {
    await gotoContext(); fixtures.reset(); await selectAndInvoke(source, '#term-a'); await until(() => count() === 1, 'old-document request missing'); const old = latest();
    await gotoContext(true); await until(() => old.aborted, 'navigation did not abort'); assert.equal(await host(source).count(), 0); await settings('normal'); await selectAndInvoke(source, '#term-foreign', 'translate');
    assert.match(await completed(source), /CONTEXT_TRANSLATION_OUTPUT/); assert.doesNotMatch(await answer(source).innerText(), /CONTEXT_A_OUTPUT/); assert.equal(count(), 2);
  });
  await check('missing Key makes zero paid requests after a real toolbar click', async () => {
    await options.locator('#clear-key').click(); await until(async () => !(await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }))).hasKey, 'Key clear incomplete'); await gotoContext(); fixtures.reset(); await selectAndInvoke(source, '#term-a');
    await until(async () => await status(source).getAttribute('data-phase') === 'error', 'missing-Key error absent'); assert.match(await status(source).innerText(), /设置|Key|模型/); assert.equal(count(), 0); await settings('normal', fakeKey);
  });
  await check('configuration barrier cancels running request until an explicit retry', async () => {
    await gotoContext(); await settings('slow'); fixtures.reset(); await selectAndInvoke(source, '#term-a'); await until(() => count() === 1, 'request before config missing'); const old = latest();
    await settings('normal'); await until(() => old.aborted, 'config did not abort'); await until(async () => await status(source).getAttribute('data-phase') === 'cancelled', 'cancelled config state missing'); await sleep(180); assert.equal(count(), 1);
    const oldId = await panel(source).getAttribute('data-request-id'); await action(source, 'retry').click(); await until(async () => await panel(source).getAttribute('data-request-id') !== oldId, 'config retry missing'); await completed(source); assert.equal(count(), 2);
  });
  await check('clearing Key aborts a running request and never resubmits it', async () => {
    await gotoContext(); await settings('slow'); fixtures.reset(); await selectAndInvoke(source, '#term-a'); await until(() => count() === 1, 'request before Key clear missing'); const old = latest();
    await options.locator('#clear-key').click(); await until(() => old.aborted, 'Key clear did not abort'); await until(async () => await status(source).getAttribute('data-phase') === 'cancelled', 'Key cancelled state absent'); await sleep(200); assert.equal(count(), 1); await settings('normal', fakeKey);
  });
  await check('permission revocation aborts running selection and prevents a new paid call', async () => {
    await gotoContext(); await settings('slow'); fixtures.reset(); await selectAndInvoke(source, '#term-a'); await until(() => count() === 1, 'request before revoke missing'); const old = latest();
    const manager = await context.newPage(); await manager.goto('chrome://extensions');
    await manager.evaluate(extensionId => chrome.developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: 'ON_CLICK' }), extensionId);
    await manager.close(); await until(() => old.aborted, 'permission revoke did not abort'); await until(async () => await host(source).count() === 0, 'revoked UI remained');
    await realSelect(source, '#term-b'); await sleep(250); if (await toolbar(source).count()) await tool(source, 'translate').click(); await sleep(250); assert.equal(count(), 1);
    return 'Selection completion after revocation cannot start another model request.';
  });
  await check('production toolbar path leaves storage/network and build boundaries intact', async () => {
    const persisted = await options.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.sync.get(null)])); assert.ok(!JSON.stringify(persisted).includes(fakeKey)); assert.ok(!JSON.stringify(persisted).includes('CONTEXT_A_NEAR_SENTINEL')); assert.deepEqual(persisted[1], {});
    assert.ok(report.network.every(request => ['127.0.0.1', 'localhost', 'reading-fixture.test'].includes(new URL(request.url).hostname))); assert.equal(await worker.evaluate(() => typeof globalThis.__contextE2EDispatch), 'undefined');
    assert.deepEqual(await hashDirectory(testExtension), testedFiles); assert.deepEqual(await hashDirectory(path.join(root, 'dist')), testedFiles);
    return { toolbarWorkerTestEntry: false, realModelVerified: false };
  });

  // Instrument only this final native-menu supplement. All toolbar checks above
  // have already run in a reloaded production worker without this helper.
  // Permission revocation above is intentional. Start this supplemental native
  // menu check in a fresh profile instead of waiting on an invisible permission
  // increase dialog while reloading the already-revoked extension headlessly.
  await context.close();
  const nativeHarness = ';(()=>{const handlers=[];globalThis.__contextE2EHandlers=handlers;const add=chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked);chrome.contextMenus.onClicked.addListener=(listener)=>{handlers.push(listener);add(listener)};globalThis.__contextE2EDispatch=(info,tab)=>{for(const listener of handlers)listener(info,tab);return handlers.length}})();\n';
  await fs.writeFile(backgroundPath, nativeHarness + productionBackground);
  nativeProfile = await fs.mkdtemp(path.join(output, 'context-native-0.9.1-profile-')); assertTestDirectory(nativeProfile);
  context = await chromium.launchPersistentContext(nativeProfile, { channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`, '--no-first-run'] });
  context.setDefaultTimeout(8000);
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 12000 }); extensionId = new URL(worker.url()).hostname;
  await until(() => worker.evaluate(() => globalThis.__contextE2EHandlers?.length > 0), 'native supplement worker unavailable');
  await fs.writeFile(backgroundPath, productionBackground);
  assert.deepEqual(await hashDirectory(testExtension), testedFiles); report.testHarness.testCopyRestored = true; report.testHarness.nativeMenuCallbackInstrumented = true;
  options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`); await until(() => options.locator('#save-settings').isEnabled(), 'native supplement settings unavailable'); await settings('normal', fakeKey); source = await context.newPage();
  await check('native-menu supplement uses a trusted contextmenu snapshot', async () => {
    await gotoContext(); fixtures.reset(); await nativeInvoke(source, '#term-a', 'explain'); assert.match(await completed(source), /CONTEXT_A_OUTPUT/); assert.equal(count(), 1);
    assert.equal(input().selection.trim(), 'coherence'); report.testHarness.trustedNativeContextMenuEvent = true; return { nativeMenuSelectionVerified: false, listenerInvokedByHarness: true };
  }, 'instrumented-native-menu-supplement');
  await check('native-menu snapshot survives selection collapse before the explicit menu callback', async () => {
    await gotoContext(); fixtures.reset(); await nativeInvoke(source, '#term-a', 'explain', { clearAfterMenu: true }); assert.match(await completed(source), /CONTEXT_A_OUTPUT/); assert.equal(count(), 1);
    assert.equal(await selected(source), ''); assert.equal(input().selection.trim(), 'coherence');
    return { nativeMenuSelectionVerified: false, trustedContextMenuZeroRequests: true, callbackRequests: 1, selectionCollapsedAfterCapture: true };
  }, 'instrumented-native-menu-supplement');
  await check('native-menu supplement rejects empty selection without reusing previous text', async () => {
    await gotoContext(); fixtures.reset(); await source.locator('#ctx-empty').scrollIntoViewIfNeeded(); await source.evaluate(() => getSelection()?.removeAllRanges());
    await nativeInvoke(source, undefined, 'explain', { textOverride: '' }); await until(async () => await status(source).getAttribute('data-phase') === 'error', 'empty native error missing'); assert.equal(count(), 0);
  }, 'instrumented-native-menu-supplement');
  await check('native harness restores exact temporary and production bytes', async () => {
    assert.deepEqual(await hashDirectory(testExtension), testedFiles); assert.deepEqual(await hashDirectory(path.join(root, 'dist')), testedFiles);
    return { nativeMenuSelectionVerified: false, temporaryCopyRestoredByteIdentical: true };
  }, 'instrumented-native-menu-supplement');
} catch (error) { fatal = error; report.fatal = error.message; process.stdout.write(`FATAL ${error.message}\n`); }
finally {
  if (context) await context.close().catch(() => {}); await fixtures.close();
  const after = await hashDirectory(path.join(root, 'dist')); report.testedBuild.unchangedAfterTest = JSON.stringify(after) === JSON.stringify(testedFiles);
  if (!report.testedBuild.unchangedAfterTest) { report.fatal = 'Production dist changed during context test'; fatal ??= new Error(report.fatal); }
  report.passed = report.checks.filter(item => item.result === 'pass').length; report.failed = report.checks.filter(item => item.result === 'fail').length;
  const passed = fragment => report.checks.some(item => item.result === 'pass' && item.name.includes(fragment));
  report.coverage = {
    automaticToolbarZeroRequests: passed('trusted selection shows compact toolbar'),
    oneClickTranslation: passed('translate click makes exactly one request'),
    mainAndPreviewFrames: ['translate click makes exactly one request', 'technical explanation retains nearby', 'actual preview iframe toolbar explains', 'actual preview iframe toolbar translates'].every(passed),
    bilingualPairs: passed('short-English expansion has 1–2 actual English/Chinese pairs') && passed('actual preview iframe toolbar translates'),
    usageExamples: passed('technical explanation retains nearby'),
    longTranslationNoExamples: passed('long paragraph translation sends the complete selection'),
    selectionLifecycle: ['keyboard selection completion', 'close, new selection, blank click', 'input, password, editable and form', 'selecting and copying part of the answer', 'pinned answer survives outside clicks', 'dragging a link never triggers', 'consecutive A/B selections'].every(passed),
    m1DragSmoke: passed('M1 drag-hover smoke')
  };
  await fs.writeFile(path.join(output, 'context-e2e-report-' + version + '.json'), JSON.stringify(report, null, 2) + '\n');
  for (const temporaryProfile of [nativeProfile, profile].filter(Boolean)) { assertTestDirectory(temporaryProfile); await fs.rm(temporaryProfile, { recursive: true, force: true }); }
  process.stdout.write(`Mock context ${version} e2e: ${report.passed} passed, ${report.failed} failed. Native menu item selection remains manual.\n`);
  if (fatal || report.failed) process.exitCode = 1;
}

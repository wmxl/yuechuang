import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from './fixtures/server.mjs';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

// Production UI and worker, deterministic loopback model, isolated browser profile.
// No source hooks, synthetic toolbar clicks, live API keys or real model calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const screenshots = path.join(output, `phrases-${version}`);
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
const productionDirectory = path.join(root, 'dist');
const testedFiles = await hashDirectory(productionDirectory);
const productionManifest = await fs.readFile(path.join(productionDirectory, 'manifest.json'), 'utf8');
const manifest = JSON.parse(productionManifest);
assert.equal(manifest.version, version, 'Build the current extension before running phrases e2e');
const report = {
  mockOnly: true, realModelVerified: false, extensionVersion: manifest.version,
  date: new Date().toISOString(), checks: [], network: [],
  testedBuild: { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false },
  testHarness: {
    productionWorkerWithoutTestEntry: true, trustedMouseSelectionAndButtonClicks: true,
    productionSourceModified: false, testCopyRestored: false,
    permissionBootstrap: 'The fresh profile loads a byte-identical copy of the production manifest with website access.',
  },
  notes: [
    'Every phrase is saved through a real toolbar/result-card button after a deterministic local mock SSE response. No test hook is inserted into the production worker.',
    'Management uses the packaged phrases.html page. Downloads are read from actual browser download events.',
    'Content-isolation checks use chrome.scripting in the isolated world to obtain a real content-script sender; no page messaging bridge is added.',
    'Persistence closes the browser and restarts the same profile with unchanged extension bytes. No local phrase storage is cleared before restart.',
    'Native browser permission prompts and native context-menu item selection remain manual. No live model answer quality is claimed.'
  ]
};
const fixtures = await startFixtures({ port: Number(process.env.PHRASES_FIXTURE_PORT || 4337) });
report.fixtureOrigin = fixtures.origin;
const profile = await fs.mkdtemp(path.join(output, `phrases-${version}-profile-`));
assertTestDirectory(profile);
const testExtension = path.join(profile, 'test-extension');
assertTestDirectory(testExtension);
const fakeKey = 'phrases-local-mock-key-do-not-use-with-real-service';
let context, options, source, library, worker, extensionId, fatal;
let translatedId, translatedCreatedAt, translatedUpdatedAt, explainedId;
const count = () => fixtures.getStats().count;
const total = () => fixtures.getStats().totalRequestsSinceStart;
const host = frame => frame.locator('local-reader-context');
const toolbar = frame => frame.locator('local-reader-selection-toolbar');
const status = frame => host(frame).locator('.status[data-phase]');
const panel = frame => host(frame).locator('.panel');
const core = frame => host(frame).locator('[data-context-core]');
const details = frame => host(frame).locator('[data-context-details]');
const action = (frame, name) => host(frame).locator(`[data-context-action="${name}"]`);
const cards = () => library.locator('#entries .phrase-card');
const entries = async () => {
  const response = await library.evaluate(() => chrome.runtime.sendMessage({ type: 'phrases:list' }));
  assert.equal(response.ok, true, response.error); assert.ok(Array.isArray(response.entries)); return response.entries;
};
async function check(name, operation) {
  const started = Date.now(), before = total();
  try {
    const evidence = await operation(), after = total();
    report.checks.push({ name, result: 'pass', milliseconds: Date.now() - started, requestsBefore: before, requestsAfter: after, newRequests: after - before, ...(evidence ? { evidence } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.checks.push({ name, result: 'fail', milliseconds: Date.now() - started, requestsBefore: before, requestsAfter: total(), newRequests: total() - before, error: error.message });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    await (library && !library.isClosed() ? library : source)?.screenshot({ path: path.join(screenshots, `failure-${report.checks.length}.png`), fullPage: true }).catch(() => {});
  }
}
async function launch(directory) {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: process.env.HEADED !== '1', acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`, '--no-first-run']
  });
  context.setDefaultTimeout(8000);
  context.on('request', request => { if (request.url().startsWith('http')) report.network.push({ method: request.method(), url: request.url() }); });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  report.browser = context.browser().version();
}
async function openOptions() {
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await until(() => options.locator('#save-settings').isEnabled(), 'settings unavailable');
}
async function openLibrary() {
  library = await context.newPage();
  await library.goto(`chrome-extension://${extensionId}/phrases.html`);
  await until(async () => (await library.locator('#total-count').innerText()) !== '—', 'phrase library not loaded');
}
async function settings(model = 'normal', key) {
  await options.bringToFront(); await until(() => options.locator('#save-settings').isEnabled(), 'settings unavailable');
  await options.locator('#base-url').fill(fixtures.origin + '/v1');
  await options.locator('#model').fill(model);
  await options.locator('#remember-key').setChecked(false);
  await options.locator('#input-budget').fill('16000');
  await options.locator('#auto-long-summary').setChecked(false);
  if (key !== undefined) await options.locator('#api-key').fill(key);
  await options.locator('#save-settings').click();
  await until(async () => await options.locator('#save-settings').isEnabled() && (await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }))).settings.model === model, 'settings save did not complete');
}
async function gotoSource(foreign = false) {
  await source.bringToFront();
  await source.goto(fixtures.origin + (foreign ? '/context-foreign' : '/context-tech'));
  await source.locator(foreign ? '#term-foreign' : '#term-a').waitFor(); await sleep(180);
}
async function invoke(frame, selector, mode = 'translate') {
  await source.bringToFront();
  const term = frame.locator(selector); await term.scrollIntoViewIfNeeded();
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await term.boundingBox(); assert.ok(box, 'selectable target missing');
  const before = count();
  await source.mouse.dblclick(box.x + Math.min(box.width / 2, 70), box.y + Math.min(box.height / 2, 14));
  const selected = await frame.evaluate(() => getSelection()?.toString() || ''); assert.ok(selected.trim());
  await toolbar(frame).waitFor({ state: 'visible' });
  assert.equal(count(), before, 'selection toolbar must not call model');
  const previous = await host(frame).count() ? await panel(frame).getAttribute('data-request-id') : undefined;
  await toolbar(frame).locator(`[data-selection-action="${mode}"]`).click();
  await until(async () => await host(frame).count() === 1 && await panel(frame).getAttribute('data-request-id') !== previous, 'context result did not open');
  return selected.trim();
}
async function completed(frame) {
  await until(async () => ['done', 'error', 'cancelled', 'interrupted'].includes(await status(frame).getAttribute('data-phase')), 'context response did not finish');
  assert.equal(await status(frame).getAttribute('data-phase'), 'done', await status(frame).innerText());
  return core(frame).innerText();
}
async function save(frame) {
  const before = total();
  assert.equal(await action(frame, 'save').isEnabled(), true);
  await action(frame, 'save').click();
  await until(async () => (await action(frame, 'save').innerText()) === '已收藏', 'save did not reach saved state');
  assert.equal(await action(frame, 'save').isDisabled(), true);
  assert.equal(total(), before, 'saving must make zero model requests');
}
async function expand(frame) {
  const oldId = await panel(frame).getAttribute('data-request-id');
  await action(frame, 'expand').click();
  await until(async () => await panel(frame).getAttribute('data-request-id') !== oldId, 'example request missing');
  await completed(frame);
}
async function dragPreview(linkId, expectedPath) {
  await source.bringToFront();
  const link = source.locator('#' + linkId); await link.scrollIntoViewIfNeeded();
  const box = await link.boundingBox(); assert.ok(box);
  await source.mouse.move(box.x + Math.min(30, box.width / 3), box.y + box.height / 2);
  await source.mouse.down(); await source.mouse.move(box.x + 95, box.y + box.height / 2 + 22, { steps: 14 });
  await until(async () => (await source.locator('local-reader-preview iframe').getAttribute('src'))?.includes(expectedPath), 'preview iframe missing');
  await source.mouse.up();
  await until(async () => await source.locator('local-reader-preview .page-status').getAttribute('data-state') === 'ready', 'preview target not ready', 18000);
  const handle = await source.locator('local-reader-preview iframe').elementHandle(); const frame = await handle.contentFrame(); assert.ok(frame); return frame;
}
async function refreshLibrary(expectedCount) {
  await library.bringToFront();
  await until(() => library.locator('#refresh').isEnabled(), 'library refresh busy');
  await library.locator('#refresh').click();
  await until(async () => await library.locator('#refresh').isEnabled() && Number(await library.locator('#total-count').innerText()) === expectedCount, 'library count incorrect');
}
async function download(format) {
  const event = library.waitForEvent('download');
  await library.locator(format === 'json' ? '#export-json' : '#export-markdown').click();
  const downloaded = await event, location = await downloaded.path(); assert.ok(location);
  const content = await fs.readFile(location, 'utf8');
  assert.equal(await downloaded.failure(), null);
  assert.ok(downloaded.suggestedFilename().endsWith(format === 'json' ? '.json' : '.md'));
  assert.ok(!content.includes(fakeKey), 'export contains API Key');
  assert.ok(!content.includes(fixtures.origin + '/v1'), 'export contains model configuration');
  return content;
}
async function deleteFirst({ cancel = false } = {}) {
  const before = await cards().count();
  await cards().first().locator('.delete-button').click();
  await library.locator('#delete-dialog').waitFor({ state: 'visible' });
  await library.locator(cancel ? '#cancel-delete' : '#confirm-delete').click();
  await library.locator('#delete-dialog').waitFor({ state: 'hidden' });
  await until(async () => await cards().count() === before - Number(!cancel), 'delete result incorrect');
}

try {
  // First prove that management is useful without model configuration.
  await fs.cp(productionDirectory, testExtension, { recursive: true });
  assert.deepEqual(await hashDirectory(testExtension), testedFiles); report.testHarness.testCopyRestored = true;
  await launch(testExtension); await openOptions(); await openLibrary();
  await check('empty collection opens with no model Key and zero API requests', async () => {
    const configuration = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }));
    assert.equal(configuration.hasKey, false);
    assert.equal((await entries()).length, 0); assert.equal(await cards().count(), 0);
    assert.equal(await library.locator('#empty-state').isVisible(), true);
    assert.match(await library.locator('#empty-title').innerText(), /还没有/);
    assert.equal(await library.locator('#export-json').isDisabled(), true);
    assert.equal(await library.locator('#export-markdown').isDisabled(), true);
    assert.equal(total(), 0);
    await library.screenshot({ path: path.join(screenshots, 'empty-desktop.png'), fullPage: true });
  });
  await openOptions(); assert.equal(await options.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*', 'http://localhost/*'] })), true);
  await settings('normal', fakeKey); await openLibrary(); source = await context.newPage(); await gotoSource(true); report.extensionId = extensionId;

  await check('real translation enables save only after completion and stores original context locally without another API call', async () => {
    fixtures.reset(); assert.equal(await invoke(source, '#term-foreign'), 'resilience');
    await until(async () => await status(source).getAttribute('data-phase') === 'running', 'stream did not start');
    assert.equal(await action(source, 'save').isDisabled(), true, 'incomplete output must not be saveable');
    const coreText = await completed(source); assert.match(coreText, /CONTEXT_TRANSLATION_OUTPUT/); assert.equal(count(), 1);
    await action(source, 'save').evaluate(node => node.click()); await sleep(100);
    assert.equal((await entries()).length, 0, 'untrusted page click must not save a phrase');
    await save(source); const saved = await entries(); assert.equal(saved.length, 1);
    const entry = saved[0]; translatedId = entry.id; translatedCreatedAt = entry.createdAt; translatedUpdatedAt = entry.updatedAt;
    assert.equal(entry.text, 'resilience'); assert.equal(entry.mode, 'translate'); assert.equal(entry.coreText, coreText);
    assert.match(entry.context, /FOREIGN_CONTEXT_SENTINEL/); assert.match(entry.sourceTitle, /Foreign reading/);
    assert.equal(entry.sourceUrl, fixtures.origin + '/context-foreign'); assert.equal(entry.detailsText, '');
    assert.equal(typeof entry.createdAt, 'number'); assert.ok(entry.updatedAt >= entry.createdAt);
    const stored = await options.evaluate(() => chrome.storage.local.get('savedPhrases'));
    assert.deepEqual(stored.savedPhrases, saved); assert.equal(count(), 1);
    await source.screenshot({ path: path.join(screenshots, 'translation-saved.png') });
    return { phraseId: translatedId, modelRequests: 1, saveModelRequests: 0 };
  });
  await check('same source, selected text and mode updates the existing phrase instead of duplicating it', async () => {
    await gotoSource(true); await invoke(source, '#term-foreign'); await completed(source);
    const before = total(); await save(source); const saved = await entries(); assert.equal(saved.length, 1);
    assert.equal(saved[0].id, translatedId); assert.equal(saved[0].createdAt, translatedCreatedAt);
    assert.ok(saved[0].updatedAt >= translatedUpdatedAt); translatedUpdatedAt = saved[0].updatedAt;
    assert.equal(total(), before);
  });
  await check('adding bilingual examples updates the same saved phrase and preserves its core answer', async () => {
    const original = (await entries())[0], beforeExpand = total();
    await expand(source); assert.equal(total(), beforeExpand + 1);
    assert.match(await details(source).innerText(), /The wetland showed resilience/);
    assert.match(await details(source).innerText(), /这片湿地/);
    assert.equal(await action(source, 'save').isEnabled(), true);
    const beforeSave = total(); await save(source); const saved = await entries(); assert.equal(saved.length, 1);
    assert.equal(saved[0].id, translatedId); assert.equal(saved[0].createdAt, translatedCreatedAt);
    assert.equal(saved[0].coreText, original.coreText); assert.equal(saved[0].exampleKind, 'bilingual');
    assert.match(saved[0].detailsText, /The wetland showed resilience/); assert.ok(saved[0].updatedAt >= translatedUpdatedAt);
    assert.equal(total(), beforeSave);
  });
  await check('technical explanation inside a real preview iframe saves that document and its nearby context', async () => {
    await source.goto(fixtures.origin + '/context-index'); await sleep(180);
    const frame = await dragPreview('context-tech', '/context-tech'), before = total();
    assert.equal(await invoke(frame, '#term-a', 'explain'), 'coherence'); await completed(frame);
    assert.equal(total(), before + 1); await save(frame);
    const saved = await entries(); assert.equal(saved.length, 2);
    const entry = saved.find(item => item.mode === 'explain'); assert.ok(entry); explainedId = entry.id;
    assert.equal(entry.text, 'coherence'); assert.equal(entry.sourceUrl, fixtures.origin + '/context-tech');
    assert.match(entry.sourceTitle, /Technical reading/); assert.match(entry.context, /CONTEXT_A_NEAR_SENTINEL/);
    assert.doesNotMatch(entry.context, /GLOBAL_NAV_NO_CONTEXT_SECRET|CONTEXT_HIDDEN_SECRET|CONTEXT_FORM_SECRET/);
    assert.equal(await host(source).count(), 0);
    await source.screenshot({ path: path.join(screenshots, 'preview-explanation-saved.png') });
  });
  await check('content-script sender cannot list/delete all phrases or directly read local collections', async () => {
    const sourceTab = await options.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), source.url()); assert.ok(sourceTab?.id);
    const results = await options.evaluate(async ({ tabId, id }) => chrome.scripting.executeScript({
      target: { tabId }, func: async phraseId => {
        const list = await chrome.runtime.sendMessage({ type: 'phrases:list' });
        const remove = await chrome.runtime.sendMessage({ type: 'phrases:delete', id: phraseId });
        let storage;
        try { storage = { allowed: true, result: await chrome.storage.local.get('savedPhrases') }; }
        catch (error) { storage = { allowed: false, error: error instanceof Error ? error.message : String(error) }; }
        return { list, remove, storage };
      }, args: [id]
    }), { tabId: sourceTab.id, id: translatedId });
    assert.equal(results.length, 1); const result = results[0].result;
    assert.equal(result.list.ok, false); assert.ok(!Array.isArray(result.list.entries));
    assert.equal(result.remove.ok, false); assert.equal(result.storage.allowed, false);
    assert.equal((await entries()).length, 2);
    return { listRejected: true, deleteRejected: true, directLocalStorageRejected: true };
  });
  await check('result-card library button opens the actual collection with answers, context and safe source links', async () => {
    const frame = source.frames().find(candidate => candidate.url() === fixtures.origin + '/context-tech'); assert.ok(frame);
    const newPage = context.waitForEvent('page'); await action(frame, 'library').click(); library = await newPage;
    await library.waitForURL(`chrome-extension://${extensionId}/phrases.html`);
    await until(async () => await cards().count() === 2, 'saved cards missing');
    assert.match(await library.locator('#result-count').innerText(), /2/);
    const translation = cards().filter({ has: library.locator('.phrase-text', { hasText: 'resilience' }) });
    const explanation = cards().filter({ has: library.locator('.phrase-text', { hasText: 'coherence' }) });
    assert.equal(await translation.count(), 1); assert.equal(await explanation.count(), 1);
    assert.match(await translation.locator('.phrase-answer').innerText(), /CONTEXT_TRANSLATION_OUTPUT/);
    await translation.locator('.phrase-details summary').filter({ hasText: '双语例句' }).click();
    assert.match(await translation.locator('.phrase-details[open]').innerText(), /The wetland showed resilience/);
    await explanation.locator('.context-details summary').click();
    assert.match(await explanation.locator('.context-details').innerText(), /CONTEXT_A_NEAR_SENTINEL/);
    assert.equal(await explanation.locator('.source-link').getAttribute('href'), fixtures.origin + '/context-tech');
    assert.equal(await explanation.locator('.source-link').getAttribute('target'), '_blank');
    assert.match(await explanation.locator('.source-link').getAttribute('rel'), /noopener/);
    await library.screenshot({ path: path.join(screenshots, 'library-desktop.png'), fullPage: true });
  });
  await check('updating an older phrase moves it ahead of newer phrases by updated time', async () => {
    const before = total(); await gotoSource(true); await invoke(source, '#term-foreign'); await completed(source); await save(source);
    assert.equal(total(), before + 1, 'only the new translation may call the model');
    const saved = await entries(); assert.equal(saved.length, 2); assert.equal(saved[0].id, translatedId);
    assert.ok(saved[0].updatedAt > saved.find(entry => entry.id === explainedId).updatedAt);
    assert.equal(saved[0].createdAt, translatedCreatedAt);
    await refreshLibrary(2);
    assert.equal(await cards().first().locator('.phrase-text').innerText(), 'resilience');
    assert.match(await cards().first().innerText(), /双语例句/);
  });
  await check('returning focus with unchanged collection preserves expanded examples', async () => {
    const before = total(), translation = cards().filter({ has: library.locator('.phrase-text', { hasText: 'resilience' }) });
    const examples = translation.locator('.phrase-details').filter({ has: library.locator('summary', { hasText: '双语例句' }) });
    if (!(await examples.evaluate(element => element.open))) await examples.locator('summary').click();
    assert.equal(await examples.evaluate(element => element.open), true);
    await source.bringToFront(); await library.bringToFront();
    await until(() => library.locator('#refresh').isEnabled(), 'focus-triggered refresh did not finish');
    // Allow visibility/focus refresh callbacks to settle, then inspect the same entry.
    await sleep(160); assert.equal(await examples.evaluate(element => element.open), true);
    await refreshLibrary(2); assert.equal(await examples.evaluate(element => element.open), true);
    assert.equal(total(), before);
  });
  await check('collection search covers words, answers, bilingual examples, nearby context and source titles', async () => {
    for (const keyword of ['RESILIENCE', 'CONTEXT_TRANSLATION_OUTPUT', 'wetland', 'FOREIGN_CONTEXT_SENTINEL', 'Foreign reading']) {
      await library.locator('#search').fill(keyword);
      await until(async () => await cards().count() === 1, 'search did not find phrase: ' + keyword);
      assert.equal(await cards().first().locator('.phrase-text').innerText(), 'resilience');
    }
    await library.locator('#search').fill('no-matching-phrase-987654');
    await until(async () => await cards().count() === 0, 'no-result search retained cards');
    assert.equal(await library.locator('#empty-state').isVisible(), true);
    assert.match(await library.locator('#empty-title').innerText(), /没有找到/);
    await library.locator('#reset-search').click(); await until(async () => await cards().count() === 2, 'reset search failed');
  });
  await check('translation/explanation filters combine with search and keep total count intact', async () => {
    await library.locator('[data-mode="translate"]').click(); assert.equal(await cards().count(), 1); assert.match(await cards().innerText(), /resilience/);
    await library.locator('#search').fill('coherence'); assert.equal(await cards().count(), 0);
    await library.locator('[data-mode="explain"]').click(); assert.equal(await cards().count(), 1); assert.match(await cards().innerText(), /coherence/);
    assert.equal(await library.locator('#total-count').innerText(), '2');
    await library.locator('#search').fill(''); await library.locator('[data-mode="all"]').click(); assert.equal(await cards().count(), 2);
  });
  await check('JSON and Markdown downloads contain phrase fields only and respect all/filtered scope', async () => {
    const before = total(); await library.locator('#export-scope').selectOption('all');
    const jsonText = await download('json'), json = JSON.parse(jsonText);
    assert.deepEqual(Object.keys(json).sort(), ['entries', 'exportedAt', 'format', 'version']);
    assert.equal(json.entries.length, 2); assert.equal(json.format, 'reading-assistant-phrases');
    const allowed = ['id', 'text', 'context', 'sourceTitle', 'sourceUrl', 'mode', 'coreText', 'detailsText', 'exampleKind', 'createdAt', 'updatedAt'];
    for (const entry of json.entries) assert.ok(Object.keys(entry).every(key => allowed.includes(key)), 'export contains non-phrase fields');
    assert.match(jsonText, /The wetland showed resilience/); assert.match(jsonText, /CONTEXT_A_NEAR_SENTINEL/);
    const markdown = await download('md'); assert.match(markdown, /resilience/); assert.match(markdown, /coherence/); assert.match(markdown, /双语例句/); assert.match(markdown, /原文语境/);
    await library.locator('[data-mode="translate"]').click(); await library.locator('#export-scope').selectOption('filtered');
    const filteredJson = JSON.parse(await download('json')); assert.equal(filteredJson.entries.length, 1); assert.equal(filteredJson.entries[0].id, translatedId);
    const filteredMd = await download('md'); assert.match(filteredMd, /resilience/); assert.doesNotMatch(filteredMd, /CONTEXT_A_NEAR_SENTINEL/);
    assert.equal(total(), before); await library.locator('[data-mode="all"]').click();
    await library.locator('#export-scope').selectOption('all');
    return { jsonEntries: 2, filteredEntries: 1, modelRequests: 0 };
  });
  await check('390px collection and delete dialog remain usable without horizontal overflow', async () => {
    await library.setViewportSize({ width: 390, height: 844 });
    assert.ok(await library.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'collection overflows 390px viewport');
    for (const selector of ['#search', '#export-json', '#export-markdown']) assert.equal(await library.locator(selector).isVisible(), true);
    await library.screenshot({ path: path.join(screenshots, 'library-mobile.png'), fullPage: true });
    await cards().first().locator('.delete-button').click(); await library.locator('#delete-dialog').waitFor({ state: 'visible' });
    const box = await library.locator('#delete-dialog').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391);
    await library.screenshot({ path: path.join(screenshots, 'delete-mobile.png') }); await library.locator('#cancel-delete').click();
    assert.equal((await entries()).length, 2); await library.setViewportSize({ width: 1280, height: 900 });
    return { viewportWidth: 390, horizontalOverflow: false };
  });
  await check('deleting a phrase in its library re-enables saving the still-open result without another model request', async () => {
    const before = total();
    assert.equal(await action(source, 'save').innerText(), '已收藏'); assert.equal(await action(source, 'save').isDisabled(), true);
    const translation = cards().filter({ has: library.locator('.phrase-text', { hasText: 'resilience' }) });
    await translation.locator('.delete-button').click(); await library.locator('#delete-dialog').waitFor({ state: 'visible' });
    await library.locator('#confirm-delete').click(); await library.locator('#delete-dialog').waitFor({ state: 'hidden' });
    await until(async () => (await entries()).length === 1, 'library deletion did not persist');
    await source.bringToFront(); await until(() => action(source, 'save').isEnabled(), 'open result still treats the deleted phrase as saved');
    assert.match(await action(source, 'save').innerText(), /收藏/); await save(source);
    const saved = await entries(); assert.equal(saved.length, 2); const translationAgain = saved.find(entry => entry.text === 'resilience');
    assert.ok(translationAgain); assert.notEqual(translationAgain.id, translatedId); translatedId = translationAgain.id;
    assert.equal(total(), before); await refreshLibrary(2);
    return { deleteThenResave: true, modelRequests: 0 };
  });
  await check('delete requires confirmation; cancel keeps data and confirm removes only that entry', async () => {
    const before = total(); await deleteFirst({ cancel: true }); assert.equal((await entries()).length, 2);
    const removedText = await cards().first().locator('.phrase-text').innerText();
    await deleteFirst(); const saved = await entries(); assert.equal(saved.length, 1); assert.ok(saved.every(entry => entry.text !== removedText));
    assert.equal(total(), before); assert.equal(await library.locator('#total-count').innerText(), '1');
    return { retainedId: saved[0].id, removedText, modelRequests: 0 };
  });
  await check('storage contains local phrase data without a remembered API Key or sync copies', async () => {
    const [local, sync, session] = await options.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.sync.get(null), chrome.storage.session.get(null)]));
    assert.ok(Array.isArray(local.savedPhrases)); assert.equal(local.savedPhrases.length, 1);
    assert.ok(!JSON.stringify(local).includes(fakeKey)); assert.ok(JSON.stringify(session).includes(fakeKey), 'test requires a session-only Key before restart');
    assert.deepEqual(sync, {}); assert.deepEqual(await hashDirectory(testExtension), testedFiles);
  });

  const persistedBeforeRestart = await entries(), priorExtensionId = extensionId;
  await context.close(); context = undefined;
  await launch(testExtension); assert.equal(extensionId, priorExtensionId); await openOptions(); await openLibrary();
  await check('browser restart preserves saved phrases in the same profile and clears the session-only Key', async () => {
    const before = total(), saved = await entries(); assert.deepEqual(saved, persistedBeforeRestart);
    const configuration = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' })); assert.equal(configuration.hasKey, false);
    const stored = await options.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]));
    assert.deepEqual(stored[0].savedPhrases, persistedBeforeRestart); assert.ok(!JSON.stringify(stored).includes(fakeKey));
    assert.equal(await cards().count(), 1); assert.equal(total(), before);
    return { sameProfile: true, phraseCount: saved.length, sessionKeyCleared: true };
  });
  await check('collection remains readable, searchable and exportable after all website/API grants are removed', async () => {
    const before = total();
    const manager = await context.newPage(); await manager.goto('chrome://extensions');
    await manager.evaluate(extensionId => chrome.developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: 'ON_CLICK' }), extensionId);
    await manager.close();
    const configuration = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' })); assert.equal(configuration.hasKey, false); assert.deepEqual(configuration.permissions, []);
    await refreshLibrary(1); const saved = await entries(); assert.equal(saved.length, 1);
    await library.locator('#search').fill(saved[0].text); assert.equal(await cards().count(), 1);
    assert.equal(JSON.parse(await download('json')).entries.length, 1); assert.ok((await download('md')).includes(saved[0].text));
    await library.locator('#search').fill(''); assert.equal(total(), before);
  });
  await check('last confirmed deletion shows the true empty state and disables exports without a model call', async () => {
    const before = total(); await deleteFirst(); assert.equal((await entries()).length, 0);
    assert.equal(await library.locator('#empty-state').isVisible(), true); assert.match(await library.locator('#empty-title').innerText(), /还没有/);
    assert.equal(await library.locator('#total-count').innerText(), '0');
    assert.equal(await library.locator('#export-json').isDisabled(), true); assert.equal(await library.locator('#export-markdown').isDisabled(), true);
    await library.setViewportSize({ width: 390, height: 844 }); await library.screenshot({ path: path.join(screenshots, 'empty-mobile.png'), fullPage: true });
    assert.equal(total(), before);
  });
  await check('all network traffic is loopback and production/test-copy builds remain byte-identical', async () => {
    assert.ok(report.network.every(request => ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname)));
    assert.deepEqual(await hashDirectory(testExtension), testedFiles); assert.deepEqual(await hashDirectory(productionDirectory), testedFiles);
    return { externalRequests: 0, realModelVerified: false, productionBytesUnchanged: true };
  });
} catch (error) { fatal = error; report.fatal = error.message; process.stdout.write(`FATAL ${error.message}\n`); }
finally {
  if (context) await context.close().catch(() => {}); await fixtures.close();
  const after = await hashDirectory(productionDirectory); report.testedBuild.unchangedAfterTest = JSON.stringify(after) === JSON.stringify(testedFiles);
  if (!report.testedBuild.unchangedAfterTest) { report.fatal = 'Production dist changed during phrases test'; fatal ??= new Error(report.fatal); }
  report.passed = report.checks.filter(check => check.result === 'pass').length;
  report.failed = report.checks.filter(check => check.result === 'fail').length;
  const passed = fragment => report.checks.some(check => check.result === 'pass' && check.name.includes(fragment));
  report.coverage = {
    trustedSelectionSave: passed('real translation enables save'),
    onlyCompletedAnswersSaveable: passed('real translation enables save'),
    saveAddsZeroModelRequests: passed('real translation enables save') && passed('adding bilingual examples'),
    deduplication: passed('same source, selected text and mode'),
    examplesUpdateSamePhrase: passed('adding bilingual examples'),
    previewIframeSource: passed('technical explanation inside a real preview iframe'),
    contentScriptIsolation: passed('content-script sender cannot list/delete'),
    actualLibraryEntry: passed('result-card library button opens'),
    updatedPhraseSortsFirst: passed('updating an older phrase'),
    unchangedRefreshPreservesExpansion: passed('returning focus with unchanged'),
    deletedPhraseCanBeSavedAgain: passed('deleting a phrase in its library'),
    searchAndModeFilters: passed('collection search covers') && passed('translation/explanation filters'),
    safeJsonAndMarkdownExport: passed('JSON and Markdown downloads'),
    deleteConfirmationAndEmptyState: passed('delete requires confirmation') && passed('last confirmed deletion'),
    narrow390: passed('390px collection and delete dialog'),
    localOnlyStorage: passed('storage contains local phrase data'),
    sameProfileRestartPersistence: passed('browser restart preserves'),
    sessionKeyClearedAfterRestart: passed('browser restart preserves'),
    managementWithoutModelOrWebsitePermission: passed('empty collection opens') && passed('collection remains readable'),
    productionBytesUnchanged: passed('all network traffic is loopback') && report.testedBuild.unchangedAfterTest
  };
  report.screenshots = (await fs.readdir(screenshots)).filter(name => name.endsWith('.png')).map(name => `test-results/phrases-${version}/${name}`);
  await fs.writeFile(path.join(output, `phrases-e2e-report-${version}.json`), JSON.stringify(report, null, 2) + '\n');
  assertTestDirectory(profile); await fs.rm(profile, { recursive: true, force: true });
  process.stdout.write(`Mock phrases ${version} e2e: ${report.passed} passed, ${report.failed} failed. Real model answer quality remains unverified.\n`);
  if (fatal || report.failed) process.exitCode = 1;
}

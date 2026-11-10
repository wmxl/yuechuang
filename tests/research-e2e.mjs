import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startResearchFixtures, RIVER_QUOTE, STREAM_QUOTE, HTML_MARKER } from './fixtures/research-server.mjs';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'test-results');
const screenshots = path.join(output, `research-${version}`);
await fs.mkdir(screenshots, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  for (const directory of ['.cache/ms-playwright', '.browsers']) {
    const candidate = path.join(root, directory);
    try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; break; } } catch {}
  }
}
const { chromium } = await import('playwright');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, message, timeout = 16000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await sleep(70);
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
assert.equal(manifest.version, version, 'Build the current extension before running research e2e');
const report = {
  mockOnly: true, realModelVerified: false, extensionVersion: version, date: new Date().toISOString(), checks: [], network: [],
  testedBuild: { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false },
  testHarness: {
    productionWorkerWithoutTestEntry: true, productionSourceModified: false, testCopyRestored: false,
    trustedResearchFormAndButtonClicks: true,
    permissionBootstrap: 'The fresh profile loads a byte-identical copy of the production manifest with website access.',
  },
  notes: [
    'Research runs through the packaged research.html form and unchanged production worker; loopback documents and JSON/SSE responses are deterministic mocks.',
    'Source quotes are verified against real fixture article text. No live model quality or native permission dialog behavior is claimed.',
    'Permission and sender boundary checks intentionally send runtime messages from actual extension pages and an injected isolated-world content script; no worker testing endpoint is added.',
    'Markdown is read from a real browser download. Browser restart uses the same isolated profile without clearing local reports.'
  ]
};
const fixtures = await startResearchFixtures({ port: Number(process.env.RESEARCH_FIXTURE_PORT || 4347) });
report.fixtureOrigin = fixtures.origin;
const profile = await fs.mkdtemp(path.join(output, `research-${version}-profile-`));
const testExtension = path.join(profile, 'test-extension');
assertTestDirectory(profile); assertTestDirectory(testExtension);
const fakeKey = 'research-local-mock-key-do-not-use-with-real-service';
let context, options, research, worker, extensionId, fatal, savedId;
const total = () => fixtures.getStats().totalRequestsSinceStart;
const count = () => fixtures.getStats().count;
const pageCount = () => fixtures.getStats().totalPagesSinceStart;
const url = path => fixtures.origin + path;
const savedCards = () => research.locator('#saved-reports .saved-card');
async function check(name, operation) {
  const started = Date.now(), before = total(), pagesBefore = pageCount();
  try {
    const evidence = await operation();
    report.checks.push({ name, result: 'pass', milliseconds: Date.now() - started, requestsBefore: before, requestsAfter: total(), newRequests: total() - before, pagesBefore, pagesAfter: pageCount(), ...(evidence ? { evidence } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.checks.push({ name, result: 'fail', milliseconds: Date.now() - started, requestsBefore: before, requestsAfter: total(), newRequests: total() - before, error: error.message });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    if (research && !research.isClosed()) await research.screenshot({ path: path.join(screenshots, `failure-${report.checks.length}.png`), fullPage: true }).catch(() => {});
    throw error;
  }
}
async function launch(directory) {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1', acceptDownloads: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`, '--no-first-run'] });
  context.setDefaultTimeout(8000);
  context.on('request', request => { if (request.url().startsWith('http')) report.network.push({ method: request.method(), url: request.url() }); });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname; report.browser = context.browser().version();
}
async function openOptions() {
  options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await until(() => options.locator('#save-settings').isEnabled(), 'settings unavailable');
}
async function openResearch() {
  research = await context.newPage(); await research.goto(`chrome-extension://${extensionId}/research.html`);
  await until(async () => (await research.locator('#saved-count').innerText()).includes('/ 20'), 'research page not initialized');
}
async function configure(model = 'normal', budget = 16000, suppliedKey) {
  await options.bringToFront(); await until(() => options.locator('#save-settings').isEnabled(), 'settings unavailable');
  await options.locator('#base-url').fill(url('/v1')); await options.locator('#model').fill(model);
  await options.locator('#remember-key').setChecked(false); await options.locator('#auto-long-summary').setChecked(false); await options.locator('#input-budget').fill(String(budget));
  if (suppliedKey !== undefined) await options.locator('#api-key').fill(suppliedKey);
  await options.locator('#save-settings').click();
  await until(async () => {
    const response = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }));
    return await options.locator('#save-settings').isEnabled() && response.settings.model === model && response.settings.inputBudgetTokens === budget;
  }, 'settings not saved');
  if (research && !research.isClosed()) { await research.bringToFront(); await research.locator('#refresh-reports').click(); }
}
async function state() {
  const response = await research.evaluate(() => chrome.runtime.sendMessage({ type: 'research:status' }));
  assert.equal(response.ok, true, response.error); return response.task;
}
async function view() {
  const response = await research.evaluate(() => chrome.runtime.sendMessage({ type: 'research:view' }));
  assert.equal(response.ok, true, response.error); return response;
}
async function fill(question, paths) {
  await research.bringToFront(); await research.locator('#question').fill(question); await research.locator('#urls').fill(paths.map(value => value.startsWith('http') ? value : url(value)).join('\n'));
  await sleep(120);
}
async function start(question, paths) {
  const previous = (await state())?.id;
  await fill(question, paths); await until(() => research.locator('#start-research').isEnabled(), 'start button unavailable');
  await research.locator('#start-research').click();
  await until(async () => (await state())?.id !== previous, 'task did not start');
}
async function terminal(expected = 'done') {
  const task = await until(async () => { const value = await state(); return value && !['reading', 'analyzing', 'synthesizing'].includes(value.status) ? value : false; }, 'research did not finish', 30000);
  assert.equal(task.status, expected, task.error || task.stage);
  await research.locator('#refresh-reports').click();
  await until(async () => await research.locator('#task-status').getAttribute('data-status') === expected, 'terminal UI did not refresh');
  return task;
}
async function tabs() { return options.evaluate(() => chrome.tabs.query({})); }
async function download(button = '#export-report') {
  const event = research.waitForEvent('download'); await research.locator(button).click();
  const downloaded = await event, location = await downloaded.path(); assert.ok(location); assert.equal(await downloaded.failure(), null);
  assert.ok(downloaded.suggestedFilename().endsWith('.md'));
  const text = await fs.readFile(location, 'utf8'); assert.ok(!text.includes(fakeKey)); assert.ok(!text.includes(url('/v1'))); return text;
}

try {
  await fs.cp(productionDirectory, testExtension, { recursive: true });
  assert.deepEqual(await hashDirectory(testExtension), testedFiles); report.testHarness.testCopyRestored = true;
  await launch(testExtension); await openOptions(); await openResearch();
  await check('empty research page opens without Key and performs zero requests', async () => {
    const response = await view(); assert.equal(response.hasKey, false); assert.deepEqual(response.reports, []);
    assert.equal(await research.locator('#task-empty').isVisible(), true); assert.equal(await research.locator('#saved-empty').isVisible(), true);
    assert.equal(await research.locator('#start-research').isDisabled(), true); assert.equal(total(), 0); assert.equal(pageCount(), 0);
    await research.screenshot({ path: path.join(screenshots, 'empty-desktop.png'), fullPage: true });
  });
  await openOptions(); await configure('normal', 16000, fakeKey); await openResearch(); report.extensionId = extensionId;

  await check('five URL limit, duplicate URLs and invalid schemes are blocked with zero document or model requests', async () => {
    const before = total(), beforePages = pageCount();
    await fill('比较这些技术文档。', Array.from({ length: 5 }, (_, index) => `/river?v=${index}`));
    assert.equal(await research.locator('#start-research').isEnabled(), true);
    for (const paths of [Array.from({ length: 6 }, (_, index) => `/river?v=${index}`), ['/river', '/river'], ['javascript:alert(1)'], ['ftp://remote.test/article']]) {
      await fill('比较这些技术文档。', paths); assert.equal(await research.locator('#start-research').isDisabled(), true);
      const response = await research.evaluate(payload => chrome.runtime.sendMessage({ type: 'research:start', ...payload }), { question: '比较这些技术文档。', urls: paths.map(value => value.startsWith('/') ? url(value) : value) });
      assert.equal(response.ok, false);
    }
    assert.equal(total(), before); assert.equal(pageCount(), beforePages);
    return { maximumUrls: 5, rejectedCases: 4, documentRequests: 0, modelRequests: 0 };
  });
  await check('ungranted document host blocks both the UI and direct start without any request', async () => {
    const before = total(), beforePages = pageCount(), ungranted = `http://localhost:${new URL(fixtures.origin).port}/river`;
    const manager = await context.newPage(); await manager.goto('chrome://extensions');
    try {
      await manager.evaluate(async extensionId => {
        await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: 'ON_CLICK' });
        await chrome.developerPrivate.addHostPermission(extensionId, 'http://127.0.0.1/*');
      }, extensionId);
      await fill('研究未授权的网页。', [ungranted]); assert.equal(await research.locator('#start-research').isDisabled(), true);
      const response = await research.evaluate(value => chrome.runtime.sendMessage({ type: 'research:start', question: '研究未授权的网页。', urls: [value] }), ungranted);
      assert.equal(response.ok, false); assert.match(response.error, /权限/); assert.equal(total(), before); assert.equal(pageCount(), beforePages);
    } finally {
      await manager.evaluate(extensionId => chrome.developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: 'ON_ALL_SITES' }), extensionId);
      await manager.close();
    }
  });
  await check('two real documents produce exactly three calls and every report citation targets a verified original quote', async () => {
    fixtures.reset(); await start('比较 RiverFlow 与 StreamJet 的背压方式及缓冲区大小。', ['/river', '/stream']);
    const task = await terminal(); assert.equal(task.calls, 3); assert.equal(task.maxCalls, 6); assert.equal(count(), 3);
    assert.deepEqual(fixtures.getStats().requests.map(record => record.kind), ['page', 'page', 'report']);
    assert.deepEqual(task.sources.map(source => source.status), ['done', 'done']);
    assert.equal(task.sources[0].findings[0].quote, RIVER_QUOTE); assert.equal(task.sources[1].findings[0].quote, STREAM_QUOTE);
    for (const section of Object.values(task.report)) for (const claim of section) for (const citation of claim.citations) assert.ok(task.sources.find(source => source.id === citation.sourceId)?.findings[citation.finding]);
    const bodies = fixtures.getStats().requests.map(record => record.body); assert.ok(bodies[0].messages[1].content.includes(RIVER_QUOTE)); assert.ok(bodies[1].messages[1].content.includes(STREAM_QUOTE));
    for (const body of bodies) { assert.equal(body.stream, true); assert.equal(body.store, false); assert.ok(!JSON.stringify(body).includes(fakeKey)); assert.ok(!JSON.stringify(body).includes('RESEARCH_FORM_SECRET_MUST_NOT_LEAVE')); }
    assert.ok(fixtures.getStats().requests.every(record => record.authPresent && record.authorizationScheme === 'Bearer'));
    assert.match(await research.locator('#report').innerText(), /64/); assert.match(await research.locator('#report').innerText(), /256/);
    const comparison = research.locator('#report #source-comparison table.comparison-table');
    assert.equal(await comparison.count(), 1, 'completed research must include one source comparison table');
    assert.equal(await comparison.locator('tbody tr').count(), 2);
    const rows = await comparison.locator('tbody tr').allInnerTexts();
    assert.ok(rows.some(row => row.includes('S1') && row.includes('RiverFlow') && row.includes('64')));
    assert.ok(rows.some(row => row.includes('S2') && row.includes('StreamJet') && row.includes('256')));
    assert.equal(await comparison.locator('tr[data-comparison-source-id="S1"] th[scope="row"]').count(), 1);
    assert.equal(await comparison.locator('tr[data-comparison-source-id="S2"] th[scope="row"]').count(), 1);
    assert.equal(await comparison.locator('.citation[data-source-id="S1"]').count(), 1); assert.equal(await comparison.locator('.citation[data-source-id="S2"]').count(), 1);
    await research.locator('#report .citation[data-source-id="S2"]').first().click();
    await until(() => research.evaluate(() => document.activeElement?.closest('[data-source-id]')?.getAttribute('data-source-id') === 'S2'), 'citation did not focus source evidence');
    const link = research.locator('#sources [data-source-id="S2"] .source-url'); assert.equal(await link.getAttribute('href'), url('/stream')); assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal((await tabs()).filter(tab => [url('/river'), url('/stream')].includes(tab.url || tab.pendingUrl)).length, 0, 'temporary reader tabs must close');
    await research.screenshot({ path: path.join(screenshots, 'comparison-desktop.png'), fullPage: true });
    return { modelCalls: 3, successfulSources: 2, exactQuotesVerified: true, temporaryTabsClosed: true, comparisonTable: true };
  });
  await check('saving and repeated save retain one local report and actual Markdown download excludes Key and configuration', async () => {
    const before = total(); await research.locator('#save-report').click();
    await until(async () => (await research.locator('#save-report').innerText()) === '已保存到本机' && await savedCards().count() === 1, 'report not saved');
    const first = (await view()).reports[0]; savedId = first.id;
    const repeated = await research.evaluate(id => chrome.runtime.sendMessage({ type: 'research:save', id }), first.task.id);
    assert.equal(repeated.ok, true, repeated.error); assert.equal(repeated.report.id, first.id); assert.equal((await view()).reports.length, 1);
    const markdown = await download(); assert.match(markdown, /RiverFlow/); assert.match(markdown, /StreamJet/); assert.ok(markdown.includes(RIVER_QUOTE)); assert.ok(markdown.includes(STREAM_QUOTE)); assert.match(markdown, /S2·1/);
    assert.ok(markdown.includes('| 来源 |'), 'Markdown download must include the source comparison table');
    const tableLines = markdown.split('\n').filter(line => line.startsWith('| S'));
    assert.equal(tableLines.length, 2); assert.ok(tableLines.some(line => line.includes('S1') && line.includes('RiverFlow') && line.includes('64'))); assert.ok(tableLines.some(line => line.includes('S2') && line.includes('StreamJet') && line.includes('256')));
    const stored = await options.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null), chrome.storage.sync.get(null)]));
    assert.equal(stored[0].researchReports.length, 1); assert.ok(!JSON.stringify(stored[0]).includes(fakeKey)); assert.ok(JSON.stringify(stored[1]).includes(fakeKey)); assert.deepEqual(stored[2], {});
    const allowed = ['id', 'question', 'urls', 'sources', 'status', 'stage', 'calls', 'maxCalls', 'createdAt', 'updatedAt', 'report', 'error']; assert.ok(Object.keys(stored[0].researchReports[0].task).every(key => allowed.includes(key)));
    assert.equal(total(), before);
    return { savedReports: 1, repeatedSaveSameId: true, markdownDownload: true, saveAndExportModelRequests: 0 };
  });
  await check('settings entry opens the packaged research page and 390px layouts fit without horizontal overflow', async () => {
    await options.bringToFront(); const entry = options.locator('a[href="research.html"]').first(); assert.equal(await entry.isVisible(), true); await entry.click();
    await options.waitForURL(`chrome-extension://${extensionId}/research.html`); await options.goto(`chrome-extension://${extensionId}/options.html`); await until(() => options.locator('#save-settings').isEnabled(), 'settings return failed');
    await options.setViewportSize({ width: 390, height: 844 }); assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await options.screenshot({ path: path.join(screenshots, 'settings-mobile.png'), fullPage: true }); await options.setViewportSize({ width: 1280, height: 900 });
    await research.bringToFront(); await research.setViewportSize({ width: 390, height: 844 });
    assert.ok(await research.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'research page overflows 390px');
    for (const selector of ['#question', '#urls', '#export-report']) { const box = await research.locator(selector).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 391, selector); }
    await research.screenshot({ path: path.join(screenshots, 'comparison-mobile.png'), fullPage: true }); await research.setViewportSize({ width: 1280, height: 900 });
    return { viewportWidth: 390, horizontalOverflow: false, settingsEntry: true };
  });
  await check('content, settings and phrases senders cannot view, start or delete research reports or read their storage', async () => {
    const before = total();
    const phrasePage = await context.newPage(); await phrasePage.goto(`chrome-extension://${extensionId}/phrases.html`);
    for (const page of [options, phrasePage]) {
      const responses = await page.evaluate(async ({ id, origin }) => Promise.all([
        chrome.runtime.sendMessage({ type: 'research:view' }), chrome.runtime.sendMessage({ type: 'research:start', question: 'Unauthorized sender', urls: [origin + '/river'] }), chrome.runtime.sendMessage({ type: 'research:delete', id })
      ]), { id: savedId, origin: fixtures.origin });
      assert.ok(responses.every(response => response.ok === false && !response.reports && !response.task));
    }
    const source = await context.newPage(); await source.goto(url('/river'));
    const sourceTab = (await tabs()).find(tab => tab.url === source.url()); assert.ok(sourceTab?.id);
    const results = await options.evaluate(async ({ tabId, id, origin }) => chrome.scripting.executeScript({ target: { tabId }, func: async ({ id, origin }) => {
      const responses = await Promise.all([chrome.runtime.sendMessage({ type: 'research:view' }), chrome.runtime.sendMessage({ type: 'research:start', question: 'Unauthorized content', urls: [origin + '/river'] }), chrome.runtime.sendMessage({ type: 'research:delete', id })]);
      let storage; try { await chrome.storage.local.get('researchReports'); storage = true; } catch { storage = false; }
      return { responses, storage };
    }, args: [{ id, origin }] }), { tabId: sourceTab.id, id: savedId, origin: fixtures.origin });
    assert.ok(results[0].result.responses.every(response => response.ok === false && !response.reports && !response.task)); assert.equal(results[0].result.storage, false);
    assert.equal((await view()).reports.length, 1); assert.equal(total(), before); await source.close(); await phrasePage.close();
    return { rejectedSenders: ['content-script', 'settings.html', 'phrases.html'], directStorageDenied: true };
  });
  await check('login, empty and cross-host redirected sources are listed as failures and never become invented evidence', async () => {
    fixtures.reset(); await start('比较可读资料，并明确无法访问的来源。', ['/river', '/login', '/empty', '/redirect']);
    const task = await terminal(); assert.equal(count(), 2); assert.equal(task.calls, 2);
    assert.deepEqual(task.sources.map(source => source.status), ['done', 'error', 'error', 'error']); assert.match(task.error, /3 个来源/);
    assert.ok(task.sources.slice(1).every(source => source.error && source.findings.length === 0));
    assert.match(task.sources[3].error, /跳转|授权|目标/);
    for (const claims of Object.values(task.report)) for (const claim of claims) assert.ok(claim.citations.every(citation => citation.sourceId === 'S1'));
    const allInputs = JSON.stringify(fixtures.getStats().requests); assert.ok(!allInputs.includes('RESEARCH_LOGIN_SECRET_MUST_NOT_LEAVE'));
    const final = JSON.parse(fixtures.getStats().requests.find(record => record.kind === 'report').body.messages[1].content); assert.deepEqual(final.sources.map(source => source.sourceId), ['S1']);
    assert.equal(await research.locator('#sources .source-state[data-status="error"]').count(), 3);
    await research.screenshot({ path: path.join(screenshots, 'partial-failures.png'), fullPage: true });
    return { successfulSources: 1, failedSources: 3, modelCalls: 2, failedSourcesExcludedFromReport: true };
  });
  await check('five allowed documents consume exactly the six-call ceiling with no automatic extra requests', async () => {
    fixtures.reset(); await start('整理这五份资料的流量控制方式。', Array.from({ length: 5 }, (_, index) => `/river?source=${index}`));
    const task = await terminal(); assert.equal(task.sources.length, 5); assert.equal(task.calls, 6); assert.equal(count(), 6); await sleep(300); assert.equal(count(), 6);
    assert.equal(fixtures.getStats().requests.filter(record => record.kind === 'page').length, 5); assert.equal(fixtures.getStats().requests.filter(record => record.kind === 'report').length, 1);
    return { pages: 5, calls: 6, automaticRetries: 0 };
  });
  await check('over-budget full article is rejected before any page-model call and is never silently truncated', async () => {
    await configure('normal', 2048); fixtures.reset(); await start('研究较长正文的背压机制。', ['/long']);
    const task = await terminal('error'); assert.equal(task.calls, 0); assert.equal(count(), 0); assert.equal(task.sources[0].status, 'error'); assert.match(task.sources[0].error, /预算/); assert.match(task.sources[0].error, /没有裁切/);
    assert.ok(task.sources[0].characters > 20000); assert.equal(await research.locator('#save-report').isDisabled(), true);
    await configure('normal', 16000); return { modelCalls: 0, sourceCharacters: task.sources[0].characters, noTruncation: true };
  });
  await check('forged original quote and invalid final citations fail closed and cannot be saved', async () => {
    await configure('forged-quote'); fixtures.reset(); await start('核对原文证据。', ['/river']); const forged = await terminal('error');
    assert.equal(count(), 1); assert.equal(forged.sources[0].findings.length, 0); assert.equal(forged.report, undefined); assert.equal(await research.locator('#save-report').isDisabled(), true);
    await configure('bad-citation'); fixtures.reset(); await start('核对最终报告引用。', ['/river']); const bad = await terminal('error');
    assert.equal(count(), 2); assert.match(bad.error, /引用/); assert.equal(bad.report, undefined); assert.equal(await research.locator('#save-report').isDisabled(), true);
    assert.equal((await view()).reports.length, 1); await configure('normal');
    return { forgedQuoteRejected: true, danglingCitationRejected: true, noIncompleteSave: true };
  });
  await check('model supplied HTML remains literal text and citation controls never execute it', async () => {
    fixtures.reset(); await start('安全渲染：整理此页的缓冲设置。', ['/river']); const task = await terminal(); assert.equal(count(), 2);
    assert.ok(task.report.overview[0].text.includes(HTML_MARKER)); assert.ok((await research.locator('#report').innerText()).includes(HTML_MARKER));
    assert.equal(await research.locator('#report img, #report script, #sources img').count(), 0); assert.equal(await research.evaluate(() => document.documentElement.dataset.researchXss), undefined);
    await research.locator('#report .citation').first().click(); assert.equal(await research.evaluate(() => document.documentElement.dataset.researchXss), undefined);
    const markdown = await download(); assert.ok(markdown.includes('\\<img')); assert.ok(!markdown.includes(fakeKey));
    return { literalHtml: true, injectedElements: 0, citationFocusSafe: true };
  });
  await check('stop aborts an active model request, starts no later source and cleans task-owned tabs', async () => {
    await configure('slow'); fixtures.reset(); const baseline = new Set((await tabs()).map(tab => tab.id));
    await start('停止正在进行的研究。', ['/river', '/stream']); await until(() => count() === 1, 'slow model request not started');
    assert.equal(await research.locator('#save-report').isDisabled(), true); await research.locator('#stop-research').click(); const task = await terminal('cancelled');
    await until(() => fixtures.getStats().requests[0]?.aborted, 'model stream not aborted'); await sleep(400);
    assert.equal(count(), 1); assert.ok(!fixtures.getStats().pages.some(page => page.path === '/stream')); assert.equal(task.report, undefined);
    assert.ok((await tabs()).every(tab => baseline.has(tab.id)), 'temporary reading tab survived stop'); await configure('normal');
    return { aborted: true, laterSourcesRead: 0, calls: 1, temporaryTabsClosed: true };
  });
  await check('closing the research page stops in-flight document reading and removes its temporary tab', async () => {
    fixtures.reset(); const baseline = new Set((await tabs()).map(tab => tab.id)); await start('关闭任务页时停止。', ['/slow-river', '/stream']);
    await until(async () => (await tabs()).some(tab => !baseline.has(tab.id) && (tab.url || tab.pendingUrl || '').includes('/slow-river')), 'temporary slow document tab missing');
    await research.close(); research = undefined;
    await until(async () => (await tabs()).every(tab => baseline.has(tab.id)), 'temporary document tab survived research page close');
    await openResearch(); const task = await terminal('cancelled'); assert.match(task.error, /关闭/); await sleep(300); assert.equal(count(), 0);
    assert.ok(!fixtures.getStats().pages.some(page => page.path === '/stream')); assert.equal((await view()).reports.length, 1);
    return { closedPageStops: true, modelCalls: 0, temporaryTabRemoved: true };
  });

  const beforeRestart = (await view()).reports, priorExtensionId = extensionId;
  await context.close(); context = undefined;
  await launch(testExtension); assert.equal(extensionId, priorExtensionId); await openOptions(); await openResearch();
  await check('same-profile browser restart retains saved reports and clears the session-only API Key', async () => {
    const before = total(), response = await view(); assert.deepEqual(response.reports, beforeRestart); assert.equal(response.hasKey, false); assert.equal(await savedCards().count(), 1);
    const stored = await options.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)])); assert.deepEqual(stored[0].researchReports, beforeRestart); assert.ok(!JSON.stringify(stored).includes(fakeKey)); assert.equal(total(), before);
    return { sameProfile: true, savedCount: 1, sessionKeyCleared: true };
  });
  await check('saved report can be viewed, exported and deleted offline without Key or website permissions', async () => {
    const before = total();
    const manager = await context.newPage(); await manager.goto('chrome://extensions');
    await manager.evaluate(extensionId => chrome.developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: 'ON_CLICK' }), extensionId);
    await manager.close();
    await research.bringToFront(); await research.locator('#refresh-reports').click(); await until(async () => (await view()).permissions.length === 0, 'permissions not removed');
    await savedCards().first().locator('[data-action="view"]').click(); assert.match(await research.locator('#report').innerText(), /256/);
    const text = await download(); assert.ok(text.includes(RIVER_QUOTE)); assert.ok(text.includes(STREAM_QUOTE)); assert.equal(total(), before);
    await savedCards().first().locator('[data-action="delete"]').click(); await research.locator('#delete-dialog').waitFor({ state: 'visible' }); await research.locator('#cancel-delete').click(); assert.equal((await view()).reports.length, 1);
    await savedCards().first().locator('[data-action="delete"]').click(); await research.locator('#delete-dialog').waitFor({ state: 'visible' }); await research.locator('#confirm-delete').click();
    await until(async () => (await view()).reports.length === 0 && await savedCards().count() === 0, 'confirmed deletion failed'); assert.equal(await research.locator('#saved-empty').isVisible(), true); assert.equal(total(), before);
    await research.setViewportSize({ width: 390, height: 844 }); await research.screenshot({ path: path.join(screenshots, 'offline-empty-mobile.png'), fullPage: true });
    return { withoutKeyOrGrants: true, actualExport: true, cancelledDeletePreserves: true, confirmedDeleteRemoves: true, modelCalls: 0 };
  });
  await check('all network traffic is loopback and production and test-copy builds remain byte-identical', async () => {
    assert.ok(report.network.every(request => ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname)));
    assert.deepEqual(await hashDirectory(testExtension), testedFiles); assert.deepEqual(await hashDirectory(productionDirectory), testedFiles);
    return { externalRequests: 0, realModelVerified: false, productionBytesUnchanged: true };
  });
} catch (error) { fatal = error; report.fatal = error.message; process.stdout.write(`FATAL ${error.message}\n`); }
finally {
  if (context) await context.close().catch(() => {}); await fixtures.close();
  const after = await hashDirectory(productionDirectory); report.testedBuild.unchangedAfterTest = JSON.stringify(after) === JSON.stringify(testedFiles);
  if (!report.testedBuild.unchangedAfterTest) { report.fatal = 'Production dist changed during research test'; fatal ??= new Error(report.fatal); }
  report.passed = report.checks.filter(check => check.result === 'pass').length; report.failed = report.checks.filter(check => check.result === 'fail').length;
  const passed = fragment => report.checks.some(check => check.result === 'pass' && check.name.includes(fragment));
  report.coverage = {
    realResearchForm: passed('two real documents'), inputValidationAndFiveUrlLimit: passed('five URL limit'), ungrantedZeroRequests: passed('ungranted document host'),
    twoPagesThreeCalls: passed('two real documents'), verifiedQuotesAndCitations: passed('two real documents'), sourceComparisonTable: passed('two real documents'), temporaryTabsClosed: passed('two real documents') && passed('stop aborts'),
    partialFailuresExcluded: passed('login, empty and cross-host'), sixCallCeiling: passed('five allowed documents'), overBudgetZeroCalls: passed('over-budget'),
    invalidEvidenceRejected: passed('forged original quote'), safeHtmlRendering: passed('model supplied HTML'), explicitLocalSave: passed('saving and repeated save'),
    safeMarkdownDownload: passed('saving and repeated save'), markdownComparisonTable: passed('saving and repeated save'), senderAndStorageIsolation: passed('content, settings and phrases'), settingsEntryAndNarrow390: passed('settings entry'),
    stopAbortsAndNoLaterRequests: passed('stop aborts'), closePageStops: passed('closing the research page'), sameProfileRestartPersistence: passed('same-profile browser restart'),
    sessionKeyClearedAfterRestart: passed('same-profile browser restart'), offlineReportManagement: passed('saved report can be viewed'), deleteConfirmation: passed('saved report can be viewed'),
    productionBytesUnchanged: passed('all network traffic is loopback') && report.testedBuild.unchangedAfterTest
  };
  report.screenshots = (await fs.readdir(screenshots)).filter(name => name.endsWith('.png')).map(name => `test-results/research-${version}/${name}`);
  await fs.writeFile(path.join(output, `research-e2e-report-${version}.json`), JSON.stringify(report, null, 2) + '\n');
  assertTestDirectory(profile); await fs.rm(profile, { recursive: true, force: true });
  process.stdout.write(`Mock research ${version} e2e: ${report.passed} passed, ${report.failed} failed. Real model quality remains unverified.\n`);
  if (fatal || report.failed) process.exitCode = 1;
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSidebarFixtures, CHAT_HTML_MARKER, CHAT_MARKDOWN } from './fixtures/sidebar-server.mjs';
import { RIVER_QUOTE, STREAM_QUOTE } from './fixtures/research-server.mjs';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'test-results');
const screenshots = path.join(output, `sidebar-${version}`);
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
assert.equal(manifest.version, version, 'Build the current package version before running sidebar e2e');
const report = {
  mockOnly: true, realModelVerified: false, extensionVersion: version, date: new Date().toISOString(), checks: [], network: [],
  testedBuild: { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false },
  testHarness: {
    productionWorkerWithoutTestEntry: true, productionSourceModified: false, testCopyRestored: false,
    trustedShellFormsAndButtonClicks: true, nativeActionClickVerified: false, nativeSidePanelSurfaceVerified: false,
    permissionBootstrap: 'The fresh profile loads a byte-identical copy of the production manifest with website access.',
  },
  notes: [
    'The packaged sidepanel.html shell runs as an extension tab with unchanged production worker. Real form and button clicks drive chat, settings, research and collection tabs.',
    'Manifest side_panel and Chrome getPanelBehavior are verified directly. Native browser toolbar clicking and the native docked side-panel surface are not claimed by this headless browser test.',
    'Only deterministic loopback chat SSE and research fixtures are contacted. No API credential for a live service is used, and model answer quality remains unverified.',
    'Sender boundary probes use a real isolated-world content script on an ordinary webpage with panel=1, and actual untrusted extension frames.',
    'Same-profile browser restart verifies session Key/chat clearing and local research report persistence. Research download contents are read from actual browser downloads.'
  ]
};
const fixtures = await startSidebarFixtures({ port: Number(process.env.SIDEBAR_FIXTURE_PORT || 4357), researchPort: Number(process.env.SIDEBAR_RESEARCH_FIXTURE_PORT || 4358) });
report.fixtureOrigin = fixtures.origin; report.researchFixtureOrigin = fixtures.research.origin;
const profile = await fs.mkdtemp(path.join(output, `sidebar-${version}-profile-`));
const testExtension = path.join(profile, 'test-extension');
assertTestDirectory(profile); assertTestDirectory(testExtension);
const fakeKey = 'sidebar-local-mock-key-do-not-use-with-real-service';
let context, shell, worker, extensionId, fatal, settingsFrame, researchFrame, phrasesFrame, savedReport;
const total = () => fixtures.getStats().totalRequestsSinceStart + fixtures.research.getStats().totalRequestsSinceStart;
const count = () => fixtures.getStats().count;
const chatMessages = () => shell.locator('#chat-messages .chat-message');
const assistantMessages = () => shell.locator('#chat-messages .chat-message[data-role="assistant"]');
const tabButton = name => shell.locator(`[data-panel-tab="${name}"]`);
const extensionUrl = file => `chrome-extension://${extensionId}/${file}`;
async function check(name, operation) {
  const started = Date.now(), before = total();
  try {
    const evidence = await operation();
    report.checks.push({ name, result: 'pass', milliseconds: Date.now() - started, requestsBefore: before, requestsAfter: total(), newRequests: total() - before, ...(evidence ? { evidence } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.checks.push({ name, result: 'fail', milliseconds: Date.now() - started, requestsBefore: before, requestsAfter: total(), newRequests: total() - before, error: error.message });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    if (shell && !shell.isClosed()) await shell.screenshot({ path: path.join(screenshots, `failure-${report.checks.length}.png`), fullPage: true }).catch(() => {});
    throw error;
  }
}
async function launch(directory) {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: process.env.HEADED !== '1', acceptDownloads: true,
    viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`, '--no-first-run']
  });
  context.setDefaultTimeout(8000);
  context.on('request', request => { if (request.url().startsWith('http')) report.network.push({ method: request.method(), url: request.url() }); });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname; report.browser = context.browser().version();
}
async function openShell() {
  shell = await context.newPage(); await shell.goto(extensionUrl('sidepanel.html'));
  await until(async () => await shell.locator('#chat-input').isVisible() && !(await shell.locator('#chat-status').innerText()).includes('正在连接'), 'default chat shell not available');
  settingsFrame = researchFrame = phrasesFrame = undefined;
}
async function select(name) {
  await tabButton(name).click(); await until(async () => await tabButton(name).getAttribute('aria-selected') === 'true', `tab ${name} not selected`);
  if (name === 'chat') return shell;
  const frame = await until(async () => { const handle = await shell.locator(`#frame-${name}`).elementHandle(); return handle && await handle.contentFrame(); }, `frame ${name} unavailable`);
  if (name === 'settings') { settingsFrame = frame; await until(() => frame.locator('#save-settings').isEnabled(), 'embedded settings not initialized'); }
  if (name === 'research') { researchFrame = frame; await until(async () => (await frame.locator('#saved-count').innerText()).includes('/ 20'), 'embedded research not initialized'); }
  if (name === 'phrases') { phrasesFrame = frame; await until(async () => (await frame.locator('#total-count').innerText()) !== '—', 'embedded collection not initialized'); }
  return frame;
}
async function settingsView() {
  const response = await settingsFrame.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }));
  assert.equal(response.ok, true, response.error); return response;
}
async function configure({ base = fixtures.origin, model = 'normal', budget = 16000, key } = {}) {
  const frame = await select('settings');
  await frame.locator('#base-url').fill(base + '/v1'); await frame.locator('#model').fill(model);
  await frame.locator('#remember-key').setChecked(false); await frame.locator('#auto-long-summary').setChecked(false); await frame.locator('#input-budget').fill(String(budget));
  if (key !== undefined) await frame.locator('#api-key').fill(key);
  await frame.locator('#save-settings').click();
  await until(async () => { const value = await settingsView(); return await frame.locator('#save-settings').isEnabled() && value.settings.model === model && value.settings.baseUrl === base + '/v1' && value.settings.inputBudgetTokens === budget; }, 'embedded settings not saved');
  await select('chat');
  await until(() => shell.locator('#chat-setup').isHidden(), 'chat did not observe model configuration');
}
async function sendChat(text, expected = 'done') {
  await select('chat'); const before = await assistantMessages().count();
  await shell.locator('#chat-input').fill(text); await until(() => shell.locator('#chat-send').isEnabled(), 'chat send unavailable'); await shell.locator('#chat-send').click();
  if (expected === 'running') { await until(async () => await assistantMessages().count() > before && await assistantMessages().last().getAttribute('data-status') === 'running', 'chat did not start'); return; }
  await until(async () => await assistantMessages().count() > before && await assistantMessages().last().getAttribute('data-status') === expected, `chat did not reach ${expected}`);
  await until(async () => await shell.locator('#chat-stop').isHidden() && await shell.locator('#chat-input').isEnabled(), 'chat remained busy');
}
async function clearChat() {
  await shell.locator('#chat-new').click(); await shell.locator('#chat-clear-dialog').waitFor({ state: 'visible' }); await shell.locator('#chat-clear-confirm').click();
  await until(async () => await chatMessages().count() === 0, 'chat not cleared');
}
async function researchView() {
  const response = await researchFrame.evaluate(() => chrome.runtime.sendMessage({ type: 'research:view' }));
  assert.equal(response.ok, true, response.error); return response;
}
async function researchState() {
  const response = await researchFrame.evaluate(() => chrome.runtime.sendMessage({ type: 'research:status' }));
  assert.equal(response.ok, true, response.error); return response.task;
}
async function downloadReport() {
  const event = shell.waitForEvent('download'); await researchFrame.locator('#export-report').click();
  const download = await event; assert.equal(await download.failure(), null); assert.ok(download.suggestedFilename().endsWith('.md'));
  const location = await download.path(); assert.ok(location); const text = await fs.readFile(location, 'utf8'); assert.ok(!text.includes(fakeKey)); return text;
}
async function screenshotTabs(width, suffix) {
  await shell.setViewportSize({ width, height: 900 });
  for (const name of ['chat', 'research', 'phrases', 'settings']) {
    const frame = await select(name); await sleep(80);
    assert.equal(await shell.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${name} shell horizontal overflow at ${width}`);
    if (frame !== shell) assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${name} embedded page horizontal overflow at ${width}`);
    await shell.screenshot({ path: path.join(screenshots, `${name}-${suffix}.png`), fullPage: true });
  }
}

try {
  await fs.cp(productionDirectory, testExtension, { recursive: true });
  assert.deepEqual(await hashDirectory(testExtension), testedFiles); report.testHarness.testCopyRestored = true;
  await launch(testExtension); await openShell();
  await check('manifest declares native side panel with action-open behavior, and default shell is chat with four tabs and zero calls', async () => {
    assert.equal(manifest.side_panel?.default_path, 'sidepanel.html'); assert.ok(manifest.permissions.includes('sidePanel')); assert.equal(manifest.action?.default_popup, undefined);
    assert.deepEqual(await worker.evaluate(() => chrome.sidePanel.getPanelBehavior()), { openPanelOnActionClick: true });
    assert.equal(await shell.locator('[data-panel-tab]').count(), 4); assert.equal(await tabButton('chat').getAttribute('aria-selected'), 'true');
    assert.equal(await shell.locator('#panel-chat').isVisible(), true); assert.equal(await shell.locator('#chat-empty').isVisible(), true); assert.equal(await shell.locator('#chat-setup').isVisible(), true);
    assert.equal(await shell.locator('iframe').count(), 0, 'inactive pages should load on first selection'); assert.equal(total(), 0);
    await shell.screenshot({ path: path.join(screenshots, 'empty-desktop.png'), fullPage: true });
    return { defaultTab: 'chat', tabCount: 4, nativeBehaviorConfigured: true, nativeToolbarClickVerified: false, shellSurface: 'extension-tab' };
  });
  await check('actual settings switches an OAuth model with punctuation to API without website validation or model calls', async () => {
    const before = total();
    await worker.evaluate(() => chrome.storage.local.set({ webChatConfig: { provider: 'chatgptOAuth', model: 'gpt-6.1-terra' } }));
    const settingsOnly = await context.newPage();
    try {
      await settingsOnly.goto(extensionUrl('options.html'));
      await until(() => settingsOnly.locator('#save-connection').isEnabled(), 'connection settings not loaded');
      assert.equal(await settingsOnly.locator('input[name="chat-provider"]').count(), 2);
      assert.equal(await settingsOnly.locator('#connection-web').count(), 0);
      assert.equal(await settingsOnly.locator('#connection-oauth').isChecked(), true);
      await settingsOnly.locator('#connection-api').check();
      await settingsOnly.locator('#save-connection').click();
      await until(async () => (await settingsOnly.locator('#connection-feedback').innerText()).includes('已切换为模型 API'), 'API connection save failed');
      const connection = await settingsOnly.evaluate(() => chrome.runtime.sendMessage({ type: 'connection:get' }));
      assert.deepEqual(connection, { ok: true, view: { config: { provider: 'apiKey', model: '' } } });
      assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('webChatConfig')).webChatConfig), { provider: 'apiKey', model: '' });
      assert.equal(total(), before);
      assert.equal(await settingsOnly.locator('#connection-feedback').getAttribute('class'), 'connection-feedback');
      report.coverage ??= {}; report.coverage.twoProviderConnectionSave = true;
      return { realRuntimeMessages: true, onlyTwoProviders: true, canonicalApiConfig: true, modelCalls: 0, accountAuthorizationStarted: false };
    } finally { await settingsOnly.close(); }
  });
  await openShell(); report.extensionId = extensionId;
  await check('embedded settings saves the model configuration through actual controls without a model request and never echoes the Key', async () => {
    const before = total(); await configure({ key: fakeKey }); const response = await settingsView();
    assert.equal(response.hasKey, true); assert.ok(!JSON.stringify(response).includes(fakeKey)); assert.equal(await settingsFrame.locator('#api-key').inputValue(), ''); assert.equal(total(), before);
    assert.equal(await shell.locator('#chat-setup').isVisible(), false); assert.equal(await shell.locator('#chat-send').isDisabled(), true);
    const values = await shell.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]));
    assert.ok(!JSON.stringify(values[0]).includes(fakeKey)); assert.equal(values[1].apiKey, fakeKey);
    return { embeddedSenderAuthorized: true, calls: 0, sessionKeyOnly: true, keyReturnedToUI: false };
  });
  await check('chat uses trusted send clicks, streams text, and carries completed assistant messages in the next request', async () => {
    fixtures.reset(); await sendChat('解释背压。'); assert.equal(count(), 1); assert.equal(await chatMessages().count(), 2);
    const first = await assistantMessages().first().locator('.chat-message-content').innerText(); assert.match(first, /消费需求/);
    assert.deepEqual(fixtures.getStats().requests[0].body.messages.map(message => message.role), ['system', 'user']);
    await sendChat('继续，用一个简短的例子。'); assert.equal(count(), 2); assert.equal(await chatMessages().count(), 4);
    const request = fixtures.getStats().requests[1]; assert.deepEqual(request.body.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']); assert.equal(request.body.messages[2].content, first);
    for (const record of fixtures.getStats().requests) { assert.equal(record.body.stream, true); assert.equal(record.body.store, false); assert.equal(record.authPresent, true); assert.equal(record.authorizationScheme, 'Bearer'); assert.ok(!JSON.stringify(record.body).includes(fakeKey)); }
    return { realButtonClicks: 2, requests: 2, roles: request.body.messages.map(message => message.role), streamed: true };
  });
  await check('chat model HTML stays literal text, copy is a user action, and switching tabs preserves the unsent draft', async () => {
    await sendChat('安全渲染：请显示这个字面标记。');
    assert.ok((await assistantMessages().last().locator('.chat-message-content').innerText()).includes(CHAT_HTML_MARKER));
    assert.equal(await shell.locator('#chat-messages img, #chat-messages script').count(), 0); assert.equal(await shell.evaluate(() => document.documentElement.dataset.chatXss), undefined);
    const before = total(); const copy = assistantMessages().last().locator('.chat-copy'); await copy.click();
    await until(async () => /已复制/.test(await copy.innerText()) || /复制/.test(await shell.locator('#chat-status').innerText()), 'copy feedback not shown');
    await shell.locator('#chat-input').fill('尚未发送的聊天草稿'); await select('research'); await select('phrases'); await select('chat');
    assert.equal(await shell.locator('#chat-input').inputValue(), '尚未发送的聊天草稿'); assert.equal(total(), before);
    assert.equal(await shell.locator('#chat-messages img').count(), 0); await shell.locator('#chat-input').fill('');
    for (const width of [500, 390, 320]) {
      await shell.setViewportSize({ width, height: 900 }); assert.equal(await shell.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      await shell.screenshot({ path: path.join(screenshots, `chat-conversation-${width}.png`), fullPage: true });
    }
    await shell.setViewportSize({ width: 1280, height: 900 });
    return { injectedElements: 0, copyClicked: true, chatDraftPreserved: true, navigationCalls: 0 };
  });
  await check('Markdown answers render during streaming, remain safe, fit narrow panels, and preserve original copy and multi-turn text', async () => {
    await clearChat(); fixtures.reset(); const initialNetwork = report.network.length;
    const prompt = 'Markdown 渲染：**用户输入保留原文**。';
    await sendChat(prompt, 'running'); const answer = assistantMessages().last().locator('.chat-message-content');
    await until(async () => await assistantMessages().last().getAttribute('data-status') === 'running' && (await answer.locator('pre code').innerText()).includes('streamingFence'), 'unclosed streaming fence was not rendered');
    assert.notEqual(fixtures.getStats().requests[0].markdownFenceReleased, true, 'stream fixture must still have an unclosed fence');
    await until(async () => await assistantMessages().last().getAttribute('data-status') === 'done', 'Markdown stream did not finish');
    assert.equal(await answer.locator('h1').innerText(), 'Markdown 阅读示例'); assert.equal(await answer.locator('strong').innerText(), '重点');
    assert.equal(await answer.locator('em').innerText(), '强调'); assert.equal(await answer.locator('del').innerText(), '过时信息');
    assert.equal(await answer.locator('ul ul li').innerText(), '嵌套子项'); assert.equal(await answer.locator('ol > li').count(), 2);
    assert.match(await answer.locator('blockquote').innerText(), /消费需求/); assert.equal(await answer.locator('code').count(), 2);
    assert.match(await answer.locator('pre code').innerText(), /veryLongLine/); assert.equal(await answer.locator('table thead th').count(), 5); assert.equal(await answer.locator('table tbody tr').count(), 2);
    const user = shell.locator('.chat-message[data-role="user"] .chat-message-content').last();
    assert.equal(await user.innerText(), prompt); assert.equal(await user.locator('strong').count(), 0, 'user text must remain literal');
    const visibleText = await answer.innerText(); assert.ok(visibleText.includes(CHAT_HTML_MARKER)); assert.ok(visibleText.includes('<script>'));
    assert.ok(visibleText.includes('禁止脚本链接') && visibleText.includes('禁止数据链接') && visibleText.includes('不加载远程图片'));
    assert.equal(await answer.locator('img, script, iframe, object, svg').count(), 0); assert.equal(await shell.evaluate(() => document.documentElement.dataset.chatXss), undefined);
    assert.equal(await answer.locator('a').count(), 1); const link = answer.locator('a');
    assert.equal(await link.getAttribute('href'), 'https://example.com/guide?q=markdown'); assert.equal(await link.getAttribute('target'), '_blank');
    assert.deepEqual(new Set((await link.getAttribute('rel')).split(/\s+/)), new Set(['noopener', 'noreferrer'])); assert.equal(await link.getAttribute('referrerpolicy'), 'no-referrer');
    const layout = [];
    for (const width of [390, 320]) {
      await shell.setViewportSize({ width, height: 900 });
      const sizes = await answer.evaluate(element => {
        const pre = element.querySelector('pre'), table = element.querySelector('.markdown-table-scroll'), scroll = document.getElementById('chat-scroll');
        return {
          documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          chatFits: scroll.scrollWidth <= scroll.clientWidth,
          codeScrollsInside: !!pre && pre.scrollWidth > pre.clientWidth && getComputedStyle(pre).overflowX === 'auto',
          tableScrollsInside: !!table && table.scrollWidth > table.clientWidth && getComputedStyle(table).overflowX === 'auto'
        };
      });
      assert.ok(sizes.documentFits && sizes.chatFits, `Markdown overflow at ${width}px`);
      assert.ok(sizes.codeScrollsInside, `long code must scroll inside its block at ${width}px`); assert.ok(sizes.tableScrollsInside, `wide table must scroll inside its wrapper at ${width}px`);
      layout.push({ width, ...sizes });
      await answer.locator('h1').scrollIntoViewIfNeeded(); await shell.screenshot({ path: path.join(screenshots, `markdown-${width}.png`), fullPage: true });
      await answer.locator('.markdown-table-scroll').scrollIntoViewIfNeeded(); await shell.screenshot({ path: path.join(screenshots, `markdown-table-${width}.png`), fullPage: true });
    }
    await shell.setViewportSize({ width: 1280, height: 900 }); await shell.bringToFront();
    // Chromium treats chrome-extension origins as opaque for the CDP permission grant.
    // This isolated throwaway profile grants clipboard access globally for the real copy/read check.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await assistantMessages().last().locator('.chat-copy').click();
    const clipboard = await shell.evaluate(() => navigator.clipboard.readText());
    assert.equal(clipboard.replace(/\r\n/g, '\n'), CHAT_MARKDOWN, 'copy must preserve original Markdown apart from Windows clipboard newline normalization');
    await sendChat('格式确认，继续说明。'); assert.equal(count(), 2);
    const nextRequest = fixtures.getStats().requests[1].body.messages;
    assert.deepEqual(nextRequest.map(message => message.role), ['system', 'user', 'assistant', 'user']); assert.equal(nextRequest[2].content, CHAT_MARKDOWN);
    assert.equal(report.network.slice(initialNetwork).filter(request => request.method === 'GET').length, 0, 'Markdown must not load remote images or activate links');
    return { streamedUnclosedFence: true, renderedStructures: ['heading', 'strong', 'em', 'del', 'nested-list', 'ordered-list', 'quote', 'inline-code', 'fenced-code', 'table', 'link'], userTextLiteral: true, rawHtmlLiteral: true, unsafeLinksRemoved: true, imageRequests: 0, copyPreservesMarkdown: true, clipboardNewlinesNormalized: true, multiTurnPreservesMarkdown: true, layout };
  });
  await check('settings and research drafts remain mounted across tabs, and canceling clear preserves conversation before confirmed clear', async () => {
    const frame = await select('settings'), time = await frame.evaluate(() => performance.timeOrigin);
    await frame.locator('#model').fill('unsaved-model-draft'); await select('chat'); await select('settings');
    assert.equal(await settingsFrame.locator('#model').inputValue(), 'unsaved-model-draft'); assert.equal(await settingsFrame.evaluate(() => performance.timeOrigin), time); assert.equal((await settingsView()).settings.model, 'normal');
    await settingsFrame.locator('#model').fill('normal');
    const research = await select('research'), researchTime = await research.evaluate(() => performance.timeOrigin);
    await research.locator('#question').fill('尚未开始的研究草稿'); await research.locator('#urls').fill(fixtures.research.origin + '/river');
    await select('chat'); await select('research'); assert.equal(await researchFrame.locator('#question').inputValue(), '尚未开始的研究草稿'); assert.equal(await researchFrame.evaluate(() => performance.timeOrigin), researchTime);
    await select('chat'); const messages = await chatMessages().count(); await shell.locator('#chat-new').click(); await shell.locator('#chat-clear-dialog').waitFor({ state: 'visible' }); await shell.locator('#chat-clear-cancel').click(); assert.equal(await chatMessages().count(), messages);
    await clearChat(); assert.equal(await shell.locator('#chat-empty').isVisible(), true);
    return { settingsDraftPreserved: true, settingsCommittedOnlyOnSave: true, researchDraftPreserved: true, iframeReloads: 0, clearRequiresConfirmation: true };
  });
  await check('embedded research settings link selects the shell settings tab without new tabs or iframe navigation', async () => {
    const before = total(), initialTabs = await shell.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id).sort());
    const research = await select('research'), researchTime = await research.evaluate(() => performance.timeOrigin), researchUrl = research.url();
    await research.getByRole('link', { name: /配置模型与 Key/ }).click();
    await until(async () => await tabButton('settings').getAttribute('aria-selected') === 'true', 'research settings link did not navigate the shell');
    assert.equal(await shell.locator('#panel-settings').isVisible(), true); assert.equal(research.url(), researchUrl); assert.equal(await research.evaluate(() => performance.timeOrigin), researchTime);
    await select('research'); assert.equal(await researchFrame.evaluate(() => performance.timeOrigin), researchTime); assert.equal(await researchFrame.locator('#question').inputValue(), '尚未开始的研究草稿');
    assert.deepEqual(await shell.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id).sort()), initialTabs); assert.equal(total(), before); await select('chat');
    return { trustedLinkClicks: 1, shellSettingsSelected: true, newTabs: 0, iframeReloads: 0, researchDraftRetained: true, calls: 0 };
  });
  await check('stop aborts an actual streaming request and the canceled partial pair is excluded from the next request', async () => {
    await configure({ model: 'slow' }); fixtures.reset(); await sendChat('这个回答需要中途停止。', 'running');
    await until(async () => (await assistantMessages().last().locator('.chat-message-content').innerText()).length > 0, 'partial stream never rendered');
    await shell.locator('#chat-stop').click(); await until(async () => await assistantMessages().last().getAttribute('data-status') === 'cancelled', 'stop status not rendered');
    await until(() => fixtures.getStats().requests[0]?.aborted, 'chat transport not aborted'); assert.equal(count(), 1);
    await configure(); await sendChat('开始新问题。'); assert.equal(count(), 2); assert.deepEqual(fixtures.getStats().requests[1].body.messages.map(message => message.role), ['system', 'user']);
    assert.ok(!JSON.stringify(fixtures.getStats().requests[1].body.messages).includes('这个回答需要中途停止')); await clearChat();
    return { abortVerified: true, requestsBeforeStop: 1, canceledPairExcluded: true, autoRetry: false };
  });
  await check('over-budget chat is rejected before fetch and the full input remains available for editing', async () => {
    await configure({ budget: 2048 }); const before = total(); const longText = '预算测试内容'.repeat(800);
    await shell.locator('#chat-input').fill(longText); await shell.locator('#chat-send').click();
    await until(async () => /预算/.test(await shell.locator('#chat-feedback').innerText()), 'budget feedback unavailable'); assert.equal(total(), before);
    assert.equal(await shell.locator('#chat-input').inputValue(), longText); assert.equal(await chatMessages().count(), 0); await shell.locator('#chat-input').fill('');
    await clearChat(); await configure(); return { modelCalls: 0, noSilentTruncation: true, inputRetained: true };
  });
  await check('ordinary content with panel=1 cannot impersonate embedded settings, research, collection or chat or read private storage', async () => {
    const before = total(), source = await context.newPage(); await source.goto(fixtures.origin + '/article?panel=1');
    const tab = (await shell.evaluate(() => chrome.tabs.query({}))).find(tab => tab.url === source.url()); assert.ok(tab?.id);
    const results = await shell.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId }, func: async () => {
      const responses = await Promise.all(['settings:get', 'research:view', 'phrases:list'].map(type => chrome.runtime.sendMessage({ type, panel: 1 })));
      let storage; try { await chrome.storage.local.get(null); await chrome.storage.session.get(null); storage = true; } catch { storage = false; }
      const chat = await new Promise(resolve => { let connected; try { connected = chrome.runtime.connect({ name: 'chat' }); } catch { resolve({ disconnected: true, gotState: false }); return; } let gotState = false; connected.onMessage.addListener(() => { gotState = true; }); connected.onDisconnect.addListener(() => { void chrome.runtime.lastError; resolve({ disconnected: true, gotState }); }); connected.postMessage({ type: 'chat:status' }); setTimeout(() => { connected.disconnect(); resolve({ disconnected: false, gotState }); }, 800); });
      return { responses, storage, chat };
    } }), tab.id);
    const result = results[0].result; assert.ok(result.responses.every(response => response.ok === false && !response.settings && !response.reports && !response.entries)); assert.equal(result.storage, false); assert.deepEqual(result.chat, { disconnected: true, gotState: false }); assert.equal(total(), before);
    await source.close(); return { actualContentSender: true, forgedQueryRejected: true, privateStorageDenied: true, chatStateDenied: true, calls: 0 };
  });
  await check('embedded two-document research survives tab switches, yields three calls, and can save and download the verified report', async () => {
    await configure({ base: fixtures.research.origin }); fixtures.research.reset(); const frame = await select('research'), time = await frame.evaluate(() => performance.timeOrigin);
    await frame.locator('#question').fill('比较 RiverFlow 与 StreamJet 的背压机制和缓冲区大小。'); await frame.locator('#urls').fill(fixtures.research.origin + '/slow-river\n' + fixtures.research.origin + '/stream');
    await until(() => frame.locator('#start-research').isEnabled(), 'embedded research start unavailable'); await frame.locator('#start-research').click();
    await until(async () => ['reading', 'analyzing', 'synthesizing'].includes((await researchState())?.status), 'research not active');
    await select('chat'); await shell.locator('#chat-input').fill('研究运行时保留的聊天草稿'); await select('phrases'); await sleep(200); await select('research');
    assert.equal(await researchFrame.evaluate(() => performance.timeOrigin), time); assert.notEqual((await researchState()).status, 'cancelled');
    const task = await until(async () => { const value = await researchState(); return value && !['reading', 'analyzing', 'synthesizing'].includes(value.status) ? value : false; }, 'embedded research not completed', 30000);
    assert.equal(task.status, 'done', task.error); assert.equal(task.calls, 3); assert.equal(fixtures.research.getStats().count, 3); assert.deepEqual(task.sources.map(source => source.status), ['done', 'done']);
    assert.equal(task.sources[0].findings[0].quote, RIVER_QUOTE); assert.equal(task.sources[1].findings[0].quote, STREAM_QUOTE);
    await frame.locator('#refresh-reports').click(); await until(() => frame.locator('#save-report').isEnabled(), 'embedded save unavailable'); await frame.locator('#save-report').click();
    savedReport = await until(async () => (await researchView()).reports[0], 'embedded report not saved');
    const markdown = await downloadReport(); assert.ok(markdown.includes(RIVER_QUOTE)); assert.ok(markdown.includes(STREAM_QUOTE)); assert.ok(markdown.includes('|'));
    await select('chat'); assert.equal(await shell.locator('#chat-input').inputValue(), '研究运行时保留的聊天草稿'); await shell.locator('#chat-input').fill('');
    return { actualEmbeddedForms: true, sources: 2, modelCalls: 3, tabSwitchCancels: false, iframeReloads: 0, explicitSave: true, actualMarkdownDownload: true };
  });
  await check('a real chat request during active research completes without canceling either task on the shared configured endpoint', async () => {
    await configure({ base: fixtures.origin }); fixtures.reset(); fixtures.research.reset(); const research = await select('research'), time = await research.evaluate(() => performance.timeOrigin);
    const previousTask = (await researchState())?.id;
    await research.locator('#question').fill('同时研究 RiverFlow 与 StreamJet，并保留独立聊天。');
    await research.locator('#urls').fill(fixtures.research.origin + '/slow-river\n' + fixtures.research.origin + '/stream');
    await until(() => research.locator('#start-research').isEnabled(), 'concurrent research start unavailable'); await research.locator('#start-research').click();
    await until(async () => { const task = await researchState(); return task?.id !== previousTask && task?.status === 'reading'; }, 'slow source not being read');
    await sendChat('研究运行时，解释一下消费者拉取。'); assert.equal(count(), 1); assert.equal(await assistantMessages().last().getAttribute('data-status'), 'done');
    const whileChatDone = await researchState(); assert.ok(['reading', 'analyzing', 'synthesizing'].includes(whileChatDone.status), 'slow research should remain active while chat finishes');
    await select('research'); assert.equal(await researchFrame.evaluate(() => performance.timeOrigin), time);
    const task = await until(async () => { const value = await researchState(); return value && !['reading', 'analyzing', 'synthesizing'].includes(value.status) ? value : false; }, 'concurrent research did not complete', 30000);
    assert.equal(task.status, 'done', task.error); assert.equal(task.calls, 3); assert.equal(fixtures.research.getStats().count, 3); assert.equal(count(), 1);
    assert.deepEqual(task.sources.map(source => source.status), ['done', 'done']); assert.equal(task.sources[0].findings[0].quote, RIVER_QUOTE); assert.equal(task.sources[1].findings[0].quote, STREAM_QUOTE);
    assert.equal((await researchView()).reports.length, 1, 'concurrency verification must not create another saved report');
    return { realChatClick: true, chatCalls: 1, researchCalls: 3, bothCompleted: true, researchActiveAfterChat: true, sharedApiBase: fixtures.origin + '/v1', iframeReloads: 0, additionalSavedReports: 0 };
  });
  await check('all four tabs render without horizontal overflow at desktop, 390 and 320 widths', async () => {
    await screenshotTabs(1280, 'desktop'); await screenshotTabs(500, '500'); await screenshotTabs(390, '390'); await screenshotTabs(320, '320');
    await shell.setViewportSize({ width: 1280, height: 900 }); await select('chat'); return { widths: [1280, 500, 390, 320], tabs: 4, horizontalOverflow: false, actualEmbeddedRenders: true };
  });
  await check('session chat excludes Keys, closing its owner stops a stream, and no unexpected later request starts', async () => {
    await configure({ model: 'slow' }); const previous = fixtures.getStats().totalRequestsSinceStart; await sendChat('关闭侧栏时停止这一轮。', 'running'); await until(() => fixtures.getStats().totalRequestsSinceStart > previous, 'closing test request missing');
    const record = fixtures.getStats().requests.at(-1), before = total();
    const stored = await shell.evaluate(() => chrome.storage.session.get('chatSession')); assert.ok(!JSON.stringify(stored).includes(fakeKey));
    await shell.close(); shell = undefined; await until(() => record.aborted, 'closing owner did not abort model'); await sleep(300); assert.equal(total(), before);
    await openShell(); assert.equal(await tabButton('chat').getAttribute('aria-selected'), 'true'); return { ownerCloseAborts: true, sessionChatContainsKey: false, extraCalls: 0 };
  });
  const previousExtensionId = extensionId; await context.close(); context = undefined; await launch(testExtension); assert.equal(extensionId, previousExtensionId); await openShell();
  await check('same-profile browser restart clears session Key and chat but retains the locally saved research report', async () => {
    const before = total(); assert.equal(await chatMessages().count(), 0); assert.equal(await shell.locator('#chat-setup').isVisible(), true);
    await select('settings'); const view = await settingsView(); assert.equal(view.hasKey, false); const stored = await shell.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)])); assert.ok(!JSON.stringify(stored).includes(fakeKey));
    await select('research'); const research = await researchView(); assert.equal(research.reports.length, 1); assert.equal(research.reports[0].id, savedReport.id);
    await researchFrame.locator('#saved-reports .saved-card [data-action="view"]').first().click(); const text = await downloadReport(); assert.ok(text.includes(RIVER_QUOTE)); assert.equal(total(), before);
    return { sameProfile: true, sessionKeyCleared: true, sessionChatCleared: true, localReportRetained: true, offlineDownload: true, calls: 0 };
  });
  await check('all traffic stays on loopback and production plus restored test-copy build bytes remain identical', async () => {
    assert.ok(report.network.every(request => ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname))); assert.deepEqual(await hashDirectory(productionDirectory), testedFiles); assert.deepEqual(await hashDirectory(testExtension), testedFiles);
    return { externalRequests: 0, productionBytesUnchanged: true, realModelVerified: false };
  });
} catch (error) { fatal = error; report.fatal = error.message; process.stdout.write(`FATAL ${error.message}\n`); }
finally {
  if (context) await context.close().catch(() => {}); await fixtures.close();
  const after = await hashDirectory(productionDirectory); report.testedBuild.unchangedAfterTest = JSON.stringify(after) === JSON.stringify(testedFiles);
  if (!report.testedBuild.unchangedAfterTest) { report.fatal = 'Production dist changed during sidebar test'; fatal ??= new Error(report.fatal); }
  report.passed = report.checks.filter(check => check.result === 'pass').length; report.failed = report.checks.filter(check => check.result === 'fail').length;
  const passed = fragment => report.checks.some(check => check.result === 'pass' && check.name.includes(fragment));
  report.coverage = {
    twoProviderConnectionSave: passed('actual settings switches an OAuth model'),
    nativeSidePanelConfiguration: passed('manifest declares'), defaultChatAndFourTabs: passed('manifest declares'), shellTabRendering: passed('all four tabs'), embeddedSettingsSave: passed('embedded settings saves'),
    zeroCallsOnNavigationAndSave: passed('embedded settings saves') && passed('chat model HTML'), trustedChatClicks: passed('chat uses trusted'), multiTurnAssistantRole: passed('chat uses trusted'),
    safeHtmlAndCopy: passed('chat model HTML'), markdownRenderingAndSafety: passed('Markdown answers render'), retainedDraftsAndFrames: passed('settings and research drafts'), confirmedClear: passed('settings and research drafts'),
    embeddedSettingsLinkNavigation: passed('embedded research settings link'), concurrentChatAndResearch: passed('a real chat request during active research'),
    stopAbortsAndExcludesPartial: passed('stop aborts an actual'), overBudgetZeroCalls: passed('over-budget chat'), actualContentSenderIsolation: passed('ordinary content with panel=1'),
    embeddedResearchTwoPagesThreeCalls: passed('embedded two-document'), tabSwitchKeepsResearch: passed('embedded two-document'), embeddedReportSaveAndDownload: passed('embedded two-document'),
    narrow390And320: passed('all four tabs'), ownerCloseAborts: passed('session chat excludes'), keyIsolationAndSessionCleared: passed('same-profile browser restart') && passed('embedded settings saves'),
    localReportPersists: passed('same-profile browser restart'), productionBytesUnchanged: passed('all traffic stays') && report.testedBuild.unchangedAfterTest
  };
  report.screenshots = (await fs.readdir(screenshots)).filter(name => name.endsWith('.png')).map(name => `test-results/sidebar-${version}/${name}`);
  await fs.writeFile(path.join(output, `sidebar-e2e-report-${version}.json`), JSON.stringify(report, null, 2) + '\n');
  assertTestDirectory(profile); await fs.rm(profile, { recursive: true, force: true });
  process.stdout.write(`Mock sidebar ${version} e2e: ${report.passed} passed, ${report.failed} failed. Native toolbar click and real model quality remain unverified.\n`);
  if (fatal || report.failed) process.exitCode = 1;
}

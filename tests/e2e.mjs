import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from './fixtures/server.mjs';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results');
await fs.mkdir(output, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  for (const directory of ['.cache/ms-playwright', '.browsers']) {
    const candidate = path.join(root, directory);
    try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; break; } } catch {}
  }
}
const { chromium } = await import('playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 12_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await sleep(75);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}

const fixtures = await startFixtures();
const profile = await fs.mkdtemp(path.join(output, 'profile-'));
function assertTestDirectory(directory) {
  const resolved = path.resolve(directory);
  const permitted = path.resolve(output);
  assert.ok(resolved !== permitted && resolved.startsWith(`${permitted}${path.sep}`), 'refusing to clean a directory outside test-results');
}
assertTestDirectory(profile);
const fakeKey = 'm1-local-mock-key-do-not-use-with-real-service';
const focus = process.env.E2E_FOCUS || '';
const reportFile = focus ? `e2e-focus-${focus}.json` : 'e2e-report.json';
const report = { mockOnly: true, realModelVerified: false, focus: focus || 'full', date: new Date().toISOString(), fixtureOrigin: fixtures.origin, checks: [], network: [], notes: [] };
report.extensionVersion = JSON.parse(await fs.readFile(path.join(root, 'dist/manifest.json'), 'utf8')).version;
const testedFiles = await hashDirectory(path.join(root, 'dist'));
report.testedBuild = { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false };
let context;
let options;
let source;
let worker;
let preview;
let id;
let fatal;
const panel = page => page.locator('local-reader-preview');
const action = (page, name) => panel(page).locator(`[data-reader-action="${name}"]`);
const status = page => panel(page).locator('.status');
const summary = page => panel(page).locator('[data-reader-output]');
const count = () => fixtures.getStats().count;
const lastRequest = () => fixtures.getStats().requests.at(-1);

async function check(name, fn) {
  if (focus === 'reuse' && !/initial permission boundary|settings and mock connection test|automatic summary once|same URL/.test(name)) {
    report.checks.push({ name, result: 'skipped' });
    return;
  }
  const start = Date.now();
  const requestsBefore = fixtures.getStats().totalRequestsSinceStart;
  try {
    const evidence = await fn();
    const requestsAfter = fixtures.getStats().totalRequestsSinceStart;
    report.checks.push({ name, result: 'pass', milliseconds: Date.now() - start, requestsBefore, requestsAfter, newRequests: requestsAfter - requestsBefore, ...(evidence ? { evidence } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    const requestsAfter = fixtures.getStats().totalRequestsSinceStart;
    report.checks.push({ name, result: 'fail', milliseconds: Date.now() - start, requestsBefore, requestsAfter, newRequests: requestsAfter - requestsBefore, error: error.message });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    if (preview && !preview.isClosed()) await preview.screenshot({ path: path.join(output, `failure-${report.checks.length}.png`) }).catch(() => {});
  }
}

async function settings({ model = 'normal', remember = false, key, budget = 16000, autoLong = false, baseUrl = `${fixtures.origin}/v1` } = {}) {
  await options.bringToFront();
  await until(() => options.locator('#save-settings').isEnabled(), 'settings not ready');
  await options.locator('#base-url').fill(baseUrl);
  await options.locator('#model').fill(model);
  await options.locator('#remember-key').setChecked(remember);
  await options.locator('#input-budget').fill(String(budget));
  await options.locator('#auto-long-summary').setChecked(autoLong);
  if (key !== undefined) await options.locator('#api-key').fill(key);
  await options.locator('#save-settings').click();
  await until(async () => {
    if (!await options.locator('#save-settings').isEnabled()) return false;
    const current = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }));
    return current.ok && current.settings.model === model && current.settings.autoLongSummary === autoLong && current.settings.rememberKey === remember;
  }, 'settings were not saved');
}

async function targetFrame() {
  const handle = await panel(source).locator('iframe').elementHandle();
  return handle?.contentFrame();
}
async function drag(linkId, expectedPath, { ready = true, hold = false } = {}) {
  await source.bringToFront();
  const anchor = source.locator('#' + linkId);
  await anchor.scrollIntoViewIfNeeded();
  const from = await anchor.boundingBox();
  assert.ok(from, 'source link missing');
  const startX = from.x + Math.min(40, from.width / 3), startY = from.y + from.height / 2;
  await source.mouse.move(startX, startY);
  await source.mouse.down();
  await source.mouse.move(startX + 65, startY + 22, { steps: 14 });
  await panel(source).waitFor({ state: 'visible', timeout: 5000 });
  await until(async () => (await panel(source).locator('iframe').getAttribute('src'))?.includes(expectedPath), 'inline iframe target was not assigned');
  preview = source;
  if (!hold) await source.mouse.up();
  if (ready) await until(async () => await panel(source).locator('.page-status').getAttribute('data-state') === 'ready', 'target frame is not readable', 18000);
  return targetFrame();
}

async function complete(page = preview, timeout = 12_000) {
  await until(async () => ['done', 'error', 'cancelled', 'interrupted'].includes(await status(page).getAttribute('data-phase')), 'summary did not finish', timeout);
  assert.equal(await status(page).getAttribute('data-phase'), 'done', await status(page).innerText());
  return summary(page).innerText();
}

async function generate({ force = false, timeout } = {}) {
  await action(preview, force ? 'reread' : 'summarize').click();
  // Reconnecting after an interrupted worker awaits page:hello before the UI
  // can leave its previous terminal state. Do not mistake that old state for
  // the result of the newly requested generation.
  await until(async () => await status(preview).getAttribute('data-phase') !== 'interrupted', 'retry never reconnected');
  return complete(preview, timeout);
}

try {
  await fs.access(path.join(root, 'dist/manifest.json'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`, '--no-first-run'],
  });
  context.setDefaultTimeout(8_000);
  context.on('request', request => { if (request.url().startsWith('http')) report.network.push({ method: request.method(), url: request.url() }); });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  id = new URL(worker.url()).hostname;
  report.browser = await context.browser().version();
  report.extensionId = id;
  options = context.pages().find(page => page.url() === `chrome-extension://${id}/options.html`) || await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await until(() => options.locator('#save-settings').isEnabled(), 'settings page did not initialize');
  source = await context.newPage();
  await source.goto(`${fixtures.origin}/index`);

  await check('M1-15 initial permission boundary', async () => {
    assert.equal(await options.evaluate(() => chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })), true);
    assert.equal(await source.locator('local-reader-preview').count(), 0);
    assert.equal(count(), 0);
    return 'Fresh profile has website access and makes no model requests.';
  });

  if (focus === 'reuse') {
    await worker.evaluate(() => {
      const trace = [];
      self.__m1ReuseTrace = trace;
      const record = entry => { trace.push({ at: Date.now(), ...entry }); if (trace.length > 1500) trace.shift(); };
      chrome.runtime.onMessage.addListener((message, sender) => {
        record({ event: 'runtime', type: message?.type, documentId: sender.documentId, tabId: sender.tab?.id, url: sender.url });
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes.preview) record({ event: 'preview-storage', preview: changes.preview.newValue });
      });
      chrome.tabs.onUpdated.addListener((tabId, info) => { record({ event: 'tab-update', tabId, status: info.status, url: info.url }); });
      chrome.runtime.onConnect.addListener(port => {
        const documentId = port.sender?.documentId;
        record({ event: 'port-connect', documentId, tabId: port.sender?.tab?.id });
        const post = port.postMessage.bind(port);
        port.postMessage = message => {
          record({ event: 'port-out', documentId, type: message.type, autoSummary: message.autoSummary, revision: message.revision, status: message.status, requestId: message.requestId, textLength: message.text?.length });
          post(message);
        };
        port.onMessage.addListener(message => { record({ event: 'port-in', documentId, type: message.type, automatic: message.automatic }); });
        port.onDisconnect.addListener(() => { record({ event: 'port-disconnect', documentId }); });
      });
    });
  }

  await check('M1-01 inline real page preview without API credentials', async () => {
    fixtures.reset(); const frame = await drag('article-a', '/article-a');
    assert.match(await frame.locator('article').innerText(), /ARTICLE_A_SENTINEL/);
    await until(async () => await status(source).getAttribute('data-phase') === 'error', 'configuration error absent');
    assert.match(await status(source).innerText(), /配置|设置|Key|模型|接口/); assert.equal(count(), 0);
    await action(source, 'close').click(); await panel(source).waitFor({state:'detached'});
  });
  await check('M1-01 settings and mock connection test', async () => {
    await settings({key:fakeKey}); fixtures.reset();
    await options.locator('#test-connection').click();
    await until(async () => (await options.locator('#test-text').innerText()).includes('CONNECTION_TEST'), 'mock connection failed');
    assert.equal(count(),1); assert.equal(lastRequest().authPresent,true); assert.equal(lastRequest().body.store,false);
    report.connectionTestRequests=count();
    await options.screenshot({path:path.join(output,'settings-desktop.png'),fullPage:true});
    await options.setViewportSize({width:390,height:844});
    await options.screenshot({path:path.join(output,'settings-mobile.png'),fullPage:true});
    assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1),true);
    await options.setViewportSize({width:1280,height:900});
    return 'Mock credentials only; no actual model service was contacted.';
  });
  await check('M1-02 ordinary click and text selection keep native behavior', async () => {
    await source.bringToFront(); const next=context.waitForEvent('page'); await source.locator('#ordinary').click();
    const page=await next; await page.waitForLoadState(); assert.ok(page.url().endsWith('/article-a')); await page.close();
    await source.locator('h1').selectText(); assert.ok(await source.evaluate(() => getSelection().toString().length>0));
    assert.equal(await panel(source).count(),0); await source.evaluate(() => getSelection().removeAllRanges());
  });
  await check('M1-02/03 drag appears before mouseup and creates no windows', async () => {
    fixtures.reset(); await source.evaluate(() => scrollTo(0,880));
    const before=await source.evaluate(() => scrollY); const windows=await options.evaluate(() => chrome.windows.getAll());
    const started=Date.now(); const frame=await drag('article-a','/article-a',{hold:true});
    assert.equal(await panel(source).isVisible(),true); report.firstPreviewMilliseconds=Date.now()-started;
    assert.equal((await options.evaluate(() => chrome.windows.getAll())).length,windows.length);
    assert.equal(context.pages().filter(page => !page.isClosed() && page.url().includes('/article-a')).length,0);
    await source.mouse.up(); await complete();
    assert.equal(count(),1);
    await action(source,'reread').evaluate(node=>node.click()); await sleep(200);
    assert.equal(count(),1,'untrusted page-script button click started another model call');
    assert.equal(source.url(),fixtures.origin+'/index'); assert.ok(Math.abs(await source.evaluate(() => scrollY)-before)<=2);
    assert.match(await frame.locator('article').innerText(),/ARTICLE_A_SENTINEL/);
    assert.equal(await panel(source).locator('iframe').getAttribute('sandbox'),'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
    return {visibleBeforeMouseup:true,extraWindows:0,sourceScrollDelta:await source.evaluate(() => scrollY)-before};
  });
  await check('M1-UI hover including iframe blurs source and leave restores', async () => {
    await panel(source).locator('iframe').hover(); await sleep(250);
    assert.equal(await panel(source).locator('.scrim').evaluate(node => node.classList.contains('active')),true);
    assert.equal(await panel(source).locator('.scrim').evaluate(node => getComputedStyle(node).pointerEvents),'none');
    assert.match(await panel(source).locator('.scrim').evaluate(node => getComputedStyle(node).backdropFilter),/blur\(5px\)/);
    await source.screenshot({path:path.join(output,'inline-hover.png')});
    await source.mouse.move(15,15); await sleep(220);
    assert.equal(await panel(source).locator('.scrim').evaluate(node => node.classList.contains('active')),false);
  });
  await check('M1-05/07/08 explicit refresh and visible streaming', async () => {
    const before=count(); await action(source,'reread').click();
    await until(async () => (await summary(source).innerText()).includes('ARTICLE_A_SENTINEL'),'first stream text absent');
    assert.ok(!(await summary(source).innerText()).includes('仅验证扩展流程'));
    assert.match(await complete(),/ARTICLE_A_SENTINEL/); assert.equal(count(),before+1);
    assert.doesNotMatch(JSON.stringify(lastRequest().body),/ARTICLE_B_SENTINEL/);
    assert.match(JSON.stringify(lastRequest().body),/const controller/);
    await action(source,'copy').click(); await source.screenshot({path:path.join(output,'inline-summary.png')});
    await action(source,'collapse').click(); assert.equal(await panel(source).locator('.content').isVisible(),false);
    await action(source,'collapse').click();
  });
  await check('M1-UI narrow actual extension panel keeps close visible', async () => {
    await source.setViewportSize({width:390,height:844});
    const bounds=await panel(source).locator('.panel').evaluate(node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
    assert.ok(bounds.left>=0 && bounds.right<=bounds.width && bounds.top>=0 && bounds.bottom<=bounds.height);
    assert.equal(await action(source,'close').isVisible(),true);
    await source.screenshot({path:path.join(output,'inline-narrow.png')});
    await source.setViewportSize({width:1280,height:900});
    return bounds;
  });
  await check('M1-12 duplicate clicks cache and explicit refresh', async () => {
    const before=count(); await generate(); assert.equal(count(),before);
    assert.match(await panel(source).locator('.plan-text').innerText(),/缓存.*不产生模型调用/);
    await drag('article-a','/article-a'); await complete(); assert.equal(count(),before);
    await action(source,'reread').click(); await action(source,'summarize').evaluate(node => node.click());
    await complete(); assert.equal(count(),before+1);
  });
  await check('M1-04 XFO-only target loads through limited frame rule', async () => {
    const frame=await drag('xfo','/xfo'); assert.match(await frame.locator('article').innerText(),/ARTICLE_A_SENTINEL/);
    assert.equal((await fetch(fixtures.origin+'/xfo')).headers.get('x-frame-options'),'DENY'); await complete();
    const rules=await options.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    assert.equal(rules.length,1); assert.equal(rules[0].condition.tabIds.length,1);
    assert.deepEqual(rules[0].condition.requestDomains,['127.0.0.1']);
    assert.deepEqual(rules[0].condition.initiatorDomains,['127.0.0.1']);
    assert.ok(rules[0].action.responseHeaders.every(header => header.header.toLowerCase()==='x-frame-options'));
  });
  await check('M1-04 CSP refusal keeps error and ordinary tab entry', async () => {
    fixtures.reset(); await drag('deny','/deny',{ready:false});
    await until(async () => await panel(source).locator('.page-status').getAttribute('data-state')==='error','CSP error missing');
    assert.equal(count(),0); assert.match(await panel(source).locator('.page-status').innerText(),/CSP|策略|嵌入/);
    const next=context.waitForEvent('page'); await action(source,'open-tab').click(); const page=await next;
    await page.waitForLoadState(); assert.match(await page.locator('article').innerText(),/ARTICLE_A_SENTINEL/); await page.close();
    await panel(source).waitFor({state:'detached'});
  });
  await check('M1-03 close preserves source URL and scroll', async () => {
    await drag('article-a','/article-a'); const before=await source.evaluate(() => scrollY);
    await action(source,'close').click(); await panel(source).waitFor({state:'detached'});
    assert.equal(source.url(),fixtures.origin+'/index'); assert.ok(Math.abs(await source.evaluate(() => scrollY)-before)<=2);
  });
  await check('M1-06 automatic summary once per new link preview', async () => {
    await settings(); fixtures.reset(); await drag('article-b','/article-b');
    assert.match(await complete(),/ARTICLE_B_SENTINEL/); assert.equal(count(),1);
    await sleep(900); assert.equal(count(),1);
  });
  await check('M1-06 same URL automatic preview repeats without stale state', async () => {
    await settings(); fixtures.reset();
    for(let i=0;i<3;i++){await options.evaluate(() => chrome.runtime.sendMessage({type:'settings:clear-cache'})); await drag('article-a','/article-a'); assert.match(await complete(),/ARTICLE_A_SENTINEL/); assert.equal(count(),i+1);}
  });
  await check('M1-09 A B isolation in a single source float', async () => {
    await settings({model:'slow'}); fixtures.reset(); await drag('article-a','/article-a');
    await until(() => count()===1,'A call absent'); await drag('article-b','/article-b');
    const text=await complete(); assert.match(text,/ARTICLE_B_SENTINEL/); assert.doesNotMatch(text,/ARTICLE_A_SENTINEL/);
    assert.equal(count(),2); assert.equal(fixtures.getStats().requests[0].aborted,true); assert.equal(await panel(source).count(),1);
  });
  await check('M1-08 stop and close abort clients', async () => {
    await settings({model:'slow'}); fixtures.reset(); await drag('article-a','/article-a');
    await until(() => count()===1,'call absent'); await action(source,'stop').click(); const text=await summary(source).innerText();
    await sleep(3700); assert.equal(await summary(source).innerText(),text); assert.equal(lastRequest().aborted,true);
    await action(source,'summarize').click(); await until(() => count()===2,'retry absent'); await action(source,'close').click();
    await until(() => lastRequest().aborted,'close did not abort'); await panel(source).waitFor({state:'detached'});
  });
  await check('M1-LONG confirmation whole text tail survives section and merge', async () => {
    await settings({budget:4096}); fixtures.reset(); await drag('long','/long');
    await until(async () => await status(source).getAttribute('data-phase')==='confirming','long confirmation absent');
    assert.equal(count(),0); assert.match(await panel(source).locator('.plan-text').innerText(),/次模型调用/);
    const plannedSections=Number((await panel(source).locator('.plan-text').innerText()).match(/分为 (\d+) 节/)?.[1]);
    await source.screenshot({path:path.join(output,'long-confirmation.png')});
    const progressLabels=new Set();
    const progressTimer=setInterval(async()=>{try{progressLabels.add(await status(source).innerText());}catch{}},50);
    try { await action(source,'confirm-sections').click(); assert.match(await complete(source,60000),/LONG_ARTICLE_END_SENTINEL/); }
    finally { clearInterval(progressTimer); }
    assert.ok([...progressLabels].some(text=>text.includes(' / '+plannedSections+' 节')), 'section progress count was not visible');
    assert.ok([...progressLabels].some(text=>text.includes('整合')), 'merge progress was not visible');
    const calls=fixtures.getStats().requests; assert.ok(calls.length>1);
    assert.ok(calls.some(call => call.stage==='section' && call.markerInputs.includes('LONG_ARTICLE_END_SENTINEL')));
    assert.ok(calls.at(-1).stage==='merge' && calls.at(-1).markerInputs.includes('LONG_ARTICLE_END_SENTINEL'));
    assert.ok(calls.map(call=>call.body.messages[1].content).join('').length>24000);
    await source.screenshot({path:path.join(output,'long-summary.png')});
    return {requests:calls.length,sectionRequests:calls.filter(call=>call.stage==='section').length,tailReachedFinalMerge:true,progressLabels:[...progressLabels]};
  });
  await check('M1-LONG outside article lead remains metadata', async () => {
    await settings(); fixtures.reset(); await drag('lead','/lead'); await complete();
    assert.match(lastRequest().body.messages[1].content,/LEAD_OUTSIDE_SENTINEL/);
    assert.match(lastRequest().body.messages[1].content,/ARTICLE_A_SENTINEL/);
  });
  await check('M1-LONG resource limit rejects instead of truncating', async () => {
    fixtures.reset(); await drag('resource','/resource');
    await until(async () => await status(source).getAttribute('data-phase')==='error','resource error absent');
    assert.match(await status(source).innerText(),/300,000|上限/); assert.equal(count(),0);
  });
  await check('M1-10 iframe navigation clears old summary without automatic traversal', async () => {
    await settings(); fixtures.reset(); const frame=await drag('article-a','/article-a'); await complete(); const before=count();
    await frame.locator('#next-article').click(); await frame.waitForURL('**/article-b'); await sleep(1000);
    assert.equal(await summary(source).innerText(),''); assert.equal(count(),before); assert.match(await generate(),/ARTICLE_B_SENTINEL/);
  });
  await check('M1-10 dynamic DOM waits and can reread', async () => {
    await settings(); fixtures.reset(); const frame=await drag('dynamic','/dynamic');
    await frame.getByRole('heading',{name:'Dynamic content is ready'}).waitFor(); assert.match(await generate({force:true}),/DYNAMIC_ARTICLE_SENTINEL/);
  });
  await check('M1-11 login and empty body never call model', async () => {
    await settings(); fixtures.reset(); await drag('login','/login');
    await until(async () => await status(source).getAttribute('data-phase')==='error','login error absent'); assert.equal(count(),0);
    assert.match(await status(source).innerText(),/登录|验证/);
    await drag('empty','/empty'); await until(async () => await status(source).getAttribute('data-phase')==='error','empty error absent'); assert.equal(count(),0);
  });
  for(const [model,expected] of [['401',/401|403|Key/],['429',/429|受限/],['missing-model',/404|模型/],['incompatible',/格式|兼容/],['redirect',/网络|重定向/]]){
    await check('M1-11 actionable '+model+' without retries',async()=>{
      await settings({model}); fixtures.reset(); const frame=await drag('article-a','/article-a');
      await until(async()=>await status(source).getAttribute('data-phase')==='error','error absent'); assert.match(await status(source).innerText(),expected);
      await sleep(250); assert.equal(count(),1); assert.match(await frame.locator('article').innerText(),/ARTICLE_A_SENTINEL/);
    });
  }
  await check('M1-11 response headers timeout after 25 seconds',async()=>{
    await settings({model:'timeout'}); fixtures.reset(); await drag('article-a','/article-a');
    await until(async()=>await status(source).getAttribute('data-phase')==='error','timeout absent',30000);
    assert.match(await status(source).innerText(),/超时|25/); assert.equal(count(),1); assert.equal(lastRequest().aborted,true);
  });
  await check('M1-08 silent 45 seconds survives worker idle boundary',async()=>{
    await settings({model:'silent'}); fixtures.reset(); await drag('article-a','/article-a');
    assert.match(await complete(source,55000),/ARTICLE_A_SENTINEL/); assert.equal(count(),1); assert.ok(Date.now()-lastRequest().startedAt>=45000);
    return 'Headers immediately; first SSE byte after 45 seconds; no background DevTools opened.';
  });
  await check('M1-11 forced worker stop requires manual retry',async()=>{
    await settings({model:'slow'}); fixtures.reset(); await drag('article-a','/article-a'); await until(()=>count()===1,'call absent');
    const cdp=await context.newCDPSession(options); await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); await cdp.detach();
    await until(async()=>await status(source).getAttribute('data-phase')==='interrupted','interruption absent'); await sleep(350); assert.equal(count(),1); assert.equal(lastRequest().aborted,true);
    assert.match(await generate(),/ARTICLE_A_SENTINEL/); assert.equal(count(),2);
    worker=await until(()=>context.serviceWorkers().find(item=>item.url().includes(id)),'worker recovery absent');
  });
  await check('M1-12 API base and Key changes invalidate cache',async()=>{
    await settings(); fixtures.reset(); await drag('article-a','/article-a'); await complete();
    await settings({baseUrl:fixtures.origin+'/second/v1'}); await drag('article-a','/article-a'); await complete(); assert.equal(count(),2);
    await settings({key:fakeKey+'-changed'}); await drag('article-a','/article-a'); await complete(); assert.equal(count(),3); await settings({key:fakeKey});
  });
  await check('M1-13/14 Key DOM storage and network boundaries',async()=>{
    await settings(); const exported=await options.evaluate(()=>chrome.runtime.sendMessage({type:'settings:export'})); assert.ok(!JSON.stringify(exported).includes(fakeKey));
    const dom=await source.evaluate(()=>document.documentElement.outerHTML+[...document.querySelectorAll('*')].map(node=>node.shadowRoot?.innerHTML||'').join(''));
    assert.ok(!dom.includes(fakeKey)); const frame=await targetFrame(); assert.ok(!(await frame.content()).includes(fakeKey));
    const data=await options.evaluate(()=>Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null),chrome.storage.sync.get(null)]));
    assert.ok(!JSON.stringify(data[0]).includes(fakeKey)); assert.ok(JSON.stringify(data[1]).includes(fakeKey)); assert.deepEqual(data[2],{});
    const tabId=await options.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url)?.id,source.url());
    const reads=await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId,allFrames:true},func:async()=>{try{await chrome.storage.local.get(null);return true;}catch{return false;}}}),tabId);
    assert.ok(reads.every(entry=>entry.result===false)); assert.ok(report.network.every(req=>['localhost','127.0.0.1'].includes(new URL(req.url).hostname)));
  });
  await check('M1-10 source navigation aborts and never restores hidden generation',async()=>{
    await settings({model:'slow'}); fixtures.reset(); await drag('article-a','/article-a'); await until(()=>count()===1,'call absent');
    await source.goto(fixtures.origin+'/index?navigation=1'); await until(()=>lastRequest().aborted,'source nav did not abort'); assert.equal(await panel(source).count(),0); await sleep(700); assert.equal(count(),1);
    await source.goto(fixtures.origin+'/index');
  });
  await check('M1-15 redirect to ungranted final origin makes no model call',async()=>{
    await settings();
    const manager = await context.newPage(); await manager.goto('chrome://extensions');
    await manager.evaluate(async id => {
      await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess: 'ON_CLICK' });
      await chrome.developerPrivate.addHostPermission(id, 'http://127.0.0.1/*');
    }, id);
    await manager.close(); await sleep(500);
    fixtures.reset(); await drag('redirect','/redirect',{ready:false});
    const finalFrame=await targetFrame(); await until(()=>finalFrame.url().includes('localhost:4317/article-b'),'redirect final page did not load');
    assert.match(await finalFrame.locator('article').innerText(),/ARTICLE_B_SENTINEL/);
    await sleep(700); assert.equal(count(),0);
    const data=await options.evaluate(()=>chrome.runtime.sendMessage({type:'settings:get'})); assert.ok(!data.permissions.includes('http://localhost/*'));
    await until(async()=>await panel(source).locator('.page-status').getAttribute('data-state')==='error','missing final-origin status',15000);
    assert.equal((await options.evaluate(()=>chrome.windows.getAll())).filter(win=>win.type==='popup').length,0);
  });
  await check('M1-15 revocation disables previously injected source drag',async()=>{
    const manager = await context.newPage(); await manager.goto('chrome://extensions');
    await manager.evaluate(id => chrome.developerPrivate.removeHostPermission(id, 'http://127.0.0.1/*'), id);
    await manager.close(); await sleep(500); fixtures.reset();
    await source.bringToFront(); const link=source.locator('#article-a'); await link.scrollIntoViewIfNeeded();const box=await link.boundingBox();
    await source.mouse.move(box.x+25,box.y+10);await source.mouse.down();await source.mouse.move(box.x+100,box.y+35,{steps:12});await source.mouse.up();
    assert.equal(await panel(source).count(),0);assert.equal(count(),0);
  });
  const restartBrowser = async () => {
    await context.close();
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`, '--no-first-run'],
    });
    context.setDefaultTimeout(8_000);
    options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await until(() => options.locator('#save-settings').isEnabled(), 'settings after restart did not initialize');
  };

  await check('M1-13/16 browser restart clears session Key and retains the long-summary setting', async () => {
    await settings({ autoLong: true, key: fakeKey });
    await restartBrowser();
    const view = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }));
    assert.equal(view.hasKey, false);
    assert.equal(view.settings.autoLongSummary, true);
    assert.equal(view.settings.rememberKey, false);
    assert.equal(await options.locator('#auto-long-summary').isChecked(), true);
    const storage = await options.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]));
    assert.ok(!JSON.stringify(storage).includes(fakeKey));
    return 'Same persistent browser profile restarted; session Key disappeared and long-summary switch stayed enabled.';
  });

  await check('M1-13 remembered local Key survives restart and can be cleared', async () => {
    await settings({ remember: true, key: fakeKey });
    await restartBrowser();
    let view = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }));
    assert.equal(view.hasKey, true);
    assert.equal(view.settings.rememberKey, true);
    const local = await options.evaluate(() => chrome.storage.local.get(null));
    assert.ok(JSON.stringify(local).includes(fakeKey));
    await options.locator('#clear-key').click();
    await until(async () => !(await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }))).hasKey, 'Key clear did not finish');
    view = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:export' }));
    assert.ok(!JSON.stringify(view).includes(fakeKey));
  });

  report.notes.push('Real Chrome, real provider, real technical/foreign articles, native installation confirmation and native context menu/tab-strip actions remain explicitly pending manual acceptance.');
} catch (error) {
  fatal = error;
  report.fatal = error.message;
  process.stdout.write(`FATAL ${error.message}\n`);
} finally {
  if (focus === 'reuse' && worker) {
    const trace = await worker.evaluate(() => self.__m1ReuseTrace || []).catch(() => []);
    await fs.writeFile(path.join(output, 'e2e-reuse-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  }
  if (context) await context.close().catch(() => {});
  await fixtures.close();
  try {
    assert.deepEqual(await hashDirectory(path.join(root, 'dist')), testedFiles, 'Build changed during browser testing');
    report.testedBuild.unchangedAfterTest = true;
  } catch (error) {
    fatal = error;
    report.fatal = error.message;
  }
  assertTestDirectory(profile);
  await fs.rm(profile, { recursive: true, force: true });
  report.passed = report.checks.filter(check => check.result === 'pass').length;
  report.failed = report.checks.filter(check => check.result === 'fail').length;
  await fs.writeFile(path.join(output, reportFile), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Mock e2e: ${report.passed} passed, ${report.failed} failed. Report: test-results/${reportFile}\n`);
  if (fatal || report.failed) process.exitCode = 1;
}

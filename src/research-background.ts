import { allowedUrl, MAX_TEXT } from './core';
import { readConfig, secureStorage } from './store';
import { trustedPage } from './trusted-page';
import type { Article } from './shared';
import { analyzeResearchSource, synthesizeResearch } from './research-model';
import { listResearchReports, saveResearchReport, deleteResearchReport } from './research-store';
import { MAX_RESEARCH_CALLS, RESEARCH_PORT, researchActive, researchInput, type ResearchTask, type ResearchSource } from './research-shared';

interface OwnedTab { id: number; url: string }
interface Job { state: ResearchTask; controller: AbortController; owner: string; tab?: OwnedTab; documentId?: string; timer?: ReturnType<typeof setTimeout> }
let latest: ResearchTask | undefined;
let job: Job | undefined;
let epoch = 0;
let initialized = false;
let writes: Promise<unknown> = Promise.resolve();
let starts: Promise<unknown> = Promise.resolve();
let configurationReady = async (): Promise<unknown> => undefined;
let beforeRequest = () => {};
const SESSION_KEY = 'researchTask';
const closedOwners = new Set<string>();
const safeError = (error: unknown) => error instanceof Error ? error.message : '研究未完成，请重试。';
const owner = (sender: chrome.runtime.MessageSender) => sender.documentId ?? `page:${sender.tab?.id ?? 'extension'}`;
const trusted = (sender: chrome.runtime.MessageSender) => trustedPage(sender, 'research.html');
async function permitted(url: string) { return chrome.permissions.contains({ origins: [allowedUrl(url).origin + '/*'] }); }

function persist(): Promise<unknown> {
  const value = latest ? structuredClone({ task: latest, ...(job?.tab ? { tab: job.tab } : {}) }) : undefined;
  const next = writes.then(() => value ? chrome.storage.session.set({ [SESSION_KEY]: value }) : chrome.storage.session.remove(SESSION_KEY));
  writes = next.catch(() => {}); return next;
}
function current(active: Job): void {
  if (job !== active || active.controller.signal.aborted || !researchActive(active.state)) throw new DOMException('Aborted', 'AbortError');
}
async function closeTab(active: Job): Promise<void> {
  const tab = active.tab; active.tab = undefined; active.documentId = undefined;
  if (!tab) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'research:cancel', requestId: active.state.id }).catch(() => {});
  // The tab was created for this task. Keep it if the user navigated it elsewhere.
  try { const actual = await chrome.tabs.get(tab.id); if (actual.url === tab.url || actual.pendingUrl === tab.url) await chrome.tabs.remove(tab.id); } catch { /* Already closed. */ }
}
export function hasActiveResearch(): boolean {
  return researchActive(latest);
}
export function cancelResearch(reason = '已停止研究，已完成的来源证据保留。'): void {
  ++epoch;
  const active = job;
  if (!active || !researchActive(active.state)) return;
  active.controller.abort(); clearTimeout(active.timer);
  active.state.status = 'cancelled'; active.state.stage = '任务已停止'; active.state.error = reason; active.state.updatedAt = Date.now();
  for (const source of active.state.sources) if (source.status !== 'done' && source.status !== 'error') { source.status = 'error'; source.error = '任务停止，尚未完成此来源。'; }
  void closeTab(active).then(persist).catch(() => {});
}
const ready = (async () => {
  await secureStorage;
  const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as { task?: ResearchTask; tab?: OwnedTab } | undefined;
  if (!stored?.task) return;
  try {
    researchInput(stored.task.question, stored.task.urls);
    if (typeof stored.task.id !== 'string' || !Array.isArray(stored.task.sources) || stored.task.sources.length > 5 || JSON.stringify(stored.task).length > 180_000) throw new Error('Invalid checkpoint');
    latest = stored.task;
    if (researchActive(latest)) {
      latest.status = 'interrupted'; latest.stage = '任务已中断'; latest.error = '扩展后台或浏览器已中断，未自动重发模型请求。可查看已完成证据，重新开始需明确点击。'; latest.updatedAt = Date.now();
      for (const source of latest.sources) if (source.status !== 'done' && source.status !== 'error') { source.status = 'error'; source.error = '后台中断，未完成此来源。'; }
    }
    if (stored.tab && Number.isInteger(stored.tab.id) && typeof stored.tab.url === 'string') {
      try { const actual = await chrome.tabs.get(stored.tab.id); if (actual.url === stored.tab.url || actual.pendingUrl === stored.tab.url) await chrome.tabs.remove(stored.tab.id); } catch { /* No remaining task tab. */ }
    }
    await persist();
  } catch { latest = undefined; await chrome.storage.session.remove(SESSION_KEY); }
})();

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function checkpoint(active: Job): Promise<void> { current(active); active.state.updatedAt = Date.now(); await persist(); current(active); }
async function readSource(active: Job, source: ResearchSource): Promise<Article> {
  current(active);
  if (!(await permitted(source.requestedUrl))) throw new Error('缺少文档域权限，请授权后重新开始。');
  current(active);
  const tab = await chrome.tabs.create({ url: source.requestedUrl, active: false });
  if (tab.id === undefined) throw new Error('未能创建临时阅读标签页。');
  active.tab = { id: tab.id, url: source.requestedUrl };
  if (active.controller.signal.aborted || job !== active) { await closeTab(active); current(active); }
  await checkpoint(active);
  const started = Date.now();
  let frame: chrome.webNavigation.GetFrameResultDetails | null = null;
  while (Date.now() - started < 20_000) {
    current(active);
    const actual = await chrome.tabs.get(tab.id); current(active);
    const candidate = actual.url || actual.pendingUrl;
    if (candidate && candidate !== 'about:blank') {
      const url = allowedUrl(candidate);
      if (url.origin !== new URL(source.requestedUrl).origin) throw new Error('文档跳转到了其他域，本轮未读取；请改用最终链接并明确授权。');
      if (url.href !== source.requestedUrl) throw new Error('文档发生跳转或导航，本轮未读取；请改用最终链接重新开始。');
      if (!(await permitted(url.href))) throw new Error('文档权限已撤销。');
      current(active); active.tab!.url = url.href;
    }
    if (actual.status === 'complete') {
      frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }); current(active);
      if (frame?.documentId && !frame.errorOccurred) break;
    }
    await wait(120, active.controller.signal);
  }
  if (!frame?.documentId || frame.errorOccurred) throw new Error('文档加载超时或失败，本轮未读取。');
  const url = allowedUrl(frame.url).href;
  if (url !== source.requestedUrl || !(await permitted(url))) throw new Error('文档目标或授权已变化，本轮未读取。');
  current(active); active.tab!.url = url; active.documentId = frame.documentId;
  await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [frame.documentId] }, files: ['content.js'] }); current(active);
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'research:extract', requestId: active.state.id, url }, { documentId: frame.documentId }); current(active);
  const final = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }); current(active);
  if (final?.documentId !== frame.documentId || final.url !== url || !(await permitted(url))) throw new Error('读取期间文档已导航或权限已变化。');
  current(active);
  if (!response?.ok) throw new Error(typeof response?.message === 'string' ? response.message : '未取得文档正文。');
  const article = response.article as Article;
  if (!article || article.url !== url || typeof article.text !== 'string' || article.text.length < 180 || article.text.length >= MAX_TEXT || article.truncated || typeof article.title !== 'string' || article.title.length > 500) throw new Error('读取正文格式无效或超过资源上限。');
  source.url = url; source.title = article.title; source.characters = article.text.length;
  source.notice = typeof article.notice === 'string' ? article.notice.slice(0, 1000) : undefined;
  return { title: article.title, url, text: article.text, originalLength: article.text.length, truncated: false, coverage: article.coverage === 'partial' ? 'partial' : 'visible', notice: source.notice };
}
function takeCall(active: Job): void {
  current(active);
  if (active.state.calls >= active.state.maxCalls) throw new Error('本次任务已达到模型调用上限。');
  active.state.calls++; active.state.updatedAt = Date.now();
  void persist().catch(() => { if (job === active && researchActive(active.state)) cancelResearch('无法保存任务进度，研究已停止。'); });
}
async function run(active: Job, settings: Awaited<ReturnType<typeof readConfig>>['settings'], key: string): Promise<void> {
  try {
    for (const source of active.state.sources) {
      current(active); source.status = 'reading'; active.state.status = 'reading'; active.state.stage = `正在读取 ${source.id} / ${active.state.sources.length}`; await checkpoint(active);
      try {
        const article = await readSource(active, source); current(active);
        await closeTab(active); current(active);
        source.status = 'analyzing'; active.state.status = 'analyzing'; active.state.stage = `正在提取 ${source.id} 的原文证据`; await checkpoint(active);
        if (!(await permitted(settings.baseUrl))) throw new Error('模型接口权限已撤销。'); current(active);
        const answer = await analyzeResearchSource(settings, key, active.state.question, article, active.controller.signal, () => takeCall(active)); current(active);
        source.findings = answer.findings; source.notice = [source.notice, answer.notice].filter(Boolean).join('；') || undefined; source.status = 'done';
      } catch (error) {
        current(active); source.status = 'error'; source.error = safeError(error);
      } finally { await closeTab(active); }
      await checkpoint(active);
    }
    const completed = active.state.sources.filter(source => source.status === 'done');
    if (!completed.length) throw new Error('所有来源均未取得可核对证据，本次未生成报告。请检查来源状态后重新开始。');
    active.state.status = 'synthesizing'; active.state.stage = '正在比较已验证的来源证据'; await checkpoint(active);
    if (!(await permitted(settings.baseUrl))) throw new Error('模型接口权限已撤销。'); current(active);
    const report = await synthesizeResearch(settings, key, active.state.question, active.state.sources, active.controller.signal, () => takeCall(active)); current(active);
    active.state.report = report; active.state.status = 'done'; active.state.stage = '研究完成';
    const failures = active.state.sources.length - completed.length;
    active.state.error = failures ? `${failures} 个来源未成功分析，报告仅依据其余 ${completed.length} 个来源。` : completed.length === 1 ? '仅有一个来源，报告属于单页资料整理。' : undefined;
  } catch (error) {
    if (job !== active || active.controller.signal.aborted) return;
    active.state.status = 'error'; active.state.stage = '研究未完成'; active.state.error = safeError(error);
  } finally {
    clearTimeout(active.timer); await closeTab(active);
    if (job === active) { active.state.updatedAt = Date.now(); await persist().catch(() => {}); }
  }
}
async function start(question: unknown, urls: unknown, sender: chrome.runtime.MessageSender): Promise<ResearchTask> {
  const version = epoch;
  const document = owner(sender);
  const input = researchInput(question, urls);
  if (researchActive(latest)) throw new Error('已有研究正在进行，请先停止或等待完成。');
  await configurationReady();
  const { settings, key } = await readConfig();
  if (!settings.baseUrl || !settings.model || !key) throw new Error('请先在设置页配置接口、模型和 API Key。');
  for (const url of [...input.urls, settings.baseUrl]) if (!(await permitted(url))) throw new Error('缺少文档或模型接口域权限，请在 Chrome 的扩展详情中检查网站访问权限。');
  if (closedOwners.has(document)) throw new Error('研究页已关闭，本次未开始。');
  if (version !== epoch) throw new Error('配置或权限已变化，请重新开始研究。');
  if (researchActive(latest)) throw new Error('已有研究正在进行。');
  beforeRequest();
  const now = Date.now();
  const state: ResearchTask = { id: crypto.randomUUID(), ...input, sources: input.urls.map((requestedUrl, index) => ({ id: `S${index + 1}`, requestedUrl, title: '', status: 'queued', findings: [] })), status: 'reading', stage: '准备读取文档', calls: 0, maxCalls: MAX_RESEARCH_CALLS, createdAt: now, updatedAt: now };
  const active: Job = { state, controller: new AbortController(), owner: document }; job = active; latest = state;
  try { await persist(); } catch { state.status = 'error'; state.stage = '未开始'; state.error = '无法保存任务进度，本次未开始研究。'; throw new Error(state.error); }
  current(active);
  active.timer = setTimeout(() => cancelResearch('研究达到 12 分钟时限，已停止；可查看已完成来源。'), 12 * 60_000);
  void run(active, settings, key);
  return structuredClone(state);
}
export function initializeResearch(options: { configurationReady?: () => Promise<unknown>; beforeRequest?: () => void } = {}): void {
  if (options.configurationReady) configurationReady = options.configurationReady;
  if (options.beforeRequest) beforeRequest = options.beforeRequest;
  if (initialized) return; initialized = true;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith('research:')) return;
    void (async () => {
      if (!trusted(sender)) throw new Error('只有扩展研究页可以管理研究任务和报告。');
      await ready;
      if (message.type === 'research:view') {
        const [{ settings, key }, permissions, reports] = await Promise.all([readConfig(), chrome.permissions.getAll(), listResearchReports()]);
        return { ok: true, task: latest ?? null, reports, hasKey: !!key, settingsReady: !!(settings.baseUrl && settings.model) && await permitted(settings.baseUrl), permissions: permissions.origins ?? [] };
      }
      if (message.type === 'research:status') return { ok: true, task: latest ?? null };
      if (message.type === 'research:start') { const next = starts.then(() => start(message.question, message.urls, sender)); starts = next.catch(() => {}); return { ok: true, task: await next }; }
      if (message.type === 'research:stop') { if (latest?.id !== message.id) throw new Error('研究任务已变化。'); cancelResearch(); await writes; return { ok: true, task: latest }; }
      if (message.type === 'research:save') {
        if (!latest || latest.id !== message.id || latest.status !== 'done' || !latest.report) throw new Error('只有当前完整报告可以保存。');
        const task = latest, report = await saveResearchReport(structuredClone(task));
        if (latest === task) { task.savedId = report.id; await persist(); }
        return { ok: true, report };
      }
      if (message.type === 'research:delete') { await deleteResearchReport(message.id); if (latest && latest.savedId === message.id) { latest.savedId = undefined; await persist(); } return { ok: true }; }
      throw new Error('未知的研究操作。');
    })().then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== RESEARCH_PORT) return;
    if (!port.sender || !trusted(port.sender)) { port.disconnect(); return; }
    const document = owner(port.sender);
    closedOwners.delete(document);
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => {
      closedOwners.add(document);
      if (closedOwners.size > 100) closedOwners.delete(closedOwners.values().next().value!);
      if (job?.owner === document && researchActive(job.state)) cancelResearch('研究页已关闭，任务已停止；已保存报告仍在本机。');
    });
  });
  chrome.permissions.onRemoved.addListener(() => cancelResearch('网站或模型接口权限已撤销，研究已停止。'));
}

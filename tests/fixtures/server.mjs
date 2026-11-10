import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const paragraphA = 'ARTICLE_A_SENTINEL explains how a distributed cache preserves consistency. Each update carries a version number. Readers compare versions before accepting cached data, and stale records are invalidated after a successful write. The article recommends measuring cache hit rate, documenting failure behavior, and keeping the original database as the source of truth.';
const paragraphB = 'ARTICLE_B_SENTINEL explores the event loop and asynchronous JavaScript. A task runs to completion, then queued microtasks are processed before rendering. Developers should divide expensive work into smaller tasks, cancel obsolete requests with AbortController, and keep interaction responsive. This article focuses on browser scheduling rather than distributed caches.';
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function documentPage(title, content, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:18px/1.7 system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 24px;color:#203347;background:#f5f8fc}header{border-bottom:3px solid #2482a4}a{color:#056f9b}article,main{background:white;padding:26px;border-radius:12px}h1{line-height:1.2}code,pre{background:#e8eef5}pre{padding:18px;white-space:pre-wrap}.spacer{height:750px}.links{display:grid;gap:18px}button,input{font:inherit}footer{margin:50px 0;color:#506070}</style></head><body><header><a href="/index">Fixture reading index</a></header>${content}<footer>Local M1 deterministic test page; no external assets.</footer>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function article(title, marker, paragraph, extra = '') {
  return documentPage(title, `<article data-fixture="${marker}"><h1>${title}</h1><p>${paragraph}</p><h2>Practical observations</h2><p>${paragraph}</p><pre><code>const marker = "${marker}";\nconst controller = new AbortController();</code></pre><p>${paragraph}</p>${extra}</article>`);
}

function contextPage(foreign = false) {
  const title = foreign ? 'Foreign reading: resilience in ecosystems' : 'Technical reading: coherence and microtasks';
  const content = foreign
    ? '<article><h1>Reading an English research note</h1><p id="ctx-before">FOREIGN_NEAR_BEFORE_SENTINEL: This note discusses ecosystems recovering after a drought.</p><p id="ctx-foreign">In this paragraph, <span id="term-foreign">resilience</span> means the capacity to recover after a disturbance while retaining essential functions. FOREIGN_CONTEXT_SENTINEL identifies this paragraph.</p><p id="ctx-after">FOREIGN_NEAR_AFTER_SENTINEL: The authors distinguish recovery from preventing every disturbance.</p><div id="ctx-empty" style="height:55px" aria-label="Empty selection target"></div></article>'
    : '<article><h1>Two contextual technical terms</h1><p id="ctx-before">CONTEXT_A_NEAR_BEFORE_SENTINEL: The cache is shared by several readers.</p><p id="ctx-a">Within this distributed cache, <span id="term-a">coherence</span> means that readers agree about the version of a cached value. CONTEXT_A_NEAR_SENTINEL identifies the intended source context.</p><p id="ctx-after">CONTEXT_A_NEAR_AFTER_SENTINEL: Version numbers make obsolete values detectable.</p><p>Background discussion of scheduling and independent application work.</p><p>Additional reading material keeps the two selected contexts separate.</p><p id="ctx-b-before">CONTEXT_B_NEAR_BEFORE_SENTINEL: A browser task runs before pending jobs are processed.</p><p id="ctx-b">In the event loop, <span id="term-b">microtasks</span> run after the current task and before the browser considers rendering. CONTEXT_B_NEAR_SENTINEL identifies this second context.</p><p id="ctx-b-after">CONTEXT_B_NEAR_AFTER_SENTINEL: A long job queue may delay the next paint.</p><div id="ctx-empty" style="height:55px" aria-label="Empty selection target"></div></article>';
  const longEnglish = 'Ecosystem resilience depends on the capacity to recover after a disturbance while retaining essential functions. The researchers observed several habitats over many seasons and compared their recovery after drought. They also documented the limits of their evidence, including incomplete measurements and changes in local conditions. This paragraph remains a complete translation target and is intentionally longer than the short phrase threshold. LONG_ENGLISH_CONTEXT_SENTINEL';
  return documentPage(title, content + '<aside>GLOBAL_NAV_NO_CONTEXT_SECRET</aside><form><label>Plain text <input id="ctx-input" type="text" value="INPUT_CONTEXT_SELECTED_SECRET"></label><label>Password <input id="ctx-password" type="password" value="CONTEXT_FORM_SECRET_MUST_NOT_LEAVE"></label><p><span id="term-form">FORM_CONTEXT_SELECTED_SECRET</span></p></form><div id="ctx-editor" contenteditable="true"><span id="term-editor">EDITOR_CONTEXT_SELECTED_SECRET</span></div><p style="opacity:0"><span id="term-hidden">HIDDEN_CONTEXT_SELECTED_SECRET</span></p><p id="ctx-long-foreign">' + longEnglish + '</p><p><a id="ctx-drag-link" draggable="true" href="/article-a">DRAG_LINK_SELECTION_MUST_NOT_TRIGGER</a></p><p id="ctx-long">' + 'LONG_CONTEXT_SELECTION '.repeat(320) + '</p><div hidden>CONTEXT_HIDDEN_SECRET_MUST_NOT_LEAVE</div>');
}

/** Deterministic local pages and a mock Chat Completions streaming endpoint. No real model is used. */
export async function startFixtures({ port = 4317 } = {}) {
  let requests = [];
  let serial = 0;
  const sockets = new Set();
  const timers = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ count: requests.length, totalRequestsSinceStart: serial, requests }));
      return;
    }
    if (url.pathname === '/reset') {
      requests = [];
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString('utf8');
        if (raw.length > 1_000_000) { res.writeHead(413); res.end(); return; }
      }
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"error":{"message":"invalid JSON"}}'); return; }
      // Store only the presence and scheme of authentication, never its value.
      const record = { id: ++serial, path: url.pathname, model: body.model, body, authPresent: Boolean(req.headers.authorization), authorizationScheme: req.headers.authorization?.split(' ')[0] || '', startedAt: Date.now(), completed: false, aborted: false, responseChunks: 0 };
      requests.push(record);
      res.on('close', () => { if (!record.completed) record.aborted = true; });
      const model = String(body.model || 'normal').toLowerCase();
      const jsonError = (status, message, code) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        record.completed = true;
        res.end(JSON.stringify({ error: { message, code } }));
      };
      if (model.includes('401')) { jsonError(401, 'Mock authentication rejected', 'invalid_api_key'); return; }
      if (model.includes('403')) { jsonError(403, 'Mock access denied', 'permission_denied'); return; }
      if (model.includes('429')) { jsonError(429, 'Mock rate limit reached', 'rate_limit_exceeded'); return; }
      if (model.includes('missing-model')) { jsonError(404, 'Mock model does not exist', 'model_not_found'); return; }
      if (model.includes('redirect')) { record.completed = true; res.writeHead(307, { Location: '/v1/chat/completions' }); res.end(); return; }
      if (model.includes('timeout')) return; // Deliberately do not send response headers.
      if (model.includes('incompatible') || model.includes('invalid-format')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        record.completed = true;
        res.end(JSON.stringify({ unexpected: 'Mock endpoint has no Chat Completions choices.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const input = JSON.stringify(body.messages || []);
      let quoteTermsInput;
      if (body.messages?.[0]?.content?.startsWith('为中文读者从网页选区中挑出')) {
        quoteTermsInput = JSON.parse(body.messages[1].content).quote;
      }
      let contextInput;
      try { const candidate = JSON.parse(body.messages?.[1]?.content || 'null'); if (typeof candidate?.selection === 'string' && typeof candidate?.paragraphContext === 'string') contextInput = candidate; } catch {}
      const markers = ['LONG_ARTICLE_SENTINEL', 'LONG_ARTICLE_END_SENTINEL', 'LEAD_OUTSIDE_SENTINEL', 'DYNAMIC_ARTICLE_SENTINEL', 'ARTICLE_B_SENTINEL', 'ARTICLE_A_SENTINEL'].filter(marker => input.includes(marker));
      const marker = markers.join(' ') || 'CONNECTION_TEST';
      record.stage = input.includes('全文中的连续一段') ? 'section' : input.includes('按原文顺序排列的全部分段事实提要') ? 'merge' : 'direct';
      record.markerInputs = markers;
      if (contextInput) {
        record.stage = 'context'; record.selection = contextInput.selection; record.paragraphContext = contextInput.paragraphContext;
        record.contextMode = /选区完整译|译法与术语说明|双语例句|英文句|英文例句|英语例句/.test(body.messages?.[0]?.content || '') ? 'translate' : 'explain';
        record.contextAnswerKind = contextInput.existingCoreAnswer ? 'details' : 'core';
      }
      // Short deterministic notes fit the planner's reserved merge budget.
      // A tail marker can reach the final answer only through an actual segment response.
      const contextMarker = contextInput?.selection.includes('microtasks') ? 'CONTEXT_B_OUTPUT' : contextInput?.selection.includes('resilience') ? 'CONTEXT_TRANSLATION_OUTPUT' : 'CONTEXT_A_OUTPUT';
      const retryQuote = quoteTermsInput?.includes('at the forefront of integrating LLMs');
      const firstQuoteAttempt = retryQuote && !requests.slice(0, -1).some(item => item.body.messages?.[1]?.content === body.messages[1].content);
      const pieces = typeof quoteTermsInput === 'string'
        ? retryQuote
          ? [firstQuoteAttempt ? '我会先检查这段话中的术语。' : '1. **forefront**：前沿\n2. **llms**：大型语言模型\n3. **intelligent agents**：智能体']
          : quoteTermsInput.includes('microtasks')
            ? ['以下是推荐词。\n```json\n["Microtasks","invented term","event loop","microtasks","rendering"]\n```']
            : ['["coherence","distributed cache"]']
        : contextInput
        ? record.contextAnswerKind === 'details'
          ? record.contextMode === 'translate'
            ? [`双语例句：${contextMarker}。`, '\n1. The wetland showed resilience after the drought.\n这片湿地在干旱后展现了恢复能力。', '\n2. The system needs resilience when a server fails.\n服务器发生故障时，系统需要具备恢复能力。']
            : [`用法示例（自拟）：${contextMarker}。`, '\n在缓存写入后递增版本号，读取方拒绝旧版本，便于理解本段中的 coherence。', '\n最小代码：const fresh = cached.version === latestVersion;']
          : [`模拟${record.contextMode === 'translate' ? '翻译' : '解释'}：${contextMarker}。`, '\n核心回答：仅依据当前选区和近邻段落。', '\n该文字由本地模拟 API 返回，仅验证数据流与界面行为。']
        : record.stage === 'section' ? [`模拟事实：${marker}。`] : [`模拟中文摘要：${marker}。`, '\n\n• 本文讨论当前目标文章的核心主题。', '\n• 版本、异步任务与可靠性需要明确的边界。', '\n• 该结果由本地模拟 API 返回，仅验证扩展流程。'];
      const events = [': mock streaming fixture\r\n\r\n', ...pieces.map(content => `data: ${JSON.stringify({ id: `mock-${record.id}`, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\r\n\r\n`), `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n'];
      // Slice raw UTF-8 bytes to exercise event boundaries and split multibyte characters.
      const chunks = [];
      for (const event of events) {
        const bytes = Buffer.from(event);
        const sizes = [1, 7, 2, 13, 3, 29, 5];
        for (let offset = 0, n = 0; offset < bytes.length; n++) {
          const size = sizes[n % sizes.length];
          chunks.push(bytes.subarray(offset, offset + size));
          offset += size;
        }
      }
      const initialDelay = model.includes('silent') ? 45_000 : model.includes('slow') || quoteTermsInput?.includes('CONTEXT_A_NEAR_SENTINEL') ? 3_500 : 30;
      let cursor = 0;
      const writeNext = () => {
        if (res.destroyed) return;
        // Flush a handful of byte fragments at a time, with visible pauses between text events.
        for (let i = 0; i < 8 && cursor < chunks.length; i++) {
          res.write(chunks[cursor++]);
          record.responseChunks++;
        }
        if (cursor < chunks.length) later(writeNext, 35);
        else { record.completed = true; record.finishedAt = Date.now(); res.end(); }
      };
      later(writeNext, initialDelay);
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/redirect') { res.writeHead(302, { Location: `http://localhost:${server.address().port}/article-b` }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let html;
    switch (url.pathname) {
      case '/context-index':
        html = documentPage('Contextual reading fixtures', '<main><h1>Contextual reading fixtures</h1><p>Open a target inside the inline preview and select a word there.</p><section class="links"><a id="context-tech" draggable="true" href="/context-tech">Technical context page</a><a id="context-foreign" draggable="true" href="/context-foreign">Foreign context page</a></section></main>');
        break;
      case '/context-tech': html = contextPage(false); break;
      case '/context-foreign': html = contextPage(true); break;
      case '/': case '/index':
        html = documentPage('M1 fixture index', '<main><h1>Reading workflow fixtures</h1><p>Select this paragraph to check ordinary page interactions.</p><a id="ordinary" href="/article-a" target="_blank">Ordinary link opens a new tab</a><div class="spacer"></div><section class="links"><a id="article-a" draggable="true" href="/article-a">Article A — distributed cache</a><a id="article-b" draggable="true" href="/article-b">Article B — JavaScript event loop</a><a id="xfo" draggable="true" href="/xfo">XFO-only article</a><a id="lead" draggable="true" href="/lead">Outside introduction</a><a id="resource" draggable="true" href="/resource">Resource guard</a><a id="deny" draggable="true" href="/deny">Article refusing iframe embedding</a><a id="dynamic" draggable="true" href="/dynamic">Delayed article</a><a id="long" draggable="true" href="/long">Long article</a><a id="login" draggable="true" href="/login">Login form</a><a id="empty" draggable="true" href="/empty">Empty page</a><a id="redirect" draggable="true" href="/redirect">Redirect to ungranted localhost</a><a id="restricted" draggable="true" href="chrome://settings">Restricted Chrome page</a></section><div class="spacer"></div></main>');
        break;
      case '/article-a': html = article('Article A: Versioned distributed cache', 'ARTICLE_A_SENTINEL', paragraphA, '<p><a id="next-article" href="/article-b">Continue to Article B</a></p>'); break;
      case '/article-b': html = article('Article B: The browser event loop', 'ARTICLE_B_SENTINEL', paragraphB); break;
      case '/xfo':
        res.setHeader('X-Frame-Options', 'DENY');
        html = article('XFO-only article', 'ARTICLE_A_SENTINEL', paragraphA);
        break;
      case '/deny':
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        html = article('A real top-level page with iframe restrictions', 'ARTICLE_A_SENTINEL', paragraphA);
        break;
      case '/dynamic':
        html = documentPage('Delayed article fixture', '<main id="dynamic-body"><h1>Preparing an article</h1><p>Loading content…</p></main>', `setTimeout(() => { document.querySelector('#dynamic-body').innerHTML = ${JSON.stringify(`<article><h1>Dynamic content is ready</h1><p>DYNAMIC_ARTICLE_SENTINEL ${paragraphB}</p><p>${paragraphB}</p><p>${paragraphB}</p></article>`)}; }, 1800);`);
        break;
      case '/long':
        html = documentPage('Long technical article', `<article><h1>Long technical article</h1><p>LONG_ARTICLE_SENTINEL</p>${Array.from({ length: 100 }, (_, i) => `<p>Section ${i + 1}. ${paragraphA}</p>`).join('')}<p>LONG_ARTICLE_END_SENTINEL</p></article>`);
        break;
      case '/lead':
        html = documentPage('A technical article with an outside lead', `<p class="lead">LEAD_OUTSIDE_SENTINEL: a correction outside the article provides essential context.</p><article><h1>Article with outside introduction</h1><p>${paragraphA}</p><p>${paragraphA}</p></article>`);
        break;
      case '/resource':
        html = documentPage('Resource boundary', `<article><h1>Resource boundary</h1><p>${'Visible resource guard text. '.repeat(12_000)}</p></article>`);
        break;
      case '/login':
        html = documentPage('Sign in to continue', '<main><h1>Sign in to continue</h1><form><label>Email <input type="email" value="private@example.invalid"></label><br><label>Password <input type="password" value="FORM_SECRET_MUST_NOT_LEAVE"></label><button type="button">Sign in</button></form><p>Please sign in to read this article.</p></main>');
        break;
      case '/empty': html = documentPage('Empty article', '<main><h1>Empty article</h1></main>'); break;
      default: res.writeHead(404); html = documentPage('Not found', '<main><h1>Fixture page not found</h1></main>');
    }
    res.end(html);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    origin,
    getStats: () => ({ count: requests.length, totalRequestsSinceStart: serial, requests }),
    reset: () => { requests = []; },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtures = await startFixtures({ port: Number(process.env.FIXTURE_PORT || 4317) });
  process.stdout.write(`M1 local mock fixtures: ${fixtures.origin}/index\nMock API Base URL: ${fixtures.origin}/v1\nModels: normal, slow, silent, 401, 403, 429, missing-model, incompatible, timeout, redirect\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixtures.close(); process.exit(); });
}

import { DEFAULT_SETTINGS, MAX_CHAT_OUTPUT_TOKENS, MIN_CHAT_OUTPUT_TOKENS, type Settings } from './shared';
export const PROMPT_VERSION = 'zh-inline-fulltext-2';
export const MAX_TEXT = 300_000;
export function allowedUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持不含用户名和密码的 HTTP 或 HTTPS 网页。');
  if (url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) throw new Error('Chrome 应用商店属于受限页面，无法读取。');
  return url;
}
export function apiEndpoint(value: string): string {
  const url = allowedUrl(value.trim());
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('模型接口请使用 HTTPS，或本机 localhost / 127.0.0.1 的 HTTP。');
  if (url.search || url.hash) throw new Error('接口地址不能包含查询参数或片段。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('配置格式无效。');
  const s = value as Settings;
  if (typeof s.baseUrl !== 'string' || typeof s.model !== 'string' || s.baseUrl.length > 2048 || s.model.length > 200 || typeof s.rememberKey !== 'boolean') throw new Error('配置格式无效。');
  if (s.baseUrl.trim()) apiEndpoint(s.baseUrl);
  const inputBudgetTokens = s.inputBudgetTokens ?? DEFAULT_SETTINGS.inputBudgetTokens;
  const autoLongSummary = s.autoLongSummary ?? DEFAULT_SETTINGS.autoLongSummary;
  const chatOutputTokens = s.chatOutputTokens ?? DEFAULT_SETTINGS.chatOutputTokens;
  if (!Number.isInteger(inputBudgetTokens) || inputBudgetTokens < 2048 || inputBudgetTokens > 128000 || typeof autoLongSummary !== 'boolean') throw new Error('请输入 2048–128000 的整数输入预算。');
  if (!Number.isInteger(chatOutputTokens) || chatOutputTokens < MIN_CHAT_OUTPUT_TOKENS || chatOutputTokens > MAX_CHAT_OUTPUT_TOKENS) throw new Error('请输入 512–8192 的整数对话输出预算。');
  return { baseUrl: s.baseUrl.trim(), model: s.model.trim(), rememberKey: s.rememberKey, inputBudgetTokens, autoLongSummary, chatOutputTokens };
}
export function httpError(status: number): string {
  if (status === 401 || status === 403) return '接口拒绝访问（401/403）。请检查 API Key、接口权限和地址。';
  if (status === 429) return '请求受限（429）。请稍后手动重试，并检查配额。';
  if (status === 404) return '接口或模型不存在（404）。请检查 Base URL 与模型标识。';
  if (status === 400 || status === 422) return '请求不兼容（400/422）。请检查模型名及 Chat Completions、stream、store 参数支持。';
  return `模型接口返回 HTTP ${status}。请稍后手动重试。`;
}
export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export async function cacheKey(url: string, text: string, settings: Settings, key: string, subscription?: { model: string; accountId: string }): Promise<string> {
  const endpoint = subscription ? 'chatgptOAuth' : apiEndpoint(settings.baseUrl);
  const model = subscription?.model ?? settings.model;
  const scope = await digest(subscription?.accountId ?? key);
  return digest(JSON.stringify([url, await digest(text), endpoint, model, settings.inputBudgetTokens, scope, 'zh', PROMPT_VERSION]));
}
export class SSEParser {
  private buffer = '';
  private data: string[] = [];
  private first = true;
  constructor(private emit: (data: string) => void) {}
  push(chunk: string, final = false) {
    if (this.first && chunk) { chunk = chunk.replace(/^\uFEFF/, ''); this.first = false; }
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.search(/[\r\n]/);
      if (index < 0 || (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, index);
      const length = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(index + length);
      this.line(line);
    }
    if (final) { if (this.buffer) this.line(this.buffer); this.buffer = ''; this.line(''); }
  }
  private line(line: string) {
    if (!line) { if (this.data.length) this.emit(this.data.join('\n')); this.data = []; return; }
    if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
  }
}

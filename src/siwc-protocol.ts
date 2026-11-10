import type { CompletionMessage } from './model';
import type { WebChatModel } from './webchat-shared';
import { SIWC_DIAGNOSTIC_EVENTS, SIWC_DIAGNOSTIC_KEYS, type SIWC_DIAGNOSTIC_REASONS, type SIWC_VALUE_TYPES, type SiwcDiagnostic } from './siwc-shared';
import type { ChatCitation, ChatSearch, SearchUpdate } from './chat-shared';
import { sanitizeChatCitations } from './chat-search';
import { sanitizeChatDetails } from './chat-details';

export const SIWC_ERRORS = {
  auth: 'ChatGPT 授权操作失败，请检查网络和扩展存储后重试。',
  authBusy: '已有 ChatGPT 登录正在进行，请完成或取消后重试。',
  signedOut: '请先在设置中登录 ChatGPT 并授权套餐用量。',
  planDenied: '账号身份已验证，尚未授权 ChatGPT 套餐用量，请重新登录并确认授权。',
  permission: '请在 Chrome 的扩展详情中检查阅窗的网站访问权限。',
  network: 'OpenAI 官方 API 连接失败，请检查网络后手动重试。',
  denied: 'OpenAI 拒绝了本次请求，请检查账号的套餐用量授权。',
  quota: '当前套餐用量或应用用量限制已达到，请查看 ChatGPT 设置中的用量。',
  model: '当前账号没有可用的所选模型，请刷新模型列表。',
  format: 'OpenAI 响应格式不符合预期，本次请求已停止。',
  interrupted: '回答尚未完成，连接已中断；收到的片段已保留。',
  length: '模型输出达到长度上限，回答尚未完成。',
  timeout: 'OpenAI 请求超时，本次请求已停止，请手动重试。',
  output: '回答超过 40,000 字符上限，已停止生成。',
  authDenied: '本次官方登录或套餐授权未完成，请重新登录并确认授权。',
  identity: '本次登录未通过官方身份校验，未启用这次连接，请重新登录。',
  unsupportedCapability: '当前账号或模型不支持本次请求的功能，请检查模型与套餐支持。',
  policyDenied: '当前账号的套餐资格或授权范围不允许本次请求，请检查 ChatGPT 中的应用授权。',
  request: 'OpenAI 未接受本次请求，请检查模型及请求配置后手动重试。',
} as const;
export class SiwcFailure extends Error {
  constructor(public readonly code: keyof typeof SIWC_ERRORS, public readonly reason?: typeof SIWC_DIAGNOSTIC_REASONS[number]) { super(SIWC_ERRORS[code]); }
}
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseSiwcModels(value: unknown): WebChatModel[] {
  if (!record(value) || !Array.isArray(value.models) || value.models.length > 1000) throw new SiwcFailure('format', 'modelCatalog');
  const result: WebChatModel[] = [];
  for (const item of value.models) {
    if (!record(item) || item.visibility !== 'list') continue;
    if (typeof item.slug !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(item.slug) || typeof item.display_name !== 'string' || !item.display_name.trim() || item.display_name.length > 160 || /[\u0000-\u001f\u007f]/.test(item.display_name)) throw new SiwcFailure('format', 'modelCatalog');
    if (!result.some(model => model.id === item.slug)) result.push({ id: item.slug, label: item.display_name });
  }
  if (!result.length) throw new SiwcFailure('model', 'modelCatalog');
  return result;
}
export const SIWC_MAX_MESSAGE_CHARACTERS = 40_000;

export function siwcRequestBody(model: string, messages: CompletionMessage[], webSearch = true) {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(model) || !Array.isArray(messages) || !messages.length || messages.length > 41) throw new SiwcFailure('format', 'requestInvalid');
  let total = 0;
  for (const item of messages) {
    if (!record(item) || !['system', 'user', 'assistant'].includes(String(item.role)) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > SIWC_MAX_MESSAGE_CHARACTERS) throw new SiwcFailure('format', 'requestInvalid');
    total += item.content.length;
  }
  if (total > 240_000 || messages.at(-1)?.role !== 'user') throw new SiwcFailure('format', 'requestInvalid');
  const instructions = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
  return {
    model, ...(instructions ? { instructions } : {}),
    input: messages.filter(item => item.role !== 'system').map(item => ({ role: item.role, content: item.content })),
    store: false, stream: true,
    ...(webSearch ? { tools: [{ type: 'web_search' }], tool_choice: 'auto' } : {}),
  };
}
function codeFailure(value: unknown): SiwcFailure | undefined {
  const error = record(value) && record(value.error) ? value.error : value;
  const code = record(error) && typeof error.code === 'string' ? error.code : '';
  if (code === 'subscription_sharing_unsupported_capability') return new SiwcFailure('unsupportedCapability');
  if (['subscription_sharing_user_not_eligible', 'subscription_sharing_route_not_supported', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'].includes(code)) return new SiwcFailure('policyDenied');
  if (code === 'subscription_sharing_usage_unavailable') return new SiwcFailure('network');
  if (['subscription_sharing_usage_limit_exceeded', 'rate_limit_exceeded', 'insufficient_quota'].includes(code)) return new SiwcFailure('quota');
  if (['invalid_api_key', 'invalid_token', 'token_expired'].includes(code)) return new SiwcFailure('signedOut');
  if (['model_not_found', 'model_not_available'].includes(code)) return new SiwcFailure('model');
  if (['access_denied', 'permission_denied'].includes(code)) return new SiwcFailure('denied');
}
function streamFailure(value: unknown): SiwcFailure {
  return codeFailure(value) || new SiwcFailure('interrupted');
}
function valueType(value: unknown): typeof SIWC_VALUE_TYPES[number] {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'undefined' || type === 'object' || type === 'string' || type === 'number' || type === 'boolean' ? type : 'invalid';
}
function diagnosticKeys(value: Record<string, unknown>): string[] {
  // Iterate the fixed list, never stringify or retain unknown server key names.
  return SIWC_DIAGNOSTIC_KEYS.filter(key => Object.hasOwn(value, key));
}
function eventDiagnostic(value: unknown): SiwcDiagnostic {
  const event = record(value) ? value : undefined;
  const response = event && record(event.response) ? event.response : undefined;
  const type = event?.type;
  const eventType = typeof type === 'string' && (SIWC_DIAGNOSTIC_EVENTS as readonly string[]).includes(type) ? type as typeof SIWC_DIAGNOSTIC_EVENTS[number] : 'other';
  const status = response?.status;
  const responseStatus = status === undefined ? 'missing' : typeof status === 'string' && ['queued', 'in_progress', 'completed', 'failed', 'incomplete', 'cancelled'].includes(status) ? status as SiwcDiagnostic['responseStatus'] : 'other';
  return {
    stage: type === 'response.completed' ? 'completion' : 'event', eventType,
    jsonType: valueType(value), eventKeys: event ? diagnosticKeys(event) : [],
    deltaType: valueType(event?.delta), responseType: valueType(event?.response),
    ...(response ? { responseKeys: diagnosticKeys(response), responseStatus } : {}),
  };
}
const MAX_ANSWER_PARTS = 1000;
const MAX_ANSWER_TEXT = 40_000;
interface AnswerPart { text: string; citations: ChatCitation[] }
interface StreamAnswerPart extends AnswerPart { rank: number }
interface StreamAnswerItem { id?: string; complete: boolean; parts: Map<number, StreamAnswerPart> }
/** Read only displayable assistant content, never reasoning or tool payloads. */
function answerPart(value: unknown): AnswerPart | undefined {
  if (!record(value)) return;
  if (value.type === 'refusal' && typeof value.refusal === 'string') return { text: value.refusal, citations: [] };
  if (value.type !== 'output_text' || typeof value.text !== 'string') return;
  const citations: unknown[] = [];
  if (Array.isArray(value.annotations)) for (const annotation of value.annotations.slice(0, MAX_ANSWER_PARTS)) {
    if (!record(annotation) || annotation.type !== 'url_citation') continue;
    citations.push({ start: annotation.start_index, end: annotation.end_index, url: annotation.url, title: annotation.title });
  }
  return { text: value.text, citations: sanitizeChatCitations(citations, value.text.length) };
}
function answerParts(value: unknown): AnswerPart[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ANSWER_PARTS) return;
  const parts: AnswerPart[] = [];
  for (const valuePart of value) {
    const part = answerPart(valuePart);
    if (!part) return;
    parts.push(part);
  }
  return parts;
}
/** Only the Responses terminal completion event establishes a successful turn. */
export class SiwcStream {
  text = '';
  completed = false;
  lastDiagnostic?: SiwcDiagnostic;
  private responseId?: string;
  private readonly searches = new Map<string, ChatSearch['state']>();
  private readonly searchIndexes = new Map<number, string>();
  private searchState?: ChatSearch;
  private readonly answerItems = new Map<number, StreamAnswerItem>();
  private answerCharacters = 0;
  private answerPartCount = 0;
  private unsupportedAnswer = false;
  private pendingRefusal = false;
  constructor(private readonly onText: (text: string) => void, private readonly onUpdate?: (update: SearchUpdate) => void) {}
  accept(data: string): void {
    if (this.completed) return;
    if (data.length > 1_000_000) {
      this.lastDiagnostic = { stage: 'event' };
      throw this.failure('format', 'eventTooLarge');
    }
    if (data.trim() === '[DONE]') {
      this.lastDiagnostic = { stage: 'stream', eventType: 'doneMarker' };
      throw this.failure('interrupted', 'streamEnded');
    }
    let value: unknown;
    try { value = JSON.parse(data); } catch {
      this.lastDiagnostic = { stage: 'event', jsonType: 'invalid' };
      throw this.failure('format', 'invalidJson');
    }
    this.lastDiagnostic = eventDiagnostic(value);
    if (!record(value) || typeof value.type !== 'string') throw this.failure('format', 'invalidEvent');
    if (record(value.response) && typeof value.response.id === 'string') {
      if (this.responseId && this.responseId !== value.response.id) throw this.failure('format', 'responseChanged');
      this.responseId = value.response.id;
    }
    if (value.type === 'response.failed' || value.type === 'error') throw this.failure(streamFailure(value.response || value).code, 'terminalStatus');
    if (value.type === 'response.incomplete') {
      const details = record(value.response) ? value.response.incomplete_details : undefined;
      throw this.failure(record(details) && details.reason === 'max_output_tokens' ? 'length' : 'interrupted', 'terminalStatus');
    }
    // Display only the model supplied by this response, never the requested
    // model as an inferred result. A valid final model replaces earlier data.
    if (record(value.response) && value.type !== 'response.completed') {
      const details = sanitizeChatDetails({ model: value.response.model });
      if (details) this.onUpdate?.({ details });
    }
    if (['response.web_search_call.in_progress', 'response.web_search_call.searching', 'response.web_search_call.completed'].includes(value.type)) {
      this.searchCall(value, undefined, value.type === 'response.web_search_call.completed' ? 'complete' : 'searching');
    }
    if ((value.type === 'response.output_item.added' || value.type === 'response.output_item.done') && record(value.item) && value.item.type === 'web_search_call') {
      this.searchItem(value, value.item);
    }
    if (value.type === 'response.output_text.delta') {
      if (typeof value.delta !== 'string') throw this.failure('format', 'invalidDelta');
      this.add(value.delta);
      if (value.output_index !== undefined || value.content_index !== undefined) {
        const [outputIndex, contentIndex] = this.partIndexes(value);
        const item = this.answerItem(outputIndex, value.item_id);
        const old = item.parts.get(contentIndex);
        if (!item.complete && (!old || old.rank === 0)) this.setAnswerPart(item, contentIndex, { text: (old?.text ?? '') + value.delta, citations: [], rank: 0 });
      }
    }
    if (value.type === 'response.refusal.delta') this.pendingRefusal = true;
    if (value.type === 'response.output_text.done' || value.type === 'response.refusal.done') {
      const isRefusal = value.type === 'response.refusal.done';
      const text = isRefusal ? value.refusal : value.text;
      if (typeof text !== 'string') throw this.failure('format', 'invalidEvent');
      const [outputIndex, contentIndex] = this.partIndexes(value);
      const item = this.answerItem(outputIndex, value.item_id);
      this.setAnswerPart(item, contentIndex, { text, citations: [], rank: 1 });
      if (isRefusal) this.pendingRefusal = false;
    }
    if (value.type === 'response.content_part.done') {
      // Reasoning content has its own event family and is never an answer.
      if (record(value.part) && value.part.type === 'reasoning_text') return;
      const part = answerPart(value.part);
      if (!part) this.unsupportedAnswer = true;
      else {
        const [outputIndex, contentIndex] = this.partIndexes(value);
        this.setAnswerPart(this.answerItem(outputIndex, value.item_id), contentIndex, { ...part, rank: 2 });
        if (record(value.part) && value.part.type === 'refusal') this.pendingRefusal = false;
      }
    }
    if (value.type === 'response.output_item.done' && record(value.item)) {
      const item = value.item;
      if (item.type === 'message' && item.role === 'assistant') {
        const parts = answerParts(item.content);
        if (!parts || item.status !== undefined && item.status !== 'completed') this.unsupportedAnswer = true;
        else if (parts.length) {
          const outputIndex = this.answerIndex(value.output_index);
          const previous = this.answerItem(outputIndex, item.id);
          // A complete message replaces lower-level part snapshots. Its text
          // and annotation offsets belong to the same authoritative version.
          const next: StreamAnswerItem = { id: previous.id, complete: false, parts: new Map() };
          this.answerCharacters -= [...previous.parts.values()].reduce((sum, part) => sum + part.text.length, 0);
          this.answerPartCount -= previous.parts.size;
          this.answerItems.set(outputIndex, next);
          for (const [contentIndex, part] of parts.entries()) this.setAnswerPart(next, contentIndex, { ...part, rank: 3 });
          next.complete = true;
          if (Array.isArray(item.content) && item.content.some((part: unknown) => record(part) && part.type === 'refusal')) this.pendingRefusal = false;
        }
      } else if (item.type !== 'reasoning' && item.type !== 'web_search_call') this.unsupportedAnswer = true;
    }
    if (value.type === 'response.completed') {
      if (!record(value.response)) throw this.failure('format', 'terminalResponseMissing');
      if (value.response.status !== 'completed') throw this.failure('format', 'terminalStatus');
      if (value.response.error !== undefined && value.response.error !== null) throw this.failure(streamFailure(value.response).code, 'terminalStatus');
      // A terminal event can contain only metadata. Replace streamed text only
      // when it actually supplies displayable assistant content, including an
      // explicit empty output_text. The top-level `text` is format config.
      let canonical: AnswerPart[] | undefined;
      if (value.response.output !== undefined) {
        if (!Array.isArray(value.response.output) || value.response.output.length > MAX_ANSWER_PARTS) throw this.failure('format', 'invalidEvent');
        const parts: AnswerPart[] = [];
        for (const [outputIndex, item] of value.response.output.entries()) {
          if (record(item) && item.type === 'web_search_call') this.searchItem({ output_index: outputIndex }, item);
          if (!record(item)) throw this.failure('format', 'invalidEvent');
          if (item.type === 'reasoning' || item.type === 'web_search_call') continue;
          if (item.type !== 'message' || item.role !== 'assistant' || item.status !== undefined && item.status !== 'completed') throw this.failure('format', 'invalidEvent');
          const message = answerParts(item.content);
          if (!message || parts.length + message.length > MAX_ANSWER_PARTS) throw this.failure('format', 'invalidEvent');
          parts.push(...message);
        }
        if (parts.length) canonical = parts;
      }
      if (!canonical) {
        if (this.unsupportedAnswer || this.pendingRefusal) throw this.failure('format', 'invalidEvent');
        const streamed = [...this.answerItems].sort(([left], [right]) => left - right).flatMap(([, item]) => [...item.parts].sort(([left], [right]) => left - right).map(([, part]) => part));
        if (streamed.length) canonical = streamed;
      }
      if (canonical) this.publishAnswer(canonical);
      if (!this.text.trim()) throw this.failure('format', 'emptyText');
      for (const [key, state] of this.searches) if (state !== 'failed') this.searches.set(key, 'complete');
      this.publishSearch();
      this.completed = true;
      const usage = record(value.response.usage) ? value.response.usage : undefined;
      const details = sanitizeChatDetails({
        model: value.response.model,
        ...(usage ? { usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens: record(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined,
          reasoningTokens: record(usage.output_tokens_details) ? usage.output_tokens_details.reasoning_tokens : undefined,
          totalTokens: usage.total_tokens,
        } } : {}),
      });
      if (details) this.onUpdate?.({ details });
    }
  }
  private failure(code: keyof typeof SIWC_ERRORS, reason: typeof SIWC_DIAGNOSTIC_REASONS[number]): SiwcFailure {
    this.lastDiagnostic = { ...(this.lastDiagnostic ?? { stage: 'event' }), reason };
    for (const key of this.searches.keys()) this.searches.set(key, 'failed');
    this.publishSearch();
    return new SiwcFailure(code, reason);
  }
  private answerIndex(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= MAX_ANSWER_PARTS) throw this.failure('format', 'invalidEvent');
    return value as number;
  }
  private partIndexes(value: Record<string, unknown>): [number, number] {
    return [this.answerIndex(value.output_index), this.answerIndex(value.content_index)];
  }
  private answerItem(index: number, rawId: unknown): StreamAnswerItem {
    if (rawId !== undefined && (typeof rawId !== 'string' || !rawId || rawId.length > 200)) throw this.failure('format', 'invalidEvent');
    const id = rawId as string | undefined;
    let item = this.answerItems.get(index);
    if (!item) {
      if (this.answerItems.size >= MAX_ANSWER_PARTS) throw this.failure('format', 'invalidEvent');
      item = { id, complete: false, parts: new Map() };
      this.answerItems.set(index, item);
    } else if (id && item.id && id !== item.id) throw this.failure('format', 'invalidEvent');
    else if (id) item.id = id;
    return item;
  }
  private setAnswerPart(item: StreamAnswerItem, index: number, part: StreamAnswerPart): void {
    const previous = item.parts.get(index);
    // Higher-level snapshots preserve their known annotations when a later
    // text.done repeats the same content without annotation metadata.
    if (item.complete || previous && previous.rank > part.rank) return;
    const characters = this.answerCharacters - (previous?.text.length ?? 0) + part.text.length;
    if (characters > MAX_ANSWER_TEXT) throw this.failure('output', 'streamTooLarge');
    if (!previous && this.answerPartCount >= MAX_ANSWER_PARTS) throw this.failure('format', 'invalidEvent');
    this.answerCharacters = characters;
    if (!previous) this.answerPartCount++;
    item.parts.set(index, part);
  }
  private publishAnswer(parts: AnswerPart[]): void {
    let text = '';
    const citations: ChatCitation[] = [];
    for (const part of parts) {
      if (text.length + part.text.length > MAX_ANSWER_TEXT) throw this.failure('output', 'streamTooLarge');
      const offset = text.length;
      text += part.text;
      for (const citation of part.citations) if (citations.length < MAX_ANSWER_PARTS) citations.push({ ...citation, start: offset + citation.start, end: offset + citation.end });
    }
    this.text = ''; this.add(text);
    this.onUpdate?.({ citations: sanitizeChatCitations(citations, text.length) });
  }
  private searchItem(event: Record<string, unknown>, item: Record<string, unknown>): void {
    const action = record(item.action) ? item.action.type : undefined;
    const state = item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'complete' : action === 'open_page' || action === 'find_in_page' ? 'reading' : 'searching';
    this.searchCall(event, item, state);
  }
  private searchCall(event: Record<string, unknown>, item: Record<string, unknown> | undefined, state: ChatSearch['state']): void {
    const itemId = item?.id ?? event.item_id;
    const id = typeof itemId === 'string' && itemId.length > 0 && itemId.length <= 200 ? `id:${itemId}` : undefined;
    const index = Number.isSafeInteger(event.output_index) && (event.output_index as number) >= 0 && (event.output_index as number) < 1000 ? event.output_index as number : undefined;
    const previousKey = index === undefined ? undefined : this.searchIndexes.get(index);
    // Real search events carry an item ID or output index. Text or an
    // unidentified event cannot manufacture a searching indicator.
    const key = id || previousKey || (index === undefined ? undefined : `index:${index}`);
    if (!key) return;
    if (previousKey && id && previousKey !== id) {
      if (!previousKey.startsWith('index:')) return;
      const previous = this.searches.get(previousKey);
      this.searches.delete(previousKey);
      if (previous) this.searches.set(key, previous);
    }
    if (!this.searches.has(key) && this.searches.size >= 1000) return;
    if (index !== undefined) this.searchIndexes.set(index, key);
    const previous = this.searches.get(key);
    if ((previous === 'complete' || previous === 'failed') && (state === 'searching' || state === 'reading')) return;
    this.searches.set(key, state);
    this.publishSearch();
  }
  private publishSearch(): void {
    if (!this.searches.size) return;
    const states = [...this.searches.values()];
    const state: ChatSearch['state'] = states.includes('reading') ? 'reading' : states.includes('searching') ? 'searching' : states.includes('failed') ? 'failed' : 'complete';
    const search = { state, calls: this.searches.size };
    if (this.searchState?.state === search.state && this.searchState.calls === search.calls) return;
    this.searchState = search;
    this.onUpdate?.({ search: { ...search } });
  }
  private add(delta: string) {
    if (this.text.length + delta.length > 40_000) throw this.failure('output', 'streamTooLarge');
    this.text += delta; this.onText(this.text);
  }
  finish(): string {
    if (!this.completed) {
      this.lastDiagnostic = { ...this.lastDiagnostic, stage: 'stream' };
      throw this.failure('interrupted', 'streamEnded');
    }
    return this.text;
  }
}
export function siwcHttpFailure(status: number, value?: unknown): SiwcFailure {
  const known = codeFailure(value);
  return new SiwcFailure(known?.code || (status === 400 || status === 422 ? 'request' : status === 401 ? 'signedOut' : status === 403 ? 'denied' : status === 429 ? 'quota' : status === 404 ? 'model' : 'network'), 'httpError');
}

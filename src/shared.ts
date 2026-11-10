export const MIN_CHAT_OUTPUT_TOKENS = 512;
export const MAX_CHAT_OUTPUT_TOKENS = 8192;
export interface Settings { baseUrl: string; model: string; rememberKey: boolean; inputBudgetTokens: number; autoLongSummary: boolean; chatOutputTokens: number }
export const DEFAULT_SETTINGS: Settings = { baseUrl: '', model: '', rememberKey: false, inputBudgetTokens: 64_000, autoLongSummary: false, chatOutputTokens: MAX_CHAT_OUTPUT_TOKENS };
export interface Article { title: string; url: string; text: string; truncated: boolean; originalLength: number; description?: string; headings?: string[]; coverage?: 'visible'|'partial'; notice?: string }
export interface SummaryPlan { strategy: 'direct'|'sections'; segments: number; requests: number; estimatedTokens: number; characters: number }
export interface SummaryProgress { stage: 'reading'|'section'|'merge'; current: number; total: number }
export interface PreviewInit { type: 'preview:init'; previewId: string; revision: number; url: string; autoSummary: boolean; interrupted: boolean }
export type PreviewEvent = PreviewInit
  | { type: 'preview:page'; previewId: string; revision: number; url: string; title?: string; status: 'loading'|'ready'|'error'; error?: string }
  | { type: 'preview:article'; article: Omit<Article, 'text'> }
  | { type: 'summary:plan'; plan: SummaryPlan; needsConfirmation: boolean }
  | { type: 'summary:progress'; progress: SummaryProgress }
  | { type: 'summary:state'; requestId: string; status: 'reading'|'planned'|'running'|'done'|'cancelled'|'error'; text: string; error?: string; cached?: boolean }
  | { type: 'preview:reset' };
export type PreviewCommand = { type: 'summary:start'; force?: boolean; automatic?: boolean; allowMultiple?: boolean } | { type: 'summary:stop' } | { type: 'summary:status' } | { type: 'preview:close' } | { type: 'preview:open-tab' } | { type: 'settings:open' };
export interface InlinePreview { id: string; url: string }
export const WEB_ACCESS_ORIGINS = ['https://*/*', 'http://*/*'] as const;
export interface SettingsView { settings: Settings; hasKey: boolean; permissions: string[]; warning: string; cacheCount: number }
// Settings messages (only options.html is trusted): settings:get, settings:save {settings,key?:string},
// settings:test, settings:clear-cache, settings:clear-key, settings:export.
// Responses: {ok:true, ...SettingsView} or {ok:false,error:string}; test: {ok:true,text:string}.
// Top-frame messages: page:hello -> {ok:true,enabled:boolean}; preview:open {url} -> {ok,preview:InlinePreview,warning}.
// Top frame creates iframe name `local-reader-${id}`, then connects Port "preview".
// Preview target subframe: frame:hello {name:window.name} -> {ok,previewId}.
// Background -> exact target document: frame:extract {previewId,requestId} -> ExtractionResult; frame:cancel {requestId}.
// Background -> exact source document: preview:closed {previewId}.

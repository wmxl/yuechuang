import type { ChatConnection } from './chat-connection-shared';
import type { SiwcStatus } from './siwc-shared';

export const CHAT_PORT = 'chat';
export const CHAT_SESSION_KEY = 'chatSession';
export const MAX_CHAT_MESSAGES = 40;
export const MAX_CHAT_INPUT = 6000;
export const MAX_CHAT_OUTPUT = 40_000;
export const MAX_CHAT_QUOTE = 3000;

export function chatPageQuote(text: string): string {
  return text.length > MAX_CHAT_QUOTE ? text.slice(0, MAX_CHAT_QUOTE - 1) + '…' : text;
}

export function isQuotePassage(text: string): boolean {
  // Skip single words, including selections from writing systems without spaces.
  return /\S\s+\S|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{8}/u.test(text);
}

export function chatInputWithQuote(text: string, quote: string): string {
  return quote ? `网页选区引用（仅供参考）：\n${quote}\n\n我的问题：\n${text}` : text;
}

export interface ChatCitation { start: number; end: number; url: string; title: string }
export interface ChatSearch { state: 'searching' | 'reading' | 'complete' | 'failed'; calls: number }
export interface ChatResponseDetails {
  model?: string;
  durationMs?: number;
  firstTokenMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
}
/** Metadata callbacks carry patches; consumers merge details and usage fields. */
export interface SearchUpdate { search?: ChatSearch; citations?: ChatCitation[]; details?: ChatResponseDetails }

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'done' | 'running' | 'cancelled' | 'error';
  search?: ChatSearch;
  citations?: ChatCitation[];
  details?: ChatResponseDetails;
}
export interface ChatState {
  type: 'chat:state';
  messages: ChatMessage[];
  status: 'idle' | 'running' | 'error' | 'cancelled' | 'interrupted';
  requestId?: string;
  error?: string;
  hasKey: boolean;
  settingsReady: boolean;
  connection?: ChatConnection;
  connectionLabel?: string;
  accountLabel?: string;
  siwcStatus?: SiwcStatus;
}
export interface ChatQuoteSource {
  windowId: number;
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
}
export type ChatCommand =
  | { type: 'chat:status' }
  | { type: 'chat:reading-window'; windowId: number; quoteEnabled: boolean }
  | { type: 'chat:quote-terms'; id: string; text: string; source: ChatQuoteSource }
  | { type: 'chat:cancel-quote-terms' }
  | { type: 'chat:send'; text: string; quoteSource?: ChatQuoteSource }
  | { type: 'chat:stop'; requestId: string }
  | { type: 'chat:clear'; requestId?: string };

export type ChatQuoteTermsResult =
  | { status: 'done'; terms: string[] }
  | { status: 'error'; message: string }
  | { status: 'cancelled' };

export type ChatReadingEvent =
  | { type: 'chat:page-quote'; text: string; source: ChatQuoteSource }
  | { type: 'chat:quote-terms'; id: string; result: ChatQuoteTermsResult }
  | { type: 'chat:follow-up-ready'; quote: string; source: ChatQuoteSource };


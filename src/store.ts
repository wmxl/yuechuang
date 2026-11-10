import { DEFAULT_SETTINGS, type Settings } from './shared';
export interface Preview { mode: 'inline'; id: string; tabId: number; sourceDocumentId: string; sourceWindowId: number; frameId?: number; documentId?: string; revision: number; url: string; autoEligible: boolean; activeTask: boolean; interrupted: boolean }
export interface CacheEntry { key: string; text: string }
export const secureStorage = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
export async function readConfig(): Promise<{ settings: Settings; key: string }> {
  await secureStorage;
  const [local, session] = await Promise.all([chrome.storage.local.get<{ settings?: Settings & { autoSummary?: boolean }; apiKey?: string }>(['settings','apiKey']), chrome.storage.session.get<{apiKey?:string}>('apiKey')]);
  const { autoSummary: _legacyAutoSummary, ...savedSettings } = local.settings ?? {};
  const settings = { ...DEFAULT_SETTINGS, ...savedSettings };
  return { settings, key: settings.rememberKey ? local.apiKey || '' : session.apiKey || '' };
}
export async function saveConfig(settings: Settings, suppliedKey?: string): Promise<void> {
  const current = await readConfig();
  const key = suppliedKey?.trim() || current.key;
  if (key.length > 8192 || /[\r\n]/.test(key)) throw new Error('Key 格式无效。');
  // Write the destination first, remove the old copy, then publish the selected mode.
  if (settings.rememberKey) { await chrome.storage.local.set({ apiKey: key }); await chrome.storage.session.remove('apiKey'); }
  else { await chrome.storage.session.set({ apiKey: key }); await chrome.storage.local.remove('apiKey'); }
  await chrome.storage.local.set({ settings });
}
export async function clearKey() { await secureStorage; await Promise.all([chrome.storage.local.remove('apiKey'), chrome.storage.session.remove('apiKey')]); }
let cacheQueue: Promise<unknown> = Promise.resolve();
async function cacheSnapshot(): Promise<CacheEntry[]> { await secureStorage; return (await chrome.storage.session.get<{cache?: CacheEntry[]}>('cache')).cache || []; }
export async function readCache(): Promise<CacheEntry[]> { await cacheQueue; return cacheSnapshot(); }
export function writeCache(key: string, text: string) {
  const next = cacheQueue.then(async () => { const entries = await cacheSnapshot(); await chrome.storage.session.set({ cache: [...entries.filter(e => e.key !== key), { key, text }].slice(-20) }); });
  cacheQueue = next.catch(() => {}); return next;
}
export function clearCache() {
  const next = cacheQueue.then(async () => { await secureStorage; await chrome.storage.session.remove('cache'); });
  cacheQueue = next.catch(() => {}); return next;
}

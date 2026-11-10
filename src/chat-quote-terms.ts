function sourceTerms(candidates: unknown[], quote: string): string[] {
  const terms = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const term = candidate.trim();
    if (term.length > 32 || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .+'’/#_-]*$/u.test(term)) continue;
    const escaped = term.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
    const start = /^[\p{Script=Latin}\p{N}]/u.test(term) ? '(?<![\\p{Script=Latin}\\p{N}_])' : '';
    const end = /[\p{Script=Latin}\p{N}]$/u.test(term) ? '(?![\\p{Script=Latin}\\p{N}_])' : '';
    const original = quote.match(new RegExp(start + escaped + end, 'iu'))?.[0];
    if (original) terms.add(original);
    if (terms.size === 3) break;
  }
  return [...terms];
}

/** Accept common wrappers around the model's list. Every chip must match the quote. */
export function parseQuoteTerms(answer: string, quote: string): string[] | undefined {
  const text = answer.replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, '').trim();
  let empty = false;
  for (const match of text.matchAll(/\[[^[\]]*\]/gu)) {
    let value: unknown;
    try { value = JSON.parse(match[0]); } catch { continue; }
    if (!Array.isArray(value)) continue;
    if (!value.length) empty = true;
    const terms = sourceTerms(value, quote);
    if (terms.length) return terms;
  }
  const list = text.split('\n').flatMap(line => {
    const item = line.match(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)(.+)$/u)?.[1];
    if (!item) return [];
    const label = item.split(/[:：]|\s+[—–-]\s+/u, 1)[0].trim();
    return [label.replace(/^[\x60*"'“‘「]+|[\x60*"'”’」]+$/gu, '')];
  });
  const terms = sourceTerms(list, quote);
  if (terms.length) return terms;
  return empty ? [] : undefined;
}

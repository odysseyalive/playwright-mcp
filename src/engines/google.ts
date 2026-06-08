/**
 * Google SERP scraper (most drift-prone; intermittent CAPTCHA). Organic results
 * in #search: an <a href> wrapping an <h3>. Skip /url? internal redirects (handled
 * by cleanHref), ads ([data-text-ad]), and "People also ask". Snippet from
 * div[data-sncf]/[data-snc] else nearby block text.
 */

import { JSDOM } from 'jsdom';
import { type Engine, type RawResult, cleanHref } from './types.js';

const BASE = 'https://www.google.com/search';

export const google: Engine = {
  name: 'google',
  resultSelector: '#search, #captcha-form',

  buildUrl(query) {
    return `${BASE}?q=${encodeURIComponent(query)}&num=10&hl=en&gl=us`;
  },

  detectBlock(html) {
    const head = html.slice(0, 8000);
    if (/captcha-form|unusual traffic|our systems have detected/i.test(head)) return true;
    const doc = new JSDOM(html).window.document;
    return doc.querySelector('#search') !== null && organicAnchors(doc).length === 0;
  },

  parse(html) {
    const doc = new JSDOM(html).window.document;
    const out: RawResult[] = [];
    const seen = new Set<string>();
    for (const a of organicAnchors(doc)) {
      const h3 = a.querySelector('h3');
      const title = h3?.textContent?.trim() ?? '';
      const url = cleanHref(a.getAttribute('href'), BASE);
      if (!title || !url || seen.has(url)) continue;
      seen.add(url);
      // Snippet: the result block that contains this anchor.
      const block = a.closest('div.g, div[data-hveid], div[jscontroller]');
      const snippet =
        block?.querySelector('div[data-sncf], div[data-snc]')?.textContent?.trim() ??
        blockText(block, title) ??
        '';
      out.push({ title, url, snippet });
    }
    return out;
  },
};

function organicAnchors(doc: Document): HTMLAnchorElement[] {
  const search = doc.querySelector('#search') ?? doc.body;
  if (!search) return [];
  const anchors = [...search.querySelectorAll('a')] as HTMLAnchorElement[];
  return anchors.filter((a) => {
    if (!a.querySelector('h3')) return false;
    if (a.closest('[data-text-ad], .related-question-pair, [aria-label="People also ask"]')) return false;
    return true;
  });
}

function blockText(block: Element | null | undefined, title: string): string | undefined {
  if (!block) return undefined;
  const text = block.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const after = text.replace(title, '').trim();
  return after.length > 20 ? after.slice(0, 300) : undefined;
}

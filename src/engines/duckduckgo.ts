/**
 * DuckDuckGo SERP scraper (html.duckduckgo.com endpoint — least drift-prone).
 * Selectors: .result; title .result__a; url = href (resolve /l/?uddg= redirect);
 * snippet .result__snippet.
 */

import { JSDOM } from 'jsdom';
import { type Engine, type RawResult, cleanHref } from './types.js';

const BASE = 'https://html.duckduckgo.com/html/';

export const duckduckgo: Engine = {
  name: 'duckduckgo',
  resultSelector: '.result, .no-results',

  buildUrl(query) {
    return `${BASE}?q=${encodeURIComponent(query)}`;
  },

  detectBlock(html) {
    if (/anomaly|are you a robot|unusual/i.test(html.slice(0, 5000))) return true;
    const doc = new JSDOM(html).window.document;
    return doc.querySelectorAll('.result__a').length === 0 && /no-results/i.test(html) === false
      ? doc.querySelectorAll('.result').length === 0
      : false;
  },

  parse(html) {
    const doc = new JSDOM(html).window.document;
    const out: RawResult[] = [];
    for (const r of doc.querySelectorAll('.result')) {
      const a = r.querySelector('.result__a');
      const url = cleanHref(a?.getAttribute('href'), BASE);
      const title = a?.textContent?.trim() ?? '';
      if (!url || !title) continue;
      out.push({ title, url, snippet: r.querySelector('.result__snippet')?.textContent?.trim() ?? '' });
    }
    return out;
  },
};

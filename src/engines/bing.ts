/**
 * Bing SERP scraper. Selectors: #b_results .b_algo; title h2 a; url = href;
 * snippet .b_caption p / .b_algoSlug. Block: consent banner or empty #b_results.
 */

import { JSDOM } from 'jsdom';
import { type Engine, type RawResult, cleanHref } from './types.js';

const BASE = 'https://www.bing.com/search';

export const bing: Engine = {
  name: 'bing',
  resultSelector: '#b_results',

  buildUrl(query) {
    return `${BASE}?q=${encodeURIComponent(query)}&count=10&setlang=en`;
  },

  detectBlock(html) {
    const doc = new JSDOM(html).window.document;
    if (/consent\.bing|bnp_btn_accept/i.test(html)) return doc.querySelectorAll('.b_algo').length === 0;
    return doc.querySelector('#b_results') !== null && doc.querySelectorAll('.b_algo').length === 0;
  },

  parse(html) {
    const doc = new JSDOM(html).window.document;
    const out: RawResult[] = [];
    for (const r of doc.querySelectorAll('#b_results .b_algo')) {
      const a = r.querySelector('h2 a');
      const url = cleanHref(a?.getAttribute('href'), BASE);
      const title = a?.textContent?.trim() ?? '';
      if (!url || !title) continue;
      const snippet =
        r.querySelector('.b_caption p')?.textContent?.trim() ??
        r.querySelector('.b_algoSlug')?.textContent?.trim() ??
        '';
      out.push({ title, url, snippet });
    }
    return out;
  },
};

/**
 * Google Scholar SERP scraper (opt-in via scholarly:true). Selectors: .gs_r /
 * .gs_ri; title .gs_rt a; snippet .gs_rs. CAPTCHA like Google.
 */

import { JSDOM } from 'jsdom';
import { type Engine, type RawResult, cleanHref } from './types.js';

const BASE = 'https://scholar.google.com/scholar';

export const scholar: Engine = {
  name: 'scholar',
  resultSelector: '#gs_res_ccl, #captcha-form',

  buildUrl(query) {
    return `${BASE}?q=${encodeURIComponent(query)}&hl=en`;
  },

  detectBlock(html) {
    if (/captcha-form|unusual traffic|not a robot/i.test(html.slice(0, 8000))) return true;
    return containers(new JSDOM(html).window.document).length === 0;
  },

  parse(html) {
    const doc = new JSDOM(html).window.document;
    const out: RawResult[] = [];
    for (const r of containers(doc)) {
      const a = r.querySelector('.gs_rt a');
      const url = cleanHref(a?.getAttribute('href'), BASE);
      const title = a?.textContent?.trim() ?? '';
      if (!url || !title) continue;
      out.push({ title, url, snippet: r.querySelector('.gs_rs')?.textContent?.trim() ?? '' });
    }
    return out;
  },
};

/** Per-result container: prefer the inner .gs_ri, fall back to .gs_r (avoids
 *  double-counting when .gs_ri is nested inside .gs_r). */
function containers(doc: Document): Element[] {
  const inner = [...doc.querySelectorAll('.gs_ri')];
  return inner.length > 0 ? inner : [...doc.querySelectorAll('.gs_r')];
}

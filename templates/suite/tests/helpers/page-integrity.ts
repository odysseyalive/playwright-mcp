import type { Page } from '@playwright/test';

import { suiteConfig, toRegExps } from './suite-config';

/**
 * Page-integrity scanner — detects broken HTML and rendered artifacts, both as
 * served AND as introduced by front-end scripts during a test. Project-agnostic;
 * per-project suppressions live in e2e-suite.config.json `integrity.allow`.
 *
 * Severity model (proven in production use — the FAIL classes are deterministic
 * first-party defects with near-zero false-positive risk):
 *   fail  server-error-text  server-side error text rendered into the page
 *                            (PHP Warning:/Fatal error:, xdebug tables, Python
 *                            Traceback, generic "Stack trace:")
 *   fail  leaked-template    template tokens rendered as text: {{var}}, {%if%},
 *                            {$var}, <%= %> — a template that didn't compile
 *   fail  leaked-markup      raw tag text visible on the page ("</div>") — the
 *                            parser bailed on malformed HTML and emitted it as text
 *   fail  undefined-nan      a visible text node that IS exactly "undefined"/"NaN",
 *                            or contains "$NaN" — a JS render path wrote a bad value
 *   warn  undefined-inline   "undefined"/"NaN" embedded inside longer visible text
 *   warn  duplicate-id       the same id= on multiple elements
 *   warn  nested-form        <form> inside <form>
 *   warn  no-doctype         document renders in quirks mode
 *
 * Console/network noise is a DIFFERENT layer (error-capture.ts, report-only):
 * this scanner reads the rendered DOM, where a finding is always first-party.
 */

export type IntegrityMode = 'enforce' | 'report' | 'off';

export interface IntegrityFinding {
  severity: 'fail' | 'warn';
  kind: string;
  url: string;
  detail: string;
}

export interface IntegrityHandle {
  findings: IntegrityFinding[];
  /** Extra allow patterns (matched against `${kind} ${detail}`) a spec can push to. */
  allow: RegExp[];
}

interface RawFinding {
  severity: 'fail' | 'warn';
  kind: string;
  detail: string;
}

/** Runs inside the page. Keep self-contained — no closure references. */
function domScan(): RawFinding[] {
  const findings: { severity: 'fail' | 'warn'; kind: string; detail: string }[] = [];
  const SKIP_PARENTS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'XMP', 'PRE', 'CODE',
  ]);

  const visible = (el: Element): boolean => (el as HTMLElement).getClientRects().length > 0;

  // Server-side error surfaces rendered as structured blocks (xdebug et al.).
  document.querySelectorAll('table.xdebug-error').forEach((t) => {
    const first = t.querySelector('th')?.textContent?.trim().slice(0, 160) ?? '(error table)';
    findings.push({ severity: 'fail', kind: 'server-error-text', detail: first });
  });

  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  const serverError =
    /^\(?\s*!?\s*\)?\s*(Warning|Notice|Deprecated|Fatal error|Parse error|Traceback \(most recent call last\)|Stack trace):\s|Use of undefined constant|Undefined (variable|index|offset|array key)/;
  const templateTokens =
    /\{\{\s*[\w.$]+\s*\}\}|\{%\s*\w+|\{\$[a-zA-Z_][\w.[\]$]*\}|<%=?\s*[\w.$]/;
  const rawMarkup = /<\/[a-z][a-z0-9]*\s*>|<[a-z][a-z0-9]*(\s+[a-z-]+(="[^"]*")?)+\s*\/?>/i;

  let node: Node | null;
  let scanned = 0;
  while ((node = walker.nextNode()) && scanned < 20000) {
    scanned++;
    const text = node.textContent ?? '';
    if (!text.trim()) continue;
    const parent = node.parentElement;
    if (!parent || SKIP_PARENTS.has(parent.tagName) || !visible(parent)) continue;

    const trimmed = text.trim();
    const context = () => `<${parent.tagName.toLowerCase()}> "${trimmed.slice(0, 120)}"`;

    if (serverError.test(trimmed) && !parent.closest('table.xdebug-error')) {
      findings.push({ severity: 'fail', kind: 'server-error-text', detail: context() });
    }
    if (templateTokens.test(text)) {
      findings.push({ severity: 'fail', kind: 'leaked-template', detail: context() });
    }
    if (rawMarkup.test(text)) {
      findings.push({ severity: 'fail', kind: 'leaked-markup', detail: context() });
    }
    if (trimmed === 'undefined' || trimmed === 'NaN' || /\$\s?NaN\b/.test(text)) {
      findings.push({ severity: 'fail', kind: 'undefined-nan', detail: context() });
    } else if (/\bundefined\b|\bNaN\b/.test(trimmed)) {
      findings.push({ severity: 'warn', kind: 'undefined-inline', detail: context() });
    }
  }

  const ids = new Map<string, number>();
  document.querySelectorAll('[id]').forEach((el) => {
    const id = el.getAttribute('id') || '';
    ids.set(id, (ids.get(id) ?? 0) + 1);
  });
  for (const [id, n] of [...ids.entries()].filter(([, n]) => n > 1).slice(0, 10)) {
    findings.push({ severity: 'warn', kind: 'duplicate-id', detail: `id="${id}" × ${n}` });
  }

  document.querySelectorAll('form form').forEach((f) => {
    findings.push({
      severity: 'warn',
      kind: 'nested-form',
      detail: `<form${f.id ? ` id="${f.id}"` : ''}> nested inside another form`,
    });
  });

  if (!document.doctype) {
    findings.push({ severity: 'warn', kind: 'no-doctype', detail: 'document renders in quirks mode' });
  }

  return findings;
}

function isAllowed(f: IntegrityFinding, extra: RegExp[]): boolean {
  const key = `${f.kind} ${f.detail}`;
  const configured = toRegExps(suiteConfig().integrity.allow);
  return [...configured, ...extra].some((re) => re.test(key));
}

function record(handle: IntegrityHandle, url: string, raw: RawFinding[]): void {
  for (const r of raw) {
    const finding: IntegrityFinding = { ...r, url };
    if (isAllowed(finding, handle.allow)) continue;
    const dupe = handle.findings.some(
      (f) => f.kind === finding.kind && f.detail === finding.detail && f.url === finding.url,
    );
    if (!dupe) handle.findings.push(finding);
  }
}

/** Scan the page's current DOM immediately (also used for the teardown pass). */
export async function scanPageIntegrity(page: Page, handle: IntegrityHandle): Promise<void> {
  if (page.isClosed()) return;
  const url = page.url();
  if (url === 'about:blank' || url.startsWith('chrome-error://') || url.startsWith('data:')) return;
  try {
    const raw = await page.evaluate(domScan);
    record(handle, page.url(), raw);
  } catch {
    // Page navigated/closed mid-scan — never fail a test from the scanner itself.
  }
}

/** Attach a load-event scanner so every page the test visits gets checked. */
export function attachPageIntegrity(page: Page): IntegrityHandle {
  const handle: IntegrityHandle = { findings: [], allow: [] };
  page.on('load', () => {
    void scanPageIntegrity(page, handle);
  });
  return handle;
}

export function formatFindings(findings: IntegrityFinding[]): string {
  return findings
    .map((f) => `[${f.severity.toUpperCase()}] ${f.kind} @ ${f.url}\n    ${f.detail}`)
    .join('\n');
}

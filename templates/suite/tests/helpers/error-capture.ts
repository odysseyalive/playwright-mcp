import type { Page } from '@playwright/test';

import { suiteConfig, toRegExps } from './suite-config';

/**
 * Report-only page-error capture — console errors/warnings, uncaught
 * exceptions, HTTP failures, and failed requests, attached to the test report
 * so a human (or an auditing model) can see everything that happened.
 *
 * DELIBERATELY does not fail tests: third-party beacons and transient network
 * noise would drown real signal. Deterministic first-party artifacts are the
 * page-integrity gate's job (that one DOES fail). Keep the two layers apart.
 *
 * Per-project noise suppression: e2e-suite.config.json `errorCapture.*`.
 */

export interface CapturedError {
  type: 'console' | 'pageerror' | 'http' | 'requestfailed';
  detail: string;
  url: string;
}

export interface ErrorCaptureHandle {
  errors: CapturedError[];
  urlAllowlist: RegExp[];
  consoleAllowlist: RegExp[];
}

export function attachErrorCapture(page: Page): ErrorCaptureHandle {
  const cfg = suiteConfig().errorCapture;
  const handle: ErrorCaptureHandle = {
    errors: [],
    urlAllowlist: toRegExps(cfg.urlAllowlist),
    consoleAllowlist: toRegExps(cfg.consoleAllowlist),
  };

  const urlAllowed = (url: string) => handle.urlAllowlist.some((re) => re.test(url));

  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    if (handle.consoleAllowlist.some((re) => re.test(text))) return;
    handle.errors.push({ type: 'console', detail: `[${msg.type()}] ${text.slice(0, 300)}`, url: page.url() });
  });

  page.on('pageerror', (err) => {
    handle.errors.push({ type: 'pageerror', detail: String(err).slice(0, 300), url: page.url() });
  });

  page.on('response', (res) => {
    const status = res.status();
    const threshold = cfg.fail4xx ? 400 : 500;
    if (status < threshold || urlAllowed(res.url())) return;
    handle.errors.push({ type: 'http', detail: `HTTP ${status}`, url: res.url() });
  });

  page.on('requestfailed', (req) => {
    if (urlAllowed(req.url())) return;
    handle.errors.push({
      type: 'requestfailed',
      detail: req.failure()?.errorText ?? 'failed',
      url: req.url(),
    });
  });

  return handle;
}

export function formatCapturedErrors(handle: ErrorCaptureHandle): string {
  return handle.errors.map((e) => `[${e.type}] ${e.detail}\n    @ ${e.url}`).join('\n');
}

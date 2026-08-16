#!/usr/bin/env node
// T1 acceptance — shared stealth-context lifecycle (src/browser.ts) and the
// never-throw contract of fetchUrl when the browser will not start.
//
// Regression cover for the memoized-failure incident: a failed launch used to be
// cached as a rejected promise, so every later web_fetch replayed one
// byte-identical error until the MCP server was restarted.
//
// Browser-free by default, like the rest of the gate — the two tests that need a
// real chrome run only with PLAYWRIGHT_MCP_TEST_BROWSER=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getStealthContext, closeBrowser, isStaleLock } from '../dist/browser.js';
import { fetchUrl } from '../dist/tools/web-fetch.js';

const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `pwmcp-${name}-`));

/** Point profileDir() at a path that cannot be created, so launch fails fast. */
function breakProfile() {
  const file = path.join(tmp('broken'), 'not-a-dir');
  fs.writeFileSync(file, '');
  process.env.XDG_CACHE_HOME = file;
  return file;
}

// ── stale-lock detection (pure fs, no browser) ───────────────────────────────

test('isStaleLock: no lock at all is not stale', () => {
  assert.equal(isStaleLock(tmp('nolock')), false);
});

test('isStaleLock: a lock owned by a live process is NOT stale', () => {
  const dir = tmp('live');
  fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
  assert.equal(isStaleLock(dir), false);
});

test('isStaleLock: a lock owned by a dead process IS stale', () => {
  const dir = tmp('dead');
  // 0x7ffffffe — above any real pid_max, so it can never be live.
  fs.symlinkSync(`${os.hostname()}-2147483646`, path.join(dir, 'SingletonLock'));
  assert.equal(isStaleLock(dir), true);
});

test('isStaleLock: a lock written on another host IS stale', () => {
  const dir = tmp('foreign');
  fs.symlinkSync(`someotherbox-${process.pid}`, path.join(dir, 'SingletonLock'));
  assert.equal(isStaleLock(dir), true);
});

// ── the memo must never hold a failure ───────────────────────────────────────

test('a failed launch is not memoized — the next call tries again', async () => {
  const first = breakProfile();
  await assert.rejects(getStealthContext(), (err) => err.message.includes(first));

  // Move the profile somewhere else and fail differently. A memoized rejection
  // would replay the FIRST path; a real second attempt names the second.
  const second = breakProfile();
  assert.notEqual(first, second);
  await assert.rejects(getStealthContext(), (err) => err.message.includes(second));
});

test('fetchUrl never throws when the browser cannot start', async () => {
  breakProfile();
  const result = await fetchUrl({ url: 'https://never-reached.test/article' });
  assert.equal(result.fetchStatus, 'blocked');
  assert.match(result.error ?? '', /^browser unavailable: /);
  assert.equal(result.text, '');
  assert.ok((result.error ?? '').length < 500, 'the browser log tail is truncated');
});

// ── real-chrome recovery (opt-in) ────────────────────────────────────────────

test('a stale profile lock is cleared, not fatal', { skip: !BROWSER_TESTS }, async () => {
  const cache = tmp('lockrecover');
  process.env.XDG_CACHE_HOME = cache;
  const profile = path.join(cache, 'playwright-mcp', 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.symlinkSync(`${os.hostname()}-2147483646`, path.join(profile, 'SingletonLock'));

  const ctx = await getStealthContext();
  assert.ok(ctx, 'launched despite the corpse lock');
  await closeBrowser();
});

test('a closed context is dropped, not handed out again', { skip: !BROWSER_TESTS }, async () => {
  process.env.XDG_CACHE_HOME = tmp('reopen');
  const first = await getStealthContext();
  await first.close(); // simulate a crashed / externally killed browser

  const second = await getStealthContext();
  assert.notEqual(second, first, 'a dead context must not be reused');
  const page = await second.newPage(); // would throw if the corpse came back
  await page.close();
  await closeBrowser();
});

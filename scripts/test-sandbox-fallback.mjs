#!/usr/bin/env node
// T1 — the browser_* sandbox fallback (src/upstream.ts withSandboxFallback).
//
// Reported 2026-10-22 from a cPanel jailshell host (EL9, non-root): the shell is
// a chroot, the kernel refuses CLONE_NEWUSER inside one, Chromium died with
// "No usable sandbox!", and the installer stopped at "No working browser" even
// though the same browser ran fine with --no-sandbox. Measured here under
// `bwrap --disable-userns`, which gives Chromium the same refusal.
//
// Browser-free by default: the launches are stand-ins that throw Chromium's own
// messages. With PLAYWRIGHT_MCP_TEST_BROWSER=1 and bubblewrap installed, the last
// case runs the installer's real check with user namespaces denied.
// The refusal is remembered for the life of the process, so the cases run in
// order and this file runs alone (node --test gives each file its own process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SANDBOX_REFUSED, sandboxUnavailable, upstreamLaunch, withSandboxFallback } from '../dist/upstream.js';
import { legacyGlibc } from '../dist/stealth.js';

const SANDBOXED_BY_DEFAULT = process.getuid?.() !== 0 && !legacyGlibc();
const NO_USABLE = '[1:1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+';
const SUID_BROKEN =
  'FATAL:setuid_sandbox_host.cc:172] The SUID sandbox helper binary was found, but is not configured correctly.';

test('any other launch error is rethrown, and the sandbox stays on', async () => {
  let calls = 0;
  await assert.rejects(
    withSandboxFallback(async () => {
      calls++;
      throw new Error('Failed to launch: libnss3.so: cannot open shared object file');
    }),
    /libnss3/,
  );
  assert.equal(calls, 1, 'no retry');
  assert.equal(sandboxUnavailable(), false);
  assert.equal(upstreamLaunch().launchOptions.chromiumSandbox, SANDBOXED_BY_DEFAULT);
});

test('both of Chromium\'s refusal messages are recognised, and nothing broader', () => {
  // The pattern itself, so the SUID case is covered without spending the
  // once-per-process refusal on it.
  assert.match(NO_USABLE, SANDBOX_REFUSED, 'bundled Chromium, no helper on disk');
  assert.match(SUID_BROKEN, SANDBOX_REFUSED, "Google Chrome's helper present but unusable");
  assert.doesNotMatch('Running as root without --no-sandbox is not supported', SANDBOX_REFUSED);
  assert.doesNotMatch('Target page, context or browser has been closed', SANDBOX_REFUSED);
});

test('"No usable sandbox": one retry, and that retry is unsandboxed', async () => {
  const seen = [];
  const title = await withSandboxFallback(async () => {
    const { chromiumSandbox } = upstreamLaunch().launchOptions;
    seen.push(chromiumSandbox);
    if (seen.length === 1) throw new Error(NO_USABLE);
    return 'Example Domain';
  });
  assert.equal(title, 'Example Domain');
  assert.deepEqual(seen, [SANDBOXED_BY_DEFAULT, false], 'the retry re-reads the gate, which is now off');
  assert.equal(sandboxUnavailable(), true);
  assert.equal(upstreamLaunch('/nonexistent/session.json').launchOptions.chromiumSandbox, false, 'bound launches too');
});

test('once refused, a further refusal is rethrown rather than retried forever', async () => {
  let calls = 0;
  await assert.rejects(
    withSandboxFallback(async () => {
      calls++;
      throw new Error(SUID_BROKEN);
    }),
    /SUID sandbox helper/,
  );
  assert.equal(calls, 1);
});

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BWRAP = spawnSync('bwrap', ['--version']).status === 0;
const REAL =
  process.env.PLAYWRIGHT_MCP_TEST_BROWSER !== '1'
    ? 'set PLAYWRIGHT_MCP_TEST_BROWSER=1 to launch a real browser'
    : !BWRAP
      ? 'needs bubblewrap (bwrap) to deny user namespaces'
      : !SANDBOXED_BY_DEFAULT
        ? 'root or legacy-glibc host: the sandbox is off before any refusal'
        : false;

test('real Chromium with user namespaces denied: the check passes and says the sandbox is off', { skip: REAL }, () => {
  // bwrap --disable-userns is the same refusal a chroot gets from the kernel.
  const uid = String(process.getuid());
  const gid = String(process.getgid());
  const res = spawnSync(
    'bwrap',
    ['--dev-bind', '/', '/', '--unshare-user', '--disable-userns', '--uid', uid, '--gid', gid, '--',
      process.execPath, path.join(REPO, 'scripts', 'check-browser.mjs')],
    { encoding: 'utf8', timeout: 150_000 },
  );
  assert.equal(res.status, 0, `check-browser failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /Browser OK/);
  assert.match(res.stdout, /WITHOUT the sandbox/, 'the success path states it');
  assert.match(res.stderr, /runs WITHOUT it/, 'the launch path states it too');
});

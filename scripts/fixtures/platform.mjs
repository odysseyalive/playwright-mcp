// Shared test helpers for platform-dependent fixtures. Imported by
// scripts/test-*.mjs; not a test file itself (the runner globs test-*.mjs only).
//
// Two jobs, both about running the gate honestly on a platform it was not
// written on:
//   - symlinkSkipReason(): PROBE whether this process may create a symlink,
//     rather than assuming. Windows grants that only to an elevated shell or
//     under Developer Mode; without it fs.symlinkSync throws EPERM.
//   - withPlatform(): make process.platform read another value for the length
//     of one call, so a win32 branch that reads the platform AT CALL TIME can be
//     driven on Linux. It is restored however the call exits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Why a symlink-backed fixture cannot run in this process, or `false` when it
 * can. Only EPERM/EACCES mean "not allowed here"; any other error is a real
 * failure and is thrown, never turned into a skip.
 */
export function symlinkSkipReason() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-symlink-probe-'));
  try {
    fs.symlinkSync('probe-target', path.join(dir, 'probe'));
    return false;
  } catch (err) {
    if (err?.code !== 'EPERM' && err?.code !== 'EACCES') throw err;
    return (
      `symlinks unavailable to this process (${err.code} from fs.symlinkSync; on Windows that needs ` +
      'Developer Mode or an elevated shell). The fixture fakes Chrome\'s SingletonLock, which is a symlink.'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run `fn` with process.platform reading `value`, then restore the original
 * descriptor. Async-safe: the fake spans every await inside `fn`, so only use it
 * where nothing else runs concurrently in this process (node:test runs a file's
 * top-level tests one at a time) and where the code under test reads the
 * platform at call time. Node's own path/os modules chose their implementation
 * at load and do not move.
 */
export async function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** Synchronous twin of withPlatform: the fake cannot outlive the call at all. */
export function withPlatformSync(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

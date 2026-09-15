#!/usr/bin/env node
// T1 regression guard — the two installers, read byte-wise (install.ps1, install.sh).
//
// Regression cover for the 2026-09-15 Windows report: install.ps1 carried
// non-ASCII characters with no UTF-8 BOM, so Windows PowerShell 5.1 decoded it in
// the ANSI code page. The em-dash in a double-quoted string became a curly quote
// that PowerShell reads as a string delimiter, and the script failed to parse
// before it ran a single line. The fix is a BOM. Any editor that saves "UTF-8
// without BOM" (VS Code's default) silently brings the crash back, and nothing on
// a Linux host would notice. This file is that notice.
//
// Second guard: the steering block install.ps1 appends to ~/.claude/CLAUDE.md
// must stay byte-identical to install.sh's, or Windows and POSIX users get
// different directives (and the marker-guard wording can drift apart).
//
// Pure file reads, no shell, no PowerShell, no network. The predicates are
// plain functions so the NEGATIVE runs here too, on mutated copies: a guard that
// cannot fail is not a guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS1 = fs.readFileSync(path.join(REPO, 'install.ps1'));
const SH = fs.readFileSync(path.join(REPO, 'install.sh'));

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page. That is
 * harmless for pure ASCII and breaks on anything else, so: any byte >= 0x80
 * requires the UTF-8 BOM up front.
 */
function ps1EncodingOk(buf) {
  const nonAscii = buf.some((b) => b >= 0x80);
  return !nonAscii || buf.subarray(0, 3).equals(BOM);
}

/**
 * The body between two marker LINES (exclusive), matched as whole lines, never
 * as substrings. Throws when a marker is missing or ambiguous, so a renamed
 * marker fails loudly instead of comparing two empty strings and passing.
 *
 * CRLF is folded to LF first: Git for Windows' default checkout converts line
 * endings, and install.ps1 itself normalizes the here-string to LF before it
 * writes (release-engineer, run org-20260915T190026Z), so a CRLF working copy
 * is not drift and must not fail the guard on Windows.
 */
function bodyBetween(text, openLine, closeLine, label) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const open = lines.findIndex((l) => l === openLine);
  if (open === -1) throw new Error(`${label}: opening marker line not found: ${JSON.stringify(openLine)}`);
  if (lines.indexOf(openLine, open + 1) !== -1) throw new Error(`${label}: opening marker appears twice`);
  const close = lines.indexOf(closeLine, open + 1);
  if (close === -1) throw new Error(`${label}: closing marker line not found: ${JSON.stringify(closeLine)}`);
  return lines.slice(open + 1, close).join('\n');
}

const ps1Steering = (buf) => bodyBetween(buf.toString('utf8'), "    $steer = @'", "'@", 'install.ps1');
const shSteering = (buf) =>
  bodyBetween(buf.toString('utf8'), `    cat >> "$USER_CLAUDE_MD" <<'EOF'`, 'EOF', 'install.sh');

// ── the guards ───────────────────────────────────────────────────────────────

test('install.ps1: non-ASCII content is saved as UTF-8 WITH a BOM (PowerShell 5.1 parses it)', () => {
  assert.ok(PS1.some((b) => b >= 0x80), 'precondition: install.ps1 carries non-ASCII (else the BOM rule is moot)');
  assert.ok(
    ps1EncodingOk(PS1),
    'install.ps1 has non-ASCII bytes but does not start with EF BB BF. Windows PowerShell 5.1 ' +
      'will decode it as ANSI and fail to parse. Re-save it as "UTF-8 with BOM".',
  );
});

test('install.ps1 and install.sh append a byte-identical steering block', () => {
  const ps1 = ps1Steering(PS1);
  const sh = shSteering(SH);
  // Not vacuous: both bodies are the real 10-line block, carrying its marker.
  assert.equal(sh.split('\n').length, 10, 'install.sh steering body is the 10-line block');
  assert.match(sh, /playwright-mcp/, 'install.sh steering body carries its content');
  assert.equal(ps1, sh, 'the here-string in install.ps1 has drifted from the heredoc in install.sh');
});

// ── the negatives: the same predicates on mutated copies must FAIL ────────────

test('negative: the encoding guard rejects install.ps1 with its BOM stripped', () => {
  assert.ok(PS1.subarray(0, 3).equals(BOM), 'precondition: the real file starts with the BOM');
  const stripped = PS1.subarray(3);
  assert.equal(ps1EncodingOk(stripped), false, 'a BOM-less, non-ASCII copy must be refused');
  // And the rule is about non-ASCII, not about BOMs for their own sake.
  assert.equal(ps1EncodingOk(Buffer.from('Write-Host "plain ascii"\n')), true);
});

test('negative: the parity guard rejects a one-character drift in the steering body', () => {
  const text = PS1.toString('utf8');
  const body = ps1Steering(PS1);
  const at = text.indexOf(body);
  assert.ok(at > 0 && body.length > 0, 'precondition: the body was located in the file');
  // Flip one character in the middle of the body (a letter to a different letter).
  const i = at + Math.floor(body.length / 2);
  const ch = text[i] === 'x' ? 'y' : 'x';
  const drifted = Buffer.from(text.slice(0, i) + ch + text.slice(i + 1), 'utf8');
  assert.notEqual(ps1Steering(drifted), shSteering(SH), 'a one-char drift must be caught');
});

test('a CRLF working copy (Git for Windows checkout) is not drift', () => {
  const crlf = Buffer.from(PS1.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
  assert.equal(ps1Steering(crlf), shSteering(SH));
  assert.equal(ps1EncodingOk(crlf), true, 'line endings do not touch the BOM');
});

test('negative: a missing marker throws rather than comparing two empty bodies', () => {
  const unmarked = Buffer.from(PS1.toString('utf8').replace("    $steer = @'", "    $steer = @\"'"), 'utf8');
  assert.throws(() => ps1Steering(unmarked), /opening marker line not found/);
});

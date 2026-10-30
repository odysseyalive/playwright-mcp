#!/usr/bin/env node
// T1 acceptance — the "I'm signed in" button a human login ends on (src/login-done.ts).
//
// A headed or attach login saves when the person presses the button, never when a
// URL or cookie rule guesses it is done (LinkedIn, 2026-10-30: saved mid-2FA). What
// is pinned here: only the token page answers, a press resolves the wait, the page
// is not told "saved" until the save has happened, and the hint is only a hint.
//
// Browser-free: the button is a loopback HTTP server, driven with fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

import { startDoneButton, looksLikeSignIn } from '../dist/login-done.js';

test('looksLikeSignIn: sign-in steps, including cross-site ones, read as sign-in', () => {
  for (const u of [
    'https://www.linkedin.com/uas/login?session_redirect=x',
    'https://www.linkedin.com/checkpoint/challenge/AgH',
    'https://accounts.google.com/v3/signin/identifier',
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    'https://idp.example.com/sso/saml',
    'https://app.example.com/auth/2fa',
  ]) {
    assert.equal(looksLikeSignIn(u), true, u);
  }
  for (const u of ['https://www.linkedin.com/feed/', 'https://app.example.com/dashboard', 'chrome://newtab/', 'not a url']) {
    assert.equal(looksLikeSignIn(u), false, u);
  }
});

test('done button: only the token page answers; a press resolves; "saved" waits for the save', async () => {
  let tabs = ['https://www.linkedin.com/checkpoint/challenge/x'];
  const b = await startDoneButton('linkedin <x>', async () => tabs);
  try {
    const origin = new URL(b.url).origin;
    assert.match(b.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);

    const page = await fetch(b.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /I'm signed in, save it/);
    assert.match(html, /linkedin &lt;x&gt;/, 'the session name is escaped');

    assert.equal((await fetch(`${origin}/`)).status, 404, 'no token, no page');
    assert.equal((await fetch(`${origin}/${'0'.repeat(32)}/done`, { method: 'POST' })).status, 404, 'a wrong token cannot press');
    assert.equal(b.isPressed(), false);

    assert.deepEqual(await (await fetch(`${b.url}/state`)).json(), { signIn: true }, 'hint while on 2FA');
    tabs = ['https://www.linkedin.com/feed/'];
    assert.deepEqual(await (await fetch(`${b.url}/state`)).json(), { signIn: false });

    let answered = false;
    const press = fetch(`${b.url}/done`, { method: 'POST' }).then((r) => ((answered = true), r.status));
    await b.pressed;
    assert.equal(b.isPressed(), true);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(answered, false, 'the page is not told "saved" before the save happened');

    assert.equal((await fetch(`${b.url}/done`, { method: 'POST' })).status, 409, 'a second press is refused');
    b.finish(true);
    assert.equal(await press, 204);
  } finally {
    b.close();
  }
});

test('done button: closing with a press unanswered tells the page "not saved"', async () => {
  const b = await startDoneButton('x', async () => []);
  const press = fetch(`${b.url}/done`, { method: 'POST' }).then((r) => r.status);
  await b.pressed;
  b.close();
  assert.equal(await press, 409);
});

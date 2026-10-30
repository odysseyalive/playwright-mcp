/**
 * login-done.ts — the human's "I'm signed in" button for a headed or attach login.
 *
 * A login is finished when the person doing it says so. Every rule this server
 * tried for guessing that instead (the URL left the login page, an auth-named
 * cookie appeared, the jar changed and held for two seconds) was wrong for some
 * site: LinkedIn runs 2FA on /checkpoint after the password rotates cookies, SSO
 * hops to another site entirely, an email link finishes in another tab. So the
 * capture window carries one extra tab, served from loopback, with a button. The
 * capture saves when it is pressed, and the window stays up until then.
 *
 * The page sits behind a random token, so another page in that browser cannot
 * press the button for the human. What the hint says (whether a tab still looks
 * like a sign-in page) is advice on the page and nothing else; it never decides.
 */

import crypto from 'node:crypto';
import http from 'node:http';

export interface DoneButton {
  /** The page to open as the extra tab. */
  url: string;
  /** Resolves when the human presses the button. */
  pressed: Promise<void>;
  isPressed(): boolean;
  /**
   * Answer the press. The page says "Saving..." until this is called, so a human
   * never reads "saved" before the cookies have been read out of the window.
   */
  finish(saved: boolean): void;
  close(): void;
}

/**
 * A path or host that reads like a sign-in step. On the button page it is a hint
 * only; web_fetch also uses it to call a REDIRECT to such a page a login wall. Not
 * "challenge": bot walls redirect there, and those must stay walls.
 */
const SIGN_IN_PATH =
  /(^|\/)(login|logon|signin|sign-in|sign_in|uas|checkpoint|2fa|mfa|otp|two-?factor|verify|verification|sso|saml|oauth2?|authorize|auth)(\/|$|\.|-|\?)/i;
const SIGN_IN_HOST = /^(login|auth|accounts?|sso|signin|id|idp)\./i;

export function looksLikeSignIn(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) return false;
    return SIGN_IN_HOST.test(u.hostname) || SIGN_IN_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(name: string, token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Save login: ${escape(name)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:4em auto;padding:0 1em;color:#1a1a1a;background:#fafafa}
h1{font-size:1.3em}button{font:inherit;font-weight:600;padding:.7em 1.4em;border:0;border-radius:6px;background:#0a66c2;color:#fff;cursor:pointer}
button:disabled{background:#888;cursor:default}#hint{color:#8a5a00;min-height:1.5em}.done{color:#0a7a2f;font-weight:600}
</style></head><body>
<h1>playwright-mcp: saving session &ldquo;${escape(name)}&rdquo;</h1>
<p>Finish signing in on the other tab, including any site it sends you to, two-factor codes and email links.
Take as long as you need.</p>
<p>When you are signed in and can see the site's own pages, press the button.</p>
<p id="hint"></p>
<p><button id="b">I'm signed in, save it</button></p>
<p>Close the window to cancel without saving.</p>
<script>
const b=document.getElementById('b'),hint=document.getElementById('hint');
b.onclick=async()=>{b.disabled=true;b.textContent='Saving...';try{const r=await fetch('/${token}/done',{method:'POST'});
document.body.innerHTML=r.ok?'<p class="done">Saved. The window will close on its own.</p>':'<p>Not saved. The tool result says why.</p>';}catch{}};
setInterval(async()=>{try{const s=await (await fetch('/${token}/state')).json();
hint.textContent=s.signIn?'A tab still looks like a sign-in page. If you are not finished there, finish first.':'';}catch{}},2000);
</script></body></html>`;
}

/**
 * Serve the button on loopback. `tabs` lists the URLs open in the capture window,
 * for the hint; a failure there just means no hint.
 */
export async function startDoneButton(name: string, tabs: () => Promise<string[]>): Promise<DoneButton> {
  const token = crypto.randomBytes(16).toString('hex');
  let pressed = false;
  let answer: ((saved: boolean) => void) | undefined;
  let press!: () => void;
  const pressedP = new Promise<void>((r) => (press = r));
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === `/${token}`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(name, token));
    } else if (req.method === 'POST' && path === `/${token}/done`) {
      if (!pressed) {
        answer = (saved) => res.writeHead(saved ? 204 : 409).end();
        pressed = true;
        press();
      } else {
        res.writeHead(409).end(); // a second press: the first one is being saved
      }
    } else if (req.method === 'GET' && path === `/${token}/state`) {
      const urls = await tabs().catch(() => [] as string[]);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ signIn: urls.some(looksLikeSignIn) }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/${token}`,
    pressed: pressedP,
    isPressed: () => pressed,
    finish: (saved) => {
      answer?.(saved);
      answer = undefined;
    },
    close: () => {
      answer?.(false);
      server.closeAllConnections?.();
      server.close();
    },
  };
}

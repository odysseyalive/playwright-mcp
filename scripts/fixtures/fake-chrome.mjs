#!/usr/bin/env node
// A fake "Chrome" for attach-mode tests: it answers the DevTools HTTP endpoint
// sessionAttach polls (/json/version for readiness, /json/list for page targets)
// and nothing else. Passive HTTP reads are the WHOLE contract attach mode has
// with the browser while the human works (no CDP attach — see pollAttached), so
// a fixture that serves those two routes exercises the real cancel/timeout
// decisions with no browser, no display and no wall-clock guessing.
//
// sessionAttach spawns whatever PLAYWRIGHT_MCP_CHROME_PATH points at with
// attachChromeArgs(), so the port arrives in argv and the scenario in the
// environment. POSIX only: the launch goes through this file's shebang, which
// win32 cannot exec (the tests that use it skip there).
//
// Modes (PWMCP_FAKE_CHROME_MODE):
//   die    — answer /json/version once, then exit. Chrome is GONE: the next
//            /json/list read is refused and the capture must CANCEL.
//   alive  — keep answering with one page target that never finishes a login.
//            The capture must end on its DEADLINE, not on a cancel.
//   popup  — an SSO identity provider opens a popup and the ORIGINAL tab closes.
//            Poll 1 shows both pages, every later poll shows only the popup.
//            A page is still open, so this must NOT cancel.
import http from 'node:http';

const port = Number(
  (process.argv.find((a) => a.startsWith('--remote-debugging-port=')) ?? '').split('=')[1],
);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('fake-chrome: no --remote-debugging-port in argv\n');
  process.exit(2);
}

const mode = process.env.PWMCP_FAKE_CHROME_MODE ?? 'alive';

// Deliberately OFF-SITE relative to the tests' loginUrl (app.fake.test): with no
// rendered login-site page attachCookieReadDecision returns 'blocked', so the
// poll loop never tries a CDP connection this fixture could not honour. The page
// COUNT is what the cancel logic reads, and it stays >= 1 in alive/popup.
const ORIGINAL = { type: 'page', url: 'https://idp.fake.test/login', title: 'IdP Login' };
const POPUP = { type: 'page', url: 'https://idp.fake.test/consent?popup=1', title: 'Approve sign-in' };

let listPolls = 0;

const targets = () => {
  listPolls += 1;
  if (mode !== 'popup') return [ORIGINAL];
  // Poll 1: the login tab plus the popup the IdP just opened.
  // Poll 2+: the IdP closed the original tab — one page is still open.
  return listPolls === 1 ? [ORIGINAL, POPUP] : [POPUP];
};

const server = http.createServer((req, res) => {
  const route = (req.url ?? '').split('?')[0];
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (route === '/json/version') {
    // A dead ws URL on purpose: nothing in attach mode's human wait speaks CDP.
    send({
      Browser: 'Chrome/153.0.0.0',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    });
    // Exit only once the response has FLUSHED — exiting first would make
    // waitForDevtools spin its full 20s and throw the wrong error.
    if (mode === 'die') res.on('finish', () => server.close(() => process.exit(0)));
    return;
  }
  if (route === '/json/list') return send(targets());
  res.writeHead(404);
  res.end('{}');
});

// Loopback only, and a hard self-destruct so a crashed test can never leak this.
server.listen(port, '127.0.0.1');
setTimeout(() => process.exit(0), 60_000);

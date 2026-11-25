#!/usr/bin/env node
// T1 acceptance — i19 items 1, 2 and 4 (reported 2026-11-25 from a pythom-space
// session): browser_* file access by root (src/file-roots.ts), the page-side
// file: guard (src/upstream.ts), and the loopback wait on browser_navigate
// (src/loopback-wait.ts).
//
// Upstream's own file check is switched off now (allowUnrestrictedFileAccess), so
// what is pinned here is the ONLY thing between a browser_* call and the disk:
//   - a file inside the project opens; one outside it, one reached through a
//     symlink out of it, and /etc/passwd do not;
//   - a screenshot may go to a scratchpad-shaped path under a claude-<uid> dir
//     this user owns, and not to another user's or an arbitrary /tmp path;
//   - every upstream tool argument that looks like a path is one the check reads;
//   - a loopback server that starts listening late is reached; a refused
//     non-loopback host is not retried.
//
// The rule and the wiring run browser-free, against a stub upstream. The real
// chrome claims sit at the bottom behind PLAYWRIGHT_MCP_TEST_BROWSER=1, on a
// fixture profile root and cwd: this checkout's profile hash belongs to live
// sessions.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { argsRefusal, pathRefusal, urlRefusal, PATH_ARGS } from '../dist/file-roots.js';
import { isLoopbackUrl, refusedConnection, withLoopbackWait } from '../dist/loopback-wait.js';
import { createOutwardServer } from '../dist/index.js';

const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';
const REAL_SKIP = !BROWSER_TESTS && 'opt-in: needs a real chrome (PLAYWRIGHT_MCP_TEST_BROWSER=1)';
// The scratchpad rule is keyed on a uid, which Windows does not have; there it
// grants nothing, and the rule tests below that need one are skipped.
const UID = process.getuid?.() ?? -1;
const POSIX_SKIP = process.platform === 'win32' && 'POSIX uid and symlink semantics';

const saved = {
  PWMCP_PROFILES_DIR_FOR_TEST: process.env.PWMCP_PROFILES_DIR_FOR_TEST,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR,
  PLAYWRIGHT_MCP_LOOPBACK_WAIT_MS: process.env.PLAYWRIGHT_MCP_LOOPBACK_WAIT_MS,
  PLAYWRIGHT_MCP_PUBLIC_URL: process.env.PLAYWRIGHT_MCP_PUBLIC_URL,
};
delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
delete process.env.PLAYWRIGHT_MCP_LOOPBACK_WAIT_MS;
const fixtures = [];
const startCwd = process.cwd();
after(() => {
  process.chdir(startCwd);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureDir(tag) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pwmcp-roots-${tag}-`)));
  fixtures.push(dir);
  return dir;
}

/**
 * A project with a page inside, a page outside, and a symlink out of it; plus a
 * fake tmp base holding a claude-<uid> dir shaped like Claude Code's.
 */
function world() {
  const top = fixtureDir('w');
  const project = path.join(top, 'project');
  const outside = path.join(top, 'outside');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'inside.html'), '<title>inside</title><a id="out" href="file:///etc/hostname">x</a>');
  fs.writeFileSync(path.join(outside, 'secret.html'), '<title>secret</title>');
  fs.symlinkSync(outside, path.join(project, 'escape'));
  const tmp = path.join(top, 'tmp');
  const claude = path.join(tmp, `claude-${UID}`);
  const scratch = path.join(claude, '-home-someone-project', '0b7a6a2e-session', 'scratchpad');
  fs.mkdirSync(scratch, { recursive: true });
  fs.chmodSync(claude, 0o700);
  const env = { cwd: project, uid: UID, tmpBases: [tmp], extra: [] };
  return { top, project, outside, tmp, claude, scratch, env };
}

// ---------------------------------------------------------------- the rule

test('rule: a file inside the project is allowed; outside, through a symlink out, and /etc/passwd are refused', { skip: POSIX_SKIP }, () => {
  const w = world();
  assert.equal(pathRefusal('inside.html', 'stdio', w.env), null, 'relative, resolved against the cwd');
  assert.equal(pathRefusal(path.join(w.project, 'new/dir/shot.png'), 'stdio', w.env), null, 'a file that does not exist yet');
  assert.match(pathRefusal(path.join(w.outside, 'secret.html'), 'stdio', w.env), /outside the allowed roots/);
  assert.match(pathRefusal('escape/secret.html', 'stdio', w.env), /outside the allowed roots/, 'a symlink is judged by where it lands');
  assert.match(pathRefusal('../outside/secret.html', 'stdio', w.env), /outside the allowed roots/);
  assert.match(pathRefusal('/etc/passwd', 'stdio', w.env), /outside the allowed roots/);
  fs.symlinkSync('/nonexistent/target', path.join(w.project, 'dangling'));
  assert.match(pathRefusal('dangling', 'stdio', w.env), /dangling symlink/, 'writing through a dangling link lands wherever it points');
});

test('rule: file: URLs follow the same roots on stdio, and are refused outright on an HTTP surface', { skip: POSIX_SKIP }, () => {
  const w = world();
  const inside = pathToFileURL(path.join(w.project, 'inside.html')).href;
  assert.equal(urlRefusal(inside, 'stdio', w.env), null);
  assert.match(urlRefusal(pathToFileURL(path.join(w.project, 'escape/secret.html')).href, 'stdio', w.env), /outside/);
  assert.match(urlRefusal('file:///etc/passwd', 'stdio', w.env), /outside/);
  assert.match(urlRefusal('FILE:///etc/passwd', 'stdio', w.env), /outside/, 'scheme case does not matter');
  assert.match(urlRefusal('view-source:file:///etc/passwd', 'stdio', w.env), /outside/, 'view-source: wraps a file: URL');
  assert.match(urlRefusal(' view-source:file:///etc/passwd', 'stdio', w.env), /outside/, 'the parser drops a leading space');
  assert.match(urlRefusal('view-\tsource:file:///etc/passwd', 'stdio', w.env), /outside/, 'and an embedded tab');
  assert.match(urlRefusal('file://fileserver/share/x.html', 'stdio', w.env), /not a local path/);
  for (const trust of ['local', 'cloud']) assert.match(urlRefusal(inside, trust, w.env), /blocked on the/);
  assert.equal(urlRefusal('http://localhost:3000/', 'stdio', w.env), null, 'not a file: URL, not this guard');
});

test('rule: a scratchpad-shaped path under this user\'s claude-<uid> dir is allowed on stdio only', { skip: POSIX_SKIP }, () => {
  const w = world();
  const shot = path.join(w.scratch, 'tb-mobile.png');
  assert.equal(pathRefusal(shot, 'stdio', w.env), null);
  assert.equal(pathRefusal(path.join(w.scratch, 'deeper/a.png'), 'stdio', w.env), null);
  assert.match(pathRefusal(shot, 'cloud', w.env), /outside/, 'no scratchpad root on an HTTP surface');
  assert.match(pathRefusal(path.join(w.claude, 'notes.txt'), 'stdio', w.env), /outside/, 'the rest of claude-<uid> is not a root');
  assert.match(pathRefusal(path.join(w.claude, '-p', 'sess', 'started', 'x'), 'stdio', w.env), /outside/);
  assert.match(pathRefusal(path.join(w.tmp, 'shot.png'), 'stdio', w.env), /outside/, 'an arbitrary tmp path');
  assert.match(pathRefusal('/tmp/shot.png', 'stdio', w.env), /outside/);
  // A symlink out of the scratchpad is judged by where it lands.
  fs.symlinkSync(w.outside, path.join(w.scratch, 'out'));
  assert.match(pathRefusal(path.join(w.scratch, 'out/x.png'), 'stdio', w.env), /outside/);
});

test('rule: another user\'s claude dir, a group-writable one, and a symlinked one are not trusted', { skip: POSIX_SKIP }, () => {
  const w = world();
  const shot = path.join(w.scratch, 'x.png');
  // Another uid: the same tree, asked about as uid+1, which does not own it.
  const other = { ...w.env, uid: UID + 1 };
  fs.renameSync(w.claude, path.join(w.tmp, `claude-${UID + 1}`));
  const otherShot = path.join(w.tmp, `claude-${UID + 1}`, '-home-someone-project', '0b7a6a2e-session', 'scratchpad', 'x.png');
  assert.match(pathRefusal(otherShot, 'stdio', other), /outside/, 'owned by someone other than the asking uid');
  assert.match(pathRefusal(otherShot, 'stdio', w.env), /outside/, 'not under this uid\'s own claude dir');
  fs.renameSync(path.join(w.tmp, `claude-${UID + 1}`), w.claude);
  assert.equal(pathRefusal(shot, 'stdio', w.env), null);
  fs.chmodSync(w.claude, 0o770);
  assert.match(pathRefusal(shot, 'stdio', w.env), /outside/, 'group-writable: someone else could have planted it');
  fs.chmodSync(w.claude, 0o700);
  const real = path.join(w.top, 'elsewhere');
  fs.renameSync(w.claude, real);
  fs.symlinkSync(real, w.claude);
  assert.match(pathRefusal(shot, 'stdio', w.env), /outside/, 'a symlinked claude-<uid> is not the real one');
});

test('rule: PLAYWRIGHT_MCP_FILE_ROOTS adds a root on stdio and nowhere else', { skip: POSIX_SKIP }, () => {
  const w = world();
  const env = { ...w.env, extra: [w.outside] };
  const secret = path.join(w.outside, 'secret.html');
  assert.equal(pathRefusal(secret, 'stdio', env), null);
  assert.match(pathRefusal(secret, 'local', env), /outside/);
  assert.match(pathRefusal(secret, 'cloud', env), /outside/);
});

test('rule: argsRefusal reads filename, every entry of paths, and url', { skip: POSIX_SKIP }, () => {
  const w = world();
  assert.equal(argsRefusal({ filename: 'a.png' }, 'stdio', w.env), null);
  assert.match(argsRefusal({ filename: '/etc/passwd' }, 'stdio', w.env), /denied/);
  assert.match(argsRefusal({ paths: ['inside.html', '/etc/passwd'] }, 'stdio', w.env), /\/etc\/passwd/);
  assert.match(argsRefusal({ url: 'file:///etc/passwd' }, 'stdio', w.env), /refused/);
  assert.equal(argsRefusal({ url: 'https://example.com/' }, 'stdio', w.env), null);
  assert.equal(argsRefusal(undefined, 'stdio', w.env), null);
});

test('drift: every path-like argument of every upstream tool is one argsRefusal reads', async () => {
  // Upstream's check is OFF, so a new upstream tool taking a path under a name
  // this server does not read would reach the disk unchecked. listTools launches
  // no browser; the fixture cache keeps the init-script write out of ~/.cache.
  const cache = fixtureDir('drift');
  process.env.XDG_CACHE_HOME = cache;
  process.env.PWMCP_PROFILES_DIR_FOR_TEST = cache;
  const { initUpstream, closeUpstream } = await import('../dist/upstream.js');
  const client = await initUpstream();
  try {
    const { tools } = await client.listTools();
    const unread = [];
    for (const t of tools)
      for (const k of Object.keys(t.inputSchema.properties ?? {}))
        if (/file|path|dir|folder/i.test(k) && !PATH_ARGS.includes(k)) unread.push(`${t.name}.${k}`);
    assert.deepEqual(unread, [], 'add these to src/file-roots.ts argsRefusal, or say why they are not paths');
    const withPaths = tools.filter((t) => PATH_ARGS.some((k) => k in (t.inputSchema.properties ?? {}))).map((t) => t.name);
    for (const name of ['browser_take_screenshot', 'browser_snapshot', 'browser_file_upload', 'browser_drop'])
      assert.ok(withPaths.includes(name), `${name} still takes a path the check reads`);
  } finally {
    await closeUpstream();
  }
});

// ---------------------------------------------------------------- loopback

test('loopback: only localhost, *.localhost, 127/8 and ::1 count', () => {
  for (const u of ['http://localhost:3000/', 'http://127.0.0.1:5173/x', 'http://127.1.2.3/', 'http://[::1]:4000/', 'https://app.localhost/'])
    assert.ok(isLoopbackUrl(u), u);
  for (const u of ['https://example.com/', 'http://10.0.0.1/', 'http://192.168.1.2:3000/', 'file:///tmp/x.html', 'http://localhost.example.com/', 'example.com'])
    assert.ok(!isLoopbackUrl(u), u);
});

const refused = (url) => ({
  content: [{ type: 'text', text: `### Error\nError: page.goto: net::ERR_CONNECTION_REFUSED at ${url}` }],
  isError: true,
});

test('loopback: retries a refused call until it succeeds and says it waited', async () => {
  let n = 0;
  const out = await withLoopbackWait(async () => (++n < 3 ? refused('x') : { content: [{ type: 'text', text: 'ok' }] }), { budgetMs: 5000 });
  assert.equal(n, 3);
  assert.ok(!out.isError);
  assert.match(out.content.at(-1).text, /was not listening yet; waited [\d.]+s \(3 tries\)/);
});

test('loopback: gives up at the budget, says so, and leaves other errors alone', async () => {
  let n = 0;
  const t0 = Date.now();
  const out = await withLoopbackWait(async () => (n++, refused('x')), { budgetMs: 600 });
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(n >= 2 && refusedConnection(out));
  assert.match(out.content.at(-1).text, /never started listening/);
  n = 0;
  const other = { content: [{ type: 'text', text: 'net::ERR_NAME_NOT_RESOLVED' }], isError: true };
  assert.equal(await withLoopbackWait(async () => (n++, other), { budgetMs: 5000 }), other);
  assert.equal(n, 1, 'only a refused connection is retried');
});

/** A stub upstream that records each call and answers from `reply`. */
async function outward(reply, trust) {
  const upstream = {
    calls: [],
    listTools: async () => ({
      tools: ['browser_navigate', 'browser_take_screenshot', 'browser_file_upload'].map((name) => ({
        name,
        inputSchema: { type: 'object', properties: { url: { type: 'string' }, filename: { type: 'string' } } },
      })),
    }),
    async callTool({ name, arguments: args }) {
      this.calls.push({ name, args });
      return reply(name, args, this.calls.length);
    },
  };
  const { tools } = await upstream.listTools();
  const server = createOutwardServer(() => upstream, tools, trust ? { trust } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
  return { client, upstream };
}

test('proxy: a refused non-loopback host is not retried; a refused loopback one is', async () => {
  process.env.PLAYWRIGHT_MCP_LOOPBACK_WAIT_MS = '3000';
  try {
    const { client, upstream } = await outward((_n, args, i) => (i < 3 || !/localhost/.test(args.url) ? refused(args.url) : { content: [{ type: 'text', text: 'ok' }] }));
    const remote = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://public.test/' } });
    assert.ok(remote.isError);
    assert.equal(upstream.calls.length, 1, 'one call, no retry');
    upstream.calls.length = 0;
    const local = await client.callTool({ name: 'browser_navigate', arguments: { url: 'http://localhost:3999/' } });
    assert.ok(!local.isError, 'reached on the third try');
    assert.equal(upstream.calls.length, 3);
    assert.ok(local.content.some((b) => /waited/.test(b.text ?? '')));
  } finally {
    delete process.env.PLAYWRIGHT_MCP_LOOPBACK_WAIT_MS;
  }
});

test('proxy: a refused path or file: URL never reaches upstream, on any surface', { skip: POSIX_SKIP }, async () => {
  const w = world();
  process.chdir(w.project);
  try {
    for (const trust of [undefined, 'local', 'cloud']) {
      const { client, upstream } = await outward(() => ({ content: [{ type: 'text', text: 'ok' }] }), trust);
      for (const [name, args] of [
        ['browser_take_screenshot', { filename: '/etc/passwd' }],
        ['browser_take_screenshot', { filename: 'escape/x.png' }],
        ['browser_file_upload', { paths: ['/etc/passwd'] }],
        ['browser_navigate', { url: 'file:///etc/passwd' }],
      ]) {
        const r = await client.callTool({ name, arguments: args });
        assert.ok(r.isError, `${trust ?? 'stdio'} ${name} ${JSON.stringify(args)}`);
      }
      assert.equal(upstream.calls.length, 0, 'nothing was forwarded');
      const ok = await client.callTool({ name: 'browser_take_screenshot', arguments: { filename: 'shot.png' } });
      assert.ok(!ok.isError, 'a path in the project still goes through');
    }
    const { client } = await outward(() => ({ content: [] }));
    const nav = (await client.listTools()).tools.find((t) => t.name === 'browser_navigate');
    assert.match(nav.description, /file:\/\/ URL opens/);
    assert.match(nav.description, /retried for up to 10s/);
  } finally {
    process.chdir(startCwd);
  }
});

// ---------------------------------------------------------------- real chrome

/**
 * The real upstream behind a real stdio-tier outward server, on a fixture profile
 * root, cache and cwd. closeUpstream() takes its chrome down with it.
 */
async function realServer(w) {
  process.env.PWMCP_PROFILES_DIR_FOR_TEST = path.join(w.top, 'profiles');
  process.env.XDG_CACHE_HOME = path.join(w.top, 'cache');
  process.env.CLAUDE_CODE_TMPDIR = w.tmp;
  process.chdir(w.project);
  const up = await import('../dist/upstream.js');
  const upstreamClient = await up.initUpstream();
  const { tools } = await upstreamClient.listTools();
  const server = createOutwardServer(up.getUpstream, tools);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
  return {
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close().catch(() => {});
      await up.closeUpstream();
      process.chdir(startCwd);
      delete process.env.CLAUDE_CODE_TMPDIR;
    },
  };
}

const text = (r) => r.content.map((b) => b.text ?? '').join('\n');

test('real: file:// inside the project opens; outside, through a symlink, /etc/passwd and a link out stay blocked', { skip: REAL_SKIP || POSIX_SKIP }, async () => {
  const w = world();
  const s = await realServer(w);
  try {
    const ok = await s.call('browser_navigate', { url: pathToFileURL(path.join(w.project, 'inside.html')).href });
    assert.ok(!ok.isError, text(ok));
    assert.match(text(ok), /inside/);
    for (const url of [
      pathToFileURL(path.join(w.outside, 'secret.html')).href,
      pathToFileURL(path.join(w.project, 'escape', 'secret.html')).href,
      'file:///etc/passwd',
      'view-source:file:///etc/passwd',
    ]) {
      const r = await s.call('browser_navigate', { url });
      assert.ok(r.isError, `${url} must be refused`);
      assert.doesNotMatch(text(r), /secret<|root:x:0/);
    }
    // The page's own link out of the root: the call handler never sees that URL,
    // only the page-side guard does. Upstream writes the snapshot to a file; the
    // link's ref is read from there.
    const back = await s.call('browser_snapshot', {});
    const yml = /\((\.playwright-mcp\/[^)]+\.yml)\)/.exec(text(back))?.[1];
    const tree = yml ? fs.readFileSync(path.join(w.project, yml), 'utf8') : text(back);
    const ref = /link "x" \[ref=(\w+)\]/.exec(tree)?.[1];
    assert.ok(ref, 'the link is in the snapshot');
    const click = await s.call('browser_click', { element: 'x link', target: ref });
    assert.doesNotMatch(text(click), /Page URL: file:\/\/\/etc\/hostname/, text(click));
  } finally {
    await s.close();
  }
});

test('real: a screenshot goes to a scratchpad-shaped path, not to another user\'s or an arbitrary /tmp path', { skip: REAL_SKIP || POSIX_SKIP }, async () => {
  const w = world();
  const s = await realServer(w);
  try {
    await s.call('browser_navigate', { url: pathToFileURL(path.join(w.project, 'inside.html')).href });
    const shot = path.join(w.scratch, 'tb-mobile.png');
    const ok = await s.call('browser_take_screenshot', { filename: shot });
    assert.ok(!ok.isError, text(ok));
    assert.ok(fs.statSync(shot).size > 0, 'the PNG is in the scratchpad');
    const otherUser = path.join(w.tmp, `claude-${UID + 1}`, '-p', 's', 'scratchpad', 'x.png');
    const arbitrary = path.join(w.tmp, 'x.png');
    for (const filename of [otherUser, arbitrary]) {
      const r = await s.call('browser_take_screenshot', { filename });
      assert.ok(r.isError, `${filename} must be refused`);
      assert.ok(!fs.existsSync(filename));
    }
  } finally {
    await s.close();
  }
});

test('real: a loopback server that starts listening ~1.5s after navigate is reached', { skip: REAL_SKIP || POSIX_SKIP }, async () => {
  const w = world();
  // Take a free port, let it go, and bind it again late.
  const port = await new Promise((r) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => r(p));
    });
  });
  const late = http.createServer((_q, res) => res.end('<title>late server</title>'));
  const timer = setTimeout(() => late.listen(port, '127.0.0.1'), 1500);
  const s = await realServer(w);
  try {
    const r = await s.call('browser_navigate', { url: `http://127.0.0.1:${port}/` });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /late server/);
    assert.match(text(r), /was not listening yet; waited/);
  } finally {
    clearTimeout(timer);
    late.close();
    await s.close();
  }
});

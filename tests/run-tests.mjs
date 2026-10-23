#!/usr/bin/env node
// DELIGHT MCP server test runner  (delight-tests 2026-10-08)
// Starts each built server, talks to it the way an AI app does, and checks what it really does.
//   node tests/run-tests.mjs                   everything
//   node tests/run-tests.mjs --offline         skip checks that need the internet
//   node tests/run-tests.mjs --only=memory,fetch
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ONLY = (argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const OFFLINE = argv.includes('--offline');
const COLOR = process.stdout.isTTY && !argv.includes('--no-color');
const paint = (n, s) => COLOR ? `\x1b[${n}m${s}\x1b[0m` : s;
const LOG = [];
const say = (s = '') => { console.log(s); LOG.push(String(s).replace(/\x1b\[[0-9;]*m/g, '')); };

// ------------------------------------------------------------------ MCP client over stdio
class Mcp {
  constructor(folder, env = {}) {
    this.folder = folder; this.env = env; this.id = 0; this.pending = new Map();
    this.buf = ''; this.stderr = ''; this.done = false; this.code = null;
  }
  start() {
    const entry = path.join(ROOT, this.folder, 'dist', 'index.js');
    if (!fs.existsSync(entry)) throw new Error(`not built: ${entry}  (run "npm install" then "npm run build" in ${this.folder})`);
    this.proc = spawn(process.execPath, [entry], {
      cwd: path.join(ROOT, this.folder), env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', d => this.onData(String(d)));
    this.proc.stderr.on('data', d => { this.stderr += d; });
    this.exitP = new Promise(res => this.proc.on('exit', code => {
      this.done = true; this.code = code;
      for (const p of this.pending.values()) p.reject(new Error(`server exited (code ${code}). Its log said: ${this.stderr.trim().slice(-300)}`));
      this.pending.clear(); res(code);
    }));
    this.proc.on('error', e => { this.done = true; for (const p of this.pending.values()) p.reject(e); });
  }
  onData(chunk) {
    this.buf += chunk; let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        p.resolve(m.error ? { error: m.error } : { result: m.result });
      }
    }
  }
  rpc(method, params, ms = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`no answer to ${method} after ${ms / 1000}s`)); }, ms);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  async init() {
    const r = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'delight-tests', version: '1' } }, 20000);
    if (r.error) throw new Error('initialize failed: ' + JSON.stringify(r.error));
    this.info = r.result.serverInfo || {}; this.notify('notifications/initialized'); return r.result;
  }
  async tools() {
    const r = await this.rpc('tools/list', {});
    if (r.error) throw new Error('tools/list failed: ' + JSON.stringify(r.error));
    return r.result.tools.map(t => t.name);
  }
  async call(name, args = {}, ms = 30000) {
    const r = await this.rpc('tools/call', { name, arguments: args }, ms);
    if (r.error) return { isError: true, rpcError: true, text: 'RPC error: ' + (r.error.message || JSON.stringify(r.error)), content: [] };
    const content = r.result.content || [];
    return { isError: !!r.result.isError, text: content.filter(x => x.type === 'text').map(x => x.text).join('\n'), content };
  }
  stop() {
    if (!this.proc || this.done) return;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else this.proc.kill();
    } catch { /* already gone */ }
  }
}

// ------------------------------------------------------------------ tiny test framework
const stats = {}; let suiteName = '';
const bump = k => { stats[suiteName] ??= { PASS: 0, FAIL: 0, SKIP: 0 }; stats[suiteName][k]++; };
const FAILS = [];
function record(kind, name, why = '') {
  bump(kind);
  const tag = kind === 'PASS' ? paint(32, 'PASS') : kind === 'FAIL' ? paint(31, 'FAIL') : paint(33, 'SKIP');
  say(`  ${tag}  ${name}${why ? '\n          ' + why : ''}`);
  if (kind === 'FAIL') FAILS.push(`${suiteName}: ${name} -> ${why}`);
}
const skip = why => { const e = new Error(why); e.skip = true; throw e; };
const ok = (c, m) => { if (!c) throw new Error(m || 'check failed'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'values differ'}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); };
const has = (t, n, m) => ok(String(t).toLowerCase().includes(String(n).toLowerCase()), `${m || 'missing text'}: wanted ${JSON.stringify(n)} in ${JSON.stringify(String(t).slice(0, 260))}`);
const lacks = (t, n, m) => ok(!String(t).toLowerCase().includes(String(n).toLowerCase()), `${m || 'unexpected text'}: found ${JSON.stringify(n)} in ${JSON.stringify(String(t).slice(0, 260))}`);
const fails = (r, m) => ok(r.isError, `${m || 'should have been refused'} but it succeeded: ${JSON.stringify(r.text.slice(0, 200))}`);
async function check(name, fn, { net = false, ms = 60000 } = {}) {
  if (net && OFFLINE) return record('SKIP', name, 'needs the internet (--offline)');
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`took longer than ${ms / 1000}s`)), ms); })]);
    record('PASS', name);
  } catch (e) { e && e.skip ? record('SKIP', name, e.message) : record('FAIL', name, (e && e.message) || String(e)); }
  finally { clearTimeout(timer); }
}
async function open(folder, env = {}) { const s = new Mcp(folder, env); s.start(); await s.init(); return s; }
async function suite(name, folder, fn) {
  if (ONLY.length && !ONLY.some(o => name.includes(o) || folder.includes(o))) return;
  suiteName = name; say(); say(paint(1, `== ${name}`));
  try { await fn(); } catch (e) { record('FAIL', 'could not start the server', e.message); }
}
async function expectFatal(folder, env, re) {
  const s = new Mcp(folder, env); s.start();
  const code = await Promise.race([s.exitP, new Promise(r => setTimeout(() => r('still-running'), 10000))]);
  s.stop();
  ok(code !== 'still-running', 'kept running although required settings were missing');
  ok(code !== 0, 'exited with code 0 although required settings were missing');
  has(s.stderr, 'FATAL', 'no FATAL message in its log');
  if (re) has(s.stderr, re, 'wrong explanation in its log');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'delight-tests-'));
const tmp = n => path.join(TMP, n);
const BRAND = 'Bryt Matech UG';
const TOOLS = {
  'filesystem-mcp-server': ['list_directory', 'read_file', 'write_file', 'create_directory', 'delete_file'],
  'fetch-mcp-server': ['fetch_url'],
  'memory-mcp-server': ['remember', 'recall', 'list_memories', 'update_memory', 'forget'],
  'playwright-mcp-server': ['navigate', 'get_page_text', 'click', 'fill', 'screenshot', 'list_pages', 'close_page'],
  'github-mcp-server': ['search_repositories', 'get_repository', 'list_issues', 'get_issue', 'list_pull_requests', 'get_pull_request', 'search_code'],
  'postgres-mcp-server': ['list_schemas', 'list_tables', 'describe_table', 'run_query'],
  'stripe-mcp-server': ['list_customers', 'get_customer', 'list_charges', 'create_customer', 'create_refund'],
  'slack-mcp-server': ['list_channels', 'get_channel_history', 'get_user_info', 'post_message'],
  'google-drive-mcp-server': ['search_files', 'list_files', 'get_file_metadata', 'read_file_content'],
  'notion-mcp-server': ['search', 'get_page', 'get_page_content', 'query_database']
};
async function basics(s, folder) {
  await check('starts and says hello, with a clean name, a version, and your branding', async () => { ok(/^[a-z-]+-mcp-server$/.test(s.info.name), 'server name: ' + s.info.name); ok(/^\d+\.\d+\.\d+/.test(String(s.info.version)), 'server version: ' + s.info.version); has(fs.readFileSync(new URL('../' + s.info.name + '/dist/index.js', import.meta.url), 'utf8'), BRAND, 'branding in built code'); });
  await check('offers exactly the expected tools', async () => {
    const got = (await s.tools()).sort(), want = [...TOOLS[folder]].sort();
    eq(got.join(','), want.join(','), 'tool list');
  });
}
const json = r => JSON.parse(r.text);

// ------------------------------------------------------------------ FILESYSTEM
await suite('Filesystem', 'filesystem-mcp-server', async () => {
  const base = tmp('fs'); fs.mkdirSync(base); const root = path.join(base, 'allowed'); fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'allowed-evil'));
  const s = await open('filesystem-mcp-server', { ALLOWED_DIR: root, MAX_FILE_BYTES: '1000' });
  try {
    await basics(s, 'filesystem-mcp-server');
    await check('write then read gives back exactly what was written', async () => {
      const text = 'Hello Uganda\nline two \u2713';
      ok(!(await s.call('write_file', { path: 'a.txt', content: text })).isError, 'write refused');
      eq((await s.call('read_file', { path: 'a.txt' })).text, text, 'content');
    });
    await check('writing into a new nested folder creates it', async () => {
      ok(!(await s.call('write_file', { path: 'sub/dir/b.txt', content: 'x' })).isError, 'write refused');
      ok(fs.existsSync(path.join(root, 'sub', 'dir', 'b.txt')), 'file not on disk');
    });
    await check('list_directory shows files and folders', async () => {
      const t = (await s.call('list_directory', { path: '.' })).text;
      has(t, '[file] a.txt'); has(t, '[dir]  sub');
    });
    await check('create_directory works', async () => {
      ok(!(await s.call('create_directory', { path: 'newdir/inner' })).isError, 'refused');
      ok(fs.statSync(path.join(root, 'newdir', 'inner')).isDirectory(), 'not created');
    });
    await check('reading a missing file is an error, not a crash', async () => fails(await s.call('read_file', { path: 'nope.txt' })));
    await check('path traversal (../) is refused and nothing is written outside', async () => {
      fails(await s.call('write_file', { path: '../escaped.txt', content: 'bad' }));
      ok(!fs.existsSync(path.join(base, 'escaped.txt')), 'a file was written outside the allowed folder!');
    });
    await check('a sibling folder with a similar name is refused', async () => {
      fails(await s.call('write_file', { path: '../allowed-evil/x.txt', content: 'bad' }));
      ok(!fs.existsSync(path.join(base, 'allowed-evil', 'x.txt')), 'escaped into a look-alike folder!');
    });
    await check('an absolute path outside the folder is refused', async () => {
      const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
      const r = await s.call('read_file', { path: outside }); fails(r); has(r.text, 'outside the allowed');
    });
    await check('files over the size limit are refused', async () => {
      await s.call('write_file', { path: 'big.txt', content: 'x'.repeat(2000) });
      const r = await s.call('read_file', { path: 'big.txt' }); fails(r); has(r.text, 'limit');
    });
    await check('delete_file removes a file', async () => {
      ok(!(await s.call('delete_file', { path: 'a.txt' })).isError, 'refused');
      ok(!fs.existsSync(path.join(root, 'a.txt')), 'still on disk');
    });
    await check('delete_file refuses to delete a folder', async () => {
      fails(await s.call('delete_file', { path: 'sub' })); ok(fs.existsSync(path.join(root, 'sub')), 'folder was deleted');
    });
  } finally { s.stop(); }
});

// ------------------------------------------------------------------ MEMORY
await suite('Memory', 'memory-mcp-server', async () => {
  const file = tmp('memory.json');
  let s = await open('memory-mcp-server', { MEMORY_FILE: file });
  let id1;
  try {
    await basics(s, 'memory-mcp-server');
    await check('remember stores a note with an id and tags', async () => {
      const r = await s.call('remember', { content: 'My favourite colour is blue', tags: ['preferences'] });
      ok(!r.isError, r.text); const e = json(r).stored; id1 = e.id;
      ok(/^[0-9a-f-]{36}$/.test(e.id), 'id is not a UUID'); eq(e.tags[0], 'preferences', 'tag');
    });
    await check('recall finds it by keyword, and ignores case', async () => {
      const r = json(await s.call('recall', { query: 'COLOUR' })); eq(r.count, 1, 'count'); has(r.results[0].content, 'blue');
    });
    await check('recall returns nothing for an unrelated word', async () => eq(json(await s.call('recall', { query: 'vehicle' })).count, 0, 'count'));
    await check('better matches rank first', async () => {
      await s.call('remember', { content: 'blue sky today' });
      const r = json(await s.call('recall', { query: 'blue colour' }));
      eq(r.count, 2, 'count'); has(r.results[0].content, 'favourite colour', 'best match should be first');
    });
    await check('list_memories reports the total, newest first', async () => {
      const r = json(await s.call('list_memories', {})); eq(r.total_stored, 2, 'total'); has(r.results[0].content, 'blue sky');
    });
    await check('tag filter works', async () => eq(json(await s.call('list_memories', { tag: 'preferences' })).returned, 1, 'returned'));
    await check('update_memory changes the note', async () => {
      ok(!(await s.call('update_memory', { id: id1, content: 'My favourite colour is green' })).isError, 'refused');
      eq(json(await s.call('recall', { query: 'green' })).count, 1, 'new word');
      eq(json(await s.call('recall', { query: 'favourite' })).results[0].content.includes('green'), true, 'old text replaced');
    });
    await check('update_memory with an unknown id is an error', async () => fails(await s.call('update_memory', { id: '11111111-1111-4111-8111-111111111111', content: 'x' })));
    await check('update_memory with a malformed id is rejected', async () => fails(await s.call('update_memory', { id: 'abc', content: 'x' })));
    await check('the notes file on disk is valid JSON', async () => { const a = JSON.parse(fs.readFileSync(file, 'utf8')); ok(Array.isArray(a) && a.length === 2, 'wrong content'); });
  } finally { s.stop(); }
  await check('notes survive a restart', async () => {
    const s2 = await open('memory-mcp-server', { MEMORY_FILE: file });
    try { eq(json(await s2.call('list_memories', {})).total_stored, 2, 'total after restart'); } finally { s2.stop(); }
  });
  await check('forget deletes, and forgetting twice is an error', async () => {
    const s3 = await open('memory-mcp-server', { MEMORY_FILE: file });
    try {
      ok(!(await s3.call('forget', { id: id1 })).isError, 'refused'); fails(await s3.call('forget', { id: id1 }));
      eq(json(await s3.call('list_memories', {})).total_stored, 1, 'total');
    } finally { s3.stop(); }
  });
  await check('20 notes saved at the same moment are all kept', async () => {
    const f2 = tmp('burst.json'); const s4 = await open('memory-mcp-server', { MEMORY_FILE: f2 });
    try {
      await Promise.all(Array.from({ length: 20 }, (_, i) => s4.call('remember', { content: 'note ' + i })));
      eq(json(await s4.call('list_memories', { limit: 100 })).total_stored, 20, 'total'); eq(JSON.parse(fs.readFileSync(f2, 'utf8')).length, 20, 'on disk');
    } finally { s4.stop(); }
  });
  await check('the size cap stops runaway growth', async () => {
    const s5 = await open('memory-mcp-server', { MEMORY_FILE: tmp('cap.json'), MAX_ENTRIES: '2' });
    try { await s5.call('remember', { content: 'a' }); await s5.call('remember', { content: 'b' }); const r = await s5.call('remember', { content: 'c' }); fails(r); has(r.text, 'full'); }
    finally { s5.stop(); }
  });
});

// ------------------------------------------------------------------ WEB FETCH
await suite('Web Fetch', 'fetch-mcp-server', async () => {
  const s = await open('fetch-mcp-server', {});
  try {
    await basics(s, 'fetch-mcp-server');
    for (const [url, want] of [['http://127.0.0.1', 'Refusing'], ['http://localhost:3000', 'Refusing'], ['http://[::1]/', 'Refusing'],
      ['http://[::ffff:127.0.0.1]/', 'Refusing'], ['http://169.254.169.254/latest/meta-data/', 'Refusing'], ['http://10.0.0.1/', 'Refusing'],
      ['http://192.168.1.1/', 'Refusing'], ['http://printer.local/', 'Refusing'], ['file:///C:/Windows/win.ini', 'Unsupported protocol'], ['ftp://example.com/x', 'Unsupported protocol']])
      await check(`refuses ${url}`, async () => { const r = await s.call('fetch_url', { url }); fails(r); has(r.text, want); });
    await check('a malformed URL is rejected', async () => fails(await s.call('fetch_url', { url: 'not a url' })));
    await check('example.com: cleaned page has a title, text, and no CSS or scripts', async () => {
      const r = await s.call('fetch_url', { url: 'https://example.com' }); ok(!r.isError, r.text);
      ok(r.text.startsWith('Title: Example Domain'), 'missing Title line'); has(r.text, 'URL: https://example.com/'); has(r.text, 'domain');
      for (const junk of ['background', 'font:', '<style', '<script', 'color-scheme']) lacks(r.text, junk, 'page junk leaked through');
    }, { net: true });
    await check('raw=true returns the page source', async () => has((await s.call('fetch_url', { url: 'https://example.com', raw: true })).text, '<html'), { net: true });
    await check('a 404 is reported as an error', async () => { const r = await s.call('fetch_url', { url: 'https://example.com/definitely-not-a-page-404' }); fails(r); has(r.text, '404'); }, { net: true });
    await check('an image is refused with a clear message', async () => { const r = await s.call('fetch_url', { url: 'https://www.google.com/favicon.ico' }); fails(r); has(r.text, 'not a web page'); }, { net: true });
    await check('a redirect is followed and the final address is shown', async () => {
      const r = await s.call('fetch_url', { url: 'http://github.com' });
      if (r.isError && /\b(403|429)\b/.test(r.text)) skip('github.com blocks automated readers right now');
      ok(!r.isError, r.text); has(r.text, 'URL: https://github.com');
    }, { net: true });
    await check('long pages are cut with a continue hint, and start_index continues', async () => {
      const a = await s.call('fetch_url', { url: 'https://en.wikipedia.org/wiki/Kampala' });
      if (a.isError && /\b(403|429)\b/.test(a.text)) skip('wikipedia blocks automated readers right now');
      ok(!a.isError, a.text); has(a.text, 'Truncated'); has(a.text, 'start_index=20000');
      const b = await s.call('fetch_url', { url: 'https://en.wikipedia.org/wiki/Kampala', start_index: 20000 });
      ok(!b.isError, b.text); ok(b.text.slice(0, 80) !== a.text.slice(0, 80), 'second chunk repeats the first');
    }, { net: true });
  } finally { s.stop(); }
});

// ------------------------------------------------------------------ BROWSER PILOT
await suite('Browser Pilot', 'playwright-mcp-server', async () => {
  const s = await open('playwright-mcp-server', { MAX_PAGES: '2', ACTION_TIMEOUT_MS: '3000', HEADLESS: 'true' });
  try {
    await basics(s, 'playwright-mcp-server');
    await check('refuses localhost', async () => { const r = await s.call('navigate', { url: 'http://localhost:3000' }); fails(r); has(r.text, 'Refusing'); });
    await check('refuses a private address', async () => fails(await s.call('navigate', { url: 'http://192.168.1.1/' })));
    await check('refuses file: pages', async () => fails(await s.call('navigate', { url: 'file:///C:/Windows/win.ini' })));
    await check('get_page_text before navigating is a clear error', async () => fails(await s.call('get_page_text', {})));
    await check('navigate opens a real page', async () => {
      const r = await s.call('navigate', { url: 'https://example.com' }, 60000); ok(!r.isError, r.text); has(r.text, 'Example Domain'); has(r.text, '200');
    }, { net: true, ms: 90000 });
    await check('get_page_text reads it', async () => has((await s.call('get_page_text', {})).text, 'domain'), { net: true });
    await check('screenshot returns a real PNG image', async () => {
      const r = await s.call('screenshot', {}); const img = r.content.find(x => x.type === 'image'); ok(img, 'no image in the answer');
      eq(img.mimeType, 'image/png', 'type'); ok(img.data.length > 1500, 'image looks empty');
    }, { net: true });
    await check('list_pages shows the open page', async () => has((await s.call('list_pages', {})).text, 'example.com'), { net: true });
    await check('a second page can be opened and closed', async () => {
      await s.call('navigate', { url: 'https://example.com', page_id: 'two' }, 60000);
      has((await s.call('list_pages', {})).text, 'two'); ok(!(await s.call('close_page', { page_id: 'two' })).isError, 'close failed');
    }, { net: true, ms: 90000 });
    await check('clicking something that is not there is an error, not a hang', async () => fails(await s.call('click', { selector: '#nope-not-here' })), { net: true });
    await check('the open-page limit is enforced', async () => {
      await s.call('navigate', { url: 'https://example.com', page_id: 'p2' }, 60000);
      const r = await s.call('navigate', { url: 'https://example.com', page_id: 'p3' }, 60000); fails(r); has(r.text, 'Maximum');
    }, { net: true, ms: 120000 });
  } finally { s.stop(); }
});

// ------------------------------------------------------------------ servers that need keys (no keys used here)
const NEEDS = {
  'github-mcp-server': [{ GITHUB_TOKEN: '' }, 'GITHUB_TOKEN'],
  'postgres-mcp-server': [{ DATABASE_URL: '' }, 'DATABASE_URL'],
  'stripe-mcp-server': [{ STRIPE_SECRET_KEY: '' }, 'STRIPE_SECRET_KEY'],
  'slack-mcp-server': [{ SLACK_CLIENT_ID: '', SLACK_CLIENT_SECRET: '' }, 'SLACK_CLIENT_ID'],
  'google-drive-mcp-server': [{ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, 'GOOGLE_CLIENT_ID'],
  'notion-mcp-server': [{ NOTION_CLIENT_ID: '', NOTION_CLIENT_SECRET: '' }, 'NOTION_CLIENT_ID']
};
const DUMMY = {
  'github-mcp-server': { GITHUB_TOKEN: 'ghp_dummy_for_tests' },
  'postgres-mcp-server': { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' },
  'stripe-mcp-server': { STRIPE_SECRET_KEY: 'sk_test_dummy_for_tests' },
  'slack-mcp-server': { SLACK_CLIENT_ID: 'x', SLACK_CLIENT_SECRET: 'y', TOKEN_FILE: tmp('slack.json') },
  'google-drive-mcp-server': { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', TOKEN_FILE: tmp('google.json') },
  'notion-mcp-server': { NOTION_CLIENT_ID: 'x', NOTION_CLIENT_SECRET: 'y', TOKEN_FILE: tmp('notion.json') }
};
for (const [label, folder] of [['GitHub', 'github-mcp-server'], ['Database', 'postgres-mcp-server'], ['Payments (Stripe)', 'stripe-mcp-server'],
  ['Slack', 'slack-mcp-server'], ['Drive', 'google-drive-mcp-server'], ['Notion', 'notion-mcp-server']]) {
  await suite(label, folder, async () => {
    await check('refuses to start without its credentials, and says which ones', () => expectFatal(folder, NEEDS[folder][0], NEEDS[folder][1]));
    const s = await open(folder, DUMMY[folder]);
    try {
      await basics(s, folder);
      if (folder === 'github-mcp-server') await check('a fake token reaches GitHub and is rejected cleanly (401)', async () => {
        const r = await s.call('get_repository', { owner: 'octocat', repo: 'Hello-World' }); fails(r); has(r.text, '401');
      }, { net: true });
      if (folder === 'postgres-mcp-server') {
        await check('DROP TABLE is refused before touching any database', async () => { const r = await s.call('run_query', { sql: 'DROP TABLE users' }); fails(r); has(r.text, 'Only SELECT'); });
        await check('two statements at once are refused', async () => { const r = await s.call('run_query', { sql: 'select 1; select 2' }); fails(r); has(r.text, 'Multiple'); });
        await check('a DELETE hidden inside a WITH is refused', async () => fails(await s.call('run_query', { sql: 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x' })));
        await check('INSERT, UPDATE and TRUNCATE are refused', async () => {
          for (const sql of ['insert into t values (1)', 'update t set a=1', 'truncate t']) fails(await s.call('run_query', { sql }), sql);
        });
      }
      if (folder === 'stripe-mcp-server') {
        await check('writing is switched off by default', async () => {
          const a = await s.call('create_customer', { email: 'a@b.co' }); fails(a); has(a.text, 'Write access is disabled');
          const b = await s.call('create_refund', { charge_id: 'ch_1', confirm: true }); fails(b); has(b.text, 'Write access is disabled');
        });
        await check('a fake key reaches Stripe and is rejected cleanly', async () => { const r = await s.call('list_customers', {}); fails(r); has(r.text, 'Invalid API Key'); }, { net: true });
        await check('with writing on, a refund still needs confirm=true', async () => {
          const w = await open(folder, { ...DUMMY[folder], ALLOW_WRITE: 'true' });
          try { const r = await w.call('create_refund', { charge_id: 'ch_1', confirm: false }); fails(r); has(r.text, 'confirm'); } finally { w.stop(); }
        });
        await check('a live key is refused unless explicitly allowed', () => expectFatal(folder, { STRIPE_SECRET_KEY: 'sk_live_dummy', ALLOW_LIVE_MODE: '' }, 'live'));
      }
      if (folder === 'slack-mcp-server') await check('posting is switched off by default', async () => {
        const r = await s.call('post_message', { channel_id: 'C1', text: 'hi' }); fails(r); has(r.text, 'Write access is disabled');
      });
    } finally { s.stop(); }
  });
}

// ------------------------------------------------------------------ report
const names = Object.keys(stats); let P = 0, F = 0, K = 0;
say(); say(paint(1, '================ SUMMARY ================'));
for (const n of names) {
  const x = stats[n]; P += x.PASS; F += x.FAIL; K += x.SKIP;
  say(`  ${x.FAIL ? paint(31, 'FAIL') : paint(32, ' ok ')}  ${n.padEnd(20)} ${x.PASS} passed, ${x.FAIL} failed, ${x.SKIP} skipped`);
}
say(`\n  Total: ${P} passed, ${F} failed, ${K} skipped`);
if (FAILS.length) { say('\n  What failed:'); FAILS.forEach(f => say('   - ' + f)); }
say(F ? paint(31, '\n  RESULT: some checks failed. Send me tests\\test-report.txt') : paint(32, '\n  RESULT: everything that ran passed.'));
try { fs.mkdirSync(path.join(ROOT, 'tests'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'tests', 'test-report.txt'), LOG.join('\n') + '\n', 'utf8'); } catch { /* ignore */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(F ? 1 : 0);

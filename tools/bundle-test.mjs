// DELIGHT bundle tester v2. No npm install needed (Node 18+ only).
// Opens every .mcpb the way Claude Desktop does, starts the server,
// speaks MCP to it, and prints PASS / WARN / FAIL for each check.
//
// Usage:  node bundle-test.mjs [folder-with-mcpb-files]
// Default folder: D:\mcp-servers\downloads
// Report is written to bundle-test-report.txt in the current folder.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const folder = process.argv[2] || 'D:\\mcp-servers\\downloads';
const lines = [];
const out = (s = '') => { console.log(s); lines.push(s.replace(/\x1b\[\d+m/g, '')); };
const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m` };
let totalFail = 0, totalWarn = 0, totalPass = 0;

function mk(res) {
  return {
    pass(m) { totalPass++; out(`   ${c.g('PASS')}  ${m}`); },
    warn(m) { totalWarn++; out(`   ${c.y('WARN')}  ${m}`); },
    fail(m) { totalFail++; out(`   ${c.r('FAIL')}  ${m}`); },
  };
}

function extract(file, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tries = [
    ['tar', ['-xf', file, '-C', dest]],                       // Windows 10+ bsdtar reads zip
    ['unzip', ['-q', '-o', file, '-d', dest]],
    ['powershell', ['-NoProfile', '-Command', `Copy-Item -LiteralPath '${file}' -Destination '${dest}.zip' -Force; Expand-Archive -LiteralPath '${dest}.zip' -DestinationPath '${dest}' -Force`]],
  ];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (!r.error && r.status === 0 && fs.existsSync(path.join(dest, 'manifest.json'))) return true;
  }
  return false;
}

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    fn(p, e);
    if (e.isDirectory() && e.name !== 'node_modules') walk(p, fn);
  }
}

function testValueFor(key, cfg, tmp) {
  if (cfg.default !== undefined && cfg.default !== null && cfg.default !== '') return Array.isArray(cfg.default) ? cfg.default[0] : String(cfg.default);
  switch (cfg.type) {
    case 'directory': {
      const d = path.join(tmp, 'sandbox-' + key);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'hello.txt'), 'hello from the DELIGHT bundle test');
      return d;
    }
    case 'file': {
      const f = path.join(tmp, 'file-' + key + '.txt');
      fs.writeFileSync(f, 'test');
      return f;
    }
    case 'number': return '1';
    case 'boolean': return 'false';
    default: return 'test-value-not-real';
  }
}

function subst(str, dir, uc) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\$\{__dirname\}/g, dir)
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$\{DESKTOP\}/g, path.join(os.homedir(), 'Desktop'))
    .replace(/\$\{DOCUMENTS\}/g, path.join(os.homedir(), 'Documents'))
    .replace(/\$\{DOWNLOADS\}/g, path.join(os.homedir(), 'Downloads'))
    .replace(/\$\{pathSeparator\}|\$\{\/\}/g, path.sep)
    .replace(/\$\{user_config\.([^}]+)\}/g, (_, k) => uc[k] ?? '');
}

async function talk(proc, steps, timeoutMs) {
  // newline-delimited JSON-RPC over stdio
  const nonJson = [];
  const pending = new Map();
  let buf = '';
  let stderr = '';
  let exited = null;
  proc.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m && m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { nonJson.push(line.slice(0, 120)); }
    }
  });
  proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
  proc.on('exit', (code, sig) => { exited = { code, sig }; for (const [, f] of pending) f({ error: { message: 'server exited' } }); pending.clear(); });
  proc.on('error', e => { exited = { code: -1, sig: String(e.message) }; });

  const send = (msg) => { try { proc.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };
  let nextId = 1;
  const request = (method, params) => new Promise(resolve => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs);
    pending.set(id, m => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

  const result = await steps({ request, notify });
  return { result, nonJson, stderr, exited: () => exited };
}

function pickProp(schema, names) {
  const props = Object.keys(schema?.properties || {});
  return names.find(n => props.includes(n)) || props.find(p => names.some(n => p.toLowerCase().includes(n)));
}
function argsFor(tool, hint = {}) {
  const sch = tool.inputSchema || {};
  const a = {};
  for (const k of sch.required || []) {
    const def = sch.properties?.[k] || {};
    if (hint[k] !== undefined) { a[k] = hint[k]; continue; }
    if (def.enum) { a[k] = def.enum[0]; continue; }
    if (def.type === 'number' || def.type === 'integer') { a[k] = 1; continue; }
    if (def.type === 'boolean') { a[k] = false; continue; }
    if (/url/i.test(k)) a[k] = 'https://example.com';
    else if (/path|file|dir|folder/i.test(k)) a[k] = hint.__path || '';
    else if (/content|text|body|value|data|fact|note/i.test(k)) a[k] = hint.__text || 'delight-marker-4821';
    else if (/query|search|term/i.test(k)) a[k] = hint.__text || 'delight-marker-4821';
    else a[k] = hint.__key || 'delight-test-key';
  }
  return a;
}
const txt = r => (r?.result?.content || []).map(x => x.text || '').join(' ');
const short = s => s.replace(/\s+/g, ' ').slice(0, 140);

async function scenarios(t, tools, call, sandbox, fakeSecrets) {
  const has = n => tools.find(x => x.name === n);
  const names = tools.map(x => x.name);
  const show = (label, r) => out(`         ${label}: ${r?.timeout ? 'TIMEOUT' : short(txt(r) || JSON.stringify(r?.error || r?.result || {}))}`);

  // ---- Files: full round trip + escape attempt
  if (has('write_file') && has('read_file') && has('delete_file')) {
    const f = path.join(sandbox, 'delight-test.txt');
    const outside = path.join(os.tmpdir(), 'delight-outside-' + Date.now() + '.txt');
    fs.writeFileSync(outside, 'SECRET OUTSIDE');
    const W = has('write_file'), R = has('read_file'), D = has('delete_file'), L = has('list_directory');
    const pk = tl => pickProp(tl.inputSchema, ['path', 'file_path', 'filepath', 'file', 'filename']);
    const ck = pickProp(W.inputSchema, ['content', 'contents', 'text', 'data']);
    const mkArgs = (tl, p, extra = {}) => ({ [pk(tl)]: p, ...extra });
    let r = await call(W.name, mkArgs(W, f, { [ck]: 'hello delight' }));
    if (r?.result && !r.result.isError) t.pass('Files: write_file created a file inside the folder'); else { t.fail('Files: write_file failed'); show('answer', r); }
    r = await call(R.name, mkArgs(R, f));
    if (txt(r).includes('hello delight')) t.pass('Files: read_file returned what was written'); else { t.fail('Files: read_file did not return the text'); show('answer', r); }
    if (L) { r = await call(L.name, mkArgs(L, sandbox)); if (/delight-test/.test(txt(r))) t.pass('Files: list_directory shows the new file'); else { t.fail('Files: list_directory did not show the file'); show('answer', r); } }
    r = await call(R.name, mkArgs(R, outside));
    if (r?.result?.isError || /outside|not allowed|denied|forbidden/i.test(txt(r))) t.pass('Files: refuses to read a file outside the chosen folder');
    else if (txt(r).includes('SECRET OUTSIDE')) t.fail('Files: SECURITY - read a file OUTSIDE the chosen folder');
    else { t.warn('Files: unclear answer when reading outside the folder'); show('answer', r); }
    r = await call(R.name, mkArgs(R, path.join(sandbox, '..', path.basename(outside))));
    if (txt(r).includes('SECRET OUTSIDE')) t.fail('Files: SECURITY - ../ escape worked'); else t.pass('Files: ../ path escape is blocked');
    r = await call(D.name, mkArgs(D, f));
    if (r?.result && !r.result.isError) t.pass('Files: delete_file removed the file'); else { t.fail('Files: delete_file failed'); show('answer', r); }
    if (fs.existsSync(f)) t.fail('Files: file is still on disk after delete_file');
    fs.rmSync(outside, { force: true });
  }

  // ---- Memory: remember -> recall -> forget
  if (has('remember') && has('recall') && has('forget')) {
    const marker = 'delight-marker-' + Math.floor(Math.random() * 1e6);
    let r = await call('remember', argsFor(has('remember'), { __text: marker, __key: 'delight-test-key' }));
    if (r?.result && !r.result.isError) t.pass('Memory: remember stored a fact'); else { t.fail('Memory: remember failed'); show('answer', r); }
    r = await call('recall', argsFor(has('recall'), { __text: marker, __key: 'delight-test-key' }));
    if (txt(r).includes(marker) || /delight-test-key/.test(txt(r))) t.pass('Memory: recall found it'); else { t.fail('Memory: recall did not find the stored fact'); show('answer', r); }
    const lm = has('list_memories');
    if (lm) { r = await call('list_memories', argsFor(lm)); if (txt(r).includes(marker) || /delight-test-key/.test(txt(r))) t.pass('Memory: list_memories shows it'); else t.warn('Memory: list_memories did not show the fact'); }
    const idMatch = (txt(r) + '').match(/"?id"?\s*[:=]\s*"?([\w-]+)/);
    r = await call('forget', argsFor(has('forget'), { __text: marker, __key: 'delight-test-key', ...(idMatch ? { id: idMatch[1] } : {}) }));
    if (r?.result && !r.result.isError) t.pass('Memory: forget removed it'); else { t.warn('Memory: forget did not succeed with my guessed arguments'); show('answer', r); }
  }

  // ---- Web fetch: real page, private IP and file: must be refused
  if (has('fetch_url')) {
    const F = has('fetch_url'); const uk = pickProp(F.inputSchema, ['url']) || 'url';
    let r = await call('fetch_url', { [uk]: 'https://example.com' });
    if (/Example Domain/i.test(txt(r))) t.pass('Web: fetched https://example.com'); else { t.warn('Web: could not fetch example.com (is the internet on?)'); show('answer', r); }
    for (const [label, u] of [['private IP 127.0.0.1', 'http://127.0.0.1'], ['IPv6 localhost', 'http://[::1]/'], ['file: address', 'file:///C:/Windows/win.ini']]) {
      r = await call('fetch_url', { [uk]: u });
      const said = txt(r);
      if (/refus|not allowed|blocked|unsupported|private|internal|local/i.test(said) && !/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(said)) t.pass(`Web: refuses ${label}`);
      else if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(said)) { t.warn(`Web: ${label} - INCONCLUSIVE, the server hit a network error instead of its own refusal rule`); show('answer', r); }
      else { t.fail(`Web: SECURITY - did not clearly refuse ${label}`); show('answer', r); }
    }
  }

  // ---- Credential servers: must fail politely, never hang, never echo the fake secret
  if (names.some(n => /^(search_repositories|list_schemas|list_customers)$/.test(n))) {
    const tl = has('search_repositories') || has('list_schemas') || has('list_customers');
    const r = await call(tl.name, argsFor(tl));
    if (r?.timeout) t.fail(`${tl.name}: hung with no real credentials`);
    else if (fakeSecrets.some(sx => txt(r).includes(sx))) t.fail(`${tl.name}: SECURITY - error message repeats the secret`);
    else if (r?.result?.isError || r?.error) t.pass(`${tl.name}: fails politely without real credentials`);
    else t.warn(`${tl.name}: answered normally with fake credentials`);
    show('answer', r);
  }
}

async function testBundle(file) {
  const name = path.basename(file);
  out(`\n== ${name}  (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  const t = mk();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delight-bt-'));
  const dir = path.join(tmp, 'bundle');
  let proc = null;
  const cleanup = async () => {
    if (proc && proc.exitCode === null) {
      await new Promise(res => { proc.once('exit', res); try { proc.kill(); } catch { res(); } setTimeout(res, 3000); });
    }
    await new Promise(r => setTimeout(r, 400));
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { /* temp cleanup is never a test failure */ }
  };
  try {
    if (!extract(file, dir)) { t.fail('could not open the bundle (not a valid zip, or manifest.json is missing)'); return; }
    t.pass('bundle opens and contains manifest.json');

    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { t.fail('manifest.json is not valid JSON: ' + e.message); return; }

    for (const k of ['name', 'version', 'description', 'author', 'server']) {
      if (m[k]) t.pass(`manifest has "${k}"`); else t.fail(`manifest is missing "${k}"`);
    }
    if (!m.server) return;

    let leaked = [];
    walk(dir, (p, e) => { if (e.isFile() && (e.name === '.env' || /\.env\.(local|production)$/.test(e.name))) leaked.push(path.relative(dir, p)); });
    if (leaked.length) t.fail('bundle contains secret files: ' + leaked.join(', ')); else t.pass('no .env or secret files inside');

    const entry = m.server.entry_point;
    if (entry) {
      if (fs.existsSync(path.join(dir, entry))) t.pass(`entry point exists (${entry})`);
      else { t.fail(`entry point missing: ${entry}`); return; }
    }

    const mc = m.server.mcp_config || {};
    const uc = {};
    const fakeSecrets = [];
    let sandbox = path.join(tmp, 'sandbox');
    fs.mkdirSync(sandbox, { recursive: true });
    for (const [k, cfg] of Object.entries(m.user_config || {})) {
      uc[k] = testValueFor(k, cfg, tmp);
      if (cfg.type === 'directory') sandbox = uc[k];
      if (cfg.sensitive || /key|token|secret|password|url|string/i.test(k)) fakeSecrets.push(uc[k]);
    }
    const command = mc.command === 'node' ? process.execPath : subst(mc.command || process.execPath, dir, uc);
    const args = (mc.args || (entry ? ['${__dirname}/' + entry] : [])).map(a => subst(a, dir, uc));
    const env = { ...process.env };
    for (const [k, v] of Object.entries(mc.env || {})) env[k] = subst(v, dir, uc);

    const started = Date.now();
    proc = spawn(command, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const talkRes = await talk(proc, async ({ request, notify }) => {
      const r = {};
      r.init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'delight-bundle-test', version: '1.0.0' } });
      notify('notifications/initialized', {});
      r.startMs = Date.now() - started;
      r.tools = await request('tools/list', {});
      const tools = r.tools?.result?.tools || [];
      r.toolsArr = tools;
      const call = async (n, a) => request('tools/call', { name: n, arguments: a });
      r.scen = { tools, call };
      // run scenarios inside the live connection
      if (tools.length) await scenarios(t, tools, call, sandbox, fakeSecrets).catch(e => t.fail('scenario crashed: ' + e.message));
      return r;
    }, 20000);

    const { result: r, nonJson, stderr } = talkRes;
    const ex = talkRes.exited();
    const tail = () => { if (stderr.trim()) out('         stderr: ' + stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300)); };

    if (r.init?.timeout) { t.fail('server never answered "initialize" within 20 s'); tail(); return; }
    if (r.init?.error) { t.fail('initialize failed: ' + (r.init.error.message || JSON.stringify(r.init.error))); tail(); return; }
    t.pass(`server starts and answers initialize (${r.startMs} ms)`);
    if (r.startMs > 8000) t.warn(`slow start (${Math.round(r.startMs / 1000)} s). Customers on slow PCs may think it is stuck`);

    const si = r.init?.result?.serverInfo;
    if (si?.name) {
      t.pass(`serverInfo: ${si.name} ${si.version || ''}`.trim());
      if (si.name.length > 40) t.warn('server name is long and contains the banner; AI apps show this name to users');
      if (si.version && !/^\d+\.\d+\.\d+/.test(String(si.version))) t.warn(`server version is "${si.version}", not x.y.z`);
    } else t.warn('server did not report serverInfo');

    if (nonJson.length) t.fail(`server prints plain text to stdout, which breaks Claude Desktop. First line: "${nonJson[0]}"`);
    else t.pass('stdout carries only protocol messages');

    const tools = r.toolsArr || [];
    if (tools.length) t.pass(`tools/list returns ${tools.length} tool(s): ${tools.map(x => x.name).slice(0, 8).join(', ')}${tools.length > 8 ? ', ...' : ''}`);
    else t.fail('tools/list returned no tools');
    const bad = tools.filter(x => !x.description || !x.inputSchema);
    if (tools.length && bad.length) t.warn(`${bad.length} tool(s) lack a description or inputSchema: ${bad.map(x => x.name).join(', ')}`);
    else if (tools.length) t.pass('every tool has a description and an input schema');

    if (Array.isArray(m.tools) && m.tools.length) {
      const declared = m.tools.map(x => x.name).sort().join(',');
      const real = tools.map(x => x.name).sort().join(',');
      if (declared === real) t.pass('manifest tool list matches the real server');
      else t.warn('manifest tool list differs from what the server reports (declared: ' + declared + ' | real: ' + real + ')');
    }
    if (ex && ex.code && ex.code !== 0 && !ex.sig) { t.fail(`server crashed during the test (exit ${ex.code})`); tail(); }
    // print schemas so a human (or Claude) can see the exact argument names
    for (const tl of tools) out(`         tool ${tl.name}(${Object.keys(tl.inputSchema?.properties || {}).join(', ')})`);
  } finally {
    await cleanup();
  }
}

const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.mcpb')).map(f => path.join(folder, f)) : [];
out(`DELIGHT bundle test  ${new Date().toISOString()}`);
out(`Folder: ${folder}`);
if (!files.length) { out(c.r('\nNo .mcpb files found in that folder. Pass the folder: node bundle-test.mjs D:\\mcp-servers\\downloads')); process.exit(2); }
for (const f of files) { try { await testBundle(f); } catch (e) { totalFail++; out(`   ${c.r('FAIL')}  test crashed: ${e.message}`); } }
out(`\n==== ${totalPass} passed, ${totalWarn} warnings, ${totalFail} failed across ${files.length} bundle(s)`);
fs.writeFileSync('bundle-test-report.txt', lines.join('\n'));
out('Report saved: ' + path.resolve('bundle-test-report.txt'));
process.exit(totalFail ? 1 : 0);

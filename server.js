#!/usr/bin/env node
'use strict';
// WiZ Control bridge: a tiny local web server that talks to WiZ bulbs over UDP and
// serves the web app + JSON API. No dependencies.
//
//   node server.js                 →  http://localhost:4200
//   node server.js --lan           →  also reachable from phones on your Wi-Fi
//   node server.js --port 5000 --origin https://my-copy.vercel.app
//
// Environment variables PORT, HOST, ALLOWED_ORIGINS, WIZ_CONFIG and APP_URL work too.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const wiz = require('./lib/wiz');
const store = require('./lib/store');
const net = require('./lib/net');

const pkg = require('./package.json');
const VERSION = pkg.version;
const PUBLIC = path.join(__dirname, 'public');

/* ---------- command line ---------- */
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const has = (name) => args.includes('--' + name);
if (has('help') || has('h')) {
  console.log(`WiZ Control bridge v${VERSION}

  --port <n>        port to listen on (default 4200)
  --lan             accept connections from other devices on your Wi-Fi (phones, tablets)
  --host <ip>       exact address to bind (default 127.0.0.1)
  --origin <url>    extra website allowed to control the bridge (repeat or comma-separate)
  --config <file>   where to keep bulbs and profile (default ${store.CONFIG_PATH})
  --no-open         don't open the browser automatically
  --version         print the version and exit

Web app:  https://github.com/realanshuman/wiz-control`);
  process.exit(0);
}
if (has('version') || has('v')) { console.log(VERSION); process.exit(0); }

if (process.pkg && !has('no-log')) {
  try {
    fs.mkdirSync(path.dirname(store.CONFIG_PATH), { recursive: true });
    const log = fs.createWriteStream(path.join(path.dirname(store.CONFIG_PATH), 'bridge.log'), { flags: 'a' });
    for (const m of ['log', 'error']) { const orig = console[m].bind(console); console[m] = (...a) => { orig(...a); log.write(new Date().toISOString() + ' ' + a.join(' ') + '\n'); }; }
  } catch (_) {}
}
const PORT = Number(flag('port') || process.env.PORT) || 4200;
const HOST = flag('host') || process.env.HOST || (has('lan') ? '0.0.0.0' : '127.0.0.1');
if (flag('config')) store.setConfigPath(flag('config'));

// Browser origins allowed to call the API from another site (the hosted app on Vercel,
// or a local dev copy). Globs; ALLOWED_ORIGINS=* allows any site.
const DEFAULT_ORIGINS = ['https://*.vercel.app', 'http://localhost:*', 'http://127.0.0.1:*'];
const extraOrigins = args.flatMap((a, i) => (a === '--origin' && args[i + 1] ? args[i + 1].split(',') : []));
const ALLOWED_ORIGINS = [...DEFAULT_ORIGINS, ...(process.env.ALLOWED_ORIGINS || '').split(','), ...extraOrigins].map((x) => x.trim()).filter(Boolean);
const originRe = ALLOWED_ORIGINS.map((p) => p === '*' ? /.*/ : new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'));
const originAllowed = (o) => !!o && originRe.some((re) => re.test(o));

/* ---------- helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) { reject(new Error('Body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Invalid JSON body')); } });
});
function cors(req, res) {
  const o = req.headers.origin;
  if (!originAllowed(o)) return;
  res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome: public site → local network
  res.setHeader('Access-Control-Max-Age', '600');
}
function serveStatic(res, file) {
  const p = path.normalize(path.join(PUBLIC, file));
  if (!p.startsWith(PUBLIC)) return json(res, 404, { error: 'Not found' });
  fs.readFile(p, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function view(b, pilot, online) {
  return { ...b, ...wiz.capabilities(b.moduleName), online, rssi: pilot ? pilot.rssi : undefined, pilot: pilot || null, summary: pilot ? wiz.describePilot(pilot) : null };
}
async function withState(b) {
  try { const p = await wiz.send(b.ip, 'getPilot', {}, { retries: 1, timeoutMs: 1000 }); return view(b, p, true); }
  catch (_) { return view(b, null, false); }
}
async function discoverAndSave() {
  const found = await wiz.discover({ extraIps: store.list().map((b) => b.ip) });
  store.upsert(found);
  const byMac = new Map(found.map((d) => [store.normMac(d.mac), d]));
  return store.list().map((b) => { const d = byMac.get(b.mac); return view(b, d ? d.pilot : null, !!d); });
}
/** setPilot, and if the bulb doesn't answer (IP changed?) re-discover once and retry. */
async function applyTo(b, params) {
  try { await wiz.setPilot(b.ip, params); return { mac: b.mac, ok: true, ip: b.ip }; }
  catch (e) {
    const found = await wiz.discover({ timeoutMs: 2000 });
    const d = found.find((x) => store.normMac(x.mac) === b.mac);
    if (!d) return { mac: b.mac, ok: false, error: e.message };
    store.update(b.mac, { ip: d.ip });
    try { await wiz.setPilot(d.ip, params); return { mac: b.mac, ok: true, ip: d.ip, note: `IP changed to ${d.ip}` }; }
    catch (e2) { return { mac: b.mac, ok: false, error: e2.message }; }
  }
}
let pinged = false;
function pingInfo() {
  return {
    ok: true, name: 'wiz-control', version: VERSION, port: PORT, lan: HOST === '0.0.0.0',
    bulbs: store.list().length, profile: store.getProfile(), defaultBulb: store.load().defaultBulb,
    wifi: net.info.wifi, computer: net.info.computer, platform: net.info.platform, lanIps: net.info.lanIps,
    packaged: !!process.pkg, config: store.CONFIG_PATH,
  };
}

/* ---------- routes ---------- */
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (parts[0] !== 'api') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    return serveStatic(res, parts.length === 0 ? 'index.html' : parts.join('/'));
  }

  if (parts[1] === 'ping') { pinged = true; return json(res, 200, pingInfo()); }
  if (parts[1] === 'scenes') return json(res, 200, Object.entries(wiz.SCENES).map(([id, name]) => ({ id: +id, name, dynamic: wiz.DYNAMIC_SCENES.has(+id) })));
  if (parts[1] === 'discover' && req.method === 'POST') return json(res, 200, await discoverAndSave());

  if (parts[1] === 'profile') {
    if (req.method === 'GET') return json(res, 200, store.getProfile());
    if (req.method === 'PUT' || req.method === 'PATCH') return json(res, 200, store.setProfile(await readBody(req)));
    if (req.method === 'DELETE') { store.clearProfile(); return json(res, 200, { ok: true }); }
  }
  if (parts[1] === 'quit' && req.method === 'POST') { json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 300); return; }
  if (parts[1] === 'reset' && req.method === 'POST') { store.forgetAll(); store.clearProfile(); return json(res, 200, { ok: true }); }

  if (parts[1] === 'all' && req.method === 'POST') {
    const params = wiz.buildPilot(await readBody(req));
    return json(res, 200, { params, results: await Promise.all(store.list().map((b) => applyTo(b, params))) });
  }

  if (parts[1] === 'bulbs') {
    if (parts.length === 2 && req.method === 'GET') return json(res, 200, await Promise.all(store.list().map(withState)));
    if (parts.length === 2 && req.method === 'DELETE') { store.forgetAll(); return json(res, 200, { ok: true }); }
    const mac = store.normMac(parts[2]);
    const b = store.load().bulbs[mac];
    if (!b) return json(res, 404, { error: `Unknown bulb ${parts[2]}` });
    if (parts.length === 3 && req.method === 'GET') return json(res, 200, await withState(b));
    if (parts.length === 3 && req.method === 'POST') {
      const params = wiz.buildPilot(await readBody(req));
      const r = await applyTo(b, params);
      return json(res, r.ok ? 200 : 502, { ...r, params });
    }
    if (parts[3] === 'toggle' && req.method === 'POST') {
      const p = await wiz.getPilot(b.ip);
      const r = await applyTo(b, { state: !p.state });
      return json(res, r.ok ? 200 : 502, { ...r, state: !p.state });
    }
    if (parts.length === 3 && req.method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 40);
      if (typeof body.room === 'string') patch.room = body.room.trim().slice(0, 40);
      if (body.default) store.setDefault(mac);
      return json(res, 200, store.update(mac, patch));
    }
    if (parts.length === 3 && req.method === 'DELETE') { store.forget(mac); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'Not found' });
}

/* ---------- start ---------- */
function openBrowser(url) {
  const p = process.platform;
  const cmd = p === 'darwin' ? ['open', [url]] : p === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { execFile(cmd[0], cmd[1], { windowsHide: true }, () => {}); } catch (_) {}
}

const server = http.createServer((req, res) => { route(req, res).catch((e) => json(res, 400, { error: e.message })); });
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — WiZ Control is probably running already.\nOpening http://localhost:${PORT}. To run a second copy, use --port 4201.\n`);
    if (!has('no-open')) openBrowser(flag('app-url') || process.env.APP_URL || `http://localhost:${PORT}`);
    setTimeout(() => process.exit(1), process.pkg ? 1500 : 200);
    return;
  }
  throw e;
});
server.listen(PORT, HOST, () => {
  net.start();
  const local = `http://localhost:${PORT}`;
  const lines = [``, `  WiZ Control bridge v${VERSION}`, `  ─────────────────────────────`, `  Open:      ${local}`];
  if (HOST === '0.0.0.0') for (const ip of net.info.lanIps.length ? net.info.lanIps : []) lines.push(`  Phones:    http://${ip}:${PORT}`);
  else lines.push(`  Phones:    start with --lan to allow other devices on your Wi-Fi`);
  lines.push(`  Bulbs:     ${store.list().length} saved  (${store.CONFIG_PATH})`, `  Leave this window open while you use the app. Press Ctrl+C to stop.`, ``);
  console.log(lines.join('\n'));
  // If no web page has contacted us within a few seconds (e.g. the app was double-clicked),
  // open the browser so the user lands in the app without typing anything.
  const appUrl = flag('app-url') || process.env.APP_URL || local;
  if (!has('no-open')) setTimeout(() => { if (!pinged) openBrowser(appUrl); }, 3500);
});

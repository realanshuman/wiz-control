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
const drivers = require('./lib/drivers');
const store = require('./lib/store');
const net = require('./lib/net');

const pkg = require('./package.json');
const VERSION = pkg.version;
const PUBLIC = path.join(__dirname, 'public');
// The public copy of the web app. Only this site (plus localhost) may talk to the bridge
// from a browser unless you add more with --origin.
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://wiz-control.vercel.app';

/* ---------- command line ---------- */
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const has = (...names) => names.some((n) => args.includes((n.length === 1 ? '-' : '--') + n));
if (has('help', 'h')) {
  console.log(`WiZ Control bridge v${VERSION}

  --port <n>        port to listen on (default 4200)
  --lan             accept connections from other devices on your Wi-Fi (phones, tablets);
                    this is the default for the downloadable app
  --local           this computer only (the default when run from source)
  --host <ip>       exact address to bind
  --origin <url>    extra website allowed to control the bridge (repeat or comma-separate)
  --config <file>   where to keep bulbs and profile (default ${store.CONFIG_PATH})
  --app-url <url>   page to open in the browser at start (default: this bridge)
  --no-open         don't open the browser automatically
  --version         print the version and exit

Web app:  ${APP_ORIGIN}   Source: https://github.com/realanshuman/wiz-control`);
  process.exit(0);
}
if (has('version', 'v')) { console.log(VERSION); process.exit(0); }

const portArg = flag('port') || process.env.PORT;
if (portArg && !/^\d{2,5}$/.test(portArg)) { console.error(`"${portArg}" is not a valid port number.`); process.exit(2); }
let PORT = Number(portArg) || 4200;
// The packaged app listens on the whole Wi-Fi so phones can open it (WiZ bulbs are open to
// the LAN anyway); from source it stays on localhost unless --lan is given.
const HOST = flag('host') || process.env.HOST || (has('lan') ? '0.0.0.0' : has('local') ? '127.0.0.1' : process.pkg ? '0.0.0.0' : '127.0.0.1');
if (flag('config')) store.setConfigPath(flag('config'));

if (process.pkg && !has('no-log')) {
  // Packaged app has no visible window: keep a log next to the data file.
  try {
    fs.mkdirSync(path.dirname(store.CONFIG_PATH), { recursive: true });
    const log = fs.createWriteStream(path.join(path.dirname(store.CONFIG_PATH), 'bridge.log'), { flags: 'a' });
    log.on('error', () => {});
    for (const m of ['log', 'error']) { const orig = console[m].bind(console); console[m] = (...a) => { orig(...a); log.write(new Date().toISOString() + ' ' + a.join(' ') + '\n'); }; }
  } catch (_) {}
}

/* ---------- who may talk to us ---------- */
// Browser origins allowed to call the API from another site. Globs (* = one label);
// ":*" at the end means any port or none. ALLOWED_ORIGINS=* allows any site.
const DEFAULT_ORIGINS = [APP_ORIGIN, 'http://localhost:*', 'http://127.0.0.1:*'];
const extraOrigins = args.flatMap((a, i) => (a === '--origin' && args[i + 1] ? args[i + 1].split(',') : []));
const ALLOWED_ORIGINS = [...DEFAULT_ORIGINS, ...(process.env.ALLOWED_ORIGINS || '').split(','), ...extraOrigins].map((x) => x.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean);
const originRe = ALLOWED_ORIGINS.map((p) => p === '*' ? /.*/ : new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:\*$/, '(:\\d+)?').replace(/\*/g, '[a-z0-9-]*') + '$'));
const originAllowed = (o) => !!o && originRe.some((re) => re.test(String(o).toLowerCase()));
// Host header check: defeats DNS rebinding (a site pointing its own name at 127.0.0.1).
function hostAllowed(h) {
  if (!h) return true; // HTTP/1.0 clients such as curl without a Host header
  const name = String(h).toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(name) || name.endsWith('.local') || name.endsWith('.localhost')) return true;
  if (net.info.lanIps.includes(name)) return true;
  if (HOST !== '0.0.0.0' && HOST !== '127.0.0.1' && name === HOST.toLowerCase()) return true;
  return false;
}

/* ---------- helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e5) { reject(new HttpError(413, 'Body too large')); req.removeAllListeners('data'); req.resume(); } });
  req.on('end', () => {
    if (!s.trim()) return resolve({});
    let j; try { j = JSON.parse(s); } catch (e) { return reject(new HttpError(400, 'Invalid JSON body')); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return reject(new HttpError(400, 'Body must be a JSON object'));
    resolve(j);
  });
  req.on('error', () => reject(new HttpError(400, 'Request aborted')));
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
  if (!p.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: 'Not found' });
  fs.readFile(p, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// A device as the web app sees it: the saved record + live capabilities + current state.
function view(dev, state, online) {
  const drv = drivers.get(dev.driver);
  const caps = (drv && drv.caps && drv.caps(dev)) || { color: false, tunableWhite: false, dimmable: false, effects: false, kind: dev.kind || 'bulb' };
  return {
    ...dev, ...caps, key: dev.key, mac: dev.driver === 'wiz' ? dev.id : undefined, brand: drv && drv.brand,
    online, needsKey: dev.driver === 'tuya' && !dev.tuya, rssi: state ? state.rssi : undefined,
    summary: state || null,
  };
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('No reply (slow)')), ms))]);
async function withState(dev) {
  const drv = drivers.get(dev.driver);
  if (!drv || (dev.driver === 'tuya' && !dev.tuya)) return view(dev, dev.state || null, false);
  // Cap per-device fetch so one slow/unreachable device can't stall the whole dashboard.
  try { const st = await withTimeout(drv.getState({ ...dev, ...(dev.tuya || {}) }), 2500); if (st) store.update(dev.key, { state: st }); return view(dev, st, true); }
  catch (_) { return view(dev, dev.state || null, false); }
}

// Run every brand's discovery. WiZ auto-adds (keyless); Hue relists saved bridges' lights;
// Tuya devices without a saved key are returned for the Add flow but not saved to the dashboard.
let discovering = null;
function discoverOnce() {
  if (discovering) return discovering;
  discovering = (async () => {
    const wizFound = await drivers.get('wiz').discover({ extraIps: store.list().filter((d) => d.driver === 'wiz').map((d) => d.ip) }).catch(() => []);
    const hueFound = await drivers.get('hue').discover({ bridges: store.hueBridges() }).catch(() => []);
    const savedTuya = store.list().filter((d) => d.driver === 'tuya' && d.tuya);
    store.upsert([...wizFound, ...hueFound]);
    return { wizFound, hueFound, savedTuya };
  })().finally(() => { discovering = null; });
  return discovering;
}
async function discoverAndSave() {
  await discoverOnce();
  return Promise.all(store.list().map(withState));
}
/** setState via the device's driver; if it times out, let the driver relocate (IP change) and retry. */
async function applyTo(dev, params) {
  const drv = drivers.get(dev.driver);
  if (!drv) return { key: dev.key, ok: false, error: `Unknown brand ${dev.driver}` };
  if (dev.driver === 'tuya' && !dev.tuya) return { key: dev.key, ok: false, error: 'This device needs its key added first' };
  const full = { ...dev, ...(dev.tuya || {}) };
  try { await drv.setState(full, params); return { key: dev.key, ok: true, ip: dev.ip }; }
  catch (e) {
    if (!drv.isTimeout || !drv.isTimeout(e) || !drv.relocate) return { key: dev.key, ok: false, error: e.message };
    try {
      const nd = await drv.relocate(full);
      if (nd && nd.ip) { store.update(dev.key, { ip: nd.ip }); await drv.setState({ ...full, ...nd }, params); return { key: dev.key, ok: true, ip: nd.ip, note: nd.ip !== dev.ip ? `IP changed to ${nd.ip}` : undefined }; }
    } catch (_) {}
    return { key: dev.key, ok: false, error: e.message };
  }
}
const isTimeout = (e) => /^No reply/.test(e && e.message);
let pinged = false;
function pingInfo() {
  return {
    ok: true, name: 'wiz-control', version: VERSION, port: PORT, lan: HOST === '0.0.0.0',
    bulbs: store.list().length, devices: store.list().length, rooms: store.rooms(),
    profile: store.getProfile(), defaultKey: store.load().defaultKey,
    wifi: net.info.wifi, computer: net.info.computer, platform: net.info.platform, lanIps: net.info.lanIps,
    packaged: !!process.pkg, config: store.CONFIG_PATH, appOrigin: APP_ORIGIN,
  };
}
const statusFor = (r) => (r.ok ? 200 : /No reply|timed out|did not respond/.test(r.error || '') ? 504 : 502);
const validate = (body) => wiz.buildPilot(body); // shared param normaliser/validator

/* ---------- routes ---------- */
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!hostAllowed(req.headers.host)) return json(res, 421, { error: 'Unexpected Host header' });

  if (parts[0] !== 'api') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    return serveStatic(res, parts.length === 0 ? 'index.html' : parts.join('/'));
  }
  if (req.method !== 'GET') {
    // State-changing requests: only from allowed websites (or non-browser clients), and only
    // as JSON, so browsers always run a CORS preflight first. Blocks cross-site form posts.
    if (req.headers.origin && !originAllowed(req.headers.origin)) return json(res, 403, { error: 'Origin not allowed. Start the bridge with --origin <your site> to allow it.' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Send Content-Type: application/json' });
  }

  if (parts[1] === 'ping') { pinged = true; return json(res, 200, pingInfo()); }
  if (parts[1] === 'scenes') return json(res, 200, Object.entries(wiz.SCENES).map(([id, name]) => ({ id: +id, name, dynamic: wiz.DYNAMIC_SCENES.has(+id) })));
  if (parts[1] === 'brands') return json(res, 200, drivers.brands());
  if (parts[1] === 'discover' && req.method === 'POST') return json(res, 200, await discoverAndSave());

  if (parts[1] === 'profile') {
    if (req.method === 'GET') return json(res, 200, store.getProfile());
    if (req.method === 'PUT' || req.method === 'PATCH') return json(res, 200, store.setProfile(await readBody(req)));
    if (req.method === 'DELETE') { store.clearProfile(); return json(res, 200, { ok: true }); }
  }
  if (parts[1] === 'quit' && req.method === 'POST') { json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 300); return; }
  if (parts[1] === 'reset' && req.method === 'POST') { store.forgetAll(); store.clearProfile(); return json(res, 200, { ok: true }); }

  // Add flow: scan for addable devices of one brand (not saved yet).
  if (parts[1] === 'scan' && req.method === 'POST') {
    const { driver = 'wiz' } = await readBody(req);
    if (driver === 'wiz') return json(res, 200, { driver, found: await drivers.get('wiz').discover({}) });
    if (driver === 'tuya') { const saved = new Set(store.list().map((d) => d.key)); return json(res, 200, { driver, found: (await drivers.get('tuya').discover({})).map((d) => ({ ...d, saved: saved.has('tuya:' + d.id) })) }); }
    if (driver === 'hue') return json(res, 200, { driver, bridges: await drivers.get('hue').findBridgeIps() });
    return json(res, 400, { error: `Unknown brand ${driver}` });
  }
  // Add a device configured by hand (Tuya key, or a WiZ device by IP).
  if (parts[1] === 'add' && req.method === 'POST') {
    const body = await readBody(req);
    const driver = body.driver;
    if (driver === 'tuya') {
      if (!body.id || !body.key) return json(res, 400, { error: 'Tuya needs the device id and local key' });
      if (String(body.key).length !== 16) return json(res, 400, { error: 'The Tuya local key is 16 characters' });
      const rec = { driver: 'tuya', id: String(body.id), ip: body.ip, name: body.name, kind: body.kind || 'bulb', version: body.version || '3.3', tuya: { key: String(body.key), version: body.version || '3.3' }, caps: drivers.get('tuya').caps({ kind: body.kind || 'bulb' }) };
      const saved = store.addDevice(rec);
      return json(res, 200, await withState(saved));
    }
    return json(res, 400, { error: `Cannot add ${driver} this way` });
  }
  // Hue: pair with a bridge (after the link button is pressed) and import its lights.
  if (parts[1] === 'hue' && parts[2] === 'pair' && req.method === 'POST') {
    const { ip } = await readBody(req);
    if (!ip) return json(res, 400, { error: 'Which bridge? Provide its IP.' });
    let bridge; try { bridge = await drivers.get('hue').pair(ip); } catch (e) { return json(res, 400, { error: e.message }); }
    const bridgeRec = { ...bridge, id: bridge.ip };
    store.saveHueBridge(bridgeRec);
    let lights = []; try { lights = await drivers.get('hue').listLights(bridgeRec); } catch (e) { return json(res, 200, { paired: true, added: 0, error: e.message }); }
    lights.forEach((l) => store.addDevice(l));
    return json(res, 200, { paired: true, added: lights.length, devices: await Promise.all(lights.map((l) => withState(store.get(l.key) || l))) });
  }

  if (parts[1] === 'all' && req.method === 'POST') {
    const params = validate(await readBody(req));
    const results = await Promise.all(store.list().map((b) => applyTo(b, params)));
    return json(res, results.some((r) => r.ok) || results.length === 0 ? 200 : 502, { params, results });
  }

  // Devices (and the legacy /api/bulbs alias). Path segment is the device key or a bare MAC.
  if (parts[1] === 'bulbs' || parts[1] === 'devices') {
    if (parts.length === 2 && req.method === 'GET') return json(res, 200, await Promise.all(store.list().map(withState)));
    if (parts.length === 2 && req.method === 'DELETE') { store.forgetAll(); return json(res, 200, { ok: true }); }
    const key = decodeURIComponent(parts[2]);
    const b = store.get(key) || store.get('wiz:' + store.normMac(key));
    if (!b) return json(res, 404, { error: `Unknown device ${key}` });
    if (parts.length === 3 && req.method === 'GET') return json(res, 200, await withState(b));
    if (parts.length === 3 && req.method === 'POST') {
      const params = validate(await readBody(req));
      const r = await applyTo(b, params);
      return json(res, statusFor(r), { ...r, params });
    }
    if (parts[3] === 'toggle' && req.method === 'POST') {
      const drv = drivers.get(b.driver);
      let st; try { st = await drv.getState({ ...b, ...(b.tuya || {}) }); } catch (e) { return json(res, statusFor({ error: e.message }), { key: b.key, ok: false, error: e.message }); }
      const r = await applyTo(b, { state: !st.on });
      return json(res, statusFor(r), { ...r, state: !st.on });
    }
    if (parts.length === 3 && req.method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 40);
      if (typeof body.room === 'string') patch.room = body.room;
      if (body.default) store.setDefault(b.key);
      return json(res, 200, store.update(b.key, patch));
    }
    if (parts.length === 3 && req.method === 'DELETE') { store.forget(b.key); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'Not found' });
}

/* ---------- start ---------- */
function openBrowser(url) {
  const p = process.platform;
  const cmd = p === 'darwin' ? ['open', [url]] : p === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { execFile(cmd[0], cmd[1], { windowsHide: true }, () => {}); } catch (_) {}
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    if (e && e.message && /^Nothing to set|^Unrecognised|must be a number|between/.test(e.message)) return json(res, 400, { error: e.message });
    if (isTimeout(e)) return json(res, 504, { error: e.message });
    console.error('request failed:', e && e.stack || e);
    json(res, 500, { error: (e && e.message) || 'Internal error' });
  });
});
const appUrl = (p) => flag('app-url') || process.env.APP_URL || `http://localhost:${p}`;
// What is already on this port? 'ours' = a WiZ Control bridge, 'other' = something else,
// 'free' = nothing. Probed by an actual request so it works regardless of how the other
// process bound the address (0.0.0.0 vs 127.0.0.1 can otherwise both "succeed" on macOS).
function probePort(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: p, path: '/api/ping', timeout: 900 }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve(JSON.parse(s).name === 'wiz-control' ? 'ours' : 'other'); } catch (_) { resolve('other'); } });
    });
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
    req.on('timeout', () => { req.destroy(); resolve('other'); });
    req.end();
  });
}

// Pick a port and listen. If a WiZ Control bridge is already there, hand off to it and open
// the browser; if something else holds the port, step to the next one (unless the port was
// given explicitly), so a fresh install never dies silently on a conflict.
async function start(port, triesLeft) {
  const chosen = flag('port') || process.env.PORT; // an explicit port is never auto-changed
  const state = await probePort(port);
  if (state === 'ours') {
    console.log(`\nWiZ Control is already running. Opening http://localhost:${port} …\n`);
    if (!has('no-open')) openBrowser(appUrl(port));
    return setTimeout(() => process.exit(0), process.pkg ? 1200 : 100);
  }
  if (state === 'other') {
    if (!chosen && triesLeft > 0) { console.error(`Port ${port} is busy; trying ${port + 1} …`); return start(port + 1, triesLeft - 1); }
    console.error(`\nPort ${port} is in use by another program. Start WiZ Control on a free port, e.g. --port ${port + 1}.\n`);
    return setTimeout(() => process.exit(1), process.pkg ? 1500 : 100);
  }
  server.removeAllListeners('error');
  server.on('error', async (e) => {
    // A race: the port filled between the probe and listen. Retry the whole picker once.
    if (e.code === 'EADDRINUSE' && !chosen && triesLeft > 0) return start(port + 1, triesLeft - 1);
    if (e.code === 'EADDRINUSE') console.error(`\nPort ${port} is in use. Start WiZ Control on a free port, e.g. --port ${port + 1}.\n`);
    else if (e.code === 'EACCES') console.error(`\nNo permission to use port ${port}. Try a port above 1024, e.g. --port 4200.\n`);
    else if (e.code === 'EADDRNOTAVAIL') console.error(`\nThis computer has no network address ${HOST}. Check --host, or leave it out.\n`);
    else console.error(`\nCould not start: ${e.message}\n`);
    setTimeout(() => process.exit(1), process.pkg ? 1500 : 100);
  });
  server.listen(port, HOST, () => {
    PORT = port;
    const local = `http://localhost:${port}`;
    const lines = [``, `  WiZ Control bridge v${VERSION}`, `  ─────────────────────────────`, `  Open:      ${local}`];
    if (HOST === '0.0.0.0') { const ips = net.info.lanIps; lines.push(ips.length ? `  Phones:    ${ips.map((ip) => `http://${ip}:${port}`).join('  or  ')}  (same Wi-Fi; the app shows a QR code)` : `  Phones:    open this computer's address on port ${port}`); }
    else lines.push(`  Phones:    start with --lan to allow other devices on your Wi-Fi`);
    lines.push(`  Bulbs:     ${store.list().length} saved  (${store.CONFIG_PATH})`);
    lines.push(process.pkg ? `  Stop it from the app's Settings page, or quit it from your system's task manager.` : `  Leave this window open while you use the app. Press Ctrl+C to stop.`, ``);
    console.log(lines.join('\n'));
    // Open the browser so the user lands in the app without typing anything. A packaged app
    // (double-clicked, no window) opens right away; run from source we wait briefly in case a
    // hosted page is about to connect on its own.
    if (!has('no-open')) {
      if (process.pkg) openBrowser(appUrl(port));
      else setTimeout(() => { if (!pinged) openBrowser(appUrl(port)); }, 3000);
    }
  });
}
(async () => {
  await net.start(); // know our LAN addresses before the first request (Host check, /api/ping)
  start(PORT, 15);   // try up to 15 ports past the default if something else is squatting
})();

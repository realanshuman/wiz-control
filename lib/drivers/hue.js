'use strict';
/*
 * Philips Hue driver — local control via the Hue Bridge REST API (v1 over HTTP).
 * Flow: find the bridge on the network → press the bridge's round link button → we create a
 * local API username → list and control the bulbs. All local; no Hue cloud account needed
 * beyond the one-time bridge discovery lookup.
 *
 * A Hue device is stored as { id: '<bridgeId>:<lightId>', hue: { ip, username, lightId } }.
 *
 * NOTE: implemented to the documented Hue API but not verified against a physical bridge in
 * this project (there was none on the network here).
 */
const http = require('http');
const https = require('https');
const dgram = require('dgram');

function httpJson(method, url, body, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const lib = u.protocol === 'https:' ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request(u, { method, timeout, rejectUnauthorized: false, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('Bad response from Hue bridge')); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Hue bridge did not respond')); });
    if (data) req.write(data); req.end();
  });
}

/* ---------- find bridges ---------- */
async function findBridgeIps() {
  const ips = new Set();
  // 1) Philips N-UPnP cloud discovery (returns bridges seen from your IP).
  try { const list = await httpJson('GET', 'https://discovery.meethue.com/', null, 4000); if (Array.isArray(list)) list.forEach((b) => b.internalipaddress && ips.add(b.internalipaddress)); } catch (_) {}
  // 2) SSDP (local, works offline).
  try { (await ssdp()).forEach((ip) => ips.add(ip)); } catch (_) {}
  return [...ips];
}
function ssdp(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const ips = new Set(); const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n');
    s.on('error', () => {}); s.on('message', (m, r) => { if (/IpBridge|hue/i.test(m.toString())) ips.add(r.address); });
    try { s.bind(() => { try { s.setBroadcast(true); } catch (_) {} s.send(msg, 1900, '239.255.255.250'); }); } catch (_) {}
    setTimeout(() => { try { s.close(); } catch (_) {} resolve([...ips]); }, timeoutMs);
  });
}

/* ---------- pairing ---------- */
// Call after the user presses the bridge's link button. Returns { ip, username } or throws
// a friendly "press the button" error.
async function pair(ip) {
  const res = await httpJson('POST', `http://${ip}/api`, { devicetype: 'wiz-control#dashboard' });
  const row = Array.isArray(res) ? res[0] : res;
  if (row && row.success && row.success.username) return { ip, username: row.success.username };
  if (row && row.error && row.error.type === 101) throw new Error('Press the round button on top of the Hue bridge, then try again.');
  throw new Error((row && row.error && row.error.description) || 'Could not pair with the Hue bridge');
}

/* ---------- colour maths (Hue uses hue/sat; kelvin↔mired) ---------- */
function rgbToHueSat(r, g, b) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  return { hue: Math.round(h / 360 * 65535), sat: Math.round((mx ? d / mx : 0) * 254) };
}
function hueSatToRgb(hue, sat, bri) {
  const h = hue / 65535 * 360, s = sat / 254, v = (bri == null ? 254 : bri) / 254;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c; let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [r, g, b].map((n) => Math.round((n + m) * 255));
}
const kelvinToMired = (k) => Math.max(153, Math.min(500, Math.round(1e6 / Math.max(2000, Math.min(6535, k)))));
const miredToKelvin = (ct) => Math.round(1e6 / ct);

function lightToDevice(bridge, id, l) {
  const st = l.state || {}; const hasColor = 'hue' in st || 'xy' in st; const hasCt = 'ct' in st;
  const kind = /plug|socket|outlet/i.test(l.type || '') ? 'plug' : 'bulb';
  let state;
  if (kind === 'plug') state = { on: !!st.on, mode: 'plug' };
  else {
    state = { on: !!st.on, brightness: st.bri != null ? Math.round(st.bri / 254 * 100) : 100, mode: st.colormode === 'ct' || (!hasColor && hasCt) ? 'white' : (hasColor ? 'color' : 'white') };
    if (state.mode === 'color' && st.hue != null) { const [r, g, b] = hueSatToRgb(st.hue, st.sat, st.bri); state.r = r; state.g = g; state.b = b; state.hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''); }
    else if (hasCt && st.ct) state.temp = miredToKelvin(st.ct);
  }
  return {
    driver: 'hue', id: `${bridge.id || bridge.ip}:${id}`, name: l.name, kind,
    hue: { ip: bridge.ip, username: bridge.username, lightId: id },
    caps: { color: hasColor, tunableWhite: hasCt, dimmable: kind !== 'plug', effects: false, kind },
    reachable: st.reachable !== false, state,
  };
}

async function listLights(bridge) {
  const lights = await httpJson('GET', `http://${bridge.ip}/api/${bridge.username}/lights`, null);
  if (lights && lights[0] && lights[0].error) throw new Error(lights[0].error.description);
  return Object.entries(lights || {}).map(([id, l]) => lightToDevice(bridge, id, l));
}

module.exports = {
  id: 'hue', brand: 'Hue', label: 'Philips Hue', beta: true,
  addStyle: 'pair',
  scenes: () => [],
  findBridgeIps, pair, listLights,
  // Discovery for the unified scan: find bridges, and if we already have a saved username,
  // list their lights. (Pairing itself happens in the Add flow.)
  async discover({ bridges = [] } = {}) {
    const out = [];
    for (const b of bridges) { try { (await listLights(b)).forEach((d) => out.push(d)); } catch (_) {} }
    return out;
  },
  caps: (dev) => dev.caps || { color: true, tunableWhite: true, dimmable: true, effects: false, kind: dev.kind || 'bulb' },
  async getState(dev) {
    const l = await httpJson('GET', `http://${dev.hue.ip}/api/${dev.hue.username}/lights/${dev.hue.lightId}`, null);
    if (l && l[0] && l[0].error) throw new Error(l[0].error.description);
    return lightToDevice({ ip: dev.hue.ip, username: dev.hue.username, id: dev.id.split(':')[0] }, dev.hue.lightId, l).state;
  },
  async setState(dev, params) {
    const body = {};
    if (params.state !== undefined) body.on = !!params.state;
    if (params.dimming !== undefined) { body.on = true; body.bri = Math.round(Math.max(10, Math.min(100, params.dimming)) / 100 * 254); }
    if (params.temp !== undefined) { body.on = true; body.ct = kelvinToMired(params.temp); }
    if (params.r !== undefined || params.g !== undefined || params.b !== undefined) { body.on = true; Object.assign(body, rgbToHueSat(params.r || 0, params.g || 0, params.b || 0)); }
    const res = await httpJson('PUT', `http://${dev.hue.ip}/api/${dev.hue.username}/lights/${dev.hue.lightId}/state`, body);
    if (Array.isArray(res) && res[0] && res[0].error) throw new Error(res[0].error.description);
    return res;
  },
  isTimeout: (e) => /did not respond|timed out/.test(e && e.message),
  _test: { rgbToHueSat, hueSatToRgb, kelvinToMired, miredToKelvin, lightToDevice },
};

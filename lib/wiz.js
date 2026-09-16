'use strict';
// Minimal WiZ local-control library (no dependencies).
// WiZ bulbs speak JSON over UDP on port 38899 on the local network.
const dgram = require('dgram');
const os = require('os');

const PORT = 38899;

const SCENES = {
  1: 'Ocean', 2: 'Romance', 3: 'Sunset', 4: 'Party', 5: 'Fireplace', 6: 'Cozy',
  7: 'Forest', 8: 'Pastel Colors', 9: 'Wake up', 10: 'Bedtime', 11: 'Warm White',
  12: 'Daylight', 13: 'Cool White', 14: 'Night Light', 15: 'Focus', 16: 'Relax',
  17: 'True Colors', 18: 'TV Time', 19: 'Plant Growth', 20: 'Spring', 21: 'Summer',
  22: 'Fall', 23: 'Deep Dive', 24: 'Jungle', 25: 'Mojito', 26: 'Club', 27: 'Christmas',
  28: 'Halloween', 29: 'Candlelight', 30: 'Golden White', 31: 'Pulse', 32: 'Steampunk',
};
// Scenes that animate; these accept a "speed" parameter (10-200).
const DYNAMIC_SCENES = new Set([1, 2, 3, 4, 5, 7, 8, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32]);

const NAMED_COLORS = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 200, 0],
  orange: [255, 100, 0], purple: [150, 0, 255], pink: [255, 0, 150], magenta: [255, 0, 255],
  cyan: [0, 255, 255], teal: [0, 180, 160], lime: [150, 255, 0], white: [255, 255, 255],
  warm: 'temp:2700', daylight: 'temp:4200', cool: 'temp:6500',
};

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
/** Parse a number from user/API input; throws a friendly error instead of producing NaN. */
function num(v, name, lo, hi) {
  if (typeof v === 'boolean' || v === null || v === undefined || v === '' || (typeof v === 'string' && !/^\s*-?\d+(\.\d+)?\s*$/.test(v))) throw new Error(`${name} must be a number between ${lo} and ${hi}`);
  const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} must be a number between ${lo} and ${hi}`);
  return clamp(Math.round(n), lo, hi);
}
function bool(v, name) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return !!v;
  if (typeof v === 'string' && /^(true|on|1)$/i.test(v.trim())) return true;
  if (typeof v === 'string' && /^(false|off|0)$/i.test(v.trim())) return false;
  throw new Error(`${name} must be true or false`);
}

/** Send one JSON-RPC style message to a bulb and wait for its reply. */
function sendRaw(ip, method, params = {}, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`No reply from ${ip} (${method})`)), timeoutMs);
    sock.on('error', finish);
    sock.on('message', (msg) => {
      let j;
      try { j = JSON.parse(msg.toString()); } catch (e) { return finish(new Error(`Bad reply from ${ip}: ${msg}`)); }
      if (j.error) return finish(new Error(`${ip} ${method}: ${j.error.message || JSON.stringify(j.error)}`));
      finish(null, j.result !== undefined ? j.result : j);
    });
    sock.send(Buffer.from(JSON.stringify({ method, params })), PORT, ip, (err) => { if (err) finish(err); });
  });
}

/** Like sendRaw but retries once — UDP over Wi-Fi drops packets now and then. */
async function send(ip, method, params = {}, { retries = 1, timeoutMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await sendRaw(ip, method, params, timeoutMs); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const getPilot = (ip) => send(ip, 'getPilot');
const getSystemConfig = (ip) => send(ip, 'getSystemConfig');
const getUserConfig = (ip) => send(ip, 'getUserConfig');
const setPilot = (ip, params) => send(ip, 'setPilot', params);

/** Build a validated setPilot payload from friendly inputs. */
function buildPilot(input = {}) {
  const p = {};
  if (input.state !== undefined) p.state = bool(input.state, 'state');
  if (input.dimming !== undefined) p.dimming = num(input.dimming, 'dimming', 10, 100);
  if (input.r !== undefined || input.g !== undefined || input.b !== undefined) {
    p.r = num(input.r ?? 0, 'r', 0, 255);
    p.g = num(input.g ?? 0, 'g', 0, 255);
    p.b = num(input.b ?? 0, 'b', 0, 255);
    // c = cool-white LED, w = warm-white LED (0-255). Off unless asked for.
    p.c = num(input.c ?? 0, 'c', 0, 255);
    p.w = num(input.w ?? 0, 'w', 0, 255);
    if (p.state === undefined) p.state = true;
  }
  if (input.temp !== undefined) {
    p.temp = num(input.temp, 'temp', 1000, 10000);
    if (p.state === undefined) p.state = true;
  }
  if (input.sceneId !== undefined) {
    p.sceneId = num(input.sceneId, 'sceneId', 1, 32);
    if (p.state === undefined) p.state = true;
    if (input.speed !== undefined && DYNAMIC_SCENES.has(p.sceneId)) p.speed = num(input.speed, 'speed', 10, 200);
  } else if (input.speed !== undefined) {
    p.speed = num(input.speed, 'speed', 10, 200);
  }
  if (Object.keys(p).length === 0) throw new Error('Nothing to set (expected state, dimming, r/g/b, temp, sceneId or speed)');
  return p;
}

/** Parse "#ff0000", "ff0000", "255,0,0" or a colour name into {r,g,b} or {temp}. */
function parseColor(str) {
  const s = String(str).trim().toLowerCase();
  if (NAMED_COLORS[s] !== undefined) {
    const v = NAMED_COLORS[s];
    if (typeof v === 'string') return { temp: Number(v.split(':')[1]) };
    return { r: v[0], g: v[1], b: v[2] };
  }
  const hex = s.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/.test(hex)) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  if (/^[0-9a-f]{3}$/.test(hex)) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
  const m = s.match(/^(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  const k = s.match(/^(\d{4})k?$/);
  if (k) return { temp: +k[1] };
  throw new Error(`Unrecognised colour "${str}". Use #rrggbb, r,g,b, 2700k or a name (${Object.keys(NAMED_COLORS).join(', ')})`);
}

/** Describe what a bulb can do from its module name (e.g. ESP25_SHRGB_01). */
function capabilities(moduleName = '') {
  const m = moduleName.toUpperCase();
  return {
    color: m.includes('RGB'),
    tunableWhite: m.includes('RGB') || m.includes('TW'),
    dimmable: !m.includes('SOCKET'),
    socket: m.includes('SOCKET'),
    kind: m.includes('SOCKET') ? 'Smart plug' : m.includes('RGB') ? 'Color bulb' : m.includes('TW') ? 'Tunable white bulb' : m.includes('DW') ? 'Dimmable white bulb' : 'WiZ device',
  };
}

/** IPv4 subnets this machine sits on: [{ip, netmask, broadcast, hosts[]}] */
function localSubnets() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(utun|tun|tap|ppp|wg)/.test(name)) continue; // skip VPN tunnels
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      const bcast = ip.map((o, i) => (o | (~mask[i] & 255))).join('.');
      const hostBits = mask.reduce((n, o) => n + (8 - (o.toString(2).match(/1/g) || []).length), 0);
      const hosts = [];
      if (hostBits <= 8) { // sweep small subnets (up to /24) with unicast probes
        const net = ip.map((o, i) => o & mask[i]);
        const base = ((net[0] << 24) >>> 0) + (net[1] << 16) + (net[2] << 8) + net[3];
        for (let h = 1; h < (1 << hostBits) - 1; h++) {
          const n = base + h;
          hosts.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
        }
      }
      out.push({ iface: name, ip: a.address, netmask: a.netmask, broadcast: bcast, hosts });
    }
  }
  return out;
}

/**
 * Discover bulbs on the LAN. Sends a broadcast plus a unicast sweep (broadcast
 * over Wi-Fi is unreliable — in testing only 1 of 3 bulbs answered it).
 * Resolves with [{ip, mac, moduleName, fwVersion, homeId, roomId, rssi, pilot}]
 */
function discover({ timeoutMs = 3000, extraIps = [] } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    let finished = false;
    const finish = () => { if (finished) return; finished = true; try { sock.close(); } catch (_) {} resolve([...found.values()].filter((d) => d.mac).map((d) => ({ ...d, ...capabilities(d.moduleName) }))); };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      let j; try { j = JSON.parse(msg.toString()); } catch (_) { return; }
      if (!j.result || !j.result.mac) return;
      const d = found.get(rinfo.address) || { ip: rinfo.address };
      if (j.method === 'getSystemConfig') Object.assign(d, {
        mac: j.result.mac, moduleName: j.result.moduleName, fwVersion: j.result.fwVersion,
        homeId: j.result.homeId, roomId: j.result.roomId,
      });
      if (j.method === 'getPilot') { d.mac = j.result.mac; d.rssi = j.result.rssi; d.pilot = j.result; }
      found.set(rinfo.address, d);
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch (_) {}
      const targets = new Set(['255.255.255.255', ...extraIps]);
      for (const s of localSubnets()) { targets.add(s.broadcast); s.hosts.forEach((h) => targets.add(h)); }
      const msgs = ['getPilot', 'getSystemConfig'].map((m) => Buffer.from(JSON.stringify({ method: m, params: {} })));
      // Stagger sends slightly so we don't flood the Wi-Fi radio.
      const list = [...targets]; let i = 0;
      const tick = () => {
        for (let n = 0; n < 32 && i < list.length; n++, i++) for (const b of msgs) sock.send(b, PORT, list[i], () => {});
        if (i < list.length) setTimeout(tick, 15);
      };
      tick();
      setTimeout(finish, timeoutMs);
    });
  });
}

/** Turn a getPilot result into a friendlier summary. */
function describePilot(p = {}) {
  if (!p) return { mode: 'unknown', on: false };
  const out = { on: !!p.state, brightness: Number.isFinite(Number(p.dimming)) ? clamp(Math.round(Number(p.dimming)), 0, 100) : undefined, rssi: Number.isFinite(Number(p.rssi)) ? Number(p.rssi) : undefined };
  if (p.sceneId && p.sceneId !== 0) { out.mode = 'scene'; out.sceneId = p.sceneId; out.scene = SCENES[p.sceneId] || `Scene ${p.sceneId}`; if (p.speed) out.speed = p.speed; }
  else if (p.r !== undefined || p.g !== undefined || p.b !== undefined) { const ch = (v) => clamp(Math.round(Number(v)) || 0, 0, 255); out.mode = 'color'; out.r = ch(p.r); out.g = ch(p.g); out.b = ch(p.b); out.c = ch(p.c); out.w = ch(p.w); out.hex = '#' + [out.r, out.g, out.b].map((v) => v.toString(16).padStart(2, '0')).join(''); }
  else if (p.temp !== undefined) { out.mode = 'white'; out.temp = clamp(Math.round(Number(p.temp)) || 2700, 1000, 10000); }
  else out.mode = 'unknown';
  return out;
}

module.exports = { PORT, SCENES, DYNAMIC_SCENES, NAMED_COLORS, send, getPilot, getSystemConfig, getUserConfig, setPilot, buildPilot, parseColor, capabilities, discover, describePilot, localSubnets };

'use strict';
/*
 * Tuya driver — local control for Tuya-based bulbs, plugs and switches
 * (Wipro, Syska, and many white-label brands).
 *
 * Tuya devices speak an encrypted protocol on TCP 6668. Every device has a per-device
 * "local key" that only the Tuya cloud hands out (via a free developer account, linked to
 * the brand's app). Without it, local control is impossible — the device ignores anything
 * it can't decrypt. So each Tuya device is added with { id (devId), key (localKey), ip,
 * version }.  Discovery finds Tuya devices on the LAN (and their version) but can't control
 * them until the key is supplied.
 *
 * Protocol versions:
 *   3.1 / 3.3  — AES-128-ECB payloads, CRC32 trailer, no session (3.3 widely used).
 *   3.4        — AES-128-ECB with a negotiated session key, HMAC-SHA256 trailer.
 *   3.5        — AES-128-GCM with a negotiated session key (frame prefix 0x00006699).
 *
 * NOTE: 3.4/3.5 session control is implemented to spec but has not been verified against a
 * physical device in this project. 3.3 encode/decode is covered by unit tests.
 */
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');

const PORT = 6668;
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest(); // well-known Tuya discovery key
const PREFIX_55AA = 0x000055aa, SUFFIX_55AA = 0x0000aa55;
const PREFIX_6699 = 0x00006699, SUFFIX_6699 = 0x00009966;
const CMD = { DP_QUERY: 0x0a, CONTROL: 0x07, CONTROL_NEW: 0x0d, DP_QUERY_NEW: 0x10, SESS_START: 0x03, SESS_RESP: 0x04, SESS_FINISH: 0x05 };

/* ---------------- CRC32 (for 3.1–3.3 trailers) ---------------- */
const CRC_TABLE = (() => { const t = new Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let crc = 0xffffffff; for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

/* ---------------- crypto helpers ---------------- */
function ecbEncrypt(data, key) { const c = crypto.createCipheriv('aes-128-ecb', key, null); return Buffer.concat([c.update(data), c.final()]); }
function ecbDecrypt(data, key) { const d = crypto.createDecipheriv('aes-128-ecb', key, null); return Buffer.concat([d.update(data), d.final()]); }
function gcmEncrypt(data, key, iv, aad) { const c = crypto.createCipheriv('aes-128-gcm', key, iv); if (aad) c.setAAD(aad); const ct = Buffer.concat([c.update(data), c.final()]); return { ct, tag: c.getAuthTag() }; }
function gcmDecrypt(ct, key, iv, aad, tag) { const d = crypto.createDecipheriv('aes-128-gcm', key, iv); if (aad) d.setAAD(aad); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]); }

/* ---------------- 55AA frame (3.1–3.4) ---------------- */
function pack55AA(seq, command, payload, { hmacKey } = {}) {
  const trailerLen = hmacKey ? 32 : 4;
  const head = Buffer.alloc(16);
  head.writeUInt32BE(PREFIX_55AA, 0); head.writeUInt32BE(seq >>> 0, 4); head.writeUInt32BE(command, 8);
  head.writeUInt32BE(payload.length + trailerLen + 4, 12); // payload + trailer + suffix(4)
  const body = Buffer.concat([head, payload]);
  const trailer = hmacKey ? crypto.createHmac('sha256', hmacKey).update(body).digest() : (() => { const b = Buffer.alloc(4); b.writeUInt32BE(crc32(body), 0); return b; })();
  const suffix = Buffer.alloc(4); suffix.writeUInt32BE(SUFFIX_55AA, 0);
  return Buffer.concat([body, trailer, suffix]);
}
function unpack55AA(buf, { hmacKey } = {}) {
  if (buf.readUInt32BE(0) !== PREFIX_55AA) throw new Error('bad 55AA prefix');
  const seq = buf.readUInt32BE(4), command = buf.readUInt32BE(8), len = buf.readUInt32BE(12);
  const trailerLen = hmacKey ? 32 : 4;
  let start = 16, retcode = 0;
  // A device→client reply carries a 4-byte return code before the payload.
  if (buf.length >= 20 && (buf.readUInt32BE(16) & 0xffffff00) === 0) { retcode = buf.readUInt32BE(16); start = 20; }
  const payload = buf.subarray(start, 16 + len - trailerLen - 4);
  return { seq, command, retcode, payload };
}

/* ---------------- 6699 frame (3.5, GCM) ---------------- */
function pack6699(seq, command, payload, sessionKey) {
  const iv = crypto.randomBytes(12);
  const header = Buffer.alloc(14);
  header.writeUInt16BE(0, 0); header.writeUInt32BE(seq >>> 0, 2); header.writeUInt32BE(command, 6);
  header.writeUInt32BE(12 + payload.length + 16, 10); // iv + ct + tag
  const { ct, tag } = gcmEncrypt(payload, sessionKey, iv, header);
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(PREFIX_6699, 0);
  const suffix = Buffer.alloc(4); suffix.writeUInt32BE(SUFFIX_6699, 0);
  return Buffer.concat([prefix, header, iv, ct, tag, suffix]);
}
function unpack6699(buf, sessionKey) {
  if (buf.readUInt32BE(0) !== PREFIX_6699) throw new Error('bad 6699 prefix');
  const header = buf.subarray(4, 18); // aad: reserved(2)+seq(4)+cmd(4)+len(4)
  const len = header.readUInt32BE(10);
  const iv = buf.subarray(18, 30);
  const ct = buf.subarray(30, 18 + len - 16), tag = buf.subarray(18 + len - 16, 18 + len);
  const pt = gcmDecrypt(ct, sessionKey, iv, header, tag);
  return { command: header.readUInt32BE(6), payload: pt.subarray(pt[0] === 0 ? 4 : 0) };
}

/* ---------------- discovery ---------------- */
function tryDecodeDiscovery(msg) {
  try {
    if (msg.readUInt32BE(0) === PREFIX_6699) { // 3.5 GCM broadcast
      const header = msg.subarray(4, 18), len = header.readUInt32BE(10);
      const iv = msg.subarray(18, 30), ct = msg.subarray(30, 18 + len - 16), tag = msg.subarray(18 + len - 16, 18 + len);
      let s = gcmDecrypt(ct, UDP_KEY, iv, header, tag).toString('utf8'); if (!s.startsWith('{')) s = s.slice(4);
      return JSON.parse(s);
    }
    // 3.1–3.4 broadcast: try plaintext then AES-ECB with the UDP key
    const body = msg.subarray(20, msg.length - 8);
    try { return JSON.parse(body.toString('utf8')); } catch (_) {}
    return JSON.parse(ecbDecrypt(body, UDP_KEY).toString('utf8'));
  } catch (_) { return null; }
}
function discover({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socks = [6666, 6667].map((port) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => {});
      s.on('message', (msg, rinfo) => {
        const info = tryDecodeDiscovery(msg); if (!info || !info.gwId) return;
        found.set(info.gwId, {
          driver: 'tuya', id: info.gwId, ip: info.ip || rinfo.address,
          version: info.version || '3.3', productKey: info.productKey,
          reachable: false, needsKey: true, kind: 'bulb',
          caps: { color: true, tunableWhite: true, dimmable: true, effects: false, kind: 'bulb' },
        });
      });
      try { s.bind(port); } catch (_) {}
      return s;
    });
    setTimeout(() => { socks.forEach((s) => { try { s.close(); } catch (_) {} }); resolve([...found.values()]); }, timeoutMs);
  });
}

/* ---------------- session + request ---------------- */
function keyBuf(localKey) { return Buffer.from(String(localKey), 'utf8'); }

/** One request/response over TCP. Handles 3.3 (ECB+CRC) and 3.4/3.5 (session) transparently. */
function request(dev, command, dpsPayload) {
  const version = String(dev.version || '3.3');
  const key = keyBuf(dev.key);
  if (key.length !== 16) return Promise.reject(new Error('Tuya local key must be 16 characters'));
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: dev.ip, port: PORT });
    let seq = 1, session = null, localNonce = null, done = false, buf = Buffer.alloc(0);
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch (_) {} err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error(`No reply from Tuya device ${dev.ip}`)), 4000);
    sock.setTimeout(4000, () => finish(new Error('Tuya connection timed out')));
    sock.on('error', finish);

    const build = (cmd, jsonObj) => {
      const payload = encodePayload(version, key, session, cmd, jsonObj);
      return version === '3.5' ? pack6699(seq, cmd, payload, session || key) : pack55AA(seq, cmd, payload, { hmacKey: version === '3.4' ? (session || key) : null });
    };
    const send = (cmd, jsonObj) => { seq++; sock.write(build(cmd, jsonObj)); };

    const sendControl = () => {
      const body = { devId: dev.id, uid: dev.id, t: Math.floor(Date.now() / 1000), dps: dpsPayload };
      if (command === CMD.DP_QUERY && !dpsPayload) { delete body.dps; }
      send(command === CMD.DP_QUERY ? (version >= '3.4' ? CMD.DP_QUERY_NEW : CMD.DP_QUERY) : (version >= '3.4' ? CMD.CONTROL_NEW : CMD.CONTROL), body);
    };

    sock.on('connect', () => {
      if (version === '3.4' || version === '3.5') {
        localNonce = Buffer.from('0123456789abcdef'); // 16 bytes; spec allows any nonce
        const p = version === '3.5' ? pack6699(seq, CMD.SESS_START, localNonce, key) : pack55AA(seq, CMD.SESS_START, ecbEncrypt(localNonce, key), { hmacKey: key });
        sock.write(p);
      } else { sendControl(); }
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Process complete frames.
      while (buf.length >= 20) {
        const isGcm = buf.readUInt32BE(0) === PREFIX_6699;
        const isLegacy = buf.readUInt32BE(0) === PREFIX_55AA;
        if (!isGcm && !isLegacy) { finish(new Error('Unrecognised Tuya frame')); return; }
        const len = buf.readUInt32BE(isGcm ? 14 : 12);
        const total = (isGcm ? 18 : 16) + len;
        if (buf.length < total) return; // wait for more
        const frame = buf.subarray(0, total); buf = buf.subarray(total);
        try { handleFrame(frame, isGcm); } catch (e) { finish(e); return; }
      }
    });

    function handleFrame(frame, isGcm) {
      if ((version === '3.4' || version === '3.5') && !session) {
        // Session negotiation reply → derive session key, send finish, then the real command.
        const remoteNonce = isGcm ? unpack6699(frame, key).payload.subarray(0, 16) : ecbDecrypt(unpack55AA(frame, { hmacKey: key }).payload, key).subarray(0, 16);
        const finishMsg = crypto.createHmac('sha256', key).update(remoteNonce).digest();
        if (version === '3.5') sock.write(pack6699(seq, CMD.SESS_FINISH, finishMsg, key));
        else sock.write(pack55AA(seq, CMD.SESS_FINISH, ecbEncrypt(finishMsg, key), { hmacKey: key }));
        // session key = AES(localNonce XOR remoteNonce) under the local key
        const xored = Buffer.alloc(16); for (let i = 0; i < 16; i++) xored[i] = localNonce[i] ^ remoteNonce[i];
        session = version === '3.5' ? gcmEncrypt(xored, key, localNonce.subarray(0, 12)).ct : ecbEncrypt(xored, key);
        seq++; sendControl();
        return;
      }
      const res = isGcm ? unpack6699(frame, session || key) : unpack55AA(frame, { hmacKey: version === '3.4' ? (session || key) : null });
      const payload = res.payload;
      if (!payload || !payload.length) return finish(null, {}); // ack with no body
      let json;
      try { json = JSON.parse(decodePayload(version, key, session, payload).toString('utf8')); }
      catch (e) { return finish(null, {}); }
      finish(null, json.dps || json);
    }
  });
}

function encodePayload(version, key, session, cmd, jsonObj) {
  const json = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  if (version === '3.5') return json; // GCM handles confidentiality at the frame layer
  if (version === '3.4') return ecbEncrypt(json, session || key);
  // 3.3: AES-ECB; DP_QUERY payloads are raw, CONTROL payloads get a version header
  const enc = ecbEncrypt(json, key);
  if (cmd === CMD.CONTROL) return Buffer.concat([Buffer.from('3.3'), Buffer.alloc(12), enc]);
  return enc;
}
function decodePayload(version, key, session, payload) {
  if (version === '3.5') return payload; // already decrypted by unpack6699
  // strip a leading "3.x" version header if present
  let p = payload;
  if (p.length > 15 && /^3\.[0-9]$/.test(p.subarray(0, 3).toString())) p = p.subarray(15);
  if (version === '3.4') return ecbDecrypt(p, session || key);
  try { return ecbDecrypt(p, key); } catch (_) { return p; }
}

/* ---------------- datapoint (DP) mapping ---------------- */
// Standard Tuya lighting DPs: 20 power, 21 mode, 22 brightness(10-1000), 23 temp(0-1000),
// 24 colour(hsv hex). Older devices use 1/2/3/4/5. Plugs use DP 1 for power.
function toHsvHex(r, g, b) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  const s = mx ? d / mx : 0, v = mx;
  return h.toString(16).padStart(4, '0') + Math.round(s * 1000).toString(16).padStart(4, '0') + Math.round(v * 1000).toString(16).padStart(4, '0');
}
function fromHsvHex(hex) {
  const h = parseInt(hex.slice(0, 4), 16), s = parseInt(hex.slice(4, 8), 16) / 1000, v = parseInt(hex.slice(8, 12), 16) / 1000;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c; let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [r, g, b].map((n) => Math.round((n + m) * 255));
}
function paramsToDps(dev, params) {
  const dps = {};
  if (dev.kind === 'plug' || dev.kind === 'switch') { if (params.state !== undefined) dps['1'] = !!params.state; return dps; }
  if (params.state !== undefined) dps['20'] = !!params.state;
  if (params.dimming !== undefined) { dps['20'] = true; dps['21'] = 'white'; dps['22'] = Math.round(10 + (Math.max(10, Math.min(100, params.dimming)) - 10) / 90 * 990); }
  if (params.temp !== undefined) { dps['20'] = true; dps['21'] = 'white'; dps['23'] = Math.round((Math.max(2200, Math.min(6500, params.temp)) - 2200) / 4300 * 1000); }
  if (params.r !== undefined || params.g !== undefined || params.b !== undefined) { dps['20'] = true; dps['21'] = 'colour'; dps['24'] = toHsvHex(params.r || 0, params.g || 0, params.b || 0); }
  return dps;
}
function dpsToState(dev, dps) {
  if (!dps) return null;
  if (dev.kind === 'plug' || dev.kind === 'switch') return { on: !!(dps['1'] ?? dps['20']), mode: 'plug' };
  const on = !!dps['20'], mode = dps['21'] === 'colour' ? 'color' : 'white';
  const out = { on, mode, brightness: dps['22'] != null ? Math.round(10 + (dps['22'] - 10) / 990 * 90) : 100 };
  if (mode === 'color' && dps['24']) { const [r, g, b] = fromHsvHex(dps['24']); out.r = r; out.g = g; out.b = b; out.hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''); }
  else if (dps['23'] != null) { out.temp = Math.round(2200 + dps['23'] / 1000 * 4300); }
  return out;
}

module.exports = {
  id: 'tuya', brand: 'Tuya', label: 'Wipro / Tuya', beta: true,
  addStyle: 'key', // needs devId + localKey
  scenes: () => [],
  discover,
  caps: (dev) => dev.caps || { color: true, tunableWhite: true, dimmable: true, effects: false, kind: dev.kind || 'bulb' },
  async getState(dev) { return dpsToState(dev, await request(dev, CMD.DP_QUERY, null)); },
  async setState(dev, params) { return request(dev, CMD.CONTROL, paramsToDps(dev, params)); },
  isTimeout: (e) => /No reply|timed out/.test(e && e.message),
  // exposed for unit tests
  _test: { pack55AA, unpack55AA, pack6699, unpack6699, crc32, toHsvHex, fromHsvHex, paramsToDps, dpsToState, ecbEncrypt, ecbDecrypt },
};

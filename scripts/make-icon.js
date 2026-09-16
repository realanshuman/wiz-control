#!/usr/bin/env node
'use strict';
// Draws the app icon (an amber orb on a dark rounded square) as a PNG, with no dependencies.
// node scripts/make-icon.js [size] [out.png]
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = Number(process.argv[2]) || 1024;
const OUT = process.argv[3] || path.join(__dirname, '..', 'build', `icon-${SIZE}.png`);

function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, t) => a + (b - a) * t;
const S = SIZE, px = Buffer.alloc(S * S * 4);
const pad = S * 0.1, rr = S * 0.22, cx = S / 2, cy = S / 2, orbR = S * 0.27;
const bg = [19, 22, 29], edge = [38, 44, 56];
const inRounded = (x, y) => { const l = pad, t = pad, r = S - pad, b = S - pad; if (x < l || x > r || y < t || y > b) return 0; const dx = Math.max(l + rr - x, 0, x - (r - rr)), dy = Math.max(t + rr - y, 0, y - (b - rr)); const d = Math.hypot(dx, dy); return d <= rr - 1 ? 1 : d >= rr + 1 ? 0 : (rr + 1 - d) / 2; };
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const i = (y * S + x) * 4; let r = 0, g = 0, b = 0, a = 0;
  const cov = inRounded(x + 0.5, y + 0.5);
  if (cov > 0) {
    // subtle vertical gradient on the tile
    const t = y / S; r = mix(bg[0] + 6, bg[0] - 4, t); g = mix(bg[1] + 6, bg[1] - 4, t); b = mix(bg[2] + 8, bg[2] - 4, t); a = 255 * cov;
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    // glow
    const glow = Math.max(0, 1 - d / (orbR * 2.1)); const gl = glow * glow * 0.85;
    r = mix(r, 245, gl); g = mix(g, 179, gl); b = mix(b, 59, gl * 0.9);
    // orb with highlight
    if (d < orbR + 1) {
      const e = Math.min(1, orbR + 1 - d);
      const hx = cx - orbR * 0.35, hy = cy - orbR * 0.4; const hd = Math.hypot(x - hx, y - hy) / (orbR * 1.5);
      const k = Math.max(0, 1 - hd);
      const or = mix(mix(245, 199, Math.min(1, d / orbR) * 0.55), 255, k * k * 0.9), og = mix(mix(179, 122, Math.min(1, d / orbR) * 0.6), 243, k * k * 0.9), ob = mix(mix(59, 16, Math.min(1, d / orbR) * 0.7), 214, k * k * 0.9);
      r = mix(r, or, e); g = mix(g, og, e); b = mix(b, ob, e);
    }
    // thin edge highlight on the tile
    const ed = 1 - Math.min(1, Math.min(x - pad, S - pad - x, y - pad, S - pad - y) / (S * 0.006)); if (ed > 0 && d > orbR * 1.6) { r = mix(r, edge[0], ed * 0.6); g = mix(g, edge[1], ed * 0.6); b = mix(b, edge[2], ed * 0.6); }
  }
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png(S, S, px));
console.log(`wrote ${OUT}`);

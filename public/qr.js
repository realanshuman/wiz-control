/* Minimal QR code encoder: byte mode, error-correction level M, versions 1-10, auto mask.
   qrMatrix(text) -> array of rows of 0/1. Small enough to inline in the web app. */
(function (global) {
  'use strict';
  const EC_M = [[0, 0], [1, 10], [1, 16], [1, 26], [2, 18], [2, 24], [4, 16], [4, 18], [4, 22], [5, 22], [5, 26]]; // [blocks, ecPerBlock] per version (index = version)
  const DATA_CW = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216]; // data codewords per version, level M
  const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  // GF(256) tables
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsPoly(n) { let p = [1]; for (let i = 0; i < n; i++) { const q = new Array(p.length + 1).fill(0); for (let j = 0; j < p.length; j++) { q[j] ^= p[j]; q[j + 1] ^= mul(p[j], EXP[i]); } p = q; } return p; }
  function rsEncode(data, n) { const g = rsPoly(n), r = new Array(n).fill(0); for (const d of data) { const f = d ^ r[0]; r.shift(); r.push(0); if (f) for (let j = 0; j < n; j++) r[j] ^= mul(g[j + 1], f); } return r; }
  function bits(bytes) { // build bit stream: mode 0100, count, data, terminator, pad
    const out = []; const push = (v, n) => { for (let i = n - 1; i >= 0; i--) out.push((v >> i) & 1); };
    return { out, push };
  }
  function encodeData(text, version) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const cap = DATA_CW[version] * 8; const { out, push } = bits();
    push(4, 4); push(bytes.length, version <= 9 ? 8 : 16); for (const b of bytes) push(b, 8);
    for (let i = 0; i < 4 && out.length < cap; i++) out.push(0);
    while (out.length % 8) out.push(0);
    const cw = []; for (let i = 0; i < out.length; i += 8) cw.push(parseInt(out.slice(i, i + 8).join(''), 2));
    for (let p = 0; cw.length < DATA_CW[version]; p++) cw.push(p % 2 ? 0x11 : 0xec);
    // split into blocks (level M: for these versions block sizes differ by at most 1)
    const [nb, ec] = EC_M[version]; const total = DATA_CW[version]; const short = Math.floor(total / nb), longer = total % nb;
    const blocks = []; let pos = 0;
    for (let b = 0; b < nb; b++) { const len = short + (b >= nb - longer ? 1 : 0); blocks.push(cw.slice(pos, pos + len)); pos += len; }
    const ecs = blocks.map((b) => rsEncode(b, ec));
    const res = []; const maxLen = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) res.push(b[i]);
    for (let i = 0; i < ec; i++) for (const e of ecs) res.push(e[i]);
    return res;
  }
  function chooseVersion(text) { const n = new TextEncoder().encode(text).length; for (let v = 1; v <= 10; v++) { const capBytes = DATA_CW[v] - (v <= 9 ? 2 : 3); if (n <= capBytes) return v; } throw new Error('Text too long for QR'); }
  function qrMatrix(text, forceMask) {
    const v = chooseVersion(text), N = v * 4 + 17;
    const m = Array.from({ length: N }, () => new Array(N).fill(null)); // null = data area
    const set = (r, c, val) => { if (r >= 0 && r < N && c >= 0 && c < N) m[r][c] = val; };
    const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); set(r + i, c + j, on ? 1 : 0); } };
    finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
    for (let i = 8; i < N - 8; i++) { m[6][i] = i % 2 ? 0 : 1; m[i][6] = i % 2 ? 0 : 1; }
    for (const a of ALIGN[v]) for (const b of ALIGN[v]) { if ((a <= 8 && b <= 8) || (a <= 8 && b >= N - 9) || (a >= N - 9 && b <= 8)) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(a + i, b + j, Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0); }
    // reserve format areas
    for (let i = 0; i < 8; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; if (m[8][N - 1 - i] === null) m[8][N - 1 - i] = 0; if (m[N - 1 - i][8] === null) m[N - 1 - i][8] = 0; }
    m[8][8] = 0; m[N - 8][8] = 1; // dark module
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { m[i][N - 11 + j] = 0; m[N - 11 + j][i] = 0; }
    const reserved = m.map((row) => row.map((x) => x !== null));
    // place data
    const data = encodeData(text, v); let bi = 0; const total = data.length * 8;
    let dir = -1, row = N - 1;
    for (let col = N - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (const cc of [col, col - 1]) if (!reserved[row][cc]) { const bit = bi < total ? (data[bi >> 3] >> (7 - (bi & 7))) & 1 : 0; m[row][cc] = bit; bi++; }
        row += dir; if (row < 0 || row >= N) { row -= dir; dir = -dir; break; }
      }
    }
    // masks
    const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
    const penalty = (g) => {
      let p = 0;
      for (let r = 0; r < N; r++) { let run = 1; for (let c = 1; c < N; c++) { if (g[r][c] === g[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
      for (let c = 0; c < N; c++) { let run = 1; for (let r = 1; r < N; r++) { if (g[r][c] === g[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
      for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) p += 3;
      const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      for (let r = 0; r < N; r++) for (let c = 0; c <= N - 11; c++) { let a = true, b = true; for (let k = 0; k < 11; k++) { if (g[r][c + k] !== pat[k]) a = false; if (g[r][c + k] !== pat2[k]) b = false; } if (a || b) p += 40; }
      for (let c = 0; c < N; c++) for (let r = 0; r <= N - 11; r++) { let a = true, b = true; for (let k = 0; k < 11; k++) { if (g[r + k][c] !== pat[k]) a = false; if (g[r + k][c] !== pat2[k]) b = false; } if (a || b) p += 40; }
      let dark = 0; for (const row of g) for (const x of row) dark += x; const pct = (dark * 100) / (N * N); p += Math.floor(Math.abs(pct - 50) / 5) * 10;
      return p;
    };
    const formatBits = (mask) => { const d = (0 << 3) | mask; /* level M = 00 */ let r = d << 10; const G = 0x537; for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= G << (i - 10); return ((d << 10) | r) ^ 0x5412; };
    const applyFormat = (g, mask) => { const f = formatBits(mask); const b = (i) => (f >> i) & 1;
      for (let i = 0; i < 6; i++) g[8][i] = b(14 - i); g[8][7] = b(8); g[8][8] = b(7); g[7][8] = b(6); for (let i = 0; i < 6; i++) g[5 - i][8] = b(5 - i);
      for (let i = 0; i < 8; i++) g[N - 1 - i][8] = b(14 - i); for (let i = 0; i < 8; i++) g[8][N - 8 + i] = b(7 - i); g[N - 8][8] = 1; };
    if (v >= 7) { // version information (18 bits, BCH 18,6)
      let r = v << 12; for (let i = 17; i >= 12; i--) if ((r >> i) & 1) r ^= 0x1f25 << (i - 12);
      const info = (v << 12) | r;
      for (let i = 0; i < 18; i++) { const bit = (info >> i) & 1; m[N - 11 + (i % 3)][Math.floor(i / 3)] = bit; m[Math.floor(i / 3)][N - 11 + (i % 3)] = bit; }
    }
    let best = null, bestP = Infinity;
    for (let mk = 0; mk < 8; mk++) { if (forceMask !== undefined && mk !== forceMask) continue;
      const g = m.map((row, r) => row.map((x, c) => (reserved[r][c] ? x : x ^ (MASKS[mk](r, c) ? 1 : 0))));
      applyFormat(g, mk); const p = penalty(g); if (p < bestP) { bestP = p; best = g; }
    }
    return best;
  }
  global.qrMatrix = qrMatrix;
})(typeof module !== 'undefined' ? module.exports : window);

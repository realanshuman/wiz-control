/* WiZ Control — web app. Talks to the bridge (server.js) over its JSON API.
   Served either by the bridge itself (local mode) or from a static host such as Vercel
   (hosted mode), in which case it connects to the bridge at http://localhost:4200. */
'use strict';

const REPO = 'https://github.com/realanshuman/wiz-control';
const REPO_SPEC = 'github:realanshuman/wiz-control';
// Fixed "latest build" release, refreshed by CI on every push to main. This URL is stable and
// always serves the newest files, so the buttons never 404 or bounce to a GitHub sign-in.
const REL = REPO + '/releases/download/latest';
const DOWNLOADS = {
  'mac-arm': { file: 'WiZ-Bridge-macOS-AppleSilicon.dmg', label: 'Mac · Apple silicon', sub: 'M1, M2, M3, M4' },
  'mac-intel': { file: 'WiZ-Bridge-macOS-Intel.dmg', label: 'Mac · Intel', sub: 'Macs before 2020' },
  'win': { file: 'WiZ-Bridge-Windows.exe', label: 'Windows', sub: '64-bit, Windows 10 or 11' },
  'linux': { file: 'wiz-bridge-linux-x64.tar.gz', label: 'Linux', sub: '64-bit' },
};
const DEFAULT_BRIDGE = 'http://localhost:4200';
const CANONICAL = 'https://wiz-control.vercel.app'; // the public copy; the bridge allows it by default
const isLoopback = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(u);
/** Normalise what the user typed as a bridge address. Returns null if unusable. */
function normalizeBridge(input) {
  let u = String(input || '').trim().replace(/\/+$/, '');
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { const p = new URL(u); return p.origin; } catch (_) { return null; }
}
/** Use a bridge address. A secure (https) page can't call an http:// address on the Wi-Fi,
 *  so for those we open the bridge's own copy of the app instead of trying and failing. */
function useBridge(input) {
  const u = normalizeBridge(input);
  if (!u) { toast('Enter an address like http://192.168.1.20:4200'); return false; }
  if (location.protocol === 'https:' && u.startsWith('http://') && !isLoopback(u)) { toast('Opening the app on your bridge…', true); setTimeout(() => { location.href = u + '/'; }, 400); return true; }
  ls.set('bridgeUrl', u); state.base = u; return true;
}
const TOUCH_HOLD = 2500; // ms after a user action during which polling won't overwrite a card

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get: (k) => { try { return localStorage.getItem('wiz.' + k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem('wiz.' + k, v); } catch (_) {} }, del: (k) => { try { localStorage.removeItem('wiz.' + k); } catch (_) {} } };

const state = {
  hosted: false, base: '', connected: false, info: null, // bridge
  bulbs: [], bulbsLoaded: false, scenes: [], cards: new Map(), touched: {}, expanded: new Set(),
  view: null, step: 1, timers: {},
};

/* ================= API ================= */
async function api(path, method = 'GET', body) {
  const r = await fetch(state.base + path, { method, headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : (method === 'GET' ? undefined : '{}'), cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText || 'Request failed');
  return j;
}
async function ping(base) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 2500);
    const r = await fetch(base + '/api/ping', { cache: 'no-store', signal: c.signal }); clearTimeout(t);
    const j = await r.json(); return j && j.name === 'wiz-control' ? j : null;
  } catch (_) { return null; }
}
const bridgeUrl = () => (ls.get('bridgeUrl') || DEFAULT_BRIDGE).replace(/\/+$/, '');

let toastT;
function toast(msg, ok = false) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (ok ? ' ok' : ''); clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 2800); }
function throttle(fn, ms) { let t, last, pend; return (...a) => { pend = a; const now = Date.now(); if (!last || now - last >= ms) { last = now; fn(...pend); pend = null; } else if (!t) t = setTimeout(() => { t = null; last = Date.now(); if (pend) fn(...pend); pend = null; }, ms - (now - last)); }; }
function stopTimers() { for (const k of Object.keys(state.timers)) { clearInterval(state.timers[k]); clearTimeout(state.timers[k]); delete state.timers[k]; } }

/* ================= colour maths ================= */
function hsv2rgb(h, s, v) { const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c; let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255)); }
function rgb2hsv(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx]; }
const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
function kelvin2rgb(k) { const t = k / 100; let r, g, b;
  r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))); }
const SCENE_COLORS = { 1: '#2b7de9', 2: '#ff5fa2', 3: '#ff7a3d', 4: '#c04cff', 5: '#ff8c1a', 6: '#ffb86b', 7: '#3ecf6b', 8: '#f7c6ff', 9: '#ffd27a', 10: '#8a4dff', 11: '#ffd39a', 12: '#fff1d6', 13: '#dfeeff', 14: '#6b4a1e', 15: '#e8f4ff', 16: '#ffc48a', 17: '#ffffff', 18: '#9ec9ff', 19: '#ff4fd8', 20: '#a6ff8a', 21: '#ffe45e', 22: '#ff9a3c', 23: '#1b4fd1', 24: '#1fa35a', 25: '#7dff9a', 26: '#ff2bd6', 27: '#ff3b3b', 28: '#ff7b00', 29: '#ffb347', 30: '#ffcf70', 31: '#ff6ec7', 32: '#c99a4a' };
const SWATCHES = [['#ff3b30', 'Red'], ['#ff7a00', 'Orange'], ['#ffd60a', 'Yellow'], ['#34c759', 'Green'], ['#00e5ff', 'Cyan'], ['#0a84ff', 'Blue'], ['#7d4dff', 'Purple'], ['#ff2d92', 'Pink'], ['#ffffff', 'White']];
const WHITE_PRESETS = [['Candle', 2200], ['Warm', 2700], ['Soft', 3000], ['Neutral', 4000], ['Daylight', 5000], ['Cool', 6500]];
/** "Colour" / "#ff8800" style pair for the card, including the off state. */
function describeSummary(s) {
  if (!s) return ['—', ''];
  const what = s.mode === 'color' ? ['Colour', s.hex] : s.mode === 'white' ? ['White', s.temp + 'K'] : s.mode === 'scene' ? ['Scene', s.scene] : ['On', ''];
  return s.on ? what : ['Off', what[1] ? `${what[0]} ${what[1]}` : ''];
}
function summaryColor(s) { if (!s || !s.on) return '#2a2f3a'; if (s.mode === 'color') return s.hex; if (s.mode === 'white') return hex(...kelvin2rgb(s.temp)); if (s.mode === 'scene') return SCENE_COLORS[s.sceneId] || '#fff'; return '#ffd39a'; }

/* ================= QR / phone access ================= */
function qrSvg(text) {
  const m = qrMatrix(text), N = m.length; let d = '';
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (m[r][c]) d += `M${c} ${r}h1v1h-1z`;
  return `<svg viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${esc(text)}"><path d="${d}" fill="#000"/></svg>`;
}
/** Block with a QR code that opens the bridge's own address on a phone. Empty string if the bridge isn't reachable from the Wi-Fi. */
function phoneBlock(info, compact) {
  info = info || {}; const ip = (info.lanIps || [])[0];
  if (!info.lan || !ip) return '';
  const url = `http://${ip}:${info.port || 4200}`;
  return `<div class="phone"><div class="qr">${qrSvg(url)}</div><div class="txt"><b>Use it on your phone</b><span>Scan with the phone's camera while on the same Wi-Fi${compact ? '' : ', or type the address. Add it to your home screen for an app-like experience'}.</span><div class="url"><code>${esc(url)}</code><button class="copyurl" data-url="${esc(url)}">Copy</button></div></div></div>`;
}
function wireCopy(root) { $$('.copyurl', root).forEach((b) => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.url); toast('Address copied', true); } catch (_) { toast(b.dataset.url); } })); }

/* ================= views ================= */
const ICON = {
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  apple: '<svg viewBox="0 0 24 24"><path d="M16.4 12.7c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.2-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.4-2.8-.1 0-2.7-1-2.7-4.1zM14 5.5c.7-.8 1.1-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z"/></svg>',
  windows: '<svg viewBox="0 0 24 24"><path d="M3 5.5 11 4.4v7.2H3zm0 13 8 1.1v-7.2H3zm9-15.4L22 2v9.6h-10zm0 8.5h10V22l-10-1.5z"/></svg>',
  linux: '<svg viewBox="0 0 24 24"><path d="M12 2c-2.5 0-4 2-4 4.5 0 1.5.3 2.3-.6 3.7C6 12.3 5 14 5 16c0 .8.2 1.5.5 2.1-.9.3-1.5 1-1.5 1.9 0 1.1 1 2 2.3 2h2.2c.9 0 1.6-.5 2-1.2.5.1 1 .2 1.5.2s1-.1 1.5-.2c.4.7 1.1 1.2 2 1.2h2.2c1.3 0 2.3-.9 2.3-2 0-.9-.6-1.6-1.5-1.9.3-.6.5-1.3.5-2.1 0-2-1-3.7-2.4-5.8-.9-1.4-.6-2.2-.6-3.7C16 4 14.5 2 12 2zm-1.5 4.5a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6zm3 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6zM12 9l1.5 1-1.5 1-1.5-1z"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><path d="M12 2v10"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.5"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>',
  wifi: '<svg viewBox="0 0 24 24"><path d="M5 12.6a11 11 0 0 1 14 0"/><path d="M8.5 16a6 6 0 0 1 7 0"/><path d="M2 9a15.5 15.5 0 0 1 20 0"/><circle cx="12" cy="19.5" r=".8"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  palette: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0 0 18c1 0 1.5-.6 1.5-1.4 0-.6-.3-.9-.6-1.3-.3-.4-.6-.8-.6-1.3 0-.8.6-1.5 1.5-1.5H15a6 6 0 0 0 6-6c0-3.6-4-6.5-9-6.5z"/><circle cx="7.5" cy="12" r="1"/><circle cx="9.5" cy="8" r="1"/><circle cx="14.5" cy="8" r="1"/></svg>',
};
function show(view) {
  stopTimers();
  state.view = view;
  const root = $('#root'); root.innerHTML = ''; root.className = 'view';
  window.scrollTo(0, 0);
  return root;
}
function topbar({ back, title, sub, right = '' } = {}) {
  return `<header class="topbar">
    ${back ? `<button class="iconbtn ghost" id="tb-back" title="Back">${ICON.back}</button>` : ''}
    ${title ? `<div class="home-title"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>` : `<a class="brand" href="./"><span class="dot"></span>WiZ Control</a>`}
    <span class="spacer"></span>${right}
  </header>`;
}

/* ---------- landing (hosted, first visit) ---------- */
// Per-device install wording for step 1, chosen by the visitor's device (and switchable).
const DEVICES = {
  mac: { name: 'Mac', icon: ICON.apple, dls: ['mac-arm', 'mac-intel'],
    how: 'Open the downloaded file, drag <b>WiZ Bridge</b> onto the <b>Applications</b> folder, then open it from Applications.',
    tip: 'Most Macs from 2020 on are Apple silicon. Older ones are Intel.' },
  win: { name: 'Windows', icon: ICON.windows, dls: ['win'],
    how: 'Open the downloaded file. If Windows shows a blue box, click <b>More info</b>, then <b>Run anyway</b>. Allow it through the firewall so your phone can connect too.' },
  linux: { name: 'Linux', icon: ICON.linux, dls: ['linux'],
    how: 'Unpack the download and run <code>./wiz-bridge</code> in a terminal.' },
};
function dlButton(key, primary) {
  const d = DOWNLOADS[key], ico = key.startsWith('mac') ? ICON.apple : key === 'win' ? ICON.windows : ICON.linux;
  return `<a class="dlbtn${primary ? ' primary' : ''}" href="${REL}/${d.file}" download data-start><span class="di">${ico}</span><span class="dt"><b>${d.label}</b><i>${d.sub}</i></span>${ICON.download}</a>`;
}
function step1Html(dev) {
  const d = DEVICES[dev];
  return `<p class="lstep-how">${d.how}</p>
    <div class="dls">${d.dls.map((k, i) => dlButton(k, i === 0)).join('')}</div>
    ${d.tip ? `<p class="lstep-tip">${d.tip}</p>` : ''}
    <p class="lstep-alt">On a different computer? <button class="linklike" data-dev="${dev === 'mac' ? 'win' : 'mac'}">Show ${dev === 'mac' ? 'Windows' : 'Mac'}</button> · <button class="linklike" data-dev="${dev === 'linux' ? 'mac' : 'linux'}">${dev === 'linux' ? 'Mac' : 'Linux'}</button></p>`;
}
function renderLanding() {
  const root = show('landing');
  const os = detectOS();
  const onPhone = os === 'mobile';
  let dev = ['mac', 'win', 'linux'].includes(os) ? os : 'mac';
  root.innerHTML = topbar({ right: `<a class="ghost gh-link" href="${REPO}" target="_blank" rel="noopener">GitHub</a><button class="primary" id="start">Get started</button>` }) + `
  <section class="hero">
    <div class="orb-hero"></div>
    <div class="eyebrow">${ICON.bolt.replace('<svg', '<svg width="14" height="14" fill="currentColor"')} For Philips WiZ bulbs</div>
    <h1>Your lights, on your Wi-Fi.<br>No app, no cloud.</h1>
    <p>Turn WiZ bulbs on and off, dim them, pick any colour or white, and run scenes — all from this page, straight over your home network.</p>
    <div class="cta"><button class="primary lg" id="start2">Set it up — 3 steps</button><a class="ghost see-how" href="#steps">See how it works</a></div>
  </section>

  <section class="steps-land" id="steps">
    <h2>Get going in 3 steps</h2>
    <p class="lead">The bulbs only listen to devices on the same Wi-Fi, so this page uses a tiny free helper — the <b>bridge</b> — that runs on a computer at home. You set it up once.</p>
    <ol class="lsteps">
      <li class="lstep">
        <div class="ln">1</div>
        <div class="lbody">
          <h3>Install the bridge on your computer</h3>
          ${onPhone ? `<div class="phone-note">${ICON.wifi}<span>You're on a phone. Do this one step on a computer that's on the same Wi-Fi as your bulbs. After that, you'll control everything from your phone.</span></div>` : ''}
          <div id="lstep1">${step1Html(dev)}</div>
        </div>
      </li>
      <li class="lstep">
        <div class="ln">2</div>
        <div class="lbody"><h3>Name your home</h3><p>Type your name, your home's name, and your Wi-Fi. It's saved on your own computer, never in a cloud.</p></div>
      </li>
      <li class="lstep">
        <div class="ln">3</div>
        <div class="lbody"><h3>Find your bulbs and go</h3><p>One tap scans your Wi-Fi and lists every bulb. Name them, then control them here — or from your phone by scanning a QR code.</p></div>
      </li>
    </ol>
    <div class="steps-cta"><button class="primary lg" id="start3">I've installed it — continue</button></div>
  </section>

  <section class="features">
    <div class="feature"><div class="ico">${ICON.wifi}</div><b>Finds your bulbs itself</b><p>Scans your Wi-Fi and lists every WiZ bulb, strip and plug. Name them once; they stay named.</p></div>
    <div class="feature"><div class="ico">${ICON.palette}</div><b>Every colour and scene</b><p>A colour wheel, warm-to-cool whites, brightness, and all 32 built-in WiZ scenes.</p></div>
    <div class="feature"><div class="ico">${ICON.lock}</div><b>Private by design</b><p>No account, no middle-man servers. Commands go straight to the bulbs — even with the internet down.</p></div>
  </section>
  <footer class="site">Free and open source · <a href="${REPO}" target="_blank" rel="noopener">${REPO.replace('https://', '')}</a> · Works with WiZ bulbs already on your Wi-Fi.</footer>`;

  const go = () => { ls.set('started', '1'); renderWizard(1); };
  $('#start').addEventListener('click', go);
  $('#start2').addEventListener('click', go);
  $('#start3').addEventListener('click', go);
  // Device switcher + download buttons (delegated, survives step-1 re-renders).
  root.addEventListener('click', (e) => {
    const swap = e.target.closest('[data-dev]');
    if (swap) { dev = swap.dataset.dev; $('#lstep1').innerHTML = step1Html(dev); return; }
    if (e.target.closest('[data-start]')) { ls.set('started', '1'); setTimeout(() => renderWizard(1), 500); } // let the download begin, then move on
  });
}

/* ---------- wizard ---------- */
const STEPS = ['Connect', 'Your home', 'Bulbs', 'Ready'];
function stepsHtml(cur) {
  return `<div class="steps">${STEPS.map((t, i) => { const n = i + 1; const cls = n < cur ? 'done' : n === cur ? 'active' : ''; return `<div class="step ${cls}"><span class="b">${n < cur ? ICON.check.replace('<svg', '<svg width="12" height="12" stroke="currentColor" fill="none" stroke-width="3"') : n}</span><span class="t">${t}</span></div>${i < STEPS.length - 1 ? `<span class="bar ${n < cur ? 'done' : ''}"></span>` : ''}`; }).join('')}</div>`;
}
function detectOS() {
  const ua = navigator.userAgent, p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/iPhone|iPad|Android/i.test(ua) || (/Mac/i.test(p) && navigator.maxTouchPoints > 1)) return 'mobile';
  if (/Mac/i.test(p) || /Macintosh/i.test(ua)) return 'mac';
  if (/Win/i.test(p) || /Windows/i.test(ua)) return 'win';
  if (/Linux|X11/i.test(p) && !/Android/i.test(ua)) return 'linux';
  return 'other';
}
function renderWizard(step) {
  state.step = step;
  const root = show('wizard');
  root.innerHTML = topbar() + `<div class="wizard">${stepsHtml(step)}<div class="card-w" id="wz"></div></div>`;
  ({ 1: wizConnect, 2: wizHome, 3: wizBulbs, 4: wizDone })[step]();
}

function wizConnect() {
  const el = $('#wz'); const os = detectOS();
  const dl = (k, hot) => `<a class="${hot ? 'hot' : ''}" href="${REL}/${DOWNLOADS[k].file}" download><span class="ic">${k.startsWith('mac') ? ICON.apple : k === 'win' ? ICON.windows : ICON.linux}</span><span><b>${DOWNLOADS[k].label}</b><span>${DOWNLOADS[k].sub}</span></span></a>`;
  const order = os === 'win' ? ['win', 'mac-arm', 'mac-intel', 'linux'] : os === 'linux' ? ['linux', 'mac-arm', 'mac-intel', 'win'] : ['mac-arm', 'mac-intel', 'win', 'linux'];
  const originFlag = state.hosted && !isLoopback(location.origin) && location.origin !== CANONICAL ? ` --origin ${location.origin}` : '';
  const choosing = !!state.choosingBridge;
  el.innerHTML = `
    <h2>First, open the bridge</h2>
    <p>WiZ bulbs only listen to devices on the same Wi-Fi, so this page needs a small helper on a computer at home. Download it, open it${os === 'mac' ? ' (drag it into Applications, then open it from there)' : ''}, and this page will notice by itself.</p>
    ${os === 'mobile' ? `<div class="tips" style="margin-bottom:14px"><span>You're on a phone or tablet. Do the setup once on a computer that's on the same Wi-Fi as your bulbs. Its Settings page then shows a QR code that opens the app on this phone.</span></div>` : ''}
    ${os === 'mobile' ? `<details><summary>Downloads for a computer</summary><div class="body"><div class="dl">${order.map((k) => dl(k, false)).join('')}</div></div></details>` : `<div class="dl">${order.map((k, i) => dl(k, i === 0 && os !== 'other' && !(os === 'mac' && i === 1))).join('')}</div>`}
    <div class="wait" id="wait"><span class="pulse"></span><span>Waiting for the bridge to start…</span></div>
    <details><summary>Your computer asks a question when you open it?</summary><div class="body">
      <span><b>Mac, "can't verify the developer":</b> open <b>System Settings → Privacy &amp; Security</b>, scroll down and click <b>Open Anyway</b>. Once.</span>
      <span><b>Mac, "wants to find devices on your local network":</b> click <b>Allow</b>, or it can't see the bulbs.</span>
      <span><b>Windows, "protected your PC":</b> click <b>More info → Run anyway</b>. If the firewall asks, click <b>Allow access</b> so your phone can connect too.</span>
    </div></details>
    <details><summary>Prefer the command line?</summary><div class="body">
      <span>With <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a> installed, this runs the same bridge without downloading anything:</span>
      <pre>npx -y ${REPO_SPEC}${originFlag}</pre>
    </div></details>
    <details${choosing ? ' open' : ''}><summary>Bridge running on another computer?</summary><div class="body">
      <span>Enter its address, shown when the bridge starts (for example <code>http://192.168.1.20:4200</code>).</span>
      <div class="row"><input type="url" id="burl" value="${esc(state.hosted ? bridgeUrl() : location.origin)}" spellcheck="false" inputmode="url" autocapitalize="off"><button id="bset">Use</button></div>
    </div></details>
    <div class="actions"><button class="ghost left" id="wz-back">Back</button><button class="primary" id="next" disabled>Continue</button></div>`;
  $('#wz-back').addEventListener('click', () => { state.choosingBridge = false; state.hosted ? renderLanding() : renderWizard(2); });
  $('#bset').addEventListener('click', () => { if (useBridge($('#burl').value)) { state.choosingBridge = false; $('#wait').className = 'wait'; $('#wait').innerHTML = '<span class="pulse"></span><span>Looking for the bridge…</span>'; $('#next').disabled = true; check(); } });
  $('#burl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#bset').click(); });
  const proceed = () => { state.choosingBridge = false; const info = state.info; if (info && info.profile && info.profile.completed) { ls.del('loggedOut'); ls.set('completed', '1'); return renderDashboard(); } renderWizard(info && info.profile ? 3 : 2); };
  $('#next').removeEventListener('click', null); $('#next').onclick = proceed;
  const check = async () => {
    const info = await ping(state.base);
    if (!info) return;
    state.info = info; state.connected = true;
    if (state.view !== 'wizard' || state.step !== 1) return;
    $('#wait').className = 'wait ok'; $('#wait').innerHTML = `<span class="check">${ICON.check}</span><span>Connected to the bridge on <b>${esc(info.computer || 'this computer')}</b>${info.wifi ? ` · Wi-Fi <b>${esc(info.wifi)}</b>` : ''}</span>`;
    $('#next').disabled = false;
    clearInterval(state.timers.ping);
    if (state.choosingBridge) return; // the user is picking a bridge: let them confirm
    if (!state.scenes.length) { try { state.scenes = await api('/api/scenes'); } catch (_) {} }
    if (info.profile && info.profile.completed) return proceed();
    state.timers.auto = setTimeout(() => { if (state.view === 'wizard' && state.step === 1) renderWizard(2); }, 1400);
  };
  check(); state.timers.ping = setInterval(check, 2000);
}

function wizHome() {
  const el = $('#wz'); const info = state.info || {}; const p = info.profile || {};
  const homeGuess = p.homeName || (info.wifi ? `${info.wifi} Home` : '');
  el.innerHTML = `
    <h2>Name your home</h2>
    <p>This is how the app greets you. It's saved on your bridge${info.computer ? ` (<b>${esc(info.computer)}</b>)` : ''}, not in any cloud.</p>
    <div class="field"><label for="f-owner">Your name</label><input type="text" id="f-owner" placeholder="e.g. Anshuman" value="${esc(p.ownerName || '')}" maxlength="60" autocomplete="given-name"></div>
    <div class="field"><label for="f-home">Home name</label><input type="text" id="f-home" placeholder="e.g. Anshuman's Home" value="${esc(homeGuess)}" maxlength="60"></div>
    <div class="field"><label for="f-wifi">Wi-Fi network</label><input type="text" id="f-wifi" placeholder="${info.wifi ? '' : 'The Wi-Fi your bulbs are on'}" value="${esc(p.wifiName || info.wifi || '')}" maxlength="60">
      <span class="hint">${info.wifi ? 'Detected from the bridge. Change it if that\'s not the network your bulbs use.' : 'Your computer didn\'t share the network name, so type it. It\'s only a label.'}</span></div>
    <div class="actions">${state.hosted ? '<button class="ghost left" id="wz-back">Back</button>' : ''}<button class="primary" id="next">Continue</button></div>`;
  if ($('#wz-back')) $('#wz-back').addEventListener('click', () => renderWizard(1));
  const submit = async () => {
    const ownerName = $('#f-owner').value.trim(), homeName = $('#f-home').value.trim() || (ownerName ? `${ownerName}'s Home` : 'My Home'), wifiName = $('#f-wifi').value.trim();
    if (!ownerName) { $('#f-owner').focus(); toast('Tell us your name first'); return; }
    $('#next').disabled = true;
    try { const prof = await api('/api/profile', 'PUT', { ownerName, homeName, wifiName }); state.info = { ...(state.info || {}), profile: prof }; renderWizard(3); }
    catch (e) { toast(e.message); $('#next').disabled = false; }
  };
  $('#next').addEventListener('click', submit);
  $$('#wz input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
  setTimeout(() => $('#f-owner').focus(), 50);
}

function wizBulbs() {
  const el = $('#wz');
  el.innerHTML = `
    <h2>Find your bulbs</h2>
    <p>Make sure the bulbs are powered on. Scanning takes a few seconds.</p>
    <div id="found"><div class="scan"><span class="spinner"></span><span>Scanning ${esc((state.info && state.info.profile && state.info.profile.wifiName) || 'your Wi-Fi')}…</span></div></div>
    <div class="actions"><button class="ghost left" id="wz-back">Back</button><button id="rescan" disabled>Scan again</button><button class="primary" id="next" disabled>Continue</button></div>`;
  $('#wz-back').addEventListener('click', () => renderWizard(2));
  $('#next').addEventListener('click', () => renderWizard(4));
  const list = (bulbs) => {
    const on = bulbs.filter((b) => b.online);
    if (!bulbs.length) {
      $('#found').innerHTML = `<div class="tips">
        <b style="color:var(--text);margin-left:-16px">No bulbs answered. Things to check:</b>
        <span>• The bulb is switched on at the wall (it needs power to answer).</span>
        <span>• The computer running the bridge is on the same Wi-Fi as the bulbs. WiZ bulbs use the 2.4 GHz band.</span>
        <span>• The bulb was set up on this Wi-Fi once, using the WiZ app. That's the only time the app is needed.</span>
        <span>• Guest networks or "client isolation" on the router block devices from seeing each other.</span>
        <span>• On a Mac, WiZ Bridge needs permission to find devices on the local network (System Settings → Privacy &amp; Security → Local Network). On Windows, allow it through the firewall.</span>
      </div>`;
      $('#next').textContent = 'Skip for now'; $('#next').disabled = false; return;
    }
    $('#found').innerHTML = `<div class="found">${bulbs.map((b) => `<div class="b" data-mac="${b.mac}">
        <span class="orb" style="background:${esc(summaryColor(b.summary))};--glow:${esc(summaryColor(b.summary))}88"></span>
        <input type="text" value="${esc(b.name)}" maxlength="40" title="Name this bulb" aria-label="Bulb name">
        <span class="spacer"></span><span class="meta">${esc(b.kind)}${b.online ? '' : ' · offline'}</span>
      </div>`).join('')}</div>
      <p class="small muted" style="margin:10px 2px 0">Found ${on.length} bulb${on.length === 1 ? '' : 's'}. Click a name to change it, e.g. "Bedroom" or "Desk lamp".</p>`;
    $$('#found input').forEach((inp) => {
      const mac = inp.closest('.b').dataset.mac;
      const save = async () => { const v = inp.value.trim(); if (!v) { inp.value = inp.defaultValue; return; } try { await api('/api/bulbs/' + mac, 'PATCH', { name: v }); inp.defaultValue = v; const sb = state.bulbs.find((x) => x.mac === mac); if (sb) sb.name = v; } catch (e) { toast(e.message); } };
      inp.addEventListener('change', save); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    });
    $('#next').textContent = 'Continue'; $('#next').disabled = false;
  };
  const scan = async () => {
    $('#rescan').disabled = true; $('#next').disabled = true;
    try { const bulbs = await api('/api/discover', 'POST'); state.bulbs = bulbs; if (state.view === 'wizard' && state.step === 3) list(bulbs); }
    catch (e) { toast(e.message); $('#found').innerHTML = `<div class="tips"><span>Couldn't scan: ${esc(e.message)}</span></div>`; }
    $('#rescan').disabled = false;
  };
  $('#rescan').addEventListener('click', () => { $('#found').innerHTML = `<div class="scan"><span class="spinner"></span><span>Scanning again…</span></div>`; scan(); });
  scan();
}

function wizDone() {
  const el = $('#wz'); const p = (state.info && state.info.profile) || {};
  const on = state.bulbs.filter((b) => b.online).length;
  el.innerHTML = `
    <div class="done-hero"><div class="orb-hero"></div>
      <h2>${esc(p.homeName || 'Your home')} is ready${p.ownerName ? `, ${esc(p.ownerName)}` : ''}</h2>
      <p class="muted" style="margin:0">Everything is set. You can rename bulbs, rescan, or change these details any time from Settings.</p>
      ${phoneBlock(state.info, true)}
      <div class="stats"><div class="stat"><b>${state.bulbs.length}</b><span>bulb${state.bulbs.length === 1 ? '' : 's'} saved</span></div><div class="stat"><b>${on}</b><span>online now</span></div>${p.wifiName ? `<div class="stat"><b style="font-size:16px;padding-top:4px">${esc(p.wifiName)}</b><span>Wi-Fi</span></div>` : ''}</div>
    </div>
    <div class="actions"><button class="ghost left" id="wz-back">Back</button><button class="primary lg" id="open">Open my dashboard</button></div>`;
  $('#wz-back').addEventListener('click', () => renderWizard(3));
  wireCopy(el);
  $('#open').addEventListener('click', async () => {
    try { const prof = await api('/api/profile', 'PUT', { completed: true }); state.info = { ...(state.info || {}), profile: prof }; ls.set('completed', '1'); renderDashboard(); }
    catch (e) { toast(e.message); }
  });
}

/* ---------- log out / welcome back ---------- */
function logout() {
  ls.set('loggedOut', '1');
  renderWelcome();
}
function renderWelcome() {
  const root = show('welcome'); const p = (state.info && state.info.profile) || {};
  root.innerHTML = topbar({ right: `<a class="ghost" href="${REPO}" target="_blank" rel="noopener" style="color:var(--muted);text-decoration:none;font-size:13.5px;padding:7px 10px">GitHub</a>` }) + `
  <div class="lost"><div class="card-w done-hero" style="text-align:center">
    <div class="orb-hero" style="width:86px;height:86px;margin-bottom:22px"></div>
    <h2>Welcome back${p.ownerName ? `, ${esc(p.ownerName)}` : ''}</h2>
    <p class="muted" style="margin:0 0 22px">${esc(p.homeName || 'Your home')} is ready on ${esc((state.info && state.info.computer) || 'the bridge')}.</p>
    <div class="stack" style="align-items:center">
      <button class="primary lg" id="cont">Continue to ${esc(p.homeName || 'my home')}</button>
      ${state.hosted ? '<button class="ghost" id="other">Use a different bridge</button>' : ''}
    </div>
  </div></div>`;
  $('#cont').addEventListener('click', () => { ls.del('loggedOut'); ls.set('completed', '1'); renderDashboard(); });
  if ($('#other')) $('#other').addEventListener('click', () => { ls.del('loggedOut'); ls.set('started', '1'); state.choosingBridge = true; renderWizard(1); });
}

/* ---------- bridge lost (hosted) ---------- */
function renderLost() {
  const root = show('lost');
  root.innerHTML = topbar({ right: `<span class="chip"><span class="st"></span>Bridge offline</span>` }) + `
  <div class="lost"><div class="card-w">
    <h2>Your bridge isn't running</h2>
    <p>Open <b>WiZ Bridge</b> on the computer at home and this page will reconnect on its own.${state.hosted ? ` Looking for it at <code>${esc(state.base)}</code>.` : ''}</p>
    <div class="wait"><span class="pulse"></span><span>Waiting for the bridge…</span></div>
    ${state.hosted ? `<details><summary>Change the bridge address</summary><div class="body"><div class="row"><input type="url" id="burl" value="${esc(state.base)}" spellcheck="false" inputmode="url" autocapitalize="off"><button id="bset">Use</button></div></div></details>
    <details><summary>Don't have the bridge any more?</summary><div class="body"><span>Download it again from the setup steps.</span><div><button id="redo">Go to setup</button></div></div></details>` : ''}
  </div></div>`;
  if ($('#bset')) $('#bset').addEventListener('click', () => { if (useBridge($('#burl').value)) boot(); });
  if ($('#redo')) $('#redo').addEventListener('click', () => { state.choosingBridge = true; renderWizard(1); });
  state.timers.ping = setInterval(async () => { const info = await ping(state.base); if (info) { state.info = info; state.connected = true; boot(); } }, 2500);
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  const root = show('dashboard'); const p = (state.info && state.info.profile) || {};
  const sub = [p.ownerName, p.wifiName ? `Wi-Fi ${p.wifiName}` : ''].filter(Boolean).join(' · ');
  root.innerHTML = topbar({ title: p.homeName || 'My home', sub, right: `
      <span class="chip on hide-m" id="count"><span class="st"></span><span>…</span></span>
      <button id="allOn" class="hide-m">All on</button><button id="allOff" class="hide-m">All off</button>
      <button class="primary hide-m" id="discover">Discover</button>
      <div class="umenu"><button class="avatar" id="ubtn" title="${esc(p.ownerName || 'Account')}" aria-haspopup="menu" aria-expanded="false">${esc((p.ownerName || 'W').trim().charAt(0).toUpperCase())}</button>
        <div class="dropdown" id="udrop" hidden role="menu">
          <div class="who"><b>${esc(p.ownerName || 'You')}</b><span>${esc(p.homeName || '')}</span></div>
          <button role="menuitem" id="settings">${ICON.gear}<span>Settings</span></button>
          <button role="menuitem" id="logout">${ICON.logout}<span>Log out</span></button>
        </div></div>` }) +
    `<main class="grid" id="main"></main>
    <nav class="bottombar" aria-label="Quick actions"><button id="m-off">${ICON.power}<span>All off</span></button><button id="m-on">${ICON.sun}<span>All on</span></button><button class="primary" id="m-disc">${ICON.scan}<span>Discover</span></button></nav>`;
  state.cards.clear();
  const drop = $('#udrop'), ubtn = $('#ubtn');
  ubtn.addEventListener('click', (e) => { e.stopPropagation(); drop.hidden = !drop.hidden; ubtn.setAttribute('aria-expanded', String(!drop.hidden)); });
  if (!state.scenes.length) api('/api/scenes').then((sc) => { state.scenes = sc; state.cards.forEach((c) => c.remove()); state.cards.clear(); renderCards(); }).catch(() => {});
  $('#settings').addEventListener('click', renderSettings);
  $('#logout').addEventListener('click', logout);
  $('#discover').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Scanning…';
    try { state.bulbs = await api('/api/discover', 'POST'); state.bulbsLoaded = true; renderCards(); toast(plural(state.bulbs.filter((b) => b.online).length, 'bulb') + ' online', true); }
    catch (err) { toast(err.message); }
    finally { e.target.disabled = false; e.target.textContent = 'Discover'; }
  });
  const all = (on) => { state.bulbs.forEach((b) => (state.touched[b.mac] = Date.now())); state.cards.forEach((c) => { $('.power', c).checked = on; c.classList.toggle('off', !on); }); api('/api/all', 'POST', { state: on }).catch((e) => toast(e.message)); };
  $('#allOn').addEventListener('click', () => all(true)); $('#allOff').addEventListener('click', () => all(false));
  $('#m-on').addEventListener('click', () => all(true)); $('#m-off').addEventListener('click', () => all(false)); $('#m-disc').addEventListener('click', () => $('#discover').click());
  renderCards();
  refresh();
  state.timers.poll = setInterval(refresh, 3000);
}
async function refresh() {
  try {
    const bulbs = await api('/api/bulbs');
    if (state.view !== 'dashboard') return;
    state.bulbs = bulbs; state.bulbsLoaded = true; state.connected = true; renderCards();
  } catch (e) {
    if (state.view !== 'dashboard') return;
    const info = await ping(state.base); if (!info) { state.connected = false; return renderLost(); }
    toast(e.message);
  }
}
function renderCards() {
  const main = $('#main'); if (!main) return;
  if (!state.bulbsLoaded && !state.bulbs.length) { main.innerHTML = '<div class="empty" style="border:0"><span class="spinner"></span></div>'; return; }
  if (!state.bulbs.length) {
    main.innerHTML = `<div class="empty"><b>No bulbs yet</b><span>Switch the bulbs on and press Discover. They must be on the same Wi-Fi as the bridge.</span><button class="primary" id="disc2">Discover bulbs</button></div>`;
    $('#disc2').addEventListener('click', () => $('#discover').click()); state.cards.clear();
    $('#count').lastElementChild.textContent = 'No bulbs'; return;
  }
  if (main.querySelector('.empty')) main.innerHTML = '';
  const seen = new Set();
  for (const b of state.bulbs) {
    seen.add(b.mac);
    let card = state.cards.get(b.mac);
    if (!card) { card = makeCard(b); state.cards.set(b.mac, card); main.appendChild(card); }
    applyState(card, b);
  }
  for (const [mac, card] of state.cards) if (!seen.has(mac)) { card.remove(); state.cards.delete(mac); }
  const on = state.bulbs.filter((b) => b.online).length;
  const c = $('#count'); c.classList.toggle('on', on > 0); c.lastElementChild.textContent = `${on} of ${state.bulbs.length} connected`;
  const p = (state.info && state.info.profile) || {}; const hs = $('.home-title span'); if (hs) hs.textContent = [p.ownerName, `${on} of ${state.bulbs.length} connected`].filter(Boolean).join(' · ');
}

/* ---------- bulb card ---------- */
const WHEEL = 210;
function drawWheel(canvas) {
  const dpr = window.devicePixelRatio || 1, S = WHEEL * dpr, R = S / 2;
  canvas.width = canvas.height = S; canvas.style.width = canvas.style.height = WHEEL + 'px';
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - R + 0.5, dy = y - R + 0.5, r = Math.hypot(dx, dy), i = (y * S + x) * 4;
    if (r > R) continue;
    const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, s = Math.min(1, r / R), [rr, gg, bb] = hsv2rgb(h, s, 1);
    d[i] = rr; d[i + 1] = gg; d[i + 2] = bb; d[i + 3] = r > R - 1.5 * dpr ? Math.round(255 * (R - r) / (1.5 * dpr)) : 255;
  }
  ctx.putImageData(img, 0, 0);
}
function touch(mac) { state.touched[mac] = Date.now(); }
const nameOf = (mac) => (state.bulbs.find((b) => b.mac === mac) || {}).name || mac;
async function setBulb(mac, params) { touch(mac); try { await api(`/api/bulbs/${mac}`, 'POST', params); } catch (e) { toast(`${nameOf(mac)}: ${e.message}`); } }
function paint(card, color) { card.style.setProperty('--c', color); card.style.setProperty('--glow', color + '99'); }

function makeCard(b) {
  const card = document.createElement('section');
  card.className = 'card' + (b.color === false ? ' no-color' : '') + (b.tunableWhite === false ? ' no-white' : '') + (b.dimmable === false ? ' no-dim' : ''); card.dataset.mac = b.mac;
  card.innerHTML = `
    <div class="top">
      <input class="name" type="text" value="" spellcheck="false" title="Click to rename" aria-label="Bulb name" maxlength="40">
      <div class="meta"><span class="sig" data-l="0"><i></i><i></i><i></i><i></i></span><span class="ip"></span><span class="badge kind"></span></div>
    </div>
    <div class="hero-b">
      <div class="orb"></div>
      <div class="state"><div class="mode">—</div><div class="sub"></div></div>
      <label class="switch"><input type="checkbox" class="power" aria-label="Power"><span></span></label>
      <button class="expand" aria-label="Show controls" aria-expanded="false">${ICON.chevron}</button>
    </div>
    <div class="controls">
      <div class="ctl"><label>Brightness</label><input type="range" class="bright" min="10" max="100" step="1" aria-label="Brightness"><output class="brightOut"></output></div>
      <div class="tabs" role="tablist"><button role="tab" data-tab="color" class="active" aria-selected="true">Colour</button><button role="tab" data-tab="white" aria-selected="false">White</button><button role="tab" data-tab="scenes" aria-selected="false">Scenes</button></div>
      <div class="panel" data-panel="color">
        <div class="wheelwrap"><canvas></canvas><div class="marker"></div></div>
        <div class="hexrow"><input class="hex" maxlength="7" placeholder="#rrggbb" aria-label="Hex colour"></div>
        <div class="swatches">${SWATCHES.map(([c, n]) => `<button style="background:${c}" data-c="${c}" title="${n} ${c}" aria-label="${n}"></button>`).join('')}</div>
      </div>
      <div class="panel" data-panel="white" hidden>
        <div class="ctl"><label>Warmth</label><input type="range" class="temp" min="2200" max="6500" step="50" aria-label="Colour temperature"><output class="tempOut"></output></div>
        <div class="presets">${WHITE_PRESETS.map(([n, k]) => `<button data-k="${k}">${n} <span style="opacity:.6">${k}K</span></button>`).join('')}</div>
      </div>
      <div class="panel" data-panel="scenes" hidden>
        <div class="scenes">${state.scenes.map((s) => `<button data-s="${s.id}">${esc(s.name)}${s.dynamic ? '<i>~</i>' : ''}</button>`).join('')}</div>
        <div class="ctl speedrow" hidden><label>Speed</label><input type="range" class="speed" min="10" max="200" step="5" aria-label="Scene speed"><output class="speedOut"></output></div>
      </div>
    </div>
    <div class="foot"><button class="ghost setDefault">Make default</button><button class="ghost forget">Forget</button></div>`;
  const mac = b.mac, q = (s) => $(s, card);
  if (state.expanded.has(mac)) card.classList.add('open');
  const toggleOpen = () => { const open = card.classList.toggle('open'); q('.expand').setAttribute('aria-expanded', String(open)); if (open) state.expanded.add(mac); else state.expanded.delete(mac); };
  q('.expand').addEventListener('click', toggleOpen);
  q('.orb').addEventListener('click', () => { if (window.matchMedia('(max-width:640px)').matches) toggleOpen(); });
  q('.state').addEventListener('click', () => { if (window.matchMedia('(max-width:640px)').matches) toggleOpen(); });

  const name = q('.name');
  const saveName = async () => { const v = name.value.trim(); if (!v || v === card._name) { name.value = card._name; return; } touch(mac); try { await api(`/api/bulbs/${mac}`, 'PATCH', { name: v }); card._name = v; const sb = state.bulbs.find((x) => x.mac === mac); if (sb) sb.name = v; toast(`Renamed to “${v}”`, true); } catch (e) { toast(e.message); } };
  name.addEventListener('change', saveName); name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = card._name; name.blur(); } });

  q('.power').addEventListener('change', (e) => { const on = e.target.checked; card.classList.toggle('off', !on); const b0 = state.bulbs.find((x) => x.mac === mac); if (b0 && b0.summary) { b0.summary.on = on; const [m, s2] = describeSummary(b0.summary); q('.mode').textContent = m; q('.sub').textContent = s2; } setBulb(mac, { state: on }); });

  const br = q('.bright'), brOut = q('.brightOut'); const sendBr = throttle((v) => setBulb(mac, { dimming: v }), 120);
  br.addEventListener('input', () => { touch(mac); brOut.value = br.value + '%'; sendBr(+br.value); });

  const selectTab = (t) => { $$('.tabs button', card).forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', String(x === t)); }); $$('.panel', card).forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab)); };
  $$('.tabs button', card).forEach((t) => t.addEventListener('click', () => selectTab(t)));
  if (b.color === false) { const first = b.tunableWhite === false ? q('[data-tab="scenes"]') : q('[data-tab="white"]'); if (first) selectTab(first); }

  const canvas = q('canvas'), marker = q('.marker'), hexIn = q('.hex');
  drawWheel(canvas);
  const sendColor = throttle((r, g, bb) => setBulb(mac, { r, g, b: bb }), 120);
  const placeMarker = (h, s, color) => { const a = h * Math.PI / 180; marker.style.left = (50 + Math.cos(a) * s * 50) + '%'; marker.style.top = (50 + Math.sin(a) * s * 50) + '%'; marker.style.background = color; };
  const showColor = (r, g, bb, fromPoll) => { const [h, s] = rgb2hsv(r, g, bb); placeMarker(h, s, hex(r, g, bb)); if (!(fromPoll && document.activeElement === hexIn)) hexIn.value = hex(r, g, bb); paint(card, hex(r, g, bb)); };
  const pick = (e) => { const rect = canvas.getBoundingClientRect(); const R = rect.width / 2; const dx = e.clientX - rect.left - R, dy = e.clientY - rect.top - R; const s = Math.min(1, Math.hypot(dx, dy) / R); const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; const [r, g, bb] = hsv2rgb(h, s, 1); touch(mac); showColor(r, g, bb); q('.mode').textContent = 'Colour'; q('.sub').textContent = hex(r, g, bb); q('.power').checked = true; card.classList.remove('off'); sendColor(r, g, bb); };
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); pick(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) pick(e); });
  canvas.addEventListener('pointerup', () => (dragging = false)); canvas.addEventListener('pointercancel', () => (dragging = false));
  hexIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') hexIn.blur(); });
  hexIn.addEventListener('change', () => { const m = hexIn.value.trim().replace('#', ''); if (!/^[0-9a-f]{6}$/i.test(m)) { toast('Use a 6-digit hex colour like #ff8800'); return; } const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), bb = parseInt(m.slice(4, 6), 16); touch(mac); showColor(r, g, bb); q('.mode').textContent = 'Colour'; q('.sub').textContent = hex(r, g, bb); setBulb(mac, { r, g, b: bb }); });
  $$('.swatches button', card).forEach((sw) => sw.addEventListener('click', () => { const m = sw.dataset.c.slice(1); const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), bb = parseInt(m.slice(4, 6), 16); touch(mac); showColor(r, g, bb); q('.mode').textContent = 'Colour'; q('.sub').textContent = sw.dataset.c; q('.power').checked = true; card.classList.remove('off'); setBulb(mac, { r, g, b: bb }); }));
  card._showColor = showColor;

  const tp = q('.temp'), tpOut = q('.tempOut'); const sendTemp = throttle((v) => setBulb(mac, { temp: v }), 120);
  tp.addEventListener('input', () => { touch(mac); tpOut.value = tp.value + 'K'; $$('.presets button', card).forEach((x) => x.classList.toggle('active', Math.abs(+x.dataset.k - +tp.value) <= 25)); paint(card, hex(...kelvin2rgb(+tp.value))); q('.mode').textContent = 'White'; q('.sub').textContent = tp.value + 'K'; q('.power').checked = true; card.classList.remove('off'); $$('.scenes button', card).forEach((x) => x.classList.remove('active')); sendTemp(+tp.value); });
  $$('.presets button', card).forEach((p) => p.addEventListener('click', () => { tp.value = p.dataset.k; tp.dispatchEvent(new Event('input')); $$('.presets button', card).forEach((x) => x.classList.toggle('active', x === p)); }));

  const speedRow = q('.speedrow'), sp = q('.speed'), spOut = q('.speedOut');
  $$('.scenes button', card).forEach((s) => s.addEventListener('click', () => {
    const id = +s.dataset.s, sc = state.scenes.find((x) => x.id === id);
    $$('.scenes button', card).forEach((x) => x.classList.toggle('active', x === s));
    speedRow.hidden = !sc.dynamic; paint(card, SCENE_COLORS[id] || '#ffffff');
    q('.mode').textContent = 'Scene'; q('.sub').textContent = sc.name; q('.power').checked = true; card.classList.remove('off');
    touch(mac); setBulb(mac, { sceneId: id, ...(sc.dynamic ? { speed: +sp.value || 100 } : {}) });
  }));
  const sendSpeed = throttle((v) => { const act = card.querySelector('.scenes button.active'); setBulb(mac, act ? { sceneId: +act.dataset.s, speed: v } : { speed: v }); }, 150);
  sp.addEventListener('input', () => { touch(mac); spOut.value = sp.value; sendSpeed(+sp.value); });

  q('.setDefault').addEventListener('click', async () => { try { await api(`/api/bulbs/${mac}`, 'PATCH', { default: true }); toast(`${card._name} is now the default bulb for the command line`, true); } catch (e) { toast(e.message); } });
  q('.forget').addEventListener('click', async () => { if (!confirm(`Forget ${card._name}? Discover will find it again.`)) return; try { await api(`/api/bulbs/${mac}`, 'DELETE'); state.bulbs = state.bulbs.filter((x) => x.mac !== mac); renderCards(); } catch (e) { toast(e.message); } });
  return card;
}
function applyState(card, b) {
  const q = (s) => $(s, card);
  const fresh = !state.touched[b.mac] || Date.now() - state.touched[b.mac] > TOUCH_HOLD;
  const name = q('.name'); if (document.activeElement !== name && fresh) name.value = b.name; if (fresh) card._name = b.name;
  q('.ip').textContent = b.ip; q('.kind').textContent = b.online ? b.kind : 'offline'; q('.kind').classList.toggle('off', !b.online);
  const rssi = b.rssi ?? -100; q('.sig').dataset.l = !b.online ? 0 : rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1; q('.sig').title = b.online ? `${rssi} dBm` : 'offline';
  card.classList.toggle('offline', !b.online);
  if (!fresh || !b.summary) return;
  const s = b.summary;
  q('.power').checked = s.on; card.classList.toggle('off', !s.on);
  q('.bright').value = s.brightness ?? 100; q('.brightOut').value = (s.brightness ?? 100) + '%';
  $$('.scenes button', card).forEach((x) => x.classList.toggle('active', s.mode === 'scene' && +x.dataset.s === s.sceneId));
  const [mode, sub] = describeSummary(s); q('.mode').textContent = mode; q('.sub').textContent = sub;
  $$('.presets button', card).forEach((x) => x.classList.toggle('active', s.mode === 'white' && Math.abs(+x.dataset.k - s.temp) <= 25));
  if (s.mode === 'color') { card._showColor(s.r, s.g, s.b, true); q('.speedrow').hidden = true; }
  else if (s.mode === 'white') { q('.temp').value = s.temp; q('.tempOut').value = s.temp + 'K'; paint(card, hex(...kelvin2rgb(s.temp))); q('.speedrow').hidden = true; }
  else if (s.mode === 'scene') { const sc = state.scenes.find((x) => x.id === s.sceneId); paint(card, SCENE_COLORS[s.sceneId] || '#fff'); q('.speedrow').hidden = !(sc && sc.dynamic); if (s.speed) { q('.speed').value = s.speed; q('.speedOut').value = s.speed; } }
  if (!q('.tempOut').value) q('.tempOut').value = q('.temp').value + 'K';
  if (!q('.speedOut').value) q('.speedOut').value = q('.speed').value;
}

/* ---------- settings ---------- */
function renderSettings() {
  const root = show('settings'); const info = state.info || {}; const p = info.profile || {};
  const lanUrls = (info.lanIps || []).map((ip) => `http://${ip}:${info.port || 4200}`);
  root.innerHTML = topbar({ back: true, title: 'Settings', sub: p.homeName || '' }) + `
  <div class="settings">
    <div class="sect"><h3>Your home</h3><p>Shown at the top of your dashboard.</p>
      <div class="field"><label for="s-owner">Your name</label><input type="text" id="s-owner" value="${esc(p.ownerName || '')}" maxlength="60"></div>
      <div class="field"><label for="s-home">Home name</label><input type="text" id="s-home" value="${esc(p.homeName || '')}" maxlength="60"></div>
      <div class="field"><label for="s-wifi">Wi-Fi network</label><input type="text" id="s-wifi" value="${esc(p.wifiName || '')}" maxlength="60"><span class="hint">${info.wifi ? `The bridge currently sees <b>${esc(info.wifi)}</b>.` : 'Just a label; the bridge couldn\'t read the network name itself.'}</span></div>
      <div class="actions" style="margin-top:6px"><button class="primary" id="save">Save</button></div>
    </div>
    <div class="sect"><h3>Bridge</h3><p>The helper that talks to your bulbs.</p>
      <dl class="kv">
        <dt>Status</dt><dd><span class="chip on"><span class="st"></span>Connected</span></dd>
        <dt>Running on</dt><dd>${esc(info.computer || 'this computer')} · v${esc(info.version || '?')}${info.packaged ? '' : ' (from source)'}</dd>
        <dt>Address</dt><dd><code>${esc(state.base || location.origin)}</code></dd>
        <dt>Bulbs saved</dt><dd>${state.bulbs.length || info.bulbs || 0}</dd>
        ${info.lan ? '' : `<dt>Use from a phone</dt><dd>Start the bridge with <code>--lan</code>, then open ${lanUrls.length ? lanUrls.map((u) => `<code>${esc(u)}</code>`).join(' or ') : 'its address'} on your phone.</dd>`}
        <dt>Data file</dt><dd><code>${esc(info.config || '')}</code></dd>
      </dl>
      <div class="row" style="margin-top:14px"><button id="quit">Stop the bridge</button><span class="small muted">Lights keep their last setting. Open WiZ Bridge again to continue.</span></div>
      ${phoneBlock(info)}
      ${state.hosted ? `<details><summary>Bridge address</summary><div class="body"><div class="row"><input type="url" id="burl" value="${esc(state.base)}" spellcheck="false" inputmode="url" autocapitalize="off"><button id="bset">Use</button></div></div></details>` : ''}
    </div>
    <div class="sect"><h3>Bulbs</h3><p>Rename bulbs from their cards on the dashboard. Discover adds new bulbs and updates addresses.</p>
      <div class="row"><button id="rescan">Discover bulbs</button><button id="forgetAll" class="danger">Forget all bulbs</button></div>
    </div>
    <div class="sect"><h3>Account</h3><p>Log out of this home on this browser. Nothing on the bridge is deleted; log back in any time.</p>
      <div class="row"><button id="logout2">Log out</button></div>
    </div>
    <div class="sect danger"><h3>Start over</h3><p>Clears your profile and the saved bulbs on this bridge. The bulbs themselves aren't touched.</p>
      <div class="row"><button id="reset" class="danger">Reset WiZ Control</button></div>
    </div>
    <p class="small muted" style="text-align:center">WiZ Control is open source · <a href="${REPO}" target="_blank" rel="noopener">${REPO.replace('https://', '')}</a></p>
  </div>`;
  $('#tb-back').addEventListener('click', renderDashboard);
  $('#logout2').addEventListener('click', logout);
  wireCopy(root);
  $('#save').addEventListener('click', async () => {
    try { const prof = await api('/api/profile', 'PUT', { ownerName: $('#s-owner').value, homeName: $('#s-home').value, wifiName: $('#s-wifi').value }); state.info = { ...(state.info || {}), profile: prof }; const hs = $('.home-title span'); if (hs) hs.textContent = prof.homeName || ''; toast('Saved', true); }
    catch (e) { toast(e.message); }
  });
  if ($('#bset')) $('#bset').addEventListener('click', () => { if (useBridge($('#burl').value)) boot(); });
  $('#quit').addEventListener('click', async () => { if (!confirm('Stop the bridge? This page will lose its connection until you open WiZ Bridge again.')) return; try { await api('/api/quit', 'POST'); } catch (_) {} state.connected = false; renderLost(); });
  $('#rescan').addEventListener('click', async (e) => { e.target.disabled = true; try { state.bulbs = await api('/api/discover', 'POST'); toast(plural(state.bulbs.filter((b) => b.online).length, 'bulb') + ' online', true); } catch (err) { toast(err.message); } e.target.disabled = false; });
  $('#forgetAll').addEventListener('click', async () => { if (!confirm('Forget all saved bulbs? Discover will find them again.')) return; try { await api('/api/bulbs', 'DELETE'); state.bulbs = []; toast('Forgot all bulbs', true); } catch (e) { toast(e.message); } });
  $('#reset').addEventListener('click', async () => { if (!confirm('Reset WiZ Control? This clears your profile and saved bulbs.')) return; try { await api('/api/reset', 'POST'); ls.del('completed'); ls.del('started'); state.info = await ping(state.base); state.bulbs = []; state.hosted ? renderLanding() : renderWizard(2); } catch (e) { toast(e.message); } });
}

// One document-level handler closes the user menu (registered once, not per render).
document.addEventListener('click', () => { const d = $('#udrop'); if (d) { d.hidden = true; const b = $('#ubtn'); if (b) b.setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const d = $('#udrop'); if (d) d.hidden = true; } });

/* ================= boot ================= */
async function boot() {
  stopTimers();
  // Served by the bridge itself? Then the API is right here.
  if (!state.hosted && !state.base) { const local = await ping(''); if (local) { state.info = local; state.connected = true; state.base = ''; } else state.hosted = true; }
  if (state.hosted) { state.base = bridgeUrl(); state.info = await ping(state.base); state.connected = !!state.info; }
  else if (!state.info) { state.info = await ping(''); state.connected = !!state.info; }
  if (state.connected && !state.scenes.length) { try { state.scenes = await api('/api/scenes'); } catch (_) {} }

  const done = state.connected && state.info.profile && state.info.profile.completed;
  if (done && ls.get('loggedOut')) return renderWelcome();
  if (done) { ls.set('completed', '1'); return renderDashboard(); }
  if (!state.hosted) return renderWizard(state.info && state.info.profile ? 3 : 2); // bridge is obviously here
  if (state.connected) return ls.get('started') ? renderWizard(state.info.profile ? 3 : 2) : renderLanding();
  if (ls.get('completed')) return renderLost();
  return ls.get('started') ? renderWizard(1) : renderLanding();
}
boot();

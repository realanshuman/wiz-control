'use strict';
// Persists the bulbs you've discovered (names, IPs, module info) in bulbs.json.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Where bulbs + profile live. Inside the repo when run from source; in the user's home
// folder when running as a packaged app (its own directory is a read-only snapshot).
let CONFIG_PATH = process.env.WIZ_CONFIG || (process.pkg
  ? path.join(process.env.APPDATA || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config'), 'wiz-control', 'bulbs.json')
  : path.join(__dirname, '..', 'bulbs.json'));
function setConfigPath(p) { CONFIG_PATH = path.resolve(p); module.exports.CONFIG_PATH = CONFIG_PATH; }

function load() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); c.bulbs = c.bulbs || {}; c.profile = c.profile || null; return c; }
  catch (_) { return { bulbs: {}, defaultBulb: null, profile: null }; }
}
function save(c) { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n'); return c; }

const normMac = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const defaultName = (mac) => `Bulb ${normMac(mac).slice(-4)}`;

/** Merge a discovery result into the saved list; keeps user-given names. */
function upsert(found) {
  const c = load();
  const now = new Date().toISOString();
  for (const d of found) {
    const mac = normMac(d.mac); if (!mac) continue;
    const prev = c.bulbs[mac] || {};
    c.bulbs[mac] = {
      mac, name: prev.name || defaultName(mac), ip: d.ip,
      moduleName: d.moduleName || prev.moduleName, fwVersion: d.fwVersion || prev.fwVersion,
      homeId: d.homeId ?? prev.homeId, roomId: d.roomId ?? prev.roomId,
      firstSeen: prev.firstSeen || now, lastSeen: now,
    };
  }
  if (!c.defaultBulb && Object.keys(c.bulbs).length === 1) c.defaultBulb = Object.keys(c.bulbs)[0];
  return save(c);
}

function list() { return Object.values(load().bulbs); }

/** Resolve "all", a name, a MAC or an IP to one or more saved bulbs. */
function resolve(target, { allowAll = true } = {}) {
  const c = load();
  const all = Object.values(c.bulbs);
  if (target === undefined || target === null || target === '') {
    if (c.defaultBulb && c.bulbs[c.defaultBulb]) return [c.bulbs[c.defaultBulb]];
    if (all.length === 1) return all;
    if (all.length === 0) throw new Error('No bulbs saved yet. Run: node wiz.js discover');
    throw new Error(`Several bulbs are saved — say which one (name, IP or MAC), or "all". Set a default with: node wiz.js use <bulb>\n  ${all.map((b) => `${b.name}  ${b.ip}  ${b.mac}`).join('\n  ')}`);
  }
  const t = String(target).trim();
  if (allowAll && t.toLowerCase() === 'all') return all;
  const tm = normMac(t);
  const hit = all.filter((b) => b.name.toLowerCase() === t.toLowerCase() || b.ip === t || (tm.length === 12 && b.mac === tm));
  if (hit.length) return hit;
  const fuzzy = all.filter((b) => b.name.toLowerCase().includes(t.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy;
  throw new Error(`No saved bulb matches "${target}". Saved: ${all.map((b) => b.name).join(', ') || '(none — run discover)'}`);
}

function update(mac, patch) {
  const c = load(); const m = normMac(mac);
  if (!c.bulbs[m]) throw new Error(`Unknown bulb ${mac}`);
  Object.assign(c.bulbs[m], patch); save(c); return c.bulbs[m];
}
function forget(mac) { const c = load(); const m = normMac(mac); delete c.bulbs[m]; if (c.defaultBulb === m) c.defaultBulb = null; save(c); }
function setDefault(mac) { const c = load(); c.defaultBulb = normMac(mac); save(c); }
/** The home profile shown in the web app: { ownerName, homeName, wifiName, completed, createdAt, updatedAt } */
const PROFILE_FIELDS = ['ownerName', 'homeName', 'wifiName'];
function getProfile() { return load().profile; }
function setProfile(patch = {}) {
  const c = load(); const now = new Date().toISOString();
  const p = c.profile || { createdAt: now };
  for (const k of PROFILE_FIELDS) if (typeof patch[k] === 'string') p[k] = patch[k].trim().slice(0, 60);
  if (typeof patch.completed === 'boolean') p.completed = patch.completed;
  p.updatedAt = now; c.profile = p; save(c); return p;
}
function clearProfile() { const c = load(); c.profile = null; save(c); }
function forgetAll() { const c = load(); c.bulbs = {}; c.defaultBulb = null; save(c); }
function getDefault() { const c = load(); return c.defaultBulb ? c.bulbs[c.defaultBulb] || null : null; }

module.exports = { CONFIG_PATH, setConfigPath, load, save, upsert, list, resolve, update, forget, forgetAll, setDefault, getDefault, getProfile, setProfile, clearProfile, normMac };

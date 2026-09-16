'use strict';
// Persists the bulbs you've discovered (names, IPs, module info) in bulbs.json.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Where bulbs + profile live. Inside the project when run from a git checkout; otherwise
// (packaged app, npx, global install) in the user's app-data folder, which survives updates.
const inCheckout = (() => { try { return fs.existsSync(path.join(__dirname, '..', '.git')); } catch (_) { return false; } })();
const appData = () => path.join(process.env.APPDATA || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config'), 'wiz-control');
let CONFIG_PATH = process.env.WIZ_CONFIG || (process.pkg || !inCheckout ? path.join(appData(), 'bulbs.json') : path.join(__dirname, '..', 'bulbs.json'));
function setConfigPath(p) { CONFIG_PATH = path.resolve(p); module.exports.CONFIG_PATH = CONFIG_PATH; }

function load() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch (_) { return { bulbs: {}, defaultBulb: null, profile: null }; }
  try { const c = JSON.parse(raw); if (!c || typeof c !== 'object') throw new Error('not an object'); c.bulbs = c.bulbs || {}; c.profile = c.profile || null; return c; }
  catch (e) {
    // Don't silently overwrite a damaged file: keep a copy next to it and start fresh.
    const backup = CONFIG_PATH + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(CONFIG_PATH, backup); console.error(`Config file was unreadable (${e.message}); moved it to ${backup}`); } catch (_) {}
    return { bulbs: {}, defaultBulb: null, profile: null };
  }
}
function save(c) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH); // atomic on every OS: a crash mid-write can't leave half a file
  return c;
}

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
  if (t.toLowerCase() === 'all') { if (allowAll) return all; throw new Error('This command works on one bulb at a time; give its name, IP or MAC.'); }
  const tm = normMac(t);
  const exact = all.filter((b) => b.name.toLowerCase() === t.toLowerCase() || b.ip === t || (tm.length === 12 && b.mac === tm));
  if (exact.length === 1) return exact;
  if (exact.length > 1) { if (allowAll) return exact; throw new Error(`Several bulbs are named "${t}"; use the IP or MAC instead:\n  ${exact.map((b) => `${b.name}  ${b.ip}  ${b.mac}`).join('\n  ')}`); }
  const fuzzy = all.filter((b) => b.name.toLowerCase().includes(t.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy;
  if (fuzzy.length > 1) throw new Error(`"${target}" matches several bulbs: ${fuzzy.map((b) => b.name).join(', ')}. Be more specific.`);
  throw new Error(`No saved bulb matches "${target}". Saved: ${all.map((b) => b.name).join(', ') || '(none — run discover)'}`);
}

function update(mac, patch) {
  const c = load(); const m = normMac(mac);
  if (!c.bulbs[m]) throw new Error(`Unknown bulb ${mac}`);
  if (typeof patch.name === 'string') patch.name = patch.name.trim().slice(0, 40) || c.bulbs[m].name;
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

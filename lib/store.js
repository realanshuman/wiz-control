'use strict';
// Persists discovered devices (any brand), the home profile, and paired Hue bridges.
// Devices are keyed by "<driver>:<id>" e.g. "wiz:9877d5af3092", "tuya:d786…", "hue:001788:3".
// Legacy files that stored WiZ bulbs keyed by bare MAC are migrated on load.
const fs = require('fs');
const path = require('path');
const os = require('os');

const inCheckout = (() => { try { return fs.existsSync(path.join(__dirname, '..', '.git')); } catch (_) { return false; } })();
const appData = () => path.join(process.env.APPDATA || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config'), 'wiz-control');
let CONFIG_PATH = process.env.WIZ_CONFIG || (process.pkg || !inCheckout ? path.join(appData(), 'bulbs.json') : path.join(__dirname, '..', 'bulbs.json'));
function setConfigPath(p) { CONFIG_PATH = path.resolve(p); module.exports.CONFIG_PATH = CONFIG_PATH; }

const normMac = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const keyOf = (d) => `${d.driver}:${d.id}`;

function migrate(c) {
  c.devices = c.devices || {};
  c.hueBridges = c.hueBridges || [];
  if (c.profile === undefined) c.profile = null;
  // Legacy: bulbs keyed by MAC → devices keyed by wiz:<mac>.
  if (c.bulbs && typeof c.bulbs === 'object') {
    for (const [k, b] of Object.entries(c.bulbs)) {
      if (!b || typeof b !== 'object') continue;
      const id = b.id || normMac(b.mac || k);
      const driver = b.driver || 'wiz';
      const dev = { ...b, driver, id, key: `${driver}:${id}` };
      if (!dev.kind) dev.kind = 'bulb';
      c.devices[dev.key] = dev;
    }
    delete c.bulbs;
  }
  if (c.defaultBulb && !c.defaultKey) { // migrate default pointer (was a MAC)
    c.defaultKey = c.devices[c.defaultBulb] ? c.defaultBulb : `wiz:${normMac(c.defaultBulb)}`;
    delete c.defaultBulb;
  }
  if (c.defaultKey && !c.devices[c.defaultKey]) c.defaultKey = null;
  return c;
}

function load() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch (_) { return { devices: {}, hueBridges: [], defaultKey: null, profile: null }; }
  try { const c = JSON.parse(raw); if (!c || typeof c !== 'object') throw new Error('not an object'); return migrate(c); }
  catch (e) {
    const backup = CONFIG_PATH + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.renameSync(CONFIG_PATH, backup); console.error(`Config file was unreadable (${e.message}); moved it to ${backup}`); } catch (_) {}
    return { devices: {}, hueBridges: [], defaultKey: null, profile: null };
  }
}
function save(c) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return c;
}

const defaultName = (d) => d.driver === 'wiz' ? `Bulb ${String(d.id).slice(-4)}` : d.kind === 'plug' ? 'Smart plug' : `${d.brand || 'Bulb'} ${String(d.id).slice(-4)}`;

/** Merge discovery results (driver-tagged partials) into the saved list; keep user fields. */
function upsert(found) {
  const c = load();
  const now = new Date().toISOString();
  for (const d of found) {
    if (!d || !d.driver || !d.id) continue;
    const key = keyOf(d);
    const prev = c.devices[key] || {};
    c.devices[key] = {
      ...prev, ...d, key,
      name: prev.name || d.name || defaultName(d),
      room: prev.room || d.room || '',
      tuya: prev.tuya || d.tuya, hue: prev.hue || d.hue,
      firstSeen: prev.firstSeen || now, lastSeen: now,
    };
  }
  if (!c.defaultKey && Object.keys(c.devices).length === 1) c.defaultKey = Object.keys(c.devices)[0];
  return save(c);
}

/** Add a device the user configured by hand (Tuya key, or a paired Hue light). */
function addDevice(rec) {
  const c = load(); const now = new Date().toISOString();
  const key = keyOf(rec);
  const prev = c.devices[key] || {};
  c.devices[key] = { ...prev, ...rec, key, name: rec.name || prev.name || defaultName(rec), room: rec.room ?? prev.room ?? '', firstSeen: prev.firstSeen || now, lastSeen: now };
  if (!c.defaultKey) c.defaultKey = key;
  save(c); return c.devices[key];
}

function list() { return Object.values(load().devices); }
function get(key) { return load().devices[key] || null; }
function rooms() { const set = new Set(); for (const d of list()) if (d.room) set.add(d.room); return [...set].sort(); }

/** Resolve "all", a name, id, key, MAC or IP to saved devices (used by the CLI). */
function resolve(target, { allowAll = true } = {}) {
  const c = load();
  const all = Object.values(c.devices);
  if (target === undefined || target === null || target === '') {
    if (c.defaultKey && c.devices[c.defaultKey]) return [c.devices[c.defaultKey]];
    if (all.length === 1) return all;
    if (all.length === 0) throw new Error('No devices saved yet. Run: node wiz.js discover');
    throw new Error(`Several devices are saved — say which one (name, IP or id), or "all".\n  ${all.map((b) => `${b.name}  ${b.ip || ''}  ${b.key}`).join('\n  ')}`);
  }
  const t = String(target).trim();
  if (t.toLowerCase() === 'all') { if (allowAll) return all; throw new Error('This command works on one device at a time; give its name, IP or id.'); }
  const tm = normMac(t);
  const exact = all.filter((b) => b.name.toLowerCase() === t.toLowerCase() || b.ip === t || b.key === t || b.id === t || (tm.length === 12 && normMac(b.id) === tm));
  if (exact.length === 1) return exact;
  if (exact.length > 1) { if (allowAll) return exact; throw new Error(`Several devices match "${t}"; use the IP or id instead.`); }
  const fuzzy = all.filter((b) => b.name.toLowerCase().includes(t.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy;
  if (fuzzy.length > 1) throw new Error(`"${target}" matches several devices: ${fuzzy.map((b) => b.name).join(', ')}. Be more specific.`);
  throw new Error(`No saved device matches "${target}". Saved: ${all.map((b) => b.name).join(', ') || '(none — run discover)'}`);
}

function update(key, patch) {
  const c = load();
  const dev = c.devices[key] || c.devices[`wiz:${normMac(key)}`];
  if (!dev) throw new Error(`Unknown device ${key}`);
  if (typeof patch.name === 'string') patch.name = patch.name.trim().slice(0, 40) || dev.name;
  if (typeof patch.room === 'string') patch.room = patch.room.trim().slice(0, 40);
  Object.assign(dev, patch); save(c); return dev;
}
function forget(key) { const c = load(); const k = c.devices[key] ? key : `wiz:${normMac(key)}`; delete c.devices[k]; if (c.defaultKey === k) c.defaultKey = null; save(c); }
function setDefault(key) { const c = load(); const k = c.devices[key] ? key : `wiz:${normMac(key)}`; if (c.devices[k]) { c.defaultKey = k; save(c); } }
function getDefault() { const c = load(); return c.defaultKey ? c.devices[c.defaultKey] || null : null; }
function forgetAll() { const c = load(); c.devices = {}; c.defaultKey = null; c.hueBridges = []; save(c); }

/* Hue bridges paired with the app: [{ ip, username, id }] */
function hueBridges() { return load().hueBridges || []; }
function saveHueBridge(b) { const c = load(); c.hueBridges = (c.hueBridges || []).filter((x) => x.ip !== b.ip); c.hueBridges.push(b); save(c); return b; }

/* Home profile */
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

module.exports = {
  CONFIG_PATH, setConfigPath, load, save, upsert, addDevice, list, get, rooms, resolve, update, forget, forgetAll,
  setDefault, getDefault, getProfile, setProfile, clearProfile, hueBridges, saveHueBridge, normMac, keyOf,
};

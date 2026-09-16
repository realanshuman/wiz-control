'use strict';
// WiZ driver — wraps the local WiZ UDP protocol (lib/wiz.js) in the common driver interface.
const wiz = require('../wiz');

const norm = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');

function kindOf(moduleName) {
  const c = wiz.capabilities(moduleName);
  return c.socket ? 'plug' : moduleName && /strip/i.test(moduleName) ? 'strip' : 'bulb';
}
function capsOf(moduleName) {
  const c = wiz.capabilities(moduleName);
  return { color: !!c.color, tunableWhite: !!c.tunableWhite, dimmable: !!c.dimmable && !c.socket, effects: !!c.color, kind: kindOf(moduleName) };
}

module.exports = {
  id: 'wiz',
  brand: 'WiZ',
  label: 'Philips WiZ',
  // WiZ needs no extra info from the user: the bulb must already be on the Wi-Fi (via the WiZ
  // app, once). After that this finds it automatically.
  addStyle: 'scan',
  scenes: () => Object.entries(wiz.SCENES).map(([id, name]) => ({ id: +id, name, dynamic: wiz.DYNAMIC_SCENES.has(+id) })),

  async discover(opts = {}) {
    const found = await wiz.discover(opts);
    return found.map((d) => ({
      driver: 'wiz', id: norm(d.mac), ip: d.ip, kind: kindOf(d.moduleName),
      moduleName: d.moduleName, fwVersion: d.fwVersion, homeId: d.homeId, roomId: d.roomId,
      caps: capsOf(d.moduleName), reachable: true, state: d.pilot ? wiz.describePilot(d.pilot) : null,
    }));
  },

  caps(dev) { return capsOf(dev.moduleName); },

  async getState(dev) {
    const p = await wiz.send(dev.ip, 'getPilot', {}, { retries: 1, timeoutMs: 1000 });
    return wiz.describePilot(p);
  },

  // params: { state, dimming, r,g,b, temp, sceneId, speed } — validated/clamped by buildPilot.
  async setState(dev, params) {
    return wiz.setPilot(dev.ip, wiz.buildPilot(params));
  },

  // Used by the server to recover a changed IP: returns the fresh device if the MAC reappears.
  async relocate(dev) {
    const found = await wiz.discover({ timeoutMs: 2000 });
    const d = found.find((x) => norm(x.mac) === dev.id);
    return d ? { ip: d.ip } : null;
  },

  isTimeout: (e) => /^No reply/.test(e && e.message),
};

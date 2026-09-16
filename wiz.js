#!/usr/bin/env node
'use strict';
// Command-line control for WiZ bulbs. Run without arguments for help.
const wiz = require('./lib/wiz');
const drivers = require('./lib/drivers');
const store = require('./lib/store');
const drv = (b) => drivers.get(b.driver) || drivers.get('wiz');

const HELP = `WiZ bulb control (local network, no app needed)

usage: node wiz.js <command> [args] [bulb]

  discover                    scan the Wi-Fi network and save every bulb found
  list                        saved bulbs with live state
  status [bulb]               current state of a bulb
  on | off | toggle [bulb]
  dim <10-100> [bulb]         brightness
  color <colour> [bulb]       #ff8800, ff8800, 255,136,0, or a name: ${Object.keys(wiz.NAMED_COLORS).join(' ')}
  white <kelvin> [bulb]       2200 (candle) … 6500 (cool daylight)
  scene <id|name> [bulb]      e.g. scene party   scene 4   (add --speed 10-200 for animated scenes)
  scenes                      list the 32 built-in scenes
  rename <bulb> <new name>
  use <bulb>                  make this the default bulb for commands
  forget <bulb>
  raw <bulb> <method> [json]  send any WiZ method, e.g. raw room getSystemConfig

[bulb] is a name, IP, MAC, or "all". Omit it to use the default bulb.
Web UI: node server.js  →  http://localhost:4200`;

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  else pos.push(argv[i]);
}
const [cmd, ...args] = pos;

const fmtState = (b, s) => {
  s = s || {};
  const what = s.mode === 'color' ? `colour ${s.hex}` : s.mode === 'white' ? `white ${s.temp}K` : s.mode === 'scene' ? `scene "${s.scene}"${s.speed ? ` speed ${s.speed}` : ''}` : s.mode === 'plug' ? '' : '';
  return `${b.name.padEnd(16)} ${(b.ip || '').padEnd(15)} ${s.on ? 'ON ' : 'off'}  ${String(s.brightness ?? '').padStart(3)}${s.brightness != null ? '%' : ' '}  ${what}  (${s.rssi != null ? s.rssi + ' dBm' : b.brand || b.driver})`;
};
const fmt = (b, p) => {
  const s = wiz.describePilot(p);
  let what = s.mode === 'color' ? `colour ${s.hex}` : s.mode === 'white' ? `white ${s.temp}K` : s.mode === 'scene' ? `scene "${s.scene}"${s.speed ? ` speed ${s.speed}` : ''}` : '';
  return `${b.name.padEnd(16)} ${b.ip.padEnd(15)} ${s.on ? 'ON ' : 'off'}  ${String(s.brightness ?? '').padStart(3)}%  ${what}  (${p.rssi} dBm)`;
};

async function ensureBulbs() {
  if (store.list().length === 0) { console.log('No saved bulbs — scanning the network first…'); await doDiscover(); }
}
async function doDiscover() {
  const found = await drivers.get('wiz').discover({ extraIps: store.list().filter((b) => b.driver === 'wiz').map((b) => b.ip) });
  store.upsert(found);
  if (!found.length) { console.log('No WiZ bulbs answered. Check the bulb is powered on and on the same Wi-Fi as this computer.'); return; }
  const saved = store.load().devices;
  for (const d of found) { const b = saved['wiz:' + d.id] || {}; console.log(`${(b.name || d.id).padEnd(16)} ${d.ip.padEnd(15)} ${d.id}  ${d.kind} (${d.moduleName || ''}, fw ${d.fwVersion || '?'})  ${d.state ? d.state.rssi : ''} dBm`); }
  console.log(`\n${found.length} device(s) saved to ${store.CONFIG_PATH}`);
}

async function apply(target, params) {
  await ensureBulbs();
  const bulbs = store.resolve(target);
  const p = wiz.buildPilot(params);
  await Promise.all(bulbs.map(async (b) => {
    try { await drv(b).setState({ ...b, ...(b.tuya || {}) }, p); console.log(`${b.name}: ${JSON.stringify(p)}`); }
    catch (e) { console.error(`${b.name}: ${e.message}`); process.exitCode = 1; }
  }));
}

async function main() {
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help': console.log(HELP); return;
    case 'discover': return doDiscover();
    case 'scenes': for (const [id, n] of Object.entries(wiz.SCENES)) console.log(`${String(id).padStart(2)}  ${n}${wiz.DYNAMIC_SCENES.has(+id) ? '  (animated)' : ''}`); return;
    case 'list': case 'status': {
      await ensureBulbs();
      const bulbs = cmd === 'list' ? store.list() : store.resolve(args[0]);
      const def = store.load().defaultKey;
      await Promise.all(bulbs.map(async (b) => {
        try { const st = await drv(b).getState({ ...b, ...(b.tuya || {}) }); console.log((b.key === def ? '* ' : '  ') + fmtState(b, st)); }
        catch (e) { console.log(`  ${b.name.padEnd(16)} ${(b.ip || '').padEnd(15)} offline (${e.message})`); }
      }));
      return;
    }
    case 'on': return apply(args[0], { state: true });
    case 'off': return apply(args[0], { state: false });
    case 'toggle': {
      await ensureBulbs();
      for (const b of store.resolve(args[0])) { const st = await drv(b).getState({ ...b, ...(b.tuya || {}) }); await drv(b).setState({ ...b, ...(b.tuya || {}) }, { state: !st.on }); console.log(`${b.name}: ${st.on ? 'off' : 'on'}`); }
      return;
    }
    case 'dim': case 'brightness': if (!args[0]) throw new Error('dim needs a value 10-100'); return apply(args[1], { dimming: args[0] });
    case 'color': case 'colour': if (!args[0]) throw new Error('color needs a colour'); return apply(args[1], wiz.parseColor(args[0]));
    case 'white': case 'temp': if (!args[0]) throw new Error('white needs a kelvin value, e.g. 2700'); return apply(args[1], { temp: String(args[0]).replace(/k$/i, '') });
    case 'scene': {
      if (!args[0]) throw new Error('scene needs an id or name (see: node wiz.js scenes)');
      let id = Number(args[0]);
      if (!id) { const hit = Object.entries(wiz.SCENES).find(([, n]) => n.toLowerCase().replace(/\s/g, '') === args[0].toLowerCase().replace(/\s/g, '')); if (!hit) throw new Error(`Unknown scene "${args[0]}"`); id = +hit[0]; }
      return apply(args[1], { sceneId: id, speed: flags.speed });
    }
    case 'rename': { await ensureBulbs(); const [b] = store.resolve(args[0], { allowAll: false }); const name = args.slice(1).join(' '); if (!name) throw new Error('rename needs a new name'); store.update(b.key, { name }); console.log(`${b.name} → "${name}"`); return; }
    case 'use': { await ensureBulbs(); const [b] = store.resolve(args[0], { allowAll: false }); store.setDefault(b.key); console.log(`Default: ${b.name} (${b.ip || b.key})`); return; }
    case 'forget': { const [b] = store.resolve(args[0], { allowAll: false }); store.forget(b.key); console.log(`Forgot ${b.name}`); return; }
    case 'raw': {
      await ensureBulbs();
      const [b] = store.resolve(args[0], { allowAll: false });
      if (!args[1]) throw new Error('raw needs a method name');
      console.log(JSON.stringify(await wiz.send(b.ip, args[1], args[2] ? JSON.parse(args[2]) : {}), null, 2));
      return;
    }
    default: throw new Error(`Unknown command "${cmd}"\n\n${HELP}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });

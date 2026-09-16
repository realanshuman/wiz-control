#!/usr/bin/env node
'use strict';
// Smoke test: starts the bridge on a random port with a throwaway config, exercises the API
// (no bulbs needed), and checks the protocol helpers. Run: node test/smoke.js
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const wiz = require('../lib/wiz');

const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-test-')), 'bulbs.json');
const PORT = 4300 + Math.floor(Math.random() * 500);
const ORIGIN = 'https://example.vercel.app';

// --- pure helpers ---
assert.deepStrictEqual(wiz.parseColor('#ff8800'), { r: 255, g: 136, b: 0 });
assert.deepStrictEqual(wiz.parseColor('255,0,120'), { r: 255, g: 0, b: 120 });
assert.deepStrictEqual(wiz.parseColor('warm'), { temp: 2700 });
assert.deepStrictEqual(wiz.buildPilot({ r: 300, g: -5, b: 10 }), { r: 255, g: 0, b: 10, c: 0, w: 0, state: true });
assert.deepStrictEqual(wiz.buildPilot({ dimming: 5 }), { dimming: 10 });
assert.deepStrictEqual(wiz.buildPilot({ sceneId: 4, speed: 500 }), { sceneId: 4, state: true, speed: 200 });
assert.throws(() => wiz.buildPilot({}));
assert.strictEqual(wiz.describePilot({ state: true, sceneId: 11, dimming: 50 }).scene, 'Warm White');
assert.strictEqual(wiz.describePilot({ state: true, r: 255, g: 0, b: 0 }).hex, '#ff0000');
assert.strictEqual(wiz.capabilities('ESP25_SHRGB_01').color, true);
assert.strictEqual(wiz.capabilities('ESP10_SOCKET_06').socket, true);
console.log('helpers ok');

// --- server ---
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(PORT), '--no-open', '--config', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
const base = `http://127.0.0.1:${PORT}`;
const req = async (p, method = 'GET', body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};
(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/ping'); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); } }
  try {
    const ping = await req('/api/ping');
    assert.strictEqual(ping.body.name, 'wiz-control'); assert.strictEqual(ping.body.bulbs, 0); assert.strictEqual(ping.body.profile, null);

    // static files
    for (const f of ['/', '/app.js', '/style.css']) { const r = await fetch(base + f); assert.strictEqual(r.status, 200, f); }
    assert.strictEqual((await fetch(base + '/../package.json')).status, 404);

    // CORS: allowed origin gets headers, others don't
    const pre = await fetch(base + '/api/bulbs', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(pre.status, 204); assert.strictEqual(pre.headers.get('access-control-allow-origin'), ORIGIN);
    assert.strictEqual(pre.headers.get('access-control-allow-private-network'), 'true');
    const bad = await fetch(base + '/api/ping', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(bad.headers.get('access-control-allow-origin'), null);

    // profile lifecycle
    let p = await req('/api/profile', 'PUT', { ownerName: '  Ada  ', homeName: 'Lab', wifiName: 'Net', completed: true, junk: 'x' });
    assert.strictEqual(p.body.ownerName, 'Ada'); assert.strictEqual(p.body.completed, true); assert.strictEqual(p.body.junk, undefined);
    assert.strictEqual((await req('/api/ping')).body.profile.homeName, 'Lab');
    await req('/api/profile', 'DELETE'); assert.strictEqual((await req('/api/profile')).body, null);

    // validation
    assert.strictEqual((await req('/api/bulbs/deadbeef0000', 'POST', { state: true })).status, 404);
    assert.strictEqual((await req('/api/all', 'POST', {})).status, 400);
    assert.strictEqual((await req('/api/scenes')).body.length, 32);
    assert.strictEqual((await req('/api/nope')).status, 404);

    // reset
    assert.strictEqual((await req('/api/reset', 'POST')).body.ok, true);
    const saved = JSON.parse(fs.readFileSync(cfg, 'utf8')); assert.deepStrictEqual(saved.bulbs, {}); assert.strictEqual(saved.profile, null);
    console.log('api ok');
  } catch (e) { console.error('FAILED:', e.message, '\n--- server output ---\n' + out); process.exitCode = 1; }
  finally { srv.kill(); fs.rmSync(path.dirname(cfg), { recursive: true, force: true }); }
})();

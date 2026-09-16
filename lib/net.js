'use strict';
// Best-effort details about the network this bridge is on: Wi-Fi name and host name.
// Every call is optional and short-lived; failures just mean "unknown".
const os = require('os');
const { execFile } = require('child_process');

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    try { execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout))); }
    catch (_) { resolve(''); }
  });
}
const clean = (s) => { s = String(s || '').trim(); return !s || /redacted|not associated|not connected/i.test(s) ? '' : s; };

async function wifiName() {
  const p = process.platform;
  if (p === 'darwin') {
    // macOS 14.4+ hides the SSID from terminal tools unless they have Location permission,
    // so this often comes back empty; the UI lets the user type it in that case.
    for (const iface of ['en0', 'en1']) {
      const out = await run('/usr/sbin/ipconfig', ['getsummary', iface]);
      const m = out.match(/^\s*SSID\s*:\s*(.+)$/m);
      if (m && clean(m[1])) return clean(m[1]);
      const ns = await run('/usr/sbin/networksetup', ['-getairportnetwork', iface]);
      const n = ns.match(/Network:\s*(.+)$/m);
      if (n && clean(n[1])) return clean(n[1]);
    }
    return '';
  }
  if (p === 'win32') {
    const out = await run('netsh', ['wlan', 'show', 'interfaces']);
    const m = out.match(/^\s*SSID\s*:\s*(.+)$/m);
    return m ? clean(m[1]) : '';
  }
  // Linux and friends
  let out = await run('iwgetid', ['-r']);
  if (clean(out)) return clean(out);
  out = await run('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi']);
  const line = out.split('\n').find((l) => l.startsWith('yes:'));
  return line ? clean(line.slice(4)) : '';
}

async function computerName() {
  if (process.platform === 'darwin') { const n = clean(await run('/usr/sbin/scutil', ['--get', 'ComputerName'])); if (n) return n; }
  return os.hostname().replace(/\.local$/, '');
}

/** Cached snapshot, refreshed in the background so /api/ping stays instant. */
const info = { wifi: '', computer: '', platform: process.platform, lanIps: [] };
async function refresh() {
  info.wifi = await wifiName();
  info.computer = await computerName();
  info.lanIps = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(utun|tun|tap|ppp|wg|ipsec|zt|tailscale|docker|br-|veth|vmnet|vboxnet)/i.test(name))
    .flatMap(([, addrs]) => addrs).filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  return info;
}
function start(intervalMs = 60000) { const first = refresh(); setInterval(refresh, intervalMs).unref(); return first; }

module.exports = { wifiName, computerName, refresh, start, info };

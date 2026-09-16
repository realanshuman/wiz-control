<p align="center"><img src="https://raw.githubusercontent.com/realanshuman/wiz-control/main/docs/icon.png" width="96" alt=""></p>
<h1 align="center">WiZ Control</h1>
<p align="center">Control your Philips WiZ Wi-Fi bulbs from a web page, on your own network.<br>No account, no cloud, no phone app.</p>

---

WiZ Control is two small pieces:

- **The web app**, a page you open in any browser. Guided setup, a dashboard for every bulb, colour wheel, tunable whites, all 32 WiZ scenes, brightness, and a profile for your home. It is designed for phones as much as for desktops and can be added to a phone's home screen like an app.
- **The bridge**, a tiny helper you open once on a computer at home. Bulbs only answer devices on the same Wi-Fi, and a web page can't reach them by itself, so the bridge does the talking. It is a single file, needs nothing installed, and stores everything on your own computer.

Everything happens on your network. Turn the internet off and the lights still work.

## For users

1. Open the web app: **https://wiz-control.vercel.app** (or run your own copy, see below).
2. Press **Get started** and download the bridge for your computer. Open it once.
3. Name your home, find your bulbs, done.
4. On your phone, scan the QR code shown in Settings (or on the last setup step) while on the same Wi-Fi. That opens the same app, served by the bridge.

The first launch of the bridge shows a security prompt because the app isn't signed with a paid developer certificate. On a Mac: **System Settings → Privacy & Security → Open Anyway**. On Windows: **More info → Run anyway**. It happens once.

Bulbs must already be on your Wi-Fi. Putting a brand-new bulb on the network for the first time is the one thing WiZ only allows through their app. Do that once; after that the app is never needed.

## For developers

Requires [Node.js](https://nodejs.org) 18 or newer. No dependencies to install.

```bash
git clone https://github.com/realanshuman/wiz-control.git
cd wiz-control
node server.js            # bridge + web app at http://localhost:4200
```

Or, without cloning:

```bash
npx -y github:realanshuman/wiz-control
```

### Command line

```bash
node wiz.js discover              # scan the network, save bulbs
node wiz.js list                  # saved bulbs with live state
node wiz.js rename "Bulb 3092" Bedroom
node wiz.js use Bedroom           # default bulb for the commands below
node wiz.js on | off | toggle
node wiz.js dim 30                # brightness 10–100
node wiz.js color ff8800          # #hex, r,g,b or a name (red, teal, pink, warm, cool …)
node wiz.js white 2700            # kelvin 2200–6500
node wiz.js scene fireplace --speed 60
node wiz.js scene 12 all          # "all" targets every saved bulb
node wiz.js scenes                # the 32 scene ids and names
node wiz.js raw Bedroom getSystemConfig   # any raw WiZ method
```

### Bridge options

```
node server.js --lan                     reachable from phones on your Wi-Fi (the downloadable app does this by default)
node server.js --local                   this computer only (the default when run from source)
node server.js --port 5000               different port
node server.js --origin https://x.app    allow another website to control this bridge
node server.js --config ~/bulbs.json     where bulbs and profile are stored
node server.js --no-open                 don't open the browser
```

Environment variables `PORT`, `HOST`, `ALLOWED_ORIGINS`, `WIZ_CONFIG` and `APP_URL` do the same.

### HTTP API

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/ping` | | bridge info, profile, Wi-Fi name |
| GET | `/api/bulbs` | | saved bulbs with live state |
| POST | `/api/discover` | | scan the network and save what answers |
| GET | `/api/bulbs/:mac` | | one bulb |
| POST | `/api/bulbs/:mac` | `{state, dimming, r, g, b, temp, sceneId, speed}` | any subset |
| POST | `/api/bulbs/:mac/toggle` | | |
| PATCH | `/api/bulbs/:mac` | `{name}` or `{default: true}` | |
| DELETE | `/api/bulbs/:mac` | | forget one; `DELETE /api/bulbs` forgets all |
| POST | `/api/all` | same as set | every saved bulb |
| GET/PUT/DELETE | `/api/profile` | `{ownerName, homeName, wifiName, completed}` | |
| GET | `/api/scenes` | | |
| POST | `/api/reset` | | clear profile and bulbs |
| POST | `/api/quit` | | stop the bridge |

```bash
curl -X POST localhost:4200/api/bulbs/<mac> -d '{"r":255,"g":80,"b":0,"dimming":60}'
```

### Hosting your own copy of the web app

The web app is static: the `public` folder. Deploy it anywhere. On Vercel, import the repository and it deploys with no settings (`vercel.json` is included):

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/realanshuman/wiz-control)

A hosted page talks to the bridge on the visitor's own computer at `http://localhost:4200`. The bridge accepts browser requests only from the official site and `localhost`; a self-hosted copy shows visitors the exact bridge command with `--origin` filled in, and the downloadable app can be told its site with `APP_ORIGIN` at build time.

### Building the downloadable bridge

Releases are built by GitHub Actions when a tag such as `v1.0.1` is pushed (see `.github/workflows/release.yml`). To build locally:

```bash
npm install
npm run build:all                  # dist/ gets a binary per platform
npx pkg . --targets node22-macos-arm64 --output dist/wiz-bridge-arm64 && bash scripts/build-mac-app.sh dist/wiz-bridge-arm64 AppleSilicon   # macOS: .app + zip
```

## How it works

WiZ bulbs accept JSON over UDP on port 38899 from any device on the LAN. `getPilot` reads the state, `setPilot` changes it (`state`, `dimming`, `r/g/b`, `temp`, `sceneId`, `speed`), `getSystemConfig` reports the model. Discovery sends `getPilot` as a broadcast plus a unicast sweep of the subnet, because broadcast over Wi-Fi is unreliable. If a bulb's IP changes, the bridge re-discovers it on the next command.

| File | What it does |
| --- | --- |
| `lib/wiz.js` | the WiZ protocol: discovery, get/set, scenes, colour parsing |
| `lib/store.js` | bulbs and profile on disk |
| `lib/net.js` | Wi-Fi name and computer name, best effort |
| `server.js` | the bridge: web server, API, browser opening |
| `wiz.js` | command-line tool |
| `public/` | the web app (plain HTML, CSS and JS, no build step) |
| `scripts/` | icon generator and macOS app bundling |
| `test/smoke.js` | API smoke test, runs in CI |

## Security notes

- The WiZ protocol has no authentication: any device on your Wi-Fi can already control the bulbs. The bridge doesn't change that.
- Run from source, the bridge listens on `localhost` only unless you pass `--lan`. The downloadable app listens on your Wi-Fi so phones can use it; pass `--local` to change that.
- "Log out" in the app only signs that browser out of the home. Nothing on the bridge is deleted; "Reset" in Settings does that.
- Browsers only let a website read from the bridge if its origin is on the allow list, and the bridge refuses state changes from any other site (it also checks the Host header, so DNS-rebinding tricks don't work). Chrome asks you once before a public site may reach your local network.

## Brands

Add devices from the dashboard with **Add device**, then control them all together.

| Brand | How it connects | Notes |
| --- | --- | --- |
| **Philips WiZ** | Local Wi-Fi (UDP) | Found automatically. Bulbs, strips, plugs. |
| **Wipro / Tuya** (Beta) | Local Wi-Fi (encrypted) | Wipro, Syska and most Tuya bulbs and plugs. Needs a one-time **local key** from a free [Tuya developer account](https://iot.tuya.com); the Add flow explains how. |
| **Philips Hue** (Beta) | Hue Bridge (local REST) | Press the bridge's link button to pair, then all its bulbs import. |

Smart plugs and switches show as a simple on/off tile. Devices can be grouped into **rooms**.

Beta drivers are implemented to each protocol's spec and unit-tested, but haven't yet been verified against physical hardware in this project — please report anything that misbehaves.

## License

MIT

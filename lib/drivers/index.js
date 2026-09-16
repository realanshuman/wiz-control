'use strict';
// Driver registry. Each brand implements the same interface so the server and UI stay
// brand-agnostic: discover(), getState(dev), setState(dev, params), caps(dev), scenes().
const wiz = require('./wiz');
const tuya = require('./tuya');
const hue = require('./hue');

const DRIVERS = { wiz, tuya, hue };

const get = (id) => DRIVERS[id];
const keyOf = (dev) => `${dev.driver}:${dev.id}`;

// What the brand picker shows. `addStyle`: how a device of this brand is added.
function brands() {
  return [
    { id: 'wiz', label: 'Philips WiZ', addStyle: 'scan', beta: false, blurb: 'Wi-Fi bulbs, strips and plugs. Found automatically.' },
    { id: 'tuya', label: 'Wipro / Tuya', addStyle: 'key', beta: true, blurb: 'Wipro, Syska and other Tuya bulbs and plugs. Needs a one-time device key.' },
    { id: 'hue', label: 'Philips Hue', addStyle: 'pair', beta: true, blurb: 'Hue bulbs via the Hue Bridge. Press the bridge button to pair.' },
  ];
}

module.exports = { DRIVERS, get, keyOf, brands };

// Admin › Live riders: the hexagon surge map drawn over the riders (getRiderSurgeMap). Each
// hexagon is coloured by how busy the riders around it are, with the surge fee written on it while
// rider surge is on. The code under test is cut from the Admin app's premium.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "../admin/src/main/assets/premium.js"), "utf8");
const cut = (from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); assert.ok(i > 0 && j > i, "premium.js: can't find " + from); return src.slice(i, j); };
const ctx = {state: {}, h: (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"), icon: () => ""};
vm.createContext(ctx);
vm.runInContext(cut("  function liveRiderList(", "  function screenLiveRiders("), ctx);

// A hexagon of radius 20 px around (x, y), in the map's own pixels.
const hex = (x, y) => Array.from({length: 6}, (_, i) => [y + 20 * Math.sin(i * Math.PI / 3), x + 20 * Math.cos(i * Math.PI / 3)]);
const project = ([lat, lng]) => [lng, lat];
ctx.state.surgeMap = {enabled: true, minOnline: 3, rings: 1, riders: 12, truncated: false, hexagons: [
  {cell: "a", corners: hex(100, 100), here: 4, online: 8, busy: 8, level: 3, fee: 30},
  {cell: "b", corners: hex(140, 100), here: 0, online: 8, busy: 6, level: 1, fee: 10},
  {cell: "c", corners: hex(180, 100), here: 2, online: 10, busy: 2, level: 0, fee: 0},
  {cell: "d", corners: hex(220, 100), here: 1, online: 1, busy: 1, level: -1, fee: 0},
  {cell: "off", corners: hex(900, 900), here: 1, online: 4, busy: 4, level: 3, fee: 30},
]};

let svg = ctx.surgeHexagons(project, 360, 380);
assert.equal((svg.match(/<polygon/g) || []).length, 4, "hexagons off the map aren't drawn");
assert.match(svg, /class="hex-l3"[^>]*>.*8 of 8 riders busy nearby · surge ₹30/);
assert.match(svg, /class="hex-l1"/);
assert.match(svg, /class="hex-l0"/);
assert.match(svg, /class="hex-ln"/, "too few riders: grey");
assert.doesNotMatch(svg, /<text/, "fees go in their own layer, over the rider dots");
const labels = ctx.surgeHexagons(project, 360, 380, true);
assert.doesNotMatch(labels, /<polygon/);
assert.match(labels, /<text x="100\.0" y="104\.0">\+₹30<\/text>/, "the fee sits in the middle of its hexagon");
assert.equal((labels.match(/<text/g) || []).length, 2);
assert.match(ctx.surgeSummary(), /3 hexagons charging rider surge/, "counts the whole map, not just what is on screen");

// Surge switched off: colours still show how busy riders are, but no fees are written.
ctx.state.surgeMap.enabled = false;
assert.equal(ctx.surgeHexagons(project, 360, 380, true), "");
assert.equal((ctx.surgeHexagons(project, 360, 380).match(/<polygon/g) || []).length, 4);
assert.match(ctx.surgeSummary(), /Rider surge is off/);

// No map yet, or it failed: riders still show, with a line saying so.
ctx.state.surgeMap = null;
assert.equal(ctx.surgeHexagons(project, 360, 380), "");
ctx.state.surgeMapError = "You're offline.";
assert.match(ctx.surgeSummary(), /Surge map unavailable: You're offline\./);

// The settings screen saves rider surge, and refuses tiers that don't go up.
const settings = cut("  async function saveSettings(form){", "\n");
assert.match(settings, /riderSurgeEnabled:fd\.get\("riderSurgeEnabled"\)==="on"/);
assert.match(settings, /Rider surge busy % must increase from low to high/);
console.log("Admin surge map: hexagons coloured by how busy riders are, fees shown while surge is on, settings saved.");

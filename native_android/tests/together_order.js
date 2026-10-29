// Order together (functions/src/services/clusterOrders.ts), in the apps. Customer: carts from
// restaurants in the same area are offered together, the checkout shows the pickup order and one
// bill, and placing sends one request for all of them. Rider: the trip is one card; pickups go in
// order, delivery starts once everything is collected, and one code completes every part.
// Restaurant: each part says where it sits in the trip. The code is cut from each app's premium.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (app) => fs.readFileSync(path.join(__dirname, "..", app, "src/main/assets/premium.js"), "utf8");
const cutter = (src, name) => (from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); assert.ok(i > 0 && j > i, name + ": can't find " + from); return src.slice(i, j); };
const h = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const tick = () => new Promise((r) => setTimeout(r, 5));
// Values made inside the app's sandbox have its own Array/Object, so compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Each restaurant's cluster hexagon and the 6 around it, as the server stores them on the listing
// (functions/src/domain/clusterOrder.ts, H3 resolution 8), for these spots in Naidupeta.
const CELLS = {"biryani": {"clusterCell": "88618e6597fffff", "clusterCells": ["88618a9a69fffff", "88618a9a6dfffff", "88618e6591fffff", "88618e6593fffff", "88618e6595fffff", "88618e6597fffff", "88618e65bbfffff"]}, "cafe": {"clusterCell": "88618e65bbfffff", "clusterCells": ["88618a9a6dfffff", "88618e6595fffff", "88618e6597fffff", "88618e65b1fffff", "88618e65b3fffff", "88618e65b9fffff", "88618e65bbfffff"]}, "icecream": {"clusterCell": "88618e6595fffff", "clusterCells": ["88618e6583fffff", "88618e6591fffff", "88618e6595fffff", "88618e6597fffff", "88618e659dfffff", "88618e65b9fffff", "88618e65bbfffff"]}, "far": {"clusterCell": "88618a9b0dfffff", "clusterCells": ["88618a9b01fffff", "88618a9b05fffff", "88618a9b09fffff", "88618a9b0dfffff", "88618a9b47fffff", "88618a9b63fffff", "88618a9b6bfffff"]}, "nearby": {"clusterCell": "88618e6597fffff", "clusterCells": ["88618a9a69fffff", "88618a9a6dfffff", "88618e6591fffff", "88618e6593fffff", "88618e6595fffff", "88618e6597fffff", "88618e65bbfffff"]}};
function place(id, name, lat, lng) {
  return {id, name, lat, lng, open: true, ...CELLS[id]};
}
const CATALOG = {
  biryani: place("biryani", "Paradise Biryani", 14.0350, 79.9050),
  cafe: place("cafe", "Brew Cafe", 14.0385, 79.9055),
  icecream: place("icecream", "Polar Ice Cream", 14.0330, 79.9095),
  far: place("far", "Highway Dhaba", 14.0890, 79.9050),
};
const line = (rid, itemId, name, price) => ({key: rid + "::" + itemId, restaurantId: rid, itemId, name, price, quantity: 1, addOns: [], addOnIds: []});

async function customer() {
  const cut = cutter(read("app"), "customer");
  const code = cut("  // ---- Order together:", "  Object.assign(SCREENS, {");
  const calls = [], toasts = [];
  const ctx = {
    console, setTimeout, Date, JSON, Math, Number, String, Object, Array, Set,
    document: {getElementById: (id) => id === "together-instructions" ? {value: "Ring the bell"} : null},
    h, money: (v) => "₹" + Number(v).toFixed(0), icon: () => "", topbar: (t, s) => "<h1>" + t + "</h1><p>" + s + "</p>",
    networkBanner: () => "", nav: () => "", emptyState: (i, t) => "<empty>" + t + "</empty>",
    state: {
      cart: [line("biryani", "b1", "Chicken Biryani", 240)],
      carts: {cafe: [line("cafe", "c1", "Filter Coffee", 40)], icecream: [line("icecream", "i1", "Kulfi", 60)], far: [line("far", "f1", "Dal", 150)]},
      catalog: {...CATALOG, nearby: place("nearby", "Annapurna Meals", 14.0365, 79.9040)},
      checkout: {instructions: "", contactless: false}, orders: [], deliveryOtps: {}, profile: {phone: "9876543210"},
      online: true, loading: false, route: "cart", tip: 0, session: {idToken: "t"},
    },
    currentAddress: () => ({id: "home", label: "Home", phone: "9876543210", lat: 14.04, lng: 79.9}),
    addressSummary: () => "<address>", validPhone: () => true, statusTone: () => "",
    restaurant: (id) => ctx.state.catalog[id] || null, cartRestaurant: () => ctx.state.catalog[ctx.state.cart[0].restaurantId],
    parkedCarts: () => ctx.state.carts,
    cartSummary: (e) => ({rid: e.rid, name: ctx.state.catalog[e.rid].name, count: e.items.length, subtotal: e.items.reduce((n, x) => n + x.price, 0)}),
    uid: () => "abcdef1234567890", persistCheckout() {}, persistCart() {}, persistOrders() {},
    render() { if (ctx.SCREENS && ctx.state.route === "together") ctx.html = ctx.screenTogether(); },
    go(route, data) { ctx.state.route = route; ctx.went = [route, data]; },
    toast: (m, t) => toasts.push([m, t]), friendlyError: (e) => e.message, ensureSession: async () => {},
    nativeAvailable: (op) => op === "invokeOrder",
    async nativeInvoke(op, payload) {
      assert.equal(op, "invokeOrder");
      calls.push(payload);
      await tick();
      const ids = payload.data.parts.map((p) => p.restaurantId);
      // The server's answer: pickup order biryani → cafe → ice cream, whatever the cart order.
      const order = ["biryani", "cafe", "icecream"].filter((id) => ids.includes(id));
      const parts = order.map((id, i) => ({restaurantId: id, restaurant: CATALOG[id].name, leg: i + 1, careLabel: ["Keeps well", "Drinks", "Melts fast"][i],
        subtotal: {biryani: 240, cafe: 40, icecream: 60}[id], total: {biryani: 300, cafe: 63, icecream: 85}[id],
        pricing: {subtotal: 0, deliveryFee: i ? 20 : 35, platformFee: i ? 0 : 9, tax: 5, tip: 0, discount: 0}}));
      if (payload.fn === "previewClusterOrder") return {parts, subtotal: 340, total: 448, stopFee: 20, etaMin: 38, etaMax: 50};
      return {clusterId: "cl_1", deliveryOtp: "4821", recovered: false,
        orders: parts.map((p, i) => ({id: "o" + (i + 1), restaurantId: p.restaurantId, status: "Order placed", cluster: {id: "cl_1", leg: i + 1, size: parts.length}}))};
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code + "\nthis.screenTogether=screenTogether;this.SCREENS={};", ctx);

  // The cart offers the saved carts from places nearby, not the dhaba 6 km away, and suggests the meals place.
  let card = ctx.togetherCard();
  assert.match(card, /Brew Cafe/);
  assert.match(card, /Polar Ice Cream/);
  assert.doesNotMatch(card, /Highway Dhaba/);
  assert.match(card, /\+ Annapurna Meals/);
  assert.doesNotMatch(card, /Order \d restaurants together/, "nothing picked yet");
  ctx.handleTogetherClick("together-pick", {dataset: {restaurantId: "icecream"}});
  ctx.handleTogetherClick("together-pick", {dataset: {restaurantId: "cafe"}});
  ctx.handleTogetherClick("together-pick", {dataset: {restaurantId: "far"}});
  assert.deepEqual(plain(ctx.state.togetherPick).sort(), ["cafe", "icecream"], "a cart from too far away can't be picked");
  card = ctx.togetherCard();
  assert.match(card, /Order 3 restaurants together/);

  // The checkout asks for the bill, then shows the pickup order the server planned.
  ctx.state.route = "together";
  ctx.html = ctx.screenTogether();
  assert.match(ctx.html, /Working out the best pickup order/);
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(plain(calls[0].data.parts.map((p) => p.restaurantId)), ["biryani", "icecream", "cafe"], "the cart being edited goes first");
  assert.match(ctx.html, /1<\/span><div class="grow"><strong>Paradise Biryani<\/strong><span class="caption">Keeps well · picked up first/);
  assert.match(ctx.html, /3<\/span><div class="grow"><strong>Polar Ice Cream<\/strong><span class="caption">Melts fast · picked up last/);
  assert.match(ctx.html, /2 extra restaurants<\/span><span>₹40/);
  assert.match(ctx.html, /To pay<\/strong><strong>₹448/);
  assert.match(ctx.html, /Cash or UPI/);

  // Placing: one request, carts cleared, the same code on every part, and on to tracking.
  await ctx.submitTogether();
  const placed = calls.find((c) => c.fn === "createClusterOrder").data;
  assert.equal(placed.paymentMethod, "cod");
  assert.equal(placed.instructions, "Ring the bell");
  assert.match(placed.idempotencyKey, /^tog_/);
  assert.equal(placed.parts.length, 3);
  assert.deepEqual(plain(ctx.state.cart), []);
  assert.deepEqual(plain(Object.keys(ctx.state.carts)), ["far"], "only the cart left out stays");
  assert.deepEqual(plain(ctx.state.deliveryOtps), {o1: "4821", o2: "4821", o3: "4821"});
  assert.deepEqual(plain(ctx.went), ["order", {orderId: "o1"}]);
  assert.equal(ctx.state.checkout.pendingTogetherKey, "");

  // Tracking lists every restaurant in pickup order with its status.
  ctx.state.orders = [{id: "o1", status: "Out for delivery"}, {id: "o2", status: "Handed to rider"}, {id: "o3", status: "Preparing"}];
  const trip = ctx.clusterTripCard({id: "o1", status: "Out for delivery", cluster: {id: "cl_1", leg: 1, size: 3, stops: [
    {orderId: "o1", restaurant: "Paradise Biryani", careLabel: "Keeps well"}, {orderId: "o2", restaurant: "Brew Cafe", careLabel: "Drinks"},
    {orderId: "o3", restaurant: "Polar Ice Cream", careLabel: "Melts fast"}]}});
  assert.match(trip, /3 restaurants, one rider/);
  assert.match(trip, /Polar Ice Cream.*Preparing/);
  assert.equal(ctx.clusterCaption({cluster: {leg: 2, size: 3}}), "Together order · 2 of 3");
  console.log("Customer app: nearby carts offered together, pickup order and one bill shown, one request places all, tracking lists every restaurant.");
}

async function rider() {
  const cut = cutter(read("rider"), "rider");
  const code = cut("  // ---- Together orders: one trip", "  function workflowAction(");
  const statuses = [], toasts = [];
  const trip = (leg, status, extra) => ({id: "o" + leg, status, restaurant: ["Paradise Biryani", "Brew Cafe", "Polar Ice Cream"][leg - 1],
    paymentMethod: "cod", total: [300, 63, 85][leg - 1], address: {}, customerName: "Ravi",
    cluster: {id: "cl_1", leg, size: 3, stops: [1, 2, 3].map((n) => ({orderId: "o" + n, restaurant: ["Paradise Biryani", "Brew Cafe", "Polar Ice Cream"][n - 1], careLabel: ""}))}, ...extra});
  const ctx = {
    console, Date, JSON, Math, Number, String, Set, Array, FormData: class { constructor(f) { this.f = f; } get(k) { return this.f.values[k]; } },
    h, icon: () => "", money: (v) => "₹" + Number(v).toFixed(0),
    state: {jobs: [], pendingJobAction: ""},
    activeJobs: () => ctx.state.jobs.filter((j) => j.status !== "Delivered"),
    job: (id) => ctx.state.jobs.find((j) => j.id === id),
    swipeConfirm: (label, attrs) => "<swipe " + attrs + ">" + label + "</swipe>",
    sheetShell: (t, s, body) => body, deliveryOtpCaption: () => "",
    async cloudStatus(o, to, options) { statuses.push([o.id, to, options]); },
    startTracking: async () => true, openNavigation() {}, navigationTarget: () => ({}), stopTracking() {}, closeSheet() {},
    toast: (m, t) => toasts.push([m, t]), friendly: (e) => e.message, syncApproved: async () => {}, render() {}, go() {}, earningDateKey: () => "",
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  ctx.state.jobs = [trip(1, "Handed to rider"), trip(2, "Assigned"), trip(3, "Assigned")];
  assert.equal(ctx.tripParts(ctx.state.jobs[1]).length, 3);
  assert.equal(ctx.tripWorkflow(ctx.state.jobs[1], ctx.tripParts(ctx.state.jobs[1])), null, "a pickup is the usual pickup steps");
  const afterFirst = ctx.tripWorkflow(ctx.state.jobs[0], ctx.tripParts(ctx.state.jobs[0]));
  assert.match(afterFirst, /Picked up\. Next: Brew Cafe/);
  assert.match(afterFirst, /data-job-id="o2"/);
  assert.match(ctx.tripCardMarkup(ctx.tripParts(ctx.state.jobs[0])), /Pickup 2 of 3.*Brew Cafe.*Paradise Biryani → Brew Cafe → Polar Ice Cream/s);
  assert.match(ctx.tripStopsMarkup(ctx.state.jobs[1], ctx.tripParts(ctx.state.jobs[1])), /class="done"><span class="trip-n">✓/);
  await ctx.tripStartDelivery(ctx.state.jobs[0]);
  assert.equal(statuses.length, 0, "delivery doesn't start until everything is collected");
  assert.match(toasts.pop()[0], /every restaurant first/);

  ctx.state.jobs.forEach((j) => { j.status = "Handed to rider"; });
  assert.match(ctx.tripWorkflow(ctx.state.jobs[2], ctx.tripParts(ctx.state.jobs[2])), /trip-start-delivery.*all picked up, start delivery/);
  await ctx.tripStartDelivery(ctx.state.jobs[2]);
  assert.deepEqual(plain(statuses.map((s) => [s[0], s[1]])), [["o1", "Out for delivery"], ["o2", "Out for delivery"], ["o3", "Out for delivery"]]);
  statuses.length = 0;

  // GPS follows one part; until the server has moved the others to Arrived, completion waits.
  ctx.state.jobs[0].status = "Arrived";
  assert.match(ctx.tripWorkflow(ctx.state.jobs[0], ctx.tripParts(ctx.state.jobs[0])), /Confirming arrival/);
  ctx.state.jobs.forEach((j) => { j.status = "Arrived"; });
  assert.match(ctx.tripWorkflow(ctx.state.jobs[0], ctx.tripParts(ctx.state.jobs[0])), /trip-complete.*verify and complete all/);
  const sheet = ctx.tripCompleteSheet({jobId: "o1"});
  assert.match(sheet, /collected exactly ₹448 cash for all 3 restaurants/);
  const form = {dataset: {jobId: "o1"}, values: {otp: "4821", cash: "on", handover: "on"}, querySelector: () => null};
  await ctx.tripComplete(form);
  assert.deepEqual(plain(statuses.map((s) => [s[0], s[1], s[2].deliveryOtp, s[2].cashCollected])),
    [["o1", "Delivered", "4821", true], ["o2", "Delivered", "4821", true], ["o3", "Delivered", "4821", true]]);
  assert.match(toasts.pop()[0], /3 restaurants in one trip/);
  console.log("Rider app: one trip card, pickups in order, delivery starts once all are collected, one code completes every part.");
}

function restaurantNote() {
  const cut = cutter(read("restaurant"), "restaurant");
  const ctx = {h};
  vm.createContext(ctx);
  vm.runInContext(cut("  function togetherNote(", "  function riderComing("), ctx);
  const stops = [{restaurant: "Paradise Biryani"}, {restaurant: "Brew Cafe"}, {restaurant: "Polar Ice Cream"}];
  assert.match(ctx.togetherNote({cluster: {leg: 3, size: 3, stops}}, true), /pickup 3 of 3.*comes to you last, after Brew Cafe\. Pack when you're told/);
  assert.match(ctx.togetherNote({cluster: {leg: 1, size: 3, stops}}, true), /comes to you first/);
  assert.match(ctx.togetherNote({cluster: {leg: 3, size: 3, stops}}, false), /pack when the rider is on the way/);
  assert.equal(ctx.togetherNote({}, true), "");
  console.log("Restaurant app: each part says where it is in the trip, and the last one packs when told.");
}

(async () => {
  await customer();
  await rider();
  restaurantNote();
})().catch((e) => { console.error(e); process.exit(1); });

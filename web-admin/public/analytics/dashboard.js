import {requireAdminSession, signOutUser, callFunction} from "../assets/firebase-client.js?v=5";

// Customer insights: the same server-built aggregates the Admin app shows
// (getAdminAnalytics), on a bigger screen, with CSV downloads and an offer
// form that can aim a discount at a group, an area or chosen dishes.
// Nothing here identifies a person: the server returns totals only.

const AGE_LIST = ["18-24", "25-34", "35-44", "45-54", "55+"];
const GENDER_WORD = {female: "Women", male: "Men", other: "Other", unknown: "Not shared"};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const state = {data: null, days: 30, kind: "all", loading: false};

function h(value) {
  return String(value == null ? "" : value).replace(/[&<>'"]/g, (c) => (
    {"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"}[c]
  ));
}
const rupee = (paise) => "₹" + Math.round(Number(paise || 0) / 100).toLocaleString("en-IN");
const pct = (v) => (Math.round(Number(v || 0) * 10) / 10) + "%";
const hourLabel = (x) => (x === 0 ? "12am" : x < 12 ? x + "am" : x === 12 ? "12pm" : (x - 12) + "pm");
const offerId = (v) => /^[A-Za-z0-9_.:-]+$/.test(String(v || ""));
function toast(message, kind) {
  const node = document.createElement("div");
  node.className = "toast " + (kind || "");
  node.textContent = message;
  document.getElementById("toast-stack").appendChild(node);
  setTimeout(() => node.remove(), 4200);
}
function bar(label, value, share, sub, tone) {
  return '<div class="bar"><div class="bar-top"><span>' + h(label) + '</span><strong>' + value + '</strong></div>' +
    '<div class="track"><span class="' + (tone || "") + '" style="width:' + Math.max(2, Math.min(100, Number(share) || 0)).toFixed(1) + '%"></span></div>' +
    (sub ? '<span class="bar-sub">' + sub + '</span>' : '') + '</div>';
}
function card(title, lede, body, csv) {
  return '<section class="card card-pad ins-card"><div class="ins-head"><h2>' + h(title) + '</h2>' +
    (csv ? '<button class="btn btn-ghost btn-sm" data-csv="' + csv + '">Download CSV</button>' : '') + '</div>' +
    (lede ? '<p class="lede">' + lede + '</p>' : '') + body + '</section>';
}
function offerAttrs(o) {
  return ' data-offer="1"' + Object.keys(o).filter((k) => o[k]).map((k) => ' data-' + k + '="' + h(o[k]) + '"').join("");
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------
function summary(d) {
  const s = d.summary, c = d.coverage;
  const stat = (label, value, sub) => '<div class="stat-card"><div class="label">' + h(label) + '</div><div class="value">' + value + '</div><div class="sub">' + sub + '</div></div>';
  return '<section class="stat-grid" style="margin-bottom:16px">' +
    stat("Customers", s.customers, s.newCustomers + " new · " + s.returningCustomers + " came back") +
    stat("Orders", s.placed, s.delivered + " delivered · " + pct(s.cancelRatePct) + " cancelled") +
    stat("Sales", rupee(s.gmvPaise), "Item totals of delivered orders") +
    stat("Avg order", rupee(s.aovPaise), s.avgItemsPerOrder + " items per order") +
    stat("Repeat rate", pct(s.repeatRatePct), s.repeatCustomers + " ordered 2+ times") +
    stat("Avg delivery", s.avgDeliveryMinutes == null ? "—" : s.avgDeliveryMinutes + " min", "Order placed to delivered") +
    stat("Offer orders", s.offerOrders, rupee(s.discountPaise) + " in discounts") +
    stat("Gone quiet", s.lapsedCustomers, "No order for " + s.lapsedAfterDays + "+ days") +
    '</section>' +
    (c.customers ? '<div class="notice ' + (c.genderPct < 50 ? 'notice-warning' : 'notice-info') + '">' + pct(c.genderPct) +
      ' of customers shared their gender and ' + pct(c.agePct) + ' their age (customer app › Account › About you). Everyone else is counted as “Not shared”. Under-18s are never put in a group.</div>' : '');
}

function people(d) {
  const genders = d.genders.map((g) => bar(g.label, g.orders + " orders · " + pct(g.sharePct), g.sharePct,
    g.customers + " customers · avg order " + rupee(g.aovPaise), g.key === "female" ? "pink" : g.key === "male" ? "blue" : "grey")).join("");
  const ages = d.ageBands.map((a) => bar(a.label, a.orders + " orders · " + pct(a.sharePct), a.sharePct,
    a.customers + " customers · avg order " + rupee(a.aovPaise), a.key === "unknown" ? "grey" : "")).join("");
  const known = d.matrix.filter((m) => m.gender !== "unknown" && m.ageBand !== "unknown");
  const max = Math.max(1, ...known.map((m) => m.orders));
  const matrix = known.length ? '<div class="matrix"><span></span>' + AGE_LIST.map((a) => '<span class="mh">' + a + '</span>').join("") +
    ["female", "male"].map((g) => '<span class="mh left">' + GENDER_WORD[g] + '</span>' + AGE_LIST.map((a) => {
      const m = known.find((x) => x.gender === g && x.ageBand === a), n = m ? m.orders : 0;
      return '<span class="cell" style="--a:' + (n / max).toFixed(2) + '" title="' + n + ' orders">' + (n || "") + '</span>';
    }).join("")).join("") + '</div>' : '<p class="lede">Not enough customers have shared both gender and age yet.</p>';
  const groups = d.groupPicks.filter((g) => g.items.length).map((g) => {
    const first = g.items[0], same = first ? g.items.slice(0, 3).filter((t) => t.restaurantId === first.restaurantId && offerId(t.itemId)) : [];
    return '<div class="group"><h3>' + h(g.label) + '</h3><p class="meta">' + g.customers + ' customers · ' + g.orders + ' orders · ' + pct(g.sharePct) + ' of all orders' +
      (g.lapsedCustomers ? ' · ' + g.lapsedCustomers + ' gone quiet' : '') + (g.earlySignal ? ' · <span class="badge badge-warning">Early signal</span>' : '') + '</p>' +
      g.items.slice(0, 3).map((it, i) => '<div class="pick"><span class="rank">' + (i + 1) + '</span><span><strong>' + h(it.name) + '</strong><br><span class="cell-sub">' +
        h(it.restaurantName) + ' · ' + it.quantity + ' ordered' + (it.lift >= 1.2 ? ' · <span class="lift">' + it.lift + '× more than others</span>' : '') + '</span></span></div>').join("") +
      '<div class="chip-row">' + (same.length ? '<button class="btn btn-primary btn-sm"' + offerAttrs({gender: g.gender, age: g.ageBand, rid: first.restaurantId,
        items: same.map((t) => t.itemId).join("|"), names: same.map((t) => t.name).join("|"), label: g.label}) + '>Offer on their favourites</button>' : '') +
      '<button class="btn btn-tonal btn-sm"' + offerAttrs({gender: g.gender, age: g.ageBand, label: g.label}) + '>Offer for this group</button></div></div>';
  }).join("");
  return '<div class="ins-grid">' + card("Women and men", "Share of orders.", genders) + card("Age groups", "Share of orders.", ages) + '</div>' +
    '<div class="ins-grid">' + card("Who orders most", "Orders by gender and age. Darker means more.", matrix) +
    card("What each group loves", "Most-ordered dishes per group. “2× more” = they order it twice as much as everyone else.",
      groups || '<p class="lede">No customer has shared their gender and age yet. Every customer is now asked for them in the app.</p>', "groups") + '</div>';
}

function mapMarkup(d, W, H) {
  const pts = (d.heat || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!pts.length) return '<p class="lede">No delivery locations in this period.</p>';
  const wx = (lng, z) => (lng + 180) / 360 * 256 * 2 ** z;
  const wy = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; };
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of pts) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng); }
  let z = 16;
  for (; z > 10; z--) if (wx(maxLng, z) - wx(minLng, z) <= W - 80 && wy(minLat, z) - wy(maxLat, z) <= H - 80) break;
  const left = (wx(minLng, z) + wx(maxLng, z)) / 2 - W / 2, top = (wy(minLat, z) + wy(maxLat, z)) / 2 - H / 2;
  let tiles = "";
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + W) / 256); tx++) {
    for (let ty = Math.floor(top / 256); ty <= Math.floor((top + H) / 256); ty++) {
      tiles += '<img alt="" loading="lazy" src="/maptile/day/' + z + '/' + tx + '/' + ty + '" style="left:' + (tx * 256 - left).toFixed(0) + 'px;top:' + (ty * 256 - top).toFixed(0) + 'px">';
    }
  }
  const max = Math.max(1, ...pts.map((p) => p.orders));
  const dots = pts.map((p) => {
    const r = 7 + Math.sqrt(p.orders / max) * 18;
    return '<span class="dot" title="' + p.orders + ' orders" style="left:' + (wx(p.lng, z) - left).toFixed(0) + 'px;top:' + (wy(p.lat, z) - top).toFixed(0) +
      'px;width:' + (2 * r).toFixed(0) + 'px;height:' + (2 * r).toFixed(0) + 'px;--a:' + (0.35 + 0.5 * p.orders / max).toFixed(2) + '"></span>';
  }).join("");
  return '<div class="map" style="width:100%;max-width:' + W + 'px;height:' + H + 'px"><div style="position:relative;width:' + W + 'px;height:' + H + 'px">' + tiles + dots + '</div></div>' +
    '<p class="lede" style="margin-top:8px">Bigger, stronger circles mean more orders from that block (about 400 m).</p>';
}

function places(d) {
  const rows = d.areas.map((a, i) => '<tr><td><div class="cell-title">' + (i + 1) + '. ' + h(a.name) + '</div><div class="cell-sub">' +
    (a.topItem ? 'Loves ' + h(a.topItem) : '') + (a.topGroup ? ' · mostly ' + h(a.topGroup) : '') + '</div></td>' +
    '<td class="num">' + a.orders + '<div class="cell-sub">' + pct(a.sharePct) + '</div></td><td class="num">' + a.customers + '</td><td class="num">' + rupee(a.aovPaise) +
    '</td><td class="num">' + (a.avgDeliveryMinutes == null ? "—" : a.avgDeliveryMinutes + " min") + '</td><td class="num">' + pct(a.cancelRatePct) + '</td><td>' +
    (a.key !== "unknown" ? '<button class="btn btn-tonal btn-sm"' + offerAttrs({area: a.key, label: a.name}) + '>Offer</button>' : '') + '</td></tr>').join("");
  return '<div class="ins-grid wide">' + card("Where orders come from", "", mapMarkup(d, 620, 420)) +
    card("Areas by orders", "", '<div class="table-wrap"><table class="data-table compact"><thead><tr><th>Area</th><th class="num">Orders</th><th class="num">Customers</th><th class="num">Avg order</th><th class="num">Delivery</th><th class="num">Cancelled</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7">No orders in this period.</td></tr>') + '</tbody></table></div>', "areas") + '</div>';
}

function dishes(d) {
  const rows = d.items.map((it, i) => {
    const g = it.genders || {}, tot = (g.female || 0) + (g.male || 0) + (g.other || 0) + (g.unknown || 0) || 1;
    const w = Math.round((g.female || 0) / tot * 100), m = Math.round((g.male || 0) / tot * 100);
    const ages = it.ageBands || {}, topAge = AGE_LIST.map((a) => [a, ages[a] || 0]).sort((x, y) => y[1] - x[1])[0];
    return '<tr><td><div class="cell-title">' + (i + 1) + '. ' + h(it.name) + '</div><div class="cell-sub">' + h(it.restaurantName) + '</div></td>' +
      '<td class="num">' + it.quantity + '</td><td class="num">' + rupee(it.revenuePaise) + '</td><td class="num">' + it.customers + '</td>' +
      '<td><div class="split"><span class="pink" style="width:' + w + '%"></span><span class="blue" style="width:' + m + '%"></span></div><div class="cell-sub">' + w + '% women · ' + m + '% men</div></td>' +
      '<td>' + (topAge && topAge[1] ? topAge[0] : '—') + '</td><td>' + (offerId(it.itemId) ? '<button class="btn btn-tonal btn-sm"' +
        offerAttrs({rid: it.restaurantId, items: it.itemId, names: it.name, label: it.name}) + '>Offer</button>' : '') + '</td></tr>';
  }).join("");
  const pairs = d.pairs.map((p) => '<tr><td>' + h(p.a) + ' + ' + h(p.b) + '<div class="cell-sub">' + h(p.restaurantName) + '</div></td><td class="num">' + p.orders + '</td></tr>').join("");
  const dt = d.diet || {};
  const diet = dt.totalQuantity ? [["veg", "Veg", "green"], ["nonveg", "Non-veg", "red"], ["egg", "Egg", ""], ["other", "Not marked", "grey"]]
    .filter((x) => dt[x[0]]).map((x) => bar(x[1], dt[x[0]] + " items · " + pct(dt[x[0]] / dt.totalQuantity * 100), dt[x[0]] / dt.totalQuantity * 100, "", x[2])).join("") : '<p class="lede">No items.</p>';
  return card("Best sellers", "What sells most, who buys it, and an offer on it in one tap.",
    '<div class="table-wrap"><table class="data-table"><thead><tr><th>Dish</th><th class="num">Sold</th><th class="num">Sales</th><th class="num">Customers</th><th>Women / men</th><th>Most by age</th><th></th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="7">No orders in this period.</td></tr>') + '</tbody></table></div>', "items") +
    '<div class="ins-grid" style="margin-top:16px">' + card("Ordered together", "Good pairs for a combo offer.",
      pairs ? '<table class="data-table compact"><tbody>' + pairs + '</tbody></table>' : '<p class="lede">No pair was ordered together twice yet.</p>') +
    card("Veg and non-veg", "Items sold.", diet) + '</div>';
}

function stores(d) {
  const rows = d.restaurants.map((r, i) => '<tr><td><div class="cell-title">' + (i + 1) + '. ' + h(r.name) + '</div><div class="cell-sub">' + h(r.kind) + (r.topItem ? ' · best: ' + h(r.topItem) : '') + '</div></td>' +
    '<td class="num">' + r.orders + '<div class="cell-sub">' + pct(r.sharePct) + '</div></td><td class="num">' + rupee(r.gmvPaise) + '</td><td class="num">' + rupee(r.aovPaise) + '</td>' +
    '<td class="num">' + r.customers + '</td><td class="num">' + r.repeatCustomers + '</td><td class="num">' + (r.avgDeliveryMinutes == null ? "—" : r.avgDeliveryMinutes + " min") + '</td>' +
    '<td class="num' + (r.cancelled ? ' danger-text' : '') + '">' + r.cancelled + ' (' + pct(r.cancelRatePct) + ')</td></tr>').join("");
  return card("Stores by orders", "", '<div class="table-wrap"><table class="data-table"><thead><tr><th>Store</th><th class="num">Orders</th><th class="num">Sales</th><th class="num">Avg order</th><th class="num">Customers</th><th class="num">Came back</th><th class="num">Delivery</th><th class="num">Cancelled</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="8">No orders in this period.</td></tr>') + '</tbody></table></div>', "stores");
}

function timing(d) {
  const g = d.timing.grid, max = Math.max(1, ...g.flat()), p = d.timing.peak;
  const grid = '<div class="heat"><span></span>' + [0, 3, 6, 9, 12, 15, 18, 21].map((x) => '<span class="hh">' + hourLabel(x) + '</span>').join("") +
    g.map((row, i) => '<span class="hd">' + DAYS[i] + '</span>' + row.map((n, hr) => '<span class="hc" title="' + DAYS[i] + ' ' + hourLabel(hr) + ': ' + n + ' orders" style="--a:' + (n / max).toFixed(2) + '"></span>').join("")).join("") + '</div>';
  const daily = d.daily || [], dmax = Math.max(1, ...daily.map((x) => x.orders));
  const spark = '<div class="spark">' + daily.map((x) => '<span title="' + h(x.day) + ': ' + x.orders + ' orders" style="height:' + Math.max(3, x.orders / dmax * 100).toFixed(0) + '%"></span>').join("") + '</div>' +
    '<div class="bar-top bar-sub" style="margin-top:6px"><span>' + h(daily[0] ? daily[0].day : "") + '</span><span>' + h(daily.length ? daily[daily.length - 1].day : "") + '</span></div>';
  const pay = d.payments.map((x) => bar(x.key === "cod" ? "Cash on delivery" : x.key === "upi" ? "UPI" : x.key === "card" ? "Card" : "Other", x.orders + " · " + pct(x.sharePct), x.sharePct)).join("");
  return '<div class="ins-grid wide">' + card("Busiest times", (p.orders ? "Busiest: <strong>" + DAYS[p.day] + " around " + hourLabel(p.hour) + "</strong> (" + p.orders + " orders). " : "") + "Darker means more orders. IST.", grid) +
    card("How they pay", "", pay || '<p class="lede">No orders.</p>') + '</div>' + card("Orders per day", "", spark);
}

function offers(d) {
  const rows = d.offers.map((o) => '<tr><td class="cell-title">' + h(o.code) + '</td><td class="num">' + o.orders + '</td><td class="num">' + rupee(o.discountPaise) + '</td><td class="num">' + rupee(o.gmvPaise) + '</td><td class="num">' + o.newCustomers + '</td></tr>').join("");
  const cancels = d.cancellations.map((c) => '<tr><td>' + h(c.reason) + '<div class="cell-sub">By ' + h(c.by === "unknown" ? "not recorded" : c.by) + '</div></td><td class="num">' + c.orders + '</td></tr>').join("");
  return '<div class="ins-grid">' + card("Offers used", "", '<table class="data-table compact"><thead><tr><th>Code</th><th class="num">Orders</th><th class="num">Discount</th><th class="num">Sales</th><th class="num">New customers</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="5">No offers used in this period.</td></tr>') + '</tbody></table>', "offers") +
    card("Why orders were cancelled", "", '<table class="data-table compact"><tbody>' + (cancels || '<tr><td>No cancellations in this period.</td></tr>') + '</tbody></table>') + '</div>';
}

function render() {
  const d = state.data;
  const root = document.getElementById("dashboard");
  if (!d) return;
  const tab = state.tab || "people";
  const tabs = [["people", "People"], ["places", "Places"], ["dishes", "Dishes"], ["stores", "Stores"], ["timing", "When"], ["offers", "Offers"]];
  root.innerHTML = summary(d) + '<div class="tabs">' + tabs.map((t) => '<div class="tab' + (t[0] === tab ? ' active' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</div>').join("") + '</div>' +
    ({people, places, dishes, stores, timing, offers}[tab] || people)(d) +
    '<p class="lede" style="text-align:center;margin-top:18px">Updated ' + new Date(d.generatedAt).toLocaleString("en-IN") + '</p>';
  root.hidden = false;
}

// ---------------------------------------------------------------------------
// loading, CSV, offers
// ---------------------------------------------------------------------------
async function load(fresh) {
  if (state.loading) return;
  state.loading = true;
  const errorBox = document.getElementById("load-error"), loadingBlock = document.getElementById("loading-block");
  errorBox.hidden = true;
  if (!state.data) loadingBlock.hidden = false;
  try {
    state.data = await callFunction("getAdminAnalytics", {days: state.days, kind: state.kind, fresh: !!fresh});
    render();
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = "Insights didn't load: " + (error.message || "try again.");
  } finally {
    state.loading = false;
    loadingBlock.hidden = true;
  }
}

function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }
function downloadCsv(name) {
  const d = state.data;
  if (!d) return;
  const tables = {
    items: [["Dish", "Store", "Sold", "Sales (₹)", "Customers", "Women qty", "Men qty", "Not shared qty"],
      ...d.items.map((i) => [i.name, i.restaurantName, i.quantity, i.revenuePaise / 100, i.customers, i.genders.female, i.genders.male, i.genders.unknown])],
    areas: [["Area", "Orders", "Share %", "Customers", "Avg order (₹)", "Avg delivery (min)", "Cancelled %", "Top dish", "Top group"],
      ...d.areas.map((a) => [a.name, a.orders, a.sharePct, a.customers, a.aovPaise / 100, a.avgDeliveryMinutes ?? "", a.cancelRatePct, a.topItem, a.topGroup])],
    stores: [["Store", "Type", "Orders", "Share %", "Sales (₹)", "Avg order (₹)", "Customers", "Came back", "Cancelled"],
      ...d.restaurants.map((r) => [r.name, r.kind, r.orders, r.sharePct, r.gmvPaise / 100, r.aovPaise / 100, r.customers, r.repeatCustomers, r.cancelled])],
    groups: [["Group", "Customers", "Orders", "Share %", "Gone quiet", "Top dish", "Top dish qty", "Lift"],
      ...d.groupPicks.map((g) => [g.label, g.customers, g.orders, g.sharePct, g.lapsedCustomers, g.items[0]?.name ?? "", g.items[0]?.quantity ?? "", g.items[0]?.lift ?? ""])],
    offers: [["Code", "Orders", "Discount (₹)", "Sales (₹)", "New customers"],
      ...d.offers.map((o) => [o.code, o.orders, o.discountPaise / 100, o.gmvPaise / 100, o.newCustomers])],
  };
  const rows = tables[name];
  if (!rows) return;
  const blob = new Blob(["﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n")], {type: "text/csv"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "scraveit-" + name + "-" + state.days + "d.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function offerDrawer(pre) {
  const a = pre.audience || {}, items = pre.itemIds || [], names = pre.itemNames || [];
  const chip = (name, value, label, on) => '<label class="chip"><input type="checkbox" name="' + name + '" value="' + value + '"' + (on ? ' checked' : '') + '>' + label + '</label>';
  return '<div class="overlay" data-close="1"><aside class="drawer" role="dialog" aria-label="New offer"><div class="drawer-head"><h2>New offer</h2><button class="btn btn-ghost" data-close="1">Close</button></div>' +
    '<form id="offer-form"><div class="drawer-body"><div class="form-grid">' +
    '<div class="field"><label for="f-code">Code</label><input id="f-code" class="input" name="code" required pattern="[A-Za-z0-9_-]{3,24}" value="' + h(pre.code || "") + '"></div>' +
    '<div class="field"><label for="f-title">Title</label><input id="f-title" class="input" name="title" required minlength="3" value="' + h(pre.title || "") + '"></div>' +
    '<div class="field"><label for="f-kind">Discount type</label><select id="f-kind" class="select" name="kind"><option value="percent">Percentage</option><option value="flat">Flat ₹</option></select></div>' +
    '<div class="field"><label for="f-amount">Discount (% or ₹)</label><input id="f-amount" class="input" name="amount" type="number" min="1" value="20"></div>' +
    '<div class="field"><label for="f-max">Maximum discount ₹</label><input id="f-max" class="input" name="max" type="number" min="0" value="100"></div>' +
    '<div class="field"><label for="f-min">Minimum order ₹</label><input id="f-min" class="input" name="min" type="number" min="0" value="0"></div>' +
    '<div class="field"><label for="f-funding">Who pays</label><select id="f-funding" class="select" name="funding"><option value="platform">Scraveit</option><option value="restaurant">The restaurant</option><option value="shared">Shared 50/50</option></select></div>' +
    '<div class="field"><label for="f-limit">Uses per customer</label><input id="f-limit" class="input" name="limit" type="number" min="0" value="2"></div>' +
    '<div class="field"><label for="f-budget">Scraveit budget ₹ (0 = no cap)</label><input id="f-budget" class="input" name="budget" type="number" min="0" value="0"></div>' +
    '<div class="field"><label for="f-ends">Ends</label><input id="f-ends" class="input" name="ends" type="date"></div>' +
    '<div class="field full"><label for="f-rids">Restaurant IDs</label><input id="f-rids" class="input" name="rids" value="' + h((pre.restaurantIds || []).join(", ")) + '" placeholder="Needed when a restaurant pays or for dish offers"></div>' +
    '</div><h3 class="section-title">Who it\'s for</h3><p class="lede">Leave unticked for all customers. Customers who didn\'t share their details never see group offers.</p>' +
    '<div class="field"><label>Gender</label><div class="chip-row aud-chips">' + chip("g", "female", "Women", (a.genders || []).includes("female")) + chip("g", "male", "Men", (a.genders || []).includes("male")) + chip("g", "other", "Other", (a.genders || []).includes("other")) + '</div></div>' +
    '<div class="field"><label>Age groups</label><div class="chip-row aud-chips">' + AGE_LIST.map((x) => chip("a", x, x, (a.ageBands || []).includes(x))).join("") + '</div></div>' +
    '<div class="field"><label for="f-areas">Delivery areas</label><input id="f-areas" class="input" name="areas" value="' + h((a.areaKeys || []).join(", ")) + '" placeholder="e.g. Magunta Layout"></div>' +
    '<div class="field" id="f-dishes"><label>Dishes</label>' + (items.length ? '<span>' + h(names.join(", ")) + '</span><input type="hidden" name="itemIds" value="' + h(items.join("|")) + '"><input type="hidden" name="itemNames" value="' + h(names.join("|")) + '"><button type="button" class="btn btn-ghost btn-sm" data-clear-dishes="1">Apply to the whole order instead</button>' : '<span class="hint">The whole order.</span>') + '</div>' +
    '<label class="checkbox-row"><input type="checkbox" name="active"> Active and visible to customers</label>' +
    '<label class="checkbox-row" style="margin-top:8px"><input type="checkbox" name="ack"> If the profit check is red, publish anyway (customers get only the safe part)</label>' +
    '<div id="offer-result" style="margin-top:14px"></div></div>' +
    '<div class="drawer-foot"><button type="button" class="btn btn-secondary" data-close="1">Cancel</button><button class="btn btn-primary" type="submit">Save offer</button></div></form></aside></div>';
}

function openOffer(pre) {
  const root = document.getElementById("drawer-root");
  root.innerHTML = offerDrawer(pre);
}

async function saveOffer(form) {
  const fd = new FormData(form), kind = fd.get("kind") === "flat" ? "flat" : "percent", amount = Number(fd.get("amount") || 0);
  const funding = String(fd.get("funding") || "platform"), split = (v) => String(v || "").split("|").map((x) => x.trim()).filter(Boolean);
  const ends = String(fd.get("ends") || "");
  const payload = {
    code: String(fd.get("code") || "").trim().toUpperCase(), title: String(fd.get("title") || "").trim(), description: "",
    kind, percent: kind === "percent" ? Math.round(amount) : 0, flatAmountPaise: kind === "flat" ? Math.round(amount * 100) : 0,
    maxDiscountPaise: Math.round(Number(fd.get("max") || 0) * 100), minimumOrderPaise: Math.round(Number(fd.get("min") || 0) * 100),
    fundingSource: funding, restaurantShareBps: funding === "shared" ? 5000 : funding === "restaurant" ? 10000 : 0,
    restaurantIds: String(fd.get("rids") || "").split(",").map((x) => x.trim()).filter(Boolean), cityKeys: ["nellore"],
    firstOrderOnly: false, perCustomerLimit: Math.round(Number(fd.get("limit") || 0)), budgetPaise: Math.round(Number(fd.get("budget") || 0) * 100),
    growthBudgetId: "", startsAt: 0, expiresAt: ends ? new Date(ends + "T23:59:59").getTime() : 0, active: fd.get("active") === "on",
    acknowledgeLimitedFunding: fd.get("ack") === "on",
    simulation: {averageOrderValuePaise: Math.max(100, (state.data && state.data.summary.aovPaise) || 30000), expectedOrders: 1000, redemptionShareBps: 5000},
    audience: {genders: fd.getAll("g").map(String), ageBands: fd.getAll("a").map(String),
      areaKeys: String(fd.get("areas") || "").split(",").map((x) => x.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean)},
    itemIds: split(fd.get("itemIds")), itemNames: split(fd.get("itemNames")),
  };
  const result = document.getElementById("offer-result");
  result.innerHTML = '<div class="loading-block" style="padding:8px 0"><span class="spinner dark"></span> Checking the numbers and saving…</div>';
  try {
    const saved = await callFunction("upsertPromotionPolicy", payload);
    const sim = saved && saved.simulation;
    result.innerHTML = '<div class="notice ' + (sim && sim.verdict === "unsafe" ? 'notice-warning' : 'notice-success') + '">Saved' + (payload.active ? ' and live' : ' (not active yet)') + '. ' + h(sim ? sim.message : "") + '</div>';
    toast("Offer saved.", "success");
  } catch (error) {
    result.innerHTML = '<div class="notice notice-danger">' + h(error.message || "Couldn't save the offer.") + '</div>';
  }
}

// ---------------------------------------------------------------------------
// events and boot
// ---------------------------------------------------------------------------
document.getElementById("dashboard").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) { state.tab = tab.dataset.tab; render(); return; }
  const csv = event.target.closest("[data-csv]");
  if (csv) { downloadCsv(csv.dataset.csv); return; }
  const offer = event.target.closest("[data-offer]");
  if (offer) {
    const ds = offer.dataset, split = (v) => String(v || "").split("|").filter(Boolean), names = split(ds.names);
    const code = ("FOR" + (ds.gender === "female" ? "HER" : ds.gender === "male" ? "HIM" : "") + String(ds.age || "").replace(/[^0-9]/g, "").slice(0, 2) +
      (names[0] || "").replace(/[^A-Za-z]/g, "").slice(0, 6) + String(ds.area || "").replace(/[^a-z]/g, "").slice(0, 6)).toUpperCase().slice(0, 16);
    openOffer({code: code.length >= 3 ? code : "FORYOU", title: names.length ? "Treat on " + names.slice(0, 2).join(" & ") : ds.label ? "Just for " + ds.label : "",
      restaurantIds: ds.rid ? [ds.rid] : [], itemIds: split(ds.items), itemNames: names,
      audience: {genders: ds.gender ? [ds.gender] : [], ageBands: ds.age ? [ds.age] : [], areaKeys: ds.area ? [ds.area] : []}});
  }
});
document.getElementById("drawer-root").addEventListener("click", (event) => {
  if (event.target.closest("[data-clear-dishes]")) {
    document.getElementById("f-dishes").innerHTML = '<label>Dishes</label><span class="hint">The whole order.</span>';
    return;
  }
  const close = event.target.closest("[data-close]");
  if (close && (close.tagName !== "DIV" || event.target === close)) document.getElementById("drawer-root").innerHTML = "";
});
document.getElementById("drawer-root").addEventListener("submit", (event) => {
  if (event.target.id !== "offer-form") return;
  event.preventDefault();
  saveOffer(event.target);
});
document.getElementById("days-select").addEventListener("change", (event) => { state.days = Number(event.target.value) || 30; load(false); });
document.getElementById("kind-select").addEventListener("change", (event) => { state.kind = event.target.value; load(false); });
document.getElementById("refresh-btn").addEventListener("click", () => load(true));
document.getElementById("offer-btn").addEventListener("click", () => openOffer({code: "", title: ""}));
document.getElementById("signout-btn").addEventListener("click", () => signOutUser());

requireAdminSession().then((sessionState) => {
  if (!sessionState) return;
  document.getElementById("app-shell").hidden = false;
  document.getElementById("sidebar-who").textContent = sessionState.user.email + " · " + sessionState.claims.savrivoRole;
  load(false);
});

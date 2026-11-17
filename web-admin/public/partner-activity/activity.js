import {requireAdminSession, signOutUser, callFunction} from "../assets/firebase-client.js?v=5";

// Pre-launch watching of delivery partners who agreed (partnerActivity callable, owner / ops admin).

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const hm = (minute) => minute == null ? "—" : String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
const dur = (m) => m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m + " min";
const KIND = {restaurant: "Restaurant", drop: "Drop", idle: "Idle", stop: "Short stop"};
let selected = "", partners = [];

function toast(message, kind) {
  const node = document.createElement("div");
  node.className = "toast " + (kind || "");
  node.textContent = message;
  document.getElementById("toast-stack").appendChild(node);
  setTimeout(() => node.remove(), 4200);
}
function todayIst() { return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); }

async function loadPartners() {
  const box = document.getElementById("partners");
  try {
    const data = await callFunction("partnerActivity", {action: "list"});
    partners = data.partners || [];
    if (!partners.length) { box.innerHTML = '<p class="note">No approved delivery partners yet. Approve them in Rider review first.</p>'; return; }
    box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Delivery partner</th><th>City</th><th>Now</th><th>Watched</th><th></th></tr></thead><tbody>' +
      partners.map((p) => "<tr><td><strong>" + h(p.name) + '</strong><div class="note">' + (p.phone ? "••" + h(p.phone) : "") + "</div></td><td>" + h(p.city) + "</td>" +
        "<td>" + (p.watched ? '<span class="dot' + (p.onlineNow ? " on" : "") + '"></span>' + (p.onlineNow ? "Online" : "Offline") + (p.recordingToday ? " · recorded today" : "") : "—") + "</td>" +
        "<td>" + (p.watched ? "Since " + new Date(p.since).toLocaleDateString("en-IN") + (p.note ? '<div class="note">' + h(p.note) + "</div>" : "") : "No") + "</td>" +
        '<td style="white-space:nowrap">' + (p.watched ? '<button class="btn btn-primary btn-sm" data-view="' + h(p.riderId) + '">View day</button> <button class="btn btn-secondary btn-sm" data-stop="' + h(p.riderId) + '">Stop</button> <button class="btn btn-ghost btn-sm" data-forget="' + h(p.riderId) + '">Delete history</button>'
          : '<button class="btn btn-secondary btn-sm" data-watch="' + h(p.riderId) + '">Start watching</button>') + "</td></tr>").join("") + "</tbody></table></div>";
  } catch (error) { box.textContent = error.message; }
}

async function watch(riderId, on) {
  const p = partners.find((x) => x.riderId === riderId); if (!p) return;
  let note = "";
  if (on) {
    if (!confirm("Has " + p.name + " agreed in writing to location recording while online (positions deleted after 60 days; daily totals kept)?")) return;
    note = prompt("How did they agree? (for the record)", "WhatsApp yes, " + new Date().toLocaleDateString("en-IN")) || "";
  } else if (!confirm("Stop recording " + p.name + "? Their positions stay until they are 60 days old and their daily totals stay, until you delete them.")) return;
  try { await callFunction("partnerActivity", {action: "watch", riderId, on, note}); toast(on ? "Watching " + p.name + "." : "Stopped.", "success"); }
  catch (error) { toast(error.message, "danger"); }
  loadPartners();
}
async function forget(riderId) {
  const p = partners.find((x) => x.riderId === riderId); if (!p) return;
  if (!confirm("Delete all recorded history for " + p.name + ", including the daily totals? This can't be undone.")) return;
  try { const r = await callFunction("partnerActivity", {action: "forget", riderId}); toast("Deleted " + r.deletedDays + " day(s).", "success"); }
  catch (error) { toast(error.message, "danger"); }
  if (selected === riderId) { loadDay(); loadHistory(); }
}

// ----- past days: one saved line per day, kept with no time limit -----
async function loadHistory() {
  const box = document.getElementById("history"); if (!box || !selected) return;
  box.innerHTML = '<p class="note">Loading&hellip;</p>';
  try {
    const {days} = await callFunction("partnerActivity", {action: "history", riderId: selected});
    const m = (v) => v == null ? "—" : dur(v);
    box.innerHTML = days.length ? '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Online</th><th>Hours</th><th>Trips</th><th>Avg wait</th><th>Avg ride</th><th>Idle</th><th>Gaps</th></tr></thead><tbody>' +
      days.map((d) => '<tr><td><a href="#" data-date="' + h(d.date) + '">' + h(new Date(d.date + "T00:00:00").toLocaleDateString("en-IN", {weekday: "short", day: "numeric", month: "short"})) + "</a>" + (d.live ? ' <span class="note">today, so far</span>' : "") + "</td><td>" + m(d.onlineMinutes) + "</td><td>" + hm(d.firstSeen) + " – " + hm(d.lastSeen) + "</td><td>" + h(d.trips) + "</td><td>" + m(d.avgWaitMinutes) + "</td><td>" + m(d.avgRideMinutes) + "</td><td>" + m(d.idleMinutes) + "</td><td>" + h(d.gaps) + "</td></tr>").join("") + "</tbody></table></div>"
      : '<p class="note">No days yet. Each finished day is saved here at 3 AM.</p>';
  } catch (error) { box.textContent = error.message; }
}

// ----- the day -----
const worldPx = (lat, lng, z) => { const sc = 256 * 2 ** z, sn = Math.sin(lat * Math.PI / 180); return {x: (lng + 180) / 360 * sc, y: (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * sc}; };
function drawMap(path, stops) {
  const box = document.getElementById("map"), w = box.clientWidth || 700, ht = box.clientHeight || 340;
  const pts = path.map((p) => ({lat: p[1], lng: p[2]})).concat(stops.filter((s) => s.lat != null).map((s) => ({lat: s.lat, lng: s.lng})));
  if (!pts.length) { box.innerHTML = '<p class="note" style="padding:14px">No positions recorded for this day.</p>'; return; }
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng), c = {lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2};
  let z = 17;
  while (z > 5) { const a = worldPx(Math.max(...lats), Math.min(...lngs), z), b = worldPx(Math.min(...lats), Math.max(...lngs), z); if (b.x - a.x < w - 60 && b.y - a.y < ht - 60) break; z--; }
  const cw = worldPx(c.lat, c.lng, z), left = cw.x - w / 2, top = cw.y - ht / 2, n = 2 ** z, xy = (lat, lng) => { const p = worldPx(lat, lng, z); return [p.x - left, p.y - top]; };
  let tiles = "";
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + w) / 256); tx++) for (let ty = Math.floor(top / 256); ty <= Math.floor((top + ht) / 256); ty++) {
    tiles += '<img alt="" src="https://savrivo-app.web.app/maptile/day/' + z + "/" + (((tx % n) + n) % n) + "/" + ty + '" style="left:' + (tx * 256 - left) + "px;top:" + (ty * 256 - top) + 'px">';
  }
  const line = path.map((p) => xy(p[1], p[2]).map((v) => v.toFixed(1)).join(",")).join(" ");
  const color = {restaurant: "#d97706", idle: "#dc2626", stop: "#64748b"};
  const dots = stops.filter((s) => s.lat != null).map((s) => { const [x, y] = xy(s.lat, s.lng); return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + Math.min(14, 5 + s.minutes / 4) + '" fill="' + (color[s.kind] || "#64748b") + '" fill-opacity=".75" stroke="#fff" stroke-width="2"><title>' + h(KIND[s.kind] + " " + hm(s.start) + " · " + dur(s.minutes) + (s.place ? " · " + s.place : "")) + "</title></circle>"; }).join("");
  // The latest recorded position: a big pin so it's easy to find.
  const last = path[path.length - 1];
  let now = "";
  if (last) {
    const [x, y] = xy(last[1], last[2]);
    now = '<g transform="translate(' + x.toFixed(1) + "," + y.toFixed(1) + ')"><circle r="22" fill="#dc2626" fill-opacity=".18"/><path d="M0 0 C-4 -9 -12 -14 -12 -22 A12 12 0 1 1 12 -22 C12 -14 4 -9 0 0Z" fill="#dc2626" stroke="#fff" stroke-width="2.5"/><circle cy="-22" r="4.5" fill="#fff"/>' +
      '<rect x="16" y="-40" rx="6" width="86" height="22" fill="#111827"/><text x="59" y="-25" fill="#fff" font-size="12" font-weight="700" text-anchor="middle">Here ' + hm(last[0]) + "</text></g>";
  }
  box.innerHTML = tiles + '<svg viewBox="0 0 ' + w + " " + ht + '"><polyline points="' + line + '" fill="none" stroke="#1460f0" stroke-width="4" stroke-opacity=".8" stroke-linejoin="round"/>' + dots + now + "</svg>";
  const where = document.getElementById("last-seen");
  if (where) where.innerHTML = last ? 'Last position at <strong>' + hm(last[0]) + '</strong> · <a href="https://www.google.com/maps?q=' + last[1].toFixed(5) + "," + last[2].toFixed(5) + '" target="_blank" rel="noopener">Open in Google Maps</a>' : "";
}
async function loadDay() {
  const p = partners.find((x) => x.riderId === selected); if (!p) return;
  const card = document.getElementById("day-card"), date = document.getElementById("day-date").value || todayIst();
  card.hidden = false; document.getElementById("day-title").textContent = p.name;
  document.getElementById("stats").innerHTML = '<div class="note">Loading&hellip;</div>';
  try {
    let d = await callFunction("partnerActivity", {action: "day", riderId: selected, date});
    // Older than 60 days: only the saved totals are left (no map, trips or stops).
    if (d.summaryOnly) {
      const sm = d.summary || {};
      d = {...d, ...sm, trips: [], stops: [], path: [], offlineGaps: Array(sm.gaps || 0).fill({}), tripCount: sm.trips, avgW: sm.avgWaitMinutes, avgR: sm.avgRideMinutes};
    }
    const avg = (k) => d.summaryOnly ? ((k === "waitMinutes" ? d.avgW : d.avgR) == null ? "—" : (k === "waitMinutes" ? d.avgW : d.avgR) + " min") : d.trips.length ? Math.round(d.trips.reduce((s, t) => s + t[k], 0) / d.trips.length) + " min" : "—";
    const stat = (label, value, sub) => '<div class="stat-card"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + (sub || "") + "</div></div>";
    document.getElementById("stats").innerHTML =
      stat("Online", dur(d.onlineMinutes), d.firstSeen == null ? "Nothing recorded" : hm(d.firstSeen) + " – " + hm(d.lastSeen)) +
      stat("Trips (likely)", d.summaryOnly ? d.tripCount : d.trips.length, "restaurant → drop") +
      stat("Restaurant wait", dur(d.restaurantWaitMinutes), "avg " + avg("waitMinutes") + " per trip") +
      stat("Ride to drop", avg("rideMinutes"), "average") +
      stat("Moving", dur(d.movingMinutes), "") +
      stat("Idle", dur(d.idleMinutes), "stops of 10+ min") +
      stat("Other stops", dur(d.otherStopMinutes + d.dropMinutes), "incl. drops " + dur(d.dropMinutes)) +
      stat("Gaps", d.offlineGaps.length, "app off or no signal");
    if (d.summaryOnly) {
      document.getElementById("map").innerHTML = '<p class="note" style="padding:14px">Over 60 days old: positions were deleted, only the day\'s totals are kept.</p>';
      document.getElementById("last-seen").innerHTML = ""; document.getElementById("trips").innerHTML = ""; document.getElementById("stops").innerHTML = "";
      return;
    }
    drawMap(d.path || [], d.stops || []);
    document.getElementById("trips").innerHTML = d.trips.length ? '<div class="table-wrap"><table><thead><tr><th>Pickup at</th><th>Restaurant</th><th>Wait</th><th>Ride</th><th>At drop</th></tr></thead><tbody>' +
      d.trips.map((t) => "<tr><td>" + hm(t.pickupAt) + "</td><td>" + h(t.place || "Repeat spot") + "</td><td>" + dur(t.waitMinutes) + "</td><td>" + dur(t.rideMinutes) + "</td><td>" + dur(t.dropMinutes) + "</td></tr>").join("") + "</tbody></table></div>" : '<p class="note">No trips found yet.</p>';
    document.getElementById("stops").innerHTML = d.stops.length ? '<div class="table-wrap"><table><thead><tr><th>From</th><th>To</th><th>Length</th><th>What</th><th>Where</th></tr></thead><tbody>' +
      d.stops.map((s) => "<tr><td>" + hm(s.start) + "</td><td>" + hm(s.end) + "</td><td>" + dur(s.minutes) + '</td><td class="k-' + s.kind + '">' + KIND[s.kind] + (s.scraveitOrder ? " · Scraveit order" : "") + "</td><td>" +
        (s.lat == null ? '<span class="note">hidden (customer door)</span>' : (s.place ? h(s.place) + " · " : "") + '<a href="https://www.google.com/maps?q=' + s.lat.toFixed(5) + "," + s.lng.toFixed(5) + '" target="_blank" rel="noopener">map</a>') + "</td></tr>").join("") + "</tbody></table></div>" : '<p class="note">No stops yet.</p>';
  } catch (error) { document.getElementById("stats").textContent = error.message; }
}

const session = await requireAdminSession();
if (session) {
  document.getElementById("app-shell").hidden = false;
  const who = document.getElementById("sidebar-who");
  if (who && session.user) who.textContent = session.user.email || "";
  document.getElementById("signout-btn").addEventListener("click", async () => { await signOutUser(); window.location.replace("../"); });
  document.getElementById("day-date").value = todayIst();
  document.getElementById("day-date").addEventListener("change", loadDay);
  document.getElementById("day-reload").addEventListener("click", loadDay);
  document.getElementById("partners").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.view) { selected = b.dataset.view; loadDay(); loadHistory(); document.getElementById("day-card").scrollIntoView({behavior: "smooth"}); }
    if (b.dataset.watch) watch(b.dataset.watch, true);
    if (b.dataset.stop) watch(b.dataset.stop, false);
    if (b.dataset.forget) forget(b.dataset.forget);
  });
  document.getElementById("history").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-date]"); if (!a) return;
    e.preventDefault(); document.getElementById("day-date").value = a.dataset.date; loadDay();
    document.getElementById("day-card").scrollIntoView({behavior: "smooth"});
  });
  loadPartners();
  // Today's view follows the partner: refresh once a minute (the recorder also saves once a minute).
  setInterval(() => { if (selected && document.getElementById("day-date").value === todayIst() && !document.hidden) loadDay(); }, 60000);
}

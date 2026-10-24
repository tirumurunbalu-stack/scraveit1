import {requireAdminSession, signOutUser, callFunction, listRiders, readRider, updateRider, writeAudit} from "../assets/firebase-client.js?v=6";

// Rider review queue: the delivery-partner applications the Admin app reviews,
// with the same identity checks (Aadhaar Secure QR, face match, one account per
// person, PAN), the same secure 5-minute photo view, the same Income Tax portal
// PAN check, and the same approve / request-changes decision on the rider record.

const PAN_PORTAL_URL = "https://eportal.incometax.gov.in/iec/foservices/#/pre-login/verifyYourPAN";
const DL_PORTAL_URL = "https://parivahan.gov.in/rcdlstatus/?pur_cd=101";
const TABS = [
  ["waiting", "Waiting for review", ["submitted"]],
  ["approved", "Approved", ["approved"]],
  ["rejected", "Changes requested", ["rejected"]],
];
const state = {tab: "waiting", riders: [], query: "", role: "", email: "", openId: "", details: {}};

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------
function h(value) {
  return String(value == null ? "" : value).replace(/[&<>'"]/g, (c) => (
    {"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"}[c]
  ));
}
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function toast(message, kind) {
  const stack = document.getElementById("toast-stack");
  const node = el('<div class="toast ' + (kind || "") + '">' + h(message) + "</div>");
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}
function when(t) {
  return t ? new Date(Number(t)).toLocaleDateString("en-IN", {day: "numeric", month: "short", year: "numeric"}) : "—";
}
function portalDob(dob) {
  const m = String(dob || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[3] + "/" + m[2] + "/" + m[1];
  const d = String(dob || "").match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  return d ? d[1] + "/" + d[2] + "/" + d[3] : String(dob || "");
}
function isOwner() { return state.role === "owner"; }
function identityOf(r) { return r && r.identity && typeof r.identity === "object" ? r.identity : null; }
function appliedAt(r) { return Number(r.submittedAt || r.createdAt || r.updatedAt || 0); }

// ---------------------------------------------------------------------------
// identity, worded exactly as in the Admin app
// ---------------------------------------------------------------------------
function panRegistryText(reg) {
  if (!reg) return "not checked on the Income Tax portal yet";
  const date = reg.checkedAt ? " (" + new Date(reg.checkedAt).toLocaleDateString("en-IN") + ")" : "";
  return (reg.result === "active_match" ? "active and matching on the Income Tax portal"
    : reg.result === "mismatch" ? "name or date of birth doesn’t match on the portal"
      : "not active on the Income Tax portal") + date;
}
function identityBadge(r) {
  const x = identityOf(r);
  if (!x) return '<span class="badge badge-neutral">Waiting for rider</span>';
  if (x.status === "verified") return '<span class="badge badge-success">ID verified</span>';
  if (x.status === "review") {
    const n = (x.reasons || []).length;
    return '<span class="badge badge-warning">' + n + " to check</span>";
  }
  return '<span class="badge badge-neutral">' + (r.identityFallback === "manual" ? "Manual Aadhaar" : "Aadhaar pending") + "</span>";
}
function checkRow(ok, label, detail) {
  const cls = ok === true ? "ok" : ok === false ? "bad" : "wait", mark = ok === true ? "✓" : ok === false ? "!" : "…";
  return '<div class="id-check ' + cls + '"><span class="id-mark">' + mark + '</span><div><strong>' + h(label) + '</strong><span>' + h(detail) + "</span></div></div>";
}
function identityMarkup(r) {
  const x = identityOf(r) || {}, a = x.aadhaar, face = x.face || {}, pan = x.pan;
  const head = x.status === "verified"
    ? '<div class="id-summary ok"><strong>All identity checks passed</strong><span>Safe to approve.</span></div>'
    : x.status === "review"
      ? '<div class="id-summary warn"><strong>' + (x.reasons || []).length + " thing" + ((x.reasons || []).length === 1 ? "" : "s") + ' to check</strong><span>' + h((x.reasons || []).join(" · ")) + "</span></div>"
      : '<div class="id-summary wait"><strong>Waiting for the rider</strong><span>' + h(r.identityFallback === "manual" ? "The rider uploaded a masked Aadhaar for manual review." : "Aadhaar not verified yet.") + "</span></div>";
  const panOk = pan ? (!(pan.formatOk && pan.individual && pan.nameInitialMatch !== false && !pan.duplicateOf) || (pan.registry && pan.registry.result !== "active_match") ? false : pan.registry ? true : null) : false;
  return head
    + checkRow(a ? true : r.identityFallback === "manual" ? null : false, "Aadhaar", a ? "Verified with UIDAI’s digital signature · " + a.name + " · •••• " + a.last4 + (a.birthYear ? " · born " + a.birthYear : "") : r.identityFallback === "manual" ? "Manual upload: compare the masked copy by eye" : "Not verified")
    + checkRow(face.status === "match" ? true : face.status === "pending" || !face.status ? null : false, "Face matches Aadhaar photo", face.status === "pending" || !face.status ? "Waiting for both photos" : face.similarity + "% similar" + (face.status === "match" ? "" : " (open the photos to compare)"))
    + checkRow(x.duplicateAadhaarOf ? false : a ? true : null, "One account per person", x.duplicateAadhaarOf ? "This Aadhaar is on another rider account" : r.faceMatchStatus === "needs_review" ? "Face looks like another rider: resolve it in the Admin app" : "No other account found")
    + checkRow(panOk, "PAN", pan ? (r.panNumber || "") + (pan.nameInitialMatch === false ? " · 5th letter doesn’t match the name" : pan.nameInitialMatch ? " · matches the name" : "") + (pan.duplicateOf ? " · used by another rider" : "") + " · " + panRegistryText(pan.registry) : "Not given")
    + licenceRow(x);
}
function licenceRow(x) {
  const l = x.licence;
  if (!l) return "";
  if (!l.required) return checkRow(true, "Driving licence", "Not needed for a bicycle");
  const bad = !l.number || !l.formatOk || !l.validTill || l.expired;
  return checkRow(!bad, "Driving licence", !l.number ? "Not given" : l.number + (l.formatOk ? "" : " · number looks wrong") + " · "
    + (!l.validTill ? "no valid-till date" : l.expired ? "expired " + portalDob(l.validTill) : "valid till " + portalDob(l.validTill)) + ". Check it on Parivahan in Open photos and details.");
}

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------
function tabRiders(key) {
  const statuses = (TABS.find((t) => t[0] === key) || TABS[0])[2];
  return state.riders.filter((r) => statuses.includes(r.status));
}
function matches(r) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [r.fullName, r.phone, r.city, r.email, r.panNumber, r.vehicleNumber].some((v) => String(v || "").toLowerCase().includes(q));
}
function renderStats() {
  const waiting = tabRiders("waiting"), ready = waiting.filter((r) => (identityOf(r) || {}).status === "verified");
  const toCheck = waiting.filter((r) => (identityOf(r) || {}).status === "review"), noId = waiting.length - ready.length - toCheck.length;
  const card = (label, value, sub) => '<div class="stat-card"><div class="label">' + h(label) + '</div><div class="value">' + h(value) + '</div><div class="sub">' + h(sub) + "</div></div>";
  document.getElementById("stat-grid").innerHTML = card("Waiting", waiting.length, "applications to decide")
    + card("Ready to approve", ready.length, "every identity check passed") + card("Need a check", toCheck.length, "open them to see what")
    + card("Waiting for rider", noId, "Aadhaar not verified yet");
}
function renderTabs() {
  document.getElementById("tabs").innerHTML = TABS.map(([key, label]) => '<button class="tab' + (state.tab === key ? " active" : "") + '" data-tab="' + key + '">' + h(label) + ' <span class="count">' + tabRiders(key).length + "</span></button>").join("");
}
function renderRows() {
  const list = tabRiders(state.tab).filter(matches).sort((a, b) => state.tab === "waiting" ? appliedAt(a) - appliedAt(b) : appliedAt(b) - appliedAt(a));
  document.getElementById("rider-rows").innerHTML = list.map((r) => '<tr><td><strong>' + h(r.fullName || "Partner") + '</strong><div class="muted">' + h(r.email || "") + "</div></td><td>" + h(r.phone || "—") + "</td><td>" + h(r.city || "—") + "</td><td>" + h(when(appliedAt(r))) + "</td><td>" + identityBadge(r) + '</td><td style="text-align:right;"><button class="btn btn-tonal btn-sm" data-review="' + h(r.id) + '">Review</button></td></tr>').join("");
  const empty = document.getElementById("table-empty");
  empty.hidden = list.length > 0;
  document.getElementById("table-empty-text").textContent = state.query ? "No applications match your search." : state.tab === "waiting" ? "No applications are waiting. Nice." : "Nothing here yet.";
}
function renderAll() { renderStats(); renderTabs(); renderRows(); if (state.openId) renderDrawer(); }

async function loadQueue(showSpinner) {
  const loading = document.getElementById("loading-block"), errorBox = document.getElementById("load-error");
  if (showSpinner) loading.hidden = false;
  errorBox.hidden = true;
  try {
    state.riders = await listRiders(["submitted", "approved", "rejected"], 500);
    document.getElementById("dashboard").hidden = false;
    renderAll();
  } catch (error) {
    errorBox.textContent = "Couldn’t load applications. " + (error && error.message ? error.message : "Try again.");
    errorBox.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// review drawer
// ---------------------------------------------------------------------------
function rider(id) { return state.riders.find((r) => r.id === id) || null; }
function copyBtn(text) { return text ? '<button type="button" class="btn btn-ghost btn-sm" data-copy="' + h(text) + '">Copy</button>' : ""; }
function panCard(id, pan, a) {
  if (!pan || !pan.number) return '<div class="notice notice-warning">The rider hasn’t given a PAN yet.</div>';
  const reg = pan.registry, dob = a ? portalDob(a.dob) : "", name = a ? a.name : "";
  return '<section class="pan-card"><strong>Check the PAN on the Income Tax portal</strong>'
    + '<p class="muted">Open Verify Your PAN, type these exactly, and use your own mobile number for the OTP. If the name doesn’t match, try the name exactly as printed on the PAN card photo.</p>'
    + '<div class="id-facts"><div><span>PAN</span><strong class="mono">' + h(pan.number) + "</strong>" + copyBtn(pan.number) + "</div><div><span>Full name (Aadhaar)</span><strong>" + h(name || "—") + "</strong>" + copyBtn(name) + "</div>"
    + "<div><span>Date of birth</span><strong>" + h(dob || "—") + "</strong>" + copyBtn(dob) + "</div><div><span>Last check</span><strong>" + h(reg ? panRegistryText(reg) : "Not checked yet") + "</strong></div></div>"
    + '<a class="btn btn-primary" href="' + PAN_PORTAL_URL + '" target="_blank" rel="noopener noreferrer">Open Verify Your PAN</a>'
    + '<p class="muted">What did the portal say?</p><div class="pan-results">'
    + [["active_match", "Active, details match", "btn-primary"], ["mismatch", "Details don’t match", "btn-secondary"], ["inactive", "Not active or not found", "btn-danger"]]
      .map(([v, t, k]) => '<button type="button" class="btn ' + k + '" data-pan-result="' + v + '" data-rider-id="' + h(id) + '"' + (reg && reg.result === v ? ' aria-pressed="true"' : "") + ">" + h(t) + "</button>").join("")
    + "</div></section>";
}
function licenceCard(l, a, img, p) {
  if (!l) return "";
  if (!l.required) return '<p class="muted">Bicycle: no driving licence needed.</p>';
  const dob = a ? portalDob(a.dob) : "";
  return '<section class="pan-card"><strong>Check the driving licence on Parivahan</strong>'
    + '<p class="muted">Open DL status, type the licence number and date of birth, and check the name, “valid till” date and the vehicle class (MCWG or MCWOG for a two-wheeler).</p>'
    + '<div class="id-facts"><div><span>Licence number</span><strong class="mono">' + h(l.number || "—") + "</strong>" + copyBtn(l.number) + "</div><div><span>Date of birth</span><strong>" + h(dob || "—") + "</strong>" + copyBtn(dob) + "</div>"
    + "<div><span>Valid till</span><strong>" + h(l.validTill ? portalDob(l.validTill) : "—") + (l.expired ? " · expired" : "") + "</strong></div><div><span>Vehicle</span><strong>" + h([l.vehicleType, l.vehicleNumber].filter(Boolean).join(" · ") || "—") + "</strong></div></div>"
    + '<div class="id-photos">' + img(p.dlFront, "Driving licence, front") + img(p.dlBack, "Driving licence, back") + "</div>"
    + '<a class="btn btn-secondary" href="' + DL_PORTAL_URL + '" target="_blank" rel="noopener noreferrer">Open DL status on Parivahan</a></section>';
}
function detailsMarkup(id) {
  const d = state.details[id];
  if (!d) return '<button class="btn btn-secondary" data-open-details="' + h(id) + '" style="width:100%;">Open photos and details</button>';
  if (d.loading) return '<div class="loading-block"><span class="spinner dark"></span> Opening a secure, 5-minute view…</div>';
  if (d.error) return '<div class="notice notice-danger">' + h(d.error) + '</div><button class="btn btn-secondary" data-open-details="' + h(id) + '">Try again</button>';
  const p = d.photos || {}, a = d.aadhaar;
  const img = (src, label) => src ? '<figure class="id-photo"><img src="' + h(src) + '" alt="' + h(label) + '"><figcaption>' + h(label) + "</figcaption></figure>"
    : '<figure class="id-photo empty"><div>—</div><figcaption>' + h(label) + " · none</figcaption></figure>";
  return panCard(id, d.pan, a)
    + '<div class="id-photos">' + img(p.aadhaarPhoto, "Photo in Aadhaar QR") + img(p.face, "Live face scan") + img(p.panCopy, "PAN card")
    + (p.aadhaarFront ? img(p.aadhaarFront, "Masked Aadhaar, front") : "") + (p.aadhaarBack ? img(p.aadhaarBack, "Masked Aadhaar, back") : "") + "</div>"
    + (p.aadhaarFront || p.aadhaarBack ? '<p class="muted">If any Aadhaar copy shows all 12 digits, reject it and ask for a masked copy or the QR.</p>' : "")
    + (a ? '<div class="id-facts"><div><span>Name on Aadhaar</span><strong>' + h(a.name) + "</strong></div><div><span>Matches application</span><strong>" + (a.nameMatchesApplication ? "Yes" : "No: compare") + "</strong></div>"
      + "<div><span>Date of birth</span><strong>" + h(portalDob(a.dob)) + "</strong></div><div><span>Gender</span><strong>" + h(a.gender) + "</strong></div>"
      + "<div><span>District, state</span><strong>" + h([a.district, a.state].filter(Boolean).join(", ")) + "</strong></div><div><span>PIN code</span><strong>" + h(a.pincode || "") + "</strong></div></div>" : "")
    + licenceCard(d.licence, a, img, p)
    + '<p class="muted">Links expire in 5 minutes and every view is logged. Don’t screenshot or share.</p>';
}
function renderDrawer() {
  const r = rider(state.openId), root = document.getElementById("drawer-root");
  if (!r) { root.innerHTML = ""; state.openId = ""; return; }
  const scroll = root.querySelector(".drawer") ? root.querySelector(".drawer").scrollTop : 0;
  const statusBadge = r.status === "approved" ? "badge-success" : r.status === "rejected" ? "badge-danger" : "badge-warning";
  const decide = isOwner()
    ? (r.status !== "approved" ? '<button class="btn btn-primary" data-approve="' + h(r.id) + '">Approve partner</button>' : "") + '<button class="btn btn-danger" data-reject-open="' + h(r.id) + '">Request changes</button>'
    : '<span class="muted">Only the owner can approve or request changes.</span>';
  root.innerHTML = '<div class="overlay" id="drawer-overlay"><aside class="drawer" role="dialog" aria-label="Review ' + h(r.fullName || "partner") + '">'
    + '<div class="drawer-head"><div><h2 style="font-size:16px;">' + h(r.fullName || "Partner application") + '</h2><div class="muted">' + h(r.email || "") + ' · <span class="badge ' + statusBadge + '">' + h(r.status || "submitted") + '</span></div></div><button class="btn btn-ghost" id="drawer-close" aria-label="Close">✕</button></div>'
    + '<div class="drawer-body">'
    + '<section class="rv-section"><h3>Contact</h3><div class="rv-rows"><div><span>Name</span><strong>' + h(r.fullName || "—") + '</strong></div><div><span>Mobile</span><strong>' + h(r.phone || "—") + '</strong></div><div><span>City</span><strong>' + h(r.city || "—") + '</strong></div><div><span>Applied</span><strong>' + h(when(appliedAt(r))) + "</strong></div></div></section>"
    + '<section class="rv-section"><h3>Vehicle</h3><div class="rv-rows"><div><span>Type</span><strong>' + h(r.vehicleType || "—") + '</strong></div><div><span>Registration</span><strong>' + h(r.vehicleNumber || "—") + "</strong></div>"
      + (r.dlNumber ? "<div><span>Driving licence</span><strong>" + h(r.dlNumber) + "</strong></div><div><span>Licence valid till</span><strong>" + h(r.dlValidTill ? portalDob(r.dlValidTill) : "—") + "</strong></div>" : "") + "</div>" + (r.address ? '<p class="muted">' + h(r.address) + "</p>" : "") + "</section>"
    + '<section class="rv-section"><h3>Identity</h3>' + identityMarkup(r) + '<div class="rv-details">' + detailsMarkup(r.id) + "</div></section>"
    + (r.reviewNote && r.status === "rejected" ? '<div class="notice notice-warning"><span><strong>Changes asked:</strong> ' + h(r.reviewNote) + "</span></div>" : "")
    + '<div id="reject-box" hidden><div class="field"><label for="reject-note">What must the rider fix?</label><textarea class="textarea" id="reject-note" placeholder="For example: the PAN card photo is blurred. Upload a clear photo of the front."></textarea><span class="hint">At least 10 characters. The rider sees this.</span></div><button class="btn btn-danger" data-reject-send="' + h(r.id) + '">Send back to the rider</button></div>'
    + "</div>"
    + '<div class="drawer-foot">' + decide + "</div></aside></div>";
  const drawer = root.querySelector(".drawer");
  if (drawer) drawer.scrollTop = scroll;
}
function openRider(id) { state.openId = id; renderDrawer(); }
function closeDrawer() { state.openId = ""; document.getElementById("drawer-root").innerHTML = ""; }

async function openDetails(id) {
  state.details[id] = {loading: true};
  renderDrawer();
  try {
    const d = await callFunction("getRiderIdentityReviewCall", {riderUid: id});
    state.details[id] = d || {};
    // The photo links last 5 minutes; after that, open again.
    setTimeout(() => { if (state.details[id] === d) { delete state.details[id]; if (state.openId === id) renderDrawer(); } }, 5 * 60_000);
    if (d && d.summary) { const r = rider(id); if (r) r.identity = d.summary; }
  } catch (error) {
    state.details[id] = {error: (error && error.message) || "The secure view didn’t open. Try again."};
  }
  renderAll();
}
async function recordPan(id, result, button) {
  button.disabled = true;
  try {
    const res = await callFunction("recordRiderPanCheck", {riderUid: id, result});
    const r = rider(id);
    if (r && res && res.summary) r.identity = res.summary;
    const d = state.details[id];
    if (d && d.pan && res && res.summary && res.summary.pan) d.pan.registry = res.summary.pan.registry;
    toast(result === "active_match" ? "PAN marked as checked." : "Saved. The rider stays in review until it’s fixed.", "success");
    renderAll();
  } catch (error) {
    toast((error && error.message) || "Couldn’t save the PAN check.", "danger");
    button.disabled = false;
  }
}
async function approve(id) {
  const r = rider(id), x = identityOf(r);
  if (!r || !isOwner()) return;
  if (!x || x.status !== "verified") {
    const why = x && x.reasons && x.reasons.length ? "Open identity items: " + x.reasons.join(" · ") : "Identity isn’t verified yet.";
    if (!window.confirm("Approve anyway?\n\n" + why)) return;
  }
  const now = Date.now(), changes = {status: "approved", approvedAt: now, reviewedAt: now, reviewedBy: state.email, documentsVerified: true, updatedAt: now};
  try {
    await updateRider(id, changes);
    Object.assign(r, changes);
    await writeAudit("rider.approve", id, r.fullName || r.email || "");
    toast("Partner approved for delivery assignments.", "success");
    closeDrawer();
    renderAll();
  } catch (error) {
    toast("Approval failed. " + ((error && error.message) || ""), "danger");
  }
}
async function reject(id) {
  const r = rider(id), note = String((document.getElementById("reject-note") || {}).value || "").trim();
  if (!r || !isOwner()) return;
  if (note.length < 10) { toast("Add a clear note for the rider (at least 10 characters).", "danger"); return; }
  const now = Date.now(), changes = {status: "rejected", reviewNote: note, reviewedAt: now, reviewedBy: state.email, updatedAt: now};
  try {
    await updateRider(id, changes);
    Object.assign(r, changes);
    await writeAudit("rider.reject", id, note);
    toast("Sent back to the rider with your note.", "success");
    closeDrawer();
    renderAll();
  } catch (error) {
    toast("Couldn’t send it back. " + ((error && error.message) || ""), "danger");
  }
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------
document.addEventListener("click", async (event) => {
  const t = event.target.closest("button, [data-copy]");
  if (event.target.id === "drawer-overlay") { closeDrawer(); return; }
  if (!t) return;
  if (t.dataset.tab) { state.tab = t.dataset.tab; renderTabs(); renderRows(); return; }
  if (t.dataset.review) { openRider(t.dataset.review); return; }
  if (t.id === "drawer-close") { closeDrawer(); return; }
  if (t.dataset.openDetails) { openDetails(t.dataset.openDetails); return; }
  if (t.dataset.panResult) { recordPan(t.dataset.riderId, t.dataset.panResult, t); return; }
  if (t.dataset.approve) { approve(t.dataset.approve); return; }
  if (t.dataset.rejectOpen) { const box = document.getElementById("reject-box"); box.hidden = false; box.scrollIntoView({block: "center"}); document.getElementById("reject-note").focus(); return; }
  if (t.dataset.rejectSend) { reject(t.dataset.rejectSend); return; }
  if (t.dataset.copy) {
    try { await navigator.clipboard.writeText(t.dataset.copy); toast("Copied.", "success"); } catch (_) { toast(t.dataset.copy); }
  }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.openId) closeDrawer(); });
document.getElementById("search-input").addEventListener("input", (event) => { state.query = event.target.value; renderRows(); });
document.getElementById("refresh-btn").addEventListener("click", async () => {
  await loadQueue(false);
  if (state.openId) { const fresh = await readRider(state.openId).catch(() => null); const i = state.riders.findIndex((r) => r.id === state.openId); if (fresh && i >= 0) state.riders[i] = fresh; renderAll(); }
  toast("Refreshed.", "success");
});
document.getElementById("signout-btn").addEventListener("click", () => signOutUser());

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
requireAdminSession().then((sessionState) => {
  if (!sessionState) return;
  state.role = String(sessionState.claims.savrivoRole || "");
  state.email = String(sessionState.user.email || "");
  document.getElementById("app-shell").hidden = false;
  document.getElementById("sidebar-who").textContent = sessionState.user.email + " · " + sessionState.claims.savrivoRole;
  loadQueue(true);
});

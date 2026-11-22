/*
 * SCRAVEIT partner dashboard (www.scraveit.in/partner): a laptop view of the
 * restaurant app for owners and their staff. Live orders, order history,
 * reports, finance (payouts, monthly report, invoices & taxes, UTR, terms), menu, offers, ads (top placement),
 * staff (owners add people and choose what each one sees) and outlet details.
 *
 * Access is the same as the Restaurant app: Firebase sign-in, then Firestore
 * rules allow only outlets the person is a member of (restaurantMembers), with
 * that member's permissions. Order actions go through the same server
 * functions as the app; they need App Check, which the website turns on with
 * the reCAPTCHA Enterprise key in /shop/web-config.js.
 */
(function () {
  "use strict";
  const CFG = window.SCRAVEIT_WEB || {};
  firebase.initializeApp(CFG.firebase);
  const WEB_CHECK = !!CFG.recaptchaEnterpriseSiteKey;
  if (WEB_CHECK) {
    try { firebase.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(CFG.recaptchaEnterpriseSiteKey), true); } catch (_) { /* reads still work */ }
  }
  const auth = firebase.auth();
  const db = firebase.firestore();
  const fns = firebase.app().functions(CFG.functionsRegion || "asia-south1");
  const call = (name, data) => fns.httpsCallable(name, {timeout: 30000})(data).then((r) => r.data);

  const app = document.getElementById("app");
  const modalRoot = document.getElementById("modal-root");
  const DAY = 86400000;
  const NEW = ["Order placed"];
  const PREPARING = ["Accepted", "Preparing"];
  const READY = ["Ready for pickup", "Assigned"];
  const PICKED = ["Handed to rider", "Out for delivery", "Near you", "Arrived"];
  const REJECT_REASONS = ["Item out of stock", "Kitchen is too busy", "Closing soon", "Can't make this order", "Other"];

  const state = {
    user: null, loadingOutlets: false, outlets: {}, rid: "", page: "orders", orderTab: "new",
    live: [], liveLoaded: false, liveUnsub: null, seenNew: new Set(), firstLiveLoad: true,
    sound: true, alert: null, busy: "",
    history: {range: "today", all: false, list: null, loading: false, sel: "", q: "", status: "all"},
    reports: {range: "today", data: null, loading: false},
    fin: {tab: "payouts", week: "", q: "", utrQ: "", tax: {}, wk: {}, mon: {}, month: "", showAll: false},
    menu: {items: null, loading: false, cat: "", q: ""},
    offers: {data: null, loading: false, error: ""},
    ads: {data: null, loaded: false, loading: false, error: "", start: "", days: 7, busy: false},
    insights: {doc: null, rid: "", loading: false, error: ""},
    staff: {data: null, rid: "", loading: false, error: "", busy: false, share: ""},
  };

  // ---------- helpers ----------
  const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const inr = (n) => { const v = Math.round(Number(n || 0) * 100) / 100; return "₹" + v.toLocaleString("en-IN", {minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2}); };
  const ms = (v) => v && typeof v.toMillis === "function" ? v.toMillis() : Number(v || 0);
  const clock = (t) => new Date(t).toLocaleTimeString("en-IN", {hour: "numeric", minute: "2-digit"});
  const dayLabel = (t) => new Date(t).toLocaleDateString("en-IN", {day: "numeric", month: "short"});
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function toast(text, bad) {
    const el = document.getElementById("toast");
    el.textContent = text; el.className = "show" + (bad ? " bad" : "");
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.className = ""; }, 3800);
  }
  function friendly(e) {
    const code = String(e && (e.code || e.message) || "");
    if (/app-check|unauthenticated|failed-precondition.*App Check/i.test(code) && !WEB_CHECK) return "Order actions from the website aren't switched on yet. Use the Scraveit Restaurant app for this.";
    if (/permission-denied|insufficient permissions/i.test(code)) return "Your account doesn't have permission for this outlet.";
    if (/wrong-password|invalid-credential|user-not-found/i.test(code)) return "Email/staff ID or password is wrong.";
    if (/user-disabled/i.test(code)) return "This account was switched off. Ask your outlet owner.";
    if (/network|unavailable/i.test(code)) return "No connection. Check your internet and try again.";
    return (e && e.message) ? String(e.message).replace(/^Firebase:\s*/, "").slice(0, 200) : "Something went wrong. Try again.";
  }
  const ICON = {
    orders: '<path d="M4 7h16l-1.5 11.5a2 2 0 0 1-2 1.5h-9a2 2 0 0 1-2-1.5Z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    menu: '<path d="M5 3v18M5 9h4a2 2 0 0 0 2-2V3M15 3c2.5 0 4 2 4 6s-1.5 5-4 5v7"/>',
    offers: '<path d="M20 12 12 20l-8-8V4h8Z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
    payouts: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
    ads: '<path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M16 9a3.5 3.5 0 0 1 0 6M19 6a7.5 7.5 0 0 1 0 12"/>',
    outlet: '<path d="M4 10 5.5 4h13L20 10"/><path d="M5 10v10h14V10M4 10h16"/><path d="M10 20v-5h4v5"/>',
    insights: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3Z"/>',
    out: '<path d="M15 4h4v16h-4M10 17l5-5-5-5M15 12H3"/>',
    dine: '<path d="M3 11h18M5 11v8M19 11v8M8 7h8a2 2 0 0 1 2 2v2H6V9a2 2 0 0 1 2-2Z"/>',
    meals: '<path d="M3 13h18a9 9 0 0 1-18 0Z"/><path d="M12 4v5M8 6v3M16 6v3"/>',
    staff: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  };
  const svg = (k) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + "</svg>";

  // ---------- orders: fields ----------
  const orderId = (o) => String(o.id || o.orderId || o._doc || "");
  const shortId = (o) => orderId(o).replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase();
  const customerId = (o) => String(o.customerId || o.userId || "");
  const placedAt = (o) => ms(o.createdAt) || ms(o.placedAt) || ms(o.updatedAt);
  const firstName = (o) => String(o.customerName || "Customer").trim().split(/\s+/)[0];
  const area = (o) => [o.address && o.address.area, o.address && o.address.city].filter(Boolean).join(", ");
  const itemValue = (o) => Number(o.pricing && o.pricing.subtotal != null ? o.pricing.subtotal : o.total || 0);
  const customerPaid = (o) => Number(o.total || (o.pricing && o.pricing.total) || 0);
  const earnings = (o) => { const e = o.economics; return e && e.calculationVersion === 1 && e.restaurant ? Number(e.restaurant.receivablePaise || 0) / 100 : null; };
  const awaitingPayment = (o) => o.paymentMethod !== "cod" && o.paymentState !== "paid" && o.paymentState !== "refunded";
  function payPill(o) {
    if (o.paymentMethod === "cod") return '<span class="pill cod">Cash</span>';
    if (awaitingPayment(o)) return '<span class="pill wait">Payment pending</span>';
    return '<span class="pill paid">Paid</span>';
  }
  function groupOf(o) {
    if (NEW.includes(o.status)) return "new";
    if (PREPARING.includes(o.status)) return "preparing";
    if (READY.includes(o.status)) return "ready";
    if (PICKED.includes(o.status)) return "picked";
    return "done";
  }
  function itemsHtml(o) {
    return '<ul class="olist">' + (o.items || []).map((it) => {
      const extras = [it.variant, ...(it.addOns || []).map((a) => a && (a.name || a))].filter(Boolean).join(" · ");
      // Veg / non-veg mark from the dish's own label; no mark when the menu doesn't say.
      const diet = String(it.diet || it.foodType || "").toLowerCase(), nonveg = /non|egg/.test(diet), veg = !nonveg && /veg/.test(diet);
      return '<li>' + (nonveg || veg ? '<span class="diet' + (nonveg ? " nonveg" : "") + '"></span>' : '<span class="diet none"></span>') + '<span class="grow"><span class="q">' + Number(it.quantity || 1) + ' ×</span> ' + h(it.name) +
        (extras ? "<small>" + h(extras) + "</small>" : "") + (it.note ? "<small>Note: " + h(it.note) + "</small>" : "") + '</span><span class="num">' + inr(Number(it.price || 0) * Number(it.quantity || 1)) + "</span></li>";
    }).join("") + "</ul>";
  }

  // ---------- sign in ----------
  function screenSignIn(error) {
    app.innerHTML = '<div class="signin"><form class="signin-card" id="signin"><div class="wordmark">scraveit<span>*</span></div><div><h1 style="font-size:22px">Partner dashboard</h1><p>For restaurant owners and staff. Use the same account as the Scraveit Restaurant app.</p></div>' +
      (error ? '<div class="notice bad">' + h(error) + "</div>" : "") +
      '<div class="field"><label for="em">Email or staff ID</label><input class="input" id="em" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>' +
      '<div class="field"><label for="pw">Password</label><input class="input" id="pw" type="password" autocomplete="current-password" required></div>' +
      '<button class="btn primary block" type="submit">Sign in</button><div class="divider">or</div><button class="btn block" type="button" data-act="google">Continue with Google</button>' +
      '<p class="small">Staff: use the staff ID and password from your outlet owner. <a href="/grievance">Help</a></p><p class="small" style="margin:0">New outlet? <button type="button" class="linklike" style="color:var(--brand)" data-act="signup">Create an account and register</button></p><p class="small" style="margin:0"><button type="button" class="linklike" style="color:var(--brand)" data-act="lang" translate="no">' + (window.ScraveitLanguage && ScraveitLanguage.get() === "te" ? "English" : "తెలుగు") + '</button></p></form></div>';
  }
  document.addEventListener("submit", async (e) => {
    if (e.target.id === "cp-form") { e.preventDefault(); cpCopy(e.target); return; }
    if (e.target.id === "signin") {
      e.preventDefault();
      // A staff ID ("ravi4821") is the sign-in the owner made for that person: <id>@staff.scraveit.in.
      const raw = document.getElementById("em").value.trim(), em = raw.includes("@") ? raw : raw.toLowerCase() + "@" + STAFF_DOMAIN, pw = document.getElementById("pw").value;
      try { await auth.signInWithEmailAndPassword(em, pw); } catch (err) { screenSignIn(friendly(err)); }
    }
    if (e.target.id === "signup") { e.preventDefault(); createAccount(e.target); }
    if (e.target.id === "item-form") { e.preventDefault(); saveItem(e.target); }
    if (e.target.id === "freebie-form") { e.preventDefault(); submitFreebie(e.target); }
    if (e.target.id === "pairing-form") { e.preventDefault(); submitPairing(e.target); }
    if (e.target.id === "discount-form") { e.preventDefault(); submitDiscount(e.target); }
    if (e.target.id === "tds-claim-form") { e.preventDefault(); sendTdsClaim(e.target); }
    if (e.target.id === "staff-form") { e.preventDefault(); saveStaff(e.target); }
    if (e.target.id === "bank-form") { e.preventDefault(); saveBank(e.target); }
    if (e.target.id === "outlet-form") { e.preventDefault(); saveOutlet(e.target); }
    if (e.target.id === "tax-form") { e.preventDefault(); saveTax(e.target); }
    if (e.target.id === "dine-form") { e.preventDefault(); saveDine(e.target, {print: e.submitter && e.submitter.value === "print"}); }
    if (e.target.id === "meal-plan-form") { e.preventDefault(); saveMealPlan(e.target); }
    if (e.target.id === "deletion-form") { e.preventDefault(); submitDeletion(e.target); }
    if (e.target.id === "chat-form") { e.preventDefault(); sendChat(e.target); }
    if (e.target.id === "staff-pass-form") { e.preventDefault(); setStaffPassword(e.target); }
    if (e.target.id === "reject-form") { e.preventDefault(); const f = e.target; setStatus(f.dataset.id, "Cancelled", f.reason.value === "Other" ? (f.note.value || "Other") : f.reason.value); closeModal(); }
  });

  // ---------- outlets ----------
  async function loadOutlets() {
    state.loadingOutlets = true; render();
    const uid = state.user.uid, outlets = {};
    try {
      const links = await db.collection("userRestaurants").doc(uid).get();
      const ids = links.exists ? Object.keys(links.data() || {}).filter((k) => links.data()[k] === true) : [];
      await Promise.all(ids.map(async (rid) => {
        const [m, r] = await Promise.all([db.collection("restaurantMembers").doc(rid + "_" + uid).get().catch(() => null), db.collection("restaurants").doc(rid).get().catch(() => null)]);
        const member = m && m.exists ? m.data() : null;
        if (member && member.active === true && r && r.exists) outlets[rid] = {id: rid, doc: r.data(), member};
      }));
    } catch (e) { toast(friendly(e), true); }
    state.outlets = outlets; state.loadingOutlets = false; CP.profiles = null;
    let saved = ""; try { saved = localStorage.getItem("scraveit.partner.rid") || ""; } catch (_) { /* private mode */ }
    state.rid = outlets[saved] ? saved : Object.keys(outlets)[0] || "";
    startLive(); render();
  }
  const outlet = () => state.outlets[state.rid] || null;
  // Same test as firestore.rules memberGrants(): owners and managers can do everything, other staff what they were given.
  const isManager = () => { const m = outlet() && outlet().member; return !!(m && m.active === true && ["restaurant_owner", "restaurant_manager"].includes(m.role)); };
  const can = (p) => { const m = outlet() && outlet().member; return isManager() || !!(m && m.active === true && m.permissions && m.permissions[p] === true); };
  function selectOutlet(rid) {
    state.rid = rid; try { localStorage.setItem("scraveit.partner.rid", rid); } catch (_) { /* ignore */ }
    stopDine(); MP.plans = null; MP.rid = "";
    state.menu.items = null; state.menu.arrange = null; state.offers.data = null; state.fin = {tab: state.fin.tab, week: "", q: "", utrQ: "", tax: {}, wk: {}, mon: {}, month: "", showAll: false};
    state.ads = {data: null, loaded: false, loading: false, error: "", start: "", days: 7, busy: false}; state.staff = {data: null, rid: "", loading: false, error: "", busy: false, share: ""}; state.reports.data = null; state.history.list = null; state.seenNew = new Set(); state.firstLiveLoad = true;
    startLive(); render();
  }

  // ---------- live orders ----------
  function startLive() {
    if (state.liveUnsub) { state.liveUnsub(); state.liveUnsub = null; }
    state.live = []; state.liveLoaded = false;
    if (!state.rid || !pageAllowed("orders")) return;
    const since = Date.now() - 36 * 3600000;
    const onSnap = (snap) => {
      state.live = snap.docs.map((d) => Object.assign({_doc: d.id}, d.data())).filter((o) => placedAt(o) >= since).sort((a, b) => placedAt(b) - placedAt(a));
      state.liveLoaded = true;
      const fresh = state.live.filter((o) => groupOf(o) === "new" && !state.seenNew.has(orderId(o)));
      fresh.forEach((o) => state.seenNew.add(orderId(o)));
      if (!state.firstLiveLoad && fresh.length) announce(fresh[0]);
      state.firstLiveLoad = false;
      if (!state.alert && state.page === "orders") render(); else updateBadges();
    };
    const fallback = () => { state.liveUnsub = db.collection("restaurantOrders").where("restaurantId", "==", state.rid).onSnapshot(onSnap, (e) => { state.liveLoaded = true; toast(friendly(e), true); render(); }); };
    try {
      state.liveUnsub = db.collection("restaurantOrders").where("restaurantId", "==", state.rid).where("createdAt", ">=", since).orderBy("createdAt", "desc").limit(300)
        .onSnapshot(onSnap, () => fallback());
    } catch (_) { fallback(); }
  }
  const liveIn = (g) => state.live.filter((o) => groupOf(o) === g);
  function updateBadges() { const el = document.querySelector('[data-page="orders"] .count'); const n = liveIn("new").length; if (el) { el.textContent = n; el.hidden = !n; } }

  // New order: a sound (once the owner has switched sound on) and a pop-up with Accept / Reject.
  let audioCtx = null, ringTimer = null;
  // With the dashboard open in two tabs, only one of them plays each sound.
  function soundTurn(kind, gapMs) {
    try {
      const key = "scraveit.partner.sound." + kind, last = Number(localStorage.getItem(key)) || 0;
      if (Date.now() - last < gapMs) return false;
      localStorage.setItem(key, String(Date.now()));
    } catch (_) { /* storage blocked: just play */ }
    return true;
  }
  function ring() {
    if (!state.sound || !soundTurn("ring", 2000)) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const beep = (at, f) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f; o.type = "triangle"; g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(.35, at + .02); g.gain.exponentialRampToValueAtTime(.0001, at + .35); o.connect(g); g.connect(audioCtx.destination); o.start(at); o.stop(at + .4); };
      // Two rings with a small gap; announce() repeats the pair after a pause.
      const t = audioCtx.currentTime; beep(t, 880); beep(t + .4, 1175); beep(t + 1.1, 880); beep(t + 1.5, 1175);
    } catch (_) { /* no audio */ }
  }
  function announce(o) {
    state.alert = orderId(o);
    ring(); clearInterval(ringTimer); ringTimer = setInterval(() => { if (state.alert) ring(); else clearInterval(ringTimer); }, 2400);
    try { if (window.Notification && Notification.permission === "granted") new Notification("New Scraveit order #" + shortId(o), {body: (o.items || []).map((i) => i.quantity + " × " + i.name).join(", ").slice(0, 120)}); } catch (_) { /* ignore */ }
    showOrderModal(o);
  }
  function showOrderModal(o) {
    const id = orderId(o), e = earnings(o);
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="New order"><header><h2>New order #' + h(shortId(o)) + '</h2><button class="x" data-act="close-alert" aria-label="Close">×</button></header>' +
      '<div class="row between"><span>' + h(firstName(o)) + (area(o) ? " · " + h(area(o)) : "") + '</span>' + payPill(o) + "</div>" + itemsHtml(o) +
      '<div class="bill"><div><span>Order value</span><span>' + inr(itemValue(o)) + "</span></div>" + (e != null ? '<div><span>You get</span><span>' + inr(e) + "</span></div>" : "") + '<div class="tot"><span>Customer pays</span><span>' + inr(customerPaid(o)) + "</span></div></div>" +
      (awaitingPayment(o) ? '<div class="notice warn">The customer\'s online payment isn\'t confirmed yet. You can accept once it is.</div>' : "") +
      '<div class="row"><button class="btn danger grow" data-act="reject" data-id="' + h(id) + '">Reject</button><button class="btn good grow" data-act="status" data-to="Accepted" data-id="' + h(id) + '"' + (awaitingPayment(o) || !can("orders") ? " disabled" : "") + ">Accept order</button></div></div></div>";
  }
  function closeModal() { if (chatUnsub) { chatUnsub(); chatUnsub = null; } chatCtx = null; modalRoot.innerHTML = ""; state.alert = null; state.staff.share = ""; clearInterval(ringTimer); if (state.page === "orders") render(); }
  async function setStatus(id, to, reason) {
    const o = state.live.find((x) => orderId(x) === id) || (state.history.list || []).find((x) => orderId(x) === id);
    if (!o) return;
    state.busy = id; render();
    try {
      const send = (toStatus) => call("updateOrderStatus", {customerId: customerId(o), orderId: id, toStatus, reason: reason || "", cashCollected: false});
      // There is no "Start preparing" step: accepting puts the order in the kitchen.
      if (to === "Ready for pickup" && o.status === "Accepted") await send("Preparing").catch(() => {});
      await send(to);
      if (to === "Accepted") { await send("Preparing").catch(() => {}); autoPrintOrder(o); }
      toast(to === "Cancelled" ? "Order rejected." : to === "Accepted" ? "Order accepted. The kitchen timer has started." : to === "Ready for pickup" ? "Marked ready. The rider is on the way." : "Order updated.");
      if (state.alert === id) closeModal();
    } catch (e) { toast(friendly(e), true); } finally { state.busy = ""; render(); }
  }
  function rejectModal(id) {
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal" id="reject-form" data-id="' + h(id) + '"><header><h2>Reject this order?</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<p class="muted" style="margin:0">The customer is told and refunded if they paid online. Frequent rejections lower your outlet\'s ranking.</p>' +
      '<div class="field"><label for="reason">Reason</label><select class="input" id="reason" name="reason">' + REJECT_REASONS.map((r) => "<option>" + h(r) + "</option>").join("") + "</select></div>" +
      '<div class="field"><label for="note">Details (optional)</label><input class="input" id="note" name="note" maxlength="200"></div>' +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Keep order</button><button class="btn danger grow" type="submit">Reject order</button></div></form></div>';
  }
  // Kitchen timer, counted from Accept: 15 minutes for a small order, 20 for a
  // bigger one (more than 3 dishes in all, or more than 2 different dishes).
  // Free items don't count. "Order ready" can be tapped at any time.
  function acceptedAt(o) {
    const at = Object.values(o.statusHistory || {}).filter((ev) => ev && ev.status === "Accepted").map((ev) => ms(ev.at)).filter(Boolean);
    return at.length ? Math.min(...at) : ms(o.updatedAt) || placedAt(o);
  }
  function prepMinutes(o) {
    const items = (o.items || []).filter((i) => !i.free), units = items.reduce((n, i) => n + (Number(i.quantity) || 1), 0);
    return units > 3 || items.length > 2 ? 20 : 15;
  }
  const readyDue = (o) => acceptedAt(o) + prepMinutes(o) * 60000;
  function readyLabel(due) {
    const left = due - Date.now(), s = Math.floor(Math.abs(left) / 1000), t = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    return left >= 0 ? t : "late " + t;
  }
  // Pickup: the rider photographs the parcel with the bill or order ID showing to pick it up, so staff tap
  // nothing. A store delivering its own order keeps the handover button.
  function riderPhotoPickup(o) {
    return o.selfDelivery !== true && READY.includes(o.status);
  }
  function pickupNote(o) {
    return '<div class="notice info small" style="margin:0;align-items:center;gap:12px"><span>Put the bill on the bag or write the order ID on it. The rider photographs the parcel to pick it up.</span>' +
      '<strong style="flex:none;font-size:26px;letter-spacing:.06em">#' + h(shortId(o)) + "</strong></div>";
  }
  function readyButton(o, busy) {
    const due = readyDue(o), late = due < Date.now();
    return '<button class="btn primary ready-btn' + (late ? " late" : "") + '" data-act="status" data-to="Ready for pickup" data-id="' + h(orderId(o)) + '" data-due="' + due + '"' + (busy ? " disabled" : "") +
      '>Order ready (<span class="timer">' + readyLabel(due) + "</span>)</button>" + '<div class="small muted" style="text-align:right">' + prepMinutes(o) + " min order</div>";
  }
  // Once a timer runs out: "Your order is getting late", then again every 30 seconds until it's marked ready.
  const LATE_REPEAT_MS = 30000, lateSaidAt = {};
  // The voice plays through the same Web Audio context as the ring, which the
  // first tap already woke up, so nothing has to be played in advance.
  let lateBuffer = null;
  function playLateVoice() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const play = (buf) => { const src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(audioCtx.destination); src.start(); };
      if (lateBuffer) { play(lateBuffer); return; }
      fetch("/partner/order-late.m4a").then((r) => r.arrayBuffer())
        .then((b) => new Promise((ok, fail) => audioCtx.decodeAudioData(b, ok, fail)))
        .then((buf) => { lateBuffer = buf; play(buf); }).catch(() => {});
    } catch (_) { /* no audio */ }
  }
  // Sounds are always on. Browsers only allow a page to play sound after the
  // first tap or key press on it, so that first one also wakes the audio up.
  let audioUnlocked = !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (_) { /* no audio */ }
    try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (_) { /* ignore */ }
    if (state.page === "orders" && !modalRoot.innerHTML) render();
  }
  ["pointerdown", "keydown"].forEach((t) => document.addEventListener(t, unlockAudio, {capture: true}));
  function tickKitchen() {
    document.querySelectorAll(".ready-btn[data-due]").forEach((b) => {
      const due = Number(b.dataset.due), t = b.querySelector(".timer");
      if (t) t.textContent = readyLabel(due);
      b.classList.toggle("late", due < Date.now());
    });
    const late = state.live.filter((o) => PREPARING.includes(o.status) && readyDue(o) < Date.now());
    const due = late.find((o) => Date.now() - (lateSaidAt[orderId(o)] || 0) >= LATE_REPEAT_MS);
    if (!due || !state.sound) return;
    late.forEach((o) => { if (Date.now() - (lateSaidAt[orderId(o)] || 0) >= LATE_REPEAT_MS) lateSaidAt[orderId(o)] = Date.now(); });
    if (!soundTurn("late", LATE_REPEAT_MS - 2000)) return;
    playLateVoice();
  }

  // ---------- order chat (same orderChats records as the Restaurant app) ----------
  let chatUnsub = null, chatCtx = null;
  const maskPhones = (v) => String(v || "").replace(/(?:\+?91[\s.()-]*)?[6-9](?:[\s.()-]*\d){9}/g, "[phone number hidden]");
  function chatButtons(o) {
    if (!can("orders")) return "";
    const id = h(orderId(o));
    return '<button class="btn small" data-act="chat" data-id="' + id + '" data-channel="customerRestaurant">💬 Customer</button>' +
      (o.riderId ? '<button class="btn small" data-act="chat" data-id="' + id + '" data-channel="restaurantRider">💬 Delivery partner</button>' : "");
  }
  function drawChat() {
    const box = document.getElementById("chat-thread"); if (!box || !chatCtx) return;
    const list = chatCtx.messages;
    box.innerHTML = list.length ? list.map((m) => '<div class="chat-msg' + (m.senderRole === "restaurant" ? " mine" : "") + '"><strong>' + h(m.senderRole === "restaurant" ? "You" : m.senderRole === "rider" ? "Delivery partner" : m.senderRole === "customer" ? "Customer" : m.senderRole || "Scraveit") + "</strong><p>" + h(m.body || "") + '</p><span class="small muted">' + h(clock(Number(m.at || 0))) + "</span></div>").join("")
      : '<div class="small muted" style="text-align:center;padding:24px 0">No messages yet. Use chat to sort out the order.</div>';
    box.scrollTop = box.scrollHeight;
  }
  function openChat(id, channel) {
    const o = state.live.find((x) => orderId(x) === id) || (state.history.list || []).find((x) => orderId(x) === id); if (!o) return;
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }
    chatCtx = {order: o, channel, messages: []};
    const who = channel === "customerRestaurant" ? "customer" : "delivery partner";
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal" id="chat-form"><header><h2>Chat with ' + who + ' · #' + h(shortId(o)) + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="notice info small" style="margin:0">Phone numbers are not shown. Any phone number typed here is hidden before sending.</div>' +
      '<div class="chat-thread" id="chat-thread"><div class="spinner"></div></div>' +
      '<div class="row"><input class="input grow" name="message" maxlength="800" placeholder="Type a message" required autocomplete="off"><button class="btn primary" type="submit">Send</button></div></form></div>';
    chatUnsub = db.collection("orderChats").where("orderId", "==", orderId(o)).where("channel", "==", channel).orderBy("at", "asc")
      .onSnapshot((snap) => { if (!chatCtx) return; chatCtx.messages = snap.docs.map((d) => d.data()); drawChat(); }, (e) => { const b = document.getElementById("chat-thread"); if (b) b.innerHTML = '<div class="notice warn">' + h(friendly(e)) + "</div>"; });
    setTimeout(() => { const i = document.querySelector("#chat-form input[name=message]"); if (i) i.focus(); }, 50);
  }
  async function sendChat(form) {
    if (!chatCtx) return;
    const o = chatCtx.order, original = String(form.elements.message.value || "").trim(); if (!original) return;
    const body = maskPhones(original).slice(0, 800), mid = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const record = {id: mid, orderId: orderId(o), customerId: String(o.userId || o.customerId || ""), restaurantId: o.restaurantId || state.rid, riderId: o.riderId || "",
      channel: chatCtx.channel, senderId: state.user.uid, senderRole: "restaurant", body, masked: body !== original, at: Date.now()};
    try {
      await db.collection("orderChats").doc(orderId(o) + "_" + chatCtx.channel + "_" + mid).set(record);
      form.elements.message.value = "";
      if (record.masked) toast("A phone number was hidden for privacy.");
    } catch (e) { toast(friendly(e), true); }
  }
  function orderCard(o) {
    const g = groupOf(o), id = orderId(o), mins = Math.floor((Date.now() - placedAt(o)) / 60000), e = earnings(o), busy = state.busy === id;
    let actions = "";
    if (g === "new") actions = '<button class="btn good" data-act="status" data-to="Accepted" data-id="' + h(id) + '"' + (awaitingPayment(o) || busy || !can("orders") ? " disabled" : "") + ">Accept</button><button class=\"btn danger\" data-act=\"reject\" data-id=\"" + h(id) + '"' + (busy ? " disabled" : "") + ">Reject</button>";
    else if (PREPARING.includes(o.status)) actions = readyButton(o, busy);
    else if (riderPhotoPickup(o)) actions = pickupNote(o);
    if (g !== "new") actions += '<button class="btn small" data-act="print-order" data-id="' + h(id) + '">🖨️ Print</button>';
    if (g !== "new") actions += chatButtons(o);
    const rider = o.riderName ? "<strong>" + h(o.riderName) + "</strong><div class=\"small muted\">" + h(g === "ready" && o.riderArrivalVerified === true ? "At your restaurant" : o.status) + "</div>" : g === "ready" ? '<div class="small muted">Finding a delivery partner…</div>' : "";
    return '<article class="card order"><div class="band' + (g === "new" ? " new" : "") + '">' + (g === "new" ? "NEW ORDER" : "SCRAVEIT DELIVERY") + " · " + h(o.status) + "</div>" +
      '<div class="o-info"><div class="oid">#' + h(shortId(o)) + '</div><div class="small muted">Placed ' + h(clock(placedAt(o))) + ' · <span class="timer">' + mins + ' min ago</span></div><p style="margin:10px 0 2px"><strong>' + h(firstName(o)) + "</strong></p>" +
      (area(o) ? '<div class="small muted">' + h(area(o)) + "</div>" : "") + (o.instructions ? '<div class="notice info small" style="margin-top:8px">' + h(o.instructions) + "</div>" : "") + "</div>" +
      // Dishes on the left, prices on the right, the action box in the middle between them.
      '<div class="o-body">' + itemsHtml(o) + '<div class="total-line"><span>Total ' + payPill(o) + '</span><span>' + inr(customerPaid(o)) + "</span></div>" + (e != null ? '<div class="small muted you-get">You get ' + inr(e) + "</div>" : "") +
      '<div class="actions" style="grid-row: 1 / span ' + ((o.items || []).length + 2) + '">' + actions + rider + (awaitingPayment(o) && g === "new" ? '<div class="small muted">Waiting for the customer\'s online payment.</div>' : "") + "</div></div></article>";
  }
  function pageOrders() {
    const groups = {new: liveIn("new"), preparing: liveIn("preparing"), ready: liveIn("ready"), picked: liveIn("picked")};
    const tabs = [["new", "New"], ["preparing", "Preparing"], ["ready", "Ready"], ["picked", "Picked up"]];
    const list = groups[state.orderTab] || [];
    return '<div class="row between"><div class="tabs">' + tabs.map((t) => '<button class="tab' + (state.orderTab === t[0] ? " on" : "") + '" data-act="order-tab" data-tab="' + t[0] + '">' + t[1] + " (" + groups[t[0]].length + ")</button>").join("") + "</div>" +
      '<div class="row" style="gap:8px">' + (audioUnlocked ? '<span class="small muted">🔔 Order sounds are on</span>' : '<span class="notice warn small" style="margin:0">🔔 Tap anywhere on this page once so order sounds can play</span>') + '<button class="btn small" data-act="printer-setup">🖨️ Printer' + (printerSettings().auto ? ": auto" : "") + "</button></div></div>" +
      (!state.liveLoaded ? '<div class="spinner"></div>' : list.length ? '<div class="orders">' + list.map(orderCard).join("") + "</div>" :
        '<div class="card empty"><strong>' + (state.orderTab === "new" ? "No new orders right now" : "Nothing here") + "</strong>" + (state.orderTab === "new" ? "Keep this page open: new orders pop up here with a sound." : "") + "</div>");
  }

  // ---------- history and reports: data ----------
  function rangeOf(key) {
    const now = Date.now(), today = startOfDay(now);
    if (key === "yesterday") return [today - DAY, today];
    if (key === "7d") return [today - 6 * DAY, now];
    if (key === "30d") return [today - 29 * DAY, now];
    return [today, now];
  }
  // Pages through every order in the window: totals and tax figures must never stop at a page size.
  async function fetchOrders(rids, from, to) {
    const out = [];
    await Promise.all(rids.map(async (rid) => {
      let docs = [];
      try {
        let query = db.collection("restaurantOrders").where("restaurantId", "==", rid).where("createdAt", ">=", from).where("createdAt", "<", to).orderBy("createdAt", "desc").limit(1000);
        for (;;) {
          const page = (await query.get()).docs;
          docs = docs.concat(page);
          if (page.length < 1000) break;
          query = query.startAfter(page[page.length - 1]);
        }
      } catch (_) {
        docs = (await db.collection("restaurantOrders").where("restaurantId", "==", rid).get()).docs;
      }
      docs.forEach((d) => { const o = Object.assign({_doc: d.id}, d.data()); const t = placedAt(o); if (t >= from && t < to) out.push(o); });
    }));
    return out.sort((a, b) => placedAt(b) - placedAt(a));
  }
  const RANGES = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]];
  function rangeTabs(cur, act) { return '<div class="tabs">' + RANGES.map((r) => '<button class="tab' + (cur === r[0] ? " on" : "") + '" data-act="' + act + '" data-range="' + r[0] + '">' + r[1] + "</button>").join("") + "</div>"; }
  const outletIds = (all) => all ? Object.keys(state.outlets) : [state.rid];

  async function loadHistory() {
    const H = state.history; H.loading = true; render();
    const [from, to] = rangeOf(H.range);
    try { H.list = await fetchOrders(outletIds(H.all), from, to); } catch (e) { toast(friendly(e), true); H.list = []; }
    H.loading = false; render();
  }
  function csv(rows) { return rows.map((r) => r.map((c) => '"' + String(c ?? "").replace(/"/g, '""') + '"').join(",")).join("\n"); }
  function download(name, text) { const a = document.createElement("a"); a.href = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], {type: "text/csv"})); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  function pageHistory() {
    const H = state.history;
    if (!H.list && !H.loading) setTimeout(loadHistory, 0);
    let list = (H.list || []).filter((o) => H.status === "all" || (H.status === "delivered" ? o.status === "Delivered" : H.status === "cancelled" ? o.status === "Cancelled" : !["Delivered", "Cancelled"].includes(o.status)));
    if (H.q) list = list.filter((o) => orderId(o).toLowerCase().includes(H.q.toLowerCase()) || shortId(o).toLowerCase() === H.q.toLowerCase());
    const sel = list.find((o) => orderId(o) === H.sel);
    const multi = Object.keys(state.outlets).length > 1;
    return '<div class="row between">' + rangeTabs(H.range, "hist-range") + '<div class="row"><input class="input" style="width:200px" placeholder="Search order ID" value="' + h(H.q) + '" data-input="hist-q">' +
      '<select class="input" style="width:150px" data-input="hist-status">' + [["all", "All orders"], ["delivered", "Delivered"], ["cancelled", "Rejected / cancelled"], ["open", "In progress"]].map((s) => '<option value="' + s[0] + '"' + (H.status === s[0] ? " selected" : "") + ">" + s[1] + "</option>").join("") + "</select>" +
      (multi ? '<label class="row small"><input type="checkbox" data-input="hist-all"' + (H.all ? " checked" : "") + "> All outlets</label>" : "") +
      '<button class="btn" data-act="hist-csv"' + (list.length ? "" : " disabled") + ">Download CSV</button></div></div>" +
      (H.loading ? '<div class="spinner"></div>' : '<div class="split"><div class="card" style="padding:0;overflow:auto"><table class="table"><thead><tr><th>Order</th><th>Placed</th><th>Customer</th><th>Status</th><th class="num">Value</th></tr></thead><tbody>' +
        (list.length ? list.map((o) => '<tr class="clickable' + (orderId(o) === H.sel ? " sel" : "") + '" data-act="hist-sel" data-id="' + h(orderId(o)) + '"><td><strong>#' + h(shortId(o)) + '</strong><div class="small muted">' + h(orderId(o)) + (multi && H.all ? " · " + h((state.outlets[o.restaurantId] || {doc: {}}).doc.name || "") : "") + "</div></td><td>" + h(dayLabel(placedAt(o))) + ", " + h(clock(placedAt(o))) + "</td><td>" + h(firstName(o)) + '</td><td><span class="pill ' + (o.status === "Delivered" ? "done" : o.status === "Cancelled" ? "wait" : "state") + '">' + h(o.status) + '</span></td><td class="num">' + inr(itemValue(o)) + "</td></tr>").join("") :
          '<tr><td colspan="5" class="empty"><strong>No orders</strong>Nothing matches this period.</td></tr>') + "</tbody></table></div>" +
        '<div class="card detail">' + (sel ? historyDetail(sel) : '<div class="empty"><strong>No order selected</strong>Pick an order to see its bill.</div>') + "</div></div>");
  }
  function historyDetail(o) {
    const e = earnings(o), pr = o.pricing || {};
    return '<div class="row between"><h2>#' + h(shortId(o)) + '</h2><span class="pill state">' + h(o.status) + '</span></div><p class="small muted" style="margin:0 0 10px">' + h(orderId(o)) + " · " + h(new Date(placedAt(o)).toLocaleString("en-IN")) + "</p>" + itemsHtml(o) +
      '<div class="bill" style="margin-top:12px"><div><span>Item total</span><span>' + inr(itemValue(o)) + "</span></div>" + (pr.discount ? '<div><span>Discount</span><span>−' + inr(pr.discount) + "</span></div>" : "") + (pr.packagingFee ? '<div><span>Packaging</span><span>' + inr(pr.packagingFee) + "</span></div>" : "") +
      '<div class="tot"><span>Customer paid ' + payPill(o) + "</span><span>" + inr(customerPaid(o)) + "</span></div>" + (e != null ? '<div class="tot"><span>You get</span><span>' + inr(e) + "</span></div>" : "") + "</div>" +
      (o.cancelReason || o.reason ? '<div class="notice warn small" style="margin-top:10px">Reason: ' + h(o.cancelReason || o.reason) + "</div>" : "") + (o.rating ? '<p class="small">Customer rating: <strong>' + h(o.rating) + " ★</strong></p>" : "");
  }

  // ---------- reports ----------
  function summarize(list) {
    const delivered = list.filter((o) => o.status === "Delivered"), cancelled = list.filter((o) => o.status === "Cancelled");
    const sales = delivered.reduce((s, o) => s + itemValue(o), 0), earned = delivered.reduce((s, o) => s + (earnings(o) || 0), 0);
    const rated = list.filter((o) => Number(o.rating) > 0);
    const byCustomer = {}; list.forEach((o) => { const c = customerId(o); if (c) byCustomer[c] = (byCustomer[c] || 0) + 1; });
    const customers = Object.keys(byCustomer).length, repeat = Object.values(byCustomer).filter((n) => n > 1).length;
    return {orders: list.length, delivered: delivered.length, cancelled: cancelled.length, sales, earned, aov: delivered.length ? sales / delivered.length : 0,
      rejectRate: list.length ? cancelled.length / list.length * 100 : 0, rating: rated.length ? rated.reduce((s, o) => s + Number(o.rating), 0) / rated.length : 0, ratedCount: rated.length, customers, repeat};
  }
  async function loadReports() {
    const R = state.reports; R.loading = true; render();
    const [from, to] = rangeOf(R.range), span = R.range === "today" ? DAY : to - from;
    // Compared with the same stretch one week earlier (today against the same weekday last week).
    const prevFrom = R.range === "today" || R.range === "yesterday" ? from - 7 * DAY : from - span, prevTo = R.range === "today" ? to - 7 * DAY : R.range === "yesterday" ? to - 7 * DAY : from;
    try {
      const rids = outletIds(true);
      const [cur, prev] = await Promise.all([fetchOrders(rids, from, to), fetchOrders(rids, prevFrom, prevTo)]);
      const mine = (l) => l.filter((o) => o.restaurantId === state.rid || R.all);
      R.data = {cur: mine(cur), prev: mine(prev), from, to};
    } catch (e) { toast(friendly(e), true); R.data = {cur: [], prev: [], from, to}; }
    R.loading = false; render();
  }
  function delta(a, b, invert) {
    if (!b) return '<span class="delta muted">—</span>';
    const d = (a - b) / b * 100, good = invert ? d < 0 : d > 0;
    return '<span class="delta ' + (good ? "up" : "down") + '">' + (d > 0 ? "▲ " : "▼ ") + Math.abs(d).toFixed(0) + "%</span>";
  }
  function barChart(list, from, to, hourly) {
    const buckets = [];
    if (hourly) for (let i = 0; i < 24; i++) buckets.push({label: i % 3 === 0 ? (i % 12 || 12) + (i < 12 ? "a" : "p") : "", v: 0});
    else for (let t = startOfDay(from); t < to; t += DAY) buckets.push({label: dayLabel(t), v: 0, t});
    list.filter((o) => o.status === "Delivered").forEach((o) => {
      const t = placedAt(o), i = hourly ? new Date(t).getHours() : Math.floor((startOfDay(t) - startOfDay(from)) / DAY);
      if (buckets[i]) buckets[i].v += itemValue(o);
    });
    const max = Math.max(1, ...buckets.map((b) => b.v)), W = 760, H = 200, bw = W / buckets.length;
    return '<svg class="chart" viewBox="0 0 ' + W + " " + (H + 22) + '" preserveAspectRatio="none" role="img" aria-label="Sales chart">' + buckets.map((b, i) => {
      const bh = Math.round(b.v / max * H);
      return '<rect class="bar" x="' + (i * bw + bw * .15) + '" y="' + (H - bh) + '" width="' + bw * .7 + '" height="' + Math.max(bh, 1) + '" rx="3"><title>' + h(b.label) + ": " + inr(b.v) + "</title></rect>" + (b.label && (hourly || buckets.length <= 10 || i % Math.ceil(buckets.length / 8) === 0) ? '<text x="' + (i * bw + bw / 2) + '" y="' + (H + 16) + '" text-anchor="middle">' + h(b.label) + "</text>" : "");
    }).join("") + "</svg>";
  }
  function topList(entries, unit) {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return entries.length ? '<div class="bars">' + entries.map((e) => '<div><span>' + h(e[0]) + '</span><i style="width:' + Math.max(4, e[1] / max * 100) + '%"></i><strong>' + h(unit(e[1])) + "</strong></div>").join("") + "</div>" : '<p class="muted small">No delivered orders in this period.</p>';
  }
  function pageReports() {
    const R = state.reports;
    if (!R.data && !R.loading) setTimeout(loadReports, 0);
    const multi = Object.keys(state.outlets).length > 1;
    const head = '<div class="row between">' + rangeTabs(R.range, "rep-range") + (multi ? '<label class="row small"><input type="checkbox" data-input="rep-all"' + (R.all ? " checked" : "") + "> All outlets</label>" : "") + "</div>";
    if (R.loading || !R.data) return head + '<div class="spinner"></div>';
    const a = summarize(R.data.cur), b = summarize(R.data.prev);
    const dishes = {}, hours = {};
    R.data.cur.filter((o) => o.status === "Delivered").forEach((o) => { (o.items || []).forEach((i) => { dishes[i.name] = (dishes[i.name] || 0) + Number(i.quantity || 1); }); const hr = new Date(placedAt(o)).getHours(); hours[hr] = (hours[hr] || 0) + 1; });
    const topDishes = Object.entries(dishes).sort((x, y) => y[1] - x[1]).slice(0, 8);
    const busy = Object.entries(hours).sort((x, y) => y[1] - x[1]).slice(0, 6).map((e) => [new Date(2000, 0, 1, Number(e[0])).toLocaleTimeString("en-IN", {hour: "numeric"}) + " – " + new Date(2000, 0, 1, Number(e[0]) + 1).toLocaleTimeString("en-IN", {hour: "numeric"}), e[1]]);
    const kpi = (label, val, d) => '<div class="kpi"><span>' + label + "</span><strong>" + val + "</strong>" + d + "</div>";
    return head + '<p class="small muted" style="margin:-6px 0 0">Compared with ' + (R.range === "today" ? "the same time on the same weekday last week" : R.range === "yesterday" ? "the same day last week" : "the period just before") + ". Sales are menu value of delivered orders.</p>" +
      '<div class="kpis">' + kpi("Sales", inr(a.sales), delta(a.sales, b.sales)) + kpi("Delivered orders", a.delivered, delta(a.delivered, b.delivered)) + kpi("Average order value", inr(Math.round(a.aov)), delta(a.aov, b.aov)) +
      kpi("Your earnings", a.earned ? inr(Math.round(a.earned)) : "—", a.earned ? delta(a.earned, b.earned) : "") + kpi("Rejected / cancelled", a.rejectRate.toFixed(1) + "%", delta(a.rejectRate, b.rejectRate, true)) +
      kpi("Average rating", a.ratedCount ? a.rating.toFixed(1) + " ★" : "—", '<span class="small muted">' + a.ratedCount + " rated orders</span>") + kpi("Customers", a.customers, '<span class="small muted">' + a.repeat + " ordered more than once</span>") + "</div>" +
      '<div class="card"><h2>' + (R.range === "today" || R.range === "yesterday" ? "Sales by hour" : "Sales by day") + "</h2>" + barChart(R.data.cur, R.data.from, R.data.to, R.range === "today" || R.range === "yesterday") + "</div>" +
      '<div class="split"><div class="card"><h2>Top dishes</h2>' + topList(topDishes, (n) => n + " sold") + '</div><div class="card"><h2>Busiest hours</h2>' + topList(busy, (n) => n + " orders") + "</div></div>";
  }

  // ---------- finance: payouts, invoices & taxes, UTR ----------
  // Weekly cycles run Monday to Sunday. Order money comes from each order's own
  // split (economics, orderTax). The bank reference (UTR) of each payout, the
  // TDS/TCS actually withheld and invoice numbers come from Scraveit's ledger
  // and tax records (getRestaurantSettlementSummary, getRestaurantTaxStatement);
  // like order actions, those calls need the website's App Check key.
  const FIN_TABS = [["payouts", "Payouts"], ["report", "Monthly report"], ["taxes", "Invoices & taxes"], ["utr", "UTR"], ["terms", "Terms explained"]];
  const WEEKS = 12;
  const METHODS = {neft: "NEFT", imps: "IMPS", upi: "UPI", rtgs: "RTGS", bank_transfer: "Bank transfer"};
  const STATES = {"01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
    "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
    "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep",
    "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory"};
  const deliveredAt = (o) => ms(o.deliveredAt) || placedAt(o);
  const mondayOf = (t) => { const d = startOfDay(t); return d - ((new Date(d).getDay() + 6) % 7) * DAY; };
  const rs = (paise) => Number(paise || 0) / 100;
  const fullDay = (t) => new Date(t).toLocaleDateString("en-IN", {day: "numeric", month: "short", year: "numeric"});
  const isoDay = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const stateName = (code) => (STATES[code] || "State") + " (" + (code || "—") + ")";
  const pct = (bps) => (Number(bps || 0) / 100).toLocaleString("en-IN", {maximumFractionDigits: 2}) + "%";
  const maskPan = (pan) => { const p = String(pan || "").toUpperCase(); return p.length === 10 ? p.slice(0, 5) + "XXXX" + p.slice(9) : ""; };
  const storeKind = () => { const t = String((outlet() && outlet().doc.storeType) || ""); return ["grocery", "dairy", "pharmacy", "other"].includes(t) ? t : "restaurant"; };
  const statement = (from, to) => call("getRestaurantTaxStatement", {restaurantId: state.rid, from, to});
  const kpiBox = (label, value, sub) => '<div class="kpi"><span>' + label + "</span><strong>" + value + '</strong><span class="small muted">' + sub + "</span></div>";
  const commissionInvoice = (row) => row ? (row.invoices || []).find((i) => i.kind === "scraveit_commission") || null : null;

  // One delivered order's money in rupees. GST lines only when GST was charged on the order.
  function orderMoney(o) {
    const e = o.economics || {}, c = e.customer || {}, r = e.restaurant || {}, t = o.orderTax || {};
    const gst = t.gstApplied === true, lines = gst && Array.isArray(t.services) ? t.services : [];
    const line = (k) => { const l = lines.find((s) => s && s.component === k); return l ? {base: rs(l.basePaise), rateBps: Number(l.rateBps || 0), gst: rs(l.gstPaise), cgst: rs(l.cgstPaise), sgst: rs(l.sgstPaise), igst: rs(l.igstPaise)} : null; };
    const items = c.itemSubtotalPaise != null ? rs(c.itemSubtotalPaise) : itemValue(o), discount = rs(c.restaurantDiscountPaise), comm = line("commission");
    return {items, discount, base: r.commissionBasePaise != null ? rs(r.commissionBasePaise) : items - discount, commission: rs(r.commissionPaise),
      commissionGst: r.commissionTaxPaise != null ? rs(r.commissionTaxPaise) : comm ? comm.gst : 0, rush: rs(r.rushFeeSharePaise), earned: earnings(o) || 0,
      commissionLine: comm, food: line("restaurant_service"), gst};
  }

  async function loadFinance() {
    const F = state.fin; F.loading = true; render();
    const from = mondayOf(Date.now()) - (WEEKS - 1) * 7 * DAY, to = Date.now() + 1;
    const jobs = [
      fetchOrders([state.rid], from - DAY, to).then((list) => { F.orders = list.filter((o) => deliveredAt(o) >= from); }, (e) => { F.orders = []; toast(friendly(e), true); }),
      db.collection("restaurantPayoutProfiles").doc(state.rid).get().then((s) => { F.profile = s.exists ? s.data() : null; }, () => { F.profile = null; }),
    ];
    if (WEB_CHECK) {
      jobs.push(call("getRestaurantSettlementSummary", {restaurantId: state.rid, ledgerLimit: 1000, historyLimit: 100}).then((r) => { F.settle = r; }, (e) => { F.serverErr = friendly(e); }));
      jobs.push(statement(from, to).then((r) => { F.stmt = r; }, (e) => { F.serverErr = friendly(e); }));
    }
    await Promise.all(jobs);
    F.loaded = true; F.loading = false; render();
  }

  // Money actually sent (with its bank reference), plus weekly runs that were held, newest first.
  function payouts() {
    const F = state.fin;
    const paid = ((F.settle && F.settle.settlementHistory) || []).filter((a) => a.activityType === "settlement")
      .map((a) => ({at: a.occurredAt, amount: -rs(a.payableMovementPaise), utr: a.referenceId || "", method: a.settlementMethod || "", status: "paid", reason: ""}));
    const held = ((F.stmt && F.stmt.payoutRuns) || []).filter((r) => r.status !== "completed")
      .map((r) => ({at: Date.parse(r.runDayKey + "T10:00:00+05:30") || 0, amount: rs(r.amountPaise), utr: "", method: r.method || "", status: "held", reason: r.reason || ""}));
    return paid.concat(held).sort((a, b) => b.at - a.at);
  }
  function payoutAccount() {
    const p = state.fin.profile; if (!p) return {label: "", sub: ""};
    const acct = String(p.bankAccountNumber || "").replace(/\s/g, "");
    if ((p.preferredMethod === "upi" || !acct) && p.upiId) return {label: "UPI", sub: String(p.upiId)};
    return acct ? {label: (p.bankName || "Bank") + " ••••" + acct.slice(-4), sub: p.bankIfsc ? "IFSC " + p.bankIfsc : ""} : {label: "", sub: ""};
  }

  function weekRows() {
    const F = state.fin, rows = {}, monday = mondayOf(Date.now()), list = payouts(), out = [];
    ((F.stmt && F.stmt.rows) || []).forEach((r) => { rows[r.orderId] = r; });
    for (let i = 0; i < WEEKS; i++) {
      const start = monday - i * 7 * DAY, end = start + 7 * DAY;
      const inWeek = (F.orders || []).filter((o) => deliveredAt(o) >= start && deliveredAt(o) < end);
      const w = {start, end, current: i === 0, orders: inWeek.filter((o) => o.status === "Delivered"), cancelled: inWeek.filter((o) => o.status === "Cancelled").length,
        items: 0, discount: 0, base: 0, commission: 0, commissionGst: 0, rush: 0, earned: 0, tds: 0, tcs: 0, cod: 0, adj: 0};
      w.orders.forEach((o) => {
        const m = orderMoney(o), r = rows[orderId(o)];
        ["items", "discount", "base", "commission", "commissionGst", "rush", "earned"].forEach((k) => { w[k] += m[k]; });
        if (r) { w.tds += rs(r.incomeTaxTdsPaise); w.tcs += rs(r.gstTcsPaise); }
        if (o.paymentMethod === "cod") w.cod += 1;
      });
      // Ads, refunds recovered, TDS refunded and other corrections, from the ledger.
      ((F.settle && F.settle.settlementHistory) || []).forEach((a) => {
        if (a.activityType !== "settlement" && a.occurredAt >= start && a.occurredAt < end) w.adj += rs(a.payableMovementPaise);
      });
      // Once this week's exact report is loaded, it is the figure.
      const L = F.wk[String(start)];
      w.net = L && L.data ? rs(L.data.periodNetPaise) : w.earned - w.tds - w.tcs + w.adj;
      // A payout sends the whole balance due, so a closed week is covered by the first payout after it ends.
      w.payout = w.current ? null : list.filter((p) => p.status === "paid" && p.at >= end).sort((a, b) => a.at - b.at)[0] || null;
      w.held = w.current ? null : list.find((p) => p.status === "held" && p.at >= end && p.at < end + 7 * DAY) || null;
      out.push(w);
    }
    return out;
  }
  function weekStatus(w) {
    const p = w.payout;
    if (w.current) return '<span class="pill state">In progress</span>';
    if (p) return '<span class="pill paid">Paid ' + h(dayLabel(p.at)) + "</span>";
    if (w.held) return '<span class="pill wait">Held</span>';
    if (!w.orders.length) return '<span class="pill done">No orders</span>';
    if (!WEB_CHECK) return '<span class="pill done">—</span>';
    return Date.now() < w.end + 7 * DAY ? '<span class="pill cod">Due</span>' : '<span class="pill wait">Not paid yet</span>';
  }

  function pageFinance() {
    const F = state.fin;
    if (!can("finance")) return '<div class="card empty"><strong>Finance is for owners, managers and staff given Payouts & invoices</strong>Ask the outlet owner for payouts and tax documents.</div>';
    const head = '<div class="tabs">' + FIN_TABS.map((t) => '<button class="tab' + (F.tab === t[0] ? " on" : "") + '" data-act="fin-tab" data-tab="' + t[0] + '">' + t[1] + "</button>").join("") + "</div>";
    if (!F.loaded && !F.loading) setTimeout(loadFinance, 0);
    if (!F.loaded) return head + '<div class="spinner"></div>';
    const server = !WEB_CHECK ? '<div class="notice warn">Bank references (UTR), the TDS and TCS withheld, and invoice numbers come from Scraveit\'s secure records and show here once the website\'s security check is switched on. Until then, amounts are worked out from your orders.</div>' :
      F.serverErr ? '<div class="notice warn">Some finance records didn\'t load: ' + h(F.serverErr) + "</div>" : "";
    return head + server + (F.tab === "taxes" ? pageTaxes() : F.tab === "utr" ? pageUtr() : F.tab === "report" ? pageMonthly() : F.tab === "terms" ? pageTerms() : pagePayouts());
  }

  // Founder 17 Nov 2026: weekly payouts go through Cashfree and the transfer fee of the
  // chosen method is taken from the payout, so the owner sees each method's fee before
  // choosing. Same table as the server and the apps (settings/payoutFees).
  const PAYOUT_FEE_DEFAULT = {deductFromPayout: true, gstBps: 1800, bands: [{upToPaise: 100000, neftPaise: 300, impsPaise: 600, upiPaise: 600}, {upToPaise: 2500000, neftPaise: 500, impsPaise: 800, upiPaise: 800}, {upToPaise: 0, neftPaise: 800, impsPaise: 1500, upiPaise: 1500}]};
  let payoutFeesAsked = false, payoutFees = null;
  function payoutFeeTable() {
    if (!payoutFeesAsked) {
      payoutFeesAsked = true;
      db.collection("settings").doc("payoutFees").get().then((snap) => {
        const d = snap.exists ? snap.data() : null;
        if (!d || !Array.isArray(d.bands) || !d.bands.length) return;
        payoutFees = {upiAvailable: d.upiAvailable === true, deductFromPayout: d.deductFromPayout !== false, gstBps: Number(d.gstBps) || 0,
          bands: d.bands.map((b) => ({upToPaise: Number(b.upToPaise) || 0, neftPaise: Number(b.neftPaise) || 0, impsPaise: Number(b.impsPaise) || 0, upiPaise: Number(b.upiPaise) || 0}))
            .sort((a, b) => (a.upToPaise || 1e15) - (b.upToPaise || 1e15))};
        render();
      }, () => {});
    }
    return payoutFees || PAYOUT_FEE_DEFAULT;
  }
  function payoutFeePaise(method, amountPaise, t) {
    const b = t.bands.find((x) => !x.upToPaise || amountPaise <= x.upToPaise) || t.bands[t.bands.length - 1];
    if (!b) return 0;
    const base = method === "neft" ? b.neftPaise : method === "imps" ? b.impsPaise : b.upiPaise;
    return Math.round(base * (10000 + t.gstBps) / 10000);
  }
  function payMethodCard() {
    const p = state.fin.profile || {};
    const t = payoutFeeTable(), example = 15000, ex = example * 100, owner = isOwner(), busy = state.fin.methodSaving;
    const hasBank = !!String(p.bankAccountNumber || "").trim() && !!p.bankIfsc, upiOpen = t.upiAvailable === true, hasUpi = upiOpen && !!String(p.upiId || "").trim();
    // UPI payouts are not offered by Cashfree from the wallet yet (18 Nov 2026): shown as "Available soon".
    const pick = p.preferredMethod === "upi" && !upiOpen ? "neft" : ["neft", "imps", "upi"].includes(p.preferredMethod) ? p.preferredMethod : "neft";
    const rows = [["neft", "Bank · NEFT", "Reaches the same day · lowest fee", hasBank, "Add your bank account below first"],
      ["imps", "Bank · IMPS", "Reaches in minutes", hasBank, "Add your bank account below first"],
      ["upi", "UPI", "Reaches in minutes", hasUpi, "Add your UPI ID below first"]];
    return '<div class="card paymethod-card"><div class="row between"><h2 style="margin:0">How you get paid</h2><span class="small muted">' +
      (owner ? "Pick one · see the fee first" : "Only the outlet owner can change this") + '</span></div><div class="paymethods">' +
      rows.map(([m, title, speed, ready, need]) => {
        if (m === "upi" && !upiOpen) return '<button type="button" class="paymethod soon" disabled><span class="pm-dot"></span><span class="pm-body"><strong>UPI</strong><span class="pm-speed">Available soon</span><span class="pm-fee">Use bank (NEFT or IMPS) for now</span></span></button>';
        let fee;
        if (!t.deductFromPayout) fee = '<span class="pm-fee">No fee · Scraveit pays it</span>';
        else {
          const bands = t.bands.map((b, i) => inr(payoutFeePaise(m, b.upToPaise || ((t.bands[i - 1] || {}).upToPaise || 0) + 1, t) / 100) + (b.upToPaise ? " up to " + inr(b.upToPaise / 100) : " above")).join(" · ");
          const f = payoutFeePaise(m, ex, t);
          fee = '<span class="pm-fee">Fee ' + bands + '</span><span class="pm-eg">On ' + inr(example) + " you get " + inr((ex - f) / 100) + " (fee " + inr(f / 100) + ")</span>";
        }
        const on = m === pick && (hasBank || hasUpi), off = !owner || busy || !ready || on;
        return '<button type="button" class="paymethod' + (on ? " on" : "") + '" data-act="pay-method" data-id="' + m + '"' + (off ? " disabled" : "") + '>' +
          '<span class="pm-dot"></span><span class="pm-body"><strong>' + title + (on ? ' <span class="pm-chosen">Chosen</span>' : "") + '</strong><span class="pm-speed">' + speed + "</span>" + fee +
          (!ready ? '<span class="pm-need">' + need + "</span>" : "") + "</span></button>";
      }).join("") + '</div><p class="small muted" style="margin:10px 0 0">The fee is the bank transfer charge, taken from your weekly payout. GST included.</p>' + bankForm(p, hasBank, hasUpi, owner) + "</div>";
  }
  function bankForm(p, hasBank, hasUpi, owner) {
    const F = state.fin, open = F.bankEdit || (owner && !hasBank && !hasUpi), acct = String(p.bankAccountNumber || "");
    const summary = (hasBank ? "Bank ••••" + h(acct.slice(-4)) + (p.bankIfsc ? " · " + h(p.bankIfsc) : "") : "No bank account") + " · " + (hasUpi ? "UPI " + h(p.upiId) : payoutFeeTable().upiAvailable === true ? "No UPI ID" : "UPI available soon");
    if (!owner) return '<p class="small muted" style="margin:8px 0 0">' + summary + "</p>";
    if (!open) return '<div class="row between bank-summary"><span class="small">' + summary + '</span><button type="button" class="btn small" data-act="bank-edit">Edit bank details</button></div>';
    const f = (name, label, value, extra) => '<div class="field"><label for="bk-' + name + '">' + label + '</label><input class="input" id="bk-' + name + '" name="' + name + '" value="' + h(value || "") + '"' + (extra || "") + "></div>";
    return '<form id="bank-form" class="bank-form"><h3 style="margin:0">Bank details</h3><p class="small muted" style="margin:0">Payouts go to this bank account every week. UPI payouts: available soon.</p><div class="bank-grid">' +
      // Only what the bank transfer uses: account number and IFSC. The name on the transfer is the outlet's.
      f("account", "Account number", acct, ' inputmode="numeric" autocomplete="off"') +
      f("ifsc", "IFSC", p.bankIfsc, ' placeholder="HDFC0001234" autocapitalize="characters" autocomplete="off" maxlength="11"') +
      (payoutFeeTable().upiAvailable === true ? f("upi", "UPI ID (optional)", p.upiId, ' placeholder="restaurant@okhdfcbank" autocapitalize="none" autocomplete="off"') : '<input type="hidden" name="upi" value="' + h(p.upiId || "") + '">') +
      '</div><div class="row" style="gap:8px"><button class="btn primary"' + (F.bankSaving ? " disabled" : "") + ">" + (F.bankSaving ? "Saving…" : "Save details") + "</button>" +
      (hasBank || hasUpi ? '<button type="button" class="btn" data-act="bank-cancel">Cancel</button>' : "") + "</div></form>";
  }
  async function saveBank(form) {
    const F = state.fin; if (!isOwner() || F.bankSaving) return;
    const v = (n) => String(form.elements[n].value || "").trim();
    const account = v("account").replace(/\s+/g, ""), ifsc = v("ifsc").toUpperCase(), upi = v("upi");
    if (!account && (!upi || payoutFeeTable().upiAvailable !== true)) return toast("Add your bank account.", true);
    if (account || ifsc) {
      if (!/^[0-9]{6,20}$/.test(account)) return toast("Enter a valid bank account number (6–20 digits).", true);
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return toast("Enter a valid IFSC, like HDFC0001234.", true);
    }
    if (upi && !/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/.test(upi)) return toast("Enter a valid UPI ID, like name@okhdfcbank.", true);
    const old = F.profile || {}, hasBank = !!account, method = old.preferredMethod;
    const preferredMethod = !hasBank ? "upi" : method === "upi" && (!upi || payoutFeeTable().upiAvailable !== true) ? "neft" : ["neft", "imps", "upi"].includes(method) ? method : "neft";
    const changes = {restaurantId: state.rid, bankAccountNumber: account, bankIfsc: ifsc, upiId: upi, preferredMethod,
      verificationStatus: preferredMethod === "upi" ? "upi_ready" : "bank_ready", updatedAt: Date.now(), updatedBy: state.user.uid};
    // A saved holder name stays; a new profile takes the outlet's name (payouts fall back to it anyway).
    const outletName = (outlet() && outlet().doc && outlet().doc.name) || "";
    if (!String(old.bankAccountHolderName || "").trim() && outletName) changes.bankAccountHolderName = outletName;
    F.bankSaving = true; render();
    try {
      await db.collection("restaurantPayoutProfiles").doc(state.rid).set(changes, {merge: true});
      F.profile = Object.assign({}, old, changes); F.bankEdit = false;
      toast("Bank details saved. Weekly payouts go here."); setTimeout(cpAfterSave, 600);
    } catch (e) { toast(friendly(e), true); }
    F.bankSaving = false; render();
  }
  // ---------- one owner, several outlets: copy owner, bank and tax details (22 Nov 2026) ----------
  // Founder: an owner with many outlets has the same owner, bank and legal details for all of them;
  // only the menu and photos differ. Fill them once, then copy. Each outlet keeps its name, menu,
  // photos, hours and phone. Rules let an owner read and write the payout profile of every outlet they own;
  // each copied profile is stamped copiedFrom {restaurantId, at, by}.
  const CP = {profiles: null, loading: null, busy: false, asked: ""};
  const CP_KEYS = ["legalBusinessName", "beneficiaryName", "bankAccountHolderName", "bankAccountNumber", "bankIfsc", "bankName", "branchName", "accountType", "preferredMethod", "upiId", "contactPhone", "contactEmail", "panNumber", "gstin", "verificationStatus"];
  const ownedOutlets = () => Object.values(state.outlets || {}).filter((o) => o.member && o.member.active === true && o.member.role === "restaurant_owner");
  const cpPan = (p) => String((p && (p.panNumber || (p.taxProfile || {}).pan)) || "").trim();
  const cpHas = (p) => !!(p && (String(p.bankAccountNumber || "").trim() || cpPan(p)));
  const cpFull = (p) => !!(p && String(p.bankAccountNumber || "").trim() && cpPan(p));
  function cpLoad() {
    if (CP.profiles) return Promise.resolve(CP.profiles);
    if (CP.loading) return CP.loading;
    const list = ownedOutlets(), out = {};
    CP.loading = Promise.all(list.map((o) => db.collection("restaurantPayoutProfiles").doc(o.id).get().then((x) => { out[o.id] = x.exists ? x.data() : null; }, () => { out[o.id] = null; })))
      .then(() => { CP.profiles = out; CP.loading = null; render(); return out; });
    return CP.loading;
  }
  function cpSummary(p) {
    const acct = String(p.bankAccountNumber || ""), t = p.taxProfile || {}, reg = {regular: "GST registered", composition: "GST composition", unregistered_eco: "No GST, e-commerce enrolled", unregistered: "No GST"}[t.registrationType] || (p.gstin ? "GST registered" : "");
    return [p.legalBusinessName || p.bankAccountHolderName, acct ? "Bank ••••" + acct.slice(-4) + (p.bankIfsc ? " · " + p.bankIfsc : "") : "No bank account", cpPan(p) ? "PAN ••••" + cpPan(p).slice(-4) : "No PAN", reg].filter(Boolean).join(" · ");
  }
  // The question on an outlet that is missing them while another of the owner's outlets has them.
  function cpAskHtml() {
    if (!isOwner() || ownedOutlets().length < 2) return "";
    if (!CP.profiles) { cpLoad(); return ""; }
    if (cpFull(CP.profiles[state.rid])) return "";
    const src = ownedOutlets().filter((o) => o.id !== state.rid && cpHas(CP.profiles[o.id])).sort((a, b) => Number(cpFull(CP.profiles[b.id])) - Number(cpFull(CP.profiles[a.id])))[0];
    if (!src) return "";
    return '<div class="notice info cp-ask"><span class="grow"><strong>Same owner as ' + h(src.doc.name) + "?</strong> Copy its owner, bank and PAN details here. Your menu and photos stay as they are.</span>" +
      '<button type="button" class="btn small primary" data-act="cp-open" data-id="' + h(src.id) + '">Copy details</button></div>';
  }
  function cpModal(from, preIds, afterSave) {
    const P = CP.profiles || {}, list = ownedOutlets(), sources = list.filter((o) => cpHas(P[o.id]));
    if (!sources.length) return toast("Add the bank details to one outlet first.", true);
    const src = sources.find((o) => o.id === from) || sources.find((o) => o.id === state.rid) || sources[0];
    const targets = list.filter((o) => o.id !== src.id).sort((a, b) => String(a.doc.name || "").localeCompare(String(b.doc.name || "")));
    const pre = new Set(preIds && preIds.length ? preIds : targets.filter((o) => !cpFull(P[o.id])).map((o) => o.id));
    const rows = targets.map((o) => { const p = P[o.id], acct = String((p && p.bankAccountNumber) || "");
      return '<label class="ol-check"><input type="checkbox" name="to" value="' + h(o.id) + '"' + (pre.has(o.id) ? " checked" : "") + "><span><strong>" + h(o.doc.name || o.id) + '</strong><span class="small muted">' +
        (cpFull(p) ? "Has bank ••••" + h(acct.slice(-4)) + " and PAN: they will be replaced" : cpHas(p) ? "Some details missing" : "No bank or PAN yet") + "</span></span></label>"; }).join("");
    const r = src.doc || {}, addr = [r.address, r.area, r.city].filter(Boolean).reduce((a, x) => a.toLowerCase().includes(String(x).toLowerCase()) ? a : a ? a + ", " + x : String(x), "");
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal" id="cp-form"><header><h2>' + (afterSave ? "Use these details for your other outlets?" : "Same details for your outlets") + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<p class="small muted" style="margin:0">Your outlets have the same owner, bank account and PAN. Fill them once and copy them here. Each outlet keeps its own name, menu, photos, hours and phone.</p>' +
      '<div class="field"><label for="cp-from">Copy from</label>' + (sources.length > 1 ? '<select class="input" id="cp-from" name="from" data-input="cp-from">' + sources.map((o) => '<option value="' + h(o.id) + '"' + (o.id === src.id ? " selected" : "") + ">" + h(o.doc.name || o.id) + "</option>").join("") + "</select>"
        : '<input type="hidden" name="from" value="' + h(src.id) + '"><strong>' + h(r.name || src.id) + "</strong>") + '<span class="small muted">' + h(cpSummary(P[src.id] || {})) + "</span></div>" +
      '<div class="field"><div class="row between"><label>Copy to</label>' + (targets.length > 2 ? '<button type="button" class="linklike" data-act="cp-all">Select all</button>' : "") + '</div><div class="cp-list">' + rows + "</div></div>" +
      (wmPoint(r.lat, r.lng) ? '<label class="ol-check"><input type="checkbox" name="place"><span><strong>Also copy the address and map pin</strong><span class="small muted">' + h(addr || "Same kitchen") + ". Only for outlets in the same kitchen.</span></span></label>" : "") +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">' + (afterSave ? "Not now" : "Cancel") + '</button><button class="btn primary grow" type="submit" id="cp-go">Copy details</button></div></form></div>';
    cpCount();
  }
  function cpCount() {
    const f = document.getElementById("cp-form"), b = document.getElementById("cp-go"); if (!f || !b || CP.busy) return;
    const n = f.querySelectorAll('input[name="to"]:checked').length; b.disabled = !n; b.textContent = n ? "Copy to " + n + (n === 1 ? " outlet" : " outlets") : "Pick an outlet";
  }
  async function cpCopy(form) {
    if (CP.busy) return;
    const owned = new Map(ownedOutlets().map((o) => [o.id, o])), from = String(form.elements.namedItem("from").value || ""), place = !!(form.elements.namedItem("place") || {}).checked;
    const ids = [...form.querySelectorAll('input[name="to"]:checked')].map((x) => x.value).filter((id) => id !== from && owned.has(id));
    if (!owned.has(from) || !ids.length) return toast("Pick at least one outlet.", true);
    CP.busy = true; const b = document.getElementById("cp-go"); if (b) { b.disabled = true; b.textContent = "Copying…"; }
    let done = 0;
    try {
      const snap = await db.collection("restaurantPayoutProfiles").doc(from).get(), src = snap.exists ? snap.data() : null;
      if (!cpHas(src)) throw new Error("That outlet has no bank or PAN details to copy.");
      const r = owned.get(from).doc || {}, pin = wmPoint(r.lat, r.lng), now = Date.now(), by = state.user.uid;
      for (const id of ids) {
        const cur = (CP.profiles && CP.profiles[id]) || {}, changes = {restaurantId: id, copiedFrom: {restaurantId: from, at: now, by}, updatedAt: now, updatedBy: by};
        // Only what the source has: an empty field there never wipes one here.
        CP_KEYS.forEach((k) => { const v = src[k]; if (v != null && String(v).trim() !== "") changes[k] = v; });
        if (src.taxProfile && typeof src.taxProfile === "object") changes.taxProfile = Object.assign({}, src.taxProfile, {invoicePrefix: String((cur.taxProfile || {}).invoicePrefix || ""), updatedAt: now});
        await db.collection("restaurantPayoutProfiles").doc(id).set(changes, {merge: true});
        if (CP.profiles) CP.profiles[id] = Object.assign({}, cur, changes);
        if (place && pin) {
          const loc = {lat: pin.lat, lng: pin.lng, updatedAt: now, updatedBy: state.user.email || by};
          ["address", "area", "city", "pincode"].forEach((k) => { if (r[k] != null && String(r[k]).trim() !== "") loc[k] = r[k]; });
          await db.collection("restaurants").doc(id).update(loc); Object.assign(owned.get(id).doc, loc);
        }
        done++;
      }
      if (ids.includes(state.rid) && state.fin.profile !== undefined) state.fin.profile = Object.assign({}, state.fin.profile || {}, CP.profiles ? CP.profiles[state.rid] : {});
      CP.busy = false; closeModal(); toast("Details copied to " + done + (done === 1 ? " outlet." : " outlets."));
    } catch (e) {
      CP.busy = false; toast((done ? "Copied to " + done + ", then stopped. " : "") + friendly(e), true); cpCount();
    }
    render();
  }
  // After this outlet's bank or tax details are saved: offer them to the owner's outlets that don't have them.
  function cpAfterSave() {
    if (!isOwner() || ownedOutlets().length < 2) return;
    const rid = state.rid, mine = state.fin.profile;
    cpLoad().then((P) => {
      P[rid] = Object.assign({}, P[rid] || {}, mine || {});
      const missing = ownedOutlets().filter((o) => o.id !== rid && !cpFull(P[o.id])).map((o) => o.id);
      if (state.rid === rid && missing.length && cpHas(P[rid]) && !modalRoot.innerHTML) cpModal(rid, missing, true);
      else render();
    });
  }
  async function savePayMethod(method) {
    const F = state.fin, p = F.profile;
    if (!p || !isOwner() || F.methodSaving || p.preferredMethod === method) return;
    F.methodSaving = true; render();
    try {
      const changes = {preferredMethod: method, updatedAt: Date.now(), updatedBy: state.user.uid};
      await db.collection("restaurantPayoutProfiles").doc(state.rid).update(changes);
      F.profile = Object.assign({}, p, changes);
      toast("Payouts will now be sent by " + (method === "upi" ? "UPI" : method.toUpperCase()) + ".");
    } catch (e) { toast(friendly(e), true); }
    F.methodSaving = false; render();
  }

  function pagePayouts() {
    const F = state.fin, W = weekRows(), s = F.settle, last = payouts().find((p) => p.status === "paid"), acct = payoutAccount();
    if (!F.week) F.week = String(W[1].start);
    const sel = W.find((w) => String(w.start) === F.week) || W[1];
    const auto = s && s.automation, balance = s && s.complete && s.pendingSettlementPaise != null ? inr(rs(s.pendingSettlementPaise)) : "—";
    return '<div class="kpis">' + kpiBox("This week so far", inr(W[0].net), W[0].orders.length + " delivered orders · after commission" + (F.stmt ? " and TDS" : "")) +
      kpiBox("Balance due to you", balance, !WEB_CHECK ? "From Scraveit's ledger" : !s ? "Couldn't load" : !s.complete ? "Being checked by Scraveit finance" : auto && auto.enabled && auto.scheduleLabel ? "Paid every " + h(auto.scheduleLabel.replace(/\s*\(Asia\/Kolkata\)$/, "")) : "Paid weekly") +
      kpiBox("Last payout", last ? inr(last.amount) : "—", last ? h(fullDay(last.at)) + (last.utr ? " · UTR " + h(last.utr) : "") : WEB_CHECK ? "No payouts yet" : "From Scraveit's ledger") +
      kpiBox("Paid to", acct.label ? h(acct.label) : "Not set", acct.label ? h(acct.sub) : '<span style="color:var(--bad)">Add your bank account below, or payouts are held</span>') + "</div>" + cpAskHtml() + payMethodCard() +
      '<div class="split fin"><div class="card" style="padding:0;overflow:auto"><div class="row between" style="padding:14px 16px"><h2 style="margin:0">Weekly payouts</h2><span class="small muted">Monday to Sunday · pick a week</span></div>' +
      '<table class="table"><thead><tr><th>Week</th><th class="num">Orders</th><th class="num">Item total</th><th class="num">Commission + GST</th><th class="num">TDS + TCS</th><th class="num">Your payout</th><th>Status</th></tr></thead><tbody>' +
      W.map((w) => '<tr class="clickable' + (w === sel ? " sel" : "") + '" data-act="fin-week" data-id="' + w.start + '"><td class="nowrap">' + h(dayLabel(w.start)) + " – " + h(dayLabel(w.end - DAY)) + '</td><td class="num">' + w.orders.length +
        '</td><td class="num">' + inr(w.items) + '</td><td class="num">' + inr(w.commission + w.commissionGst) + '</td><td class="num">' + (F.stmt ? inr(w.tds + w.tcs) : "—") +
        '</td><td class="num"><strong>' + inr(w.net) + "</strong></td><td>" + weekStatus(w) + "</td></tr>").join("") + "</tbody></table></div>" + weekStatement(sel) + "</div>";
  }
  function statementLines(w) {
    const F = state.fin, rate = w.base ? w.commission / w.base * 100 : 0;
    const line = (label, v, cls) => "<div" + (cls ? ' class="' + cls + '"' : "") + "><span>" + label + "</span><span>" + v + "</span></div>";
    return '<div class="bill">' + line("Item total (your menu prices)", inr(w.items)) + (w.discount ? line("− Discounts you funded", "−" + inr(w.discount)) : "") +
      line("Value the commission is on", inr(w.base), "sub") + line("− Scraveit commission" + (rate ? " (" + (Math.round(rate * 10) / 10) + "%)" : ""), "−" + inr(w.commission)) +
      line("− GST on commission (18%)", "−" + inr(w.commissionGst)) + (w.rush ? line("+ Your share of busy-kitchen fees", inr(w.rush)) : "") +
      line("Your earnings", inr(w.earned), "tot") + line("− Income-tax TDS", F.stmt ? "−" + inr(w.tds) : "—") +
      (w.tcs || storeKind() !== "restaurant" ? line("− GST TCS", F.stmt ? "−" + inr(w.tcs) : "—") : "") +
      (w.adj ? line("± Ads, refunds recovered and other adjustments", (w.adj < 0 ? "−" : "+") + inr(Math.abs(w.adj))) : "") + line(F.stmt ? "Net payout" : "Net payout, before TDS", inr(w.net), "tot") + "</div>";
  }
  function weekStatement(w) {
    const F = state.fin, p = w.payout, acct = payoutAccount(), L = weekLedger(w);
    let pay = w.held ? '<div class="notice warn small">' + h(w.held.reason || "Held: Scraveit finance will contact you.") + "</div>" : "";
    if (w.current) pay = '<div class="notice info small">This week is still running. It\'s paid in the first payout after Sunday.</div>';
    else if (p) pay += '<div class="notice info small"><div>Paid ' + h(fullDay(p.at)) + (p.method ? " by " + h(METHODS[p.method] || p.method) : "") + (p.utr ? ' · UTR <strong class="utr">' + h(p.utr) + "</strong>" : "") + (acct.label ? " · " + h(acct.label) : "") +
      (Math.abs(p.amount - w.net) > 0.5 ? '<div class="small muted">That payout was ' + inr(p.amount) + ": the whole balance due on that day, which can cover more than one week.</div>" : "") + "</div></div>";
    return '<div class="card detail"><div class="row between"><h2 style="margin:0">Payout statement</h2><span class="small muted">' + h(fullDay(w.start)) + " – " + h(fullDay(w.end - DAY)) + "</span></div>" +
      '<p class="small muted" style="margin:6px 0 12px">' + w.orders.length + " delivered (" + w.cod + " cash, " + (w.orders.length - w.cod) + " online)" + (w.cancelled ? " · " + w.cancelled + " rejected or cancelled, not paid" : "") + "</p>" +
      (L && L.data ? ledgerLines(L.data, w) + (w.held ? pay : "") : (L && L.loading ? '<div class="spinner"></div>' : "") + statementLines(w) + pay + (L && L.err ? '<div class="notice warn small">Exact figures didn\'t load: ' + h(L.err) + "</div>" : "")) +
      '<div class="row" style="margin-top:12px">' + (L && L.data ? '<button class="btn small" data-act="fin-orders">Orders and the payout that paid them</button>' : "") + '<button class="btn small" data-act="fin-annex"' + (w.orders.length ? "" : " disabled") + '>Order-wise annexure (CSV)</button><button class="btn small" data-act="fin-print">Print statement</button></div>' +
      '<p class="small muted" style="margin:10px 0 0">Customers\' GST on your food is paid by Scraveit under section 9(5) and isn\'t part of your payout.' + (F.stmt && !F.stmt.tdsActive ? " Income-tax TDS isn't being deducted yet." : "") + "</p></div>";
  }
  function annexureRows(w) {
    const rows = {}, led = {}, L = state.fin.wk[String(w.start)]; ((state.fin.stmt && state.fin.stmt.rows) || []).forEach((r) => { rows[r.orderId] = r; });
    ((L && L.data && L.data.orders) || []).forEach((r) => { led[r.orderId] = r; });
    return [["Order ID", "Placed", "Delivered", "Payment", "Item total", "Your discount", "Commission on", "Commission %", "Commission", "GST on commission", "Busy-kitchen share", "Your earnings", "TDS", "TCS", "Refund recovered", "Net payout", "Settlement status", "Paid on", "Bank UTR", "Commission invoice no."]].concat(w.orders.map((o) => {
      const m = orderMoney(o), r = rows[orderId(o)] || null, l = led[orderId(o)] || null, tds = l ? rs(l.tdsPaise) : r ? rs(r.incomeTaxTdsPaise) : 0, tcs = l ? rs(l.tcsPaise) : r ? rs(r.gstTcsPaise) : 0, inv = commissionInvoice(r);
      return [orderId(o), new Date(placedAt(o)).toLocaleString("en-IN"), new Date(deliveredAt(o)).toLocaleString("en-IN"), o.paymentMethod === "cod" ? "Cash" : "Online", m.items, m.discount, m.base,
        m.base ? (m.commission / m.base * 100).toFixed(2) : "", m.commission, m.commissionGst, m.rush, m.earned, r || l ? tds : "", r || l ? tcs : "", l ? rs(l.refundRecoveredPaise) : "",
        l ? rs(l.netPaise) : r ? Math.round((m.earned - tds - tcs) * 100) / 100 : "", l ? settledText(l.settlement) : "", l && l.settlement.at ? fullDay(l.settlement.at) : "", l ? l.settlement.utr : "", inv ? inv.invoiceNo : ""];
    }));
  }
  function printDoc(title, inner) {
    const win = window.open("", "_blank");
    if (!win) { toast("Allow pop-ups for this site to print.", true); return; }
    const css = (document.querySelector('link[href*="partner"]') || {}).href || "";
    win.document.write('<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><title>' + h(title) + '</title><link rel="stylesheet" href="' + h(css) + '"></head><body class="printable"><div class="no-print"><button class="btn primary" onclick="print()">Print or save as PDF</button></div>' + inner + "</body></html>");
    win.document.close();
  }
  // ---------- receipt printer: auto-print on Accept ----------
  // Same kitchen slip and bill as the Restaurant app. A website can't talk to a
  // Bluetooth printer directly, so it prints through the computer's printer
  // (USB, Bluetooth or Wi-Fi receipt printer installed in Windows/Mac). Chrome
  // started with --kiosk-printing prints with no print window at all.
  const PRINTER_KEY = "scraveit.partner.printer", PRINTED_KEY = "scraveit.partner.printed";
  function printerSettings() { let p = {}; try { p = JSON.parse(localStorage.getItem(PRINTER_KEY) || "{}") || {}; } catch (_) {} return {auto: p.auto === true, kitchen: p.kitchen !== false, bill: p.bill !== false, paper: p.paper === 80 ? 80 : 58}; }
  function savePrinterSettings(next) { try { localStorage.setItem(PRINTER_KEY, JSON.stringify(Object.assign(printerSettings(), next))); } catch (_) {} }
  const rupees = (p) => (Number(p || 0) / 100).toFixed(2);
  const itemVariant = (i) => { const v = i && (i.variantName || i.variant); return typeof v === "string" ? v : v && typeof v.name === "string" ? v.name : ""; };
  function billModel(o) {
    const d = (outlet() && outlet().doc) || {}, e = o.economics, terms = e && e.calculationVersion === 1 && e.restaurant && e.customer ? e : null, items = o.items || [], placed = placedAt(o);
    const unit = (i) => i.restaurantPrice != null ? Number(i.restaurantPrice) : Number(i.price || 0) + Number(i.variantPrice || 0) + Number(i.addOnTotal || 0);
    const lineTotal = (i) => unit(i) * Number(i.quantity || 1), mk = o.pricing && o.pricing.markup, inc = !!(mk && mk.model === "inclusive");
    const P = [], row = (l, v, cls) => P.push(["row", l, v, cls || ""]), rule = () => P.push(["rule"]), note = (t) => P.push(["note", t]);
    if (mk && !inc) {
      const own = terms ? Number(terms.customer.restaurantDiscountPaise || 0) : 0, payout = terms ? Number(terms.restaurant.receivablePaise || 0) : Math.round(Number(mk.restaurantPayout || 0) * 100), gstIn = Math.round(Number(mk.restaurantSubtotal || 0) * 100) - payout - own;
      row("Your price total (GST incl.)", "₹" + Number(mk.restaurantSubtotal || 0).toFixed(2)); row("GST inside (5%, paid by Scraveit)", "-₹" + rupees(gstIn));
      if (own) row("Discount (your offer)", "-₹" + rupees(own));
      rule(); row("YOU RECEIVE", "₹" + rupees(payout), "total");
      note("Customers paid your prices plus " + String(Number(mk.bps || 0) / 100) + "%. No commission or GST on commission is taken from you.");
    } else if (terms) {
      const c = terms.customer, t = terms.restaurant, pct = (Number(t.commissionBps || 0) / 100).toFixed(2).replace(/\.00$/, "");
      if (inc) { row("Your price total (GST incl.)", "₹" + Number(mk.restaurantSubtotal || 0).toFixed(2)); row("GST inside (5%, paid by Scraveit)", "-₹" + rupees(Math.round(Number(mk.restaurantSubtotal || 0) * 100) - Number(c.itemSubtotalPaise || 0))); }
      row(inc ? "Item total (before GST)" : "Item total", "₹" + rupees(c.itemSubtotalPaise));
      if (c.restaurantDiscountPaise) row("Discount (your offer)", "-₹" + rupees(c.restaurantDiscountPaise));
      row("Your food total", "₹" + rupees(t.commissionBasePaise), "strong");
      if (c.platformDiscountPaise) note("Scraveit offer of ₹" + rupees(c.platformDiscountPaise) + " is paid by Scraveit, not taken from you.");
      rule(); P.push(["head", "YOUR SETTLEMENT"]);
      row("Scraveit commission (" + pct + "%)", "-₹" + rupees(t.commissionPaise));
      if (t.commissionTaxPaise) row("GST on commission", "-₹" + rupees(t.commissionTaxPaise));
      if (t.rushFeeSharePaise) row("Busy-kitchen fee (your share)", "+₹" + rupees(t.rushFeeSharePaise));
      rule(); row("YOU RECEIVE", "₹" + rupees(t.receivablePaise), "total");
    } else { row("Item total", "₹" + items.reduce((sum, i) => sum + lineTotal(i), 0).toFixed(2), "strong"); note("This order has no locked settlement terms. See your settlement statement for its payout."); }
    const paid = ["paid", "captured", "settled"].includes(String(o.paymentState || ""));
    return {tag: o.paymentMethod === "cod" ? "CASH ON DELIVERY" : paid ? "PAID ONLINE" : "ONLINE PAYMENT", store: d.name || "Your store", address: d.address || "", id: orderId(o),
      placed: placed ? new Date(placed).toLocaleString("en-IN", {day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"}) : "",
      who: firstName(o) + (area(o) ? " · " + area(o) : ""), items: items.map((i) => ({name: (i.name || "Item") + (itemVariant(i) ? " (" + itemVariant(i) + ")" : ""), qty: Number(i.quantity || 1), amount: lineTotal(i)})),
      totalQty: items.reduce((sum, i) => sum + Number(i.quantity || 1), 0), money: P,
      gstNote: storeKind() === "restaurant" ? "GST on food is collected and paid by Scraveit, the e-commerce operator, under section 9(5) of the CGST Act." : ""};
  }
  function kitchenPrintLines(o) {
    const items = o.items || [], placed = placedAt(o), L = [];
    L.push({t: storeKind() === "restaurant" ? "KITCHEN ORDER" : "PACKING SLIP", a: 1, b: 1}); L.push({t: "#" + shortId(o), a: 1, b: 1, big: 1}); L.push({t: orderId(o), a: 1});
    L.push({t: (placed ? new Date(placed).toLocaleString("en-IN", {day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"}) + " · " : "") + (o.deliveryMode === "pickup" ? "Pickup" : "Delivery"), a: 1});
    L.push({rule: 1});
    items.forEach((i) => { L.push({t: Number(i.quantity || 1) + " x " + (i.name || "Item"), b: 1, big: 1});
      const v = itemVariant(i); if (v) L.push({t: "   (" + v + ")"});
      if ((i.addOns || []).length) L.push({t: "   + " + i.addOns.map((a) => a && (a.name || a)).filter(Boolean).join(", ")});
      if (i.note) L.push({t: "   Note: " + i.note, b: 1}); });
    L.push({rule: 1}); L.push({l: "Total items", r: String(items.reduce((sum, i) => sum + Number(i.quantity || 1), 0)), b: 1}); L.push({cut: 1});
    return L;
  }
  function billPrintLines(o) {
    const m = billModel(o), L = [];
    L.push({t: m.tag, a: 1, b: 1}); L.push({t: m.store, a: 1, b: 1, big: 1}); if (m.address) L.push({t: m.address, a: 1});
    L.push({rule: 1}); L.push({t: "Order via Scraveit", a: 1, b: 1}); L.push({t: m.id, a: 1, b: 1});
    if (m.placed) L.push({t: m.placed, a: 1}); L.push({t: m.who, a: 1}); L.push({t: "DELIVERY", a: 1, b: 1}); L.push({rule: 1});
    m.items.forEach((i) => L.push({l: i.qty + " x " + i.name, r: i.amount.toFixed(2)}));
    L.push({rule: 1}); L.push({l: "Total qty", r: String(m.totalQty)});
    m.money.forEach((p) => { if (p[0] === "row") L.push({l: p[1], r: p[2], b: p[3] ? 1 : 0}); else if (p[0] === "rule") L.push({rule: 1}); else if (p[0] === "head") L.push({t: p[1], a: 1, b: 1}); else L.push({t: p[1], small: 1}); });
    if (m.gstNote) L.push({t: m.gstNote, small: 1});
    L.push({rule: 1}); L.push({t: "Thank you · scraveit.in", a: 1}); L.push({cut: 1});
    return L;
  }
  function receiptHtml(lines) {
    const slips = [[]]; lines.forEach((x) => { if (x.cut) slips.push([]); else slips[slips.length - 1].push(x); });
    return slips.filter((s) => s.length).map((s) => '<div class="slip">' + s.map((x) => {
      const cls = [x.a === 1 ? "c" : "", x.b ? "b" : "", x.big ? "big" : "", x.small ? "small" : ""].filter(Boolean).join(" ");
      if (x.rule) return '<div class="rule"></div>';
      if (x.l != null) return '<div class="r' + (cls ? " " + cls : "") + '"><span>' + h(x.l) + "</span><span>" + h(x.r) + "</span></div>";
      return '<div' + (cls ? ' class="' + cls + '"' : "") + ">" + h(x.t) + "</div>";
    }).join("") + "</div>").join("");
  }
  function printReceipt(lines) {
    const w = printerSettings().paper, css = "@page{margin:0}html,body{margin:0;background:#fff;color:#000}body{width:" + (w === 80 ? 72 : 48) + "mm;padding:2mm " + (w === 80 ? 4 : 5) + "mm;font:" + (w === 80 ? 13 : 12) + "px/1.35 'Courier New',monospace}" +
      ".c{text-align:center}.b{font-weight:700}.big{font-size:1.5em;font-weight:700}.small{font-size:.88em}.r{display:flex;justify-content:space-between;gap:6px}.r span:last-child{white-space:nowrap}.rule{border-top:1px dashed #000;margin:4px 0}.slip{padding-bottom:6mm}.slip+.slip{break-before:page}";
    const f = document.createElement("iframe"); f.setAttribute("aria-hidden", "true"); f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.appendChild(f);
    const d = f.contentDocument; d.open(); d.write('<!doctype html><html><head><meta charset="utf-8"><title>Scraveit</title><style>' + css + "</style></head><body>" + receiptHtml(lines) + "</body></html>"); d.close();
    setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (_) { toast("Could not open printing in this browser.", true); } setTimeout(() => f.remove(), 60000); }, 300);
  }
  function printedOrders() { let all = {}; try { all = JSON.parse(localStorage.getItem(PRINTED_KEY) || "{}") || {}; } catch (_) {} const now = Date.now(), kept = {}; Object.keys(all).forEach((k) => { if (now - Number(all[k]) < 2 * DAY) kept[k] = all[k]; }); return kept; }
  function markPrinted(id) { try { const all = printedOrders(); all[id] = Date.now(); localStorage.setItem(PRINTED_KEY, JSON.stringify(all)); } catch (_) {} }
  // Called once an order is accepted on this computer.
  function autoPrintOrder(o) { const p = printerSettings(), id = orderId(o); if (!p.auto || (!p.kitchen && !p.bill) || printedOrders()[id]) return; markPrinted(id); printReceipt([].concat(p.kitchen ? kitchenPrintLines(o) : [], p.bill ? billPrintLines(o) : [])); }
  function printerModal() {
    const p = printerSettings(), chk = (k, on, label, copy) => '<label class="row" style="align-items:flex-start;gap:10px;justify-content:flex-start"><input type="checkbox" data-act="printer-opt" data-key="' + k + '"' + (on ? " checked" : "") + ' style="margin-top:3px"><span><strong>' + h(label) + '</strong><div class="small muted">' + h(copy) + "</div></span></label>";
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="Printer"><header><h2>Receipt printer</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<p class="small muted" style="margin:0">Uses the printer installed on this computer (USB, Bluetooth or Wi-Fi). Settings are for this computer only.</p>' +
      chk("auto", p.auto, "Print automatically when I accept", "Orders accepted on another computer or phone don't print here.") +
      chk("kitchen", p.kitchen, "Kitchen slip", "Dishes and quantity for the cook, no prices.") +
      chk("bill", p.bill, "Bill", "Order ID, dishes and what you receive. Stick it on the parcel.") +
      '<div><strong>Paper width</strong><div class="small muted">Written on the paper roll box.</div><div class="row" style="justify-content:flex-start;margin-top:8px"><button class="btn small' + (p.paper === 58 ? " primary" : "") + '" data-act="printer-paper" data-id="58">58 mm</button><button class="btn small' + (p.paper === 80 ? " primary" : "") + '" data-act="printer-paper" data-id="80">80 mm</button></div></div>' +
      '<details><summary class="small"><strong>Print without the print window</strong></summary><ol class="small" style="margin:8px 0 0;padding-left:18px"><li>Make the receipt printer the computer\'s default printer.</li><li>Use Google Chrome. Right-click its desktop shortcut → Properties, and add <code>--kiosk-printing</code> at the end of Target.</li><li>Open Chrome from that shortcut. Slips now print straight away.</li></ol><p class="small muted" style="margin:6px 0 0">Without this, Chrome shows the print window: pick the receipt printer once and press Print; Chrome remembers it.</p></details>' +
      '<div class="row"><button class="btn primary" data-act="printer-test">Print a test slip</button></div></div></div>';
  }
  function printerTestLines() { const p = printerSettings(); return [{t: "SCRAVEIT", a: 1, b: 1, big: 1}, {t: "Printer test", a: 1, b: 1}, {rule: 1}, {l: "Paper", r: p.paper + " mm"}, {l: "1 x Idli", r: "30.00"}, {l: "2 x Bean Vanilla Waffle with extra chocolate", r: "154.00"}, {l: "YOU RECEIVE", r: "₹184.00", b: 1}, {rule: 1}, {t: "If every line fits, you are set.", a: 1}, {cut: 1}]; }
  function printStatement(w) {
    const o = outlet(), prof = state.fin.profile || {}, p = w.payout, rows = annexureRows(w);
    printDoc("Payout statement " + isoDay(w.start), '<div class="doc"><div class="row between"><div><div class="wordmark">scraveit<span>*</span></div><div class="small muted">Weekly payout statement</div></div><div class="num"><strong>' + h(fullDay(w.start)) + " – " + h(fullDay(w.end - DAY)) + "</strong></div></div>" +
      '<p><strong>' + h(prof.legalBusinessName || o.doc.name) + "</strong>" + (prof.legalBusinessName ? " (" + h(o.doc.name) + ")" : "") + "<br>Outlet ID " + h(o.id) + (prof.gstin ? " · GSTIN " + h(prof.gstin) : "") + "</p>" + (state.fin.wk[String(w.start)] && state.fin.wk[String(w.start)].data ? ledgerLines(state.fin.wk[String(w.start)].data, w) : statementLines(w)) +
      (p && p.status === "paid" ? "<p>Paid " + h(fullDay(p.at)) + (p.method ? " by " + h(METHODS[p.method] || p.method) : "") + (p.utr ? " · UTR " + h(p.utr) : "") + "</p>" : "") +
      '<table class="table"><thead><tr>' + [0, 2, 4, 8, 9, 11, 12, 14].map((i) => "<th>" + h(rows[0][i]) + "</th>").join("") + "</tr></thead><tbody>" +
      rows.slice(1).map((r) => "<tr>" + [0, 2, 4, 8, 9, 11, 12, 14].map((i) => '<td class="' + (i >= 4 ? "num" : "") + '">' + h(typeof r[i] === "number" ? inr(r[i]) : r[i]) + "</td>").join("") + "</tr>").join("") + "</tbody></table>" +
      '<p class="small muted">Generated from Scraveit\'s records on ' + h(new Date().toLocaleString("en-IN")) + ". Customers' GST on food is paid by Scraveit under section 9(5) of the CGST Act.</p></div>");
  }

  // ---------- finance: the ledger report ----------
  // Exact figures from Scraveit's books (getRestaurantPayoutReport): the
  // balance carried in, every deduction and addition, each payout's UTR, and
  // which payout paid each order. The order-by-order money split (commission,
  // GST, discounts) still comes from each order's own record.
  const payoutReport = (from, to) => call("getRestaurantPayoutReport", {restaurantId: state.rid, from, to});
  const SETTLED = {paid: ["paid", "Paid"], part_paid: ["cod", "Part paid"], pending: ["state", "Pending"]};
  function settledCell(s) {
    const k = SETTLED[(s && s.status) || "pending"] || SETTLED.pending;
    return '<span class="pill ' + k[0] + '">' + k[1] + "</span>" + (s && s.at ? '<div class="small muted nowrap">' + h(fullDay(s.at)) + "</div>" + (s.utr ? '<div class="small utr">' + h(s.utr) + "</div>" : "") : "");
  }
  const settledText = (s) => s ? (SETTLED[s.status] || SETTLED.pending)[1] : "";
  function weekLedger(w) {
    if (!WEB_CHECK) return null;
    const F = state.fin, key = String(w.start);
    if (!F.wk[key]) {
      F.wk[key] = {loading: true};
      setTimeout(() => payoutReport(w.start, w.end).then((r) => { F.wk[key] = {data: r}; render(); }, (e) => { F.wk[key] = {err: friendly(e)}; render(); }), 0);
    }
    return F.wk[key];
  }
  const BASIS = {after_payout: "left after your last payout", from_start: "since your first order", unknown: "not known: older than six weeks"};
  const LINE_LABEL = {order: "Order earnings", tax_withheld: "TDS / TCS withheld", tax_returned: "TDS / TCS returned (order refunded)", refund_recovery: "Customer refund recovered",
    ads: "Ads: top placement (incl. GST)", ads_refund: "Ads refunded (cancelled before start)", tds_commission_refund: "TDS on commission refunded to you", delivery: "Delivery you did yourself", other: "Other adjustment"};
  const money = (paise, plus) => { const v = rs(paise); return v < 0 ? "−" + inr(-v) : (plus && v > 0 ? "+" : "") + inr(v); };
  function ledgerLines(r, w) {
    const T = r.totals, row = (label, paise, cls) => "<div" + (cls ? ' class="' + cls + '"' : "") + "><span>" + label + "</span><span>" + (paise == null ? "—" : money(paise)) + "</span></div>";
    const opt = (label, k) => T[k] && T[k].paise ? row(label + (T[k].count > 1 ? " (" + T[k].count + ")" : ""), T[k].paise) : "";
    const inPeriod = r.payouts.filter((p) => p.at >= r.from && p.at < r.to);
    const split = w && w.orders.length ? row("Item total " + inr(w.items) + (w.discount ? " − your discounts " + inr(w.discount) : "") + " − commission " + inr(w.commission) +
      " − GST on it " + inr(w.commissionGst) + (w.rush ? " + busy-kitchen share " + inr(w.rush) : ""), null, "sub").replace("<span>—</span>", "<span></span>") : "";
    return '<div class="bill">' + row("Balance carried in (" + BASIS[r.opening.basis] + ")", r.opening.balancePaise, "sub") +
      row("+ Your earnings on " + T.order.count + (T.order.count === 1 ? " order" : " orders"), T.order.paise) + split +
      row("− Income-tax TDS", -r.tdsPaise) + (r.tcsPaise || storeKind() !== "restaurant" ? row("− GST TCS", -r.tcsPaise) : "") +
      opt("+ TDS / TCS returned on refunded orders", "tax_returned") + opt("− Customer refunds recovered", "refund_recovery") +
      opt("− Ads: top placement (incl. 18% GST)", "ads") + opt("+ Ads refunded", "ads_refund") + opt("+ TDS on commission refunded to you", "tds_commission_refund") +
      opt("+ Delivery you did yourself", "delivery") + opt("± Other adjustments", "other") +
      row("Net for this period", r.periodNetPaise, "tot") +
      inPeriod.map((p) => row("− Paid " + h(fullDay(p.at)) + (p.method ? " by " + h(METHODS[p.method] || p.method) : "") + (p.utr ? ' · UTR <span class="utr">' + h(p.utr) + "</span>" : ""), -p.amountPaise)).join("") +
      row("Balance due at the end", r.closingPaise, "tot") + "</div>" +
      '<p class="small muted" style="margin:8px 0 0">Of this period\'s ' + money(r.periodNetPaise) + ": " + money(r.settledPaise) + " already paid, " + money(r.pendingPaise) + " waiting for the next payout" +
      (r.schedule && r.schedule.nextRunDayKey ? " (" + h(fullDay(Date.parse(r.schedule.nextRunDayKey + "T10:00:00+05:30"))) + ")" : "") + ".</p>";
  }
  function ledgerOrdersModal(w, r) {
    const money1 = {}; w.orders.forEach((o) => { money1[orderId(o)] = orderMoney(o); });
    const rows = r.orders.map((x) => { const m = money1[x.orderId];
      return "<tr><td><strong>#" + h(x.orderId.replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase()) + '</strong><div class="small muted">' + h(new Date(x.at).toLocaleString("en-IN", {day: "numeric", month: "short", hour: "numeric", minute: "2-digit"})) + "</div></td><td>" +
        (x.paymentMethod === "cod" ? "Cash" : x.paymentMethod ? "Online" : "—") + '</td><td class="num">' + (m ? inr(m.items) : "—") + '</td><td class="num">' + money(x.earningPaise) + '</td><td class="num">' + money(-(x.tdsPaise + x.tcsPaise)) +
        '</td><td class="num">' + (x.refundRecoveredPaise ? money(-x.refundRecoveredPaise) : "—") + '</td><td class="num"><strong>' + money(x.netPaise) + "</strong></td><td>" + settledCell(x.settlement) + "</td></tr>"; }).join("");
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal wide" role="dialog" aria-modal="true" aria-label="Orders and payouts"><header><h2>Orders and the payout that paid them</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div style="overflow:auto"><table class="table"><thead><tr><th>Order</th><th>Pay</th><th class="num">Items</th><th class="num">Earnings</th><th class="num">TDS + TCS</th><th class="num">Refund</th><th class="num">Net</th><th>Paid</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" class="empty"><strong>No orders in this period</strong></td></tr>') + "</tbody></table></div>" +
      '<div class="row"><button class="btn" data-act="fin-annex">Download (CSV)</button></div></div></div>';
  }

  // ---------- finance: monthly report ----------
  // One calendar month, laid out like a marketplace payout report but with more
  // detail: who you are and who Scraveit is (for your CA), the payout breakup
  // line by line, every payout with its UTR, each order and whether it's been
  // paid, cancelled orders with the reason, offers, adjustments, and the terms.
  function monthList() {
    const out = [], now = new Date();
    for (let i = 0; i < 6; i++) {
      const a = new Date(now.getFullYear(), now.getMonth() - i, 1), b = new Date(a.getFullYear(), a.getMonth() + 1, 1);
      out.push({key: a.getFullYear() + "-" + String(a.getMonth() + 1).padStart(2, "0"), from: a.getTime(), to: b.getTime(), label: a.toLocaleDateString("en-IN", {month: "long", year: "numeric"})});
    }
    return out;
  }
  async function loadMonth(m) {
    const F = state.fin, M = F.mon[m.key] = {loading: true}; render();
    const jobs = [fetchOrders([state.rid], m.from - 2 * DAY, Math.min(m.to, Date.now() + 1)).then((l) => { M.all = l; }, (e) => { M.all = []; M.err = friendly(e); })];
    if (WEB_CHECK) {
      jobs.push(payoutReport(m.from, m.to).then((r) => { M.rep = r; }, (e) => { M.err = friendly(e); }));
      jobs.push(statement(m.from, m.to).then((r) => { M.stmt = r; }, () => { M.stmt = null; }));
      jobs.push(call("getSponsoredListings", {restaurantId: state.rid}).then((r) => { M.ads = r.bookings || []; }, () => { M.ads = []; }));
    }
    if (F.profile === undefined) jobs.push(db.collection("restaurantPayoutProfiles").doc(state.rid).get().then((s) => { F.profile = s.exists ? s.data() : null; }, () => { F.profile = null; }));
    await Promise.all(jobs);
    M.loading = false; render();
  }
  const CANCEL_BY = {restaurant_rejected: "You rejected it", customer_cancelled: "Customer cancelled", system_cancelled: "Scraveit (automatic)", delivery_failed: "Delivery failed"};
  const ROLE_BY = {customer: "Customer", staff: "Restaurant or Scraveit staff", owner: "Scraveit", ops_admin: "Scraveit", rider: "Delivery partner", system: "Scraveit (automatic)"};
  function cancelInfo(o) {
    const hist = Object.values(o.statusHistory || {}).filter((e) => e && e.status).sort((a, b) => Number(a.at) - Number(b.at));
    const end = hist.filter((e) => e.status === "Cancelled").pop(), before = hist.filter((e) => e.status !== "Cancelled").pop();
    return {at: end ? Number(end.at) : ms(o.updatedAt), by: CANCEL_BY[o.cancellationKind] || ROLE_BY[o.cancelledByRole || (end && end.actorRole)] || "—",
      stage: o.statusBeforeTerminal || (before && before.status) || "Order placed", reason: o.cancelReason || (end && (end.reason || end.detail)) || ""};
  }
  function monthFigures(m, M) {
    const stmt = {}, led = {}; ((M.stmt && M.stmt.rows) || []).forEach((r) => { stmt[r.orderId] = r; }); ((M.rep && M.rep.orders) || []).forEach((r) => { led[r.orderId] = r; });
    const all = M.all || [];
    const del = all.filter((o) => o.status === "Delivered" && deliveredAt(o) >= m.from && deliveredAt(o) < m.to).sort((a, b) => deliveredAt(a) - deliveredAt(b));
    const can = all.filter((o) => o.status === "Cancelled" && placedAt(o) >= m.from && placedAt(o) < m.to).sort((a, b) => placedAt(a) - placedAt(b));
    const t = {items: 0, discount: 0, scraveitDiscount: 0, base: 0, commission: 0, cgst: 0, sgst: 0, igst: 0, commissionGst: 0, rush: 0, earned: 0, foodBase: 0, foodGst: 0, cod: 0, cancelValue: 0};
    const offers = {};
    del.forEach((o) => {
      const x = orderMoney(o), c = (o.economics && o.economics.customer) || {}, a = o.appliedOffer;
      ["items", "discount", "base", "commission", "commissionGst", "rush", "earned"].forEach((k) => { t[k] += x[k]; });
      t.scraveitDiscount += rs(c.platformDiscountPaise);
      if (x.commissionLine) { t.cgst += x.commissionLine.cgst; t.sgst += x.commissionLine.sgst; t.igst += x.commissionLine.igst; }
      if (x.food) { t.foodBase += x.food.base; t.foodGst += x.food.gst; }
      if (o.paymentMethod === "cod") t.cod += 1;
      if (a && (a.promotionId || a.code)) {
        const k = a.promotionId || a.code, f = offers[k] = offers[k] || {title: a.title || a.code || "Offer", code: a.code || "", funding: a.fundingSource || "", orders: 0, items: 0, you: 0, scraveit: 0};
        f.orders += 1; f.items += x.items; f.you += a.restaurantFundedPaise != null ? rs(a.restaurantFundedPaise) : x.discount; f.scraveit += rs(a.platformFundedPaise);
      }
    });
    can.forEach((o) => { t.cancelValue += itemValue(o); });
    return {del, can, t, offers: Object.values(offers).sort((a, b) => b.orders - a.orders), stmt, led};
  }
  const FUNDED = {restaurant: "You", platform: "Scraveit", shared: "Shared", co_funded: "Shared"};
  function monthHeader(m, M, fig) {
    const r = M.rep, o = outlet(), prof = state.fin.profile || {}, R = r ? r.restaurant : {}, S = r ? r.scraveit : (M.stmt && M.stmt.issuer) || {};
    const acct = payoutAccount(), utrs = r ? r.payouts.filter((p) => p.at >= m.from && p.at < m.to && p.utr).map((p) => p.utr) : [];
    return [["Report period", fullDay(m.from) + " – " + fullDay(m.to - DAY)], ["Outlet", o.doc.name + " · ID " + o.id], ["Legal entity", R.legalName || prof.legalBusinessName || "Not given"],
      ["Address", R.address || [o.doc.address, o.doc.area, o.doc.city].filter(Boolean).join(", ")], ["PAN", R.panMasked || maskPan(prof.panNumber) || "Not given"],
      ["GSTIN", R.gstin || String(prof.gstin || "").toUpperCase() || "Not registered"], ["TAN", R.tan || "Not given"], ["FSSAI licence", R.fssai || o.doc.fssaiNumber || "—"],
      ["Paid to", R.payoutTo ? R.payoutTo + (R.ifsc ? " · IFSC " + R.ifsc : "") : acct.label ? acct.label + " " + acct.sub : "Not set"],
      ["Payout cycle", r && r.schedule && r.schedule.label ? "Weekly, " + r.schedule.label.replace(/\s*\(Asia\/Kolkata\)$/, "") : "Weekly"],
      ["Scraveit", (S.legalName || "SCRAVEIT PRIVATE LIMITED") + (S.address ? ", " + S.address : "")], ["Scraveit GSTIN (regular)", S.gstin || "—"],
      ["Scraveit GSTIN (TCS)", S.tcsGstin || "—"], ["Scraveit PAN / TAN (check TDS in Form 168)", [S.pan, S.tan].filter(Boolean).join(" / ") || "—"],
      ["Orders", fig.del.length + " delivered + " + fig.can.length + " cancelled or rejected = " + (fig.del.length + fig.can.length)],
      ["Net payout for the month", r ? money(r.periodNetPaise) + " (" + money(r.settledPaise) + " paid + " + money(r.pendingPaise) + " pending)" : inr(fig.t.earned) + " before TDS (exact figure loads with website security)"],
      ["Bank UTRs", utrs.join(", ") || "—"]];
  }
  function monthBreakup(m, M, fig) {
    const r = M.rep, T = r ? r.totals : null, t = fig.t, rate = t.base ? Math.round(t.commission / t.base * 1000) / 10 : 0;
    const yr = M.stmt && M.stmt.year, tot = (k) => T ? T[k].paise : null, v = (rupees) => Math.round(rupees * 100);
    const tdsRow = r ? -r.tdsPaise : null, tcsRow = r ? -r.tcsPaise : null, gov = r ? -(r.tdsPaise + r.tcsPaise) + tot("tax_returned") : null;
    return [
      ["", "Orders", null, fig.del.length + " delivered · " + fig.can.length + " cancelled or rejected"],
      ["1", "Item total (your menu prices)", v(t.items)], ["2", "− Discounts you funded", -v(t.discount)],
      ["A", "Value Scraveit's commission is on (1 − 2)", v(t.base), "", "sub"],
      ["3", "− Commission" + (rate ? " (" + rate + "% of A)" : ""), -v(t.commission)],
      ["4", "− GST on commission, 18% (CGST " + inr(t.cgst) + " · SGST " + inr(t.sgst) + " · IGST " + inr(t.igst) + ")", -v(t.commissionGst)],
      ["5", "+ Your share of busy-kitchen fees", v(t.rush)],
      ["B", "Your earnings (A − 3 − 4 + 5)", T ? tot("order") : v(t.earned), "", "tot"],
      ["6", "− Income-tax TDS" + (yr ? " (section " + yr.section + ", " + pct(yr.rateBps) + ")" : ""), tdsRow],
      ["7", "− GST TCS (section 52, on goods only)", tcsRow], ["8", "+ TDS / TCS returned on refunded orders", tot("tax_returned")],
      ["C", "Government deductions (6 + 7 − 8)", gov, "", "sub"],
      ["9", "− Customer refunds recovered from you", tot("refund_recovery")], ["10", "− Ads: top placement (incl. 18% GST)", tot("ads")],
      ["11", "+ Ads refunded (cancelled before start)", tot("ads_refund")], ["12", "+ TDS on commission refunded to you", tot("tds_commission_refund")],
      ["13", "+ Delivery you did yourself", tot("delivery")], ["14", "± Other adjustments", tot("other")],
      ["D", "Net payout for the month (B − C − 9 − 10 + 11 + 12 + 13 ± 14)", r ? r.periodNetPaise : null, "", "tot"],
      ["", "For your information (not part of the payout)", null, "", "head"],
      ["i", "Discounts Scraveit funded on your orders", v(t.scraveitDiscount)],
      ["ii", "GST customers paid on your food: paid to the government by Scraveit, section 9(5)", v(t.foodGst)],
      ["iii", "Value of cancelled or rejected orders (not paid)", v(t.cancelValue)],
    ];
  }
  function pageMonthly() {
    const F = state.fin, L = monthList(), m = L.find((x) => x.key === F.month) || L[0]; F.month = m.key;
    const head = '<div class="tabs">' + L.map((x) => '<button class="tab' + (x === m ? " on" : "") + '" data-act="fin-month" data-id="' + x.key + '">' + h(x.label) + "</button>").join("") + "</div>";
    const M = F.mon[m.key];
    if (!M) { setTimeout(() => loadMonth(m), 0); return head + '<div class="spinner"></div>'; }
    if (M.loading) return head + '<div class="spinner"></div>';
    const fig = monthFigures(m, M), r = M.rep;
    const facts = '<div class="card"><div class="row between"><h2 style="margin:0">Report summary</h2><div class="row"><button class="btn small primary" data-act="fin-xlsx">Download full report (Excel)</button><button class="btn small" data-act="fin-month-print">Print</button></div></div>' +
      (M.err ? '<div class="notice warn small" style="margin-top:10px">Some records didn\'t load: ' + h(M.err) + "</div>" : "") +
      (!WEB_CHECK ? '<div class="notice warn small" style="margin-top:10px">Payouts, UTRs, TDS and deductions come from Scraveit\'s secure records and show once the website\'s security check is on. Until then this report shows your orders only.</div>' : "") +
      '<div class="facts report-facts" style="margin-top:12px">' + monthHeader(m, M, fig).map((f) => "<div><span>" + h(f[0]) + "</span><strong>" + h(f[1]) + "</strong></div>").join("") + "</div></div>";
    const breakup = '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2>Payout breakup</h2><p class="small muted">Every line that makes up your payout. Letters are totals; numbers are the parts.</p></div><table class="table"><tbody>' +
      monthBreakup(m, M, fig).map((b) => b[4] === "head" ? '<tr><td colspan="3" class="sub-h" style="padding-top:16px"><strong>' + h(b[1]) + "</strong></td></tr>" :
        "<tr" + (b[4] === "tot" ? ' class="foot"' : "") + '><td style="width:36px" class="muted">' + h(b[0]) + "</td><td>" + (b[4] === "tot" ? "<strong>" + h(b[1]) + "</strong>" : h(b[1])) + '</td><td class="num">' +
        (b[3] ? h(b[3]) : b[2] == null ? "—" : b[4] === "tot" ? "<strong>" + money(b[2]) + "</strong>" : money(b[2])) + "</td></tr>").join("") + "</tbody></table></div>";
    const settle = !r ? "" : '<div class="card"><h2>Settlement</h2>' + ledgerLines(r, null) + '<table class="table" style="margin-top:12px"><thead><tr><th>Paid on</th><th>Method</th><th>UTR</th><th class="num">Amount</th><th class="num">Of it, for this month</th></tr></thead><tbody>' +
      (r.payouts.length ? r.payouts.map((p) => "<tr><td>" + h(fullDay(p.at)) + "</td><td>" + h(METHODS[p.method] || p.method || "") + '</td><td><span class="utr">' + h(p.utr || "—") + '</span></td><td class="num">' + money(p.amountPaise) + '</td><td class="num">' + money(p.coversPaise) + "</td></tr>").join("") :
        '<tr><td colspan="5" class="empty"><strong>No payouts yet for this month</strong>They\'re sent on the next payout day.</td></tr>') + "</tbody></table></div>";
    const shown = F.showAll ? fig.del : fig.del.slice(0, 20);
    const orders = '<div class="card" style="padding:0;overflow:auto"><div class="pad row between"><h2 style="margin:0">Orders (' + fig.del.length + ")</h2><span class=\"small muted\">" + fig.t.cod + " cash · " + (fig.del.length - fig.t.cod) + " online</span></div>" +
      '<table class="table"><thead><tr><th>Order</th><th>Delivered</th><th>Offer</th><th class="num">Items</th><th class="num">Your discount</th><th class="num">Commission + GST</th><th class="num">Earnings</th><th class="num">TDS + TCS</th><th class="num">Refund</th><th class="num">Net</th><th>Paid</th></tr></thead><tbody>' +
      (shown.length ? shown.map((o) => { const x = orderMoney(o), l = fig.led[orderId(o)], s = fig.stmt[orderId(o)];
        const tax = l ? l.tdsPaise + l.tcsPaise : s ? Number(s.incomeTaxTdsPaise || 0) + Number(s.gstTcsPaise || 0) : null;
        return "<tr><td><strong>#" + h(shortId(o)) + '</strong><div class="small muted">' + (o.paymentMethod === "cod" ? "Cash" : "Online") + '</div></td><td class="nowrap">' + h(dayLabel(deliveredAt(o))) + '</td><td class="small">' + h((o.appliedOffer && (o.appliedOffer.code || o.appliedOffer.title)) || "—") +
          '</td><td class="num">' + inr(x.items) + '</td><td class="num">' + (x.discount ? "−" + inr(x.discount) : "—") + '</td><td class="num">−' + inr(x.commission + x.commissionGst) + '</td><td class="num">' + inr(x.earned) +
          '</td><td class="num">' + (tax == null ? "—" : money(-tax)) + '</td><td class="num">' + (l && l.refundRecoveredPaise ? money(-l.refundRecoveredPaise) : "—") + '</td><td class="num"><strong>' + (l ? money(l.netPaise) : tax == null ? "—" : inr(x.earned - rs(tax))) + "</strong></td><td>" + (l ? settledCell(l.settlement) : "—") + "</td></tr>"; }).join("") :
        '<tr><td colspan="11" class="empty"><strong>No delivered orders this month</strong></td></tr>') + "</tbody></table>" +
      (fig.del.length > 20 ? '<div class="pad"><button class="btn small" data-act="fin-show-all">' + (F.showAll ? "Show fewer" : "Show all " + fig.del.length + " orders") + "</button></div>" : "") + "</div>";
    const cancelled = '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2>Cancelled and rejected orders (' + fig.can.length + ')</h2><p class="small muted">Who cancelled, at which step, and why. Cancelled orders aren\'t paid unless a line below shows money for them.</p></div>' +
      '<table class="table"><thead><tr><th>Order</th><th>Placed</th><th>Cancelled</th><th>By</th><th>At step</th><th>Reason</th><th class="num">Order value</th><th class="num">Paid to you</th></tr></thead><tbody>' +
      (fig.can.length ? fig.can.map((o) => { const c = cancelInfo(o), l = fig.led[orderId(o)];
        return "<tr><td><strong>#" + h(shortId(o)) + '</strong></td><td class="nowrap small">' + h(new Date(placedAt(o)).toLocaleString("en-IN", {day: "numeric", month: "short", hour: "numeric", minute: "2-digit"})) + '</td><td class="nowrap small">' +
          h(c.at ? new Date(c.at).toLocaleString("en-IN", {day: "numeric", month: "short", hour: "numeric", minute: "2-digit"}) : "—") + "</td><td>" + h(c.by) + "</td><td>" + h(c.stage) + '</td><td class="small">' + h(c.reason || "—") + '</td><td class="num">' + inr(itemValue(o)) + '</td><td class="num">' + (l ? money(l.netPaise) : inr(0)) + "</td></tr>"; }).join("") :
        '<tr><td colspan="8" class="empty"><strong>No cancelled or rejected orders</strong></td></tr>') + "</tbody></table></div>";
    const offers = '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2>Offers and discounts</h2><p class="small muted">What each offer sold and what it cost you. Effective discount is your discount as a share of the item total.</p></div>' +
      '<table class="table"><thead><tr><th>Offer</th><th>Funded by</th><th class="num">Orders</th><th class="num">Item total</th><th class="num">Avg order</th><th class="num">Your discount</th><th class="num">Per order</th><th class="num">Scraveit\'s discount</th><th class="num">Effective %</th></tr></thead><tbody>' +
      (fig.offers.length ? fig.offers.map((f) => "<tr><td><strong>" + h(f.title) + "</strong>" + (f.code ? '<div class="small muted">Code ' + h(f.code) + "</div>" : "") + "</td><td>" + h(FUNDED[f.funding] || f.funding || "—") + '</td><td class="num">' + f.orders + '</td><td class="num">' + inr(f.items) +
        '</td><td class="num">' + inr(f.items / f.orders) + '</td><td class="num">' + inr(f.you) + '</td><td class="num">' + inr(f.you / f.orders) + '</td><td class="num">' + inr(f.scraveit) + '</td><td class="num">' + (f.items ? (f.you / f.items * 100).toFixed(1) + "%" : "—") + "</td></tr>").join("") :
        '<tr><td colspan="9" class="empty"><strong>No offers used this month</strong></td></tr>') + "</tbody></table></div>";
    const adj = !r ? "" : '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2>Additions and deductions</h2><p class="small muted">Everything other than order earnings and order TDS/TCS: refunds recovered, ads, refunds to you and other adjustments.</p></div>' +
      '<table class="table"><thead><tr><th>Date</th><th>What</th><th>Details</th><th class="num">Amount</th><th>Paid</th></tr></thead><tbody>' +
      (r.adjustments.length ? r.adjustments.map((a) => "<tr><td class=\"nowrap\">" + h(fullDay(a.at)) + "</td><td>" + h(LINE_LABEL[a.kind] || a.kind) + '</td><td class="small">' + h(adjustmentDetail(a, M)) + '</td><td class="num"><strong>' + money(a.movementPaise) + "</strong></td><td>" + settledCell(a.settlement) + "</td></tr>").join("") :
        '<tr><td colspan="5" class="empty"><strong>None this month</strong></td></tr>') + "</tbody></table></div>";
    return head + facts + breakup + settle + orders + cancelled + offers + adj +
      '<div class="notice info"><div>Keep payout and tax records for at least 72 months (section 36, CGST Act). Terms used here are explained under <button class="btn small" data-act="fin-tab" data-tab="terms">Terms explained</button></div></div>';
  }
  function adjustmentDetail(a, M) {
    const b = (M.ads || []).find((x) => x.bookingId === a.reference);
    if (b) return "Top placement " + fullDay(b.startAt) + " – " + fullDay(b.endAt - DAY) + " (" + b.days + (b.days === 1 ? " day" : " days") + ")" + (b.invoiceNo ? " · invoice " + b.invoiceNo : "") + (b.creditNoteNo && a.kind === "ads_refund" ? " · credit note " + b.creditNoteNo : "");
    return [a.orderId ? "Order #" + a.orderId.replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase() : "", a.reason].filter(Boolean).join(" · ") || "—";
  }
  function printMonth() {
    const F = state.fin, m = monthList().find((x) => x.key === F.month), M = m && F.mon[m.key]; if (!M || M.loading) return;
    const fig = monthFigures(m, M), r = M.rep;
    printDoc("Payout report " + m.label, '<div class="doc"><div class="row between"><div><div class="wordmark">scraveit<span>*</span></div><div class="small muted">Monthly payout report</div></div><div class="num"><strong>' + h(m.label) + "</strong></div></div>" +
      '<table class="table"><tbody>' + monthHeader(m, M, fig).map((f) => '<tr><td class="muted" style="width:220px">' + h(f[0]) + "</td><td>" + h(f[1]) + "</td></tr>").join("") + "</tbody></table>" +
      '<table class="table"><tbody>' + monthBreakup(m, M, fig).map((b) => "<tr><td>" + h(b[0]) + "</td><td>" + h(b[1]) + '</td><td class="num">' + (b[3] ? h(b[3]) : b[2] == null ? "" : money(b[2])) + "</td></tr>").join("") + "</tbody></table>" +
      (r ? ledgerLines(r, null) : "") + '<p class="small muted">Generated from Scraveit\'s records on ' + h(new Date().toLocaleString("en-IN")) + ". The full order list is in the Excel download.</p></div>");
  }

  // ---------- finance: Excel download ----------
  // A real .xlsx (zip of SpreadsheetML), built here so no outside library loads.
  // Money cells are numbers formatted #,##0.00 so a CA can add them up. Parts
  // are deflated where the browser can (CompressionStream), else stored.
  const MONEY = (v) => ({m: Math.round(Number(v || 0) * 100) / 100});
  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== "function") return null;
    try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()); } catch (_) { return null; }
  }
  async function xlsxBlob(sheets) {
    const enc = new TextEncoder(), esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    const col = (i) => { let s = ""; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const sheetXml = (sh) => {
      const widths = []; sh.rows.forEach((r) => r.forEach((c, i) => { const t = c && typeof c === "object" ? String(c.m) : String(c ?? ""); widths[i] = Math.min(60, Math.max(widths[i] || 8, t.length + 2)); }));
      return head + "<worksheet " + ns + ">" + (sh.head != null ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + (sh.head + 1) + '" topLeftCell="A' + (sh.head + 2) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "") +
        "<cols>" + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("") + "</cols><sheetData>" +
        sh.rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((c, ci) => {
          const ref = col(ci) + (ri + 1), bold = (sh.bold || []).includes(ri) || ri === sh.head ? ' s="1"' : "";
          if (c == null || c === "") return "";
          if (typeof c === "object") return '<c r="' + ref + '" s="' + (bold ? 3 : 2) + '"><v>' + c.m + "</v></c>";
          if (typeof c === "number") return '<c r="' + ref + '"' + bold + "><v>" + c + "</v></c>";
          return '<c r="' + ref + '" t="inlineStr"' + bold + '><is><t xml:space="preserve">' + esc(c) + "</t></is></c>";
        }).join("") + "</row>").join("") + "</sheetData></worksheet>";
    };
    const files = [["[Content_Types].xml", head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") + "</Types>"],
      ["_rels/.rels", head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", head + "<workbook " + ns + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + esc(s.name.slice(0, 31)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + "</sheets></workbook>"],
      ["xl/_rels/workbook.xml.rels", head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ["xl/styles.xml", head + "<styleSheet " + ns + '><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>']]
      .concat(sheets.map((s, i) => ["xl/worksheets/sheet" + (i + 1) + ".xml", sheetXml(s)]));
    // Zip: each part deflated, or stored when it doesn't shrink.
    const crcTable = xlsxBlob.crc || (xlsxBlob.crc = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
    const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const parts = [], central = []; let offset = 0;
    const u16 = (v) => [v & 255, (v >>> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    for (const [name, body] of files) {
      const nb = enc.encode(name), raw = enc.encode(body), crc = crc32(raw), packed = await deflateRaw(raw), deflated = !!packed && packed.length < raw.length, data = deflated ? packed : raw;
      const common = [...u16(20), ...u16(0x0800), ...u16(deflated ? 8 : 0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(nb.length), ...u16(0)];
      const local = new Uint8Array([...u32(0x04034b50), ...common]);
      parts.push(local, nb, data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nb);
      offset += local.length + nb.length + data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob(parts.concat(central, [end]), {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  }
  async function monthWorkbook(m, M) {
    const fig = monthFigures(m, M), r = M.rep, o = outlet();
    const breakup = monthBreakup(m, M, fig);
    const sheets = [
      {name: "Summary", bold: [0], rows: [["Scraveit monthly payout report"]].concat(monthHeader(m, M, fig).map((f) => [f[0], f[1]]),
        [[""], ["Generated", new Date().toLocaleString("en-IN")], ["Sheets", "Payout breakup · Settlement · Order level · Cancelled orders · Additions and deductions · Offers · Invoices · Terms explained"]])},
      {name: "Payout breakup", head: 0, rows: [["No.", "Particular", "Amount (₹)", "Note"]].concat(breakup.map((b) => [b[0], b[1], b[2] == null ? "" : MONEY(rs(b[2])), b[3] || ""]))},
      {name: "Settlement", head: 0, rows: [["Item", "Date", "Method", "UTR", "Amount (₹)", "Of it, for this month (₹)"]].concat(r ? [["Balance carried in (" + BASIS[r.opening.basis] + ")", "", "", "", r.opening.balancePaise == null ? "" : MONEY(rs(r.opening.balancePaise)), ""],
        ["Net payout for the month", "", "", "", MONEY(rs(r.periodNetPaise)), ""]].concat(r.payouts.map((p) => ["Payout sent", fullDay(p.at), METHODS[p.method] || p.method, p.utr, MONEY(rs(p.amountPaise)), MONEY(rs(p.coversPaise))]),
        [["Balance due at the end of the month", "", "", "", r.closingPaise == null ? "" : MONEY(rs(r.closingPaise)), ""], ["This month: already paid", "", "", "", MONEY(rs(r.settledPaise)), ""], ["This month: waiting for the next payout", "", "", "", MONEY(rs(r.pendingPaise)), ""]]) :
        [["Loads with the website's security check", "", "", "", "", ""]])},
      {name: "Order level", head: 0, rows: [["S.No.", "Order ID", "Placed", "Delivered", "Week from", "Payment", "Customer in", "Offer", "Offer funded by", "Item total", "Your discount", "Scraveit's discount", "Commission on", "Commission %", "Commission",
        "CGST on commission", "SGST on commission", "IGST on commission", "GST on commission", "Busy-kitchen share", "Your earnings", "Food value taxed u/s 9(5)", "GST paid by Scraveit u/s 9(5)", "Income-tax TDS", "GST TCS",
        "TDS/TCS returned", "Refund recovered", "Other", "Net payout", "Settlement status", "Paid on", "Bank UTR", "Commission invoice no.", "Customer invoice no."]].concat(fig.del.map((x, i) => {
        const mm = orderMoney(x), l = fig.led[orderId(x)], s = fig.stmt[orderId(x)], c = (x.economics && x.economics.customer) || {}, a = x.appliedOffer || {}, cl = mm.commissionLine || {};
        const inv = commissionInvoice(s), cust = s ? (s.invoices || []).find((v) => v.kind !== "scraveit_commission") : null;
        return [i + 1, orderId(x), new Date(placedAt(x)).toLocaleString("en-IN"), new Date(deliveredAt(x)).toLocaleString("en-IN"), fullDay(mondayOf(deliveredAt(x))), x.paymentMethod === "cod" ? "Cash" : "Online",
          x.orderTax ? (x.orderTax.intraState === false ? "Other state" : "Same state") : "", a.code || a.title || "", FUNDED[a.fundingSource] || "", MONEY(mm.items), MONEY(mm.discount), MONEY(rs(c.platformDiscountPaise)), MONEY(mm.base),
          mm.base ? Math.round(mm.commission / mm.base * 10000) / 100 : "", MONEY(mm.commission), MONEY(cl.cgst), MONEY(cl.sgst), MONEY(cl.igst), MONEY(mm.commissionGst), MONEY(mm.rush), MONEY(mm.earned),
          MONEY(mm.food ? mm.food.base : 0), MONEY(mm.food ? mm.food.gst : 0), l ? MONEY(rs(l.tdsPaise)) : s ? MONEY(rs(s.incomeTaxTdsPaise)) : "", l ? MONEY(rs(l.tcsPaise)) : s ? MONEY(rs(s.gstTcsPaise)) : "",
          l ? MONEY(rs(l.taxReturnedPaise)) : "", l ? MONEY(rs(l.refundRecoveredPaise)) : "", l ? MONEY(rs(l.otherPaise + l.deliveryPaise)) : "", l ? MONEY(rs(l.netPaise)) : "",
          l ? settledText(l.settlement) : "", l && l.settlement.at ? fullDay(l.settlement.at) : "", l ? l.settlement.utr : "", inv ? inv.invoiceNo : "", cust ? cust.invoiceNo : ""];
      }))},
      {name: "Cancelled orders", head: 0, rows: [["Order ID", "Placed", "Cancelled", "Cancelled by", "At step", "Reason", "Payment", "Order value (₹)", "Paid to you (₹)"]].concat(fig.can.map((x) => {
        const c = cancelInfo(x), l = fig.led[orderId(x)];
        return [orderId(x), new Date(placedAt(x)).toLocaleString("en-IN"), c.at ? new Date(c.at).toLocaleString("en-IN") : "", c.by, c.stage, c.reason, x.paymentMethod === "cod" ? "Cash" : "Online", MONEY(itemValue(x)), MONEY(l ? rs(l.netPaise) : 0)];
      }))},
      {name: "Additions and deductions", head: 0, rows: [["Date", "Type", "Details", "Reference", "Amount (₹)", "Settlement status", "Paid on", "Bank UTR"]].concat(r ? r.adjustments.map((a) => [fullDay(a.at), LINE_LABEL[a.kind] || a.kind, adjustmentDetail(a, M), a.reference,
        MONEY(rs(a.movementPaise)), settledText(a.settlement), a.settlement.at ? fullDay(a.settlement.at) : "", a.settlement.utr]) : [])},
      {name: "Offers", head: 0, rows: [["Offer", "Code", "Funded by", "Orders", "Item total (₹)", "Average order (₹)", "Your discount (₹)", "Your discount per order (₹)", "Scraveit's discount (₹)", "Effective discount %"]].concat(fig.offers.map((f) =>
        [f.title, f.code, FUNDED[f.funding] || f.funding, f.orders, MONEY(f.items), MONEY(f.items / f.orders), MONEY(f.you), MONEY(f.you / f.orders), MONEY(f.scraveit), f.items ? Math.round(f.you / f.items * 10000) / 100 : ""]))},
      {name: "Invoices", head: 0, rows: [["Invoice no.", "Date", "Kind", "Order / booking", "Taxable value (₹)", "GST (₹)", "Total (₹)"]].concat(
        fig.del.map((x) => { const s = fig.stmt[orderId(x)], inv = commissionInvoice(s), mm = orderMoney(x); return inv ? [inv.invoiceNo, fullDay(s.recordedAt), "Commission (Scraveit to you)", orderId(x), MONEY(mm.commission), MONEY(mm.commissionGst), MONEY(mm.commission + mm.commissionGst)] : null; }).filter(Boolean),
        (M.ads || []).filter((b) => b.invoiceNo && b.createdAt >= m.from && b.createdAt < m.to).map((b) => [b.invoiceNo, fullDay(b.createdAt), "Advertising: top placement", b.bookingId, MONEY(rs(b.pricePaise)), MONEY(rs(b.gstPaise)), MONEY(rs(b.totalPaise))]),
        (M.ads || []).filter((b) => b.creditNoteNo && b.cancelledAt >= m.from && b.cancelledAt < m.to).map((b) => [b.creditNoteNo, fullDay(b.cancelledAt), "Credit note: top placement cancelled", b.bookingId, MONEY(-rs(b.pricePaise)), MONEY(-rs(b.gstPaise)), MONEY(-rs(b.totalPaise))]))},
      {name: "Terms explained", head: 0, rows: [["Term", "What it means"]].concat(GLOSSARY)},
    ];
    download("scraveit-payout-report-" + m.key + "-" + o.id + ".xlsx", await xlsxBlob(sheets));
  }

  // ---------- finance: terms explained ----------
  const GLOSSARY = [
    ["Item total", "What your dishes cost at your menu prices, before any discount."],
    ["Discount you funded", "The part of an offer's discount that comes out of your money."],
    ["Scraveit's discount", "The part of an offer's discount Scraveit pays. It is never taken from you."],
    ["Value commission is on", "Item total minus the discount you funded. Scraveit's commission is a percentage of this."],
    ["Commission", "Scraveit's fee for each order, a percentage of the value commission is on."],
    ["GST on commission", "18% GST on the commission, shown as CGST + SGST (same state) or IGST (other state). Scraveit's commission invoice shows it."],
    ["Busy-kitchen share", "Your part of the busy-kitchen fee customers paid when your kitchen was very busy."],
    ["Your earnings", "Value commission is on, minus commission and GST on it, plus your busy-kitchen share."],
    ["GST paid by Scraveit, section 9(5)", "GST customers paid on your food. The law makes Scraveit pay it to the government, so it isn't part of your payout and you don't pay it again. Report these sales in GSTR-1 Table 14(b)."],
    ["Income-tax TDS", "Tax Scraveit deducts from your sales (section 393 of the Income-tax Act, 2025; earlier 194-O), usually 0.1%, or 5% without a PAN. It is credited to your PAN and shows in your Form 168 (earlier 26AS)."],
    ["GST TCS", "Tax Scraveit collects on goods sales (section 52 of the CGST Act), not on restaurant food. Claim it on the GST portal; it reaches your cash ledger."],
    ["TDS / TCS returned", "Tax withheld on an order that was later refunded, given back to you."],
    ["Customer refund recovered", "Money Scraveit refunded a customer for a problem with your order (for example a wrong or missing item) and took back from your payout."],
    ["Ads: top placement", "What you paid to be listed first in your city, with 18% GST once Scraveit's GST is live. Each booking has a tax invoice."],
    ["Ads refunded", "A top placement booking you cancelled before it started, given back in full with a credit note."],
    ["TDS on commission refunded", "TDS you deducted on Scraveit's commission and paid to the government (old section 194H). After Scraveit sees it in its Form 168, it adds the amount back to your payout."],
    ["Delivery you did yourself", "Delivery charge paid to you for orders your own staff delivered."],
    ["Other adjustments", "Any other correction to your balance, with the reason shown next to it."],
    ["Net payout", "Your earnings minus TDS, TCS, refunds recovered and ads, plus anything added back."],
    ["Balance carried in", "Money due to you (or owed by you) from before this period that wasn't paid yet."],
    ["Balance due at the end", "What Scraveit owes you after this period's payouts. It is paid on the next payout day."],
    ["Payout", "One bank transfer to you. It pays the whole balance due on that day, oldest amounts first."],
    ["Paid / Pending / Part paid", "Paid: a payout has sent this money. Pending: it goes in the next payout. Part paid: a smaller payout covered only some of it."],
    ["UTR", "The bank's reference for a transfer: 16 characters for NEFT, 22 for RTGS, 12 digits for IMPS and UPI. Use it to find the payout in your bank statement."],
    ["Payout cycle", "Payouts run weekly, Monday to Sunday orders, sent on the day shown."],
    ["Cancelled or rejected order", "An order that wasn't delivered. Who cancelled it and at which step are shown. It isn't paid unless a line shows money for it."],
    ["Effective discount %", "Your discount as a share of the item total for that offer."],
    ["Commission invoice", "Scraveit's tax invoice to you for its commission (CGST rule 46). If you're GST-registered it reaches your GSTR-2B."],
    ["Customer invoice", "The invoice Scraveit issues to the customer for your food under section 9(5)."],
    ["Form 168 (earlier 26AS)", "Your annual tax statement on the income-tax portal. TDS Scraveit deducted shows here against your PAN."],
    ["Form 131 (earlier 16A)", "TDS certificate. Scraveit gives you one every quarter for the TDS it deducted."],
    ["GSTIN, PAN, TAN", "GST number, income-tax number, and tax-deduction account number. Scraveit's are on every report so your CA can match them."],
  ];
  function pageTerms() {
    return '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2>Terms explained</h2><p class="small muted">Every word used in your payouts, reports and downloads, in plain language. The Excel report has the same list.</p></div>' +
      '<table class="table"><tbody>' + GLOSSARY.map((g) => '<tr><td style="width:240px"><strong>' + h(g[0]) + "</strong></td><td>" + h(g[1]) + "</td></tr>").join("") + "</tbody></table></div>";
  }

  // ---------- finance: TDS on commission ----------
  // Large restaurants (companies, firms, audited businesses) deduct TDS on the
  // commission they pay Scraveit and send the details here; Scraveit finance
  // checks it in its Form 168 and adds it back to the payout.
  const fyLabel = (y) => String(y % 100).padStart(2, "0") + "-" + String((y + 1) % 100).padStart(2, "0");
  const CLAIM_STATUS = {submitted: ["state", "Being checked"], approved: ["paid", "Added to payout"], rejected: ["wait", "Not accepted"]};
  function loadClaims() {
    const F = state.fin; F.claims = {loading: true};
    call("getTdsCommissionClaims", {restaurantId: state.rid}).then((r) => { F.claims = {list: r.claims || []}; render(); }, (e) => { F.claims = {list: [], err: friendly(e)}; render(); });
  }
  function claimsCard(q, commissionBase) {
    const F = state.fin;
    if (!WEB_CHECK) return "";
    if (!F.claims) setTimeout(loadClaims, 0);
    const C = F.claims || {loading: true}, list = C.list || [];
    return '<div class="card"><h2>TDS you deducted on Scraveit\'s commission</h2>' +
      '<p style="margin:0 0 8px">If you\'re a company, firm or a business that has its accounts audited, you must deduct TDS on the commission you pay Scraveit (section 194H of the 1961 Act; section 393 of the Income-tax Act, 2025), usually 2% of the commission before GST, once it crosses ₹20,000 in a year. Scraveit already kept its full commission, so after you pay that TDS to the government, send the details here. Scraveit checks it in its Form 168 and adds it back to your next payout.</p>' +
      '<div class="facts"><div><span>Commission this quarter (before GST)</span><strong>' + inr(commissionBase) + "</strong></div><div><span>TDS at 2%</span><strong>" + inr(Math.round(commissionBase * 2) / 100) + "</strong></div><div><span>Deduct to Scraveit's PAN</span><strong>" + h((state.fin.tax[q.key] && state.fin.tax[q.key].stmt && state.fin.tax[q.key].stmt.issuer.pan) || "—") + "</strong></div></div>" +
      '<div class="row" style="margin:12px 0"><button class="btn primary small" data-act="tds-claim">Send TDS details</button><span class="small muted">One claim per TDS certificate (Form 131, earlier 16A).</span></div>' +
      (C.err ? '<div class="notice warn small">' + h(C.err) + "</div>" : "") +
      (C.loading ? '<div class="spinner"></div>' : '<div style="overflow:auto"><table class="table"><thead><tr><th>Quarter</th><th>Certificate</th><th class="num">Commission</th><th class="num">TDS</th><th>Sent</th><th>Status</th></tr></thead><tbody>' +
        (list.length ? list.map((c) => { const st = CLAIM_STATUS[c.status] || CLAIM_STATUS.submitted;
          return "<tr><td>FY " + h(c.financialYear) + " Q" + c.quarter + '</td><td><span class="utr">' + h(c.certificateNo) + '</span><div class="small muted">Challan ' + h(c.challanBsrCode) + "/" + h(c.challanSerialNo) + " · " + h(c.challanDate) + '</div></td><td class="num">' + inr(rs(c.commissionPaise)) +
            '</td><td class="num"><strong>' + inr(rs(c.tdsPaise)) + "</strong></td><td>" + h(fullDay(c.submittedAt)) + '</td><td><span class="pill ' + st[0] + '">' + st[1] + "</span>" + (c.note ? '<div class="small muted">' + h(c.note) + "</div>" : "") + "</td></tr>"; }).join("") :
          '<tr><td colspan="6" class="empty"><strong>No TDS sent yet</strong>Only needed if you deduct TDS on commission.</td></tr>') + "</tbody></table></div>") + "</div>";
  }
  function claimModal() {
    const F = state.fin, Q = quarterList(), q = Q.find((x) => x.key === F.q) || Q[0], T = F.tax[q.key], base = T ? taxFigures(q, T).months.reduce((s, m) => s + m.comm.base, 0) : 0;
    const field = (id, label, attrs, value) => '<div class="field grow"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" name="' + id + '" ' + attrs + ' value="' + h(value || "") + '" required></div>';
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal" id="tds-claim-form"><header><h2>Send TDS details</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="field"><label for="quarter">Quarter</label><select class="input" id="quarter" name="quarter">' + Q.map((x) => '<option value="' + fyLabel(x.fy) + "|" + x.n + '"' + (x === q ? " selected" : "") + ">FY " + fyLabel(x.fy) + " Q" + x.n + " · " + h(x.label) + "</option>").join("") + "</select></div>" +
      '<div class="row">' + field("commission", "Commission you deducted on (₹, before GST)", 'type="number" min="1" step="0.01"', base ? base.toFixed(2) : "") + field("tds", "TDS you deducted (₹)", 'type="number" min="1" step="0.01"', base ? (Math.round(base * 2) / 100).toFixed(2) : "") + "</div>" +
      '<div class="row">' + field("tan", "Your TAN", 'maxlength="10" placeholder="ABCD12345E" style="text-transform:uppercase"', "") + field("certificate", "Certificate no. (Form 131 / 16A)", 'maxlength="20"', "") + "</div>" +
      '<div class="row">' + field("bsr", "Challan BSR code", 'inputmode="numeric" maxlength="7" placeholder="7 digits"', "") + field("serial", "Challan serial no.", 'inputmode="numeric" maxlength="5"', "") + field("cdate", "Challan date", 'type="date"', "") + "</div>" +
      '<p class="small muted" style="margin:0">Scraveit adds this to your payout after it appears in Scraveit\'s Form 168, usually after you file your quarterly TDS return.</p>' +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit">Send</button></div></form></div>';
  }
  async function sendTdsClaim(f) {
    const [fy, n] = f.quarter.value.split("|"), paise = (v) => Math.round(Number(v) * 100);
    const input = {restaurantId: state.rid, financialYear: fy, quarter: Number(n), commissionPaise: paise(f.commission.value), tdsPaise: paise(f.tds.value), deductorTan: f.tan.value.trim().toUpperCase(),
      certificateNo: f.certificate.value.trim(), challanBsrCode: f.bsr.value.trim(), challanSerialNo: f.serial.value.trim(), challanDate: f.cdate.value};
    if (!/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(input.deductorTan)) { toast("Enter your 10-character TAN.", true); return; }
    if (input.tdsPaise * 10 > input.commissionPaise) { toast("TDS can't be more than 10% of the commission. Check the amounts.", true); return; }
    try { await call("submitTdsCommissionClaim", input); closeModal(); toast("Sent. Scraveit will check it and add it to your payout."); loadClaims(); }
    catch (e) { toast(friendly(e), true); }
  }

  // Invoices & taxes, by quarter (April–June is Q1). Monthly figures inside each quarter.
  function quarterList() {
    const out = [], now = new Date(); let y = now.getFullYear(), m = Math.floor(now.getMonth() / 3) * 3;
    for (let i = 0; i < 5; i++) {
      const from = new Date(y, m, 1).getTime(), to = new Date(y, m + 3, 1).getTime(), fy = m >= 3 ? y : y - 1;
      out.push({key: y + "-" + m, from, to, n: (m + 9) % 12 / 3 + 1, fy, label: new Date(from).toLocaleDateString("en-IN", {month: "short"}) + "–" + new Date(to - DAY).toLocaleDateString("en-IN", {month: "short", year: "numeric"})});
      m -= 3; if (m < 0) { m += 12; y -= 1; }
    }
    return out;
  }
  // Quarterly TDS statement (Form 140) due dates; the certificate (Form 131) follows within 15 days.
  function tdsDates(q) {
    const d = [[q.fy, 6, 31], [q.fy, 9, 31], [q.fy + 1, 0, 31], [q.fy + 1, 4, 31]][q.n - 1], ret = new Date(d[0], d[1], d[2]).getTime();
    return {ret, cert: ret + 15 * DAY};
  }
  async function loadTax(q) {
    const F = state.fin, T = F.tax[q.key] = {loading: true}; render();
    const jobs = [fetchOrders([state.rid], q.from - DAY, Math.min(q.to, Date.now() + 1)).then((list) => {
      T.orders = list.filter((o) => o.status === "Delivered" && deliveredAt(o) >= q.from && deliveredAt(o) < q.to).sort((a, b) => deliveredAt(a) - deliveredAt(b));
    }, (e) => { T.orders = []; toast(friendly(e), true); })];
    if (WEB_CHECK) jobs.push(statement(q.from, q.to).then((r) => { T.stmt = r; }, (e) => { T.err = friendly(e); }));
    if (F.profile === undefined) jobs.push(db.collection("restaurantPayoutProfiles").doc(state.rid).get().then((s) => { F.profile = s.exists ? s.data() : null; }, () => { F.profile = null; }));
    await Promise.all(jobs);
    T.loading = false; render();
  }
  function taxFigures(q, T) {
    const rows = {}; ((T.stmt && T.stmt.rows) || []).forEach((r) => { rows[r.orderId] = r; });
    const months = [0, 1, 2].map((i) => { const a = new Date(q.from); a.setMonth(a.getMonth() + i); const b = new Date(a); b.setMonth(b.getMonth() + 1);
      return {from: a.getTime(), to: b.getTime(), label: a.toLocaleDateString("en-IN", {month: "long", year: "numeric"}), food: {n: 0, base: 0, cgst: 0, sgst: 0, igst: 0, gst: 0},
        comm: {n: 0, base: 0, cgst: 0, sgst: 0, igst: 0, gst: 0}, tds: 0, tdsBase: 0, tcs: {base: 0, cgst: 0, sgst: 0, igst: 0, total: 0}}; });
    const invoices = [];
    (T.orders || []).forEach((o) => {
      const at = deliveredAt(o), mo = months.find((x) => at >= x.from && at < x.to); if (!mo) return;
      const m = orderMoney(o), r = rows[orderId(o)] || null, inv = commissionInvoice(r);
      if (m.food) { mo.food.n += 1; ["base", "cgst", "sgst", "igst", "gst"].forEach((k) => { mo.food[k] += m.food[k]; }); }
      if (m.commission > 0) {
        mo.comm.n += 1; mo.comm.base += m.commission; mo.comm.gst += m.commissionGst;
        if (m.commissionLine) ["cgst", "sgst", "igst"].forEach((k) => { mo.comm[k] += m.commissionLine[k]; });
        invoices.push({o, m, no: inv ? inv.invoiceNo : "", at: r ? r.recordedAt : at, row: r});
      }
      if (r) {
        mo.tds += rs(r.incomeTaxTdsPaise); mo.tdsBase += rs(r.incomeTaxTdsBasePaise);
        mo.tcs.base += rs(r.gstTcs.basePaise); mo.tcs.cgst += rs(r.gstTcs.cgstPaise); mo.tcs.sgst += rs(r.gstTcs.sgstPaise); mo.tcs.igst += rs(r.gstTcs.igstPaise); mo.tcs.total += rs(r.gstTcsPaise);
      }
    });
    return {months, invoices: invoices.sort((a, b) => b.at - a.at), rows};
  }
  function moneyTable(head, body, foot) {
    return '<table class="table"><thead><tr>' + head.map((c, i) => "<th" + (i ? ' class="num"' : "") + ">" + c + "</th>").join("") + "</tr></thead><tbody>" +
      body.map((r) => "<tr>" + r.map((c, i) => "<td" + (i ? ' class="num"' : "") + ">" + c + "</td>").join("") + "</tr>").join("") +
      (foot ? '<tr class="foot">' + foot.map((c, i) => "<td" + (i ? ' class="num"' : "") + "><strong>" + c + "</strong></td>").join("") + "</tr>" : "") + "</tbody></table>";
  }

  // PAN, GSTIN and GST registration: the same fields as the app's "Tax details" (restaurantPayoutProfiles.taxProfile).
  function taxEditModal() {
    if (!isOwner()) return;
    const p = state.fin.profile || {}, t = p.taxProfile || {}, opt = (v, l, cur) => '<option value="' + v + '"' + (cur === v ? " selected" : "") + ">" + l + "</option>";
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal" id="tax-form"><header><h2>Tax details</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<p class="small muted" style="margin:0">Used for GST TCS and income-tax TDS on your sales, and on Scraveit\'s commission invoices to you. A GSTIN sets the State automatically.</p>' +
      '<div class="field"><label for="tx-legal">Legal business name</label><input class="input" id="tx-legal" name="legal" maxlength="120" value="' + h(p.legalBusinessName || "") + '"></div>' +
      '<div class="ol-grid"><div class="field"><label for="tx-pan">PAN</label><input class="input" id="tx-pan" name="pan" maxlength="10" placeholder="ABCDE1234F" style="text-transform:uppercase" value="' + h(p.panNumber || t.pan || "") + '" autocomplete="off"></div>' +
      '<div class="field"><label for="tx-gstin">GSTIN</label><input class="input" id="tx-gstin" name="gstin" maxlength="15" placeholder="37ABCDE1234F1Z5" style="text-transform:uppercase" value="' + h(p.gstin || t.gstin || "") + '" autocomplete="off"></div>' +
      '<div class="field"><label for="tx-reg">GST registration</label><select class="input" id="tx-reg" name="reg">' + opt("regular", "Regular GST", t.registrationType || "regular") + opt("composition", "Composition scheme", t.registrationType) + opt("unregistered_eco", "Not registered: enrolled for e-commerce (Notification 34/2023)", t.registrationType) + opt("unregistered", "Not registered", t.registrationType) + "</select></div>" +
      '<div class="field"><label for="tx-enrol">E-commerce enrolment number</label><input class="input" id="tx-enrol" name="enrol" maxlength="20" value="' + h(t.ecoEnrolmentNo || "") + '" placeholder="Only if not GST-registered"></div>' +
      '<div class="field"><label for="tx-entity">Business type</label><select class="input" id="tx-entity" name="entity">' + [["individual", "Individual / proprietor"], ["huf", "HUF"], ["firm", "Partnership firm"], ["llp", "LLP"], ["company", "Company"], ["trust", "Trust / society"], ["other", "Other"]].map(([v, l]) => opt(v, l, t.entityType || "individual")).join("") + "</select></div>" +
      '<div class="field"><label for="tx-state">State</label><select class="input" id="tx-state" name="state">' + opt("37", "Andhra Pradesh (37)", t.stateCode || "37") + opt("36", "Telangana (36)", t.stateCode) + opt("33", "Tamil Nadu (33)", t.stateCode) + opt("29", "Karnataka (29)", t.stateCode) + "</select></div></div>" +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit">Save tax details</button></div></form></div>';
  }
  async function saveTax(form) {
    if (!isOwner()) return;
    const v = (n) => String(form.elements[n].value || "").trim(), pan = v("pan").toUpperCase(), gstin = v("gstin").toUpperCase(), reg = v("reg") || "regular", enrol = v("enrol");
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return toast("Enter a valid PAN, like ABCDE1234F.", true);
    if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) return toast("Enter a valid GSTIN.", true);
    if ((reg === "regular" || reg === "composition") && !gstin) return toast("Enter the GSTIN, or choose Not registered.", true);
    if (reg === "unregistered_eco" && !enrol) return toast("Enter the e-commerce enrolment number from the GST portal.", true);
    if (reg === "unregistered_eco" && !pan) return toast("A PAN is required for e-commerce enrolment.", true);
    const old = state.fin.profile || {}, now = Date.now();
    const taxProfile = {registrationType: reg, gstin, ecoEnrolmentNo: enrol, pan, panFurnished: Boolean(pan), entityType: v("entity") || "individual", stateCode: gstin ? gstin.slice(0, 2) : v("state") || "37", invoicePrefix: (old.taxProfile || {}).invoicePrefix || "", updatedAt: now};
    const changes = {restaurantId: state.rid, legalBusinessName: v("legal"), panNumber: pan, gstin, taxProfile, updatedAt: now, updatedBy: state.user.uid};
    try {
      await db.collection("restaurantPayoutProfiles").doc(state.rid).set(changes, {merge: true});
      state.fin.profile = Object.assign({}, old, changes); state.fin.tax = {}; closeModal(); toast("Tax details saved."); render(); setTimeout(cpAfterSave, 600);
    } catch (e) { toast(friendly(e), true); }
  }
  function pageTaxes() {
    const F = state.fin, Q = quarterList(), q = Q.find((x) => x.key === F.q) || Q[0], T = F.tax[q.key];
    F.q = q.key;
    const head = '<div class="tabs">' + Q.map((x) => '<button class="tab' + (x === q ? " on" : "") + '" data-act="fin-q" data-id="' + x.key + '">Q' + x.n + " · " + h(x.label) + "</button>").join("") + "</div>";
    if (!T) { setTimeout(() => loadTax(q), 0); return head + '<div class="spinner"></div>'; }
    if (T.loading) return head + '<div class="spinner"></div>';
    const S = T.stmt || null, I = S ? S.issuer : null, prof = F.profile || {}, fig = taxFigures(q, T), M = fig.months;
    const sum = (f) => M.reduce((s, m) => s + f(m), 0);
    const gstin = S ? S.seller.gstin : String(prof.gstin || "").toUpperCase(), pan = S ? S.seller.panMasked : maskPan(prof.panNumber);
    const legal = (S && S.seller.legalName) || prof.legalBusinessName || "", year = S ? S.year : null, rate = year ? year.rateBps : 10, noPan = year ? year.noPanRateBps : 500;
    const warns = [];
    if (!pan) warns.push("Add your PAN with “Edit tax details” below. Without a PAN, income-tax TDS is " + pct(noPan) + " of your sales instead of " + pct(rate) + ".");
    if (!gstin) warns.push("There's no GSTIN on file, so Scraveit's commission invoices are issued without one. If you're GST-registered, add it so the invoices reach your GSTR-2B.");
    const details = '<div class="card"><h2>Your tax details</h2><div class="facts"><div><span>Legal name</span><strong>' + h(legal || "Not given") + "</strong></div><div><span>GSTIN</span><strong>" + h(gstin || "Not registered") +
      "</strong></div><div><span>PAN</span><strong>" + h(pan || "Not given") + "</strong></div><div><span>Scraveit's GSTIN</span><strong>" + h((I && I.gstin) || "—") + "</strong></div></div>" +
      warns.map((w) => '<div class="notice warn small" style="margin-top:10px">' + h(w) + "</div>").join("") +
      (isOwner() ? '<div class="row" style="margin-top:10px"><button class="btn" data-act="tax-edit">Edit tax details</button></div>' : "") +
      (T.err ? '<div class="notice warn small" style="margin-top:10px">Invoice numbers and TDS/TCS didn\'t load: ' + h(T.err) + "</div>" : "") +
      (S && !S.gstActive ? '<div class="notice info small" style="margin-top:10px">Scraveit isn\'t charging GST yet, so no GST invoices have been issued and nothing is reported under section 9(5) for this period.</div>' : "") + "</div>";

    const fRows = M.map((m) => [h(m.label), m.food.n, inr(m.food.base), inr(m.food.cgst), inr(m.food.sgst), inr(m.food.igst), inr(m.food.gst)]);
    const food = '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2>GST on your food sales: paid by Scraveit</h2><p class="small muted">On food ordered through Scraveit, Scraveit charges the customer GST and pays it to the government (section 9(5) of the CGST Act). You don\'t pay this GST again. Show these sales in GSTR-1 Table 14(b) against Scraveit\'s GSTIN' + (I && I.gstin ? " " + h(I.gstin) : "") + "; they carry to GSTR-3B Table 3.1.1(ii). Keep them out of Table 3.1(a).</p></div>" +
      moneyTable(["Month", "Orders", "Taxable value", "CGST", "SGST", "IGST", "GST paid by Scraveit"], fRows, ["Quarter", sum((m) => m.food.n), inr(sum((m) => m.food.base)), inr(sum((m) => m.food.cgst)), inr(sum((m) => m.food.sgst)), inr(sum((m) => m.food.igst)), inr(sum((m) => m.food.gst))]) +
      '<div class="pad row"><button class="btn small" data-act="fin-csv" data-id="food">Download for your GST return (CSV)</button></div></div>';

    const shown = fig.invoices.slice(0, 10);
    const invTable = shown.length ? '<table class="table"><thead><tr><th>Invoice no.</th><th>Date</th><th>Order</th><th class="num">Commission</th><th class="num">GST</th><th class="num">Total</th><th></th></tr></thead><tbody>' +
      shown.map((x) => "<tr><td>" + (x.no ? '<strong class="utr">' + h(x.no) + "</strong>" : '<span class="muted">' + (S ? (S.gstActive ? "Not numbered" : "No GST invoice") : "Loads with website security") + "</span>") + "</td><td>" + h(fullDay(x.at)) + "</td><td>#" + h(shortId(x.o)) + '</td><td class="num">' + inr(x.m.commission) +
        '</td><td class="num">' + inr(x.m.commissionGst) + '</td><td class="num">' + inr(x.m.commission + x.m.commissionGst) + "</td><td>" + (x.no ? '<button class="btn small" data-act="fin-inv" data-id="' + h(orderId(x.o)) + '">View</button>' : "") + "</td></tr>").join("") + "</tbody></table>" : '<div class="empty"><strong>No commission this quarter</strong></div>';
    const cRows = M.map((m) => [h(m.label), m.comm.n, inr(m.comm.base), inr(m.comm.cgst), inr(m.comm.sgst), inr(m.comm.igst), inr(m.comm.gst)]);
    const comm = '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2>Scraveit\'s commission invoices to you</h2><p class="small muted">Scraveit issues a GST tax invoice for its commission on every delivered order (18% GST). Match them with your GSTR-2B. Most restaurants pay 5% GST without input tax credit, so for them this GST is a cost, not a credit; restaurants in hotels charging over ₹7,500 a night can claim it. Check with your CA.</p></div>' +
      moneyTable(["Month", "Invoices", "Commission (taxable)", "CGST", "SGST", "IGST", "GST"], cRows, ["Quarter", sum((m) => m.comm.n), inr(sum((m) => m.comm.base)), inr(sum((m) => m.comm.cgst)), inr(sum((m) => m.comm.sgst)), inr(sum((m) => m.comm.igst)), inr(sum((m) => m.comm.gst))]) +
      '<div class="pad"><h3 class="sub-h">Invoices' + (fig.invoices.length > shown.length ? " (latest " + shown.length + " of " + fig.invoices.length + ")" : "") + "</h3></div>" + invTable +
      '<div class="pad row"><button class="btn small" data-act="fin-csv" data-id="invoices"' + (fig.invoices.length ? "" : " disabled") + ">Download all invoices (CSV)</button></div></div>";

    const dates = tdsDates(q), tdsQ = sum((m) => m.tds), baseQ = sum((m) => m.tdsBase);
    const tds = '<div class="card"><h2>Income-tax TDS on your sales</h2><div class="kpis">' +
      kpiBox("TDS this quarter", S ? inr(tdsQ) : "—", S ? "on " + inr(baseQ) + " of sales" : "Loads with website security") +
      kpiBox("This financial year", year ? inr(rs(year.tdsDeductedPaise)) : "—", year ? "on " + inr(rs(year.grossPaise)) + " of sales through Scraveit (FY " + h(year.financialYear) + ")" : "") +
      kpiBox("Rate", pct(rate), "Without a PAN: " + pct(noPan)) + "</div>" +
      (S && !S.tdsActive ? '<div class="notice info small" style="margin-top:12px">Scraveit isn\'t deducting income-tax TDS yet, so nothing has been withheld from your payouts.</div>' : "") +
      '<ol class="steps"><li>Scraveit deducts TDS on your sales through the app under section ' + h((year && year.section) || "393 (Income-tax Act, 2025)") + ' (before April 2026, section 194-O) and pays it to the government.</li>' +
      "<li>It files its quarterly TDS statement (Form 140) by <strong>" + h(fullDay(dates.ret)) + "</strong> and gives you a TDS certificate (Form 131) by <strong>" + h(fullDay(dates.cert)) + "</strong>.</li>" +
      "<li>Check the credit in your annual tax statement on the income-tax portal (Form 168, earlier Form 26AS) and claim it in your income-tax return.</li></ol>" +
      '<p class="small muted" style="margin:0">If you\'re an individual or HUF, have given your PAN and your sales through Scraveit stay within ' + inr(rs((year && year.individualExemptUptoPaise) || 50000000)) + " in the year, no TDS is deducted. Once they cross it, TDS applies to the whole year's sales.</p></div>";

    const goods = storeKind() !== "restaurant", tcsQ = sum((m) => m.tcs.total);
    const tcs = !goods && !tcsQ ? '<div class="card"><h2>GST TCS</h2><p class="muted" style="margin:0">None. Restaurant food is taxed on Scraveit under section 9(5), so Scraveit doesn\'t collect TCS (section 52) on your orders.</p></div>' :
      '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2>GST TCS collected from you</h2><p class="small muted">Scraveit collects TCS (section 52 of the CGST Act) on your taxable goods sales and reports it in its GSTR-8 by the 10th of the next month. Accept it on the GST portal (Services → Returns → TDS and TCS credit received); it then reaches your electronic cash ledger.</p></div>' +
      moneyTable(["Month", "Taxable sales", "CGST", "SGST", "IGST", "TCS"], M.map((m) => [h(m.label), inr(m.tcs.base), inr(m.tcs.cgst), inr(m.tcs.sgst), inr(m.tcs.igst), inr(m.tcs.total)]),
        ["Quarter", inr(sum((m) => m.tcs.base)), inr(sum((m) => m.tcs.cgst)), inr(sum((m) => m.tcs.sgst)), inr(sum((m) => m.tcs.igst)), inr(tcsQ)]) + "</div>";

    return head + details + food + comm + tds + claimsCard(q, sum((m) => m.comm.base)) + tcs +
      '<div class="notice info"><div>Keep these records for at least 72 months (section 36, CGST Act). <button class="btn small" data-act="fin-csv" data-id="quarter" style="margin-left:8px">Download this quarter, order by order (CSV)</button></div></div>';
  }
  function taxCsv(kind) {
    const F = state.fin, q = quarterList().find((x) => x.key === F.q), T = q && F.tax[q.key]; if (!T || T.loading) return;
    const fig = taxFigures(q, T), name = "scraveit-" + kind + "-Q" + q.n + "-FY" + q.fy + ".csv";
    if (kind === "food") return download(name, csv([["Month", "Orders", "Taxable value", "CGST", "SGST", "IGST", "GST paid by Scraveit", "E-commerce operator GSTIN"]]
      .concat(fig.months.map((m) => [m.label, m.food.n, m.food.base, m.food.cgst, m.food.sgst, m.food.igst, m.food.gst, (T.stmt && T.stmt.issuer.gstin) || ""])).map((r) => r.map((c) => typeof c === "number" ? Math.round(c * 100) / 100 : c))));
    if (kind === "invoices") return download(name, csv([["Invoice no.", "Date", "Order ID", "Commission (taxable)", "CGST", "SGST", "IGST", "Total GST", "Invoice total"]]
      .concat(fig.invoices.map((x) => [x.no, isoDay(x.at), orderId(x.o), x.m.commission, x.m.commissionLine ? x.m.commissionLine.cgst : 0, x.m.commissionLine ? x.m.commissionLine.sgst : 0, x.m.commissionLine ? x.m.commissionLine.igst : 0, x.m.commissionGst, Math.round((x.m.commission + x.m.commissionGst) * 100) / 100]))));
    download(name, csv([["Order ID", "Delivered", "Item total", "Your discount", "9(5) taxable value", "9(5) GST paid by Scraveit", "Commission", "GST on commission", "Commission invoice no.", "Customer invoice no.", "Income-tax TDS", "GST TCS", "Your earnings"]]
      .concat((T.orders || []).map((o) => { const m = orderMoney(o), r = fig.rows[orderId(o)] || null, inv = commissionInvoice(r), cust = r ? (r.invoices || []).find((i) => i.kind !== "scraveit_commission") : null;
        return [orderId(o), new Date(deliveredAt(o)).toLocaleString("en-IN"), m.items, m.discount, m.food ? m.food.base : 0, m.food ? m.food.gst : 0, m.commission, m.commissionGst, inv ? inv.invoiceNo : "", cust ? cust.invoiceNo : "", r ? rs(r.incomeTaxTdsPaise) : "", r ? rs(r.gstTcsPaise) : "", m.earned]; }))));
  }

  // A commission tax invoice with the particulars CGST rule 46 asks for. Shown as a
  // tax invoice only when Scraveit's GSTIN, address and SAC are all on record.
  function invoiceHtml(o) {
    const F = state.fin, T = F.tax[F.q], S = T && T.stmt, r = S && S.rows.find((x) => x.orderId === orderId(o)), inv = commissionInvoice(r); if (!S || !inv) return "";
    const I = S.issuer, P = S.seller, m = orderMoney(o), l = m.commissionLine || {base: m.commission, rateBps: 1800, cgst: 0, sgst: 0, igst: 0}, out = outlet().doc;
    const missing = [!I.gstin && "GSTIN", !I.address && "registered address", !I.commissionSac && "SAC code"].filter(Boolean), igst = l.igst > 0, half = pct(l.rateBps / 2);
    return '<div class="inv">' + (missing.length ? '<div class="notice warn small">Not a complete tax invoice yet: Scraveit still has to add its ' + h(missing.join(", ")) + ". The number and amounts are final.</div>" : "") +
      '<div class="row between"><div><div class="inv-title">' + (missing.length ? "Invoice details" : "Tax invoice") + '</div><div class="small muted">Original for recipient</div></div><div class="num"><strong class="utr">' + h(inv.invoiceNo) + '</strong><div class="small">Date ' + h(fullDay(r.recordedAt)) + "</div></div></div>" +
      '<div class="inv-parties"><div><div class="small muted">Supplier</div><strong>' + h(I.legalName) + "</strong><div>" + h(I.address || "—") + "</div><div>GSTIN " + h(I.gstin || "—") + "</div><div>State " + h(stateName(I.stateCode)) + "</div></div>" +
      '<div><div class="small muted">Recipient</div><strong>' + h(P.legalName || out.name) + "</strong>" + (P.legalName && P.legalName !== out.name ? "<div>Trading as " + h(out.name) + "</div>" : "") +
      "<div>" + h([out.address, out.area, out.city].filter(Boolean).join(", ")) + "</div><div>GSTIN " + h(P.gstin || "Unregistered") + "</div><div>Place of supply " + h(stateName(P.stateCode)) + "</div></div></div>" +
      '<table class="table"><thead><tr><th>Description</th><th>SAC</th><th class="num">Taxable value</th>' + (igst ? '<th class="num">IGST ' + pct(l.rateBps) + "</th>" : '<th class="num">CGST ' + half + '</th><th class="num">SGST ' + half + "</th>") + '<th class="num">Total</th></tr></thead><tbody>' +
      "<tr><td>Commission on order #" + h(shortId(o)) + " (" + h(orderId(o)) + ") delivered through Scraveit</td><td>" + h(I.commissionSac || "—") + '</td><td class="num">' + inr(l.base) + "</td>" + (igst ? '<td class="num">' + inr(l.igst) + "</td>" : '<td class="num">' + inr(l.cgst) + '</td><td class="num">' + inr(l.sgst) + "</td>") +
      '<td class="num"><strong>' + inr(l.base + m.commissionGst) + "</strong></td></tr></tbody></table>" +
      '<p class="small">Tax payable on reverse charge: No. Collected from your payout for the week of ' + h(fullDay(mondayOf(deliveredAt(o)))) + ".</p>" +
      '<p class="small" style="text-align:right">For ' + h(I.legalName) + "<br>Authorised signatory</p></div>";
  }
  function invoiceModal(id) {
    const T = state.fin.tax[state.fin.q], o = T && (T.orders || []).find((x) => orderId(x) === id), body = o ? invoiceHtml(o) : ""; if (!body) return;
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal wide" role="dialog" aria-modal="true" aria-label="Invoice"><header><h2>Commission invoice</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>' + body +
      '<div class="row"><button class="btn primary" data-act="fin-inv-print" data-id="' + h(id) + '">Print or save as PDF</button></div></div></div>';
  }

  function pageUtr() {
    const F = state.fin, qv = F.utrQ.toLowerCase(), acct = payoutAccount();
    const list = payouts().filter((p) => !qv || [p.utr, String(p.amount), fullDay(p.at), METHODS[p.method] || p.method, p.reason].join(" ").toLowerCase().includes(qv));
    const help = '<div class="card"><h2>What is a UTR?</h2><p style="margin:0 0 8px">The Unique Transaction Reference your bank gives every transfer. It proves the payout was sent and lets your bank trace it.</p>' +
      '<ul class="steps"><li>NEFT: 16 characters · RTGS: 22 characters</li><li>IMPS and UPI: a 12-digit reference (RRN)</li><li>Find it in the narration or reference column of your bank statement to match each payout.</li></ul>' +
      '<p class="small muted" style="margin:0">Not in your account 2 working days after the date shown? Write to <a href="mailto:balaji@scraveit.in">balaji@scraveit.in</a> with the UTR.' + (acct.label ? " Payouts now go to " + h(acct.label) + "." : "") + "</p></div>";
    if (!WEB_CHECK) return '<div class="card empty"><strong>Bank references show here once website security is on</strong>Each payout\'s UTR comes from Scraveit\'s ledger.</div>' + help;
    return '<div class="row between"><input class="input" style="max-width:320px" placeholder="Search UTR, amount or date" value="' + h(F.utrQ) + '" data-input="utr-q"><button class="btn" data-act="fin-utr-csv"' + (list.length ? "" : " disabled") + ">Download for bank matching (CSV)</button></div>" +
      '<div class="card" style="padding:0;overflow:auto"><table class="table"><thead><tr><th>Date</th><th class="num">Amount</th><th>UTR / bank reference</th><th>Method</th><th>Status</th></tr></thead><tbody>' +
      (list.length ? list.map((p) => "<tr><td>" + h(fullDay(p.at)) + (p.status === "paid" ? '<div class="small muted">' + h(clock(p.at)) + "</div>" : "") + '</td><td class="num"><strong>' + inr(p.amount) + "</strong></td><td>" +
        (p.utr ? '<span class="utr">' + h(p.utr) + '</span> <button class="btn small" data-act="copy-utr" data-id="' + h(p.utr) + '">Copy</button>' : '<span class="muted">—</span>') + "</td><td>" + h(METHODS[p.method] || p.method || "") + "</td><td>" +
        (p.status === "paid" ? '<span class="pill paid">Sent</span>' : '<span class="pill wait">Held</span><div class="small muted">' + h(p.reason) + "</div>") + "</td></tr>").join("") :
        '<tr><td colspan="5" class="empty"><strong>' + (qv ? "Nothing matches" : "No payouts yet") + "</strong>" + (qv ? "Try the UTR's last few characters." : "Your first payout shows here with its bank reference.") + "</td></tr>") + "</tbody></table></div>" + help;
  }

  // ---------- menu ----------
  async function loadMenu() {
    const M = state.menu; M.loading = true; M.arrange = null; render();
    try { const all = (await db.collection("menus").doc(state.rid).collection("items").get()).docs.map((d) => Object.assign({id: d.id}, d.data())); M.items = all.filter((i) => i.archived !== true); M.archived = all.filter((i) => i.archived === true); } catch (e) { toast(friendly(e), true); M.items = []; }
    M.loading = false; render();
  }
  const itemImage = (i) => String(i.imageUrl || i.image || "");
  function menuScore(items) {
    if (!items.length) return {score: 0, tips: []};
    const n = items.length, photo = items.filter((i) => itemImage(i)).length / n, desc = items.filter((i) => String(i.description || "").trim().length >= 20).length / n;
    const stock = items.filter((i) => i.available !== false).length / n, extras = items.filter((i) => (i.variants || []).length || (i.addOns || []).length).length / n;
    const score = Math.round((photo * .35 + desc * .3 + stock * .2 + Math.min(1, extras * 2) * .15) * 100), tips = [];
    if (photo < .9) tips.push("Add photos: " + items.filter((i) => !itemImage(i)).length + " dishes have none. Dishes with photos sell more.");
    if (desc < .8) tips.push("Describe your dishes: " + items.filter((i) => String(i.description || "").trim().length < 20).length + " have a short or missing description.");
    if (stock < 1) { const off = items.filter((i) => i.available === false).length; tips.push(off + (off === 1 ? " dish is" : " dishes are") + " switched off. Turn them back on when they're available."); }
    if (extras < .3) tips.push("Offer sizes or add-ons (extra cheese, dips, a drink) to raise your average order value.");
    return {score, tips};
  }
  function pageMenu() {
    const M = state.menu;
    if (!M.items && !M.loading) setTimeout(loadMenu, 0);
    if (M.loading || !M.items) return '<div class="spinner"></div>';
    // Arranging: the order being built (category names, and item ids in each); otherwise the saved order.
    const A = M.arrange, ordered = menuInOrder(M.items), cats = {}; ordered.forEach((i) => { const c = catOf(i); cats[c] = (cats[c] || 0) + 1; });
    const catNames = A ? A.cats : Object.keys(cats);
    let items = A ? (M.cat && A.by[M.cat] ? A.by[M.cat].map((id) => M.items.find((i) => i.id === id)).filter(Boolean) : []) : ordered.filter((i) => !M.cat || catOf(i) === M.cat);
    if (M.q && !A) items = items.filter((i) => String(i.name || "").toLowerCase().includes(M.q.toLowerCase()));
    const s = menuScore(M.items), R = 40, C = 2 * Math.PI * R, editable = can("menu");
    const moves = (kind, i, n) => '<span class="moves">' + [["top", "Move to the top", "⤒", i === 0], ["up", "Move up", "↑", i === 0], ["down", "Move down", "↓", i === n - 1]].map((m) =>
      '<button class="mv" type="button" data-act="mv" data-kind="' + kind + '" data-i="' + i + '" data-to="' + m[0] + '" title="' + m[1] + '" aria-label="' + m[1] + '"' + (m[3] ? " disabled" : "") + ">" + m[2] + "</button>").join("") + "</span>";
    const bar = !editable ? "" : A ? '<div class="card row between arrange-bar"><span class="small">' + (M.cat ? "Move the dishes in <strong>" + h(M.cat) + "</strong>, or pick another category." : "Move categories with ⤒ ↑ ↓. Pick a category to move its dishes.") + '</span><div class="row"><button class="btn" data-act="arrange-cancel">Cancel</button><button class="btn primary" data-act="arrange-save"' + (A.dirty && !A.saving ? "" : " disabled") + ">" + (A.saving ? "Saving…" : "Save order") + "</button></div></div>" :
      '<div class="row" style="justify-content:flex-end;gap:8px"><button class="btn primary" data-act="item-new">+ Add ' + (sellsPacked() ? "product" : "dish") + "</button>" + ((M.archived || []).length ? '<button class="btn" data-act="show-archived">Archived (' + M.archived.length + ")</button>" : "") + (M.items.length > 1 ? '<button class="btn" data-act="arrange">Arrange menu</button>' : "") + "</div>";
    return '<div class="card score"><svg class="ring" viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="' + R + '"/><circle class="fg" cx="50" cy="50" r="' + R + '" stroke-dasharray="' + C + '" stroke-dashoffset="' + C * (1 - s.score / 100) + '"/><text x="50" y="58" text-anchor="middle">' + s.score + "%</text></svg>" +
      '<div><h2>Menu health</h2>' + (s.tips.length ? '<ul class="small" style="margin:0;padding-left:18px;display:grid;gap:4px">' + s.tips.map((t) => "<li>" + h(t) + "</li>").join("") + "</ul>" : '<p class="muted" style="margin:0">Your menu looks great: photos, descriptions and options are all in place.</p>') + "</div></div>" +
      (editable ? "" : '<div class="notice warn">You can view the menu. Ask the outlet owner for menu permission to change it.</div>') + gstRow() + bar +
      '<div class="menu-layout"><div class="card cats">' + (A ? "" : '<button class="cat' + (!M.cat ? " on" : "") + '" data-act="cat" data-cat=""><span>All dishes</span><span>' + M.items.length + "</span></button>") + catNames.map((c, ci) => '<div class="cat-row"><button class="cat' + (M.cat === c ? " on" : "") + '" data-act="cat" data-cat="' + h(c) + '"><span>' + h(c) + "</span><span>" + (A ? A.by[c].length : cats[c]) + "</span></button>" + (A ? moves("cat", ci, catNames.length) : "") + "</div>").join("") + "</div>" +
      '<div class="items">' + (A ? "" : '<input class="input" placeholder="Search dishes" value="' + h(M.q) + '" data-input="menu-q">') + (items.length ? items.map((i, ii) => '<div class="card item">' + (itemImage(i) ? '<img src="' + h(itemImage(i)) + '" alt="" loading="lazy">' : '<div class="ph"></div>') +
        '<div><h3>' + h(i.name || "Untitled") + '</h3><div class="small muted">' + h(i.category || "Other") + " · " + inr(i.price) + ((i.variants || []).length ? " · " + i.variants.length + " sizes" : "") + ((i.addOns || []).length ? " · " + i.addOns.length + " add-ons" : "") + '</div><div class="small muted">' + h(String(i.description || "").slice(0, 120)) + "</div></div>" +
        (A ? moves("item", ii, items.length) : '<div class="row"><span class="small muted">' + (i.available === false ? "Off" : "In stock") + '</span><button class="switch' + (i.available === false ? "" : " on") + '" data-act="stock" data-id="' + h(i.id) + '" aria-label="In stock"' + (editable ? "" : " disabled") + "></button>" + (editable ? '<button class="btn small" data-act="edit-item" data-id="' + h(i.id) + '">Edit</button>' : "") + "</div>") + "</div>").join("") :
        A ? '<div class="card empty"><strong>Pick a category</strong>Choose a category on the left to move its dishes.</div>' : '<div class="card empty"><strong>No dishes</strong>Click “+ Add ' + (sellsPacked() ? "product" : "dish") + '” to start your menu.</div>') + "</div></div>";
  }

  function archivedModal() {
    const list = state.menu.archived || [];
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal"><header><h2>Archived (' + list.length + ')</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      (list.length ? list.map((i) => '<div class="row between" style="border-top:1px solid var(--line);padding-top:8px"><span><strong>' + h(i.name) + '</strong><span class="small muted"> · ' + h(i.category || "") + " · " + inr(i.price) + '</span></span><span class="row" style="gap:6px"><button class="btn small good" data-act="item-restore" data-id="' + h(i.id) + '">Restore</button><button class="btn small" data-act="edit-item" data-id="' + h(i.id) + '">Open</button></span></div>').join("") : '<p class="muted">Nothing archived.</p>') + "</div></div>";
  }
  async function toggleStock(id) {
    const it = (state.menu.items || []).find((i) => i.id === id); if (!it || !can("menu")) return;
    const next = it.available === false;
    it.available = next; render();
    try { await db.collection("menus").doc(state.rid).collection("items").doc(id).update({available: next, updatedAt: Date.now()}); toast(next ? it.name + " is back in stock." : it.name + " is switched off."); }
    catch (e) { it.available = !next; render(); toast(friendly(e), true); }
  }
  // Add or edit a dish or product: everything the Restaurant app's menu form has, plus sizes and add-ons.
  // Goods stores (grocery, dairy, pharmacy) also get the pack label (Legal Metrology / FSSAI) and GST per product.
  const PACKAGED_FIELDS = () => {
    const ph = storeKind() === "pharmacy";
    return [["brand", "Brand", "", true], ["netQuantity", "Net quantity", "500 g, 1 L, 6 pieces", true], ["mrp", "MRP (₹, incl. of all taxes)", "", true, "number"],
      ["ingredients", "Ingredients", "As printed on the pack"], ["allergens", "Allergens", "Milk, nuts, gluten"], ["storage", "Storage", "Keep refrigerated below 4 °C"],
      ["shelfLife", "Shelf life", "6 months from packing"], ["manufacturer", "Manufacturer or packer name and address", "", true], ["manufacturerFssai", "Manufacturer FSSAI licence number", "14-digit number from the label", true],
      ["countryOfOrigin", "Country of origin", "India"]].filter((f) => !ph || !["ingredients", "allergens", "shelfLife", "manufacturerFssai"].includes(f[0]))
      .concat(ph ? [["manufacturingLicence", "Manufacturing licence number", "Mfg. Lic. No. on the pack (medicines only)"], ["expiry", "Expiry date", "As on the pack"]] : []);
  };
  const GST_GUIDES = () => {
    const g = [["", "Choose product type", null], ["milk", "Milk (fresh, pasteurised, UHT)", ["0401", 0, "nil", false]], ["paneer", "Paneer / chena", ["0406", 0, "nil", false]],
      ["curd_loose", "Curd, lassi, buttermilk (loose)", ["0403", 0, "nil", false]], ["curd_packed", "Curd, lassi, buttermilk (packed and labelled)", ["0403", 500, "taxable", true]],
      ["condensed_milk", "Condensed milk", ["0402", 500, "taxable", true]], ["butter_ghee", "Butter, ghee, dairy spread", ["0405", 500, "taxable", true]],
      ["cheese", "Cheese (not paneer)", ["0406", 500, "taxable", true]], ["plant_milk", "Plant / soya milk drink", ["2202", 500, "taxable", true]],
      ["fresh_veg", "Fresh vegetables and fruit", ["0702", 0, "nil", false]], ["eggs", "Fresh eggs", ["0407", 0, "nil", false]],
      ["rice_packed", "Rice (packed and labelled)", ["1006", 500, "taxable", true]], ["pulses_packed", "Dals and pulses (packed and labelled)", ["0713", 500, "taxable", true]],
      ["flour_packed", "Atta, rava, flour (packed and labelled)", ["1101", 500, "taxable", true]], ["sugar", "Sugar", ["1701", 500, "taxable", true]], ["salt", "Salt", ["2501", 0, "nil", false]],
      ["edible_oil", "Cooking oil", ["1512", 500, "taxable", true]], ["spices_packed", "Masala and spice powders (packed)", ["0910", 500, "taxable", true]],
      ["tea_coffee", "Tea or coffee powder", ["0902", 500, "taxable", true]], ["biscuits", "Biscuits", ["1905", 500, "taxable", true]], ["soap", "Bath soap", ["3401", 500, "taxable", true]],
      ["other", "Other: enter HSN and rate", null]];
    if (storeKind() === "pharmacy") g.splice(1, 0, ["medicine_otc", "Medicine sold without prescription (ORS, balm, lozenges)", ["3004", 500, "taxable", true]],
      ["bandages", "Bandages, cotton, gauze, plasters", ["3005", 500, "taxable", true]], ["thermometer", "Thermometer", ["9025", 500, "taxable", true]],
      ["diapers", "Baby diapers", ["9619", 500, "taxable", true]], ["sanitary_pads", "Sanitary pads, panty liners, tampons", ["9619", 0, "nil", true]],
      ["talc", "Talcum or baby powder", ["3304", 500, "taxable", true]], ["shampoo", "Shampoo or hair oil", ["3305", 500, "taxable", true]], ["toothpaste", "Toothpaste or tooth powder", ["3306", 500, "taxable", true]]);
    return g;
  };
  const sellsPacked = () => ["grocery", "dairy", "pharmacy"].includes(storeKind());
  const openTaxRule = (i) => (Array.isArray(i.taxRules) ? i.taxRules : []).filter((r) => !r.effectiveTo).sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0] || null;
  const choiceList = (v) => Array.isArray(v) ? v : Object.entries(v || {}).map(([id, c]) => Object.assign({id}, c));
  function choiceRow(kind, c) {
    return '<div class="choice-row" data-kind="' + kind + '"><input type="hidden" data-f="id" value="' + h(c.id || "") + '"><input class="input" data-f="name" maxlength="50" placeholder="' + (kind === "variant" ? "e.g. Half, Full, Large" : "e.g. Extra cheese") + '" value="' + h(c.name || "") + '">' +
      '<input class="input" data-f="price" type="number" min="0" step="1" placeholder="+₹" value="' + h(c.priceDelta != null ? c.priceDelta : c.price != null ? c.price : "") + '"><label class="small"><input type="checkbox" data-f="available"' + (c.available === false ? "" : " checked") + '> On</label><button type="button" class="btn small" data-act="choice-del" aria-label="Remove">✕</button></div>';
  }
  function editItemModal(id) {
    const M = state.menu, i = id ? ((M.items || []).find((x) => x.id === id) || (M.archived || []).find((x) => x.id === id)) : {}; if (!i) return;
    dishPhoto = null;
    const img = itemImage(i), isNew = !id, packed = sellsPacked(), noun = packed ? "product" : "dish", diet = i.diet === "nonveg" || i.diet === "egg" ? i.diet : "veg", c = i.compliance || {};
    const cats = [...new Set((M.items || []).map((x) => String(x.category || "").trim()).filter(Boolean))].slice(0, 16);
    const pkgField = ([key, label, ph, req, type]) => '<div class="field"><label>' + h(label) + (req ? ' <span class="small muted">for packed products</span>' : "") + '</label><input class="input" name="pkg_' + key + '"' + (type === "number" ? ' type="number" min="0" step="0.01"' : "") + ' value="' + h(c[key] != null ? c[key] : key === "countryOfOrigin" ? "India" : "") + '" placeholder="' + h(ph) + '" autocomplete="off"></div>';
    const PF = PACKAGED_FIELDS(), rule = openTaxRule(i) || {}, rate = Number(rule.gstRateBps || 0) / 100, guides = GST_GUIDES();
    const pkg = !packed ? "" : '<details class="card-sub" open><summary><strong>Label details</strong> <span class="small muted">' + (storeKind() === "pharmacy" ? "The law asks for these on packed products" : "FSSAI asks for these on packed products") + '. Loose items can skip this.</span></summary><div class="ol-grid">' + PF.map(pkgField).join("") + "</div></details>" +
      '<details class="card-sub" open><summary><strong>GST for this product</strong> <span class="small muted">Pick the product type and we fill the usual GST. Check it against your purchase bill.</span></summary><div class="ol-grid">' +
      '<div class="field"><label>Product type</label><select class="input" name="tax_guide" data-input="tax-guide">' + guides.map(([k, l]) => '<option value="' + k + '"' + (i.taxGuide === k ? " selected" : "") + ">" + h(l) + "</option>").join("") + "</select></div>" +
      '<div class="field"><label>HSN code</label><input class="input" name="tax_hsn" inputmode="numeric" maxlength="8" value="' + h(rule.hsnCode || "") + '" placeholder="0401"></div>' +
      '<div class="field"><label>GST rate</label><select class="input" name="tax_rate">' + [0, 5, 18, 40].map((v) => '<option value="' + v + '"' + (rate === v ? " selected" : "") + ">" + v + "%</option>").join("") + "</select></div>" +
      '<div class="field"><label>Treatment</label><select class="input" name="tax_kind"><option value="taxable"' + (rule.taxability === "taxable" || (!rule.taxability && rate > 0) ? " selected" : "") + '>Taxable</option><option value="nil"' + (rule.taxability === "nil" || (!rule.taxability && !(rate > 0)) ? " selected" : "") + '>Nil-rated</option><option value="exempt"' + (rule.taxability === "exempt" ? " selected" : "") + ">Exempt</option></select></div></div>" +
      '<label class="ol-check"><input type="checkbox" name="tax_packed"' + (rule.prepackagedLabelled ? " checked" : "") + "><span><strong>Pre-packaged and labelled</strong></span></label></details>";
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal wide" id="item-form" data-id="' + h(id || "") + '"><header><h2>' + (isNew ? "Add " : "Edit ") + noun + (i.archived ? " (archived)" : "") + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      (isNew ? '<p class="small muted" style="margin:0">Only the name and price are needed. The rest is optional.</p>' : "") +
      '<div class="dish-photo"><div class="dish-photo-box" id="dp-box">' + (img ? '<img id="dp-img" src="' + h(img) + '" alt="">' : '<img id="dp-img" alt="" hidden><span class="small muted" id="dp-empty">No photo yet</span>') + "</div>" +
      '<div class="dish-photo-side"><label class="btn small">' + (img ? "Change photo" : "Upload photo") + '<input type="file" accept="image/jpeg,image/png,image/webp" data-input="dish-photo" hidden></label>' +
      '<div class="dp-modes" id="dp-modes" hidden><button type="button" class="dp-mode on" data-act="dp-mode" data-mode="enhanced">✨ Enhanced</button><button type="button" class="dp-mode" data-act="dp-mode" data-mode="original">Original</button></div>' +
      '<p class="small muted" id="dp-note" style="margin:0">' + (packed ? "The front of the pack. " : "Bright, clear photos sell more. ") + "We brighten and sharpen your photo automatically.</p></div></div>" +
      '<div class="field"><label for="iname">Name</label><input class="input" id="iname" name="name" maxlength="80" required value="' + h(i.name || "") + '" placeholder="' + (packed ? "e.g. Amul milk" : "e.g. Masala dosa") + '"></div>' +
      '<div class="row"><div class="field grow"><label for="iprice">' + (packed ? "Selling price (₹)" : priceLabel()) + '</label><input class="input" id="iprice" name="price" type="number" min="0" step="1" required value="' + h(i.price != null ? i.price : "") + '" data-input="dish-price"><span class="small muted" id="iprice-get">' + (packed ? "" : youGetText(i.price)) + "</span></div>" +
      '<div class="field grow"><label for="icat">' + (packed ? "Section in your store" : "Section in your menu") + '</label><input class="input" id="icat" name="category" maxlength="40" list="icat-list" value="' + h(i.category || "") + '" placeholder="' + (packed ? "Milk, Dals, Snacks" : "Tiffins, Biryani, Drinks") + '"><datalist id="icat-list">' + cats.map((x) => '<option value="' + h(x) + '">').join("") + "</datalist></div></div>" +
      (packed ? "" : '<div class="field"><label>Veg or non-veg</label><div class="row" style="gap:8px">' + [["veg", "🟢 Veg"], ["nonveg", "🔴 Non-veg"], ["egg", "🟡 Egg"]].map(([v, t]) => '<label class="mp-meal"><input type="radio" name="diet" value="' + v + '"' + (diet === v ? " checked" : "") + "><span>" + t + "</span></label>").join("") + "</div></div>") +
      '<label class="ol-check"><input type="checkbox" name="available"' + (i.available !== false && !i.archived ? " checked" : "") + "><span><strong>In stock now</strong></span></label>" +
      '<div class="field"><div class="row between"><label for="idesc">Description</label>' + (packed ? "" : '<button type="button" class="btn small ai-btn" data-act="ai-desc">✨ Write with AI</button>') + "</div>" +
      '<textarea class="input" id="idesc" name="description" rows="3" maxlength="500" placeholder="' + (packed ? "Anything customers should know" : "What’s in it, how spicy, how much") + '">' + h(i.description || "") + "</textarea>" +
      '<div class="ai-row" id="ai-row" hidden><input class="input" id="ai-ask" maxlength="300" placeholder="Want changes? e.g. mention it\'s made with ghee, less spicy"><button type="button" class="btn small" data-act="ai-rewrite">Rewrite</button><button type="button" class="btn small" data-act="ai-undo" id="ai-undo" hidden>Undo</button></div>' +
      '<p class="small muted" id="ai-note" hidden style="margin:0">AI draft. Read it, change anything, then save.</p></div>' +
      '<details class="card-sub"' + (choiceList(i.variants).length || choiceList(i.addOns).length ? " open" : "") + '><summary><strong>Sizes and add-ons</strong> <span class="small muted">optional</span></summary>' +
      '<p class="small muted" style="margin:6px 0">Sizes: the customer must pick one. Its price is <strong>added</strong> to the price above (₹0 for the basic size). Add-ons: the customer can pick any; each adds its price.</p>' +
      '<div class="row between"><strong class="small">Sizes</strong><button type="button" class="btn small" data-act="choice-add" data-id="variant">+ Add size</button></div><div class="choices" id="ch-variant">' + choiceList(i.variants).map((x) => choiceRow("variant", x)).join("") + "</div>" +
      '<div class="row between" style="margin-top:8px"><strong class="small">Add-ons</strong><button type="button" class="btn small" data-act="choice-add" data-id="addon">+ Add add-on</button></div><div class="choices" id="ch-addon">' + choiceList(i.addOns).map((x) => choiceRow("addon", x)).join("") + "</div></details>" +
      pkg +
      '<details class="card-sub"' + (i.popular || i.calories != null ? " open" : "") + '><summary><strong>More details</strong> <span class="small muted">optional</span></summary><div class="ol-grid">' +
      '<div class="field"><label>' + (packed ? "Packing time (minutes)" : "Cooking time (minutes)") + '</label><input class="input" name="preparationTime" type="number" min="1" max="240" value="' + h(i.preparationTime || (packed ? 10 : 20)) + '"></div>' +
      (packed ? "" : '<div class="field"><label>Calories per serving (kcal)</label><input class="input" name="calories" type="number" min="0" max="5000" step="1" value="' + h(i.calories != null ? i.calories : "") + '" placeholder="Optional"></div><div class="field"><label>Serving size</label><input class="input" name="servingSize" maxlength="40" value="' + h(i.servingSize || "") + '" placeholder="e.g. 1 plate, 350 g"></div>') +
      "</div>" + (packed ? "" : '<p class="small muted" style="margin:4px 0">FSSAI needs calories per serving only if you hold a central licence or have 10 or more outlets.</p>') +
      '<label class="ol-check"><input type="checkbox" name="popular"' + (i.popular ? " checked" : "") + "><span><strong>Mark as popular</strong></span></label></details>" +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' + (isNew ? "" : i.archived ? '<button class="btn good" type="button" data-act="item-restore" data-id="' + h(id) + '">Restore</button>' : '<button class="btn" type="button" data-act="item-archive" data-id="' + h(id) + '">Archive</button>') +
      (isNew ? "" : '<button class="btn danger" type="button" data-act="item-delete" data-id="' + h(id) + '">Delete permanently</button>') + '<span class="grow"></span><button class="btn" type="button" data-act="close-modal">Cancel</button><button class="btn primary" type="submit">' + (isNew ? "Add " + noun : "Save changes") + "</button></div></form></div>";
    // A dish without a real description gets an AI draft straight away.
    if (!packed && !isNew && String(i.description || "").trim().length < 25) aiDescription(false);
  }
  // Markup restaurants (set by Scraveit): prices include GST and customers pay them plus the markup.
  function priceLabel() { return outlet() && outlet().doc && outlet().doc.pricingModel === "markup" ? "Your price, GST included (₹)" : gstIncluded() ? "Price, GST included (₹)" : "Price before GST (₹)"; }
  async function saveItem(form) {
    if (!can("menu")) return;
    const M = state.menu, existing = form.dataset.id, before = existing ? ((M.items || []).find((x) => x.id === existing) || (M.archived || []).find((x) => x.id === existing) || {}) : {};
    const packed = sellsPacked(), v = (n) => String((form.elements[n] || {}).value || "").trim();
    const name = v("name").slice(0, 80), price = Number(v("price")), category = v("category").slice(0, 40) || "Others";
    if (!name || v("price") === "" || !Number.isFinite(price) || price < 0) return toast("Add the name and price.", true);
    const readChoices = (kind) => Array.from(form.querySelectorAll('.choice-row[data-kind="' + kind + '"]')).map((r) => {
      const g = (f) => r.querySelector('[data-f="' + f + '"]'), nm = g("name").value.trim().slice(0, 50), pr = Number(g("price").value || 0);
      return nm ? {id: g("id").value || (kind === "variant" ? "v_" : "a_") + Math.random().toString(36).slice(2, 9), name: nm, price: Number.isFinite(pr) && pr >= 0 ? Math.round(pr) : 0, available: g("available").checked} : null;
    }).filter(Boolean);
    const variants = readChoices("variant"), addOns = readChoices("addon");
    if (new Set(variants.map((x) => x.name.toLowerCase())).size !== variants.length || new Set(addOns.map((x) => x.name.toLowerCase())).size !== addOns.length) return toast("Two sizes or two add-ons have the same name.", true);
    const id = existing || "item_" + Date.now().toString(36) + "_" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "dish");
    const record = Object.assign({}, before, {id, name, description: v("description").slice(0, 500), category, price: Math.round(price * 100) / 100,
      diet: packed ? "veg" : ((form.querySelector('input[name="diet"]:checked') || {}).value || "veg"), preparationTime: Math.max(1, Math.min(240, Number(v("preparationTime")) || 20)),
      available: form.elements.available.checked, popular: form.elements.popular.checked, archived: false, variants, addOns, updatedAt: Date.now(), updatedBy: state.user.email || state.user.uid});
    if (!existing) record.createdAt = Date.now();
    if (!packed) {
      const kcal = v("calories"), serving = v("servingSize").slice(0, 40);
      if (kcal !== "" && Number(kcal) >= 0 && Number(kcal) <= 5000) record.calories = Math.round(Number(kcal)); else delete record.calories;
      if (serving) record.servingSize = serving; else delete record.servingSize;
    } else {
      const PF = PACKAGED_FIELDS();
      const isPacked = form.elements.tax_packed.checked, mrpText = v("pkg_mrp"), mrp = Number(mrpText);
      if (isPacked) { const missing = PF.filter((f) => f[3] && !v("pkg_" + f[0])).map((f) => f[0] === "netQuantity" ? "Pack size" : f[1].replace(/ \(.*\)$/, "")); if (missing.length) return toast("Packed products need: " + missing.join(", ") + ".", true); }
      if ((isPacked || mrpText) && (!Number.isFinite(mrp) || mrp < price)) return toast("MRP must be at least the selling price.", true);
      const c = Object.assign({}, before.compliance || {}); PF.forEach(([key, , , , type]) => { const x = v("pkg_" + key); c[key] = type === "number" ? Number(x) : x; }); delete c.sampleValues; record.compliance = c;
      const hsn = v("tax_hsn").replace(/[^0-9]/g, "").slice(0, 8), kind = v("tax_kind") || "taxable", rateBps = kind === "taxable" ? Math.round(Number(v("tax_rate") || 0) * 100) : 0;
      if (!/^[0-9]{4,8}$/.test(hsn)) return toast("Enter the product's HSN code (4 to 8 digits).", true);
      if (kind === "taxable" && rateBps <= 0) return toast("A taxable product needs a GST rate above 0%, or mark it nil-rated.", true);
      // A changed GST treatment closes the old rule and starts a new one, so past orders keep theirs.
      const rules = (Array.isArray(before.taxRules) ? before.taxRules : []).map((r) => Object.assign({}, r)), open = rules.filter((r) => !r.effectiveTo).sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0], now = Date.now();
      const same = open && open.hsnCode === hsn && Number(open.gstRateBps || 0) === rateBps && open.taxability === kind && Boolean(open.prepackagedLabelled) === isPacked;
      if (!same) { if (open) open.effectiveTo = now; rules.push({hsnCode: hsn, gstRateBps: rateBps, taxability: kind, prepackagedLabelled: isPacked, effectiveFrom: open ? now : 0, effectiveTo: 0}); }
      record.taxRules = rules; if (v("tax_guide")) record.taxGuide = v("tax_guide");
    }
    if (!existing || String(before.category || "") !== category) { const placed = menuPlacement(category, id); Object.keys(placed).forEach((k) => { if (placed[k] === null) delete record[k]; else record[k] = placed[k]; }); }
    const saveBtn = form.querySelector('[type="submit"]'), label = saveBtn ? saveBtn.textContent : "";
    if (saveBtn) saveBtn.disabled = true;
    if (dishPhoto) {
      if (saveBtn) saveBtn.textContent = "Uploading photo…";
      try { Object.assign(record, await uploadDishPhoto(id)); }
      catch (e) { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = label; } return toast("Photo upload failed. " + friendly(e), true); }
    }
    try {
      await db.collection("menus").doc(state.rid).collection("items").doc(id).set(record);
      M.archived = (M.archived || []).filter((x) => x.id !== id); M.items = (M.items || []).filter((x) => x.id !== id).concat([record]);
      dishPhoto = null; closeModal(); toast(existing ? "Saved." : name + " is on your menu."); render();
    } catch (e) { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = label; } toast(friendly(e), true); }
  }
  async function archiveItem(id, back) {
    const M = state.menu, it = (M.items || []).concat(M.archived || []).find((x) => x.id === id); if (!it || !can("menu")) return;
    const patch = {archived: !back, available: !!back, updatedAt: Date.now(), updatedBy: state.user.email || state.user.uid};
    try {
      await db.collection("menus").doc(state.rid).collection("items").doc(id).update(patch); Object.assign(it, patch);
      M.items = (M.items || []).filter((x) => x.id !== id); M.archived = (M.archived || []).filter((x) => x.id !== id);
      (back ? M.items : M.archived).push(it); closeModal(); toast(back ? it.name + " is back on your menu." : it.name + " archived. Restore it any time from Archived."); render();
    } catch (e) { toast(friendly(e), true); }
  }
  async function deleteItem(id) {
    const M = state.menu, it = (M.items || []).concat(M.archived || []).find((x) => x.id === id); if (!it || !can("menu")) return;
    if (!confirm("Delete “" + it.name + "” permanently? This cannot be undone. Archive it instead if it may come back.")) return;
    try {
      await db.collection("menus").doc(state.rid).collection("items").doc(id).delete();
      M.items = (M.items || []).filter((x) => x.id !== id); M.archived = (M.archived || []).filter((x) => x.id !== id);
      closeModal(); toast("Deleted."); render();
    } catch (e) { toast(friendly(e), true); }
  }

  // ---------- dish photo: auto-enhance ----------
  // Like the big delivery apps: the photo is brightened, colour-balanced and
  // sharpened in the browser before upload. The owner can keep the original.
  let dishPhoto = null;
  function loadImage(file) {
    return new Promise((ok, fail) => { const url = URL.createObjectURL(file), im = new Image(); im.onload = () => { URL.revokeObjectURL(url); ok(im); }; im.onerror = () => { URL.revokeObjectURL(url); fail(new Error("That file isn't a photo we can open.")); }; im.src = url; });
  }
  function drawScaled(src, max) {
    const k = Math.min(1, max / Math.max(src.width, src.height)), c = document.createElement("canvas");
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, c.width, c.height); return c;
  }
  function enhanceCanvas(src) {
    const c = drawScaled(src, 1000), g = c.getContext("2d"), im = g.getImageData(0, 0, c.width, c.height), d = im.data, n = d.length / 4;
    // Levels from the 0.5% darkest to the 0.5% brightest pixels, and a gentle grey-world white balance.
    const hist = new Uint32Array(256); let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; }
    const at = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v; } return 255; };
    const lo = at(.002), hi = Math.max(at(.998), lo + 80), m = (sr + sg + sb) / 3;
    // The balance may take a colour cast out, but never takes red away or adds blue: food looks best warm.
    const gain = (s) => Math.min(1.04, Math.max(.96, 1 + .5 * (m / Math.max(s, 1) - 1)));
    const gr = Math.max(1, gain(sr)), gg = gain(sg), gb = Math.min(1, gain(sb)), scale = 255 / (hi - lo);
    const meanLuma = (sr * .3 + sg * .59 + sb * .11) / n, gamma = meanLuma < 110 ? .85 : meanLuma > 170 ? 1.08 : .97;
    // Levels and brightness, then a soft S-curve for a little more contrast.
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) { const x = Math.pow(Math.min(1, Math.max(0, (v - lo) * scale / 255)), gamma); lut[v] = 255 * (x * .8 + x * x * (3 - 2 * x) * .2); }
    for (let i = 0; i < d.length; i += 4) {
      const r = lut[Math.min(255, d[i] * gr) | 0], gch = lut[Math.min(255, d[i + 1] * gg) | 0], b = lut[Math.min(255, d[i + 2] * gb) | 0], l = r * .3 + gch * .59 + b * .11;
      d[i] = l + (r - l) * 1.15; d[i + 1] = l + (gch - l) * 1.15; d[i + 2] = l + (b - l) * 1.15;
    }
    // Light sharpening: the pixel minus a little of its neighbours.
    const w = c.width, src2 = new Uint8ClampedArray(d);
    for (let y = 1; y < c.height - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) d[i + k] = src2[i + k] * 1.36 - (src2[i - 4 + k] + src2[i + 4 + k] + src2[i - w * 4 + k] + src2[i + w * 4 + k]) * .09;
    }
    g.putImageData(im, 0, 0); return c;
  }
  const toBlob = (c, q) => new Promise((ok, fail) => c.toBlob((b) => b ? ok(b) : fail(new Error("Couldn't prepare the photo.")), "image/jpeg", q));
  async function pickDishPhoto(file) {
    if (!file) return;
    const note = document.getElementById("dp-note");
    if (file.size > 15 * 1024 * 1024) { toast("Pick a photo under 15 MB.", true); return; }
    if (note) note.textContent = "Enhancing your photo…";
    try {
      const im = await loadImage(file), original = drawScaled(im, 1000), enhanced = enhanceCanvas(im);
      dishPhoto = {original, enhanced, use: "enhanced"};
      showDishPhoto();
      const modes = document.getElementById("dp-modes"); if (modes) modes.hidden = false;
      if (note) note.textContent = "Enhanced: brighter colours and sharper detail. Tap Original to keep it as it was.";
    } catch (e) { dishPhoto = null; if (note) note.textContent = friendly(e); }
  }
  function showDishPhoto() {
    const img = document.getElementById("dp-img"), empty = document.getElementById("dp-empty"); if (!img || !dishPhoto) return;
    img.src = dishPhoto[dishPhoto.use].toDataURL("image/jpeg", .85); img.hidden = false; if (empty) empty.hidden = true;
    document.querySelectorAll(".dp-mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === dishPhoto.use));
  }
  async function uploadDishPhoto(id) {
    const chosen = dishPhoto[dishPhoto.use], base = "restaurants/" + state.rid + "/users/" + state.user.uid + "/menu/" + id + "/" + Date.now();
    const put = async (c, q, path) => { const ref = firebase.storage().ref(path); await ref.put(await toBlob(c, q), {contentType: "image/jpeg", cacheControl: "public, max-age=31536000"}); return ref.getDownloadURL(); };
    const [imageUrl, imageThumbUrl] = await Promise.all([put(chosen, .82, base + ".jpg"), put(drawScaled(chosen, 480), .72, base + "-thumb.jpg")]);
    return {imageUrl, imageThumbUrl};
  }

  // ---------- dish description: AI draft ----------
  let aiBusy = false, aiPrevious = null;
  async function aiDescription(rewrite) {
    const form = document.getElementById("item-form"); if (!form || aiBusy) return;
    const it = (state.menu.items || []).find((x) => x.id === form.dataset.id) || {}, box = form.description, ask = document.getElementById("ai-ask");
    const instructions = rewrite && ask ? ask.value.trim() : "";
    if (rewrite && !instructions) { if (ask) ask.focus(); toast("Type what you'd like changed.", true); return; }
    const btns = form.querySelectorAll('[data-act="ai-desc"],[data-act="ai-rewrite"]');
    aiBusy = true; btns.forEach((b) => { b.disabled = true; }); const was = box.value; box.disabled = true; box.placeholder = "Writing a description…"; if (!was) box.value = "";
    try {
      const photo = dishPhoto ? drawScaled(dishPhoto[dishPhoto.use], 512).toDataURL("image/jpeg", .7) : "";
      const r = await call("suggestDishDescription", {restaurantId: state.rid, name: form.name.value.trim() || it.name || "", category: form.category.value.trim(),
        price: Number(form.price.value) || 0, diet: String(it.diet || it.foodType || ""), current: was.trim(), instructions,
        imageUrl: photo ? "" : itemImage(it), imageData: photo});
      if (!document.body.contains(box)) return;
      aiPrevious = was; box.value = r.description;
      const row = document.getElementById("ai-row"), note = document.getElementById("ai-note"), undo = document.getElementById("ai-undo");
      if (row) row.hidden = false; if (note) note.hidden = false; if (undo) undo.hidden = !was; if (ask) ask.value = "";
    } catch (e) { if (document.body.contains(box)) box.value = was; toast(friendly(e), true); }
    finally { aiBusy = false; btns.forEach((b) => { b.disabled = false; }); box.disabled = false; box.placeholder = ""; }
  }

  // ---------- menu order and GST ----------
  // categoryRank and itemRank on each dish; anything not arranged yet follows, A to Z.
  // Same order as the customer app (native_android/app premium.js menuInOrder).
  const catOf = (i) => (i && i.category) || "Menu";
  function menuInOrder(items) {
    const rank = (v) => v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? Infinity : Number(v), catRank = {};
    items.forEach((i) => { const c = catOf(i), r = rank(i.categoryRank); if (!(c in catRank) || r < catRank[c]) catRank[c] = r; });
    return items.map((item, i) => ({item, i})).sort((a, b) => {
      const ca = catOf(a.item), cb = catOf(b.item);
      if (ca !== cb) return (catRank[ca] - catRank[cb]) || ca.localeCompare(cb);
      return (rank(a.item.itemRank) - rank(b.item.itemRank)) || String(a.item.name || "").localeCompare(String(b.item.name || "")) || (a.i - b.i);
    }).map((x) => x.item);
  }
  /** Where a dish moved to another category goes: last in it. null leaves it unranked. */
  function menuPlacement(category, id) {
    const num = (v) => v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v)), others = (state.menu.items || []).filter((i) => i.id !== id);
    const same = others.filter((i) => catOf(i) === category), own = same.filter((i) => num(i.categoryRank)).map((i) => Number(i.categoryRank));
    const all = others.filter((i) => num(i.categoryRank)).map((i) => Number(i.categoryRank)), ranks = same.filter((i) => num(i.itemRank)).map((i) => Number(i.itemRank));
    return {categoryRank: own.length ? Math.min(...own) : same.length || !all.length ? null : Math.max(...all) + 1, itemRank: ranks.length ? Math.max(...ranks) + 1 : null};
  }
  function startArrange() {
    const M = state.menu, cats = [], by = {};
    menuInOrder(M.items || []).forEach((i) => { const c = catOf(i); if (!by[c]) { by[c] = []; cats.push(c); } by[c].push(i.id); });
    M.arrange = {cats, by, dirty: false, saving: false}; M.q = ""; if (M.cat && !by[M.cat]) M.cat = ""; render();
  }
  function arrangeMove(kind, i, to) {
    const M = state.menu, A = M.arrange, list = A && (kind === "cat" ? A.cats : A.by[M.cat]); if (!list) return;
    const j = to === "top" ? 0 : to === "up" ? i - 1 : to === "down" ? i + 1 : i;
    if (j < 0 || j >= list.length || j === i) return;
    list.splice(j, 0, list.splice(i, 1)[0]); A.dirty = true; render();
  }
  async function saveArrange() {
    const M = state.menu, A = M.arrange; if (!A || A.saving || !A.dirty || !can("menu")) return;
    A.saving = true; render();
    const changes = [];
    A.cats.forEach((c, ci) => A.by[c].forEach((id, ii) => { const it = M.items.find((x) => x.id === id); if (it && (it.categoryRank !== ci || it.itemRank !== ii)) changes.push({it, ci, ii}); }));
    try {
      for (let k = 0; k < changes.length; k += 400) {
        const batch = db.batch(), now = Date.now();
        changes.slice(k, k + 400).forEach((x) => batch.update(db.collection("menus").doc(state.rid).collection("items").doc(x.it.id), {categoryRank: x.ci, itemRank: x.ii, updatedAt: now}));
        await batch.commit();
      }
      changes.forEach((x) => { x.it.categoryRank = x.ci; x.it.itemRank = x.ii; });
      M.arrange = null; toast("Menu order saved. Customers see it now."); render();
    } catch (e) { A.saving = false; render(); toast(friendly(e), true); }
  }
  // The restaurant's own switch (always on under markup): menu prices include GST, customers pay them as they
  // are and Scraveit pays the 5% GST inside them. Grocery and dairy stores set GST per product instead.
  function gstIncluded() { const d = outlet() && outlet().doc; return !!d && d.storeType !== "grocery" && d.storeType !== "dairy" && (d.pricingModel === "markup" || d.pricesIncludeGst === true); }
  function gstRow() {
    const d = outlet() && outlet().doc; if (!d || d.storeType === "grocery" || d.storeType === "dairy") return "";
    const markup = d.pricingModel === "markup", on = gstIncluded(), ok = !markup && (can("profile") || can("availability"));
    return '<div class="card row between gst-row"><div><strong>My prices include GST</strong><div class="small muted">' + (markup ? "Set by Scraveit for your plan: customers pay your price plus the markup, GST included." : on ? "Customers pay your menu price as it is. Scraveit pays the 5% GST from it." : "Customers pay your menu price plus 5% GST at checkout.") +
      '</div></div><button class="switch' + (on ? " on" : "") + '" data-act="gst" role="switch" aria-checked="' + on + '" aria-label="My prices include GST"' + (ok ? "" : " disabled") + "></button></div>";
  }
  async function toggleGst() {
    const o = outlet(); if (!o || o.doc.pricingModel === "markup" || !(can("profile") || can("availability"))) return;
    const next = o.doc.pricesIncludeGst !== true;
    if (!confirm(next ? "Your menu prices include GST? Customers pay them as they are, and Scraveit pays the 5% GST from them." : "Your menu prices are before GST? Customers pay your price plus 5% GST at checkout.")) return;
    try {
      await db.collection("restaurants").doc(o.id).update({pricesIncludeGst: next, updatedAt: Date.now(), updatedBy: state.user.email || state.user.uid});
      o.doc.pricesIncludeGst = next; toast(next ? "Your menu prices now include GST." : "GST is now added at checkout."); render();
    } catch (e) { toast(friendly(e), true); }
  }

  // ---------- offers ----------
  async function loadOffers() {
    const O = state.offers; O.loading = true; O.error = ""; render();
    try {
      const [list, perf] = await Promise.all([call("getRestaurantOffers", {restaurantId: state.rid}), call("getRestaurantOfferPerformance", {restaurantId: state.rid, days: 30}).catch(() => null)]);
      O.data = {offers: list && list.offers || [], perf};
    } catch (e) { O.error = friendly(e); O.data = {offers: [], perf: null}; }
    O.loading = false; render();
  }
  function pageOffers() {
    const O = state.offers, M = state.menu;
    if (!O.data && !O.loading) setTimeout(loadOffers, 0);
    if (!M.items && !M.loading) setTimeout(loadMenu, 0);
    if (O.loading || !O.data) return '<div class="spinner"></div>';
    const p = O.data.perf && (O.data.perf.summary || O.data.perf);
    const val = (k) => p && p[k] != null ? p[k] : null;
    const edit = isManager() || can("offers"), gifts = freebies(), pairs = pairings();
    return '<div class="row between"><p class="muted" style="margin:0;max-width:620px">Offers lift you into “Top offers near you”. A free item is your gift on top of the order; a pairing suggests your dishes, at their prices, under the dishes you choose; a discount takes money off the bill.</p>' +
      (edit ? '<div class="row"><button class="btn primary" data-act="freebie-new">+ Free item offer</button><button class="btn" data-act="pairing-new">+ Pair dishes</button><button class="btn" data-act="discount-new">+ Discount offer</button></div>' : "") + "</div>" +
      (O.error ? '<div class="notice warn">' + h(O.error) + "</div>" : "") +
      '<h2 class="offer-head">Free items</h2>' +
      (gifts.length ? '<div class="gift-grid">' + gifts.map((f) => giftCard(f, edit)).join("") + "</div>" :
        '<div class="card empty"><strong>No free-item offers yet</strong>Give a free side with chosen dishes (“Free French fries with any Crispy Box”), one with each.' + (edit ? '<div style="margin-top:12px"><button class="btn primary" data-act="freebie-new">+ Free item offer</button></div>' : "") + "</div>") +
      '<h2 class="offer-head">Pairings</h2>' +
      (pairs.length ? '<div class="gift-grid">' + pairs.map((x) => pairingCard(x, edit)).join("") + "</div>" :
        '<div class="card empty"><strong>No pairings yet</strong>Suggest dishes from your menu under the dishes you choose, once a customer adds one, with your own name for it (“Finish sweetly: Gulab Jamun, Double Ka Meetha” under burgers). Customers pay your menu price for it.' + (edit ? '<div style="margin-top:12px"><button class="btn primary" data-act="pairing-new">+ Pair dishes</button></div>' : "") + "</div>") +
      '<h2 class="offer-head">Discounts</h2>' +
      (p ? '<div class="kpis">' + [["Orders with offers (30 days)", val("orders") ?? val("orderCount")], ["Sales from offers", val("grossPaise") != null ? inr(val("grossPaise") / 100) : val("sales") != null ? inr(val("sales")) : null], ["Discount you gave", val("restaurantDiscountPaise") != null ? inr(val("restaurantDiscountPaise") / 100) : null]].filter((x) => x[1] != null).map((x) => '<div class="kpi"><span>' + h(x[0]) + "</span><strong>" + h(x[1]) + "</strong></div>").join("") + "</div>" : "") +
      '<div class="card" style="padding:0;overflow:auto"><table class="table"><thead><tr><th>Offer</th><th>Status</th><th>Runs</th></tr></thead><tbody>' +
      (O.data.offers.length ? O.data.offers.map((o) => "<tr><td><strong>" + h(o.title || o.name || (o.percent ? o.percent + "% off" : o.flatAmountPaise ? inr(o.flatAmountPaise / 100) + " off" : "Offer")) + '</strong><div class="small muted">' + h(o.code ? "Code " + o.code : "") + (o.minimumOrderPaise ? " · min order " + inr(o.minimumOrderPaise / 100) : "") + "</div></td><td><span class=\"pill " + (o.approvalStatus === "pending" ? "cod" : o.status === "active" || o.active ? "paid" : "done") + '">' + h(o.approvalStatus === "pending" ? "waiting for approval" : o.status || (o.active ? "active" : "inactive")) + "</span></td><td>" + (o.startsAt ? h(dayLabel(ms(o.startsAt))) : "") + (o.expiresAt ? " – " + h(dayLabel(ms(o.expiresAt))) : "") + "</td></tr>").join("") :
        '<tr><td colspan="3" class="empty"><strong>No discounts yet</strong>' + (edit ? "Use + Discount offer above." : "") + "</td></tr>") + "</tbody></table></div>";
  }

  // ---------- free-item offers ----------
  // Kept on the outlet's listing as `freebies` and saved through saveRestaurantFreebies, which
  // checks them. At checkout the server adds the free item to the order at ₹0 (functions
  // domain/freebies.ts): one with each chosen dish, or one once the item total reaches the amount.
  const freebies = () => (outlet() && outlet().doc && Array.isArray(outlet().doc.freebies) ? outlet().doc.freebies : []);
  const dishName = (id) => { const i = (state.menu.items || []).find((x) => x.id === id); return i ? i.name : ""; };
  function giftLine(f) {
    if (f.trigger === "amount") return "Free " + f.freeItem + " on orders above " + inr(f.minimumOrder);
    const names = (f.itemIds || []).map(dishName).filter(Boolean);
    return "Free " + f.freeItem + " with " + (names.length === 1 ? names[0] : names.length ? names[0] + " and " + (names.length - 1) + " more" : (f.itemIds || []).length + " dishes");
  }
  function giftCard(f, edit) {
    return '<div class="gift-card' + (f.active === false ? " paused" : "") + '"><div class="gift-top"><span class="gift-icon" aria-hidden="true">🎁</span><div class="grow"><strong>' + h(f.title) + '</strong><div class="small muted">' + h(giftLine(f)) + "</div></div>" +
      '<span class="pill ' + (f.active === false ? "done" : "paid") + '">' + (f.active === false ? "paused" : "live") + "</span></div>" +
      (f.trigger === "items" ? '<div class="gift-dishes">' + (f.itemIds || []).map((id) => '<span class="tag">' + h(dishName(id) || "Removed dish") + "</span>").join("") + "</div>" : "") +
      '<div class="gift-note small muted">' + (f.trigger === "items" ? "One " + h(f.freeItem) + " with each of these dishes, added to the order at ₹0." : "One " + h(f.freeItem) + " per order once the item total reaches " + inr(f.minimumOrder) + ".") + "</div>" +
      (edit ? '<div class="row"><button class="btn small" data-act="freebie-edit" data-id="' + h(f.id) + '">Edit</button><button class="btn small" data-act="freebie-pause" data-id="' + h(f.id) + '">' + (f.active === false ? "Resume" : "Pause") + '</button><button class="btn small danger" data-act="freebie-delete" data-id="' + h(f.id) + '">Delete</button></div>' : "") + "</div>";
  }
  function freebieModal(id) {
    const f = freebies().find((x) => x.id === id) || {id: "", title: "", freeItem: "", diet: "veg", trigger: "items", itemIds: [], minimumOrder: 0, active: true};
    const diet = (v, label) => '<label class="seg"><input type="radio" name="diet" value="' + v + '"' + (f.diet === v ? " checked" : "") + "><span>" + label + "</span></label>";
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal wide gift-form" id="freebie-form" data-id="' + h(f.id) + '" data-trigger="' + h(f.trigger) + '"><header><h2>' + (f.id ? "Edit free item offer" : "New free item offer") + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="row"><div class="field grow"><label for="fb-item">Free item</label><input class="input" id="fb-item" name="freeItem" maxlength="60" required placeholder="e.g. French Fries" value="' + h(f.freeItem) + '" data-input="fb-preview"></div>' +
      '<div class="field grow"><label for="fb-title">Offer name customers see</label><input class="input" id="fb-title" name="title" maxlength="60" placeholder="e.g. Free French fries" value="' + h(f.title) + '" data-input="fb-preview"></div></div>' +
      '<div class="field"><label>The free item is</label><div class="segs">' + diet("veg", "Veg") + diet("nonveg", "Non-veg") + diet("egg", "Contains egg") + "</div></div>" +
      '<div class="field"><label>Give it</label><div class="segs">' +
      '<label class="seg"><input type="radio" name="trigger" value="items" data-input="fb-trigger"' + (f.trigger !== "amount" ? " checked" : "") + "><span>With chosen dishes</span></label>" +
      '<label class="seg"><input type="radio" name="trigger" value="amount" data-input="fb-trigger"' + (f.trigger === "amount" ? " checked" : "") + "><span>On orders above an amount</span></label></div></div>" +
      '<div class="field when-amount"><label for="fb-min">Item total at least (₹)</label><input class="input" id="fb-min" name="minimumOrder" type="number" min="1" step="1" placeholder="e.g. 499" value="' + h(f.minimumOrder || "") + '" data-input="fb-preview"></div>' +
      '<div class="field when-items"><label>Dishes that come with it <span class="muted">(one free with each)</span></label>' +
      dishPicker("checkbox", "itemIds", new Set(f.itemIds || []), "fb-preview") + "</div>" +
      '<div class="gift-preview"><div class="small muted">Customers will see</div><div class="gift-preview-line" id="fb-preview"></div></div>' +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit">' + (f.id ? "Save offer" : "Start offer") + "</button></div></form></div>";
    freebiePreview();
  }
  function freebieFromForm(form) {
    const pick = (n) => (form.querySelector('input[name="' + n + '"]:checked') || {}).value;
    const trigger = pick("trigger") === "amount" ? "amount" : "items", freeItem = form.freeItem.value.trim().replace(/\s+/g, " ").slice(0, 60);
    return {id: form.dataset.id || "fb" + Date.now().toString(36), title: form.elements.title.value.trim().slice(0, 60) || (freeItem ? "Free " + freeItem : ""), freeItem, diet: pick("diet") || "veg", trigger,
      itemIds: trigger === "items" ? Array.from(form.querySelectorAll('input[name="itemIds"]:checked')).map((x) => x.value) : [],
      minimumOrder: trigger === "amount" ? Math.round(Number(form.minimumOrder.value) || 0) : 0,
      active: (freebies().find((x) => x.id === form.dataset.id) || {}).active !== false};
  }
  function freebiePreview() {
    const form = document.getElementById("freebie-form"), out = document.getElementById("fb-preview"); if (!form || !out) return;
    const f = freebieFromForm(form);
    form.dataset.trigger = f.trigger;
    out.innerHTML = f.freeItem ? "🎁 <strong>" + h(f.title) + "</strong> · " + h(giftLine(f)) : '<span class="muted">Type the free item to see it.</span>';
  }
  async function saveFreebies(list, done) {
    try {
      const r = await call("saveRestaurantFreebies", {restaurantId: state.rid, freebies: list});
      if (outlet() && outlet().doc) outlet().doc.freebies = r && r.freebies || list;
      closeModal(); toast(done); render();
    } catch (e) { toast(friendly(e), true); }
  }
  async function submitFreebie(form) {
    const f = freebieFromForm(form);
    if (f.freeItem.length < 2) { toast("Type the free item, e.g. French Fries.", true); return; }
    if (f.trigger === "items" && !f.itemIds.length) { toast("Tick the dishes that come with it.", true); return; }
    if (f.trigger === "amount" && !(f.minimumOrder > 0)) { toast("Enter the item total, e.g. 499.", true); return; }
    const list = freebies().filter((x) => x.id !== f.id).concat(f);
    if (list.length > 6) { toast("Up to 6 free-item offers. Delete one first.", true); return; }
    const btn = form.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
    await saveFreebies(freebies().some((x) => x.id === f.id) ? freebies().map((x) => x.id === f.id ? f : x) : list, form.dataset.id ? "Offer saved." : "Offer is live. Customers see it on your menu now.");
    if (btn) btn.disabled = false;
  }

  /** The menu by category, to tick dishes (checkbox) or pick one (radio), with a search box over it. */
  function dishPicker(type, name, picked, previewKey) {
    const items = state.menu.items || [], cats = {};
    if (!items.length) return '<div class="notice warn">Your menu is still loading. Close this and open it again in a moment.</div>';
    menuInOrder(items).forEach((i) => (cats[catOf(i)] = cats[catOf(i)] || []).push(i));
    return '<input class="input" placeholder="Search dishes" data-input="dish-search"><div class="dish-pick">' + Object.keys(cats).map((c) => '<div class="dish-cat"><div class="dish-cat-name">' + h(c) + "</div>" + cats[c].map((i) => '<label class="dish-opt" data-name="' + h(String(i.name || "").toLowerCase()) + '"><input type="' + type + '" name="' + name + '" value="' + h(i.id) + '" data-input="' + previewKey + '"' + (picked.has(i.id) ? " checked" : "") + "><span>" + h(i.name) + (i.available === false ? ' <span class="muted">(off)</span>' : "") + '</span><span class="muted">' + inr(i.price) + "</span></label>").join("") + "</div>").join("") + "</div>";
  }

  // ---------- pairings (paid) ----------
  // Kept on the outlet's listing as `pairings` and saved through saveRestaurantPairings. Each has the
  // restaurant's own name for it ("Finish sweetly"), the dishes from its menu to suggest, and the dishes
  // they show under: once a customer adds one of those, the app suggests them there at their menu prices.
  // They are ordinary menu items, so the bill, commission and GST work as for any dish.
  const MAX_PAIRINGS = 10, MAX_SUGGESTED = 10;
  const pairings = () => (outlet() && outlet().doc && Array.isArray(outlet().doc.pairings) ? outlet().doc.pairings : []);
  const menuDish = (id) => (state.menu.items || []).find((x) => x.id === id);
  const fewNames = (ids) => { const names = (ids || []).map(dishName).filter(Boolean); return names.length === 1 ? names[0] : names.length ? names[0] + " and " + (names.length - 1) + " more" : (ids || []).length + " dishes"; };
  function pairingCard(p, edit) {
    const off = (p.suggestIds || []).map(menuDish).filter((d) => d && d.available === false).map((d) => d.name);
    const tags = (ids) => (ids || []).map((id) => { const d = menuDish(id); return '<span class="tag">' + h(d ? d.name : "Removed dish") + (d && d.price ? " · " + inr(d.price) : "") + "</span>"; }).join("");
    return '<div class="gift-card' + (p.active === false ? " paused" : "") + '"><div class="gift-top"><span class="gift-icon pair-icon" aria-hidden="true">🍽️</span><div class="grow"><strong>' + h(p.title) + '</strong><div class="small muted">' + h(fewNames(p.suggestIds)) + " under " + h(fewNames(p.itemIds)) + "</div></div>" +
      '<span class="pill ' + (p.active === false ? "done" : "paid") + '">' + (p.active === false ? "paused" : "live") + "</span></div>" +
      '<div class="small muted">Suggests</div><div class="gift-dishes">' + tags(p.suggestIds) + "</div>" +
      '<div class="small muted">Under</div><div class="gift-dishes">' + tags(p.itemIds).replace(/ · ₹[\d,.]+/g, "") + "</div>" +
      '<div class="gift-note small muted">' + (off.length ? h(off.join(", ")) + (off.length === 1 ? " is" : " are") + " switched off on your menu, so customers don't see " + (off.length === 1 ? "it" : "them") + " right now." : "Once a customer adds one of these dishes, your suggestions show under it with Add buttons, at your menu prices.") + "</div>" +
      (edit ? '<div class="row"><button class="btn small" data-act="pairing-edit" data-id="' + h(p.id) + '">Edit</button><button class="btn small" data-act="pairing-pause" data-id="' + h(p.id) + '">' + (p.active === false ? "Resume" : "Pause") + '</button><button class="btn small danger" data-act="pairing-delete" data-id="' + h(p.id) + '">Delete</button></div>' : "") + "</div>";
  }
  function pairingModal(id) {
    const p = pairings().find((x) => x.id === id) || {id: "", title: "", suggestIds: [], itemIds: [], active: true}, addOk = can("menu");
    const diet = (v, label) => '<label class="seg"><input type="radio" name="newDiet" value="' + v + '"' + (v === "veg" ? " checked" : "") + "><span>" + label + "</span></label>";
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal wide gift-form" id="pairing-form" data-id="' + h(p.id) + '" data-adding=""><header><h2>' + (p.id ? "Edit pairing" : "Pair dishes") + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="field"><label for="pr-title">Your name for it <span class="muted">(customers see this)</span></label><input class="input" id="pr-title" name="title" maxlength="60" placeholder="e.g. Finish sweetly" value="' + h(p.title) + '" data-input="pr-preview"></div>' +
      '<div class="field"><label>Dishes to suggest <span class="muted">(tick as many as you like)</span></label>' + dishPicker("checkbox", "suggestIds", new Set(p.suggestIds || []), "pr-preview") +
      (addOk ? '<label class="seg pair-add-toggle"><input type="checkbox" name="addNew" data-input="pr-preview"><span>+ Add a dish that isn\'t on my menu</span></label>' +
        '<div class="when-new pair-new"><div class="row"><div class="field grow"><label for="pr-name">Dish name</label><input class="input" id="pr-name" name="newName" maxlength="70" placeholder="e.g. Gulab Jamun (2 pcs)" data-input="pr-preview"></div><div class="field"><label for="pr-price">' + priceLabel() + '</label><input class="input" id="pr-price" name="newPrice" type="number" min="1" step="1" placeholder="e.g. 50" data-input="pr-preview"></div></div>' +
        '<div class="row"><div class="field grow"><label>It is</label><div class="segs">' + diet("veg", "Veg") + diet("nonveg", "Non-veg") + diet("egg", "Contains egg") + '</div></div><div class="field grow"><label for="pr-cat">Menu category</label><input class="input" id="pr-cat" name="newCategory" maxlength="60" value="Desserts"></div></div>' +
        '<p class="small muted" style="margin:0">It joins your menu too, so customers can also order it on its own.</p></div>' : "") + "</div>" +
      '<div class="field"><label>Show them under <span class="muted">(only these dishes, once a customer adds one)</span></label>' + dishPicker("checkbox", "itemIds", new Set(p.itemIds || []), "pr-preview") + "</div>" +
      '<div class="gift-preview"><div class="small muted">Customers will see</div><div class="gift-preview-line" id="pr-preview"></div></div>' +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit">' + (p.id ? "Save pairing" : "Start pairing") + "</button></div></form></div>";
    pairingPreview();
  }
  function pairingFromForm(form) {
    const el = form.elements, adding = !!(el.addNew && el.addNew.checked), ticked = (n) => Array.from(form.querySelectorAll('input[name="' + n + '"]:checked')).map((x) => x.value);
    const suggestIds = ticked("suggestIds").concat(adding && form.dataset.newItem ? [form.dataset.newItem] : []);
    return {id: form.dataset.id || "pr" + Date.now().toString(36), title: el.title.value.trim().replace(/\s+/g, " ").slice(0, 60), suggestIds,
      itemIds: ticked("itemIds").filter((x) => !suggestIds.includes(x)),
      newDish: adding && !form.dataset.newItem ? {name: el.newName.value.trim().replace(/\s+/g, " ").slice(0, 70), price: Math.round(Number(el.newPrice.value) || 0),
        diet: (form.querySelector('input[name="newDiet"]:checked') || {}).value || "veg", category: el.newCategory.value.trim().slice(0, 60) || "Desserts"} : null,
      active: (pairings().find((x) => x.id === form.dataset.id) || {}).active !== false};
  }
  function pairingPreview() {
    const form = document.getElementById("pairing-form"), out = document.getElementById("pr-preview"); if (!form || !out) return;
    const p = pairingFromForm(form), names = p.itemIds.map(dishName).filter(Boolean);
    const dishes = p.suggestIds.map(menuDish).filter(Boolean).concat(p.newDish && p.newDish.name ? [p.newDish] : []);
    form.dataset.adding = form.elements.addNew && form.elements.addNew.checked ? "1" : "";
    out.innerHTML = dishes.length && names.length ? "Under <strong>" + h(names[0]) + "</strong>" + (names.length > 1 ? " and " + (names.length - 1) + " more" : "") + ", once added:" +
      '<div class="pair-preview"><strong>' + h(p.title || "Goes well with") + "</strong>" + dishes.map((d) => '<div class="pair-preview-row"><span class="grow">' + h(d.name) + "</span>" + (d.price > 0 ? "<strong>" + inr(d.price) + "</strong>" : "") + '<span class="pair-add">ADD</span></div>').join("") + "</div>" :
      '<span class="muted">Tick the dishes to suggest and the dishes to show them under.</span>';
  }
  /** Adds a plain dish to the menu, last in its category, and returns its id. */
  async function addDish(d) {
    const now = Date.now(), id = "item_" + now.toString(36) + "_" + (d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "dish");
    const doc = {id, name: d.name, category: d.category, description: "", price: d.price, diet: d.diet, preparationTime: 10,
      available: true, popular: false, archived: false, createdAt: now, updatedAt: now, updatedBy: state.user.email || state.user.uid}, placed = menuPlacement(d.category, id);
    Object.keys(placed).forEach((k) => { if (placed[k] !== null) doc[k] = placed[k]; });
    await db.collection("menus").doc(state.rid).collection("items").doc(id).set(doc);
    (state.menu.items = state.menu.items || []).push(doc);
    return id;
  }
  async function savePairings(list, done) {
    try {
      const r = await call("saveRestaurantPairings", {restaurantId: state.rid, pairings: list});
      if (outlet() && outlet().doc) outlet().doc.pairings = r && r.pairings || list;
      closeModal(); toast(done); render();
    } catch (e) { toast(friendly(e), true); }
  }
  async function submitPairing(form) {
    const p = pairingFromForm(form), known = pairings().some((x) => x.id === p.id), count = p.suggestIds.length + (p.newDish ? 1 : 0);
    if (!p.title) { toast("Give it a name customers see, e.g. Finish sweetly.", true); return; }
    if (p.newDish && (p.newDish.name.length < 2 || !(p.newDish.price > 0))) { toast("Type the new dish's name and price.", true); return; }
    if (!count) { toast("Tick the dishes to suggest.", true); return; }
    if (count > MAX_SUGGESTED) { toast("Suggest up to " + MAX_SUGGESTED + " dishes in one pairing.", true); return; }
    if (!p.itemIds.length) { toast("Tick the dishes to show them under.", true); return; }
    if (!known && pairings().length >= MAX_PAIRINGS) { toast("Up to " + MAX_PAIRINGS + " pairings. Delete one first.", true); return; }
    const btn = form.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
    // A new dish is added once; if saving the pairing then fails, trying again reuses it.
    if (p.newDish) {
      try { form.dataset.newItem = await addDish(p.newDish); p.suggestIds.push(form.dataset.newItem); } catch (e) { toast(friendly(e), true); if (btn) btn.disabled = false; return; }
    }
    const saved = {id: p.id, title: p.title, suggestIds: p.suggestIds, itemIds: p.itemIds.filter((x) => !p.suggestIds.includes(x)), active: p.active};
    await savePairings(known ? pairings().map((x) => x.id === saved.id ? saved : x) : pairings().concat(saved), form.dataset.id ? "Pairing saved." : "Pairing is live. Customers see it under those dishes now.");
    if (btn) btn.disabled = false;
  }

  // ---------- discount offers (codes) ----------
  function discountModal() {
    const day = (t) => isoDay(t);
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal" id="discount-form" data-kind="percent"><header><h2>New discount offer</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="field"><label>Discount</label><div class="segs"><label class="seg"><input type="radio" name="kind" value="percent" data-input="dc-kind" checked><span>% off</span></label><label class="seg"><input type="radio" name="kind" value="flat" data-input="dc-kind"><span>₹ off</span></label></div></div>' +
      '<div class="row when-percent"><div class="field grow"><label for="dc-pct">Percent off</label><input class="input" id="dc-pct" name="percent" type="number" min="1" max="100" step="1" placeholder="20"></div><div class="field grow"><label for="dc-max">Up to (₹)</label><input class="input" id="dc-max" name="maxDiscount" type="number" min="1" step="1" placeholder="100"></div></div>' +
      '<div class="field when-flat"><label for="dc-flat">Amount off (₹)</label><input class="input" id="dc-flat" name="flat" type="number" min="1" step="1" placeholder="75"></div>' +
      '<div class="row"><div class="field grow"><label for="dc-min">Minimum item total (₹)</label><input class="input" id="dc-min" name="minimum" type="number" min="0" step="1" placeholder="299"></div><div class="field grow"><label for="dc-code">Code</label><input class="input" id="dc-code" name="code" maxlength="24" required placeholder="SPICY20" style="text-transform:uppercase"></div></div>' +
      '<div class="field"><label for="dc-title">Name customers see</label><input class="input" id="dc-title" name="title" maxlength="120" required placeholder="20% off up to ₹100"></div>' +
      '<div class="row"><div class="field grow"><label for="dc-start">Starts</label><input class="input" id="dc-start" name="start" type="date" value="' + day(Date.now()) + '"></div><div class="field grow"><label for="dc-end">Ends (optional)</label><input class="input" id="dc-end" name="end" type="date"></div></div>' +
      '<p class="small muted" style="margin:0">You pay for the discount. Small offers go live at once; bigger ones wait for a quick Scraveit check.</p>' +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit">Start offer</button></div></form></div>';
  }
  async function submitDiscount(form) {
    const kind = (form.querySelector('input[name="kind"]:checked') || {}).value === "flat" ? "flat" : "percent", n = (v) => Math.round(Number(v) || 0);
    const at = (v, end) => v ? new Date(v + (end ? "T23:59:59" : "T00:00:00")).getTime() : 0;
    const body = {restaurantId: state.rid, code: form.code.value.trim().toUpperCase(), title: form.elements.title.value.trim(), kind,
      percent: kind === "percent" ? n(form.percent.value) : 0, flatAmountPaise: kind === "flat" ? n(form.flat.value) * 100 : 0,
      maxDiscountPaise: kind === "percent" ? n(form.maxDiscount.value) * 100 : n(form.flat.value) * 100, minimumOrderPaise: n(form.minimum.value) * 100,
      perCustomerLimit: 0, startsAt: at(form.start.value), expiresAt: at(form.end.value, true), active: true};
    if (!/^[A-Z0-9_-]{3,24}$/.test(body.code)) { toast("Use a code of 3–24 letters or numbers, e.g. SPICY20.", true); return; }
    if (kind === "percent" && (!(body.percent > 0) || !(body.maxDiscountPaise > 0))) { toast("Enter the percent and the most it takes off.", true); return; }
    if (kind === "flat" && !(body.flatAmountPaise > 0)) { toast("Enter the amount off.", true); return; }
    const btn = form.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
    try {
      const r = await call("saveRestaurantOffer", body);
      closeModal(); toast(r && r.approvalStatus === "pending" ? "Saved. It goes live after a quick Scraveit check." : "Offer is live."); state.offers.data = null; render();
    } catch (e) { toast(friendly(e), true); if (btn) btn.disabled = false; }
  }

  // ---------- ads: top placement ----------
  // A store pays a fixed price per day to be listed first in its city in the
  // customer app, marked "Ad". Scraveit sets the price and how many stores can
  // be on top on one day; the charge comes off the weekly payout, and a booking
  // cancelled before it starts is refunded in full. Owners book and cancel,
  // managers can look. Like order actions, this needs the website's App Check.
  const AD_DAYS = [1, 3, 7, 14, 30];
  const AD_STATUS = {live: ["paid", "Live"], upcoming: ["state", "Upcoming"], ended: ["done", "Ended"], cancelled: ["done", "Cancelled"]};
  const istDay = (key) => Date.parse(key + "T00:00:00+05:30");
  const weekday = (key) => new Date(istDay(key)).toLocaleDateString("en-IN", {weekday: "short"});
  async function loadAds() {
    const A = state.ads; A.loading = true; A.error = ""; render();
    const [data, profile] = await Promise.all([
      call("getSponsoredListings", {restaurantId: state.rid}).catch((e) => { A.error = friendly(e); return null; }),
      db.collection("restaurantPayoutProfiles").doc(state.rid).get().then((s) => s.exists ? s.data() : null, () => null),
    ]);
    A.data = data; A.profile = profile; A.loading = false; A.loaded = true;
    if (data && !data.availability.some((x) => x.day === A.start)) {
      // Start on the first day from which every day of the chosen length is free.
      const free = (x) => x.left > 0 && !x.mine, at = data.availability.findIndex((x, i) => data.availability.slice(i, i + A.days).filter(free).length === A.days);
      A.start = (data.availability[at] || data.availability.find(free) || {day: data.today}).day;
    }
    render();
  }
  // Same sum as the server (sponsoredQuote); the server refuses a booking if its total differs.
  function adQuote(d, days) { const price = d.dailyPricePaise * days, gst = Math.round(price * d.gstRateBps / 10000); return {price, gst, total: price + gst}; }
  function adRange() { const A = state.ads, d = A.data, i = d.availability.findIndex((x) => x.day === A.start); return i < 0 ? [] : d.availability.slice(i, i + A.days); }
  function adProblem() {
    const A = state.ads, d = A.data, days = adRange(), full = days.find((x) => x.left <= 0 && !x.mine), mine = days.find((x) => x.mine);
    if (d.notBookable) return d.notBookable;
    if (days.length < A.days) return "You can book up to " + d.bookAheadDays + " days ahead. Pick an earlier start or fewer days.";
    if (mine) return "You already have top placement on " + fullDay(istDay(mine.day)) + ". Pick days after your current booking.";
    if (full) return "All " + d.slotsPerCity + " top places in " + d.city + " are taken on " + fullDay(istDay(full.day)) + ". Pick other dates.";
    return "";
  }
  function pageAds() {
    const A = state.ads;
    if (!pageAllowed("ads")) return '<div class="card empty"><strong>Ads are for owners, managers and staff given Offers & ads</strong>Ask the outlet owner about top placement.</div>';
    if (!WEB_CHECK) return '<div class="card empty"><strong>Ads switch on with the website\'s security check</strong>Booking top placement is charged to your payout, so it runs through Scraveit\'s secure server. Until then, ask Scraveit to book it for you.</div>';
    if (!A.loaded && !A.loading) setTimeout(loadAds, 0);
    if (!A.loaded) return '<div class="spinner"></div>';
    if (!A.data) return '<div class="notice warn">Ads didn\'t load: ' + h(A.error || "try again.") + '</div><button class="btn" data-act="ad-reload">Try again</button>';
    const d = A.data, o = outlet().doc, now = Date.now(), live = d.bookings.find((b) => b.status === "live");
    const ahead = d.bookings.filter((b) => b.status === "upcoming").sort((a, b) => a.startAt - b.startAt);
    const daysAhead = ahead.reduce((n, b) => n + b.days, 0) + (live ? Math.ceil((live.endAt - now) / DAY) : 0);
    const spent = d.bookings.filter((b) => b.status !== "cancelled" && b.createdAt >= now - 30 * DAY).reduce((n, b) => n + b.totalPaise, 0);
    const kpis = '<div class="kpis">' +
      kpiBox("Top placement now", live ? '<span style="color:var(--good)">Live</span>' : "Not running", live ? "Until " + h(fullDay(live.endAt - DAY)) : ahead.length ? "Next from " + h(fullDay(ahead[0].startAt)) : "Book days below") +
      kpiBox("Days booked ahead", String(daysAhead), daysAhead ? "including today" : "None yet") +
      kpiBox("Price per day", inr(rs(d.dailyPricePaise)), (d.gstRateBps ? "+ " + pct(d.gstRateBps) + " GST · " : "") + d.slotsPerCity + " top places a day in " + h(d.city || "your city")) +
      kpiBox("Spent, last 30 days", inr(rs(spent)), "Taken from your payouts") + "</div>";

    const days = adRange(), problem = adProblem(), q = adQuote(d, A.days);
    const line = (label, v, cls) => "<div" + (cls ? ' class="' + cls + '"' : "") + "><span>" + label + "</span><span>" + v + "</span></div>";
    // No city, ads paused or no open days: say why instead of a booking form with no days in it.
    const closed = d.notBookable || (d.availability.length ? "" : "No days are open for booking right now.");
    const book = closed ? '<div class="card"><h2>Book top placement</h2><div class="notice warn small">' + h(closed) + '</div><p class="small muted" style="margin:8px 0 0">Your bookings and invoices stay below.</p></div>' :
      '<div class="card"><h2>Book top placement</h2>' +
      '<div class="ad-form"><div class="field"><label for="ad-start">Start</label><input class="input" id="ad-start" type="date" data-input="ad-start" min="' + h(d.today) + '" max="' + h(d.availability[d.availability.length - 1].day) + '" value="' + h(A.start) + '"></div>' +
      '<div class="field"><label>Days</label><div class="tabs">' + AD_DAYS.filter((n) => n <= d.maxDays).map((n) => '<button class="tab' + (A.days === n ? " on" : "") + '" data-act="ad-days" data-id="' + n + '">' + n + (n === 1 ? " day" : " days") + "</button>").join("") + "</div></div></div>" +
      '<div class="ad-days" aria-label="Top places left each day">' + days.map((x) => { const full = x.left <= 0 && !x.mine, k = x.mine ? "mine" : full ? "full" : x.left === 1 ? "few" : "ok";
        return '<div class="ad-day ' + k + '"><span>' + h(weekday(x.day)) + "</span><strong>" + h(dayLabel(istDay(x.day))) + "</strong><small>" + (x.mine ? "Booked" : full ? "Full" : x.left + " left") + "</small></div>"; }).join("") + "</div>" +
      (problem ? '<div class="notice warn small">' + h(problem) + "</div>" : "") +
      '<div class="bill">' + line(inr(rs(d.dailyPricePaise)) + " × " + A.days + (A.days === 1 ? " day" : " days"), inr(rs(q.price))) +
      (q.gst ? line("GST " + pct(d.gstRateBps) + " (SAC " + h(d.sac) + ")", inr(rs(q.gst))) : "") + line("Total, taken from your payout", inr(rs(q.total)), "tot") + "</div>" +
      (d.gstRateBps ? "" : '<p class="small muted" style="margin:8px 0 0">No GST is charged yet: Scraveit will add GST and send you a tax invoice once its GST registration is live.</p>') +
      '<div class="row" style="margin-top:12px"><button class="btn primary" data-act="ad-book"' + (problem || !d.canBook ? " disabled" : "") + ">Book " + A.days + (A.days === 1 ? " day" : " days") + " for " + inr(rs(q.total)) + "</button>" +
      (d.canBook ? '<span class="small muted">Cancel any time before it starts for a full refund.</span>' : '<span class="small muted">Only the outlet owner can book.</span>') + "</div></div>";

    const cover = (Array.isArray(o.coverPhotos) && o.coverPhotos[0] && (o.coverPhotos[0].url || o.coverPhotos[0])) || o.imageUrl || o.image || "";
    const how = '<div class="card"><h2>How it works</h2><div class="ad-preview"><div class="ad-preview-img"' + (cover ? ' style="background-image:url(\'' + h(String(cover).replace(/'/g, "%27")) + '\')"' : "") + '><span class="ad-tag">Ad</span></div>' +
      '<div><strong>' + h(o.name) + '</strong><div class="small muted">First under “All restaurants” in ' + h(d.city || "your city") + "</div></div></div>" +
      '<ul class="steps"><li>On each day you book (midnight to midnight), customers in ' + h(d.city || "your city") + " see you at the top of the list, marked “Ad”.</li>" +
      "<li>Only " + d.slotsPerCity + " outlets can be on top in " + h(d.city || "a city") + " on one day, so it stays worth it. First to book gets the place.</li>" +
      "<li>Customers still see you only while you're open and deliver to their address. If they sort by rating, distance or delivery fee, their choice comes first.</li>" +
      "<li>The amount comes off your next weekly payout and shows in Finance → Payouts.</li></ul></div>";

    const byBooking = (d.results && d.results.byBooking) || {};
    const rows = d.bookings.map((b) => { const st = AD_STATUS[b.status] || AD_STATUS.ended, res = byBooking[b.bookingId];
      const result = res && (b.status === "live" || b.status === "ended") ? '<div class="small muted">' + Math.round(res.impressions).toLocaleString("en-IN") + " seen · " + res.orders + (res.orders === 1 ? " order" : " orders") + " · " + inr(res.earned) + " earned</div>" : "";
      return "<tr><td class=\"nowrap\">" + h(fullDay(b.startAt)) + (b.days > 1 ? " – " + h(fullDay(b.endAt - DAY)) : "") + '<div class="small muted">Booked ' + h(fullDay(b.createdAt)) + "</div>" + result + '</td><td class="num">' + b.days +
        '</td><td class="num"><strong>' + inr(rs(b.totalPaise)) + "</strong>" + (b.gstPaise ? '<div class="small muted">incl. GST ' + inr(rs(b.gstPaise)) + "</div>" : "") + "</td><td>" +
        (b.invoiceNo ? '<button class="btn small" data-act="ad-inv" data-id="' + h(b.bookingId) + '">' + h(b.invoiceNo) + "</button>" : '<span class="muted">—</span>') + (b.creditNoteNo ? '<div class="small muted">Credit note ' + h(b.creditNoteNo) + "</div>" : "") +
        '</td><td><span class="pill ' + st[0] + '">' + st[1] + "</span>" + (b.status === "cancelled" ? '<div class="small muted">Refunded to payout</div>' : "") + "</td><td>" +
        (b.status === "upcoming" && d.canBook ? '<button class="btn small danger" data-act="ad-cancel" data-id="' + h(b.bookingId) + '"' + (A.busy ? " disabled" : "") + ">Cancel</button>" : "") + "</td></tr>"; }).join("");
    const list = '<div class="card" style="padding:0;overflow:auto"><div class="pad"><h2 style="margin:0">Your bookings</h2></div><table class="table"><thead><tr><th>Dates</th><th class="num">Days</th><th class="num">Amount</th><th>Invoice</th><th>Status</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="empty"><strong>No bookings yet</strong>Your top placement bookings show here.</td></tr>') + "</tbody></table></div>";
    return kpis + adResultsCard(d) + '<div class="split fin">' + book + how + "</div>" + list;
  }
  // What the ads did. Counted by the server: a view is a customer seeing the Ad card for at least
  // a second; an order counts when that customer tapped the Ad card and ordered here within 24
  // hours; earned is the food value of those orders once delivered. Spent is the price of the
  // days that have run, before GST.
  function adResultsCard(d) {
    const R = d.results, t = R && R.total;
    if (!t) return "";
    const ran = d.bookings.some((b) => b.status === "live" || b.status === "ended");
    if (!ran) return '<div class="card"><h2>What your ads did</h2><p class="muted" style="margin:0">Results show here from the first day your top placement runs: how many customers saw it, tapped it and ordered.</p></div>';
    const n = (v) => Math.round(Number(v || 0)).toLocaleString("en-IN");
    const roas = t.spent > 0 ? t.earned / t.spent : 0;
    const head = '<div class="row between" style="align-items:flex-end;flex-wrap:wrap;gap:12px"><div><h2 style="margin:0 0 6px">What your ads did</h2>' +
      '<div style="font-family:Manrope,sans-serif;font-size:26px;font-weight:800">Spent ' + inr(t.spent) + ' <span class="muted">→</span> Earned <span style="color:var(--good)">' + inr(t.earned) + "</span></div>" +
      '<div class="small muted">' + (t.spent > 0 ? (roas >= 1 ? "Every ₹1 on ads brought " + inr(Math.round(roas * 100) / 100) + " in orders." : "So far " + inr(Math.round(roas * 100) / 100) + " in orders for every ₹1 on ads.") : "") +
      (t.pendingOrders ? " " + t.pendingOrders + (t.pendingOrders === 1 ? " order is" : " orders are") + " still on the way and will add to this." : "") + "</div></div></div>";
    const kpis = '<div class="kpis" style="margin-top:14px">' +
      kpiBox("Customers reached", n(t.reach), "different people who saw your Ad") +
      kpiBox("Times seen", n(t.impressions), t.avgViewSeconds ? "looked at for " + (Math.round(t.avgViewSeconds * 10) / 10) + " s on average" : "at least a second each") +
      kpiBox("Taps", n(t.clicks), t.impressions ? (Math.round(t.ctr * 1000) / 10) + "% of views opened your menu" : "opened your menu") +
      kpiBox("Orders from ads", n(t.orders), (t.orders ? "worth " + inr(t.earned) : "delivered") + (t.cancelledOrders ? " · " + t.cancelledOrders + " cancelled" : "")) + "</div>";
    const days = (R.daily || []).slice(-14), top = Math.max(1, ...days.map((x) => x.impressions || 0));
    const rows = days.slice().reverse().map((x) => "<tr><td class=\"nowrap\">" + h(dayLabel(istDay(x.day))) + " <span class=\"small muted\">" + h(weekday(x.day)) + "</span></td>" +
      '<td style="min-width:140px"><div style="display:flex;align-items:center;gap:8px"><div style="height:8px;border-radius:4px;background:var(--brand);width:' + Math.max(2, Math.round((x.impressions || 0) / top * 100)) + 'px"></div><span class="num">' + n(x.impressions) + "</span></div></td>" +
      '<td class="num">' + n(x.reach) + '</td><td class="num">' + n(x.clicks) + '</td><td class="num">' + n(x.orders) + '</td><td class="num">' + inr(x.earned) + "</td></tr>").join("");
    const table = days.length ? '<div style="overflow:auto;margin-top:14px"><table class="table"><thead><tr><th>Day</th><th>Seen</th><th class="num">People</th><th class="num">Taps</th><th class="num">Orders</th><th class="num">Earned</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : "";
    return '<div class="card">' + head + kpis + table +
      '<p class="small muted" style="margin:10px 0 0">An order counts when the customer tapped your Ad and ordered from you within 24 hours. Earned is the food value of those orders once delivered. Spent is the price of the days that have run, before GST.</p></div>';
  }
  function adConfirmModal() {
    const A = state.ads, d = A.data, q = adQuote(d, A.days), days = adRange(); if (adProblem() || !d.canBook) return;
    A.requestId = "web" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const line = (label, v, cls) => "<div" + (cls ? ' class="' + cls + '"' : "") + "><span>" + label + "</span><span>" + v + "</span></div>";
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="Confirm booking"><header><h2>Confirm top placement</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>' +
      "<p style=\"margin:0\"><strong>" + h(outlet().doc.name) + "</strong> at the top in " + h(d.city) + " from <strong>" + h(fullDay(istDay(days[0].day))) + "</strong> to <strong>" + h(fullDay(istDay(days[days.length - 1].day))) + "</strong>.</p>" +
      '<div class="bill">' + line("Price", inr(rs(q.price))) + (q.gst ? line("GST " + pct(d.gstRateBps), inr(rs(q.gst))) : "") + line("Total", inr(rs(q.total)), "tot") + "</div>" +
      '<p class="small muted" style="margin:0">' + inr(rs(q.total)) + " is taken from your next weekly payout. You can cancel for a full refund until " + h(fullDay(istDay(days[0].day))) + " starts.</p>" +
      '<div class="row"><button class="btn grow" data-act="close-modal">Not now</button><button class="btn primary grow" data-act="ad-confirm"' + (A.busy ? " disabled" : "") + ">Confirm booking</button></div></div></div>";
  }
  async function bookAd() {
    const A = state.ads, d = A.data, q = adQuote(d, A.days); if (A.busy) return;
    A.busy = true; adConfirmModal();
    try {
      const b = await call("bookSponsoredListing", {restaurantId: state.rid, startDay: A.start, days: A.days, expectedTotalPaise: q.total, requestId: A.requestId});
      closeModal(); toast("Booked. You're on top in " + d.city + " from " + fullDay(b.startAt) + "."); state.fin.loaded = false;
      A.busy = false; A.start = ""; await loadAds();
    } catch (e) { A.busy = false; closeModal(); toast(friendly(e), true); loadAds(); }
  }
  async function cancelAd(id) {
    const A = state.ads, b = A.data && A.data.bookings.find((x) => x.bookingId === id); if (!b || A.busy) return;
    if (!confirm("Cancel top placement from " + fullDay(b.startAt) + "? " + inr(rs(b.totalPaise)) + " goes back to your next payout.")) return;
    A.busy = true; render();
    try { await call("cancelSponsoredListing", {restaurantId: state.rid, bookingId: id}); toast("Cancelled. " + inr(rs(b.totalPaise)) + " goes back to your payout."); state.fin.loaded = false; }
    catch (e) { toast(friendly(e), true); }
    A.busy = false; loadAds();
  }
  // The advertising tax invoice, with the particulars CGST rule 46 asks for.
  function adInvoiceHtml(b) {
    const d = state.ads.data, I = d.issuer, P = state.ads.profile || {}, out = outlet().doc, igst = b.igstPaise > 0, half = pct(1800 / 2), missing = [!I.gstin && "GSTIN", !I.address && "registered address"].filter(Boolean);
    return '<div class="inv">' + (missing.length ? '<div class="notice warn small">Not a complete tax invoice yet: Scraveit still has to add its ' + h(missing.join(", ")) + ". The number and amounts are final.</div>" : "") +
      '<div class="row between"><div><div class="inv-title">' + (missing.length ? "Invoice details" : "Tax invoice") + '</div><div class="small muted">Original for recipient</div></div><div class="num"><strong class="utr">' + h(b.invoiceNo) + '</strong><div class="small">Date ' + h(fullDay(b.createdAt)) + "</div></div></div>" +
      '<div class="inv-parties"><div><div class="small muted">Supplier</div><strong>' + h(I.legalName) + "</strong><div>" + h(I.address || "—") + "</div><div>GSTIN " + h(I.gstin || "—") + "</div><div>State " + h(stateName(I.stateCode)) + "</div></div>" +
      '<div><div class="small muted">Recipient</div><strong>' + h(P.legalBusinessName || out.name) + "</strong>" + (P.legalBusinessName && P.legalBusinessName !== out.name ? "<div>Trading as " + h(out.name) + "</div>" : "") +
      "<div>" + h([out.address, out.area, out.city].filter(Boolean).join(", ")) + "</div><div>GSTIN " + h(b.recipientGstin || "Unregistered") + "</div><div>Place of supply " + h(stateName(b.recipientStateCode)) + "</div></div></div>" +
      '<table class="table"><thead><tr><th>Description</th><th>SAC</th><th class="num">Taxable value</th>' + (igst ? '<th class="num">IGST 18%</th>' : '<th class="num">CGST ' + half + '</th><th class="num">SGST ' + half + "</th>") + '<th class="num">Total</th></tr></thead><tbody>' +
      "<tr><td>Top placement (advertising) in the Scraveit app, " + h(d.city) + ", " + h(fullDay(b.startAt)) + " to " + h(fullDay(b.endAt - DAY)) + " (" + b.days + (b.days === 1 ? " day" : " days") + ")</td><td>" + h(d.sac) + '</td><td class="num">' + inr(rs(b.pricePaise)) + "</td>" +
      (igst ? '<td class="num">' + inr(rs(b.igstPaise)) + "</td>" : '<td class="num">' + inr(rs(b.cgstPaise)) + '</td><td class="num">' + inr(rs(b.sgstPaise)) + "</td>") + '<td class="num"><strong>' + inr(rs(b.totalPaise)) + "</strong></td></tr></tbody></table>" +
      '<p class="small">Tax payable on reverse charge: No. Recovered from your weekly payout.' + (b.creditNoteNo ? " Cancelled before it started: credit note " + h(b.creditNoteNo) + " for the full amount." : "") + "</p>" +
      '<p class="small" style="text-align:right">For ' + h(I.legalName) + "<br>Authorised signatory</p></div>";
  }
  function adInvoiceModal(id) {
    const b = state.ads.data && state.ads.data.bookings.find((x) => x.bookingId === id); if (!b || !b.invoiceNo) return;
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal wide" role="dialog" aria-modal="true" aria-label="Invoice"><header><h2>Ads invoice</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>' + adInvoiceHtml(b) +
      '<div class="row"><button class="btn primary" data-act="ad-inv-print" data-id="' + h(id) + '">Print or save as PDF</button></div></div></div>';
  }

  // ---------- insights ----------
  // Worked out every night by Scraveit from the last 30 days of this outlet's orders, ratings and
  // menu (restaurantInsights/{rid}): what to fix first, what to keep an eye on, what is going well.
  const INSIGHT_KIND = {act: ["wait", "Do this"], watch: ["cod", "Keep an eye"], good: ["paid", "Going well"]};
  async function loadInsights() {
    const I = state.insights, rid = state.rid; I.loading = true; I.error = ""; I.rid = rid;
    try { const snap = await db.collection("restaurantInsights").doc(rid).get(); if (state.rid === rid) I.doc = snap.exists ? snap.data() : null; }
    catch (e) { I.error = friendly(e); I.doc = null; }
    I.loading = false; if (state.page === "insights") render();
  }
  function pageInsights() {
    const I = state.insights;
    if (I.rid !== state.rid && !I.loading) { I.doc = null; setTimeout(loadInsights, 0); return '<div class="spinner"></div>'; }
    if (I.loading) return '<div class="spinner"></div>';
    if (I.error) return '<div class="notice warn">Insights didn\'t load: ' + h(I.error) + '</div><button class="btn" data-act="insights-reload">Try again</button>';
    const doc = I.doc;
    if (!doc) return '<div class="card empty"><strong>Your first insights are on the way</strong>Scraveit looks at your orders, ratings and menu every night and tells you what to fix first. Check back tomorrow.</div>';
    const st = doc.stats || {}, list = Array.isArray(doc.insights) ? doc.insights : [];
    const order = {act: 0, watch: 1, good: 2}, sorted = list.slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    const pctOf = (v) => v == null ? "—" : Math.round(v * 100) + "%";
    const kpis = '<div class="kpis">' +
      kpiBox("Orders, 30 days", String(st.orders || 0), (st.delivered || 0) + " delivered") +
      kpiBox("Rating", st.ratingAvg ? "★ " + (Math.round(st.ratingAvg * 10) / 10) : "—", st.ratingCount ? st.ratingCount + " ratings" : "No ratings yet") +
      kpiBox("Real cooking time", st.prepMedian ? Math.round(st.prepMedian) + " min" : "—", st.prepStated ? "you say " + Math.round(st.prepStated) + " min" : "typical order") +
      kpiBox("Late orders", pctOf(st.lateShare), "arrived after the promised time") +
      kpiBox("Customers who came back", pctOf(st.repeatShare), "ordered more than once") +
      kpiBox("Time to accept", st.acceptSecondsMedian ? Math.round(st.acceptSecondsMedian) + " s" : "—", "typical order") + "</div>";
    const cards = sorted.map((x) => { const k = INSIGHT_KIND[x.severity] || INSIGHT_KIND.watch;
      return '<div class="card" style="display:grid;gap:6px"><div class="row between" style="gap:10px"><strong style="font-size:15.5px">' + h(x.title) + '</strong><span class="pill ' + k[0] + '">' + k[1] + "</span></div>" +
        (x.detail ? '<div class="muted">' + h(x.detail) + "</div>" : "") + (x.action ? '<div><strong>What to do:</strong> ' + h(x.action) + "</div>" : "") + "</div>"; }).join("");
    const act = list.filter((x) => x.severity === "act").length;
    return '<div class="notice info" style="margin-bottom:14px">' + (act ? act + (act === 1 ? " thing needs" : " things need") + " your attention." : "Nothing urgent. Keep it up.") +
      " Updated " + h(fullDay(Number(doc.generatedAt) || Date.now())) + " from the last 30 days.</div>" + kpis + '<div style="display:grid;gap:12px;margin-top:16px">' + (cards || '<div class="card empty"><strong>No suggestions right now</strong>Everything looks steady.</div>') + "</div>";
  }

  // ---------- outlet ----------
  function pageOutlet() {
    const o = outlet(); if (!o) return "";
    const r = o.doc, open = r.open !== false, cuisines = Array.isArray(r.cuisines) ? r.cuisines.join(", ") : (r.cuisine || r.cuisines || "");
    const cover = (coverList(r)[0] || {}).url || "";
    const rows = [["Address", [r.address, r.area, r.city].filter(Boolean).join(", ")], ["Phone", r.phone || r.contactPhone], ["Cuisines", cuisines], ["Hours", r.opensAt || r.opensUntil ? (r.opensAt || "—") + " to " + (r.opensUntil || "—") : ""], ["FSSAI", r.fssaiNumber], ["Rating", r.rating ? Number(r.rating).toFixed(1) + " ★ (" + Number(r.ratingCount || 0) + " ratings)" : "New"], ["Outlet ID", o.id], ["Your role", ROLE_NAME[o.member.role] || "Staff"],
      ["You can use", isManager() ? "" : FEATURES.filter((f) => can(f[0])).map((f) => f[1]).join(", ") || "Outlet info only"]];
    return cpAskHtml() + '<div class="card" style="padding:0;overflow:hidden">' + (cover ? '<img src="' + h(cover) + '" alt="" style="width:100%;height:200px;object-fit:cover;display:block">' : "") +
      '<div style="padding:16px"><div class="row between"><div><h2 style="font-size:22px;margin:0">' + h(r.name) + '</h2><div class="muted">' + h(cuisines) + "</div></div>" +
      '<button class="status-toggle' + (open ? " on" : "") + '" data-act="toggle-open"' + (can("availability") ? "" : " disabled") + "><i></i>" + (open ? "Accepting orders" : "Not accepting orders") + "</button></div>" +
      '<table class="table" style="margin-top:12px"><tbody>' + rows.filter((x) => x[1]).map((x) => '<tr><td class="muted" style="width:160px">' + h(x[0]) + "</td><td>" + h(x[1]) + "</td></tr>").join("") + "</tbody></table>" +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' + (can("profile") ? '<button class="btn primary" data-act="outlet-edit">Edit outlet details</button>' : "") + '<button class="btn" data-act="agreement">📄 Your agreement (commission)</button>' + (can("menu") || can("offers") ? '<button class="btn" data-act="price-check">🧮 Price check</button>' : "") + "</div>" + '<p class="small muted">Bank and UPI details are in Finance → Payouts. Questions? Write to <a href="mailto:balaji@scraveit.in">balaji@scraveit.in</a>.</p><p class="small" style="margin:14px 0 0"><a href="/privacy" target="_blank" rel="noopener">Privacy policy</a> · <a href="/terms" target="_blank" rel="noopener">Terms</a> · <button class="linklike" data-act="delete-account">Delete account</button>' + (isOwner() ? ' · <button class="linklike" data-act="rg-new-outlet">Register another outlet</button>' : "") + "</p></div></div>";
  }
  async function toggleOpen() {
    const o = outlet(); if (!o || !can("availability")) return;
    const next = o.doc.open === false;
    if (!next && !confirm("Stop taking new orders at " + o.doc.name + "? Orders already placed still need to be prepared.")) return;
    try {
      await db.collection("restaurants").doc(o.id).update({open: next, offlineUntil: null, offlineReason: next ? "" : "Paused from the partner dashboard", updatedAt: Date.now(), updatedBy: state.user.email || state.user.uid});
      o.doc.open = next; toast(next ? "You're accepting orders." : "Outlet is offline."); render();
    } catch (e) { toast(friendly(e), true); }
  }

  // One switch for every outlet this account may open or close (same as the app's "Open all / Close all").
  const availabilityOutletIds = () => Object.keys(state.outlets || {}).filter((rid) => {
    const m = (state.outlets[rid] || {}).member || {};
    return m.active === true && (m.role === "restaurant_owner" || m.role === "restaurant_manager" || !!(m.permissions && m.permissions.availability === true));
  });
  async function setAllOutlets(open) {
    const ids = availabilityOutletIds(); if (ids.length < 2) return;
    if (!open && !confirm("Close all " + ids.length + " outlets? Customers see all of them as closed until you open them again.")) return;
    const patch = {open, offlineUntil: null, offlineReason: open ? "" : "Paused from the partner dashboard", updatedAt: Date.now(), updatedBy: state.user.email || state.user.uid};
    const res = await Promise.allSettled(ids.map((rid) => db.collection("restaurants").doc(rid).update(patch)));
    res.forEach((r, i) => { if (r.status === "fulfilled" && state.outlets[ids[i]]) state.outlets[ids[i]].doc.open = open; });
    const failed = res.filter((r) => r.status === "rejected").length;
    toast(failed ? (ids.length - failed) + " of " + ids.length + " outlets changed. Try again for the rest." : open ? "All " + ids.length + " outlets are accepting orders." : "All " + ids.length + " outlets are closed.", failed > 0);
    render();
  }

  // ---------- outlet details: edit (same fields as the Restaurant app's Restaurant screen) ----------
  // Founder 17 Nov 2026: everything in the app should be on the website too.
  const MAX_COVERS = 10;
  const OL = {draft: null, covers: null, zoom: 16, uploading: false, saving: false};
  function coverList(r) {
    r = r || {};
    const list = (Array.isArray(r.coverImages) ? r.coverImages : []).map((x) => typeof x === "string" ? {url: x, thumbUrl: x} : x && x.url ? {url: String(x.url), thumbUrl: String(x.thumbUrl || x.url)} : null).filter(Boolean);
    if (!list.length && (r.imageUrl || r.image)) list.push({url: String(r.imageUrl || r.image), thumbUrl: String(r.imageThumbUrl || r.imageUrl || r.image)});
    return list.slice(0, MAX_COVERS);
  }
  const worldPx = (lat, lng, z) => { const sc = 256 * Math.pow(2, z), sn = Math.sin(lat * Math.PI / 180); return {x: (lng + 180) / 360 * sc, y: (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * sc}; };
  const pxLatLng = (x, y, z) => { const sc = 256 * Math.pow(2, z), n = Math.PI - 2 * Math.PI * y / sc; return {lat: 180 / Math.PI * Math.atan(Math.sinh(n)), lng: x / sc * 360 - 180}; };
  // ---------- the outlet map, the same as the Restaurant app (22 Nov 2026) ----------
  // Drag, pinch (or Ctrl + scroll) and double-click look around; the pin moves only after "Move pin" on the
  // full-screen map, and in Edit outlet details it is kept only when the form is saved.
  const WM_PIN = '<svg class="wm-pin-svg" viewBox="0 0 40 52" aria-hidden="true"><path d="M20 51s17-17.6 17-31A17 17 0 0 0 3 20c0 13.4 17 31 17 31Z"/><circle cx="20" cy="20" r="6.5"/></svg>';
  const WM_IC = {expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/></svg>', target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>', minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>', close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 3 10.5l7.5 2.5L13 21z"/></svg>', pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.6 7-12a7 7 0 0 0-14 0c0 5.4 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>'};
  const WM_HOME = {lat: 14.9077, lng: 79.8946};
  const wmPoint = (lat, lng) => { if (lat === "" || lat == null || lng === "" || lng == null) return null; lat = Number(lat); lng = Number(lng); return Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? {lat, lng} : null; };
  const wmSame = (a, b) => (!a && !b) || !!(a && b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7);
  // Tiles cover the box plus one tile each side, so a drag never shows an empty edge.
  function wmTiles(c, z, w, hh, pin, was) {
    const wp = worldPx(c.lat, c.lng, z), max = Math.pow(2, z), mx = w / 2 + 256, my = hh / 2 + 256;
    const x0 = Math.floor((wp.x - mx) / 256), x1 = Math.floor((wp.x + mx) / 256), y0 = Math.max(0, Math.floor((wp.y - my) / 256)), y1 = Math.min(max - 1, Math.floor((wp.y + my) / 256));
    let t = "";
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const wrap = ((tx % max) + max) % max;
      t += '<img src="https://savrivo-app.web.app/maptile/day/' + z + "/" + wrap + "/" + ty + '" data-osm="https://tile.openstreetmap.org/' + z + "/" + wrap + "/" + ty + '.png" alt="" draggable="false" style="left:calc(50% + ' + (tx * 256 - wp.x).toFixed(1) + "px);top:calc(50% + " + (ty * 256 - wp.y).toFixed(1) + 'px)">';
    }
    if (pin) { const pp = worldPx(pin.lat, pin.lng, z); t += '<div class="wm-pin' + (was ? " was" : "") + '" style="left:calc(50% + ' + (pp.x - wp.x).toFixed(1) + "px);top:calc(50% + " + (pp.y - wp.y).toFixed(1) + 'px)">' + WM_PIN + "</div>"; }
    return t;
  }
  // A tile our server can't give comes from OpenStreetMap instead.
  document.addEventListener("error", (e) => { const t = e.target; if (t && t.tagName === "IMG" && t.dataset && t.dataset.osm && t.src !== t.dataset.osm) t.src = t.dataset.osm; }, true);
  function wmGet(root) { return {c: {lat: Number(root.dataset.clat), lng: Number(root.dataset.clng)}, z: Number(root.dataset.zoom) || 16, pin: wmPoint(root.dataset.plat, root.dataset.plng), edit: root.dataset.mode === "edit"}; }
  function wmDraw(root) {
    const m = wmGet(root), layer = root.querySelector(".wm-layer"); if (!layer) return;
    layer.style.transform = ""; layer.innerHTML = wmTiles(m.c, m.z, root.clientWidth || 520, root.clientHeight || 260, m.pin, m.edit);
    const scope = root.closest(".wm-full") || root, back = scope.querySelector(".wm-recenter");
    if (back) { let off = false; if (m.pin) { const p = worldPx(m.c.lat, m.c.lng, m.z), q = worldPx(m.pin.lat, m.pin.lng, m.z); off = Math.hypot(p.x - q.x, p.y - q.y) > 24; } back.hidden = !off; }
    const coords = scope.querySelector("#wm-coords"); if (coords && m.edit) coords.textContent = m.c.lat.toFixed(6) + ", " + m.c.lng.toFixed(6);
  }
  function wmSet(root, c, z) { root.dataset.clat = c.lat; root.dataset.clng = c.lng; root.dataset.zoom = Math.max(4, Math.min(19, Math.round(z))); wmDraw(root); if (root.id === "ol-map") OL.zoom = Number(root.dataset.zoom); }
  // The small map in Edit outlet details and in registration. OL.draft is the pin the form will save; OL.saved the one it had.
  function olDrawMap() {
    const box = document.getElementById("ol-map"); if (!box) return;
    const pin = wmPoint(OL.draft && OL.draft.lat, OL.draft && OL.draft.lng), c = pin || WM_HOME;
    box.className = "wm"; box.removeAttribute("data-act"); box.dataset.mode = "view"; box.dataset.clat = c.lat; box.dataset.clng = c.lng; box.dataset.zoom = OL.zoom;
    box.dataset.plat = pin ? pin.lat : ""; box.dataset.plng = pin ? pin.lng : "";
    box.setAttribute("role", "application"); box.setAttribute("aria-label", "Map of your outlet. Drag to look around.");
    box.innerHTML = '<div class="wm-layer"></div><button type="button" class="wm-btn wm-expand" data-act="wm-expand" aria-label="Full screen map" title="Full screen">' + WM_IC.expand + "</button>" +
      '<button type="button" class="wm-btn wm-recenter" data-act="wm-recenter" aria-label="Back to the pin" title="Back to the pin" hidden>' + WM_IC.target + "</button>" +
      '<button type="button" class="wm-move" data-act="wm-move">' + WM_IC.pin + "<span>" + (pin ? "Move pin" : "Set pin") + "</span></button>";
    wmDraw(box);
    const cap = document.getElementById("ol-map-cap"); if (cap) cap.textContent = pin ? "Delivery partners come to this pin. Click Move pin to change it." : "No pin yet. Click Set pin and put it on your entrance.";
    const co = document.getElementById("ol-coords"); if (co) co.textContent = pin ? pin.lat.toFixed(6) + ", " + pin.lng.toFixed(6) : "";
    const u = document.getElementById("ol-unsaved");
    if (u) u.innerHTML = OL.ctx === "outlet" && !wmSame(pin, OL.saved) ? '<div class="notice warn wm-unsaved"><span class="grow">Pin moved, not saved yet. Click Save outlet details to keep it.</span><button type="button" class="linklike" data-act="wm-undo">Undo</button></div>' : "";
  }
  let wmOpen = false;
  const wmFullRoot = () => wmOpen ? document.getElementById("wm-full-map") : null;
  function wmClose() { if (!wmOpen) return; wmOpen = false; const w = document.getElementById("wm-full"); if (w) w.remove(); document.documentElement.classList.remove("wm-open"); if (wmG && !wmG.root.isConnected) { wmG = null; wmPointers.clear(); } }
  function wmOpenFull(mode) {
    wmClose();
    const inline = document.getElementById("ol-map"), src = inline && inline.dataset.clat ? wmGet(inline) : {c: WM_HOME, z: OL.zoom, pin: null}, edit = mode === "edit";
    const c = edit ? (src.pin || src.c) : src.c, z = Math.min(19, edit ? Math.max(17, src.z) : src.z + 1);
    const wrap = document.createElement("div"); wrap.id = "wm-full"; wrap.className = "wm-full"; wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-modal", "true"); wrap.setAttribute("aria-label", "Outlet location");
    wrap.innerHTML = '<div id="wm-full-map" class="wm" data-mode="' + (edit ? "edit" : "view") + '" data-clat="' + c.lat + '" data-clng="' + c.lng + '" data-zoom="' + z + '" data-plat="' + (src.pin ? src.pin.lat : "") + '" data-plng="' + (src.pin ? src.pin.lng : "") + '" role="application" aria-label="Map. Drag to look around."><div class="wm-layer"></div><div class="wm-center" aria-hidden="true">' + WM_PIN + "<i></i></div></div>" +
      '<button type="button" class="wm-btn wm-close" data-act="wm-close" aria-label="Close map" title="Close">' + WM_IC.close + "</button>" +
      '<p class="wm-hint">Drag the map to put the pin on your outlet’s entrance.</p>' +
      '<div class="wm-tools"><div class="wm-zoom"><button type="button" data-act="wm-zoom" data-id="1" aria-label="Zoom in" title="Zoom in">' + WM_IC.plus + '</button><button type="button" data-act="wm-zoom" data-id="-1" aria-label="Zoom out" title="Zoom out">' + WM_IC.minus + "</button></div>" +
      '<button type="button" class="wm-btn wm-recenter" data-act="wm-recenter" aria-label="Back to the pin" title="Back to the pin" hidden>' + WM_IC.target + "</button>" +
      '<button type="button" class="wm-btn wm-locate" data-act="wm-locate" aria-label="Use this device\'s location" title="Use this device\'s location">' + WM_IC.locate + "</button></div>" +
      '<div class="wm-panel"></div>';
    document.body.appendChild(wrap); wmOpen = true; document.documentElement.classList.add("wm-open"); wmPanel(); wmDraw(wmFullRoot());
  }
  function wmPanel() {
    const wrap = wmOpen && document.getElementById("wm-full"), root = wmFullRoot(); if (!wrap || !root) return;
    const m = wmGet(root), panel = wrap.querySelector(".wm-panel"), reg = OL.ctx === "reg";
    const name = reg ? String(regDraft().restaurantName || "") : String((outlet() && outlet().doc.name) || "");
    const addrBox = document.getElementById(reg ? "rg-location.address" : "ol-address"), addr = String(addrBox ? addrBox.value : "").trim();
    wrap.classList.toggle("editing", m.edit);
    panel.innerHTML = m.edit
      ? '<p class="wm-coords"><strong>Pin here</strong><span id="wm-coords">' + m.c.lat.toFixed(6) + ", " + m.c.lng.toFixed(6) + '</span></p><div class="wm-actions"><button type="button" class="btn" data-act="wm-close">Cancel</button><button type="button" class="btn primary" data-act="wm-confirm">Confirm pin</button></div>'
      : '<div class="wm-place"><span class="wm-place-ic">' + WM_IC.pin + '</span><span class="grow"><strong>' + h(name || "Your outlet") + "</strong><small>" + h(m.pin ? (addr || m.pin.lat.toFixed(6) + ", " + m.pin.lng.toFixed(6)) : "No pin yet") + '</small></span></div><button type="button" class="btn primary block" data-act="wm-edit">' + (m.pin ? "Move pin" : "Set pin") + "</button>";
    wrap.style.setProperty("--wm-panel", panel.offsetHeight + "px");
  }
  function wmStartEdit() { const root = wmFullRoot(); if (!root) return; const m = wmGet(root); root.dataset.mode = "edit"; wmPanel(); wmSet(root, m.pin || m.c, Math.max(17, m.z)); }
  function wmConfirm() { const root = wmFullRoot(); if (!root) return; const m = wmGet(root); wmClose(); OL.draft = {lat: m.c.lat, lng: m.c.lng}; OL.zoom = Math.max(4, Math.min(19, m.z)); olDrawMap(); }
  function wmLocate() {
    if (!navigator.geolocation) return toast("This browser can't share its location. Drag the map instead.", true);
    navigator.geolocation.getCurrentPosition((p) => {
      const root = wmFullRoot(); if (!root || root.dataset.mode !== "edit") return;
      wmSet(root, {lat: p.coords.latitude, lng: p.coords.longitude}, Math.max(17, wmGet(root).z)); toast("Found you. Check the pin, then click Confirm pin.");
    }, () => toast("Location not allowed. Drag the map instead.", true), {enableHighAccuracy: true, timeout: 15000});
  }
  const wmTarget = (el) => el.closest(".wm-full") ? wmFullRoot() : document.getElementById("ol-map");
  // Gestures: one finger or the mouse drags, two fingers zoom, a double click zooms in. On the full-screen
  // "Move pin" map a single click also puts the pin where you clicked.
  const wmPointers = new Map(); let wmG = null, wmLastTap = null;
  document.addEventListener("pointerdown", (e) => {
    const root = e.target.closest && e.target.closest(".wm"); if (!root || e.target.closest("button") || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (wmG && wmG.root !== root) return;
    wmPointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); try { root.setPointerCapture(e.pointerId); } catch (_) { /* old browser */ }
    if (wmPointers.size === 1) wmG = {root, x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false, scale: 1, pinch: 0};
    else if (wmPointers.size === 2 && wmG) { const [p, q] = [...wmPointers.values()]; wmG.pinch = Math.hypot(p.x - q.x, p.y - q.y) || 1; wmG.moved = true; }
  });
  document.addEventListener("pointermove", (e) => {
    const g = wmG; if (!g || !wmPointers.has(e.pointerId)) return;
    wmPointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); const layer = g.root.querySelector(".wm-layer"); if (!layer) return;
    if (wmPointers.size >= 2 && g.pinch) { const [p, q] = [...wmPointers.values()]; g.scale = Math.max(0.25, Math.min(4, Math.hypot(p.x - q.x, p.y - q.y) / g.pinch)); }
    else if (wmPointers.size === 1 && !g.pinch) { g.dx = e.clientX - g.x; g.dy = e.clientY - g.y; if (Math.abs(g.dx) + Math.abs(g.dy) > 6) g.moved = true; }
    if (g.moved) { layer.style.transform = "translate(" + g.dx + "px," + g.dy + "px) scale(" + g.scale + ")"; g.root.classList.add("dragging"); }
  });
  function wmEnd(e) {
    if (!wmPointers.has(e.pointerId)) return; wmPointers.delete(e.pointerId); if (wmPointers.size || !wmG) return;
    const g = wmG, root = g.root; wmG = null; root.classList.remove("dragging"); if (!root.isConnected) return;
    const m = wmGet(root), wp = worldPx(m.c.lat, m.c.lng, m.z);
    if (g.moved) { wmLastTap = null; wmSet(root, pxLatLng(wp.x - g.dx / g.scale, wp.y - g.dy / g.scale, m.z), m.z + (g.scale !== 1 ? Math.round(Math.log2(g.scale)) : 0)); return; }
    if (e.type !== "pointerup") { wmDraw(root); return; }
    const r = root.getBoundingClientRect(), tx = wp.x + (e.clientX - r.left - r.width / 2), ty = wp.y + (e.clientY - r.top - r.height / 2), now = Date.now();
    if (m.edit) { wmSet(root, pxLatLng(tx, ty, m.z), m.z); return; }
    if (wmLastTap && wmLastTap.root === root && now - wmLastTap.at < 320 && Math.hypot(e.clientX - wmLastTap.x, e.clientY - wmLastTap.y) < 30) { wmLastTap = null; wmSet(root, pxLatLng((wp.x + tx) / 2, (wp.y + ty) / 2, m.z), m.z + 1); return; }
    wmLastTap = {root, at: now, x: e.clientX, y: e.clientY};
  }
  document.addEventListener("pointerup", wmEnd); document.addEventListener("pointercancel", wmEnd);
  // Scroll zooms the full-screen map. On the small map inside a form, plain scrolling still scrolls the
  // page: zoom there with Ctrl + scroll (a trackpad pinch sends that).
  let wmWheel = {acc: 0, at: 0};
  document.addEventListener("wheel", (e) => {
    const root = e.target.closest && e.target.closest(".wm"); if (!root) return;
    if (!root.closest(".wm-full") && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const now = Date.now(); if (now - wmWheel.at > 250) wmWheel.acc = 0; wmWheel.at = now; wmWheel.acc += e.deltaY;
    if (Math.abs(wmWheel.acc) < 40) return;
    const step = wmWheel.acc < 0 ? 1 : -1; wmWheel.acc = 0;
    const m = wmGet(root), z2 = Math.max(4, Math.min(19, m.z + step)); if (z2 === m.z) return;
    if (m.edit) { wmSet(root, m.c, z2); return; }
    // Zoom around the pointer, like any map.
    const r = root.getBoundingClientRect(), ox = e.clientX - r.left - r.width / 2, oy = e.clientY - r.top - r.height / 2, wp = worldPx(m.c.lat, m.c.lng, m.z), f = Math.pow(2, z2 - m.z);
    wmSet(root, pxLatLng((wp.x + ox) * f - ox, (wp.y + oy) * f - oy, z2), z2);
  }, {passive: false});
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && wmOpen) { e.preventDefault(); e.stopPropagation(); wmClose(); } }, true);
  function olCoversHtml() {
    return OL.covers.map((x, i) => '<figure class="ol-cover' + (i === 0 ? " first" : "") + '"><img src="' + h(x.thumbUrl || x.url) + '" alt="Cover photo ' + (i + 1) + '">' + (i === 0 ? '<span class="ol-first">First</span>' : "") +
      '<div class="ol-tools">' + (i > 0 ? '<button type="button" class="btn small" data-act="ol-cover-first" data-id="' + i + '">Make first</button>' : "") + '<button type="button" class="btn small danger" data-act="ol-cover-remove" data-id="' + i + '">Remove</button></div></figure>').join("") +
      (OL.covers.length < MAX_COVERS ? '<label class="ol-add' + (OL.uploading ? " busy" : "") + '">' + (OL.uploading ? "Uploading…" : "<strong>+</strong><span>Add photo</span>") + '<input type="file" accept="image/jpeg,image/png,image/webp" data-input="ol-cover" hidden' + (OL.uploading ? " disabled" : "") + "></label>" : "");
  }
  function olDrawCovers() { const g = document.getElementById("ol-covers"); if (g) g.innerHTML = olCoversHtml(); const c = document.getElementById("ol-cover-count"); if (c) c.textContent = OL.covers.length + "/" + MAX_COVERS; }
  function outletEditModal() {
    const o = outlet(); if (!o || !can("profile")) return;
    const r = o.doc;
    OL.draft = {lat: Number(r.lat), lng: Number(r.lng)}; OL.saved = wmPoint(r.lat, r.lng); OL.ctx = "outlet"; OL.covers = coverList(r); OL.zoom = 16; OL.uploading = false; OL.saving = false;
    const f = (name, label, value, extra) => '<div class="field"><label for="ol-' + name + '">' + label + '</label><input class="input" id="ol-' + name + '" name="' + name + '" value="' + h(value == null ? "" : value) + '"' + (extra || "") + "></div>";
    const chk = (name, on, title, copy) => '<label class="ol-check"><input type="checkbox" name="' + name + '"' + (on ? " checked" : "") + '><span><strong>' + title + '</strong><span class="small muted">' + copy + "</span></span></label>";
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal wide" id="outlet-form"><header><h2>Edit outlet details</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      // The owner can rename the outlet; staff see the name locked.
      '<div class="field"><label for="ol-name">Outlet</label>' + (isOwner() ? '<input class="input" id="ol-name" name="name" value="' + h(r.name || "") + '" maxlength="60" autocomplete="off" required>' : '<input class="input" value="' + h(r.name || "") + '" disabled>') + "</div>" +
      '<div class="field"><label for="ol-description">Description</label><textarea class="input" id="ol-description" name="description" rows="3" maxlength="1000">' + h(r.description || "") + "</textarea></div>" +
      '<div class="ol-grid">' + f("cuisines", "Cuisines (comma separated)", (r.cuisines || []).join ? (r.cuisines || []).join(", ") : r.cuisines) + f("category", "Category", r.category || r.type, ' placeholder="Biryani, Cafe, Fast food"') +
      f("city", "City", r.city) + f("etaMin", "Minimum ETA (min)", r.etaMin || 25, ' type="number" min="5" max="240"') + f("etaMax", "Maximum ETA (min)", r.etaMax || 35, ' type="number" min="5" max="360"') + "<span></span>" +
      f("opensAt", "Opens at", r.opensAt, ' placeholder="11:00 AM"') + f("opensUntil", "Open until", r.opensUntil, ' placeholder="11:00 PM"') + "</div>" +
      '<p class="small muted" style="margin:0">The outlet opens and closes itself at these times. You can still switch it by hand; that holds until the next opening or closing time. Leave either empty to switch only by hand.</p>' +
      '<h3 style="margin:6px 0 0">Location</h3><div class="field"><label for="ol-address">Address</label><textarea class="input" id="ol-address" name="address" rows="2">' + h(r.address || "") + "</textarea></div>" +
      '<div class="row between" style="gap:8px;flex-wrap:wrap"><span class="small muted" id="ol-map-cap"></span><button type="button" class="btn small" data-act="ol-detect">📍 Use this device\'s location</button></div>' +
      '<div id="ol-map" class="wm"></div><p class="small muted" id="ol-coords" style="margin:0"></p><div id="ol-unsaved"></div>' +
      '<h3 style="margin:6px 0 0">Kitchen capacity</h3>' + f("maxConcurrentOrders", "Maximum orders at a time", r.maxConcurrentOrders || 20, ' type="number" min="1" max="500"') +
      chk("autoAcceptOrders", r.autoAcceptOrders === true, "Accept new orders automatically", "While the outlet is online and below the limit above.") +
      chk("autoPauseWhenBusy", r.autoPauseWhenBusy === true, "Pause for 30 minutes when the limit is reached", "New orders stop until the kitchen catches up.") +
      chk("pureVeg", r.pureVeg === true, "Pure vegetarian outlet", "Shows the Pure Veg badge and hides non-veg filters for customers.") +
      '<div class="row between"><h3 style="margin:6px 0 0">Cover photos</h3><span class="small muted" id="ol-cover-count"></span></div><p class="small muted" style="margin:0">Customers see these as a slideshow at the top of your page. The first is also your card photo in the list.</p><div class="ol-covers" id="ol-covers"></div>' +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit" id="ol-save">Save outlet details</button></div></form></div>';
    olDrawMap(); olDrawCovers();
  }
  async function addOutletCover(file) {
    if (!file || OL.uploading || !OL.covers) return;
    if (file.size > 15 * 1024 * 1024) return toast("Pick a photo under 15 MB.", true);
    OL.uploading = true; olDrawCovers();
    try {
      const im = await loadImage(file), big = drawScaled(im, 1600), base = "restaurants/" + state.rid + "/users/" + state.user.uid + "/cover/" + Date.now();
      const put = async (c, q, path) => { const ref = firebase.storage().ref(path); await ref.put(await toBlob(c, q), {contentType: "image/jpeg", cacheControl: "public, max-age=31536000"}); return ref.getDownloadURL(); };
      const [url, thumbUrl] = await Promise.all([put(big, .82, base + ".jpg"), put(drawScaled(big, 640), .74, base + "-thumb.jpg")]);
      OL.covers.push({url, thumbUrl});
    } catch (e) { toast(friendly(e), true); }
    OL.uploading = false; olDrawCovers();
  }
  async function saveOutlet(form) {
    const o = outlet(); if (!o || !can("profile") || OL.saving) return;
    if (OL.uploading) return toast("Wait for the photo to finish uploading.", true);
    const v = (n) => String(form.elements[n].value || "").trim(), num = (n, d) => { const x = Number(form.elements[n].value); return Number.isFinite(x) && x > 0 ? Math.round(x) : d; };
    const etaMin = num("etaMin", 25), etaMax = num("etaMax", 35);
    if (etaMax < etaMin) return toast("Maximum ETA can't be less than minimum ETA.", true);
    const changes = {description: v("description"), cuisines: v("cuisines").split(",").map((x) => x.trim()).filter(Boolean), city: v("city"), category: v("category"), etaMin, etaMax,
      opensAt: v("opensAt"), opensUntil: v("opensUntil"), address: v("address"), pureVeg: form.elements.pureVeg.checked, maxConcurrentOrders: Math.min(500, num("maxConcurrentOrders", 20)),
      autoAcceptOrders: form.elements.autoAcceptOrders.checked, autoPauseWhenBusy: form.elements.autoPauseWhenBusy.checked, updatedAt: Date.now(), updatedBy: state.user.email || state.user.uid};
    if (Number.isFinite(OL.draft.lat) && Number.isFinite(OL.draft.lng)) { changes.lat = OL.draft.lat; changes.lng = OL.draft.lng; }
    const nameBox = form.elements.namedItem("name");
    if (nameBox && isOwner()) {
      const name = String(nameBox.value || "").replace(/\s+/g, " ").trim();
      if (name.length < 2) return toast("Enter the outlet name.", true);
      if (name !== String(o.doc.name || "")) changes.name = name;
    }
    const covers = OL.covers.map((x) => ({url: x.url, thumbUrl: x.thumbUrl || x.url}));
    changes.coverImages = covers; changes.imageUrl = covers[0] ? covers[0].url : ""; changes.imageThumbUrl = covers[0] ? covers[0].thumbUrl : "";
    OL.saving = true; const btn = document.getElementById("ol-save"); if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      await db.collection("restaurants").doc(o.id).update(changes);
      Object.assign(o.doc, changes); closeModal(); render(); toast("Outlet details saved.");
    } catch (e) { toast(friendly(e), true); if (btn) { btn.disabled = false; btn.textContent = "Save outlet details"; } }
    OL.saving = false;
  }

  // ---------- agreement, price check, account deletion (as in the Restaurant app's More screen) ----------
  const OMATH = window.ScraveitOfferMath || null;
  const rupeesP = (paise) => inr(Math.round(Number(paise) || 0) / 100);
  function priceRules() {
    const r = (outlet() || {}).doc || {}, markup = r.pricingModel === "markup", raw = r.markupBps, mb = Number(raw);
    const markupBps = !markup ? null : raw == null || raw === "" ? 1000 : Number.isInteger(mb) && mb >= 0 && mb <= 5000 ? mb : 1000;
    const cb = Number(r.commissionBps), commissionBps = Number.isFinite(cb) && cb >= 0 && cb <= 5000 ? cb : 3000;
    return {markupBps, commissionBps, gstIncluded: markup || r.pricesIncludeGst === true};
  }
  const exGst = (price) => Math.round(Number(price || 0) * 100 * 10000 / 10500);
  function getPerDish(price) {
    const p = Number(price || 0), R = priceRules(); if (!(p > 0) || !OMATH) return 0;
    if (R.markupBps != null) return exGst(p);
    return OMATH.payout(R.gstIncluded ? exGst(p) : Math.round(p * 100), 0, R.commissionBps).receive;
  }
  function youGetText(price) {
    const p = Number(price || 0), R = priceRules();
    if (!OMATH) return "";
    if (!(p > 0)) return "Type a price to see what you get per dish.";
    if (R.markupBps != null) return "Customers see <strong>₹" + Math.round(p * (10000 + R.markupBps) / 10000) + "</strong> · You get <strong>" + rupeesP(exGst(p)) + "</strong> per dish. We pay the 5% GST for you.";
    if (R.gstIncluded) return "Customers pay <strong>₹" + p + "</strong>, GST included · You get <strong>" + rupeesP(getPerDish(p)) + "</strong> per dish. We pay the 5% GST from it.";
    return "You get <strong>" + rupeesP(getPerDish(p)) + "</strong> per dish. Food GST is added for the customer at checkout.";
  }
  function wantText(want) {
    const w = Number(want || 0), R = priceRules(); if (!(w > 0) || !OMATH) return "Type an amount.";
    if (R.markupBps != null) { const price = Math.ceil(w * 1.05 - 1e-9); return "Set your price to <strong>₹" + price + "</strong> and you get " + rupeesP(exGst(price)) + "."; }
    if (R.gstIncluded) {
      const target = Math.round(w * 100); let price = Math.ceil(OMATH.priceForReceive(target, R.commissionBps) * 1.05 / 100 - 1e-9);
      while (getPerDish(price) < target) price++;
      return "Set your price to <strong>₹" + price + "</strong> (GST included) and you get " + rupeesP(getPerDish(price)) + ".";
    }
    const pp = OMATH.priceForReceive(Math.round(w * 100), R.commissionBps);
    return pp ? "Set your price to <strong>" + rupeesP(pp) + "</strong> and you get " + rupeesP(OMATH.payout(pp, 0, R.commissionBps).receive) + "." : "Type an amount.";
  }
  function priceCheckModal() {
    const R = priceRules();
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal"><header><h2>Price check</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<p class="small muted" style="margin:0">' + (R.markupBps != null ? "Your prices include GST" : "At your " + R.commissionBps / 100 + "% commission" + (R.gstIncluded ? ", prices with GST included" : "")) + "</p>" +
      '<div class="field"><label for="pc-price">My menu price ₹</label><input class="input" id="pc-price" inputmode="numeric" value="150" data-input="pc-price"><span class="small" id="pc-get">' + youGetText(150) + "</span></div>" +
      '<div class="field"><label for="pc-want">I want to get, per dish ₹</label><input class="input" id="pc-want" inputmode="numeric" value="100" data-input="pc-want"><span class="small" id="pc-want-out">' + wantText(100) + "</span></div>" +
      '<p class="small muted" style="margin:0">The free Scraveit Price Planner app does the same, offline, and lets you try offers too.</p></div></div>';
  }
  // Partner agreement for an outlet that is already live: the server fills in what Scraveit holds;
  // the owner adds only what's missing, reads it, and signs (IT Act s.10A).
  const AG = {view: null, loading: false, signing: false, error: "", details: {}, shownFor: "{}"};
  function agFields() {
    const out = {}, v = (id) => String((document.getElementById(id) || {}).value || "").trim();
    if (document.getElementById("la-owner")) out.ownerName = v("la-owner");
    if (document.getElementById("la-pan")) out.pan = v("la-pan").toUpperCase();
    if (document.getElementById("la-fssai")) out.fssaiNumber = v("la-fssai").replace(/\s+/g, "");
    if (document.getElementById("la-drug")) out.drugLicenceNumber = v("la-drug").toUpperCase();
    if (document.getElementById("la-gstin")) out.gstin = v("la-gstin").toUpperCase();
    const mode = document.querySelector('input[name="la-gstmode"]:checked'); if (mode) out.gstMode = mode.value;
    if (document.getElementById("la-enrol")) out.gstEnrolment = v("la-enrol").toUpperCase();
    Object.keys(out).forEach((k) => { if (!out[k]) delete out[k]; });
    return out;
  }
  async function loadAgreement(details) {
    if (AG.loading) return;
    AG.loading = true; AG.error = ""; if (details) AG.details = details; drawAgreement();
    try { AG.view = await call("getLiveRestaurantAgreement", {restaurantId: state.rid, details: AG.details}); AG.shownFor = JSON.stringify(AG.details); }
    catch (e) { AG.error = friendly(e); }
    AG.loading = false; drawAgreement();
  }
  function agreementModal() {
    if (AG.rid !== state.rid) Object.assign(AG, {rid: state.rid, view: null, details: {}, shownFor: "{}", error: ""});
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal wide"><header><h2>Partner agreement</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header><div id="ag-body"></div></div></div>';
    drawAgreement(); if (!AG.view) loadAgreement();
  }
  function drawAgreement() {
    const box = document.getElementById("ag-body"); if (!box) return;
    const ag = AG.view, when = (t) => new Date(t).toLocaleDateString("en-IN", {day: "numeric", month: "short", year: "numeric"}) + ", " + clock(t);
    if (!ag) { box.innerHTML = AG.error ? '<div class="notice warn">' + h(AG.error) + '</div><button class="btn" data-act="ag-reload">Try again</button>' : '<div class="spinner"></div>'; return; }
    if (!ag.partiesReady) { box.innerHTML = '<div class="notice warn">The agreement isn\'t ready yet. Please check again later.</div>'; return; }
    const title = '<p class="small muted" style="margin:0">' + ag.commissionBps / 100 + "% commission · " + ag.termMonths + " months</p>";
    const body = '<div class="ag-text">' + (ag.sections || []).map((x) => "<h3>" + h(x.heading) + "</h3><p>" + h(x.body) + "</p>").join("") + "</div>";
    const outlets = agOutletsHtml(ag);
    if (ag.status === "signed") { box.innerHTML = title + outlets + body + '<div class="notice info">✓ Signed by ' + h(ag.signedBy) + " on " + h(when(ag.signedAt)) + ". Scraveit keeps the signed copy with the time, account and device it was signed from.</div>"; return; }
    const owner = isOwner(), d = AG.details || {}, k = ag.known || {}, goods = ["grocery", "dairy", "pharmacy"].includes(ag.storeType), asks = [];
    const fld = (id, label, val, extra, note) => '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" value="' + h(val || "") + '" autocomplete="off" spellcheck="false"' + (extra || "") + ">" + (note ? '<span class="small muted">' + note + "</span>" : "") + "</div>";
    if (!k.ownerName) asks.push(fld("la-owner", "Owner's full name (as on PAN)", d.ownerName));
    if (!k.pan) asks.push(fld("la-pan", "PAN of the business or owner", d.pan, ' maxlength="10" placeholder="ABCDE1234F" style="text-transform:uppercase"'));
    if (ag.storeType === "pharmacy") { if (!k.drugLicenceNumber) asks.push(fld("la-drug", "Drug licence number", d.drugLicenceNumber, ' maxlength="60"', "As printed on your retail drug licence (Form 20 and 21).")); }
    else if (!k.fssaiNumber) asks.push(fld("la-fssai", "FSSAI licence or registration number", d.fssaiNumber, ' inputmode="numeric" maxlength="14" placeholder="14 digits"', "14 digits, starting with 1 (licence) or 2 (registration), as on your FSSAI certificate."));
    if (goods && !k.gstin) {
      asks.push(fld("la-gstin", "GSTIN, if you have one", d.gstin, ' maxlength="15"'));
      asks.push('<fieldset class="ag-mode"><legend class="small muted">No GSTIN? Choose one</legend><label><input type="radio" name="la-gstmode" value="enrolment"' + (d.gstMode !== "exempt_only" ? " checked" : "") + "> I have a GST enrolment number</label>" + fld("la-enrol", "GST enrolment number", d.gstEnrolment, ' maxlength="20"') +
        '<label><input type="radio" name="la-gstmode" value="exempt_only"' + (d.gstMode === "exempt_only" ? " checked" : "") + "> I sell only GST-exempt goods (fresh milk, fruits, vegetables)</label></fieldset>");
    }
    const issues = ag.issues || [], missing = issues.length ? '<div class="notice warn">Still needed: ' + h(issues.join(", ")) + ". Fill " + (issues.length > 1 ? "these" : "this") + " and click “Put these in my agreement”; the sign box appears below the agreement after that.</div>" : "";
    const form = asks.length ? '<div class="card ag-ask"><h3 style="margin:0">Your details for the agreement</h3><p class="small muted" style="margin:0">Only what Scraveit doesn\'t have yet. It goes into the agreement and your payout records.</p>' + asks.join("") + missing +
      '<button class="btn" data-act="ag-details"' + (AG.loading || !owner ? " disabled" : "") + ">" + (AG.loading ? "Updating…" : "Put these in my agreement") + "</button></div>" : missing;
    const sign = issues.length ? "" : !owner ? '<div class="notice info">Only the outlet owner can sign the agreement.</div>' :
      '<div class="ag-sign"><div class="field"><label for="la-sign-name">Type your full name to sign</label><input class="input" id="la-sign-name" autocomplete="name"></div><label class="ol-check"><input type="checkbox" id="la-sign-consent"><span><strong>I have read this agreement and I agree to it' + ((ag.outlets || []).length > 1 ? " for all " + ag.outlets.length + " outlets" : "") + '</strong><span class="small muted" style="display:block">I am the owner named in it, or the business has authorised me in writing to sign.</span></span></label>' +
      '<button class="btn primary" data-act="ag-sign"' + (AG.signing ? " disabled" : "") + ">" + (AG.signing ? "Signing…" : "Accept and sign") + '</button><p class="small muted" style="margin:0">Your name, account, time and device are recorded with the agreement. It is a valid electronic agreement under the IT Act, 2000 (s.10A).</p></div>';
    const keep = {};
    box.querySelectorAll("input[id]").forEach((el) => { keep[el.id] = el.type === "checkbox" ? el.checked : el.value; });
    box.innerHTML = title + outlets + form + body + sign;
    // A failed sign or a details update redraws this: keep what the owner typed and ticked.
    Object.keys(keep).forEach((id) => { const el = document.getElementById(id); if (!el) return; if (el.type === "checkbox") el.checked = !!keep[id]; else if (!el.value) el.value = keep[id]; });
  }
  // One owner, many outlets: which outlets this one agreement covers, and which sign their own (and why).
  function agOutletsHtml(ag) {
    const list = ag.outlets || [], sep = ag.status === "signed" ? [] : (ag.separate || []);
    if (list.length < 2 && !sep.length) return "";
    return (list.length > 1 ? '<div class="notice info"><strong>' + (ag.status === "signed" ? "Covers " : "One agreement for ") + list.length + " outlets</strong><br>" + list.map((o) => h(o.name)).join(", ") + "</div>" : "") +
      (sep.length ? '<div class="notice warn"><strong>' + (sep.length === 1 ? "This outlet signs its own agreement" : "These outlets sign their own agreements") + "</strong><br>" + sep.map((o) => h(o.name) + ": " + h(o.reason)).join("<br>") + "</div>" : "");
  }
  async function signAgreement() {
    const ag = AG.view; if (!ag || AG.signing || !isOwner()) return;
    if (JSON.stringify(Object.assign({}, AG.details, agFields())) !== AG.shownFor) return toast("Click “Put these in my agreement” first, then read it again.", true);
    const name = String((document.getElementById("la-sign-name") || {}).value || "").trim(), consent = !!(document.getElementById("la-sign-consent") || {}).checked;
    if (!consent) return toast("Tick the box to confirm you agree.", true);
    if (name.length < 2) return toast("Type your full name to sign.", true);
    AG.signing = true; drawAgreement();
    try {
      const res = await call("signLiveRestaurantAgreement", {restaurantId: state.rid, details: AG.details, hash: ag.hash, typedName: name, consent: true, method: "in_app"});
      AG.view = null; toast(Number(res && res.outlets) > 1 ? "Agreement signed for " + res.outlets + " outlets. Thank you!" : "Agreement signed. Thank you!"); AG.signing = false; loadAgreement(); return;
    } catch (e) { toast(friendly(e), true); }
    AG.signing = false; drawAgreement();
  }
  // Commission change notice: Scraveit proposes a new rate; the owner reads it and clicks Accept.
  // The listing only says a notice exists (id, status, date); the rates come from the server.
  const CN = {rid: "", view: null, loading: false, accepting: false, error: ""};
  const cnDate = (t) => new Date(Number(t) || 0).toLocaleDateString("en-IN", {day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata"});
  const cnPct = (b) => Number((Number(b) / 100).toFixed(2)) + "%";
  function cnLive() {
    const n = ((outlet() || {}).doc || {}).commissionNotice || {}, at = Number(n.effectiveAt || 0);
    if (!isOwner() || !n.id) return null;
    if (n.status === "pending" && at > Date.now()) return n;
    if (n.status === "applied" && at > Date.now() - 7 * 864e5) return n;
    return null;
  }
  function cnBannerHtml() {
    const n = cnLive(); if (!n) return "";
    return n.status === "pending" ?
      '<div class="notice warn cp-ask"><span class="grow"><strong>Commission change: please read and accept.</strong> Accept before ' + h(cnDate(n.effectiveAt)) + '.</span><button type="button" class="btn small primary" data-act="cn-open">Read and accept</button></div>' :
      '<div class="notice info cp-ask"><span class="grow"><strong>Your commission is going down</strong> from ' + h(cnDate(n.effectiveAt)) + '.</span><button type="button" class="btn small" data-act="cn-open">Read</button></div>';
  }
  async function cnLoad() {
    if (CN.loading) return; CN.loading = true; CN.error = ""; drawCn();
    try { const res = await call("restaurantCommissionNotice", {action: "get", restaurantId: state.rid}); CN.view = (res && res.notice) || null; if (!CN.view) CN.error = "This notice is no longer available."; }
    catch (e) { CN.error = friendly(e); }
    CN.loading = false; drawCn();
  }
  function cnModal() {
    Object.assign(CN, {rid: state.rid, view: null, error: ""});
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal wide"><header><h2>Commission change</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header><div id="cn-body"></div></div></div>';
    cnLoad();
  }
  function drawCn() {
    const box = document.getElementById("cn-body"); if (!box) return;
    const v = CN.view;
    if (!v) { box.innerHTML = CN.error ? '<div class="notice warn">' + h(CN.error) + '</div><button class="btn" data-act="cn-reload">Try again</button>' : '<div class="spinner"></div>'; return; }
    const from = [...new Set((v.outlets || []).map((o) => o.fromBps))], many = (v.outlets || []).length > 1;
    const title = '<p class="small muted" style="margin:0">' + (from.length === 1 ? cnPct(from[0]) + " → " : "") + cnPct(v.toBps) + " from " + h(cnDate(v.effectiveAt)) + "</p>";
    const body = '<div class="ag-text">' + (v.sections || []).map((x) => "<h3>" + h(x.heading) + "</h3><p>" + h(x.body) + "</p>").join("") + "</div>";
    const foot = v.status === "pending" ?
      '<div class="ag-sign"><label class="ol-check"><input type="checkbox" id="cn-consent"><span><strong>I accept the new commission of ' + cnPct(v.toBps) + " from " + h(cnDate(v.effectiveAt)) + (many ? " for all " + v.outlets.length + " outlets" : "") + '</strong><span class="small muted" style="display:block">I own ' + (many ? "these outlets" : "this outlet") + ", or I am authorised in writing to accept for " + (many ? "them" : "it") + ".</span></span></label>" +
        '<button class="btn primary" data-act="cn-accept"' + (CN.accepting ? " disabled" : "") + ">" + (CN.accepting ? "Accepting…" : "Accept") + "</button></div>" :
      v.status === "accepted" ? '<div class="notice info">✓ Accepted. The new rate starts on ' + h(cnDate(v.effectiveAt)) + ".</div>" :
      v.status === "applied" ? '<button class="btn primary" data-act="close-modal">OK</button>' :
      v.status === "lapsed" ? '<div class="notice warn">The date in this notice has passed. Please contact Scraveit.</div>' :
      '<div class="notice info">Scraveit withdrew this notice. Your commission stays the same.</div>';
    const tick = !!(document.getElementById("cn-consent") || {}).checked;
    box.innerHTML = title + body + foot;
    const c = document.getElementById("cn-consent"); if (c && tick) c.checked = true;
  }
  async function cnAccept() {
    const v = CN.view; if (!v || CN.accepting || !isOwner()) return;
    if (!(document.getElementById("cn-consent") || {}).checked) return toast("Tick the box to accept the new rate.", true);
    CN.accepting = true; drawCn();
    try {
      const res = await call("restaurantCommissionNotice", {action: "accept", restaurantId: state.rid, noticeId: v.noticeId, hash: v.hash, consent: true});
      CN.view = (res && res.notice) || v; toast("Accepted. Thank you!");
    } catch (e) { toast(friendly(e), true); }
    CN.accepting = false; drawCn();
  }
  function deletionModal() {
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal" id="deletion-form"><header><h2>Delete your account</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="notice warn">Your outlet stops taking orders. Pending settlements are paid before the account closes. Invoices, settlement and tax records that the law makes us keep are kept; everything else is deleted within 30 days.</div>' +
      '<div class="field"><label for="del-confirm">Type DELETE to confirm</label><input class="input" id="del-confirm" name="confirmation" autocomplete="off" required></div>' +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Keep my account</button><button class="btn danger grow" type="submit">Delete my account</button></div></form></div>';
  }
  async function submitDeletion(form) {
    if (String(form.elements.confirmation.value || "").trim().toUpperCase() !== "DELETE") return toast("Type DELETE exactly to confirm.", true);
    const id = "privacy_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try {
      await db.collection("privacyRequests").doc(id).set({id, type: "account_deletion", app: "restaurant", uid: state.user.uid, email: state.user.email || "", status: "requested", createdAt: Date.now(), source: "partner_website"});
      closeModal(); toast("Your deletion request is in. We'll settle any payments and close your account within 30 days.");
      setTimeout(() => { if (state.liveUnsub) state.liveUnsub(); auth.signOut(); }, 2500);
    } catch (e) { toast(friendly(e), true); }
  }

  // ---------- dine-in: tables, QR stickers, bookings, table rounds (same data and functions as the app) ----------
  const DINE_TABLE_URL = "https://savrivo-app.web.app/t/";
  const DINE = {rid: "", unsub: [], roundUnsub: {}, sessions: [], bookings: [], rounds: {}, seen: {}, ready: false, tableId: ""};
  const dineAllowed = () => (outlet() && (outlet().doc.storeType || "restaurant") === "restaurant") && (can("orders") || can("profile"));
  function dineSettings() {
    const d = ((outlet() || {}).doc || {}).dineIn || {}, tables = Array.isArray(d.tables) ? d.tables : [];
    return {enabled: d.enabled === true && tables.length > 0, autoAccept: d.autoAccept !== false, tables, slotMinutes: [15, 30, 60].includes(Number(d.slotMinutes)) ? Number(d.slotMinutes) : 30,
      openFrom: d.openFrom || "12:00", openTo: d.openTo || "22:30", maxParty: Number(d.maxParty) || 10};
  }
  function stopDine() { DINE.unsub.forEach((u) => { try { u(); } catch (_) {} }); Object.values(DINE.roundUnsub).forEach((u) => { try { u(); } catch (_) {} }); Object.assign(DINE, {unsub: [], roundUnsub: {}, sessions: [], bookings: [], rounds: {}, ready: false, rid: ""}); }
  function dineRedraw() {
    if (document.getElementById("dine-table-body")) { drawDineTable(); return; }
    const el = document.activeElement;
    if (state.page === "dinein" && !modalRoot.innerHTML && !(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) render();
  }
  function startDine() {
    if (DINE.rid === state.rid) return;
    stopDine(); if (!dineAllowed()) return; const rid = state.rid; DINE.rid = rid;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    DINE.unsub.push(db.collection("tableSessions").where("restaurantId", "==", rid).where("status", "in", ["open", "bill"]).onSnapshot((snap) => {
      const prev = {}; DINE.sessions.forEach((x) => { prev[x.id] = x; }); DINE.sessions = snap.docs.map((d) => d.data());
      DINE.sessions.forEach((x) => { const p = prev[x.id]; if (p && x.status === "bill" && p.status !== "bill") toast(x.tableLabel + " asked for the bill"); if (x.waiterCalledAt && (!p || p.waiterCalledAt !== x.waiterCalledAt)) toast(x.tableLabel + " is calling a waiter"); if (!p && DINE.ready) toast(x.tableLabel + " is seated"); });
      const open = new Set(DINE.sessions.map((x) => x.id));
      Object.keys(DINE.roundUnsub).forEach((id) => { if (!open.has(id)) { try { DINE.roundUnsub[id](); } catch (_) {} delete DINE.roundUnsub[id]; delete DINE.rounds[id]; } });
      DINE.sessions.forEach((x) => {
        if (DINE.roundUnsub[x.id]) return;
        DINE.roundUnsub[x.id] = db.collection("tableSessions").doc(x.id).collection("rounds").onSnapshot((rs) => {
          const rounds = rs.docs.map((d) => d.data()).sort((a, b) => a.number - b.number);
          rounds.forEach((r) => { if (!DINE.seen[r.id]) { DINE.seen[r.id] = true; if (DINE.ready && r.status === "sent") toast(x.tableLabel + " · new round"); } });
          DINE.rounds[x.id] = rounds; dineRedraw();
        }, () => {});
      });
      dineRedraw(); setTimeout(() => { DINE.ready = true; }, 1500);
    }, (e) => console.warn("DINE_SESSIONS", e)));
    DINE.unsub.push(db.collection("dineBookings").where("restaurantId", "==", rid).where("slotAt", ">=", start.getTime()).onSnapshot((snap) => {
      const before = new Set(DINE.bookings.map((b) => b.id)); DINE.bookings = snap.docs.map((d) => d.data()).sort((a, b) => a.slotAt - b.slotAt);
      if (DINE.ready) DINE.bookings.forEach((b) => { if (!before.has(b.id)) toast((b.status === "requested" ? "Booking request: " : "New booking: ") + b.customerName + " · " + b.party); });
      dineRedraw();
    }, (e) => console.warn("DINE_BOOKINGS", e)));
  }
  const dineDay = (at) => { const d = new Date(at), t = new Date(); t.setHours(0, 0, 0, 0); const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - t.getTime()) / 86400000); return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toLocaleDateString("en-IN", {weekday: "short", day: "numeric", month: "short"}); };
  const dineNew = (sid) => (DINE.rounds[sid] || []).filter((r) => r.status === "sent").length;
  function pageDine() {
    startDine();
    const st = dineSettings(), byTable = {}, bookings = DINE.bookings.filter((b) => ["requested", "confirmed", "seated"].includes(b.status));
    DINE.sessions.forEach((x) => { byTable[x.tableId] = x; });
    const board = st.tables.map((t) => {
      const x = byTable[t.id]; let cls = "free", label = "Free", extra = "";
      if (x) { cls = x.status === "bill" ? "bill" : "seated"; label = x.status === "bill" ? "Bill asked" : "Seated"; const nr = dineNew(x.id); if (nr) extra += '<span class="tb-flag">' + nr + " new</span>"; if (x.waiterCalledAt) extra += '<span class="tb-flag call">Waiter</span>'; }
      return '<button class="table-tile ' + cls + '" data-act="' + (x ? "dine-table" : "dine-qr-one") + '" data-id="' + h(x ? x.id : t.id) + '" title="' + (x ? "Open table" : "Print this table's QR sticker") + '"><strong>' + h(t.label) + "</strong><span>" + h(t.seats) + " seats</span><em>" + label + "</em>" + (x ? '<span class="tb-money">' + inr(x.subtotal) + "</span>" : "") + extra + "</button>";
    }).join("");
    const setup = can("profile") ? '<button class="btn" data-act="dine-setup">⚙️ ' + (st.enabled ? "Dine-in settings" : "Set up dine-in") + "</button>" : "";
    return (st.enabled ? "" : '<div class="card"><h2 style="margin-top:0">Set up dine-in in a minute</h2><p class="muted">Count your tables, pick your hours, print the QR stickers. Guests can then book ahead or order from the table, and pay at your counter. Scraveit takes no fee on dine-in at launch.</p>' + (setup || '<p class="small muted">Ask the outlet owner to set it up.</p>') + "</div>") +
      (st.enabled ? '<div class="card"><div class="row between"><h2 style="margin:0">Tables</h2><div class="row" style="gap:8px"><button class="btn small" data-act="dine-qr">🖨️ Print all QR stickers</button>' + setup + '</div></div><div class="table-board">' + board + "</div><p class=\"small muted\" style=\"margin:8px 0 0\">Click a seated table to see its rounds and bill. Click a free table to print its QR sticker.</p></div>" : "") +
      '<div class="card"><h2 style="margin-top:0">Bookings</h2>' + (bookings.length ? bookings.map((b) => '<div class="booking-row ' + h(b.status) + '"><div class="booking-time"><strong>' + h(clock(b.slotAt)) + "</strong><span>" + h(dineDay(b.slotAt)) + '</span></div><div class="grow"><strong>' + h(b.customerName) + " · " + b.party + (b.party === 1 ? " person" : " people") + '</strong><div class="small muted">' + h(b.status === "requested" ? "Waiting for you" : b.status === "seated" ? "Seated" : "Confirmed") + (b.note ? " · " + h(b.note) : "") + "</div></div>" +
        (b.status === "requested" ? '<div class="row" style="gap:6px"><button class="btn good small" data-act="dine-accept" data-id="' + h(b.id) + '">Accept</button><button class="btn small" data-act="dine-decline" data-id="' + h(b.id) + '">Decline</button></div>' : b.status === "confirmed" ? '<button class="btn small danger" data-act="dine-decline" data-id="' + h(b.id) + '">Cancel</button>' : "") + "</div>").join("") : '<p class="muted" style="margin:0">No bookings yet today.</p>') + "</div>";
  }
  function dineTableModal(sid) {
    DINE.tableId = sid;
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal wide"><header><h2 id="dine-table-title">Table</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header><div id="dine-table-body"></div></div></div>';
    drawDineTable();
  }
  function drawDineTable() {
    const box = document.getElementById("dine-table-body"); if (!box) return;
    const x = DINE.sessions.find((s) => s.id === DINE.tableId), t = document.getElementById("dine-table-title");
    if (!x) { if (t) t.textContent = "Table closed"; box.innerHTML = '<p class="muted">This table is no longer open.</p>'; return; }
    if (t) t.textContent = x.tableLabel;
    const paid = document.getElementById("dine-paid"), paidVal = paid ? paid.value : String(Math.round(Number(x.subtotal || 0)));
    const rounds = DINE.rounds[x.id] || [], totals = x.memberTotals || {}, op = (o, label, cls, rid) => '<button class="btn ' + (cls || "") + '" data-act="dine-op" data-op="' + o + '" data-id="' + h(x.id) + '"' + (rid ? ' data-round="' + h(rid) + '"' : "") + ">" + label + "</button>";
    box.innerHTML = '<p class="small muted" style="margin:0">' + h((x.members || []).map((m) => m.name).join(", ")) + " · opened " + h(clock(x.openedAt)) + "</p>" +
      (x.waiterCalledAt ? '<div class="notice warn row between"><span><strong>Waiter called</strong> at ' + h(clock(x.waiterCalledAt)) + "</span>" + op("ackWaiter", "Done", "small") + "</div>" : "") +
      (rounds.length ? rounds.map((r) => '<div class="round-row ' + h(r.status) + '"><div class="row between"><strong>Round ' + r.number + " · " + h(r.byName) + '</strong><span class="small muted">' + h(clock(r.createdAt)) + '</span></div><ul class="round-items">' +
        (r.items || []).map((i) => "<li><b>" + i.quantity + "×</b> " + h(i.name) + (i.variant ? " (" + h(i.variant) + ")" : "") + ((i.addOns || []).length ? " + " + h(i.addOns.map((a) => a.name).join(", ")) : "") + (i.note ? " <i>“" + h(i.note) + "”</i>" : "") + "</li>").join("") +
        '</ul><div class="row" style="gap:6px">' + (r.status === "sent" ? op("cooking", "Start cooking", "primary small", r.id) : "") + (r.status !== "served" ? op("served", "Served", (r.status === "sent" ? "" : "primary ") + "small", r.id) : '<span class="pill paid">Served</span>') + "</div></div>").join("") : '<p class="muted">No rounds yet.</p>') +
      '<div class="bill-box">' + (x.members || []).filter((m) => Number(totals[m.uid] || 0) > 0).map((m) => '<div class="row between"><span>' + h(m.name) + "</span><strong>" + inr(totals[m.uid]) + "</strong></div>").join("") +
      '<div class="row between total"><span>Food total</span><strong>' + inr(x.subtotal) + '</strong></div><p class="small muted" style="margin:0">Add your GST and any service charge on your own bill.</p></div>' +
      '<div class="field"><label for="dine-paid">Amount paid (with taxes)</label><input class="input" id="dine-paid" type="number" inputmode="decimal" value="' + h(paidVal) + '"></div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' + op("paid", "Mark paid and free the table", "primary") + (x.status === "bill" ? op("reopen", "Reopen for more orders") : "") + op("close", "Close without payment", "danger") + "</div>";
  }
  async function dineOp(el) {
    const o = el.dataset.op, payload = {sessionId: el.dataset.id, action: o}; if (el.dataset.round) payload.roundId = el.dataset.round;
    if (o === "paid") { const v = Number((document.getElementById("dine-paid") || {}).value || 0); if (v > 0) payload.paidAmount = v; }
    if (o === "close" && !confirm("Close this table without marking it paid?")) return;
    el.disabled = true;
    try {
      await call("dineInStaff", payload);
      if (o === "paid" || o === "close") { closeModal(); render(); toast(o === "paid" ? "Paid. The table is free." : "Table closed."); }
      else toast(o === "served" ? "Marked served. The table gets a ping." : o === "cooking" ? "Cooking." : "Done.");
    } catch (e) { el.disabled = false; toast(friendly(e), true); }
  }
  async function dineRespond(id, accept) {
    if (!accept && !confirm("Decline this booking? The customer is told.")) return;
    try { await call("dineInRespondBooking", {bookingId: id, accept}); toast(accept ? "Booking accepted." : "Booking declined."); } catch (e) { toast(friendly(e), true); }
  }
  function dineSetupModal() {
    const st = dineSettings(), seats = st.tables.length ? st.tables.map((t) => Math.max(1, Number(t.seats) || 4)) : Array(8).fill(4);
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal wide" id="dine-form"><header><h2>' + (st.enabled ? "Dine-in settings" : "Set up dine-in") + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="ol-grid"><div class="field"><label for="dn-count">Number of tables</label><input class="input" id="dn-count" name="count" type="number" min="1" max="60" value="' + seats.length + '" data-input="dine-count"></div>' +
      '<div class="field"><label for="dn-all">Most tables seat</label><select class="input" id="dn-all" data-input="dine-all"><option value="">Pick to set all…</option>' + [2, 4, 6, 8].map((k) => "<option>" + k + "</option>").join("") + "</select></div></div>" +
      '<div class="dine-seat-grid" id="dn-seats">' + dineSeatInputs(seats, st.tables) + "</div>" +
      '<div class="ol-grid"><div class="field"><label for="dn-from">Guests can book from</label><input class="input" id="dn-from" name="openFrom" type="time" value="' + h(st.tables.length ? st.openFrom : "12:00") + '"></div><div class="field"><label for="dn-to">Until</label><input class="input" id="dn-to" name="openTo" type="time" value="' + h(st.tables.length ? st.openTo : "23:00") + '"></div>' +
      '<div class="field"><label for="dn-slot">Booking slots every</label><select class="input" id="dn-slot" name="slotMinutes">' + [15, 30, 60].map((m) => '<option value="' + m + '"' + (m === st.slotMinutes ? " selected" : "") + ">" + m + " min</option>").join("") + "</select></div>" +
      '<div class="field"><label for="dn-party">Largest group for one booking</label><input class="input" id="dn-party" name="maxParty" type="number" min="1" max="30" value="' + st.maxParty + '"></div></div>' +
      '<label class="ol-check"><input type="checkbox" name="autoAccept"' + (st.tables.length ? (st.autoAccept ? " checked" : "") : " checked") + '><span><strong>Confirm bookings automatically</strong><span class="small muted">Guests get an instant yes. You can still cancel one.</span></span></label>' +
      '<p class="small muted" style="margin:0">QR stickers print 4 to an A4 page. No printer? Choose “Save as PDF” and get it printed at any shop.</p>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' + (st.enabled ? '<button class="btn danger" type="button" data-act="dine-pause">Pause dine-in</button>' : "") + '<span class="grow"></span><button class="btn" type="submit" name="go" value="save">' + (st.enabled ? "Save changes" : "Turn on dine-in") + '</button><button class="btn primary" type="submit" name="go" value="print">' + (st.enabled ? "Save and print QR stickers" : "Turn on and print QR stickers") + "</button></div></form></div>";
  }
  function dineSeatInputs(seats, old) {
    return seats.map((n, i) => '<label class="dine-seat"><span>' + h((old && old[i] && old[i].label) || "Table " + (i + 1)) + '</span><input class="input" type="number" min="1" max="30" name="seat' + i + '" value="' + n + '"><small>seats</small></label>').join("");
  }
  async function saveDine(form, opts) {
    const o = opts || {}, out = outlet(); if (!out || !can("profile")) return;
    const old = dineSettings().tables, count = Math.max(1, Math.min(60, Number(form.elements.count.value) || 1)), seats = [];
    for (let i = 0; i < count; i++) seats.push(Math.max(1, Math.min(30, Number((form.elements["seat" + i] || {}).value) || 4)));
    const tables = seats.map((n, i) => ({id: String(i + 1), label: (old[i] && old[i].label) || "Table " + (i + 1), seats: n}));
    const dineIn = {enabled: !o.pause, autoAccept: form.elements.autoAccept.checked, tables, openFrom: form.elements.openFrom.value || "12:00", openTo: form.elements.openTo.value || "23:00",
      slotMinutes: [15, 30, 60].includes(Number(form.elements.slotMinutes.value)) ? Number(form.elements.slotMinutes.value) : 30, maxParty: Math.max(1, Math.min(30, Number(form.elements.maxParty.value) || 10)), updatedAt: Date.now()};
    try {
      await db.collection("restaurants").doc(out.id).set({dineIn}, {merge: true});
      out.doc.dineIn = dineIn; closeModal(); DINE.rid = ""; render();
      toast(o.pause ? "Dine-in paused. Your tables are kept." : "Dine-in is on. " + tables.length + (tables.length === 1 ? " table is" : " tables are") + " ready.");
      if (o.print && !o.pause) setTimeout(() => printDineQr(""), 300);
    } catch (e) { toast(friendly(e), true); }
  }
  function printDineQr(onlyId) {
    if (typeof window.qrcode !== "function") return toast("QR codes couldn't load. Refresh the page and try again.", true);
    const r = (outlet() || {}).doc || {}, rid = state.rid, tables = dineSettings().tables.filter((t) => !onlyId || t.id === onlyId);
    const cards = tables.map((t) => { const q = window.qrcode(0, "M"); q.addData(DINE_TABLE_URL + rid + "/" + t.id); q.make(); return '<div class="qr-card"><div class="brand">Scraveit</div><div class="rname">' + h(r.name || "") + '</div><img src="' + q.createDataURL(7, 2) + '" alt=""><div class="tname">' + h(t.label) + '</div><div class="how">Scan with your phone camera to order<br>and share one bill with your table</div></div>'; }).join("");
    const css = "@page{size:A4;margin:12mm}body{font-family:Arial,sans-serif;margin:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10mm}.qr-card{border:2px dashed #9aa6c2;border-radius:6mm;padding:6mm;text-align:center;page-break-inside:avoid}.brand{font-weight:900;font-size:20pt;color:#1460f0}.rname{font-size:11pt;color:#4A5878;margin:1mm 0 3mm}.qr-card img{width:55mm;height:55mm;image-rendering:pixelated}.tname{font-size:22pt;font-weight:800;margin-top:2mm}.how{font-size:9pt;color:#4A5878;margin-top:2mm}";
    const f = document.createElement("iframe"); f.setAttribute("aria-hidden", "true"); f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0"; document.body.appendChild(f);
    const d = f.contentDocument; d.open(); d.write('<!doctype html><html><head><meta charset="utf-8"><title>Scraveit table QR codes</title><style>' + css + '</style></head><body><div class="grid">' + cards + "</div></body></html>"); d.close();
    setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (_) { toast("Could not open printing in this browser.", true); } setTimeout(() => f.remove(), 60000); }, 400);
  }

  // ---------- daily meal plans (getRestaurantMealPlans / saveMealPlan, as in the app) ----------
  const MEAL_LABEL = {breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner"}, MEAL_TIMES = {breakfast: ["07:30", "09:00"], lunch: ["12:30", "13:30"], dinner: ["19:30", "21:00"]}, MEAL_ICON = {breakfast: "🌅", lunch: "🍛", dinner: "🌙"};
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const MP = {rid: "", plans: null, busy: false, error: "", saving: false};
  const fmt12 = (t) => { const [hh, mm] = String(t || "0:0").split(":").map(Number); return ((hh % 12) || 12) + (mm ? ":" + String(mm).padStart(2, "0") : "") + (hh < 12 ? " am" : " pm"); };
  function mpDaysText(days) { const d = WEEK_ORDER.filter((i) => days.includes(i)); if (d.length === 7) return "Every day"; if (d.length === 6 && !d.includes(0)) return "Mon–Sat"; if (d.length === 5 && !d.includes(0) && !d.includes(6)) return "Mon–Fri"; return d.map((i) => WD[i]).join(", ") || "No days"; }
  async function loadMealPlans() {
    MP.busy = true; MP.rid = state.rid; render();
    try { const r = await call("getRestaurantMealPlans", {restaurantId: state.rid}); MP.plans = Array.isArray(r && r.plans) ? r.plans : []; MP.error = ""; } catch (e) { MP.error = friendly(e); MP.plans = MP.plans || []; }
    MP.busy = false; if (state.page === "meals") render();
  }
  function pageMeals() {
    if (MP.rid !== state.rid) { MP.plans = null; MP.rid = state.rid; }
    if (!MP.plans && !MP.busy) setTimeout(loadMealPlans, 0);
    if (state.menu.items == null && !state.menu.loading) setTimeout(loadMenu, 0);
    const list = MP.plans || [];
    return '<div class="row between"><p class="muted" style="margin:0">Customers subscribe and skip days in the Scraveit app. Each day, 45 minutes before your delivery window, every meal arrives in Live orders as a normal order to accept and cook. The price is the dish’s menu price.</p>' +
      (can("orders") ? '<button class="btn primary" data-act="mp-edit" data-id="">+ New meal plan</button>' : "") + "</div>" +
      (MP.error ? '<div class="notice warn">' + h(MP.error) + "</div>" : "") +
      (MP.busy && !list.length ? '<div class="spinner"></div>' : list.length ? '<div class="mp-list">' + list.map((p) => '<div class="card"><div class="row between"><div><div class="small muted">' + h(MEAL_LABEL[p.meal] || "Meal") + " · " + h(fmt12(p.windowStart)) + "–" + h(fmt12(p.windowEnd)) + '</div><h2 style="margin:2px 0">' + h(p.name) + '</h2><div class="small muted">' + h(p.menuItemName || "") + " · ₹" + Math.round(Number(p.price || 0)) + " · " + h(mpDaysText(p.days || [])) + '</div></div><span class="pill ' + (p.active ? "paid" : "wait") + '">' + (p.active ? "Live" : "Paused") + "</span></div>" +
        '<div class="kpis" style="margin:12px 0">' + [["Today", p.mealsToday], ["Tomorrow", p.mealsTomorrow], ["Subscribers", p.subscribers]].map((k) => '<div class="kpi"><div class="small muted">' + k[0] + "</div><strong>" + Number(k[1] || 0) + "</strong></div>").join("") + "</div>" +
        (can("orders") ? '<button class="btn" data-act="mp-edit" data-id="' + h(p.id) + '">Edit plan</button>' : "") + "</div>").join("") + "</div>"
        : '<div class="card empty"><strong>No meal plans yet</strong>Offer a daily thali or tiffin. Regular customers get it every day without opening the app.</div>');
  }
  function mealPlanModal(id) {
    const p = (MP.plans || []).find((x) => x.id === id) || {meal: "lunch", days: [1, 2, 3, 4, 5, 6], windowStart: "12:30", windowEnd: "13:30", maxPerDay: 30, active: true, weeklyMenu: {}};
    const items = (state.menu.items || []).filter((i) => Number(i.price) > 0), menu = p.weeklyMenu || {}, days = p.days || [];
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal wide" id="meal-plan-form" data-id="' + h(p.id || "") + '"><header><h2>' + (p.id ? "Edit meal plan" : "New meal plan") + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="field"><label for="mp-name">Plan name</label><input class="input" id="mp-name" name="name" required minlength="3" maxlength="60" value="' + h(p.name || "") + '" placeholder="e.g. Lunch thali"></div>' +
      '<div class="field"><label for="mp-desc">What’s in it</label><textarea class="input" id="mp-desc" name="description" rows="2" maxlength="240" placeholder="Rice, dal, 2 curries, curd, pickle">' + h(p.description || "") + "</textarea></div>" +
      '<p class="small" style="margin:0"><span class="muted">Customers see </span><strong id="mp-summary"></strong></p>' +
      '<div class="field"><label>Meal</label><div class="row" style="gap:8px">' + ["breakfast", "lunch", "dinner"].map((m) => '<label class="mp-meal"><input type="radio" name="meal" value="' + m + '"' + (m === p.meal ? " checked" : "") + ' data-input="mp-meal"><span>' + MEAL_ICON[m] + " " + MEAL_LABEL[m] + "</span></label>").join("") + "</div></div>" +
      '<div class="ol-grid"><div class="field"><label for="mp-from">Delivery from</label><input class="input" id="mp-from" name="windowStart" type="time" required value="' + h(p.windowStart) + '" data-input="mp-sum"></div><div class="field"><label for="mp-to">Until</label><input class="input" id="mp-to" name="windowEnd" type="time" required value="' + h(p.windowEnd) + '" data-input="mp-sum"></div></div>' +
      '<div class="field"><div class="row between"><label>Days</label><span class="row" style="gap:6px"><button type="button" class="btn small" data-act="mp-days" data-id="1,2,3,4,5,6">Mon–Sat</button><button type="button" class="btn small" data-act="mp-days" data-id="0,1,2,3,4,5,6">Every day</button></span></div><div class="row" style="gap:6px;flex-wrap:wrap">' +
        WEEK_ORDER.map((i) => '<label class="mp-day"><input type="checkbox" name="day" value="' + i + '"' + (days.includes(i) ? " checked" : "") + ' data-input="mp-sum"><span>' + WD[i] + "</span></label>").join("") + "</div></div>" +
      (items.length ? '<div class="field"><label for="mp-item">Price: the same as this dish on your menu</label><select class="input" id="mp-item" name="menuItemId" required data-input="mp-sum">' + items.map((i) => '<option value="' + h(i.id) + '" data-price="' + h(Number(i.price || 0)) + '"' + (i.id === p.menuItemId ? " selected" : "") + ">" + h(i.name) + " · ₹" + Math.round(Number(i.price || 0)) + "</option>").join("") + "</select></div>"
        : '<div class="notice warn">' + (state.menu.items == null ? "Loading your menu…" : "Add the plan meal to your menu first. Its menu price is the plan price.") + "</div>") +
      '<div class="ol-grid"><div class="field"><label for="mp-max">Most meals a day</label><input class="input" id="mp-max" name="maxPerDay" type="number" min="1" max="500" required value="' + h(p.maxPerDay || 30) + '"><span class="small muted">New subscribers wait once it’s full.</span></div>' +
      '<label class="ol-check"><input type="checkbox" name="active"' + (p.active !== false ? " checked" : "") + '><span><strong>Plan is live</strong><span class="small muted">Off stops new subscribers and daily orders.</span></span></label></div>' +
      '<details' + (WEEK_ORDER.some((i) => menu[i]) ? " open" : "") + '><summary><strong>Daily menu</strong> <span class="small muted">optional · tell customers what’s cooking each day</span></summary><div class="mp-week">' + WEEK_ORDER.map((i) => '<label><span>' + WD[i] + '</span><input class="input" name="menu' + i + '" maxlength="160" value="' + h(menu[i] || "") + '" placeholder="Sambar, beans poriyal, curd"></label>').join("") + "</div></details>" +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit"' + (items.length ? "" : " disabled") + ">" + (p.id ? "Save changes" : "Create plan") + "</button></div></form></div>";
    mpSummary();
  }
  function mpSummary() {
    const f = document.getElementById("meal-plan-form"), out = document.getElementById("mp-summary"); if (!f || !out) return;
    const meal = (f.querySelector('input[name="meal"]:checked') || {}).value, days = Array.from(f.querySelectorAll('input[name="day"]:checked')).map((x) => Number(x.value));
    const opt = f.elements.menuItemId && f.elements.menuItemId.selectedOptions[0], price = opt ? Number(opt.dataset.price || 0) : 0;
    out.textContent = (MEAL_LABEL[meal] || "Meal") + " · " + fmt12(f.elements.windowStart.value) + "–" + fmt12(f.elements.windowEnd.value) + " · " + mpDaysText(days) + (price ? " · ₹" + Math.round(price) : "");
  }
  async function saveMealPlan(form) {
    if (MP.saving) return;
    const days = Array.from(form.querySelectorAll('input[name="day"]:checked')).map((x) => Number(x.value)); if (!days.length) return toast("Choose at least one day.", true);
    const weeklyMenu = {}; for (let i = 0; i < 7; i++) { const v = String((form.elements["menu" + i] || {}).value || "").trim(); if (v) weeklyMenu[String(i)] = v; }
    const input = {restaurantId: state.rid, name: form.elements.name.value.trim(), description: form.elements.description.value.trim(), meal: (form.querySelector('input[name="meal"]:checked') || {}).value || "lunch", menuItemId: form.elements.menuItemId.value,
      days, windowStart: form.elements.windowStart.value, windowEnd: form.elements.windowEnd.value, weeklyMenu, maxPerDay: Number(form.elements.maxPerDay.value), active: form.elements.active.checked};
    if (form.dataset.id) input.planId = form.dataset.id;
    MP.saving = true; const btn = form.querySelector('button[type="submit"]'); if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try { await call("saveMealPlan", input); toast("Meal plan saved."); closeModal(); MP.plans = null; render(); }
    catch (e) { toast("Couldn’t save the plan. " + friendly(e), true); if (btn) { btn.disabled = false; btn.textContent = form.dataset.id ? "Save changes" : "Create plan"; } }
    MP.saving = false;
  }

  // ---------- staff ----------
  // The owner adds people here and ticks what each one may use. The server
  // (restaurantStaff.ts) makes a staff ID and password for them and the
  // membership that Firestore rules and the order/finance functions read.
  const STAFF_DOMAIN = "staff.scraveit.in";
  const FEATURES = [
    ["orders", "Take orders", "See new orders, accept or reject them, mark them ready"],
    ["handover", "Hand over to rider", "Confirm the rider picked up the order"],
    ["availability", "Stock & open/close", "Mark dishes sold out, take the outlet offline"],
    ["menu", "Edit menu & prices", "Add dishes, change prices and photos"],
    ["offers", "Offers & ads", "Create offers, see ad results"],
    ["analytics", "Sales reports", "Order history, reports and insights"],
    ["finance", "Payouts & invoices", "Payout statements, UTRs and tax invoices. Can't change bank details"],
    ["profile", "Outlet details", "Change address, timings and photos"],
  ];
  const PRESETS = [["Kitchen", ["orders", "availability"]], ["Counter", ["orders", "handover", "availability"]], ["Accountant", ["finance", "analytics"]]];
  const ROLE_NAME = {restaurant_owner: "Owner", restaurant_manager: "Manager", restaurant_staff: "Staff"};
  const isOwner = () => { const m = outlet() && outlet().member; return !!(m && m.active === true && m.role === "restaurant_owner"); };
  const staffIdOf = (email) => { const m = /^([a-z0-9]+)@staff\.scraveit\.in$/i.exec(String(email || "")); return m ? m[1] : ""; };
  function pageAllowed(p) {
    if (p === "outlet") return true;
    if (p === "staff") return isOwner();
    if (p === "orders") return can("orders") || can("handover");
    if (p === "history") return can("orders") || can("analytics");
    if (p === "reports" || p === "insights") return can("analytics");
    if (p === "finance") return can("finance");
    if (p === "menu") return can("menu") || can("availability");
    if (p === "offers") return can("offers");
    if (p === "ads") return can("offers") || can("finance");
    if (p === "dinein") return dineAllowed();
    if (p === "meals") return can("orders") || can("profile");
    return false;
  }
  // Easy to read out and type on a billing machine: no 0/o or 1/l.
  function newPassword() {
    const A = "abcdefghjkmnpqrstuvwxyz23456789", b = new Uint32Array(8); crypto.getRandomValues(b);
    const c = Array.from(b, (n) => A[n % A.length]).join(""); return c.slice(0, 4) + "-" + c.slice(4);
  }
  const seen = (t) => (new Date(t).toDateString() === new Date().toDateString() ? "Today" : fullDay(t)) + ", " + clock(t);
  async function loadStaff() {
    const S = state.staff, rid = state.rid; if (S.loading) return;
    S.loading = true; S.error = "";
    try { const d = await call("listRestaurantStaff", {restaurantId: rid}); if (state.rid === rid) { S.data = d; S.rid = rid; } }
    catch (e) { S.error = friendly(e); S.rid = rid; }
    S.loading = false; if (state.page === "staff") render();
  }
  function pageStaff() {
    const S = state.staff;
    if (!WEB_CHECK) return '<div class="card empty"><strong>Adding staff from the website switches on with its security check</strong>Until then, add staff in the Scraveit Restaurant app: More → Staff.</div>';
    if (S.rid !== state.rid && !S.loading) { S.data = null; setTimeout(loadStaff, 0); }
    if (S.error && !S.data) return '<div class="notice warn">Staff didn\'t load: ' + h(S.error) + '</div><button class="btn" data-act="staff-reload">Try again</button>';
    if (!S.data) return '<div class="spinner"></div>';
    const list = S.data.staff, n = list.length;
    const rows = list.map((p) => {
      const fixed = p.role === "restaurant_owner" || p.uid === S.data.you;
      const what = p.role === "restaurant_owner" ? "Everything" : p.role === "restaurant_manager" ? "Everything except staff and bank details" :
        FEATURES.filter((f) => p.features.includes(f[0])).map((f) => '<span class="pill state">' + h(f[1]) + "</span>").join(" ");
      return "<tr><td><strong>" + h(p.name) + "</strong>" + (p.uid === S.data.you ? ' <span class="pill">You</span>' : "") + (p.phone ? '<div class="small muted">' + h(p.phone) + "</div>" : "") + "</td>" +
        "<td>" + h(ROLE_NAME[p.role]) + '</td><td class="staff-can">' + what + "</td>" +
        "<td>" + (p.loginId ? '<span class="small muted">Staff ID</span> <strong class="utr">' + h(p.loginId) + "</strong>" : h(p.email || "Own account")) + "</td>" +
        '<td class="small">' + (p.lastSignInAt ? h(seen(p.lastSignInAt)) : '<span class="muted">Not yet</span>') + "</td>" +
        '<td class="num nowrap">' + (fixed ? "" : '<button class="btn small" data-act="staff-edit" data-id="' + h(p.uid) + '">Change</button> ' +
          (p.managed ? '<button class="btn small" data-act="staff-pass" data-id="' + h(p.uid) + '">New password</button> ' : "") +
          '<button class="btn small danger" data-act="staff-remove" data-id="' + h(p.uid) + '"' + (S.busy ? " disabled" : "") + ">Remove</button>") + "</td></tr>";
    }).join("");
    return '<div class="card"><div class="row between"><div><h2 style="margin:0">Your team</h2><p class="small muted" style="margin:4px 0 0">' + n + (n === 1 ? " person signs" : " people sign") + " in to " + h(outlet().doc.name) + ". Each person sees only what you allow.</p></div>" +
      '<button class="btn primary" data-act="staff-add">Add staff</button></div>' +
      '<div style="overflow-x:auto"><table class="table" style="margin-top:12px"><thead><tr><th>Name</th><th>Role</th><th>Can use</th><th>Signs in with</th><th>Last used</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div></div>" +
      '<div class="card"><h2>How staff sign in</h2><ol class="small" style="margin:0;padding-left:18px;line-height:1.7">' +
      "<li>On the billing computer or tablet, open <strong>www.scraveit.in/partner</strong> in Chrome. On an Android phone or tablet they can also use the Scraveit Restaurant app.</li>" +
      "<li>They type the <strong>staff ID</strong> and <strong>password</strong> you gave them.</li>" +
      "<li>They see only the pages you ticked. A change shows the next time they open or refresh the page; Remove ends their access at once.</li></ol></div>";
  }
  const roleOption = (v, title, note, cur) => '<label class="feature"><input type="radio" name="role" value="' + v + '" data-input="staff-role"' + (cur === v ? " checked" : "") + "><span><strong>" + title + "</strong><small>" + note + "</small></span></label>";
  function staffModal(uid) {
    const S = state.staff, p = uid ? S.data && S.data.staff.find((x) => x.uid === uid) : null; if (uid && !p) return;
    const role = p ? p.role : "restaurant_staff", features = p ? p.features : PRESETS[1][1];
    const req = "web" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal wide" id="staff-form" data-id="' + h(uid) + '" data-req="' + req + '" role="dialog" aria-modal="true" aria-label="' + (p ? "Change access" : "Add staff") + '">' +
      "<header><h2>" + (p ? "Change " + h(p.name) + "'s access" : "Add staff") + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="ad-form"><div class="field grow"><label for="st-name">Name</label><input class="input" id="st-name" name="name" required minlength="2" maxlength="60" value="' + h(p ? p.name : "") + '"></div>' +
      '<div class="field"><label for="st-phone">Mobile (optional)</label><input class="input" id="st-phone" name="phone" inputmode="tel" maxlength="13" value="' + h(p ? p.phone : "") + '"></div></div>' +
      '<div class="field"><label>Role</label><div class="feature-list two">' + roleOption("restaurant_staff", "Staff", "Only what you tick below", role) +
        roleOption("restaurant_manager", "Manager", "Everything except staff and bank details", role) + "</div></div>" +
      '<div class="field" id="st-features"' + (role === "restaurant_manager" ? " hidden" : "") + '><label>Can use</label>' +
        '<div class="row small" style="gap:6px;margin-bottom:8px"><span class="muted">Quick pick:</span>' + PRESETS.map((x, i) => '<button class="btn small" type="button" data-act="staff-preset" data-id="' + i + '">' + x[0] + "</button>").join("") + "</div>" +
        '<div class="feature-list">' + FEATURES.map((f) => '<label class="feature"><input type="checkbox" name="f" value="' + f[0] + '"' + (features.includes(f[0]) ? " checked" : "") + "><span><strong>" + h(f[1]) + "</strong><small>" + h(f[2]) + "</small></span></label>").join("") + "</div></div>" +
      (p ? "" : passField("Password", "You'll see it again after saving, to give to them.")) +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit">' + (p ? "Save" : "Add staff") + "</button></div></form></div>";
    const first = document.getElementById("st-name"); if (first && !p) first.focus();
  }
  function passField(label, note) {
    return '<div class="field"><label for="st-pass">' + label + '</label><div class="row"><input class="input grow utr" id="st-pass" name="password" required minlength="8" maxlength="64" autocomplete="off" spellcheck="false" value="' + newPassword() + '">' +
      '<button class="btn" type="button" data-act="staff-newpass">Make another</button></div><p class="small muted" style="margin:4px 0 0">' + note + "</p></div>";
  }
  async function saveStaff(form) {
    const S = state.staff; if (S.busy) return;
    const uid = form.dataset.id, fd = new FormData(form), role = String(fd.get("role") || "restaurant_staff");
    const name = String(fd.get("name") || "").trim(), phone = String(fd.get("phone") || "").replace(/[\s-]/g, ""), features = role === "restaurant_manager" ? [] : fd.getAll("f");
    if (role !== "restaurant_manager" && !features.length) { toast("Tick at least one thing this person can use.", true); return; }
    if (phone && !/^(\+91)?[6-9]\d{9}$/.test(phone)) { toast("Enter a 10-digit mobile number, or leave it empty.", true); return; }
    const btn = form.querySelector('[type="submit"]'); S.busy = true; if (btn) btn.disabled = true;
    try {
      if (uid) {
        await call("updateRestaurantStaff", {restaurantId: state.rid, uid, name, phone, role, features});
        closeModal(); toast("Saved. " + name + " sees the change next time they open or refresh the page.");
      } else {
        const password = String(fd.get("password") || "");
        const r = await call("createRestaurantStaff", {restaurantId: state.rid, name, phone, role, features, password, requestId: form.dataset.req});
        loginCard(name, r.loginId, password, false);
      }
      S.busy = false; loadStaff();
    } catch (e) { S.busy = false; if (btn) btn.disabled = false; toast(friendly(e), true); }
  }
  function passModal(uid) {
    const p = state.staff.data && state.staff.data.staff.find((x) => x.uid === uid); if (!p || !p.managed) return;
    modalRoot.innerHTML = '<div class="modal-back"><form class="modal" id="staff-pass-form" data-id="' + h(uid) + '" role="dialog" aria-modal="true" aria-label="New password">' +
      "<header><h2>New password for " + h(p.name) + '</h2><button class="x" type="button" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<p class="small muted" style="margin:0">Their old password stops working and they\'re signed out on every device. Staff ID stays <strong class="utr">' + h(p.loginId) + "</strong>.</p>" +
      passField("New password", "You'll see it again after saving, to give to them.") +
      '<div class="row"><button class="btn grow" type="button" data-act="close-modal">Cancel</button><button class="btn primary grow" type="submit">Set password</button></div></form></div>';
  }
  async function setStaffPassword(form) {
    const S = state.staff, uid = form.dataset.id, p = S.data && S.data.staff.find((x) => x.uid === uid); if (!p || S.busy) return;
    const password = String(new FormData(form).get("password") || ""), btn = form.querySelector('[type="submit"]');
    S.busy = true; if (btn) btn.disabled = true;
    try { await call("updateRestaurantStaff", {restaurantId: state.rid, uid, password}); loginCard(p.name, p.loginId, password, true); }
    catch (e) { if (btn) btn.disabled = false; toast(friendly(e), true); }
    S.busy = false;
  }
  // Shown once: Scraveit never keeps the password, so the owner passes it on now.
  function loginCard(name, loginId, password, reset) {
    state.staff.share = "Scraveit partner dashboard\nOpen: www.scraveit.in/partner\nStaff ID: " + loginId + "\nPassword: " + password;
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="Sign-in details"><header><h2>' + (reset ? "New password for " + h(name) : h(name) + " can sign in now") + '</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>' +
      '<div class="login-card"><div><span>Open</span><strong>www.scraveit.in/partner</strong></div><div><span>Staff ID</span><strong class="utr">' + h(loginId) + '</strong></div><div><span>Password</span><strong class="utr">' + h(password) + "</strong></div></div>" +
      '<p class="small muted" style="margin:0">Give these to ' + h(name) + ". This is the only time the password is shown" + (reset ? ". The old one has stopped working." : "; you can set a new one any time from Staff.") + "</p>" +
      '<div class="row"><button class="btn grow" data-act="staff-copy">Copy</button>' + (navigator.share ? '<button class="btn grow" data-act="staff-share">Share</button>' : "") + '<button class="btn primary grow" data-act="close-modal">Done</button></div></div></div>';
  }
  async function removeStaff(uid) {
    const S = state.staff, p = S.data && S.data.staff.find((x) => x.uid === uid); if (!p || S.busy) return;
    if (!confirm("Remove " + p.name + "? They can't sign in to " + outlet().doc.name + " any more" + (p.managed ? " and staff ID " + p.loginId + " is switched off." : "."))) return;
    S.busy = true; render();
    try { await call("removeRestaurantStaff", {restaurantId: state.rid, uid}); toast(p.name + " was removed."); }
    catch (e) { toast(friendly(e), true); }
    S.busy = false; loadStaff();
  }

  // ---------- register a new outlet (the same application as the Restaurant app) ----------
  // Writes restaurantApplications/{uid | uid_grocery | uid_dairy | uid_pharmacy} with the same fields
  // the app writes; Scraveit checks it, confirms the rate and approves. Nothing here decides money.
  const REG_TYPES = {
    restaurant: {title: "Restaurant", noun: "restaurant", example: "The Waffle Spot", packaged: false, pharmacy: false},
    grocery: {title: "Store", noun: "store", example: "Sri Lakshmi Kirana", packaged: true, pharmacy: false},
    dairy: {title: "Dairy", noun: "dairy", example: "Sai Milk Point", packaged: true, pharmacy: false},
    pharmacy: {title: "Pharmacy", noun: "pharmacy", example: "Sri Sai Medicals", packaged: true, pharmacy: true},
  };
  const REG_TYPE_LABEL = {restaurant: "Restaurant", grocery: "Grocery store", dairy: "Dairy", pharmacy: "Pharmacy (health care)"};
  const REG_STEPS = [["basics", "About you"], ["location", "Location and hours"], ["documents", "Licence and tax"], ["bank", "Payouts"], ["menu", "Menu"], ["review", "Review"]];
  const REG_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const REG_RATE = 30;
  const REG = {loaded: false, loading: false, apps: {}, type: "", draft: null, step: 0, busy: "", saving: false, error: "", editing: false, ag: null, agLoading: false, agError: "", watch: null, mapSynced: false, signup: false, creating: false, pendingConsent: false};
  const regT = () => REG_TYPES[REG.type] || REG_TYPES.restaurant;
  const regAppId = (type) => type === "restaurant" ? state.user.uid : state.user.uid + "_" + type;
  const regDoc = (type) => db.collection("restaurantApplications").doc(regAppId(type || REG.type));
  const regNum = (v) => v === "" || v == null ? NaN : Number(v);
  function regOutlets(t) {
    return t.pharmacy ? ["Pharmacy", "Medical store", "Surgical store"] : REG.type === "dairy" ? ["Dairy shop", "Milk booth", "Dairy farm"] : REG.type === "grocery" ? ["Supermarket", "Kirana store", "Fruits and vegetables", "Organic store"] : ["Restaurant", "Cafe", "Cloud kitchen", "Sweets and bakery", "Fast food", "Dhaba"];
  }
  function regCuisines(t) {
    return t.pharmacy ? ["Everyday", "Baby care", "Women care", "Cold and cough", "First aid", "Personal care"] : REG.type === "dairy" ? ["Milk", "Curd", "Paneer", "Ghee", "Butter", "Sweets"] : REG.type === "grocery" ? ["Staples", "Fruits", "Vegetables", "Snacks", "Beverages", "Household", "Personal care"] : ["South Indian", "Andhra", "Biryani", "Tiffins", "North Indian", "Chinese", "Fast food", "Pizza and burgers", "Desserts", "Bakery", "Ice cream", "Beverages", "Chaat and snacks", "Sea food", "Healthy"];
  }
  function regHours(t) {
    return t.pharmacy ? [["all", "8 am to 10 pm", "08:00", "22:00"], ["day", "9 am to 9 pm", "09:00", "21:00"], ["late", "8 am to 11 pm", "08:00", "23:00"], ["custom", "Custom", "", ""]]
      : REG.type === "dairy" ? [["all", "5 am to 9 pm", "05:00", "21:00"], ["morning", "5 am to 11 am", "05:00", "11:00"], ["day", "6 am to 10 pm", "06:00", "22:00"], ["custom", "Custom", "", ""]]
      : REG.type === "grocery" ? [["all", "7 am to 10 pm", "07:00", "22:00"], ["day", "8 am to 9 pm", "08:00", "21:00"], ["late", "9 am to 11 pm", "09:00", "23:00"], ["custom", "Custom", "", ""]]
      : [["all", "7 am to 11 pm", "07:00", "23:00"], ["lunch", "11 am to 11 pm", "11:00", "23:00"], ["evening", "4 pm to 11 pm", "16:00", "23:00"], ["custom", "Custom", "", ""]];
  }
  // The same checks the app and the server make.
  const OBC = {
    fssai: (v) => /^[12]\d{13}$/.test(String(v || "")),
    drugLicence: (v) => { const t = String(v || "").toUpperCase().trim(); return /^[A-Z0-9][A-Z0-9 /().,-]{3,59}$/.test(t) && /\d/.test(t); },
    pan: (v) => /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(String(v || "").toUpperCase()),
    ifsc: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v || "").toUpperCase()),
    upi: (v) => /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(String(v || "").trim()),
    phone: (v) => String(v || "").replace(/\D/g, "").length >= 10,
    gstin: (v) => {
      const g = String(v || "").toUpperCase(); if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
      const C = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; let sum = 0;
      for (let i = 0; i < 14; i++) { const p = C.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + p % 36; }
      return C[(36 - sum % 36) % 36] === g[14];
    },
  };

  // ----- loading -----
  async function regLoad() {
    if (REG.loading || !state.user) return;
    REG.loading = true;
    const uid = state.user.uid, apps = {};
    await Promise.all(Object.keys(REG_TYPES).map(async (type) => {
      try { const s = await regDoc(type).get(); if (s.exists && s.data().uid === uid) apps[type] = s.data(); } catch (_) { /* not readable = none */ }
    }));
    REG.loading = false;
    if (!state.user || state.user.uid !== uid) return;
    REG.apps = apps; REG.loaded = true; REG.loading = false;
    const types = Object.keys(apps);
    if (!REG.type && types.length === 1) regOpen(types[0]);
    render();
  }
  function regReset() {
    regStopWatch();
    Object.assign(REG, {loaded: false, loading: false, apps: {}, type: "", draft: null, step: 0, busy: "", saving: false, error: "", editing: false, ag: null, agLoading: false, agError: "", mapSynced: false});
  }
  function regOpen(type) {
    REG.type = type; REG.draft = null; REG.ag = null; REG.agError = ""; REG.error = ""; REG.editing = false; REG.mapSynced = false;
    const a = REG.apps[type] || {};
    REG.step = Math.max(0, Math.min(REG_STEPS.length - 1, Number(a.step || 0)));
  }
  async function regStart(type) {
    if (!state.user || REG.busy) return;
    if (REG.apps[type]) { regOpen(type); render(); return; }
    const now = Date.now(), rec = {uid: state.user.uid, email: state.user.email || "", storeType: type, status: "draft", step: 0, ownerName: state.user.displayName || "", createdAt: now, updatedAt: now};
    REG.busy = "start"; render();
    try { await regDoc(type).set(rec); REG.apps[type] = rec; regOpen(type); }
    catch (e) { toast(friendly(e), true); }
    REG.busy = ""; render(); window.scrollTo(0, 0);
  }

  // ----- the draft -----
  function regDraft() {
    if (REG.draft) return REG.draft;
    const t = regT(), a = JSON.parse(JSON.stringify(REG.apps[REG.type] || {})), hrs = regHours(t);
    a.location = a.location || {};
    a.hours = a.hours || {preset: "all", open: hrs[0][2], close: hrs[0][3], days: REG_DAYS.slice()};
    if (t.packaged && !a.gstMode) a.gstMode = a.hasGst ? "registered" : "enrolment";
    a.fssai = a.fssai || {}; if (t.pharmacy) a.drugLicence = a.drugLicence || {};
    a.pan = a.pan || {}; a.bank = a.bank || {method: "bank"}; if (!a.bank.accountNumber) a.bank.accountNumberAgain = "";
    a.menu = a.menu || {}; a.menu.dishes = Array.isArray(a.menu.dishes) ? a.menu.dishes : []; a.menu.cardPhotoPaths = Array.isArray(a.menu.cardPhotoPaths) ? a.menu.cardPhotoPaths : [];
    a.cuisines = Array.isArray(a.cuisines) ? a.cuisines : String(a.cuisines || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!a.location.address && a.address) a.location.address = a.address;
    if (!a.location.city && a.city) a.location.city = a.city;
    while (a.menu.dishes.length < 5) a.menu.dishes.push({name: "", price: "", diet: "veg"});
    REG.draft = a; return a;
  }
  const regGet = (path) => path.split(".").reduce((o, k) => o == null ? undefined : o[k], regDraft());
  function regPut(path, value) { const keys = path.split("."), last = keys.pop(); let o = regDraft(); keys.forEach((k) => { if (o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; }); o[last] = value; }
  // The map pin lives in OL.draft (the same map as Edit outlet details).
  function regPullMap() { if (REG.mapSynced && OL.draft && Number.isFinite(OL.draft.lat)) { const l = regDraft().location; l.lat = OL.draft.lat; l.lng = OL.draft.lng; } }
  function regIssues(step) {
    regPullMap();
    const a = regDraft(), t = regT(), out = [], need = (ok, msg) => { if (!ok) out.push(msg); };
    if (step === "basics" || !step) { need(String(a.restaurantName || "").trim().length >= 2, "Add your " + t.noun + " name"); need(String(a.ownerName || "").trim().length >= 2, "Add the owner's full name"); need(OBC.phone(a.phone), "Add a 10-digit phone number"); need(a.cuisines.length > 0, "Pick at least one " + (t.packaged ? "category" : "cuisine")); }
    if (step === "location" || !step) { need(Number.isFinite(regNum(a.location.lat)), "Set your pin on the map"); need(String(a.location.address || "").trim().length >= 6, "Add the street address"); need(String(a.location.city || "").trim(), "Add the town or city"); need(!a.location.pincode || /^\d{6}$/.test(a.location.pincode), "PIN code should be 6 digits"); need((a.hours.days || []).length > 0, "Pick the days you're open"); }
    if (step === "documents" || !step) {
      if (t.pharmacy) { need(OBC.drugLicence(a.drugLicence.number), "Add your drug licence number"); need(a.drugLicence.photoPath, "Add a photo of the drug licence"); need(!a.fssai.number || OBC.fssai(a.fssai.number), "FSSAI number should be 14 digits"); need(a.noPrescriptionOnly, "Confirm you'll list only items that need no prescription"); }
      else { need(OBC.fssai(a.fssai.number), "FSSAI number should be 14 digits"); need(a.fssai.photoPath, "Add a photo of the FSSAI certificate"); }
      need(OBC.pan(a.pan.number), "PAN should look like ABCPK1234D"); need(a.pan.photoPath, "Add a photo of the PAN card");
      if (t.packaged) { if (a.gstMode === "registered") need(OBC.gstin(a.gstin), "GSTIN doesn't look right. Check it against your certificate"); else if (a.gstMode === "enrolment") need(/^[A-Z0-9]{10,20}$/.test(String(a.gstEnrolment || "").toUpperCase()), "Add your GST enrolment number"); }
      else if (a.hasGst) need(OBC.gstin(a.gstin), "GSTIN doesn't look right. Check it against your certificate");
    }
    if (step === "bank" || !step) {
      if (a.bank.method === "upi") need(OBC.upi(a.bank.upiId), "UPI ID should look like name@bank");
      else { need(String(a.bank.holderName || "").trim(), "Add the account holder's name"); need(/^\d{9,18}$/.test(String(a.bank.accountNumber || "")), "Account number should be 9 to 18 digits"); if (a.bank.accountNumberAgain !== undefined) need(a.bank.accountNumber === a.bank.accountNumberAgain, "The two account numbers don't match"); need(OBC.ifsc(a.bank.ifsc), "IFSC should look like SBIN0001234"); }
    }
    if (step === "menu" || !step) { const n = a.menu.dishes.filter((d) => String(d.name || "").trim() && Number(d.price) > 0).length; need(n >= 5 || a.menu.cardPhotoPaths.length > 0, "Add 5 " + (t.packaged ? "products" : "dishes") + ", or a photo of your " + (t.packaged ? "price list" : "menu card")); }
    return out;
  }
  function regClean() {
    regPullMap();
    const t = regT(), o = JSON.parse(JSON.stringify(regDraft())), prev = REG.apps[REG.type] || {};
    delete o.bank.accountNumberAgain;
    o.menu.dishes = o.menu.dishes.filter((d) => String(d.name || "").trim()).map((d) => Object.assign({name: String(d.name).trim().slice(0, 80), price: Math.round(Number(d.price) || 0), diet: d.diet || "veg", category: String(d.category || "").trim().slice(0, 40)}, t.packaged ? {packSize: String(d.packSize || "").trim().slice(0, 40)} : {}));
    o.fssai.kind = OBC.fssai(o.fssai.number) ? (String(o.fssai.number)[0] === "1" ? "licence" : "registration") : "";
    o.pan.number = String(o.pan.number || "").toUpperCase();
    if (o.drugLicence) o.drugLicence.number = String(o.drugLicence.number || "").toUpperCase().trim().slice(0, 60);
    if (t.packaged) { o.hasGst = o.gstMode === "registered"; o.gstEnrolment = o.gstMode === "enrolment" ? String(o.gstEnrolment || "").toUpperCase().replace(/\s/g, "") : ""; }
    o.gstin = o.hasGst ? String(o.gstin || "").toUpperCase() : "";
    o.bank.ifsc = String(o.bank.ifsc || "").toUpperCase();
    o.address = o.location.address || ""; o.city = o.location.city || "";
    ["terms", "agreement", "reviewedAt", "reviewedBy", "reviewMessage", "restaurantId", "approvedAt"].forEach((k) => delete o[k]);
    o.uid = state.user.uid; o.email = state.user.email || o.email || "";
    if (prev.storeType) o.storeType = prev.storeType; else delete o.storeType;
    o.updatedAt = Date.now();
    return o;
  }
  async function regSave(status) {
    const prev = REG.apps[REG.type] || {}, o = regClean();
    o.status = status || (["submitted", "changes_requested"].includes(prev.status) ? "submitted" : "draft");
    o.step = REG.step;
    if (o.status === "submitted" && !o.submittedAt) o.submittedAt = Date.now();
    await regDoc().set(o, {merge: true});
    REG.apps[REG.type] = Object.assign({}, prev, o);
    return o;
  }
  async function regNext(submit) {
    const step = REG_STEPS[REG.step][0], issues = submit ? regIssues() : regIssues(step);
    if (issues.length) { REG.error = issues[0]; render(); return; }
    REG.error = ""; REG.saving = true; render();
    try {
      if (submit) { await regSave("submitted"); REG.editing = false; REG.ag = null; toast("Submitted. We'll check your details shortly."); }
      else { REG.step++; await regSave(); }
    } catch (e) { REG.error = friendly(e); }
    REG.saving = false; render(); window.scrollTo(0, 0);
  }
  async function regUpload(kind, file) {
    if (!file || REG.busy) return;
    if (file.size > 15 * 1024 * 1024) { toast("Pick a photo under 15 MB.", true); return; }
    REG.busy = kind; render();
    try {
      const path = "private/restaurant-onboarding/" + state.user.uid + "/" + kind + "-" + Date.now() + ".jpg", im = await loadImage(file);
      await firebase.storage().ref(path).put(await toBlob(drawScaled(im, 1200), .75), {contentType: "image/jpeg"});
      const a = regDraft();
      if (kind === "fssai") a.fssai.photoPath = path;
      else if (kind === "drug") a.drugLicence.photoPath = path;
      else if (kind === "pan") a.pan.photoPath = path;
      else if (kind === "bank") a.bank.proofPath = path;
      else if (kind === "gst") a.gstPhotoPath = path;
      else if (kind === "menu") a.menu.cardPhotoPaths = a.menu.cardPhotoPaths.concat(path).slice(0, 6);
      await regSave(); toast("Photo added.");
    } catch (e) { toast("Upload failed. " + friendly(e), true); }
    REG.busy = ""; render();
  }

  // ----- markup -----
  function regField(path, label, opt) {
    opt = opt || {}; const v = regGet(path);
    return '<div class="field"><label for="rg-' + h(path) + '">' + h(label) + '</label><input id="rg-' + h(path) + '" class="input' + (opt.mono ? " mono" : "") + '" data-ob="' + h(path) + '" value="' + h(v == null ? "" : v) + '"' +
      (opt.type ? ' type="' + opt.type + '"' : "") + (opt.mode ? ' inputmode="' + opt.mode + '"' : "") + (opt.max ? ' maxlength="' + opt.max + '"' : "") + (opt.upper ? ' data-upper="1"' : "") + (opt.digits ? ' data-digits="1"' : "") +
      ' placeholder="' + h(opt.ph || "") + '" autocomplete="off">' + (opt.hint ? '<span class="small muted">' + opt.hint + "</span>" : "") + "</div>";
  }
  function regChips(path, options, multi) {
    const v = regGet(path), on = (x) => multi ? (v || []).includes(x) : v === x;
    return '<div class="reg-chips">' + options.map((x) => '<button type="button" class="reg-chip' + (on(x) ? " on" : "") + '" data-act="rg-chip" data-path="' + h(path) + '" data-value="' + h(x) + '" data-multi="' + (multi ? 1 : 0) + '" aria-pressed="' + on(x) + '">' + h(x) + "</button>").join("") + "</div>";
  }
  function regPhoto(kind, label, copy, path) {
    const done = !!regGet(path), busy = REG.busy === kind;
    return '<label class="reg-photo' + (done ? " done" : "") + (busy ? " busy" : "") + '"><span class="reg-photo-icon">' + (busy ? "…" : done ? "✓" : "📷") + '</span><span class="grow"><strong>' + h(done ? label + " added" : label) + '</strong><span class="small muted">' + h(busy ? "Uploading…" : done ? "Click to replace" : copy) + '</span></span><input type="file" accept="image/jpeg,image/png,image/webp" data-ob-photo="' + kind + '" hidden' + (REG.busy ? " disabled" : "") + "></label>";
  }
  const regOk = (ok, text) => ok ? '<span class="reg-ok">✓ ' + h(text) + "</span>" : "";
  function regCheck(key, on, title, copy) {
    return '<label class="ol-check"><input type="checkbox" data-ob-check="' + key + '"' + (on ? " checked" : "") + "><span><strong>" + h(title) + '</strong><span class="small muted">' + h(copy) + "</span></span></label>";
  }
  function regStepBody() {
    const a = regDraft(), t = regT(), step = REG_STEPS[REG.step][0];
    if (step === "basics") return '<h2>Tell us about your ' + h(t.noun) + '</h2><p class="muted">This is how customers will find you.</p>' +
      regField("restaurantName", t.title + " name", {ph: "e.g. " + t.example, max: 80}) +
      '<div class="field"><label>What kind of place is it?</label>' + regChips("outletType", regOutlets(t), false) + "</div>" +
      '<div class="field"><label>' + (t.packaged ? "What do you sell?" : "What do you serve?") + ' <span class="muted">(pick all that fit)</span></label>' + regChips("cuisines", regCuisines(t), true) + "</div>" +
      '<div class="ol-grid">' + regField("ownerName", "Owner's full name", {ph: "As on your PAN card", max: 80, hint: "The person who will sign the partner agreement."}) + regField("phone", "Phone number for orders", {type: "tel", mode: "tel", ph: "98765 43210", max: 16}) + "</div>" +
      regField("legalName", "Business name on PAN or GST (if different)", {ph: "Optional", max: 120});
    if (step === "location") {
      const hrs = regHours(t);
      return '<h2>Where are you?</h2><p class="muted">Delivery partners come here to pick up orders.</p>' +
        '<div class="row between" style="gap:8px;flex-wrap:wrap"><span class="small muted" id="ol-map-cap"></span><button type="button" class="btn small" data-act="ol-detect">📍 Use this device\'s location</button></div>' +
        '<div id="ol-map" class="wm"></div><p class="small muted" id="ol-coords" style="margin:0"></p>' +
        regField("location.address", "Street address", {ph: "Shop number, street, landmark", max: 200}) +
        '<div class="ol-grid">' + regField("location.area", "Area", {ph: "e.g. Gandhi Nagar", max: 60}) + regField("location.city", "Town or city", {ph: "Naidupeta", max: 60}) + regField("location.pincode", "PIN code", {mode: "numeric", digits: 1, max: 6, ph: "524126"}) + "</div>" +
        '<div class="field"><label>Opening hours</label><div class="reg-chips">' + hrs.map((x) => '<button type="button" class="reg-chip' + (a.hours.preset === x[0] ? " on" : "") + '" data-act="rg-hours" data-value="' + x[0] + '">' + h(x[1]) + "</button>").join("") + "</div></div>" +
        (a.hours.preset === "custom" ? '<div class="ol-grid">' + regField("hours.open", "Opens at", {type: "time"}) + regField("hours.close", "Closes at", {type: "time"}) + "</div>" : "") +
        '<div class="field"><label>Open on</label>' + regChips("hours.days", REG_DAYS, true) + "</div>";
    }
    if (step === "documents") {
      const fssaiHint = (num) => num ? regOk(OBC.fssai(num), String(num)[0] === "2" ? "Registration number" : "Licence number") : "";
      const docs = t.pharmacy
        ? '<section class="reg-doc"><h3>Drug licence</h3><p class="small muted">Your retail drug licence (Form 20 and 21).</p>' + regPhoto("drug", "Drug licence", "Upload a clear photo", "drugLicence.photoPath") +
          '<div class="ol-grid">' + regField("drugLicence.number", "Licence number", {max: 60, mono: 1, upper: 1, ph: "As printed on the licence", hint: regOk(OBC.drugLicence(a.drugLicence.number), "Looks right")}) + regField("drugLicence.expiresOn", "Valid until", {type: "date"}) + "</div>" +
          regCheck("noPrescriptionOnly", a.noPrescriptionOnly, "I'll list only items that need no prescription", "No Schedule H, H1 or X medicines. Customers can't upload prescriptions on Scraveit.") + "</section>" +
          '<section class="reg-doc"><h3>FSSAI (optional)</h3><p class="small muted">Only if you sell food such as baby food or nutrition drinks.</p>' + regField("fssai.number", "FSSAI number", {mode: "numeric", digits: 1, max: 14, mono: 1, ph: "14 digits", hint: fssaiHint(a.fssai.number)}) + "</section>"
        : '<section class="reg-doc"><h3>FSSAI licence or registration</h3><p class="small muted">Required by law for anyone selling food online.</p>' + regPhoto("fssai", "FSSAI certificate", "Upload a clear photo", "fssai.photoPath") +
          '<div class="ol-grid">' + regField("fssai.number", "FSSAI number", {mode: "numeric", digits: 1, max: 14, mono: 1, ph: "14 digits", hint: fssaiHint(a.fssai.number)}) + regField("fssai.expiresOn", "Valid until", {type: "date"}) + "</div></section>";
      const pan = '<section class="reg-doc"><h3>PAN</h3><p class="small muted">For tax on your sales. The owner\'s PAN, or the business PAN.</p>' + regPhoto("pan", "PAN card", "Front side, all text readable", "pan.photoPath") +
        '<div class="ol-grid">' + regField("pan.number", "PAN", {upper: 1, max: 10, mono: 1, ph: "ABCPK1234D", hint: regOk(OBC.pan(a.pan.number), "Looks right")}) + regField("pan.name", "Name on PAN", {ph: "As printed on the card", max: 80}) + "</div></section>";
      const gstinField = regPhoto("gst", "GST certificate (optional)", "Upload it if you have it", "gstPhotoPath") + regField("gstin", "GSTIN", {upper: 1, max: 15, mono: 1, ph: "37ABCPK1234D1Z5", hint: regOk(OBC.gstin(a.gstin), "Looks right")});
      let gst;
      if (t.packaged) {
        const m = a.gstMode || "enrolment", opt = (v, ti, c) => '<button type="button" class="reg-opt' + (m === v ? " on" : "") + '" data-act="rg-gst" data-value="' + v + '"><strong>' + h(ti) + '</strong><span class="small muted">' + h(c) + "</span></button>";
        gst = '<section class="reg-doc"><h3>GST</h3><p class="small muted">Shops selling goods online need one of these.</p><div class="reg-opts">' + opt("registered", "I have GST registration", "Add your GSTIN") + opt("enrolment", "Not registered: I have a GST enrolment number", "Free on gst.gov.in for small sellers on apps like Scraveit") +
          opt("exempt_only", "I sell only GST-free items", REG.type === "dairy" ? "Such as fresh milk and unpacked curd" : t.pharmacy ? "Such as sanitary pads" : "Such as fresh fruits and vegetables") + "</div>" +
          (m === "registered" ? gstinField : m === "enrolment" ? regField("gstEnrolment", "GST enrolment number", {upper: 1, max: 20, mono: 1, ph: "From the GST portal", hint: "No number yet? On gst.gov.in choose User Services › Generate User ID for Unregistered Applicant › supplier to e-commerce operators. It's free and uses your PAN."}) : '<p class="small muted">If you later add packed or taxable products, you\'ll need GST registration or an enrolment number first.</p>') + "</section>";
      } else gst = '<section class="reg-doc"><h3>GST</h3>' + regCheck("hasGst", a.hasGst, "I have GST registration", "Not registered? That's fine. Scraveit pays the GST on food sold through the app.") + (a.hasGst ? gstinField : "") + "</section>";
      return '<h2>Licence and tax details</h2><p class="muted">Only Scraveit\'s verification team sees these.</p>' + docs + pan + gst;
    }
    if (step === "bank") {
      const upi = a.bank.method === "upi";
      return '<h2>Where should we pay you?</h2><p class="muted">Payouts every week, with a statement for every order.</p><div class="reg-chips"><button type="button" class="reg-chip' + (!upi ? " on" : "") + '" data-act="rg-bank" data-value="bank">Bank account</button><button type="button" class="reg-chip' + (upi ? " on" : "") + '" data-act="rg-bank" data-value="upi">UPI</button></div>' +
        (upi ? regField("bank.upiId", "UPI ID", {ph: "name@okaxis", max: 80, hint: regOk(OBC.upi(a.bank.upiId), "Looks right")})
          : regPhoto("bank", "Cancelled cheque or passbook", "Upload a photo of the first page", "bank.proofPath") + regField("bank.holderName", "Account holder's name", {ph: "As in the bank", max: 80}) +
            '<div class="ol-grid">' + regField("bank.accountNumber", "Account number", {mode: "numeric", digits: 1, max: 18, mono: 1}) + regField("bank.accountNumberAgain", "Type the account number again", {mode: "numeric", digits: 1, max: 18, mono: 1}) + "</div>" +
            regField("bank.ifsc", "IFSC", {upper: 1, max: 11, mono: 1, ph: "SBIN0001234", hint: regOk(OBC.ifsc(a.bank.ifsc), "Looks right")}));
    }
    if (step === "menu") {
      const what = t.packaged ? "products" : "dishes";
      return '<h2>Add your first ' + what + '</h2><p class="muted">Five is enough to start. You can add photos' + (t.packaged ? ", brand and label details" : "") + " and more once you're live.</p>" +
        '<div class="reg-dishes">' + a.menu.dishes.map((d, i) => '<div class="reg-dish' + (t.packaged ? " pk" : "") + '"><input class="input" data-ob="menu.dishes.' + i + '.name" value="' + h(d.name || "") + '" placeholder="' + (t.packaged ? "Product" : "Dish") + " " + (i + 1) + '" maxlength="80" autocomplete="off">' +
          '<input class="input" data-ob="menu.dishes.' + i + '.price" data-digits="1" inputmode="numeric" value="' + h(d.price || "") + '" placeholder="' + (t.packaged ? "MRP ₹" : "₹") + '" maxlength="5">' +
          (t.packaged ? '<input class="input" data-ob="menu.dishes.' + i + '.packSize" value="' + h(d.packSize || "") + '" placeholder="' + (REG.type === "dairy" ? "500 ml" : t.pharmacy ? "20 pieces" : "1 kg") + '" maxlength="20" aria-label="Pack size">'
            : '<button type="button" class="reg-diet' + (d.diet === "nonveg" ? " nonveg" : "") + '" data-act="rg-diet" data-id="' + i + '">' + (d.diet === "nonveg" ? "Non-veg" : "Veg") + "</button>") + "</div>").join("") + "</div>" +
        '<button type="button" class="btn" data-act="rg-add-dish">+ Add another</button><div class="divider">or</div>' +
        regPhoto("menu", (t.packaged ? "Price list" : "Menu card") + " photo" + (a.menu.cardPhotoPaths.length > 1 ? "s (" + a.menu.cardPhotoPaths.length + ")" : ""), "Scraveit types it in for you", "menu.cardPhotoPaths.0");
    }
    const row = (l, v, s) => '<div class="reg-row"><span>' + h(l) + "</span><span>" + v + ' <button type="button" class="linklike" data-act="rg-goto" data-id="' + s + '">Edit</button></span></div>', issues = regIssues();
    const gstText = t.packaged ? (a.gstMode === "registered" ? (OBC.gstin(a.gstin) ? "✓ " + h(String(a.gstin).toUpperCase()) : "Check GSTIN") : a.gstMode === "exempt_only" ? "GST-free items only" : (a.gstEnrolment ? "✓ Enrolment " + h(String(a.gstEnrolment).toUpperCase()) : "Add enrolment number")) : a.hasGst ? (OBC.gstin(a.gstin) ? "✓ " + h(String(a.gstin).toUpperCase()) : "Check GSTIN") : "Not registered";
    return '<h2>Check and submit</h2><p class="muted">Scraveit checks your documents, usually within a day.</p><div class="reg-review">' +
      row(t.title, h(a.restaurantName || "—"), 0) + row("Owner", h(a.ownerName || "—"), 0) + row("Location", h([a.location.area, a.location.city].filter(Boolean).join(", ") || "—"), 1) +
      (t.pharmacy ? row("Drug licence", OBC.drugLicence(a.drugLicence.number) && a.drugLicence.photoPath ? "✓ " + h(String(a.drugLicence.number).toUpperCase()) : "Missing", 2) : row("FSSAI", OBC.fssai(a.fssai.number) ? "✓ " + h(a.fssai.number) : "Missing", 2)) +
      row("PAN", OBC.pan(a.pan.number) ? "✓ " + h(String(a.pan.number).toUpperCase()) : "Missing", 2) + row("GST", gstText, 2) +
      row("Payouts", a.bank.method === "upi" ? (OBC.upi(a.bank.upiId) ? "✓ UPI" : "Missing") : (OBC.ifsc(a.bank.ifsc) && a.bank.accountNumber ? "✓ Bank account ••" + h(String(a.bank.accountNumber).slice(-4)) : "Missing"), 3) +
      row(t.packaged ? "Products" : "Menu", a.menu.dishes.filter((d) => d.name && Number(d.price) > 0).length + " items" + (a.menu.cardPhotoPaths.length ? " + photo" : ""), 4) + "</div>" +
      (issues.length ? '<div class="notice warn">Still needed: ' + h(issues.join(" · ")) + "</div>" : "") +
      '<div class="notice info"><span><strong>What happens next.</strong> 1. Scraveit checks your documents. 2. We confirm your commission (standard rate ' + REG_RATE + "%). 3. You sign the partner agreement here. 4. You go live.</span></div>";
  }
  function regWizard() {
    const app0 = REG.apps[REG.type] || {}, i = REG.step, last = i === REG_STEPS.length - 1, t = regT();
    const steps = REG_STEPS.map((s, k) => '<button type="button" class="reg-step' + (k === i ? " on" : k < i ? " done" : "") + '" data-act="rg-goto" data-id="' + k + '"' + (k > i && app0.status === "draft" && k > Number(app0.step || 0) ? " disabled" : "") + "><b>" + (k < i ? "✓" : k + 1) + "</b><span>" + h(k === 4 && t.packaged ? "Products" : s[1]) + "</span></button>").join("");
    return '<div class="reg"><header class="reg-top"><div class="wordmark">scraveit<span>*</span></div><span class="muted">Register your ' + h(t.noun) + '</span><span class="grow"></span>' + regLangBtn() + '<button class="btn small" data-act="rg-home">All registrations</button>' + (state.rid ? "" : '<button class="btn small" data-act="signout">Sign out</button>') + "</header>" +
      '<div class="reg-body"><nav class="reg-steps">' + steps + '<p class="small muted">Saved as you go. You can close this and finish later, here or in the app.</p></nav><section class="reg-card">' +
      (app0.status === "changes_requested" && app0.reviewMessage ? '<div class="notice warn"><span><strong>Scraveit asked for a change:</strong> ' + h(app0.reviewMessage) + "</span></div>" : "") +
      (REG.error ? '<div class="notice bad">' + h(REG.error) + "</div>" : "") + regStepBody() +
      '<footer class="reg-foot">' + (i ? '<button class="btn" data-act="rg-back">Back</button>' : "<span></span>") + '<button class="btn primary" data-act="' + (last ? "rg-submit" : "rg-next") + '"' + (REG.saving || REG.busy ? " disabled" : "") + ">" + (REG.saving ? "Saving…" : last ? "Submit for review" : "Continue") + "</button></footer></section></div></div>";
  }
  function regLangBtn() { return '<button class="btn small" data-act="lang" translate="no">' + (window.ScraveitLanguage && ScraveitLanguage.get() === "te" ? "English" : "తెలుగు") + "</button>"; }

  // ----- after submitting: live status and the agreement -----
  function regWatch() {
    if (REG.watch || !REG.type) return;
    const type = REG.type;
    try {
      REG.watch = regDoc(type).onSnapshot((s) => {
        if (state.rid || REG.type !== type || !s.exists) return;
        const next = s.data(), prev = REG.apps[type] || {}, key = (a) => JSON.stringify([a.status || "", a.terms || null, (a.agreement || {}).status || "", a.reviewMessage || ""]);
        const changed = key(next) !== key(prev); REG.apps[type] = next;
        if (changed && !REG.editing) { REG.draft = null; regLoadAgreement(true); if (!modalRoot.innerHTML) render(); }
      }, () => { REG.watch = null; });
    } catch (_) { REG.watch = null; }
  }
  function regStopWatch() { if (REG.watch) { try { REG.watch(); } catch (_) { /* gone */ } REG.watch = null; } }
  async function regLoadAgreement(force) {
    if (!REG.type || (!force && (REG.agLoading || REG.ag))) return;
    REG.agLoading = true; const type = REG.type;
    try { const ag = await call("getRestaurantAgreement", {appId: regAppId(type)}); if (REG.type === type) { REG.ag = ag; REG.agError = ""; } }
    catch (e) { REG.agError = friendly(e); }
    REG.agLoading = false;
    if (!state.rid && !modalRoot.innerHTML) render();
    if (document.getElementById("reg-ag")) regAgreementModal();
  }
  function regStatus() {
    const app0 = REG.apps[REG.type] || {}, t = regT(), ag = REG.ag, missing = regIssues(), signed = ag && ag.status === "signed", rateSet = ag && ag.rateAgreed, approved = app0.status === "approved", pct = ag && Number.isFinite(Number(ag.commissionBps)) && ag.commissionBps !== null ? Number(ag.commissionBps) / 100 : REG_RATE;
    regWatch(); if (!REG.ag && !REG.agLoading && !REG.agError) setTimeout(() => regLoadAgreement(false), 0);
    const steps = [["Submitted", true, "We have your details"], ["Documents checked", !missing.length && (rateSet || signed || approved), missing.length ? "Add the missing details below" : "Usually within a day"],
      ["Rate confirmed", rateSet || approved, rateSet ? pct + "% commission" : "Standard rate " + REG_RATE + "% until we agree yours"], ["Agreement signed", signed || approved, signed ? "Signed " + new Date(ag.signedAt).toLocaleDateString("en-IN") : "Read and sign it here when your rate is confirmed"], ["Live on Scraveit", approved, "Open your " + t.noun + " and take orders"]];
    const firstOpen = steps.findIndex((s) => !s[1]);
    return '<div class="signin"><div class="signin-card reg-status"><div class="row between"><div class="wordmark">scraveit<span>*</span></div>' + regLangBtn() + '</div><p class="small muted" style="margin:0">Your registration · ' + h(REG_TYPE_LABEL[REG.type]) + '</p><h1 style="font-size:22px">' + h(app0.restaurantName || "Your " + t.noun) + "</h1>" +
      "<p>" + (approved ? "You're approved! Open your " + h(t.noun) + " to start." : app0.status === "changes_requested" ? "Scraveit asked for a few changes." : signed ? "All done from your side. Scraveit will switch you on shortly." : rateSet ? "Your rate is confirmed. Read and sign your partner agreement." : "Thanks! We're checking your details.") + "</p>" +
      '<ol class="reg-track">' + steps.map((s, i) => '<li class="' + (s[1] ? "done" : i === firstOpen ? "now" : "") + '"><b>' + (s[1] ? "✓" : i + 1) + "</b><div><strong>" + h(s[0]) + '</strong><span class="small muted">' + h(s[2]) + "</span></div></li>").join("") + "</ol>" +
      (missing.length && !approved ? '<div class="notice warn"><span>' + h(missing.join(" · ")) + "</span></div>" : "") +
      (!ag && !approved && REG.agError ? '<div class="notice bad">Couldn\'t load your rate: ' + h(REG.agError) + "</div>" : "") +
      (approved ? '<button class="btn primary block" data-act="rg-open-outlet">Open my ' + h(t.noun) + "</button>"
        : '<div class="reg-rate"><span>' + (rateSet ? "Your rate" : "Standard rate") + "</span><strong>" + h(pct) + '%</strong></div><p class="small muted" style="margin:0">' + (rateSet ? "Commission on the item total after your own offers, plus 18% GST on the commission. Fixed for " + h(ag.termMonths) + " months." : "Commission on the item total after your own offers. Your Scraveit partner manager will confirm your rate with you.") + "</p>" +
          (rateSet && !signed ? '<button class="btn primary block" data-act="rg-agreement">Read and sign the agreement</button>' : signed ? '<button class="btn block" data-act="rg-agreement">View your signed agreement</button>' : "")) +
      (!approved && !signed ? '<button class="btn block" data-act="rg-edit">' + (missing.length ? "Add missing details" : "Edit my details") + "</button>" : "") +
      (!approved ? '<button class="btn block" data-act="rg-refresh">Check status</button>' : "") +
      '<div class="row"><button class="btn grow" data-act="rg-home">All registrations</button>' + (state.rid ? "" : '<button class="btn grow" data-act="signout">Sign out</button>') + "</div></div></div>";
  }
  function regAgreementModal() {
    const ag = REG.ag;
    const body = !ag ? '<div class="spinner"></div>' : !ag.partiesReady ? '<div class="notice warn">The agreement isn\'t ready yet. Please check again later.</div>'
      : '<div class="ag-text">' + (ag.sections || []).map((s) => "<h3>" + h(s.heading) + "</h3><p>" + h(s.body) + "</p>").join("") + "</div>" +
        (ag.status === "signed" ? '<div class="notice info">Signed by ' + h(ag.signedBy) + " on " + h(new Date(ag.signedAt).toLocaleString("en-IN", {day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit"})) + ".</div>"
          : '<div class="field"><label for="rg-sign-name">Type your full name to sign</label><input class="input" id="rg-sign-name" autocomplete="name"></div><label class="ol-check"><input type="checkbox" id="rg-sign-consent"><span><strong>I have read this agreement and I agree to it</strong></span></label>' +
            '<button class="btn primary block" data-act="rg-sign"' + (REG.signing ? " disabled" : "") + ">" + (REG.signing ? "Signing…" : "Accept and sign") + '</button><p class="small muted" style="margin:0">Your name, account, time and device are recorded with the agreement. It is a valid electronic agreement under the IT Act, 2000 (s.10A).</p>');
    modalRoot.innerHTML = '<div class="modal-back"><div class="modal wide" id="reg-ag" role="dialog" aria-modal="true" aria-label="Partner agreement"><header><h2>Partner agreement' + (ag && ag.partiesReady ? ' <span class="small muted">' + h(ag.commissionBps / 100) + "% · " + h(ag.termMonths) + " months</span>" : "") + '</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>' + body + "</div></div>";
  }
  async function regSign() {
    const ag = REG.ag, name = (document.getElementById("rg-sign-name") || {}).value || "", consent = !!(document.getElementById("rg-sign-consent") || {}).checked;
    if (!ag || REG.signing) return;
    if (!consent) { toast("Tick the box to confirm you agree.", true); return; }
    if (name.trim().length < 2) { toast("Type your full name to sign.", true); return; }
    REG.signing = true; regAgreementModal();
    try { await call("signRestaurantAgreement", {appId: regAppId(REG.type), hash: ag.hash, typedName: name.trim(), consent: true, method: "in_app"}); REG.ag = null; REG.signing = false; closeModal(); toast("Agreement signed. Thank you!"); await regLoadAgreement(true); return; }
    catch (e) { toast(friendly(e), true); }
    REG.signing = false; regAgreementModal();
  }

  // ----- the screen for an account with no outlet -----
  function regHome() {
    const apps = REG.apps, types = Object.keys(apps), statusText = {draft: "Not finished", submitted: "Being checked", changes_requested: "Changes asked", approved: "Approved"};
    const pick = Object.keys(REG_TYPES).filter((x) => !apps[x]).map((x) => '<button class="btn" data-act="rg-start" data-id="' + x + '"' + (REG.busy ? " disabled" : "") + ">" + h(REG_TYPE_LABEL[x]) + "</button>").join("");
    return '<div class="signin"><div class="signin-card"><div class="row between"><div class="wordmark">scraveit<span>*</span></div>' + regLangBtn() + "</div>" +
      (types.length ? '<h1 style="font-size:20px">Your registrations</h1>' + types.map((x) => '<button class="reg-app" data-act="rg-open" data-id="' + x + '"><span class="grow"><strong>' + h(apps[x].restaurantName || REG_TYPE_LABEL[x]) + '</strong><span class="small muted">' + h(REG_TYPE_LABEL[x]) + "</span></span><span class=\"pill\">" + h(statusText[apps[x].status] || "Being checked") + "</span></button>").join("") +
          (pick ? '<p class="small muted" style="margin:0">Register another kind of outlet:</p><div class="reg-chips">' + pick + "</div>" : "")
        : '<h1 style="font-size:20px">Register your outlet on Scraveit</h1><p>' + h(state.user.email || "") + " isn't linked to an outlet yet. Register here: about 10 minutes, saved as you go.</p>" +
          '<div class="notice info"><span><strong>Keep these ready:</strong> FSSAI licence (pharmacy: drug licence) · PAN card · bank passbook or cancelled cheque · menu card or price list.</span></div>' +
          '<p class="small muted" style="margin:0">What are you registering?</p><div class="reg-types">' + pick + "</div>" +
          '<p class="small muted" style="margin:0">Staff? Ask your outlet owner to add you from Staff, then sign in with that staff ID.</p>') +
      (state.rid ? '<button class="btn" data-act="rg-dashboard">Back to dashboard</button>' : '<button class="btn" data-act="signout">Sign out</button>') + "</div></div>";
  }
  function regScreen() {
    if (!REG.loaded) { regLoad(); return '<div class="spinner" style="margin-top:20vh"></div>'; }
    if (!REG.type || !REG.apps[REG.type]) return regHome();
    const st = REG.apps[REG.type].status;
    if (st === "draft" || st === "changes_requested" || REG.editing) return regWizard();
    return regStatus();
  }
  // After the screen is drawn: put the map in.
  function regAfterDraw() {
    if (!REG.type || REG_STEPS[REG.step][0] !== "location" || !document.getElementById("ol-map")) return;
    if (!REG.mapSynced) { const l = regDraft().location; OL.draft = {lat: regNum(l.lat), lng: regNum(l.lng)}; OL.saved = wmPoint(l.lat, l.lng); OL.zoom = 16; REG.mapSynced = true; }
    OL.ctx = "reg";
    olDrawMap();
  }
  function regClick(act, el) {
    const id = el.dataset.id;
    if (act === "rg-start") { regStart(id); return true; }
    if (act === "rg-open") { regOpen(id); render(); window.scrollTo(0, 0); return true; }
    if (act === "rg-home") { if (REG.type && REG.draft && (REG.apps[REG.type] || {}).status === "draft") regSave().catch(() => { /* saved next time */ }); regStopWatch(); REG.type = ""; REG.draft = null; REG.editing = false; REG.error = ""; render(); return true; }
    if (act === "rg-dashboard") { regStopWatch(); state.regMode = false; REG.type = ""; REG.draft = null; REG.editing = false; render(); return true; }
    if (act === "rg-new-outlet") { state.regMode = true; REG.loaded = false; REG.type = ""; render(); window.scrollTo(0, 0); return true; }
    if (act === "rg-next") { regNext(false); return true; }
    if (act === "rg-submit") { regNext(true); return true; }
    if (act === "rg-back") { regPullMap(); REG.error = ""; if (REG.step > 0) REG.step--; render(); window.scrollTo(0, 0); return true; }
    if (act === "rg-goto") { regPullMap(); REG.error = ""; REG.step = Number(id) || 0; render(); window.scrollTo(0, 0); return true; }
    if (act === "rg-edit") { REG.draft = null; REG.editing = true; REG.mapSynced = false; const k = REG_STEPS.findIndex((s) => regIssues(s[0]).length); REG.step = k >= 0 ? k : REG_STEPS.length - 1; render(); window.scrollTo(0, 0); return true; }
    if (act === "rg-chip") { const path = el.dataset.path, v = el.dataset.value; if (el.dataset.multi === "1") { const list = (regGet(path) || []).slice(), i = list.indexOf(v); if (i >= 0) list.splice(i, 1); else list.push(v); regPut(path, list); } else regPut(path, v); regPullMap(); render(); return true; }
    if (act === "rg-hours") { const x = regHours(regT()).find((o) => o[0] === el.dataset.value), hrs = regDraft().hours; hrs.preset = x[0]; if (x[2]) { hrs.open = x[2]; hrs.close = x[3]; } regPullMap(); render(); return true; }
    if (act === "rg-gst") { regDraft().gstMode = el.dataset.value; render(); return true; }
    if (act === "rg-bank") { regDraft().bank.method = el.dataset.value; render(); return true; }
    if (act === "rg-diet") { const d = regDraft().menu.dishes[Number(id)]; if (d) d.diet = d.diet === "nonveg" ? "veg" : "nonveg"; el.classList.toggle("nonveg", d && d.diet === "nonveg"); el.textContent = d && d.diet === "nonveg" ? "Non-veg" : "Veg"; return true; }
    if (act === "rg-add-dish") { const m = regDraft().menu; if (m.dishes.length < 30) m.dishes.push({name: "", price: "", diet: "veg"}); render(); return true; }
    if (act === "rg-agreement") { regAgreementModal(); regLoadAgreement(!REG.ag); return true; }
    if (act === "rg-sign") { regSign(); return true; }
    if (act === "rg-refresh") { REG.ag = null; REG.agError = ""; REG.loaded = false; const t = REG.type; regStopWatch(); REG.loading = false; regLoad().then(() => { if (REG.apps[t]) { REG.type = t; render(); } }); render(); return true; }
    if (act === "rg-open-outlet") { regReset(); state.regMode = false; loadOutlets(); return true; }
    if (act === "signup") { REG.signup = true; screenSignUp(); return true; }
    if (act === "signin-back") { REG.signup = false; screenSignIn(); return true; }
    if (act === "google-signup") { REG.pendingConsent = true; auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch((err) => { REG.pendingConsent = false; screenSignUp(friendly(err)); }); return true; }
    return false;
  }
  // Typing into the form keeps the draft; nothing is redrawn, so the cursor stays put.
  function regInput(el) {
    let v = el.value;
    if (el.dataset.upper) { const p = el.selectionStart; v = v.toUpperCase(); if (v !== el.value) { el.value = v; try { el.setSelectionRange(p, p); } catch (_) { /* number inputs */ } } }
    if (el.dataset.digits) { const d = v.replace(/\D/g, ""); if (d !== v) { el.value = d; v = d; } }
    regPut(el.dataset.ob, v);
  }

  // ----- create an account -----
  function screenSignUp(error) {
    const tap = window.ScraveitPrivacy ? '<p class="small" style="margin:0">' + ScraveitPrivacy.tapLine("store", ScraveitPrivacy.lang()) + "</p>" : "";
    app.innerHTML = '<div class="signin"><form class="signin-card" id="signup"><div class="row between"><div class="wordmark">scraveit<span>*</span></div>' + regLangBtn() + '</div><div><h1 style="font-size:22px">Create your account</h1><p>To register your restaurant, store, dairy or pharmacy. You\'ll use it to sign in here and in the Scraveit app.</p></div>' +
      (error ? '<div class="notice bad">' + h(error) + "</div>" : "") +
      '<button class="btn block" type="button" data-act="google-signup">Continue with Google</button><div class="divider">or use email</div>' +
      '<div class="field"><label for="su-em">Email</label><input class="input" id="su-em" type="email" autocomplete="email" required></div>' +
      '<div class="field"><label for="su-pw">Create a password</label><input class="input" id="su-pw" type="password" minlength="6" autocomplete="new-password" required><span class="small muted">At least 6 characters.</span></div>' +
      '<button class="btn primary block" type="submit"' + (REG.creating ? " disabled" : "") + ">" + (REG.creating ? "Creating…" : "Create account") + "</button>" + tap +
      '<p class="small" style="margin:0">Already have an account? <button type="button" class="linklike" style="color:var(--brand)" data-act="signin-back">Sign in</button></p></form></div>';
  }
  async function createAccount(form) {
    if (REG.creating) return;
    const email = form.querySelector("#su-em").value.trim().toLowerCase(), password = form.querySelector("#su-pw").value;
    if (!email || password.length < 6) { screenSignUp("Enter your email and a password of at least 6 characters."); return; }
    REG.creating = true; REG.pendingConsent = true; screenSignUp();
    try { await auth.createUserWithEmailAndPassword(email, password); }
    catch (e) { REG.pendingConsent = false; REG.creating = false; screenSignUp(friendly(e)); return; }
    REG.creating = false;
  }
  // Consent to the privacy notice, recorded the way the apps record it (privacyConsents/{uid}_store).
  async function saveSignupConsent(user) {
    if (!REG.pendingConsent || !user || !window.ScraveitPrivacy) return;
    REG.pendingConsent = false;
    try { await db.collection("privacyConsents").doc(ScraveitPrivacy.consentDocId(user.uid, "store")).set(ScraveitPrivacy.consentRecord(user.uid, "store", ScraveitPrivacy.lang(), "signup", "partner_website")); }
    catch (e) { console.warn("consent not saved", e); }
  }

  // ---------- shell ----------
  const PAGES = [["orders", "Live orders", "orders"], ["history", "Order history", "history"], ["reports", "Reports", "reports"], ["insights", "Insights", "insights"], ["finance", "Finance", "payouts"], ["menu", "Menu", "menu"], ["offers", "Offers", "offers"], ["ads", "Ads", "ads"], ["dinein", "Dine-in", "dine"], ["meals", "Meal plans", "meals"], ["staff", "Staff", "staff"], ["outlet", "Outlet info", "outlet"]];
  // A page that fails to draw shows what went wrong, not the last spinner forever.
  function pageOrProblem(body) {
    try { return body(); } catch (e) {
      console.error(e);
      return '<div class="notice warn">This page didn\'t open: ' + h((e && e.message) || "something went wrong.") + '</div><button class="btn" data-act="reload-site">Reload</button>';
    }
  }
  function render() {
    if (!state.user) return REG.signup ? screenSignUp() : screenSignIn();
    if (state.loadingOutlets) { app.innerHTML = '<div class="spinner" style="margin-top:20vh"></div>'; return; }
    if (!state.rid || state.regMode) { app.innerHTML = regScreen(); regAfterDraw(); return; }
    const o = outlet(), open = o.doc.open !== false, ids = Object.keys(state.outlets), newCount = liveIn("new").length;
    // Staff land on the first page the owner gave them.
    if (!pageAllowed(state.page)) state.page = PAGES.map((p) => p[0]).find(pageAllowed) || "outlet";
    const body = {orders: pageOrders, history: pageHistory, reports: pageReports, insights: pageInsights, menu: pageMenu, offers: pageOffers, ads: pageAds, finance: pageFinance, dinein: pageDine, meals: pageMeals, staff: pageStaff, outlet: pageOutlet}[state.page] || pageOutlet;
    const title = (PAGES.find((p) => p[0] === state.page) || PAGES[0])[1];
    const scroll = window.scrollY;
    app.innerHTML = '<div class="shell"><aside class="side"><div class="wordmark">scraveit<span>*</span><small>Partner dashboard</small></div>' +
      PAGES.filter((p) => pageAllowed(p[0])).map((p) => '<button class="nav-item' + (state.page === p[0] ? " on" : "") + '" data-act="page" data-page="' + p[0] + '">' + svg(p[2]) + "<span>" + p[1] + "</span>" + (p[0] === "orders" ? '<span class="count"' + (newCount ? "" : " hidden") + ">" + newCount + "</span>" : "") + "</button>").join("") +
      '<div class="spacer"></div><div class="who">' + h(staffIdOf(state.user.email) ? (o.member.name || "Staff") + " · " + staffIdOf(state.user.email) : state.user.email || "") + '</div><button class="nav-item" data-act="signout">' + svg("out") + "<span>Sign out</span></button></aside>" +
      '<div class="main"><header class="topbar"><h1>' + h(title) + "</h1>" +
      (ids.length > 1 ? '<select class="input outlet-select" data-input="outlet" aria-label="Outlet">' + ids.map((id) => '<option value="' + h(id) + '"' + (id === state.rid ? " selected" : "") + ">" + h(state.outlets[id].doc.name || id) + "</option>").join("") + "</select>" : '<strong>' + h(o.doc.name) + "</strong>") +
      (availabilityOutletIds().length > 1 ? '<button class="btn small" data-act="all-open" title="Open every outlet">Open all</button><button class="btn small" data-act="all-close" title="Close every outlet">Close all</button>' : "") +
      '<button class="btn small lang-btn" data-act="lang" translate="no" title="Language · భాష">' + (window.ScraveitLanguage && ScraveitLanguage.get() === "te" ? "English" : "తెలుగు") + "</button>" +
      '<button class="status-toggle' + (open ? " on" : "") + '" data-act="toggle-open" title="Accepting orders"' + (can("availability") ? "" : " disabled") + "><i></i>" + (open ? "Online" : "Offline") + "</button></header>" +
      '<main class="content">' + (WEB_CHECK ? "" : '<div class="notice warn">You can see everything here. Accepting and updating orders from the website switches on soon; until then, use the Scraveit Restaurant app for order actions.</div>') + cnBannerHtml() + pageOrProblem(body) + "</main></div></div>";
    window.scrollTo(0, scroll);
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]"); if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    if (act === "google") { auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch((err) => screenSignIn(friendly(err))); return; }
    if (act === "signout") { if (state.liveUnsub) state.liveUnsub(); regReset(); state.regMode = false; REG.signup = false; auth.signOut(); return; }
    if ((act.startsWith("rg-") || act === "signup" || act === "signin-back" || act === "google-signup") && regClick(act, el)) return;
    if (act === "page") { state.page = el.dataset.page; render(); window.scrollTo(0, 0); return; }
    if (act === "order-tab") { state.orderTab = el.dataset.tab; render(); return; }
    if (act === "sound") {
      unlockAudio(); return;
    }
    if (act === "status") { setStatus(id, el.dataset.to); return; }
    if (act === "printer-setup") { printerModal(); return; }
    if (act === "printer-opt") { savePrinterSettings({[el.dataset.key]: !!el.checked}); if (state.page === "orders") render(); return; }
    if (act === "printer-paper") { savePrinterSettings({paper: Number(id) === 80 ? 80 : 58}); printerModal(); return; }
    if (act === "printer-test") { printReceipt(printerTestLines()); return; }
    if (act === "print-order") { const o = state.live.find((x) => orderId(x) === id); if (o) { const p = printerSettings(); printReceipt([].concat(p.kitchen || !p.bill ? kitchenPrintLines(o) : [], p.bill ? billPrintLines(o) : [])); } return; }
    if (act === "reject") { rejectModal(id); return; }
    if (act === "close-alert" || act === "close-modal") { closeModal(); return; }
    if (act === "hist-range") { state.history.range = el.dataset.range; state.history.list = null; render(); return; }
    if (act === "hist-sel") { state.history.sel = id; render(); return; }
    if (act === "hist-csv") {
      const rows = [["Order ID", "Outlet", "Placed", "Customer", "Status", "Items", "Menu value", "Customer paid", "Payment", "Your earnings"]].concat((state.history.list || []).map((o) => [orderId(o), (state.outlets[o.restaurantId] || {doc: {}}).doc.name || o.restaurantId, new Date(placedAt(o)).toLocaleString("en-IN"), firstName(o), o.status, (o.items || []).map((i) => i.quantity + " x " + i.name).join("; "), itemValue(o), customerPaid(o), o.paymentMethod === "cod" ? "Cash" : "Online", earnings(o) ?? ""]));
      download("scraveit-orders-" + state.history.range + ".csv", csv(rows)); return;
    }
    if (act === "insights-reload") { state.insights.rid = ""; render(); return; }
    if (act === "rep-range") { state.reports.range = el.dataset.range; state.reports.data = null; render(); return; }
    if (act === "fin-tab") { state.fin.tab = el.dataset.tab; render(); return; }
    if (act === "fin-week") { state.fin.week = id; render(); return; }
    if (act === "pay-method") { savePayMethod(id); return; }
    if (act === "outlet-edit") { outletEditModal(); return; }
    if (act === "dine-table") { dineTableModal(id); return; }
    if (act === "dine-qr-one") { printDineQr(id); return; }
    if (act === "dine-qr") { printDineQr(""); return; }
    if (act === "dine-op") { dineOp(el); return; }
    if (act === "dine-accept") { dineRespond(id, true); return; }
    if (act === "dine-decline") { dineRespond(id, false); return; }
    if (act === "dine-setup") { dineSetupModal(); return; }
    if (act === "dine-pause") { const f = document.getElementById("dine-form"); if (f && confirm("Pause dine-in? Your tables are kept.")) saveDine(f, {pause: true}); return; }
    if (act === "mp-edit") { mealPlanModal(id); return; }
    if (act === "mp-days") { const f = document.getElementById("meal-plan-form"), want = String(id).split(","); if (f) { f.querySelectorAll('input[name="day"]').forEach((x) => { x.checked = want.includes(x.value); }); mpSummary(); } return; }
    if (act === "price-check") { priceCheckModal(); return; }
    if (act === "agreement") { agreementModal(); return; }
    if (act === "ag-reload") { loadAgreement(); return; }
    if (act === "cn-open") { cnModal(); return; }
    if (act === "all-open") { setAllOutlets(true); return; }
    if (act === "all-close") { setAllOutlets(false); return; }
    if (act === "cn-reload") { cnLoad(); return; }
    if (act === "cn-accept") { cnAccept(); return; }
    if (act === "ag-details") { loadAgreement(Object.assign({}, AG.details, agFields())); return; }
    if (act === "ag-sign") { signAgreement(); return; }
    if (act === "delete-account") { deletionModal(); return; }
    if (act === "chat") { openChat(id, el.dataset.channel); return; }
    if (act === "cp-open") { cpLoad().then(() => cpModal(id)); return; }
    if (act === "cp-all") { const f = document.getElementById("cp-form"); if (f) f.querySelectorAll('input[name="to"]').forEach((x) => { x.checked = true; }); cpCount(); return; }
    if (act === "wm-expand") { wmOpenFull("view"); return; }
    if (act === "wm-move") { wmOpenFull("edit"); return; }
    if (act === "wm-edit") { wmStartEdit(); return; }
    if (act === "wm-close") { wmClose(); return; }
    if (act === "wm-confirm") { wmConfirm(); return; }
    if (act === "wm-locate") { wmLocate(); return; }
    if (act === "wm-undo") { OL.draft = OL.saved ? {lat: OL.saved.lat, lng: OL.saved.lng} : {lat: NaN, lng: NaN}; olDrawMap(); return; }
    if (act === "wm-zoom") { const root = wmFullRoot(); if (root) { const m = wmGet(root); wmSet(root, m.c, m.z + Number(id)); } return; }
    if (act === "wm-recenter") { const root = wmTarget(el); if (root) { const m = wmGet(root); if (m.pin) wmSet(root, m.pin, m.z); } return; }
    if (act === "ol-detect") { wmOpenFull("edit"); wmLocate(); return; }
    if (act === "ol-cover-first") { const i = Number(id); OL.covers.unshift(OL.covers.splice(i, 1)[0]); olDrawCovers(); return; }
    if (act === "ol-cover-remove") { OL.covers.splice(Number(id), 1); olDrawCovers(); return; }
    if (act === "bank-edit") { state.fin.bankEdit = true; render(); return; }
    if (act === "bank-cancel") { state.fin.bankEdit = false; render(); return; }
    if (act === "fin-annex" || act === "fin-print") {
      const w = weekRows().find((x) => String(x.start) === state.fin.week); if (!w) return;
      if (act === "fin-print") printStatement(w); else download("scraveit-payout-" + isoDay(w.start) + ".csv", csv(annexureRows(w)));
      return;
    }
    if (act === "fin-q") { state.fin.q = id; render(); return; }
    if (act === "fin-month") { state.fin.month = id; state.fin.showAll = false; render(); return; }
    if (act === "fin-show-all") { state.fin.showAll = !state.fin.showAll; render(); return; }
    if (act === "fin-xlsx") { const m = monthList().find((x) => x.key === state.fin.month), M = m && state.fin.mon[m.key]; if (M && !M.loading) monthWorkbook(m, M).catch((e) => toast(friendly(e), true)); return; }
    if (act === "fin-month-print") { printMonth(); return; }
    if (act === "fin-orders") { const w = weekRows().find((x) => String(x.start) === state.fin.week), L = w && state.fin.wk[String(w.start)]; if (L && L.data) ledgerOrdersModal(w, L.data); return; }
    if (act === "tds-claim") { claimModal(); return; }
    if (act === "fin-csv") { taxCsv(id); return; }
    if (act === "fin-inv") { invoiceModal(id); return; }
    if (act === "fin-inv-print") { const T = state.fin.tax[state.fin.q], o = T && (T.orders || []).find((x) => orderId(x) === id); if (o) printDoc("Invoice", invoiceHtml(o)); return; }
    if (act === "copy-utr") { navigator.clipboard.writeText(id).then(() => toast("UTR copied."), () => toast(id)); return; }
    if (act === "fin-utr-csv") { download("scraveit-payouts-utr.csv", csv([["Date", "Amount", "UTR", "Method", "Status", "Note"]].concat(payouts().map((p) => [isoDay(p.at), p.amount, p.utr, METHODS[p.method] || p.method, p.status === "paid" ? "Sent" : "Held", p.reason])))); return; }
    if (act === "cat") { state.menu.cat = el.dataset.cat; render(); return; }
    if (act === "arrange") { startArrange(); return; }
    if (act === "arrange-cancel") { state.menu.arrange = null; render(); return; }
    if (act === "arrange-save") { saveArrange(); return; }
    if (act === "mv") { arrangeMove(el.dataset.kind, Number(el.dataset.i), el.dataset.to); return; }
    if (act === "gst") { toggleGst(); return; }
    if (act === "stock") { toggleStock(id); return; }
    if (act === "edit-item") { editItemModal(id); return; }
    if (act === "item-new") { editItemModal(""); return; }
    if (act === "lang") { if (window.ScraveitLanguage) ScraveitLanguage.set(ScraveitLanguage.get() === "te" ? "en" : "te"); return; }
    if (act === "tax-edit") { taxEditModal(); return; }
    if (act === "item-archive") { if (confirm("Archive this item? Customers stop seeing it; you can restore it later.")) archiveItem(id, false); return; }
    if (act === "item-restore") { archiveItem(id, true); return; }
    if (act === "item-delete") { deleteItem(id); return; }
    if (act === "show-archived") { archivedModal(); return; }
    if (act === "choice-add") { const box = document.getElementById("ch-" + id); if (box) { box.insertAdjacentHTML("beforeend", choiceRow(id, {})); const n = box.lastElementChild.querySelector('[data-f="name"]'); if (n) n.focus(); } return; }
    if (act === "choice-del") { const r = el.closest(".choice-row"); if (r) r.remove(); return; }
    if (act === "dp-mode") { if (dishPhoto) { dishPhoto.use = el.dataset.mode; showDishPhoto(); } return; }
    if (act === "ai-desc") { aiDescription(false); return; }
    if (act === "ai-rewrite") { aiDescription(true); return; }
    if (act === "ai-undo") { const box = document.getElementById("idesc"); if (box && aiPrevious != null) { box.value = aiPrevious; aiPrevious = null; el.hidden = true; } return; }
    if (act === "freebie-new" || act === "freebie-edit") { freebieModal(id || ""); return; }
    if (act === "freebie-pause") { const on = freebies().find((x) => x.id === id); if (on) saveFreebies(freebies().map((x) => x.id === id ? Object.assign({}, x, {active: x.active === false}) : x), on.active === false ? "Offer is live again." : "Offer paused."); return; }
    if (act === "freebie-delete") { const on = freebies().find((x) => x.id === id); if (on && confirm("Delete “" + on.title + "”? Customers stop seeing it.")) saveFreebies(freebies().filter((x) => x.id !== id), "Offer deleted."); return; }
    if (act === "pairing-new" || act === "pairing-edit") { pairingModal(id || ""); return; }
    if (act === "pairing-pause") { const on = pairings().find((x) => x.id === id); if (on) savePairings(pairings().map((x) => x.id === id ? Object.assign({}, x, {active: x.active === false}) : x), on.active === false ? "Pairing is live again." : "Pairing paused."); return; }
    if (act === "pairing-delete") { const on = pairings().find((x) => x.id === id); if (on && confirm("Delete “" + on.title + "”? Customers stop seeing it. The dish stays on your menu.")) savePairings(pairings().filter((x) => x.id !== id), "Pairing deleted."); return; }
    if (act === "discount-new") { discountModal(); return; }
    if (act === "toggle-open") { toggleOpen(); return; }
    if (act === "ad-days") { state.ads.days = Number(id); render(); return; }
    if (act === "ad-book") { adConfirmModal(); return; }
    if (act === "ad-confirm") { bookAd(); return; }
    if (act === "ad-cancel") { cancelAd(id); return; }
    if (act === "ad-reload") { state.ads.loaded = false; render(); return; }
    if (act === "reload-site") { location.reload(); return; }
    if (act === "ad-inv") { adInvoiceModal(id); return; }
    if (act === "staff-reload") { state.staff.rid = ""; state.staff.error = ""; render(); return; }
    if (act === "staff-add") { staffModal(""); return; }
    if (act === "staff-edit") { staffModal(id); return; }
    if (act === "staff-pass") { passModal(id); return; }
    if (act === "staff-remove") { removeStaff(id); return; }
    if (act === "staff-newpass") { const f = document.getElementById("st-pass"); if (f) f.value = newPassword(); return; }
    if (act === "staff-preset") {
      const pick = (PRESETS[Number(id)] || [0, []])[1];
      document.querySelectorAll('#staff-form input[name="f"]').forEach((x) => { x.checked = pick.includes(x.value); }); return;
    }
    if (act === "staff-copy") { const t = state.staff.share; if (t && navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast("Copied. Paste it in a message to them."), () => toast("Couldn't copy. Write it down instead.", true)); return; }
    if (act === "staff-share") { const t = state.staff.share; if (t && navigator.share) navigator.share({text: t}).catch(() => { /* closed */ }); return; }
    if (act === "ad-inv-print") { const b = state.ads.data && state.ads.data.bookings.find((x) => x.bookingId === id); if (b) printDoc("Invoice " + b.invoiceNo, adInvoiceHtml(b)); return; }
  });
  document.addEventListener("change", (e) => {
    const ds = e.target.dataset || {};
    if (e.target.name === "to" && e.target.closest("#cp-form")) { cpCount(); return; }
    if (ds.obCheck) { regDraft()[ds.obCheck] = !!e.target.checked; if (ds.obCheck === "hasGst") { regPullMap(); render(); } return; }
    if (ds.obPhoto) { regUpload(ds.obPhoto, e.target.files && e.target.files[0]); e.target.value = ""; return; }
    const k = ds.input; if (!k) return;
    if (k === "outlet") selectOutlet(e.target.value);
    if (k === "cp-from") { const f = document.getElementById("cp-form"), keep = f ? [...f.querySelectorAll('input[name="to"]:checked')].map((x) => x.value) : []; cpModal(e.target.value, keep.filter((x) => x !== e.target.value), /Use these/.test((f && f.querySelector("h2") || {}).textContent || "")); }
    if (k === "hist-status") { state.history.status = e.target.value; render(); }
    if (k === "hist-all") { state.history.all = e.target.checked; state.history.list = null; render(); }
    if (k === "rep-all") { state.reports.all = e.target.checked; state.reports.data = null; render(); }
    if (k === "ad-start" && e.target.value) { state.ads.start = e.target.value; render(); }
    if (k === "staff-role") { const box = document.getElementById("st-features"); if (box) box.hidden = e.target.value === "restaurant_manager"; }
    if (k === "fb-trigger" || k === "fb-preview") freebiePreview();
    if (k === "pr-preview") pairingPreview();
    if (k === "dish-photo") { pickDishPhoto(e.target.files && e.target.files[0]); e.target.value = ""; }
    if (k === "ol-cover") { addOutletCover(e.target.files && e.target.files[0]); e.target.value = ""; }
    if (k === "mp-meal") { const f = e.target.form, t = MEAL_TIMES[e.target.value]; if (f && t) { f.elements.windowStart.value = t[0]; f.elements.windowEnd.value = t[1]; } mpSummary(); }
    if (k === "mp-sum") mpSummary();
    if (k === "tax-guide") { const g = GST_GUIDES().find((x) => x[0] === e.target.value), f = e.target.form; if (g && g[2] && f) { f.elements.tax_hsn.value = g[2][0]; f.elements.tax_rate.value = String(g[2][1] / 100); f.elements.tax_kind.value = g[2][2]; f.elements.tax_packed.checked = g[2][3]; } }
    if (k === "dine-all" && e.target.value) { document.querySelectorAll('#dn-seats input').forEach((x) => { x.value = e.target.value; }); e.target.value = ""; }
    if (k === "dc-kind") { const f = document.getElementById("discount-form"); if (f) f.dataset.kind = e.target.value; }
  });
  let typing = null;
  document.addEventListener("input", (e) => {
    if (e.target.dataset && e.target.dataset.ob) { regInput(e.target); return; }
    const f = e.target.dataset && e.target.dataset.input;
    if (f === "fb-preview") { freebiePreview(); return; }
    if (f === "dine-count") { const box = document.getElementById("dn-seats"), n = Math.max(1, Math.min(60, Number(e.target.value) || 0)); if (box && n) { const cur = Array.from(box.querySelectorAll("input")).map((x) => Number(x.value) || 4); while (cur.length < n) cur.push(cur[cur.length - 1] || 4); box.innerHTML = dineSeatInputs(cur.slice(0, n), dineSettings().tables); } return; }
    if (f === "pc-price") { const o = document.getElementById("pc-get"); if (o) o.innerHTML = youGetText(e.target.value); return; }
    if (f === "pc-want") { const o = document.getElementById("pc-want-out"); if (o) o.innerHTML = wantText(e.target.value); return; }
    if (f === "dish-price") { const o = document.getElementById("iprice-get"); if (o) o.innerHTML = youGetText(e.target.value); return; }
    if (f === "pr-preview") { pairingPreview(); return; }
    if (f === "dish-search") { const q = e.target.value.trim().toLowerCase(), pick = e.target.nextElementSibling; if (!pick) return; pick.querySelectorAll(".dish-opt").forEach((x) => { x.hidden = !!q && !x.dataset.name.includes(q); }); pick.querySelectorAll(".dish-cat").forEach((c) => { c.hidden = !c.querySelector(".dish-opt:not([hidden])"); }); return; }
    const k = e.target.dataset && e.target.dataset.input; if (k !== "hist-q" && k !== "menu-q" && k !== "utr-q") return;
    clearTimeout(typing);
    typing = setTimeout(() => { const v = e.target.value.trim(); if (k === "hist-q") state.history.q = v; else if (k === "utr-q") state.fin.utrQ = v; else state.menu.q = v; render(); const again = document.querySelector('[data-input="' + k + '"]'); if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); } }, 250);
  });
  // Elapsed times on live orders tick over once a minute.
  setInterval(() => { if (state.user && state.page === "orders" && !modalRoot.innerHTML) render(); }, 60000);
  setInterval(() => { if (state.user) tickKitchen(); }, 1000);

  auth.onAuthStateChanged((user) => {
    state.user = user; state.outlets = {}; state.rid = ""; state.regMode = false; regReset();
    if (user) { REG.signup = false; REG.creating = false; saveSignupConsent(user); loadOutlets(); } else render();
  });
})();

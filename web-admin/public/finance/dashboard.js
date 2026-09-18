import {requireAdminSession, signOutUser, callFunction, readDatabasePath} from "../assets/firebase-client.js?v=5";

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
function uid() {
  return crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function moneyPaise(paise) {
  const value = Number(paise);
  if (!Number.isFinite(value)) return "₹0";
  // The sign belongs before the currency symbol ("-₹50"), not after it
  // ("₹-50") - only a factor here because platform profit can now go
  // negative in a period where rider rewards outspent commission and fees.
  const sign = value < 0 ? "-" : "";
  return sign + "₹" + (Math.abs(value) / 100).toLocaleString("en-IN", {minimumFractionDigits: 0, maximumFractionDigits: 2});
}
function dateTimeWithYear(t) {
  return t ? new Date(Number(t)).toLocaleString("en-IN", {day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit"}) : "—";
}
function warningIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';
}
function toast(message, kind) {
  const stack = document.getElementById("toast-stack");
  const node = el('<div class="toast ' + (kind || "") + '">' + h(message) + "</div>");
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

// ---------------------------------------------------------------------------
// money input parsing - shared by COD remittance, rider payouts and
// restaurant settlements. Deliberately strict (mirrors the Admin Android
// app's rupeesInputToPaise): rejects malformed decimals rather than rounding
// them, since this is money leaving or entering the ledger.
// ---------------------------------------------------------------------------
function rupeesInputToPaise(value) {
  const text = String(value == null ? "" : value).trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(text)) return null;
  const parts = text.split(".");
  const whole = Number(parts[0]);
  const fraction = Number(String(parts[1] || "").padEnd(2, "0"));
  const amount = whole * 100 + fraction;
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000_000 ? amount : null;
}
function paiseInputValue(paise) {
  return Number.isFinite(Number(paise)) ? String(Math.round(Number(paise)) / 100) : "";
}

// ---------------------------------------------------------------------------
// exact-retry safety net, generalized across all three money-recording
// actions (COD remittance, rider payout, restaurant settlement). Mirrors the
// Admin Android app's COD remittance pattern (the only one of the three the
// app itself hardens this way) and extends the same protection to the other
// two: before sending, persist the exact request to localStorage. If the
// response is lost (timeout, tab closed, network drop), the SAME
// operationId/amount/method/reference must be resubmitted on next load
// rather than a fresh one - the server's operationId-based idempotency then
// either no-ops (already committed) or completes it (never landed). This
// prevents a lost response from turning into either a double-submission or
// an orphaned, silently-abandoned money action.
// ---------------------------------------------------------------------------
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const COD_METHODS = new Set(["cash_deposit", "bank_transfer", "upi"]);
const PAYOUT_METHODS = new Set(["upi", "imps", "neft"]);

function createRetryStore({storageKey, idField, methods, referenceRequired}) {
  function fingerprint(value) {
    return JSON.stringify([String(value && value[idField] || ""), value && value.amountPaise, String(value && value.method || ""), String(value && value.referenceId || "")]);
  }
  function persist(payload, ownerUid) {
    const record = Object.assign({}, payload, {ownerUid, fingerprint: fingerprint(payload), createdAt: Date.now()});
    localStorage.setItem(storageKey, JSON.stringify(record));
  }
  function clear() { try { localStorage.removeItem(storageKey); } catch (_) { /* best effort */ } }
  function validate(raw) {
    let value;
    try { value = JSON.parse(raw); } catch (_) { return null; }
    if (!value || typeof value !== "object") return null;
    const {operationId, ownerUid, amountPaise, method, referenceId, createdAt} = value;
    const entityId = value[idField];
    if (!OPERATION_ID_PATTERN.test(String(operationId || ""))) return null;
    if (!ownerUid || String(ownerUid).length > 128) return null;
    if (!IDENTIFIER_PATTERN.test(String(entityId || ""))) return null;
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > 1_000_000_000) return null;
    if (!methods.has(String(method || ""))) return null;
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
    if (referenceRequired(method) && !referenceId) return null;
    if (referenceId && !REFERENCE_PATTERN.test(String(referenceId))) return null;
    return value;
  }
  function pending() {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const value = validate(raw);
    if (!value) { clear(); return null; }
    return value;
  }
  function ownerMatches(retry, currentUid) { return !!(retry && currentUid && retry.ownerUid === currentUid); }
  return {idField, fingerprint, persist, clear, pending, ownerMatches};
}

const codRetryStore = createRetryStore({
  storageKey: "savrivo.webadmin.codRemittancePending", idField: "riderId", methods: COD_METHODS,
  referenceRequired: (method) => method !== "cash_deposit",
});
const riderPayoutRetryStore = createRetryStore({
  storageKey: "savrivo.webadmin.riderPayoutPending", idField: "riderId", methods: PAYOUT_METHODS,
  referenceRequired: () => true,
});
const settlementRetryStore = createRetryStore({
  storageKey: "savrivo.webadmin.restaurantSettlementPending", idField: "restaurantId", methods: PAYOUT_METHODS,
  referenceRequired: () => true,
});
function createOperationId(prefix, entityId) {
  const safeEntity = String(entityId || "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 40);
  const nonce = uid().replace(/[^A-Za-z0-9]/g, "").slice(0, 44);
  return (prefix + ":" + Date.now().toString(36) + ":" + safeEntity + ":" + nonce).slice(0, 128);
}

// ---------------------------------------------------------------------------
// beneficiary-profile validation - mirrors riderPayoutProfile(Supports) /
// restaurantSettlementProfile(Supports) in the Admin Android app exactly, so
// the same UPI/bank-detail completeness rules gate "Record payout" here too.
// ---------------------------------------------------------------------------
function hasValidUpiId(value) { return /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/.test(String(value || "").trim()); }
function hasValidBankAccountNumber(value) { return /^[0-9]{6,20}$/.test(String(value || "").replace(/\s+/g, "").trim()); }
function hasValidIfsc(value) { return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(value || "").trim().toUpperCase()); }
function payoutMethodValue(value, fallback) { const m = String(value || "").toLowerCase(); return PAYOUT_METHODS.has(m) ? m : (fallback || "neft"); }
function payoutMethodLabel(value) { return value === "upi" ? "UPI" : value === "imps" ? "IMPS" : "NEFT"; }

function riderPayoutProfile(rider) {
  const source = rider && rider.payoutProfile && typeof rider.payoutProfile === "object" && !Array.isArray(rider.payoutProfile) ? rider.payoutProfile : {};
  return {
    beneficiaryName: String(source.beneficiaryName || (rider && rider.fullName) || ""),
    preferredMethod: payoutMethodValue(source.preferredMethod, "upi"),
    upiId: String(source.upiId || ""),
    bankAccountHolderName: String(source.bankAccountHolderName || (rider && rider.fullName) || ""),
    bankAccountNumber: String(source.bankAccountNumber || "").replace(/\s+/g, "").trim(),
    bankIfsc: String(source.bankIfsc || "").trim().toUpperCase(),
    bankName: String(source.bankName || ""),
  };
}
function restaurantSettlementProfile(record) {
  const source = record && record.payoutProfile && typeof record.payoutProfile === "object" && !Array.isArray(record.payoutProfile) ? record.payoutProfile : {};
  return {
    legalBusinessName: String(source.legalBusinessName || (record && record.name) || ""),
    beneficiaryName: String(source.beneficiaryName || (record && record.name) || ""),
    preferredMethod: payoutMethodValue(source.preferredMethod, "neft"),
    upiId: String(source.upiId || ""),
    bankAccountHolderName: String(source.bankAccountHolderName || (record && record.name) || ""),
    bankAccountNumber: String(source.bankAccountNumber || "").replace(/\s+/g, "").trim(),
    bankIfsc: String(source.bankIfsc || "").trim().toUpperCase(),
    bankName: String(source.bankName || ""),
  };
}
function profileSupports(profile, method) {
  return payoutMethodValue(method, "neft") === "upi"
    ? !!(String(profile.beneficiaryName || profile.legalBusinessName || "").trim() && hasValidUpiId(profile.upiId))
    : !!(String(profile.bankAccountHolderName || profile.legalBusinessName || "").trim() && hasValidBankAccountNumber(profile.bankAccountNumber) && hasValidIfsc(profile.bankIfsc));
}
function profileHasReadyRail(profile) {
  return profileSupports(profile, "upi") || profileSupports(profile, "imps") || profileSupports(profile, "neft");
}
function profileStateLabel(profile) {
  const hasAny = !![profile.beneficiaryName, profile.legalBusinessName, profile.upiId, profile.bankAccountNumber, profile.bankIfsc].join("").trim();
  const upiReady = profileSupports(profile, "upi"), bankReady = profileSupports(profile, "neft");
  if (!hasAny) return "Not added";
  if (upiReady && bankReady) return "UPI + Bank ready";
  if (profile.preferredMethod === "upi") return upiReady ? "UPI ready" : "UPI incomplete";
  return bankReady ? "Bank ready" : "Bank incomplete";
}
function enabledPayoutMethods() {
  const payouts = (state.platformConfig && state.platformConfig.finance && state.platformConfig.finance.payouts) || {};
  const methods = [];
  if (payouts.upiEnabled !== false) methods.push("upi");
  if (payouts.impsEnabled !== false) methods.push("imps");
  if (payouts.neftEnabled !== false || !methods.length) methods.push("neft");
  return methods;
}
function recommendedPayoutMethod(amountPaise, preferredMethod) {
  const payouts = (state.platformConfig && state.platformConfig.finance && state.platformConfig.finance.payouts) || {};
  const methods = enabledPayoutMethods();
  const preferred = payoutMethodValue(preferredMethod, methods[0] || "neft");
  const highValueMethod = payoutMethodValue(payouts.highValuePayoutMethod, "neft");
  const high = methods.includes(highValueMethod) ? highValueMethod : (methods.includes("neft") ? "neft" : (methods[0] || "neft"));
  const threshold = Math.max(0, Number(payouts.upiPreferredMaximumPaise || 100000_00));
  if (Number(amountPaise || 0) > threshold) return high;
  if (methods.includes(preferred)) return preferred;
  if (methods.includes("upi")) return "upi";
  return high;
}

// ---------------------------------------------------------------------------
// state + data loading
// ---------------------------------------------------------------------------
const state = {
  dashboard: null, platformConfig: null, currentUid: "", tab: "overview",
  ridersDirectory: null, ridersLoading: false, riderQuery: "", selectedRiderId: "",
  riderFinanceById: {}, riderFinanceLoadingById: {}, riderFinanceErrorById: {},
  restaurantsDirectory: null, restaurantsLoading: false, restaurantQuery: "", selectedRestaurantId: "",
  settlementById: {}, settlementLoadingById: {}, settlementErrorById: {},
  statementPeriodType: "day", statementAnchor: Date.now(), statementLoading: false, statementError: "",
  statementData: null, statementYearRows: null, statementExpandedId: "",
  statementSelYear: null, statementSelMonth: null, statementSelWeekStart: null, statementSelDay: null,
  statementSelYearPage: null,
};

function codExposureByRider(riderId) {
  const rows = (state.dashboard && state.dashboard.codExposure && state.dashboard.codExposure.riders) || [];
  return rows.find((r) => r.riderId === riderId) || null;
}

async function loadDashboard(showSpinner) {
  if (showSpinner) {
    document.getElementById("loading-block").hidden = false;
    document.getElementById("dashboard").hidden = true;
    document.getElementById("load-error").hidden = true;
  }
  try {
    const [dashboard, platformConfig] = await Promise.all([
      callFunction("getAdminDashboard", {activeLimit: 50, recentLimit: 50, ledgerLimit: 250, codLimit: 100}),
      callFunction("getPlatformConfiguration", {}).catch(() => null),
    ]);
    state.dashboard = dashboard;
    state.platformConfig = platformConfig;
    document.getElementById("loading-block").hidden = true;
    document.getElementById("dashboard").hidden = false;
    render();
  } catch (error) {
    document.getElementById("loading-block").hidden = true;
    const box = document.getElementById("load-error");
    box.hidden = false;
    box.textContent = error.message || "Could not load finance data.";
  }
}

async function ensureRidersDirectory() {
  if (state.ridersDirectory || state.ridersLoading) return;
  state.ridersLoading = true;
  renderRiderPayoutsTab();
  try {
    state.ridersDirectory = (await readDatabasePath("feastly/riders")) || {};
  } catch (error) {
    toast("Could not load the rider directory. " + (error.message || ""), "danger");
    state.ridersDirectory = {};
  } finally {
    state.ridersLoading = false;
    renderRiderPayoutsTab();
  }
}
async function ensureRestaurantsDirectory() {
  if (state.restaurantsDirectory || state.restaurantsLoading) return;
  state.restaurantsLoading = true;
  renderRestaurantSettlementsTab();
  try {
    state.restaurantsDirectory = (await readDatabasePath("feastly/catalog/restaurants")) || {};
  } catch (error) {
    toast("Could not load the restaurant directory. " + (error.message || ""), "danger");
    state.restaurantsDirectory = {};
  } finally {
    state.restaurantsLoading = false;
    renderRestaurantSettlementsTab();
  }
}

async function loadRiderFinance(riderId, force) {
  const id = String(riderId || "").trim();
  if (!id || state.riderFinanceLoadingById[id]) return;
  const current = state.riderFinanceById[id];
  if (!force && current && Date.now() - Number(current.generatedAt || 0) < 60000) return;
  state.riderFinanceLoadingById[id] = true;
  state.riderFinanceErrorById[id] = "";
  if (state.selectedRiderId === id) renderRiderPayoutsTab();
  try {
    state.riderFinanceById[id] = await callFunction("getRiderFinancialSummary", {riderId: id, ledgerLimit: 250, historyLimit: 20});
    state.riderFinanceErrorById[id] = "";
  } catch (error) {
    state.riderFinanceErrorById[id] = error.message || "Could not load this rider's balance.";
  } finally {
    delete state.riderFinanceLoadingById[id];
    if (state.selectedRiderId === id) renderRiderPayoutsTab();
  }
}
async function loadSettlementSummary(restaurantId, force) {
  const id = String(restaurantId || "").trim();
  if (!id || state.settlementLoadingById[id]) return;
  const current = state.settlementById[id];
  if (!force && current && Date.now() - Number(current.newestOccurredAt || 0) < 60000) return;
  state.settlementLoadingById[id] = true;
  state.settlementErrorById[id] = "";
  if (state.selectedRestaurantId === id) renderRestaurantSettlementsTab();
  try {
    state.settlementById[id] = await callFunction("getRestaurantSettlementSummary", {restaurantId: id, ledgerLimit: 1000, historyLimit: 20});
    state.settlementErrorById[id] = "";
  } catch (error) {
    state.settlementErrorById[id] = error.message || "Could not load this restaurant's balance.";
  } finally {
    delete state.settlementLoadingById[id];
    if (state.selectedRestaurantId === id) renderRestaurantSettlementsTab();
  }
}

// ---------------------------------------------------------------------------
// rendering: tabs shell
// ---------------------------------------------------------------------------
function render() {
  renderTabs();
  if (state.tab === "overview") renderOverviewTab();
  else if (state.tab === "riderPayouts") renderRiderPayoutsTab();
  else if (state.tab === "restaurantSettlements") renderRestaurantSettlementsTab();
  else if (state.tab === "bankPayouts") renderBankPayoutsTab();
  else if (state.tab === "statement") { renderStatementTab(); loadStatement(); }
}
function renderTabs() {
  const tabs = [["overview", "Overview"], ["riderPayouts", "Rider payouts"], ["restaurantSettlements", "Restaurant settlements"], ["bankPayouts", "Bank & payouts"], ["statement", "Statement"]];
  document.getElementById("tabs").innerHTML = tabs.map(([key, label]) => (
    '<div class="tab' + (state.tab === key ? " active" : "") + '" data-tab="' + key + '">' + h(label) + "</div>"
  )).join("");
  document.getElementById("panel-statement").hidden = state.tab !== "statement";
  document.getElementById("panel-overview").hidden = state.tab !== "overview";
  document.getElementById("panel-riderPayouts").hidden = state.tab !== "riderPayouts";
  document.getElementById("panel-restaurantSettlements").hidden = state.tab !== "restaurantSettlements";
  document.getElementById("panel-bankPayouts").hidden = state.tab !== "bankPayouts";
  if (state.tab === "riderPayouts") ensureRidersDirectory();
  if (state.tab === "restaurantSettlements") ensureRestaurantsDirectory();
  if (state.tab === "bankPayouts") renderBankPayoutsTab();
}

// ---------------------------------------------------------------------------
// rendering: overview (ledger summary + COD exposure + remittance)
// ---------------------------------------------------------------------------
function renderOverviewTab() {
  const finance = state.dashboard.finance || {};
  const cod = state.dashboard.codExposure || {};
  const totalOutstanding = (cod.riders || []).reduce((sum, r) => sum + Number(r.codOutstandingPaise || 0), 0);
  const blockedCount = (cod.riders || []).filter((r) => r.codBlocked).length;
  document.getElementById("stat-grid").innerHTML = [
    ["Ledger journals (window)", finance.journalCount ?? 0, finance.invalidJournalCount ? finance.invalidJournalCount + " invalid — flagged below" : "All valid"],
    ["Riders holding COD", cod.riderCount ?? 0, blockedCount ? blockedCount + " over their limit" : "None over limit"],
    ["Total COD outstanding", moneyPaise(totalOutstanding), "Across " + (cod.riderCount ?? 0) + " rider(s)"],
  ].map(([label, value, sub]) => (
    '<div class="stat-card"><div class="label">' + h(label) + '</div><div class="value">' + h(value) + '</div><div class="sub">' + h(sub) + "</div></div>"
  )).join("");

  const eventCounts = finance.eventCounts || {};
  const netMovement = finance.windowNetMovementPaise || {};
  const eventRows = Object.keys(eventCounts).sort((a, b) => eventCounts[b] - eventCounts[a]);
  const accountRows = Object.keys(netMovement).sort((a, b) => Math.abs(netMovement[b]) - Math.abs(netMovement[a]));
  const notice = !finance.complete
    ? '<div class="notice notice-warning">' + warningIcon() + '<span>This window is bounded — older journals exist outside it. This is a read-only recent slice, not the full ledger.</span></div>' : "";
  const invalidNotice = finance.invalidJournalCount
    ? '<div class="notice notice-danger">' + warningIcon() + '<span>' + finance.invalidJournalCount + ' journal(s) in this window failed validation and were excluded from the totals below.</span></div>' : "";
  document.getElementById("ledger-summary").innerHTML = notice + invalidNotice
    + '<div class="form-grid"><div class="field"><label>Window</label><div>' + h(dateTimeWithYear(finance.oldestOccurredAt)) + ' &rarr; ' + h(dateTimeWithYear(finance.newestOccurredAt)) + '</div></div>'
    + '<div class="field"><label>Scope</label><div>' + h(finance.scope || "—") + '</div></div></div>'
    + (eventRows.length ? '<div class="section-title" style="margin-top:6px;">Event types in this window</div>' + eventRows.map((k) => '<div class="price-row"><span>' + h(k) + '</span><strong>' + h(eventCounts[k]) + '</strong></div>').join("") : "")
    + (accountRows.length ? '<div class="section-title">Net movement by account (window)</div>' + accountRows.map((k) => '<div class="price-row"><span>' + h(k) + '</span><strong class="' + (netMovement[k] < 0 ? "danger-text" : "") + '">' + h(moneyPaise(netMovement[k])) + '</strong></div>').join("") : "");

  const retryBanner = document.getElementById("retry-banner");
  const retry = codRetryStore.pending();
  if (!retry) { retryBanner.hidden = true; retryBanner.innerHTML = ""; }
  else {
    const owned = codRetryStore.ownerMatches(retry, state.currentUid);
    retryBanner.hidden = false;
    retryBanner.innerHTML = '<div class="notice notice-warning" style="margin-bottom:20px;">' + warningIcon()
      + '<span><strong>Unconfirmed remittance retained.</strong> Operation ' + h(retry.operationId) + ' for rider ' + h(retry.riderId) + ' is preserved on this device. '
      + (owned ? 'Resume with the exact same amount and details.' : 'Sign back in with the account that started it to resume safely.') + '</span>'
      + (owned ? '<button class="btn btn-secondary btn-sm" id="resume-cod-retry-btn" style="margin-left:auto; flex:none;">Resume</button>' : "") + '</div>';
    if (owned) document.getElementById("resume-cod-retry-btn").addEventListener("click", () => openCodDrawer(retry.riderId));
  }

  const rows = cod.riders || [];
  document.getElementById("cod-scope-badge").textContent = rows.length + " displayed" + (cod.complete ? "" : " (bounded)");
  document.getElementById("cod-empty").hidden = rows.length > 0;
  const owned = codRetryStore.ownerMatches(retry, state.currentUid);
  document.getElementById("cod-rows").innerHTML = rows.map((row) => {
    const limit = row.codOutstandingLimitPaise > 0 ? moneyPaise(row.codOutstandingLimitPaise) : "Not configured";
    const sameRetry = owned && retry.riderId === row.riderId;
    const blockedByRetry = retry && (!owned || retry.riderId !== row.riderId);
    let action;
    if (sameRetry) action = '<button class="btn btn-primary btn-sm" data-action="resume-cod" data-rider-id="' + h(row.riderId) + '">Resume</button>';
    else if (blockedByRetry) action = '<button class="btn btn-secondary btn-sm" type="button" disabled>Resolve pending first</button>';
    else if (row.availableToRemitPaise > 0) action = '<button class="btn btn-primary btn-sm" data-action="record-cod" data-rider-id="' + h(row.riderId) + '">Record remittance</button>';
    else action = '<span style="color:var(--text-faint); font-size:12px;">Nothing available</span>';
    return '<tr><td><div class="cell-title">' + h(row.riderId) + '</div></td>'
      + '<td>' + h(moneyPaise(row.codOutstandingPaise)) + '</td><td>' + h(moneyPaise(row.codRemittanceReservedPaise)) + '</td>'
      + '<td>' + h(moneyPaise(row.availableToRemitPaise)) + '</td><td>' + h(limit) + '</td>'
      + '<td>' + (row.codBlocked ? '<span class="badge badge-danger">Over limit</span>' : '<span class="badge badge-warning">Outstanding</span>') + '</td>'
      + '<td style="text-align:right;">' + action + '</td></tr>';
  }).join("");
}

// ---------------------------------------------------------------------------
// rendering: rider payouts tab
// ---------------------------------------------------------------------------
function riderDisplayName(riderId) {
  const r = (state.ridersDirectory || {})[riderId] || {};
  return r.fullName || r.name || riderId;
}
function matchingRiderIds(query) {
  const directory = state.ridersDirectory || {};
  const q = query.trim().toLowerCase();
  const ids = Object.keys(directory);
  const filtered = q ? ids.filter((id) => {
    const r = directory[id] || {};
    return [id, r.fullName, r.name, r.phone, r.email, r.city].filter(Boolean).join(" ").toLowerCase().includes(q);
  }) : ids;
  return filtered.slice(0, 30);
}

function renderRiderPayoutsTab() {
  const box = document.getElementById("panel-riderPayouts");
  if (box.hidden) return;
  const searchBox = document.getElementById("rider-search-results");
  if (state.ridersLoading && !state.ridersDirectory) {
    searchBox.innerHTML = '<div class="loading-block"><span class="spinner dark"></span> Loading rider directory…</div>';
  } else {
    const ids = matchingRiderIds(state.riderQuery);
    searchBox.innerHTML = ids.length ? ids.map((id) => (
      '<div class="table-wrap" style="margin-bottom:6px;"><div class="row-clickable" data-select-rider="' + h(id) + '" style="padding:10px 14px; cursor:pointer;'
      + (state.selectedRiderId === id ? " background:var(--brand-soft);" : "") + '"><strong>' + h(riderDisplayName(id)) + '</strong>'
      + '<span class="cell-sub" style="margin-left:8px;">' + h(id) + '</span></div></div>'
    )).join("") : '<p class="hint">No rider matches this search.</p>';
  }

  const detail = document.getElementById("rider-detail");
  const id = state.selectedRiderId;
  if (!id) { detail.innerHTML = '<div class="empty-state"><p>Search and select a rider to view their authoritative payable balance.</p></div>'; return; }
  if (!state.riderFinanceById[id] && !state.riderFinanceLoadingById[id]) loadRiderFinance(id, false);
  const summary = state.riderFinanceById[id];
  const loading = !!state.riderFinanceLoadingById[id];
  const error = state.riderFinanceErrorById[id];
  const rider = (state.ridersDirectory || {})[id] || {};
  const profile = riderPayoutProfile(rider);

  if (loading && !summary) { detail.innerHTML = '<div class="loading-block"><span class="spinner dark"></span> Loading authoritative balance…</div>'; return; }
  if (error && !summary) {
    detail.innerHTML = '<div class="notice notice-danger">' + warningIcon() + '<span>' + h(error) + '</span></div><button class="btn btn-secondary btn-sm" id="retry-rider-finance">Retry</button>';
    document.getElementById("retry-rider-finance").addEventListener("click", () => loadRiderFinance(id, true));
    return;
  }
  if (!summary) { detail.innerHTML = ""; return; }

  const retry = riderPayoutRetryStore.pending();
  const owned = riderPayoutRetryStore.ownerMatches(retry, state.currentUid);
  const blockedByRetry = retry && (!owned || retry.riderId !== id);
  const sameRetry = owned && retry && retry.riderId === id;
  const payable = summary.payableEarningsPaise;
  const releasedWindow = Number(summary.window.earningsSettledOrAdjustedPaise || 0) + Number(summary.window.tipsSettledOrAdjustedPaise || 0);
  const recommended = recommendedPayoutMethod(payable || 0, profile.preferredMethod);
  const hasRail = profileHasReadyRail(profile);
  const canRecord = summary.complete && Number.isSafeInteger(payable) && payable > 0 && hasRail && !blockedByRetry;

  detail.innerHTML = '<div class="cluster between" style="align-items:flex-start;"><h2 style="font-size:15px;">' + h(riderDisplayName(id)) + '</h2>'
    + '<span class="badge ' + (summary.complete ? "badge-success" : "badge-warning") + '">' + (summary.complete ? "Authoritative" : "Review needed") + '</span></div>'
    + '<div class="form-grid" style="margin-top:10px;">'
    + statTile("Payable now", payable == null ? "Reconciliation required" : moneyPaise(payable))
    + statTile("Suggested rail", payoutMethodLabel(recommended))
    + statTile("COD outstanding", moneyPaise(summary.cod.outstandingPaise))
    + statTile("Released in window", moneyPaise(releasedWindow))
    + statTile("Completed deliveries", String(summary.window.completedDeliveryCount || 0))
    + statTile("Payout destination", profileStateLabel(profile))
    + '</div>'
    + (payable == null ? '<div class="notice notice-warning">' + warningIcon() + '<span>The server is withholding an authoritative payable until ledger coverage and reconciliation are fully verified.</span></div>' : "")
    + (!hasRail ? '<div class="notice notice-warning">' + warningIcon() + '<span>This rider has no valid UPI ID or verified bank details on file yet — ask them to add one in the Rider app before releasing funds.</span></div>' : "")
    + (blockedByRetry ? '<div class="notice notice-warning">' + warningIcon() + '<span>Resolve the pending payout for a different rider first.</span></div>' : "")
    + '<p class="hint" style="margin:10px 0;">Scope: ' + h(String(summary.scope || "").replace(/_/g, " ")) + ' · Reconciliation: ' + h(String(summary.reconciliationStatus || "").replace(/_/g, " ")) + '</p>'
    + '<div class="cluster wrap"><button class="btn btn-secondary btn-sm" id="refresh-rider-finance">Refresh</button>'
    + '<button class="btn btn-primary btn-sm" id="record-rider-payout"' + (canRecord || sameRetry ? "" : " disabled") + '>' + (sameRetry ? "Resume payout" : "Record payout") + '</button></div>';

  document.getElementById("refresh-rider-finance").addEventListener("click", () => loadRiderFinance(id, true));
  const recordBtn = document.getElementById("record-rider-payout");
  if (recordBtn && !recordBtn.disabled) recordBtn.addEventListener("click", () => openRiderPayoutDrawer(id));
}
function statTile(label, value) {
  return '<div class="notice notice-info"><strong>' + h(label) + '</strong><div style="margin-top:6px;">' + h(value) + '</div></div>';
}

// ---------------------------------------------------------------------------
// rendering: restaurant settlements tab
// ---------------------------------------------------------------------------
function restaurantDisplayName(restaurantId) {
  const r = (state.restaurantsDirectory || {})[restaurantId] || {};
  return r.name || restaurantId;
}
function matchingRestaurantIds(query) {
  const directory = state.restaurantsDirectory || {};
  const q = query.trim().toLowerCase();
  const ids = Object.keys(directory);
  const filtered = q ? ids.filter((id) => {
    const r = directory[id] || {};
    return [id, r.name, r.city, r.address].filter(Boolean).join(" ").toLowerCase().includes(q);
  }) : ids;
  return filtered.slice(0, 30);
}

function renderRestaurantSettlementsTab() {
  const box = document.getElementById("panel-restaurantSettlements");
  if (box.hidden) return;
  const searchBox = document.getElementById("restaurant-search-results");
  if (state.restaurantsLoading && !state.restaurantsDirectory) {
    searchBox.innerHTML = '<div class="loading-block"><span class="spinner dark"></span> Loading restaurant directory…</div>';
  } else {
    const ids = matchingRestaurantIds(state.restaurantQuery);
    searchBox.innerHTML = ids.length ? ids.map((id) => (
      '<div class="table-wrap" style="margin-bottom:6px;"><div class="row-clickable" data-select-restaurant="' + h(id) + '" style="padding:10px 14px; cursor:pointer;'
      + (state.selectedRestaurantId === id ? " background:var(--brand-soft);" : "") + '"><strong>' + h(restaurantDisplayName(id)) + '</strong>'
      + '<span class="cell-sub" style="margin-left:8px;">' + h(id) + '</span></div></div>'
    )).join("") : '<p class="hint">No restaurant matches this search.</p>';
  }

  const detail = document.getElementById("restaurant-detail");
  const id = state.selectedRestaurantId;
  if (!id) { detail.innerHTML = '<div class="empty-state"><p>Search and select a restaurant to view their authoritative pending settlement.</p></div>'; return; }
  if (!state.settlementById[id] && !state.settlementLoadingById[id]) loadSettlementSummary(id, false);
  const summary = state.settlementById[id];
  const loading = !!state.settlementLoadingById[id];
  const error = state.settlementErrorById[id];
  const record = (state.restaurantsDirectory || {})[id] || {};
  const profile = restaurantSettlementProfile(record);

  if (loading && !summary) { detail.innerHTML = '<div class="loading-block"><span class="spinner dark"></span> Loading authoritative balance…</div>'; return; }
  if (error && !summary) {
    detail.innerHTML = '<div class="notice notice-danger">' + warningIcon() + '<span>' + h(error) + '</span></div><button class="btn btn-secondary btn-sm" id="retry-settlement">Retry</button>';
    document.getElementById("retry-settlement").addEventListener("click", () => loadSettlementSummary(id, true));
    return;
  }
  if (!summary) { detail.innerHTML = ""; return; }

  const retry = settlementRetryStore.pending();
  const owned = settlementRetryStore.ownerMatches(retry, state.currentUid);
  const blockedByRetry = retry && (!owned || retry.restaurantId !== id);
  const sameRetry = owned && retry && retry.restaurantId === id;
  const pending = summary.pendingSettlementPaise;
  const recommended = recommendedPayoutMethod(pending || 0, profile.preferredMethod);
  const hasRail = profileHasReadyRail(profile);
  const canRecord = summary.complete && Number.isSafeInteger(pending) && pending > 0 && hasRail && !blockedByRetry;

  detail.innerHTML = '<div class="cluster between" style="align-items:flex-start;"><h2 style="font-size:15px;">' + h(restaurantDisplayName(id)) + '</h2>'
    + '<span class="badge ' + (summary.complete ? "badge-success" : "badge-warning") + '">' + (summary.complete ? "Authoritative" : "Review needed") + '</span></div>'
    + '<div class="form-grid" style="margin-top:10px;">'
    + statTile("Pending settlement", pending == null ? "Reconciliation required" : moneyPaise(pending))
    + statTile("Suggested rail", payoutMethodLabel(recommended))
    + statTile("Already settled", moneyPaise(summary.alreadySettledPaise))
    + statTile("Destination profile", profileStateLabel(profile))
    + statTile("Completed orders", String(summary.completedOrderCount || 0))
    + statTile("Refund recovery pending", moneyPaise(summary.refundRecoveryPendingAllocationPaise))
    + '</div>'
    + (pending == null ? '<div class="notice notice-warning">' + warningIcon() + '<span>The server is withholding an authoritative pending settlement until full ledger coverage and integrity checks are complete.</span></div>' : "")
    + (!hasRail ? '<div class="notice notice-warning">' + warningIcon() + '<span>This restaurant has no valid UPI ID or verified bank details on file yet — add one in the Restaurant app before releasing settlement funds.</span></div>' : "")
    + (blockedByRetry ? '<div class="notice notice-warning">' + warningIcon() + '<span>Resolve the pending settlement for a different restaurant first.</span></div>' : "")
    + '<p class="hint" style="margin:10px 0;">Scope: ' + h(String(summary.scope || "").replace(/_/g, " ")) + ' · Included journals: ' + h(summary.includedJournalCount || 0) + '</p>'
    + '<div class="cluster wrap"><button class="btn btn-secondary btn-sm" id="refresh-settlement">Refresh</button>'
    + '<button class="btn btn-primary btn-sm" id="record-settlement"' + (canRecord || sameRetry ? "" : " disabled") + '>' + (sameRetry ? "Resume settlement" : "Record settlement") + '</button></div>';

  document.getElementById("refresh-settlement").addEventListener("click", () => loadSettlementSummary(id, true));
  const recordBtn = document.getElementById("record-settlement");
  if (recordBtn && !recordBtn.disabled) recordBtn.addEventListener("click", () => openSettlementDrawer(id));
}

// ---------------------------------------------------------------------------
// generic money-action drawer (shared markup, three call sites below)
// ---------------------------------------------------------------------------
function openMoneyDrawer(config) {
  const {title, entityLabel, retryStore, resuming, retry, amount, method, referenceId, methodOptionsHtml, rowSummaryHtml, closeCb} = config;
  const root = document.getElementById("drawer-root");
  root.innerHTML = "";
  const overlay = el('<div class="overlay"></div>');
  const drawer = el(`
    <div class="drawer" style="width:min(480px,100vw);">
      <div class="drawer-head">
        <h2 style="font-size:16px;">${h(title)}</h2>
        <button class="icon-btn" id="drawer-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="drawer-body">
        <p style="font-size:13px; color:var(--text-soft); margin-bottom:14px;">${entityLabel}</p>
        <div class="notice notice-warning">${warningIcon()}<span>Record only funds already verified as sent/received. The server writes the immutable ledger — this panel never changes a balance directly.</span></div>
        ${resuming ? '<div class="notice notice-warning">' + warningIcon() + '<span><strong>Exact retry mode.</strong> Amount, method and reference must stay unchanged.</span></div>' : ""}
        ${rowSummaryHtml}
        <form id="money-form">
          <div class="field"><label>Amount (₹)</label><input class="input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${h(amount)}" required></div>
          <div class="field"><label>Method</label><select class="select" name="method" required>${methodOptionsHtml}</select></div>
          <div class="field"><label>Reference</label><input class="input" name="referenceId" maxlength="120" autocomplete="off" placeholder="Bank/UPI reference" value="${h(referenceId)}"></div>
          <div class="notice notice-danger" id="money-error" hidden></div>
        </form>
      </div>
      <div class="drawer-foot">
        <button class="btn btn-secondary" id="drawer-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="drawer-save" type="submit" form="money-form">${resuming ? "Retry exact action" : "Record"}</button>
      </div>
    </div>`);
  overlay.appendChild(drawer);
  root.appendChild(overlay);
  function close() { root.innerHTML = ""; }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  drawer.querySelector("#drawer-close").addEventListener("click", close);
  drawer.querySelector("#drawer-cancel").addEventListener("click", close);
  drawer.querySelector("#money-form").addEventListener("submit", (event) => {
    event.preventDefault();
    config.onSubmit(event.target, close);
  });
  return {close};
}

function methodOptions(selected, allowedMethods, isCod) {
  const list = isCod ? [["cash_deposit", "Cash deposit"], ["bank_transfer", "Bank transfer"], ["upi", "UPI"]]
    : allowedMethods.map((m) => [m, payoutMethodLabel(m)]);
  return list.map(([v, label]) => '<option value="' + v + '"' + (v === selected ? " selected" : "") + '>' + h(label) + "</option>").join("");
}

// -- COD remittance --
function openCodDrawer(riderId) {
  const retry = codRetryStore.pending();
  const owned = codRetryStore.ownerMatches(retry, state.currentUid);
  const resuming = !!(retry && retry.riderId === riderId && owned);
  if (retry && !owned) { toast("Sign back in with the account that started the pending remittance.", "danger"); return; }
  if (retry && !resuming) { toast("Resolve the pending remittance for rider " + retry.riderId + " first.", "danger"); return; }
  const row = codExposureByRider(riderId);
  if (!row && !resuming) { toast("This rider's COD projection changed. Refresh and try again.", "danger"); return; }
  const operationId = resuming ? retry.operationId : createOperationId("cod-remit-web", riderId);
  const rowSummaryHtml = row ? '<div class="form-grid"><div class="field"><label>Outstanding</label><div>' + h(moneyPaise(row.codOutstandingPaise)) + '</div></div><div class="field"><label>Available now</label><div>' + h(moneyPaise(row.availableToRemitPaise)) + '</div></div></div>' : "";
  const {close} = openMoneyDrawer({
    title: "Record verified COD remittance", entityLabel: "Rider " + riderId, retryStore: codRetryStore, resuming, retry,
    amount: resuming ? paiseInputValue(retry.amountPaise) : "", method: resuming ? retry.method : "cash_deposit", referenceId: resuming ? (retry.referenceId || "") : "",
    methodOptionsHtml: methodOptions(resuming ? retry.method : "cash_deposit", null, true), rowSummaryHtml,
    onSubmit: (form, closeDrawer) => submitCodRemittance(form, riderId, operationId, row, closeDrawer),
  });
}
async function submitCodRemittance(form, riderId, operationId, row, closeDrawer) {
  const errorBox = form.querySelector("#money-error");
  errorBox.hidden = true;
  const fail = (m) => { errorBox.hidden = false; errorBox.textContent = m; };
  const amountPaise = rupeesInputToPaise(form.elements.amount.value);
  const method = String(form.elements.method.value || "");
  const referenceId = String(form.elements.referenceId.value || "").trim();
  if (!OPERATION_ID_PATTERN.test(operationId) || !IDENTIFIER_PATTERN.test(riderId)) { fail("This operation is invalid. Close and reopen."); return; }
  if (amountPaise === null) { fail("Enter a positive amount with no more than two decimal places."); return; }
  if (!COD_METHODS.has(method)) { fail("Choose a supported remittance method."); return; }
  if ((method !== "cash_deposit" && !referenceId) || (referenceId && !REFERENCE_PATTERN.test(referenceId))) {
    fail(method === "cash_deposit" ? "Enter a valid reference or leave it blank." : "Enter the verified bank or UPI reference."); return;
  }
  const candidate = {riderId, amountPaise, method}; if (referenceId) candidate.referenceId = referenceId;
  const existing = codRetryStore.pending();
  let payload;
  if (existing) {
    if (!codRetryStore.ownerMatches(existing, state.currentUid)) { fail("Sign in with the account that started this pending remittance."); return; }
    if (existing.operationId !== operationId || existing.riderId !== riderId || existing.fingerprint !== codRetryStore.fingerprint(candidate)) {
      fail("A remittance response is still unconfirmed. Retry the exact same rider, amount, method and reference."); return;
    }
    payload = {operationId: existing.operationId, riderId: existing.riderId, amountPaise: existing.amountPaise, method: existing.method};
    if (existing.referenceId) payload.referenceId = existing.referenceId;
  } else {
    if (!row) { fail("This COD projection changed. Close, refresh, and reopen."); return; }
    if (amountPaise > row.availableToRemitPaise) { fail("The amount exceeds the server-projected COD available to remit."); return; }
    payload = {operationId, riderId, amountPaise, method}; if (referenceId) payload.referenceId = referenceId;
    try { codRetryStore.persist(payload, state.currentUid); } catch (_) { fail("The exact retry request could not be secured on this device. Nothing was sent."); return; }
  }
  await submitMoneyAction({
    payload, closeDrawer, retryStore: codRetryStore, form,
    call: () => callFunction("recordCodRemittance", payload),
    onSuccess: (result) => { toast((result.idempotent ? "Verified existing remittance. " : "Remittance recorded. ") + "Remaining COD: " + moneyPaise(result.remainingOutstandingPaise) + ".", "success"); loadDashboard(false); },
  });
}

// -- rider payout --
function openRiderPayoutDrawer(riderId) {
  const retry = riderPayoutRetryStore.pending();
  const owned = riderPayoutRetryStore.ownerMatches(retry, state.currentUid);
  const resuming = !!(retry && retry.riderId === riderId && owned);
  if (retry && !owned) { toast("Sign back in with the account that started the pending payout.", "danger"); return; }
  if (retry && !resuming) { toast("Resolve the pending payout for rider " + retry.riderId + " first.", "danger"); return; }
  const summary = state.riderFinanceById[riderId];
  const rider = (state.ridersDirectory || {})[riderId] || {};
  const profile = riderPayoutProfile(rider);
  const operationId = resuming ? retry.operationId : createOperationId("rider-payout-web", riderId);
  const recommended = recommendedPayoutMethod(summary && summary.payableEarningsPaise || 0, profile.preferredMethod);
  const rowSummaryHtml = summary ? '<div class="form-grid"><div class="field"><label>Payable now</label><div>' + h(moneyPaise(summary.payableEarningsPaise)) + '</div></div></div>' : "";
  openMoneyDrawer({
    title: "Record rider payout", entityLabel: riderDisplayName(riderId) + " (" + riderId + ")", retryStore: riderPayoutRetryStore, resuming, retry,
    amount: resuming ? paiseInputValue(retry.amountPaise) : "", method: resuming ? retry.method : recommended, referenceId: resuming ? (retry.referenceId || "") : "",
    methodOptionsHtml: methodOptions(resuming ? retry.method : recommended, enabledPayoutMethods(), false), rowSummaryHtml,
    onSubmit: (form, closeDrawer) => submitRiderPayout(form, riderId, operationId, summary, profile, closeDrawer),
  });
}
async function submitRiderPayout(form, riderId, operationId, summary, profile, closeDrawer) {
  const errorBox = form.querySelector("#money-error");
  errorBox.hidden = true;
  const fail = (m) => { errorBox.hidden = false; errorBox.textContent = m; };
  const amountPaise = rupeesInputToPaise(form.elements.amount.value);
  const method = String(form.elements.method.value || "");
  const referenceId = String(form.elements.referenceId.value || "").trim();
  if (!OPERATION_ID_PATTERN.test(operationId) || !IDENTIFIER_PATTERN.test(riderId)) { fail("This operation is invalid. Close and reopen."); return; }
  if (!summary || summary.payableEarningsPaise == null || summary.complete !== true) { fail("Refresh the authoritative rider balance before recording a payout."); return; }
  if (amountPaise === null) { fail("Enter a valid payout amount."); return; }
  if (amountPaise > summary.payableEarningsPaise) { fail("The amount exceeds the rider's authoritative payable balance."); return; }
  if (!enabledPayoutMethods().includes(method)) { fail("That payout rail is currently disabled in secure money controls."); return; }
  if (!profileSupports(profile, method)) { fail(method === "upi" ? "The rider payout profile is missing a valid UPI ID." : "The rider payout profile is missing verified bank details."); return; }
  if (!referenceId || !REFERENCE_PATTERN.test(referenceId)) { fail("Enter a valid payout reference."); return; }
  const candidate = {riderId, amountPaise, method, referenceId};
  const existing = riderPayoutRetryStore.pending();
  let payload;
  if (existing) {
    if (!riderPayoutRetryStore.ownerMatches(existing, state.currentUid)) { fail("Sign in with the account that started this pending payout."); return; }
    if (existing.operationId !== operationId || existing.riderId !== riderId || existing.fingerprint !== riderPayoutRetryStore.fingerprint(candidate)) {
      fail("A payout response is still unconfirmed. Retry the exact same rider, amount, method and reference."); return;
    }
    payload = {operationId: existing.operationId, riderId: existing.riderId, amountPaise: existing.amountPaise, method: existing.method, referenceId: existing.referenceId};
  } else {
    payload = {operationId, riderId, amountPaise, method, referenceId};
    try { riderPayoutRetryStore.persist(payload, state.currentUid); } catch (_) { fail("The exact retry request could not be secured on this device. Nothing was sent."); return; }
  }
  await submitMoneyAction({
    payload, closeDrawer, retryStore: riderPayoutRetryStore, form,
    call: () => callFunction("recordRiderPayout", payload),
    onSuccess: (result) => {
      toast((result.idempotent ? "Verified existing payout. " : "Payout recorded. ") + riderDisplayName(riderId) + " remaining payable: " + moneyPaise(result.remainingPayablePaise) + ".", "success");
      loadRiderFinance(riderId, true);
    },
  });
}

// -- restaurant settlement --
function openSettlementDrawer(restaurantId) {
  const retry = settlementRetryStore.pending();
  const owned = settlementRetryStore.ownerMatches(retry, state.currentUid);
  const resuming = !!(retry && retry.restaurantId === restaurantId && owned);
  if (retry && !owned) { toast("Sign back in with the account that started the pending settlement.", "danger"); return; }
  if (retry && !resuming) { toast("Resolve the pending settlement for restaurant " + retry.restaurantId + " first.", "danger"); return; }
  const summary = state.settlementById[restaurantId];
  const record = (state.restaurantsDirectory || {})[restaurantId] || {};
  const profile = restaurantSettlementProfile(record);
  const operationId = resuming ? retry.operationId : createOperationId("restaurant-settle-web", restaurantId);
  const recommended = recommendedPayoutMethod(summary && summary.pendingSettlementPaise || 0, profile.preferredMethod);
  const rowSummaryHtml = summary ? '<div class="form-grid"><div class="field"><label>Pending settlement</label><div>' + h(moneyPaise(summary.pendingSettlementPaise)) + '</div></div></div>' : "";
  openMoneyDrawer({
    title: "Record restaurant settlement", entityLabel: restaurantDisplayName(restaurantId) + " (" + restaurantId + ")", retryStore: settlementRetryStore, resuming, retry,
    amount: resuming ? paiseInputValue(retry.amountPaise) : "", method: resuming ? retry.method : recommended, referenceId: resuming ? (retry.referenceId || "") : "",
    methodOptionsHtml: methodOptions(resuming ? retry.method : recommended, enabledPayoutMethods(), false), rowSummaryHtml,
    onSubmit: (form, closeDrawer) => submitSettlement(form, restaurantId, operationId, summary, profile, closeDrawer),
  });
}
async function submitSettlement(form, restaurantId, operationId, summary, profile, closeDrawer) {
  const errorBox = form.querySelector("#money-error");
  errorBox.hidden = true;
  const fail = (m) => { errorBox.hidden = false; errorBox.textContent = m; };
  const amountPaise = rupeesInputToPaise(form.elements.amount.value);
  const method = String(form.elements.method.value || "");
  const referenceId = String(form.elements.referenceId.value || "").trim();
  if (!OPERATION_ID_PATTERN.test(operationId) || !IDENTIFIER_PATTERN.test(restaurantId)) { fail("This operation is invalid. Close and reopen."); return; }
  if (!summary || summary.pendingSettlementPaise == null || summary.complete !== true) { fail("Refresh the authoritative restaurant payable before recording settlement."); return; }
  if (amountPaise === null) { fail("Enter a valid settlement amount."); return; }
  if (amountPaise > summary.pendingSettlementPaise) { fail("The amount exceeds the restaurant's authoritative pending settlement balance."); return; }
  if (!enabledPayoutMethods().includes(method)) { fail("That settlement rail is currently disabled in secure money controls."); return; }
  if (!profileSupports(profile, method)) { fail(method === "upi" ? "The restaurant payout profile is missing a valid UPI ID." : "The restaurant payout profile is missing verified bank details."); return; }
  if (!referenceId || !REFERENCE_PATTERN.test(referenceId)) { fail("Enter a valid settlement reference."); return; }
  const candidate = {restaurantId, amountPaise, method, referenceId};
  const existing = settlementRetryStore.pending();
  let payload;
  if (existing) {
    if (!settlementRetryStore.ownerMatches(existing, state.currentUid)) { fail("Sign in with the account that started this pending settlement."); return; }
    if (existing.operationId !== operationId || existing.restaurantId !== restaurantId || existing.fingerprint !== settlementRetryStore.fingerprint(candidate)) {
      fail("A settlement response is still unconfirmed. Retry the exact same restaurant, amount, method and reference."); return;
    }
    payload = {operationId: existing.operationId, restaurantId: existing.restaurantId, amountPaise: existing.amountPaise, method: existing.method, referenceId: existing.referenceId};
  } else {
    payload = {operationId, restaurantId, amountPaise, method, referenceId};
    try { settlementRetryStore.persist(payload, state.currentUid); } catch (_) { fail("The exact retry request could not be secured on this device. Nothing was sent."); return; }
  }
  await submitMoneyAction({
    payload, closeDrawer, retryStore: settlementRetryStore, form,
    call: () => callFunction("recordRestaurantSettlement", payload),
    onSuccess: (result) => {
      toast((result.idempotent ? "Verified existing settlement. " : "Settlement recorded. ") + restaurantDisplayName(restaurantId) + " remaining pending: " + moneyPaise(result.remainingPendingSettlementPaise) + ".", "success");
      loadSettlementSummary(restaurantId, true);
    },
  });
}

// -- shared submit plumbing --
async function submitMoneyAction({payload, closeDrawer, retryStore, form, call, onSuccess}) {
  const saveBtn = document.getElementById("drawer-save");
  saveBtn.disabled = true;
  const original = saveBtn.textContent;
  saveBtn.innerHTML = '<span class="spinner"></span> Recording securely…';
  let result;
  try {
    result = await call();
  } catch (error) {
    saveBtn.disabled = false;
    saveBtn.textContent = original;
    const errorBox = form.querySelector("#money-error");
    errorBox.hidden = false;
    errorBox.textContent = "Not yet confirmed. The exact request was retained for a safe retry. " + error.message;
    render();
    return;
  }
  retryStore.clear();
  closeDrawer();
  onSuccess(result);
}

// ---------------------------------------------------------------------------
// rendering: bank & payouts (platform beneficiary + payout rails + automation)
// this is a PARTIAL patch - only finance.payouts is sent, so it can never
// touch checkout method toggles, commission %, or the COD exposure limit
// (those stay whatever they already are, unedited by this tab).
// ---------------------------------------------------------------------------
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function minutesToTimeInput(minutes) {
  const safe = Math.max(0, Math.min(1439, Number.isFinite(Number(minutes)) ? Math.trunc(Number(minutes)) : 630));
  return String(Math.floor(safe / 60)).padStart(2, "0") + ":" + String(safe % 60).padStart(2, "0");
}
function timeInputToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const hour = Number(m[1]), minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}
function defaultPayouts() {
  return {
    upiEnabled: true, impsEnabled: true, neftEnabled: true, upiPreferredMaximumPaise: 1_000_000, highValuePayoutMethod: "neft",
    automation: {enabled: false, cadence: "weekly", timezone: "Asia/Kolkata", executionDayOfWeek: 1, executionMinuteOfDay: 630, ridersEnabled: true, restaurantsEnabled: true, minimumRestaurantSettlementPaise: 0},
    platformBeneficiary: {legalName: "", contactName: "", contactPhone: "", contactEmail: "", preferredMethod: "neft", upiId: "", bankAccountHolderName: "", bankAccountNumber: "", bankIfsc: "", bankName: "", branchName: "", accountType: "current", panNumber: "", gstin: "", notes: ""},
  };
}
function fieldHtml(label, name, value, placeholder) {
  return '<div class="field"><label>' + h(label) + '</label><input class="input" name="' + name + '" value="' + h(value || "") + '" placeholder="' + h(placeholder || "") + '"></div>';
}
function selectFieldHtml(label, name, options, selected) {
  return '<div class="field"><label>' + h(label) + '</label><select class="select" name="' + name + '">' + options.map(([v, l]) => '<option value="' + h(v) + '"' + (v === selected ? " selected" : "") + '>' + h(l) + '</option>').join("") + '</select></div>';
}
function checkboxHtml(name, label, checked) {
  return '<label class="checkbox-row" style="margin:8px 0;"><input type="checkbox" name="' + name + '"' + (checked ? " checked" : "") + '> ' + h(label) + '</label>';
}

function renderBankPayoutsTab() {
  const box = document.getElementById("panel-bankPayouts");
  if (box.hidden) return;
  const body = document.getElementById("bank-payouts-body");
  const liveConfig = !!state.platformConfig;
  const payouts = (liveConfig && state.platformConfig.finance && state.platformConfig.finance.payouts) || defaultPayouts();
  const beneficiary = payouts.platformBeneficiary || defaultPayouts().platformBeneficiary;
  const automation = payouts.automation || defaultPayouts().automation;

  body.innerHTML = (!liveConfig ? '<div class="notice notice-warning">' + warningIcon() + '<span>Live configuration could not load. Refresh before saving.</span></div>' : "")
    + '<section class="card card-pad" style="margin-bottom:20px;">'
    + '<div class="cluster between" style="margin-bottom:4px;"><h2 style="font-size:14px;">Platform settlement beneficiary</h2>'
    + '<span class="badge badge-neutral">' + (liveConfig ? "Revision " + (state.platformConfig.revision || 0) : "Not loaded") + '</span></div>'
    + '<p style="font-size:12px; color:var(--text-soft); margin-bottom:14px;">Leave any field blank for now — add the real bank details whenever they\'re ready. Every field here can be edited again at any time; nothing you leave untouched gets cleared.</p>'
    + '<form id="bank-payouts-form">'
    + '<div class="form-grid">'
    + fieldHtml("Legal business name", "legalName", beneficiary.legalName, "Savrivo Technologies Private Limited")
    + fieldHtml("Settlement contact name", "contactName", beneficiary.contactName, "Finance operations")
    + fieldHtml("Settlement phone", "contactPhone", beneficiary.contactPhone, "+91 98765 43210")
    + fieldHtml("Settlement email", "contactEmail", beneficiary.contactEmail, "finance@savrivo.in")
    + selectFieldHtml("Preferred treasury method", "preferredMethod", [["upi", "UPI"], ["imps", "IMPS"], ["neft", "NEFT"]], beneficiary.preferredMethod || "neft")
    + fieldHtml("UPI ID", "upiId", beneficiary.upiId, "business@bank")
    + fieldHtml("Bank account holder", "bankAccountHolderName", beneficiary.bankAccountHolderName, "")
    + fieldHtml("Bank account number", "bankAccountNumber", beneficiary.bankAccountNumber, "")
    + fieldHtml("IFSC", "bankIfsc", beneficiary.bankIfsc, "HDFC0001234")
    + fieldHtml("Bank name", "bankName", beneficiary.bankName, "")
    + fieldHtml("Branch name", "branchName", beneficiary.branchName, "")
    + selectFieldHtml("Account type", "accountType", [["current", "Current"], ["savings", "Savings"]], beneficiary.accountType || "current")
    + fieldHtml("PAN", "panNumber", beneficiary.panNumber, "ABCDE1234F")
    + fieldHtml("GSTIN", "gstin", beneficiary.gstin, "37ABCDE1234F1Z5")
    + "</div>"
    + '<div class="field"><label>Notes</label><textarea class="textarea" name="notes" maxlength="500" placeholder="Internal payout notes, finance reminders or bank instructions">' + h(beneficiary.notes || "") + "</textarea></div>"

    + '<div class="section-title">Payout rails</div>'
    + '<div class="form-grid">'
    + '<div class="field"><label>Prefer UPI payout up to ₹</label><input class="input" name="upiPreferredMaximum" type="number" min="0" step="0.01" value="' + h(paiseInputValue(payouts.upiPreferredMaximumPaise || 0)) + '"></div>'
    + selectFieldHtml("Above threshold use", "highValuePayoutMethod", [["neft", "NEFT"], ["imps", "IMPS"]], payouts.highValuePayoutMethod || "neft")
    + "</div>"
    + checkboxHtml("upiEnabled", "Allow UPI payouts", payouts.upiEnabled !== false)
    + checkboxHtml("impsEnabled", "Allow IMPS payouts", payouts.impsEnabled !== false)
    + checkboxHtml("neftEnabled", "Allow NEFT payouts", payouts.neftEnabled !== false)

    + '<div class="section-title">Weekly payout automation</div>'
    + '<div class="form-grid">'
    + selectFieldHtml("Run day", "executionDayOfWeek", WEEKDAY_LABELS.map((l, i) => [String(i), l]), String(automation.executionDayOfWeek ?? 1))
    + '<div class="field"><label>Run time</label><input class="input" name="executionTime" type="time" value="' + h(minutesToTimeInput(automation.executionMinuteOfDay)) + '"></div>'
    + '<div class="field"><label>Timezone</label><input class="input" name="timezone" value="' + h(automation.timezone || "Asia/Kolkata") + '"></div>'
    + '<div class="field"><label>Minimum restaurant settlement ₹</label><input class="input" name="minimumRestaurantSettlement" type="number" min="0" step="0.01" value="' + h(paiseInputValue(automation.minimumRestaurantSettlementPaise || 0)) + '"></div>'
    + "</div>"
    + checkboxHtml("automationEnabled", "Enable weekly automation", automation.enabled === true)
    + checkboxHtml("automationRidersEnabled", "Include rider payouts", automation.ridersEnabled !== false)
    + checkboxHtml("automationRestaurantsEnabled", "Include restaurant settlements", automation.restaurantsEnabled !== false)

    + '<div class="notice notice-danger" id="bank-payouts-error" hidden></div>'
    + '<button class="btn btn-primary" type="submit" style="margin-top:16px;"' + (liveConfig ? "" : " disabled") + '>' + (liveConfig ? "Save bank & payout settings" : "Refresh to enable saving") + "</button>"
    + "</form></section>";

  document.getElementById("bank-payouts-form").addEventListener("submit", onSaveBankPayouts);
}

async function onSaveBankPayouts(event) {
  event.preventDefault();
  const form = event.target;
  const errorBox = document.getElementById("bank-payouts-error");
  errorBox.hidden = true;
  const fail = (m) => { errorBox.hidden = false; errorBox.textContent = m; };
  const fd = new FormData(form);
  const get = (n) => String(fd.get(n) || "").trim();

  const contactEmail = get("contactEmail");
  const upiId = get("upiId");
  const bankIfsc = get("bankIfsc").toUpperCase();
  const bankAccountNumber = get("bankAccountNumber").replace(/\s+/g, "");
  const panNumber = get("panNumber").toUpperCase();
  const gstin = get("gstin").toUpperCase();
  const upiPreferredMaximumRupees = Number(fd.get("upiPreferredMaximum") || 0);
  const minimumRestaurantSettlementRupees = Number(fd.get("minimumRestaurantSettlement") || 0);
  const executionDayOfWeek = Number(fd.get("executionDayOfWeek"));
  const executionMinuteOfDay = timeInputToMinutes(fd.get("executionTime"));
  const timezone = get("timezone") || "Asia/Kolkata";

  if (contactEmail && !/^\S+@\S+\.\S+$/.test(contactEmail)) { fail("Enter a valid settlement email, or leave it blank."); return; }
  if (upiId && !/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/.test(upiId)) { fail("Enter a valid UPI ID, or leave it blank."); return; }
  if (bankIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIfsc)) { fail("Enter a valid IFSC code, or leave it blank."); return; }
  if (bankAccountNumber && !/^[0-9]{6,20}$/.test(bankAccountNumber)) { fail("Enter a valid bank account number, or leave it blank."); return; }
  if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) { fail("Enter a valid PAN, or leave it blank."); return; }
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) { fail("Enter a valid GSTIN, or leave it blank."); return; }
  if (!Number.isFinite(upiPreferredMaximumRupees) || upiPreferredMaximumRupees < 0) { fail("Enter a valid UPI payout threshold."); return; }
  if (!Number.isFinite(minimumRestaurantSettlementRupees) || minimumRestaurantSettlementRupees < 0) { fail("Enter a valid minimum restaurant settlement amount."); return; }
  if (!Number.isInteger(executionDayOfWeek) || executionDayOfWeek < 0 || executionDayOfWeek > 6) { fail("Choose a valid weekly payout day."); return; }
  if (executionMinuteOfDay == null) { fail("Choose a valid weekly payout time."); return; }

  const payload = {
    operationId: createOperationId("bank-payouts-web", "platform"),
    expectedRevision: Number((state.platformConfig && state.platformConfig.revision) || 0),
    finance: {
      payouts: {
        upiEnabled: fd.get("upiEnabled") === "on",
        impsEnabled: fd.get("impsEnabled") === "on",
        neftEnabled: fd.get("neftEnabled") === "on",
        upiPreferredMaximumPaise: Math.max(0, Math.round(upiPreferredMaximumRupees * 100)),
        highValuePayoutMethod: get("highValuePayoutMethod") || "neft",
        automation: {
          enabled: fd.get("automationEnabled") === "on",
          cadence: "weekly",
          timezone,
          executionDayOfWeek,
          executionMinuteOfDay,
          ridersEnabled: fd.get("automationRidersEnabled") === "on",
          restaurantsEnabled: fd.get("automationRestaurantsEnabled") === "on",
          minimumRestaurantSettlementPaise: Math.max(0, Math.round(minimumRestaurantSettlementRupees * 100)),
        },
        platformBeneficiary: {
          legalName: get("legalName"), contactName: get("contactName"), contactPhone: get("contactPhone"), contactEmail,
          preferredMethod: get("preferredMethod") || "neft", upiId,
          bankAccountHolderName: get("bankAccountHolderName"), bankAccountNumber, bankIfsc,
          bankName: get("bankName"), branchName: get("branchName"), accountType: get("accountType") || "current",
          panNumber, gstin, notes: get("notes"),
        },
      },
    },
  };

  const saveBtn = form.querySelector('button[type="submit"]');
  saveBtn.disabled = true;
  const original = saveBtn.textContent;
  saveBtn.innerHTML = '<span class="spinner"></span> Saving securely…';
  try {
    state.platformConfig = await callFunction("updatePlatformConfigurationPolicy", payload);
    toast("Bank & payout settings saved.", "success");
    renderBankPayoutsTab();
  } catch (error) {
    fail(error.message || "Save failed.");
    saveBtn.disabled = false;
    saveBtn.textContent = original;
  }
}

// ---------------------------------------------------------------------------
// statement tab - a bank-statement-style itemized read of the immutable
// ledger for a day/week/month/year, built on getFinanceStatement's bounded
// [startAt, endAt) window. All boundary math is pinned to Asia/Kolkata via a
// fixed +5:30 offset (India has no DST, so this is exact and never needs a
// timezone library) rather than the admin's own browser timezone, so two
// admins in different timezones see the same "today".
// ---------------------------------------------------------------------------
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const EVENT_TYPE_LABELS = {
  cod_delivery: "COD order delivered", cod_collection: "COD cash collected", cod_remittance: "COD remittance to platform",
  restaurant_payable: "Restaurant payable accrued", platform_commission: "Platform commission", platform_fee: "Platform fee",
  rider_earning: "Rider earning accrued", rider_incentive: "Rider incentive", rider_referral_reward: "Rider referral reward",
  rider_payout: "Rider payout", rider_tip: "Rider tip", payment: "Online payment received", refund: "Refund", adjustment: "Adjustment",
};
function eventTypeLabel(type) { return EVENT_TYPE_LABELS[type] || type; }
function istParts(ms) {
  const shifted = new Date(Number(ms) + IST_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate(), dow: shifted.getUTCDay(),
  };
}
function istMidnight(y, mo, d) { return Date.UTC(y, mo, d) - IST_OFFSET_MS; }
function startOfIstDay(ms) { const p = istParts(ms); return istMidnight(p.y, p.mo, p.d); }
function startOfIstWeek(ms) { const p = istParts(ms); return istMidnight(p.y, p.mo, p.d - p.dow); }
function startOfIstMonth(ms) { const p = istParts(ms); return istMidnight(p.y, p.mo, 1); }
function startOfIstYear(ms) { const p = istParts(ms); return istMidnight(p.y, 0, 1); }
function addIstDays(ms, n) { const p = istParts(ms); return istMidnight(p.y, p.mo, p.d + n); }
function addIstMonths(ms, n) { const p = istParts(ms); return istMidnight(p.y, p.mo + n, 1); }
function addIstYears(ms, n) { const p = istParts(ms); return istMidnight(p.y + n, 0, 1); }
function statementPeriodRange(type, anchor) {
  if (type === "day") { const s = startOfIstDay(anchor); return {startAt: s, endAt: addIstDays(s, 1)}; }
  if (type === "week") { const s = startOfIstWeek(anchor); return {startAt: s, endAt: addIstDays(s, 7)}; }
  if (type === "month") { const s = startOfIstMonth(anchor); return {startAt: s, endAt: addIstMonths(s, 1)}; }
  const s = startOfIstYear(anchor); return {startAt: s, endAt: addIstYears(s, 1)};
}
function statementEntryTime(ms) {
  return new Date(Number(ms)).toLocaleString("en-IN", {day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata"});
}

async function loadStatement() {
  state.statementLoading = true;
  state.statementError = "";
  renderStatementTab();
  try {
    if (state.statementPeriodType === "year") {
      const yearStart = startOfIstYear(state.statementAnchor);
      const months = Array.from({length: 12}, (_, i) => addIstMonths(yearStart, i)).filter((m) => m <= Date.now());
      const results = await Promise.all(months.map((m) => {
        const {startAt, endAt} = statementPeriodRange("month", m);
        return callFunction("getFinanceStatement", {startAt, endAt, limit: 3000});
      }));
      state.statementYearRows = months.map((m, i) => ({monthStart: m, statement: results[i]}));
      state.statementData = null;
    } else {
      const {startAt, endAt} = statementPeriodRange(state.statementPeriodType, state.statementAnchor);
      state.statementData = await callFunction("getFinanceStatement", {startAt, endAt, limit: 3000});
      state.statementYearRows = null;
    }
  } catch (error) {
    state.statementError = error.message || "Could not load the statement.";
  } finally {
    state.statementLoading = false;
    renderStatementTab();
  }
}

/** Three cards regrouping the same period's money by who it belongs to -
 *  restaurant, rider, platform - instead of by event type. Shown at every
 *  level of the statement (day/week/month/year), right above the event-type
 *  breakdown, since "who got what" is usually the first question a bank
 *  statement is opened to answer. */
function statementAllocationCardsHtml(allocation, hasEntries) {
  // Deliberately deferring to the "No transactions in this period" hint the
  // event-type cards already show, rather than rendering three ₹0 cards that
  // could read as a broken load instead of a genuinely quiet period.
  if (!allocation || !hasEntries) return "";
  const card = (label, paise, sub) => (
    '<div class="stat-card"><div class="label">' + h(label) + '</div>'
    + '<div class="value">' + h(moneyPaise(paise)) + '</div>'
    + '<div class="sub">' + h(sub) + '</div></div>'
  );
  return '<section class="stat-grid" style="margin-bottom:12px;">'
    + card("Restaurant settlement", allocation.restaurantPaise, "Owed or paid to restaurants")
    + card("Rider payout", allocation.riderPaise, "Earnings, tips and incentives")
    + card("Platform profit", allocation.platformPaise, "Commission and fees, net of rider rewards")
    + '</section>';
}

function statementSummaryCardsHtml(totalsByEventType, entryCount) {
  if (!totalsByEventType || !totalsByEventType.length) return '<p class="hint">No transactions in this period.</p>';
  const cards = totalsByEventType.map((t) => (
    '<div class="stat-card"><div class="label">' + h(eventTypeLabel(t.eventType)) + '</div>'
    + '<div class="value">' + h(moneyPaise(t.grossPaise)) + '</div>'
    + '<div class="sub">' + h(t.count) + (t.count === 1 ? " transaction" : " transactions") + '</div></div>'
  )).join("");
  return '<section class="stat-grid" style="margin-bottom:20px;">' + cards
    + '<div class="stat-card"><div class="label">Total entries</div><div class="value">' + h(entryCount) + '</div><div class="sub">this period</div></div>'
    + '</section>';
}

function statementEntryRowsHtml(entries) {
  if (!entries.length) {
    return '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h10"/></svg><p>No transactions in this period.</p></div>';
  }
  return '<div class="table-wrap"><table class="data-table"><thead><tr>'
    + '<th>Date &amp; time</th><th>Type</th><th>Order</th><th>Reference</th><th style="text-align:right;">Amount</th>'
    + '</tr></thead><tbody>'
    + entries.map((e) => {
      const expanded = state.statementExpandedId === e.journalId;
      const legsHtml = expanded ? '<tr class="row-detail"><td colspan="5"><div class="cell-sub">'
        + e.legs.map((l) => (l.side === "debit" ? "Debit " : "Credit ") + h(l.accountId) + ": " + h(moneyPaise(l.amountPaise))).join("<br>")
        + '</div></td></tr>' : "";
      return '<tr class="row-clickable" data-statement-toggle="' + h(e.journalId) + '">'
        + '<td><div class="cell-sub">' + h(statementEntryTime(e.occurredAt)) + '</div></td>'
        + '<td>' + h(eventTypeLabel(e.eventType)) + '</td>'
        + '<td><div class="cell-sub">' + h(e.orderId || "—") + '</div></td>'
        + '<td><div class="cell-sub">' + h(e.actorId || "—") + '</div></td>'
        + '<td style="text-align:right;">' + h(moneyPaise(e.grossPaise)) + '</td>'
        + '</tr>' + legsHtml;
    }).join("")
    + '</tbody></table></div>';
}

/** Adds up each already-fetched month's server-computed allocation into one
 *  year total. Pure arithmetic over numbers the server already produced -
 *  no new classification logic runs client-side, so this can never disagree
 *  with what a single month's own statement shows. */
function sumYearAllocation(rows) {
  const total = {restaurantPaise: 0, riderPaise: 0, platformPaise: 0};
  (rows || []).forEach((r) => {
    const a = r.statement && r.statement.allocation;
    if (!a) return;
    total.restaurantPaise += a.restaurantPaise;
    total.riderPaise += a.riderPaise;
    total.platformPaise += a.platformPaise;
  });
  return total;
}

function statementYearRowsHtml(rows) {
  if (!rows || !rows.length) return '<p class="hint">No data yet for this year.</p>';
  return '<div class="table-wrap"><table class="data-table"><thead><tr><th>Month</th><th>Transactions</th><th style="text-align:right;">Total</th></tr></thead><tbody>'
    + rows.map((r) => {
      const total = (r.statement.totalsByEventType || []).reduce((sum, t) => sum + t.grossPaise, 0);
      return '<tr class="row-clickable" data-statement-month="' + r.monthStart + '">'
        + '<td>' + h(new Date(r.monthStart).toLocaleDateString("en-IN", {month: "long", year: "numeric", timeZone: "Asia/Kolkata"})) + '</td>'
        + '<td>' + h(r.statement.entryCount) + (r.statement.truncated ? ' <span class="badge badge-warning">Truncated</span>' : "") + '</td>'
        + '<td style="text-align:right;">' + h(moneyPaise(total)) + '</td></tr>';
    }).join("") + '</tbody></table></div>';
}

// ---------------------------------------------------------------------------
// statement period selector - a year -> month -> week -> day cascade shown
// directly on the page: pick a year to see that whole year's transactions,
// and optionally narrow down to a month within it, a week within that month,
// and a day within that week. Not narrowing further at any level is how you
// stop there - there's no separate "just show the year" toggle to find, it's
// simply what happens when you don't go on to pick a month.
// ---------------------------------------------------------------------------
const STATEMENT_YEAR_MIN = 2026;
const STATEMENT_YEAR_MAX = 2126;
const STATEMENT_YEARS_PER_PAGE = 12;
const MONTH_LABELS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function statementYearPageStart(year) {
  const clamped = Math.max(STATEMENT_YEAR_MIN, Math.min(STATEMENT_YEAR_MAX, year));
  return STATEMENT_YEAR_MIN + Math.floor((clamped - STATEMENT_YEAR_MIN) / STATEMENT_YEARS_PER_PAGE) * STATEMENT_YEARS_PER_PAGE;
}
function statementMonthWeekStarts(year, month0) {
  const monthStart = istMidnight(year, month0, 1);
  const monthEnd = addIstMonths(monthStart, 1);
  const weeks = [];
  let cursor = startOfIstWeek(monthStart);
  while (cursor < monthEnd) { weeks.push(cursor); cursor = addIstDays(cursor, 7); }
  return weeks;
}

function statementYearGridHtml() {
  const pageStart = state.statementSelYearPage;
  const pageEnd = Math.min(STATEMENT_YEAR_MAX, pageStart + STATEMENT_YEARS_PER_PAGE - 1);
  const years = [];
  for (let y = pageStart; y <= pageEnd; y += 1) years.push(y);
  const canPrev = pageStart > STATEMENT_YEAR_MIN;
  const canNext = pageEnd < STATEMENT_YEAR_MAX;
  return '<div class="cluster between" style="margin-bottom:10px;">'
    + '<button type="button" class="icon-btn" id="statement-year-prev"' + (canPrev ? "" : " disabled") + '>&larr;</button>'
    + '<strong style="font-size:13px;">' + pageStart + ' – ' + pageEnd + '</strong>'
    + '<button type="button" class="icon-btn" id="statement-year-next"' + (canNext ? "" : " disabled") + '>&rarr;</button>'
    + '</div>'
    + '<div class="chip-row" id="statement-year-grid">'
    + years.map((y) => '<button type="button" class="chip" data-pick-year="' + y + '">' + y + '</button>').join("")
    + '</div>';
}
function statementMonthGridHtml() {
  return '<div class="chip-row" id="statement-month-grid">'
    + MONTH_LABELS_SHORT.map((label, i) => '<button type="button" class="chip" data-pick-month="' + i + '">' + h(label) + '</button>').join("")
    + '</div>';
}
function statementWeekListHtml(year, month0) {
  const weeks = statementMonthWeekStarts(year, month0);
  const dayFmt = (ms) => new Date(ms).toLocaleDateString("en-IN", {day: "numeric", month: "short", timeZone: "Asia/Kolkata"});
  return '<div class="table-wrap"><table class="data-table"><tbody id="statement-week-list">'
    + weeks.map((w, i) => (
      '<tr class="row-clickable" data-pick-week="' + w + '"><td>Week ' + (i + 1) + '</td>'
      + '<td class="cell-sub">' + h(dayFmt(w)) + ' – ' + h(dayFmt(addIstDays(w, 6))) + '</td></tr>'
    )).join("") + '</tbody></table></div>';
}
function statementWeekDayChipsHtml(weekStart) {
  const dayFmt = (ms) => new Date(ms).toLocaleDateString("en-IN", {weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata"});
  const todayStart = startOfIstDay(Date.now());
  const days = Array.from({length: 7}, (_, i) => addIstDays(weekStart, i));
  return '<div class="chip-row" id="statement-day-grid">'
    + days.map((d) => (
      '<button type="button" class="chip" data-pick-day="' + d + '" style="' + (d === todayStart ? "border-color:var(--brand);font-weight:700;" : "") + '">' + h(dayFmt(d)) + '</button>'
    )).join("") + '</div>';
}

/** Re-derives the internal statementPeriodType/statementAnchor from whichever
 * level is deepest in the cascading selection, and reloads that period. */
function statementApplySelection() {
  state.statementExpandedId = "";
  if (state.statementSelDay != null) {
    state.statementPeriodType = "day"; state.statementAnchor = state.statementSelDay;
  } else if (state.statementSelWeekStart != null) {
    state.statementPeriodType = "week"; state.statementAnchor = state.statementSelWeekStart;
  } else if (state.statementSelMonth != null) {
    state.statementPeriodType = "month"; state.statementAnchor = istMidnight(state.statementSelYear, state.statementSelMonth, 1);
  } else if (state.statementSelYear != null) {
    state.statementPeriodType = "year"; state.statementAnchor = istMidnight(state.statementSelYear, 0, 1);
  } else {
    state.statementData = null;
    state.statementYearRows = null;
    renderStatementTab();
    return;
  }
  loadStatement();
}

function statementLevelCardHtml(title, chosenLabel, onChangeId, pickerHtml) {
  if (chosenLabel != null) {
    return '<section class="card card-pad" style="margin-bottom:16px;">'
      + '<div class="cluster between"><p class="hint" style="margin:0;">' + h(title) + '</p>'
      + '<div class="cluster" style="gap:10px;"><strong style="font-size:13.5px;">' + h(chosenLabel) + '</strong>'
      + '<button type="button" class="btn btn-ghost btn-sm" id="' + onChangeId + '">Change</button></div></div>'
      + '</section>';
  }
  return '<section class="card card-pad" style="margin-bottom:16px;">'
    + '<p class="hint" style="margin-bottom:10px;">' + h(title) + '</p>' + pickerHtml + '</section>';
}

function renderStatementTab() {
  const box = document.getElementById("panel-statement");
  if (box.hidden) return;
  const body = document.getElementById("statement-body");
  if (state.statementSelYearPage == null) state.statementSelYearPage = statementYearPageStart(istParts(Date.now()).y);

  const dayFmt = (ms) => new Date(ms).toLocaleDateString("en-IN", {day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata"});

  let levelsHtml = statementLevelCardHtml(
    "Which year's transactions would you like to see?",
    state.statementSelYear != null ? String(state.statementSelYear) : null,
    "statement-change-year",
    statementYearGridHtml(),
  );

  if (state.statementSelYear != null) {
    levelsHtml += statementLevelCardHtml(
      state.statementSelMonth != null ? "Month" : "Want to narrow down to a specific month in " + state.statementSelYear + "?",
      state.statementSelMonth != null ? MONTH_LABELS_SHORT[state.statementSelMonth] + " " + state.statementSelYear : null,
      "statement-change-month",
      statementMonthGridHtml(),
    );
  }

  if (state.statementSelYear != null && state.statementSelMonth != null) {
    const weekLabel = state.statementSelWeekStart != null
      ? dayFmt(state.statementSelWeekStart) + " – " + dayFmt(addIstDays(state.statementSelWeekStart, 6)) : null;
    levelsHtml += statementLevelCardHtml(
      state.statementSelWeekStart != null ? "Week"
        : "Want to narrow down to a specific week in " + MONTH_LABELS_SHORT[state.statementSelMonth] + " " + state.statementSelYear + "?",
      weekLabel,
      "statement-change-week",
      statementWeekListHtml(state.statementSelYear, state.statementSelMonth),
    );
  }

  if (state.statementSelWeekStart != null) {
    levelsHtml += statementLevelCardHtml(
      state.statementSelDay != null ? "Day" : "Want to narrow down to a specific day in that week?",
      state.statementSelDay != null ? dayFmt(state.statementSelDay) : null,
      "statement-change-day",
      statementWeekDayChipsHtml(state.statementSelWeekStart),
    );
  }

  let resultsHtml;
  if (state.statementSelYear == null) {
    resultsHtml = "";
  } else if (state.statementLoading) {
    resultsHtml = '<div class="loading-block"><span class="spinner dark"></span> Loading statement…</div>';
  } else if (state.statementError) {
    resultsHtml = '<div class="notice notice-danger">' + h(state.statementError) + '</div>';
  } else if (state.statementPeriodType === "year") {
    const rows = state.statementYearRows;
    const anyTruncated = !!(rows && rows.some((r) => r.statement.truncated));
    resultsHtml = rows
      ? (anyTruncated ? '<div class="notice notice-warning">' + warningIcon() + '<span>At least one month hit its page limit — the totals below cover only what was fetched for that month, not its whole transaction history.</span></div>' : "")
        + statementAllocationCardsHtml(sumYearAllocation(rows), rows.some((r) => r.statement.entryCount > 0))
        + statementYearRowsHtml(rows)
      : "";
  } else {
    const data = state.statementData;
    resultsHtml = data
      ? (data.truncated ? '<div class="notice notice-warning">' + warningIcon() + '<span>More transactions exist in this period than shown here (page limit reached) — totals below cover only the ' + h(data.entryCount) + ' shown, not the whole period.</span></div>' : "")
        + statementAllocationCardsHtml(data.allocation, data.entryCount > 0)
        + statementSummaryCardsHtml(data.totalsByEventType, data.entryCount)
        + statementEntryRowsHtml(data.entries)
      : "";
  }

  body.innerHTML = levelsHtml + '<div id="statement-content">' + resultsHtml + '</div>';

  const yearPrev = document.getElementById("statement-year-prev");
  if (yearPrev) yearPrev.addEventListener("click", () => {
    state.statementSelYearPage = Math.max(STATEMENT_YEAR_MIN, state.statementSelYearPage - STATEMENT_YEARS_PER_PAGE);
    renderStatementTab();
  });
  const yearNext = document.getElementById("statement-year-next");
  if (yearNext) yearNext.addEventListener("click", () => {
    state.statementSelYearPage = Math.min(STATEMENT_YEAR_MAX, state.statementSelYearPage + STATEMENT_YEARS_PER_PAGE);
    renderStatementTab();
  });
  const yearGrid = document.getElementById("statement-year-grid");
  if (yearGrid) yearGrid.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-pick-year]");
    if (!btn) return;
    state.statementSelYear = Number(btn.dataset.pickYear);
    state.statementSelMonth = null; state.statementSelWeekStart = null; state.statementSelDay = null;
    statementApplySelection();
  });
  const changeYear = document.getElementById("statement-change-year");
  if (changeYear) changeYear.addEventListener("click", () => {
    state.statementSelYear = null; state.statementSelMonth = null; state.statementSelWeekStart = null; state.statementSelDay = null;
    statementApplySelection();
  });

  const monthGrid = document.getElementById("statement-month-grid");
  if (monthGrid) monthGrid.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-pick-month]");
    if (!btn) return;
    state.statementSelMonth = Number(btn.dataset.pickMonth);
    state.statementSelWeekStart = null; state.statementSelDay = null;
    statementApplySelection();
  });
  const changeMonth = document.getElementById("statement-change-month");
  if (changeMonth) changeMonth.addEventListener("click", () => {
    state.statementSelMonth = null; state.statementSelWeekStart = null; state.statementSelDay = null;
    statementApplySelection();
  });

  const weekList = document.getElementById("statement-week-list");
  if (weekList) weekList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-pick-week]");
    if (!row) return;
    state.statementSelWeekStart = Number(row.dataset.pickWeek);
    state.statementSelDay = null;
    statementApplySelection();
  });
  const changeWeek = document.getElementById("statement-change-week");
  if (changeWeek) changeWeek.addEventListener("click", () => {
    state.statementSelWeekStart = null; state.statementSelDay = null;
    statementApplySelection();
  });

  const dayGrid = document.getElementById("statement-day-grid");
  if (dayGrid) dayGrid.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-pick-day]");
    if (!btn) return;
    state.statementSelDay = Number(btn.dataset.pickDay);
    statementApplySelection();
  });
  const changeDay = document.getElementById("statement-change-day");
  if (changeDay) changeDay.addEventListener("click", () => {
    state.statementSelDay = null;
    statementApplySelection();
  });

  document.getElementById("statement-content").addEventListener("click", (event) => {
    const monthRow = event.target.closest("[data-statement-month]");
    if (monthRow) {
      state.statementSelMonth = istParts(Number(monthRow.dataset.statementMonth)).mo;
      state.statementSelWeekStart = null; state.statementSelDay = null;
      statementApplySelection();
      return;
    }
    const toggleRow = event.target.closest("[data-statement-toggle]");
    if (toggleRow) {
      const id = toggleRow.dataset.statementToggle;
      state.statementExpandedId = state.statementExpandedId === id ? "" : id;
      renderStatementTab();
    }
  });
}


// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
document.getElementById("tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  state.tab = tab.dataset.tab;
  render();
});
document.getElementById("cod-rows").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  openCodDrawer(btn.dataset.riderId);
});
document.getElementById("rider-search-input").addEventListener("input", (event) => {
  state.riderQuery = event.target.value;
  renderRiderPayoutsTab();
});
document.getElementById("rider-search-results").addEventListener("click", (event) => {
  const row = event.target.closest("[data-select-rider]");
  if (!row) return;
  state.selectedRiderId = row.dataset.selectRider;
  renderRiderPayoutsTab();
});
document.getElementById("restaurant-search-input").addEventListener("input", (event) => {
  state.restaurantQuery = event.target.value;
  renderRestaurantSettlementsTab();
});
document.getElementById("restaurant-search-results").addEventListener("click", (event) => {
  const row = event.target.closest("[data-select-restaurant]");
  if (!row) return;
  state.selectedRestaurantId = row.dataset.selectRestaurant;
  renderRestaurantSettlementsTab();
});
document.getElementById("refresh-btn").addEventListener("click", () => loadDashboard(true));
document.getElementById("signout-btn").addEventListener("click", () => signOutUser());

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
requireAdminSession().then((sessionState) => {
  if (!sessionState) return;
  state.currentUid = sessionState.user.uid;
  document.getElementById("app-shell").hidden = false;
  document.getElementById("sidebar-who").textContent = sessionState.user.email + " · " + sessionState.claims.savrivoRole;
  loadDashboard(true);
});

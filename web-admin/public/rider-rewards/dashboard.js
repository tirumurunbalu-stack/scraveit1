import {requireAdminSession, signOutUser, callFunction} from "../assets/firebase-client.js?v=5";

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
function uid(prefix) {
  return (prefix || "") + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
}
function slug(text) {
  return String(text || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "campaign";
}
function operationId(prefix) {
  return prefix + "_" + Date.now() + "_" + uid("").replace(/[^A-Za-z0-9]/g, "").slice(-10);
}
function moneyPaise(paise) {
  const value = Number(paise);
  if (!Number.isFinite(value)) return "₹0";
  return "₹" + Math.round(value / 100).toLocaleString("en-IN");
}
function moneyInput(paise) {
  return Number.isFinite(Number(paise)) ? String(Math.round(Number(paise)) / 100) : "";
}
function moneyToPaise(value) {
  const numeric = Math.round(Number(String(value || "").replace(/,/g, "")) * 100);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}
function intOrUndefined(value) {
  if (value === "" || value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}
function floatOrUndefined(value) {
  if (value === "" || value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function linesToArray(value) {
  return String(value || "").split(/\n|,/).map((v) => v.trim()).filter(Boolean);
}
function arrayToLines(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}
function datetimeLocalValue(epochMs) {
  if (!epochMs) return "";
  const date = new Date(Number(epochMs));
  const pad = (v) => String(v).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
    + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
}
function datetimeLocalToEpoch(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}
function dateTimeWithYear(t) {
  return t ? new Date(Number(t)).toLocaleString("en-IN", {day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit"}) : "—";
}
function timeMinuteFromHHMM(value) {
  const m = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hours = Number(m[1]), minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}
function minuteToHHMM(minute) {
  const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}
function minuteToClock(minute) {
  const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
  const h24 = Math.floor(m / 60), mm = m % 60, period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return h12 + ":" + String(mm).padStart(2, "0") + " " + period;
}

function toast(message, kind) {
  const stack = document.getElementById("toast-stack");
  const node = el('<div class="toast ' + (kind || "") + '">' + h(message) + "</div>");
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

// ---------------------------------------------------------------------------
// campaign write-payload construction (mirrors functions/src/schemas.ts's
// riderRewardCampaignSchema exactly - see that file for the authoritative
// contract this must stay in sync with)
// ---------------------------------------------------------------------------
const META_KEYS = ["schemaVersion", "campaignId", "updatedAt", "updatedBy", "updatedByRole", "lastOperationId", "lastRequestHash"];
const NULLABLE_OPTIONAL_NUMBER_KEYS = [
  "rewardAmountPaise", "minCompletedTrips", "minRating", "firstNCompletedTrips",
  "orderTotalMinPaise", "minimumAccountAgeDays", "minimumCompletedSessionsPerDay",
];
// The dashboard read model fills unset optional numbers with null and includes
// server-owned metadata; the write schema is .strict() and only accepts those
// fields as present-and-a-number or entirely absent, never null or unknown
// keys - reusing a read campaign as a write payload (every quick action below
// does this) needs this normalization first every time.
function sanitizeCampaignForWrite(campaign) {
  const c = JSON.parse(JSON.stringify(campaign));
  META_KEYS.forEach((key) => { delete c[key]; });
  NULLABLE_OPTIONAL_NUMBER_KEYS.forEach((key) => { if (c[key] == null) delete c[key]; });
  return c;
}
function defaultCampaignBase() {
  return {
    subtitle: "", description: "",
    milestones: [], window: "daily",
    eligibleDays: [0, 1, 2, 3, 4, 5, 6], timeSlots: [],
    cityNames: [], zoneNames: [], restaurantIds: [], riderIds: [],
    rainOnly: false, requireDailyLoginSession: false,
    conditionGroups: [], otherConditions: [],
    milestonePayoutMode: "highest_unlocked", timezone: "Asia/Kolkata",
    tripAttribution: "delivered_at", allowOverlappingSlotCredit: false,
    eligibleRiderTypes: [], vehicleTypes: [],
    stacking: "stack", priority: 100,
    visible: true, active: true, archived: false,
  };
}
// Fields not exposed by this first version of the form (condition groups,
// login-session requirements, other-conditions, milestone payout mode, trip
// attribution, overlap credit) are deliberately left untouched from `base`
// rather than reset, so editing an existing campaign's basics can never
// silently wipe out configuration this panel doesn't yet have a UI for.
function buildCampaignPayload(sourceCampaign, form) {
  const base = sourceCampaign ? sanitizeCampaignForWrite(sourceCampaign) : defaultCampaignBase();
  const payload = Object.assign({}, base, {
    internalName: form.internalName,
    title: form.title,
    subtitle: form.subtitle,
    description: form.description,
    kind: form.kind,
    displayType: form.displayType,
    section: form.section,
    window: form.window,
    startAt: form.startAt,
    endAt: form.endAt,
    eligibleDays: form.eligibleDays,
    timezone: form.timezone,
    priority: form.priority,
    stacking: form.stacking,
    visible: form.visible,
    active: form.active,
    cityNames: form.cityNames,
    zoneNames: form.zoneNames,
    restaurantIds: form.restaurantIds,
    riderIds: form.riderIds,
    eligibleRiderTypes: form.eligibleRiderTypes,
    vehicleTypes: form.vehicleTypes,
    minCompletedTrips: form.minCompletedTrips,
    minRating: form.minRating,
    firstNCompletedTrips: form.firstNCompletedTrips,
    minimumAccountAgeDays: form.minimumAccountAgeDays,
    orderTotalMinPaise: form.orderTotalMinPaise,
    rainOnly: form.rainOnly,
  });
  if (form.kind === "per_order_bonus") {
    payload.rewardAmountPaise = form.rewardAmountPaise;
    payload.timeSlots = form.timeSlots;
    payload.milestones = [];
  } else {
    payload.milestones = form.milestones;
    payload.rewardAmountPaise = undefined;
  }
  NULLABLE_OPTIONAL_NUMBER_KEYS.forEach((key) => { if (payload[key] == null) delete payload[key]; });
  return payload;
}

// ---------------------------------------------------------------------------
// state + data loading
// ---------------------------------------------------------------------------
const state = {dashboard: null, query: "", tab: "active", busyCampaignId: "", settingsOpen: false};

async function loadDashboard(showSpinner) {
  if (showSpinner) {
    document.getElementById("loading-block").hidden = false;
    document.getElementById("dashboard").hidden = true;
    document.getElementById("load-error").hidden = true;
  }
  try {
    const data = await callFunction("getAdminRiderRewardsDashboard", {ledgerLimit: 500, campaignLimit: 200});
    state.dashboard = data;
    document.getElementById("loading-block").hidden = true;
    document.getElementById("dashboard").hidden = false;
    render();
  } catch (error) {
    document.getElementById("loading-block").hidden = true;
    const box = document.getElementById("load-error");
    box.hidden = false;
    box.textContent = error.message || "Could not load rider rewards.";
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
function campaignStats(campaigns) {
  return {
    total: campaigns.length,
    active: campaigns.filter((c) => c.campaign.active && !c.campaign.archived).length,
    paused: campaigns.filter((c) => !c.campaign.active && !c.campaign.archived).length,
    archived: campaigns.filter((c) => c.campaign.archived).length,
    accruedPaise: campaigns.reduce((sum, c) => sum + Number(c.totalAccruedPaise || 0), 0),
  };
}

function statusBadge(campaign) {
  if (campaign.archived) return '<span class="badge badge-neutral">Archived</span>';
  if (campaign.active) return '<span class="badge badge-success">Active</span>';
  return '<span class="badge badge-warning">Paused</span>';
}
function kindBadge(campaign) {
  return campaign.kind === "per_order_bonus"
    ? '<span class="badge badge-neutral">Per-order</span>'
    : '<span class="badge badge-neutral">Milestone</span>';
}
function rewardSummary(campaign) {
  if (campaign.kind === "per_order_bonus") return moneyPaise(campaign.rewardAmountPaise);
  const ms = campaign.milestones || [];
  if (!ms.length) return "—";
  const first = ms[0], last = ms[ms.length - 1];
  return ms.length === 1 ? first.target + " → " + moneyPaise(first.rewardAmountPaise)
    : first.target + "→" + moneyPaise(first.rewardAmountPaise) + " … " + last.target + "→" + moneyPaise(last.rewardAmountPaise);
}
function timeSlotsSummary(campaign) {
  const slots = campaign.timeSlots || [];
  if (!slots.length) return campaign.kind === "per_order_bonus" ? "All day" : "—";
  return slots.map((s) => (s.label ? h(s.label) + ": " : "") + minuteToClock(s.startMinute) + "–" + minuteToClock(s.endMinute)).join("<br>");
}
function matchesQuery(view, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const c = view.campaign;
  return [c.title, c.internalName, c.campaignId, c.description].join(" ").toLowerCase().includes(q);
}
function matchesTab(view, tab) {
  const c = view.campaign;
  if (tab === "active") return c.active && !c.archived;
  if (tab === "paused") return !c.active && !c.archived;
  if (tab === "archived") return c.archived;
  return true;
}

function renderStats() {
  const campaigns = state.dashboard.campaigns || [];
  const stats = campaignStats(campaigns);
  document.getElementById("stat-grid").innerHTML = [
    ["Total campaigns", stats.total, "All configured rewards"],
    ["Active", stats.active, "Live right now"],
    ["Paused", stats.paused, "Configured, not paying"],
    ["Archived", stats.archived, "Retired records"],
    ["Accrued", moneyPaise(stats.accruedPaise), "Ledger-recorded rewards"],
  ].map(([label, value, sub]) => (
    '<div class="stat-card"><div class="label">' + h(label) + '</div><div class="value">' + h(value) + '</div><div class="sub">' + h(sub) + "</div></div>"
  )).join("");
}

function renderTabs() {
  const campaigns = state.dashboard.campaigns || [];
  const stats = campaignStats(campaigns);
  const tabs = [["all", "All", stats.total], ["active", "Active", stats.active], ["paused", "Paused", stats.paused], ["archived", "Archived", stats.archived]];
  document.getElementById("tabs").innerHTML = tabs.map(([key, label, count]) => (
    '<div class="tab' + (state.tab === key ? " active" : "") + '" data-tab="' + key + '">' + h(label) + ' <span class="count">' + count + "</span></div>"
  )).join("");
}

function renderTable() {
  const campaigns = (state.dashboard.campaigns || [])
    .filter((view) => matchesTab(view, state.tab) && matchesQuery(view, state.query))
    .sort((a, b) => Number(b.campaign.updatedAt || 0) - Number(a.campaign.updatedAt || 0));
  const rows = document.getElementById("campaign-rows");
  document.getElementById("table-empty").hidden = campaigns.length > 0;
  rows.innerHTML = campaigns.map((view) => {
    const c = view.campaign;
    const busy = state.busyCampaignId === c.campaignId;
    const dateRange = dateTimeWithYear(c.startAt) + " → " + dateTimeWithYear(c.endAt);
    return '<tr class="row-clickable" data-open="' + h(c.campaignId) + '">'
      + '<td><div class="cell-title">' + h(c.title || c.internalName || c.campaignId) + '</div>'
      + '<div class="cell-sub">' + h(c.internalName) + '</div></td>'
      + '<td>' + kindBadge(c) + '</td>'
      + '<td>' + statusBadge(c) + '</td>'
      + '<td>' + h(rewardSummary(c)) + '</td>'
      + '<td><div class="cell-sub">' + h(dateRange) + '</div></td>'
      + '<td><div class="cell-sub">' + timeSlotsSummary(c) + '</div></td>'
      + '<td>' + h(view.totalRidersEnrolled || 0) + '</td>'
      + '<td>' + h(moneyPaise(view.totalAccruedPaise || 0)) + '</td>'
      + '<td><div class="cell-actions" data-stop>'
      + (busy ? '<span class="spinner dark"></span>' : rowActions(c))
      + '</div></td></tr>';
  }).join("");
}

function rowActions(c) {
  const edit = '<button class="icon-btn" data-action="edit" data-id="' + h(c.campaignId) + '" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>';
  const duplicate = '<button class="icon-btn" data-action="duplicate" data-id="' + h(c.campaignId) + '" title="Duplicate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg></button>';
  if (c.archived) {
    return edit + duplicate + '<button class="btn btn-tonal btn-sm" data-action="restore" data-id="' + h(c.campaignId) + '">Restore</button>';
  }
  const toggle = '<button class="btn btn-secondary btn-sm" data-action="toggle" data-id="' + h(c.campaignId) + '">' + (c.active ? "Pause" : "Resume") + '</button>';
  const archive = '<button class="btn btn-danger btn-sm" data-action="archive" data-id="' + h(c.campaignId) + '">Archive</button>';
  return edit + duplicate + toggle + archive;
}

function renderSettings() {
  const s = state.dashboard.settings || {};
  const chevron = document.getElementById("settings-chevron");
  chevron.style.transform = state.settingsOpen ? "rotate(180deg)" : "rotate(0deg)";
  document.getElementById("settings-body").hidden = !state.settingsOpen;
  if (!state.settingsOpen) return;
  document.getElementById("settings-body").innerHTML = `
    <form id="settings-form" class="form-grid">
      <div class="field"><label>Minimum payout ₹</label><input class="input" name="payoutMinimum" type="number" min="0" step="0.01" value="${h(moneyInput(s.payoutMinimumPaise))}"></div>
      <div class="field"><label>Referral min completed trips</label><input class="input" name="referralMinTrips" type="number" min="0" value="${h(s.referralMinCompletedTrips || 0)}"></div>
      <div class="field"><label>Inviter reward ₹</label><input class="input" name="inviterReward" type="number" min="0" step="0.01" value="${h(moneyInput(s.inviterRewardPaise))}"></div>
      <div class="field"><label>Invitee reward ₹</label><input class="input" name="inviteeReward" type="number" min="0" step="0.01" value="${h(moneyInput(s.inviteeRewardPaise))}"></div>
      <div class="field"><label>Referral max rewards / rider</label><input class="input" name="referralMaxRewards" type="number" min="0" value="${h(s.referralMaxRewardsPerRider || 0)}"></div>
      <div class="field" style="justify-content:flex-end;"><label class="checkbox-row"><input type="checkbox" name="referralProgramActive" ${s.referralProgramActive ? "checked" : ""}> Referral program active</label></div>
      <div class="field full"><button class="btn btn-primary" type="submit">Save settings</button></div>
    </form>`;
  document.getElementById("settings-form").addEventListener("submit", onSaveSettings);
}

function render() {
  renderStats();
  renderSettings();
  renderTabs();
  renderTable();
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------
async function onSaveSettings(event) {
  event.preventDefault();
  const form = event.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const original = submitBtn.textContent;
  submitBtn.innerHTML = '<span class="spinner dark"></span> Saving…';
  try {
    const payload = {
      operationId: operationId("reward_settings"),
      expectedUpdatedAt: state.dashboard.settings.updatedAt,
      payoutMinimumPaise: moneyToPaise(form.elements.payoutMinimum.value),
      referralProgramActive: form.elements.referralProgramActive.checked,
      inviterRewardPaise: moneyToPaise(form.elements.inviterReward.value),
      inviteeRewardPaise: moneyToPaise(form.elements.inviteeReward.value),
      referralMinCompletedTrips: intOrUndefined(form.elements.referralMinTrips.value) ?? 0,
      referralMaxRewardsPerRider: intOrUndefined(form.elements.referralMaxRewards.value) ?? 0,
    };
    await callFunction("updateRiderRewardSettingsPolicy", payload);
    toast("Settings saved.", "success");
    await loadDashboard(false);
  } catch (error) {
    toast("Settings save failed. " + error.message, "danger");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = original;
  }
}

async function mutateCampaign(campaignId, mutate, successMessage) {
  const view = (state.dashboard.campaigns || []).find((v) => v.campaign.campaignId === campaignId);
  if (!view) return;
  state.busyCampaignId = campaignId;
  renderTable();
  try {
    const next = mutate(JSON.parse(JSON.stringify(view.campaign)));
    await callFunction("upsertRiderRewardCampaignPolicy", {
      operationId: operationId("reward"),
      campaignId: view.campaign.campaignId,
      expectedUpdatedAt: view.campaign.updatedAt,
      campaign: sanitizeCampaignForWrite(next),
    });
    toast(successMessage, "success");
    await loadDashboard(false);
  } catch (error) {
    toast("Campaign update failed. " + error.message, "danger");
  } finally {
    state.busyCampaignId = "";
    renderTable();
  }
}

// ---------------------------------------------------------------------------
// create / edit drawer
// ---------------------------------------------------------------------------
const DISPLAY_TYPES = ["trip_milestone", "surge", "rain_surge", "shift_bonus", "daily_incentive", "weekly_incentive", "zone_bonus", "special_campaign"];
const SECTIONS = ["breakfast", "lunch", "snacks", "dinner", "late_night", "special"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function optionList(values, selected) {
  return values.map((v) => '<option value="' + v + '"' + (v === selected ? " selected" : "") + '">' + v.replace(/_/g, " ") + "</option>").join("");
}

function openDrawer(sourceCampaign, mode) {
  const isEdit = mode === "edit";
  const isDuplicate = mode === "duplicate";
  const seed = sourceCampaign ? JSON.parse(JSON.stringify(sourceCampaign)) : {
    kind: "per_order_bonus", displayType: "surge", section: "special", window: "daily",
    startAt: Date.now(), endAt: Date.now() + 7 * 86400000, eligibleDays: [0, 1, 2, 3, 4, 5, 6],
    timezone: "Asia/Kolkata", priority: 100, stacking: "stack", visible: true, active: true,
    timeSlots: [], milestones: [], cityNames: [], zoneNames: [], restaurantIds: [], riderIds: [],
    eligibleRiderTypes: [], vehicleTypes: [],
  };
  if (isDuplicate) {
    seed.campaignId = "";
    seed.title = (seed.title || "") + " copy";
    seed.internalName = (seed.internalName || "") + "-copy";
    seed.archived = false;
    seed.active = false;
    seed.updatedAt = 0;
  }
  const draft = {
    milestones: (seed.milestones || []).map((m) => ({key: uid("ms_"), target: m.target, reward: moneyInput(m.rewardAmountPaise), label: m.label || ""})),
    timeSlots: (seed.timeSlots || []).map((s) => ({key: uid("ts_"), label: s.label || "", start: minuteToHHMM(s.startMinute), end: minuteToHHMM(s.endMinute)})),
  };

  const root = document.getElementById("drawer-root");
  root.innerHTML = "";
  const overlay = el('<div class="overlay"></div>');
  const drawer = el(`
    <div class="drawer">
      <div class="drawer-head">
        <h2 style="font-size:16px;">${isEdit ? "Edit campaign" : isDuplicate ? "Duplicate campaign" : "New campaign"}</h2>
        <button class="icon-btn" id="drawer-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="drawer-body">
        <form id="campaign-form">
          <div class="section-title">Basics</div>
          <div class="form-grid">
            <div class="field"><label>Internal name</label><input class="input" name="internalName" required value="${h(seed.internalName || "")}"></div>
            <div class="field"><label>Offer title</label><input class="input" name="title" required value="${h(seed.title || "")}"></div>
            <div class="field full"><label>Subtitle</label><input class="input" name="subtitle" value="${h(seed.subtitle || "")}"></div>
            <div class="field full"><label>Description</label><textarea class="textarea" name="description">${h(seed.description || "")}</textarea></div>
            <div class="field"><label>Kind</label><select class="select" name="kind">
              <option value="per_order_bonus"${seed.kind === "per_order_bonus" ? " selected" : ""}>Per-order bonus</option>
              <option value="milestone_bonus"${seed.kind === "milestone_bonus" ? " selected" : ""}>Milestone bonus</option>
            </select></div>
            <div class="field"><label>Priority</label><input class="input" name="priority" type="number" min="0" max="1000" value="${h(seed.priority || 100)}"></div>
            <div class="field"><label>Display type</label><select class="select" name="displayType">${optionList(DISPLAY_TYPES, seed.displayType)}</select></div>
            <div class="field"><label>Section</label><select class="select" name="section">${optionList(SECTIONS, seed.section)}</select></div>
            <div class="field"><label>Stacking</label><select class="select" name="stacking">
              <option value="stack"${seed.stacking === "stack" ? " selected" : ""}>Stack with other campaigns</option>
              <option value="highest_only"${seed.stacking === "highest_only" ? " selected" : ""}>Highest reward only</option>
            </select></div>
            <div class="field"><label>Timezone</label><input class="input" name="timezone" value="${h(seed.timezone || "Asia/Kolkata")}"></div>
            <div class="field full">
              <label class="checkbox-row"><input type="checkbox" name="visible" ${seed.visible !== false ? "checked" : ""}> Visible in Rider app</label>
              <label class="checkbox-row" style="margin-top:6px;"><input type="checkbox" name="active" ${seed.active !== false ? "checked" : ""}> Active and payable</label>
            </div>
          </div>

          <div class="section-title">Schedule</div>
          <div class="form-grid">
            <div class="field"><label>Start</label><input class="input" name="startAt" type="datetime-local" required value="${h(datetimeLocalValue(seed.startAt))}"></div>
            <div class="field"><label>End</label><input class="input" name="endAt" type="datetime-local" required value="${h(datetimeLocalValue(seed.endAt))}"></div>
            <div class="field full"><label>Applicable days</label>
              <div class="chip-row" id="day-chips">
                ${DAY_LABELS.map((label, i) => '<button type="button" class="chip" data-day="' + i + '" data-selected="' + ((seed.eligibleDays || []).includes(i) ? "1" : "0") + '">' + label + "</button>").join("")}
              </div>
            </div>
          </div>

          <div class="section-title">Reward</div>
          <div id="reward-section"></div>

          <div class="section-title">Who qualifies</div>
          <div class="form-grid">
            <div class="field"><label>Eligible cities</label><textarea class="textarea" name="cityNames" placeholder="One per line">${h(arrayToLines(seed.cityNames))}</textarea></div>
            <div class="field"><label>Eligible zones</label><textarea class="textarea" name="zoneNames" placeholder="One per line">${h(arrayToLines(seed.zoneNames))}</textarea></div>
            <div class="field"><label>Restaurant IDs</label><textarea class="textarea" name="restaurantIds">${h(arrayToLines(seed.restaurantIds))}</textarea></div>
            <div class="field"><label>Specific rider IDs</label><textarea class="textarea" name="riderIds">${h(arrayToLines(seed.riderIds))}</textarea></div>
            <div class="field"><label>Eligible rider categories</label><textarea class="textarea" name="eligibleRiderTypes">${h(arrayToLines(seed.eligibleRiderTypes))}</textarea></div>
            <div class="field"><label>Vehicle types</label><textarea class="textarea" name="vehicleTypes">${h(arrayToLines(seed.vehicleTypes))}</textarea></div>
            <div class="field"><label>Minimum completed trips</label><input class="input" name="minCompletedTrips" type="number" min="0" value="${h(seed.minCompletedTrips ?? "")}"></div>
            <div class="field"><label>Minimum rating</label><input class="input" name="minRating" type="number" min="0" max="5" step="0.1" value="${h(seed.minRating ?? "")}"></div>
            <div class="field"><label>First N completed trips only</label><input class="input" name="firstNCompletedTrips" type="number" min="1" value="${h(seed.firstNCompletedTrips ?? "")}"></div>
            <div class="field"><label>Minimum account age (days)</label><input class="input" name="minimumAccountAgeDays" type="number" min="0" value="${h(seed.minimumAccountAgeDays ?? "")}"></div>
            <div class="field"><label>Minimum order value ₹</label><input class="input" name="orderTotalMin" type="number" min="0" step="0.01" value="${h(moneyInput(seed.orderTotalMinPaise || 0))}"></div>
            <div class="field" style="justify-content:flex-end;"><label class="checkbox-row"><input type="checkbox" name="rainOnly" ${seed.rainOnly ? "checked" : ""}> Rain-only campaign</label></div>
          </div>

          ${seed.kind === "milestone_bonus" && ((seed.conditionGroups || []).length || seed.requireDailyLoginSession) ? `
          <div class="notice notice-info">This campaign also has login-condition rules (grouped time slots, daily session requirements) configured in the Admin app. This panel does not yet edit those — saving here leaves them exactly as they are.</div>
          ` : ""}
          <div id="form-error" class="notice notice-danger" hidden></div>
        </form>
      </div>
      <div class="drawer-foot">
        <button class="btn btn-secondary" id="drawer-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="drawer-save" type="submit" form="campaign-form">Save campaign</button>
      </div>
    </div>`);
  overlay.appendChild(drawer);
  root.appendChild(overlay);

  function renderRewardSection() {
    const kind = drawer.querySelector('select[name="kind"]').value;
    const box = drawer.querySelector("#reward-section");
    if (kind === "per_order_bonus") {
      box.innerHTML = `
        <div class="field"><label>Reward amount ₹ per order</label><input class="input" name="rewardAmount" type="number" min="0" step="0.01" value="${h(moneyInput(seed.kind === "per_order_bonus" ? seed.rewardAmountPaise : 0))}" required></div>
        <div class="field"><label>Time slots</label><div id="timeslot-rows"></div>
          <button type="button" class="chip" id="add-timeslot">+ Add time slot</button>
          <p class="hint" style="margin-top:6px;">Leave empty for an all-day offer. Times are 24-hour, local to the timezone above.</p>
        </div>`;
      renderTimeSlotRows();
      box.querySelector("#add-timeslot").addEventListener("click", () => {
        draft.timeSlots.push({key: uid("ts_"), label: "", start: "", end: ""});
        renderTimeSlotRows();
      });
    } else {
      box.innerHTML = `
        <div class="field"><label>Milestones</label><div id="milestone-rows"></div>
          <button type="button" class="chip" id="add-milestone">+ Add milestone</button>
        </div>`;
      renderMilestoneRows();
      box.querySelector("#add-milestone").addEventListener("click", () => {
        if (draft.milestones.length >= 20) return;
        draft.milestones.push({key: uid("ms_"), target: "", reward: "", label: ""});
        renderMilestoneRows();
      });
    }
  }

  function renderTimeSlotRows() {
    const box = drawer.querySelector("#timeslot-rows");
    if (!box) return;
    box.innerHTML = draft.timeSlots.map((s) => (
      '<div class="repeat-row" data-key="' + s.key + '">'
      + '<div class="field" style="margin:0;"><label>Label</label><input class="input" data-field="label" value="' + h(s.label) + '"></div>'
      + '<div class="field" style="margin:0;"><label>Start</label><input class="input" type="time" data-field="start" value="' + h(s.start) + '"></div>'
      + '<div class="field" style="margin:0;"><label>End</label><input class="input" type="time" data-field="end" value="' + h(s.end) + '"></div>'
      + '<button type="button" class="icon-btn" data-remove-timeslot="' + s.key + '">✕</button></div>'
    )).join("") || '<p class="hint">No time slots yet.</p>';
    box.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const row = draft.timeSlots.find((s) => s.key === input.closest("[data-key]").dataset.key);
        row[input.dataset.field] = input.value;
      });
    });
    box.querySelectorAll("[data-remove-timeslot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        draft.timeSlots = draft.timeSlots.filter((s) => s.key !== btn.dataset.removeTimeslot);
        renderTimeSlotRows();
      });
    });
  }

  function renderMilestoneRows() {
    const box = drawer.querySelector("#milestone-rows");
    if (!box) return;
    box.innerHTML = draft.milestones.map((m) => (
      '<div class="repeat-row" data-key="' + m.key + '">'
      + '<div class="field" style="margin:0;"><label>Trips</label><input class="input" type="number" min="1" data-field="target" value="' + h(m.target) + '"></div>'
      + '<div class="field" style="margin:0;"><label>Reward ₹</label><input class="input" type="number" min="0" step="0.01" data-field="reward" value="' + h(m.reward) + '"></div>'
      + '<div class="field" style="margin:0;"><label>Label</label><input class="input" data-field="label" value="' + h(m.label) + '"></div>'
      + '<button type="button" class="icon-btn" data-remove-milestone="' + m.key + '">✕</button></div>'
    )).join("") || '<p class="hint">No milestones yet.</p>';
    box.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const row = draft.milestones.find((m) => m.key === input.closest("[data-key]").dataset.key);
        row[input.dataset.field] = input.value;
      });
    });
    box.querySelectorAll("[data-remove-milestone]").forEach((btn) => {
      btn.addEventListener("click", () => {
        draft.milestones = draft.milestones.filter((m) => m.key !== btn.dataset.removeMilestone);
        renderMilestoneRows();
      });
    });
  }

  renderRewardSection();
  drawer.querySelector('select[name="kind"]').addEventListener("change", renderRewardSection);

  function paintDayChip(chip) {
    const on = chip.dataset.selected === "1";
    chip.style.background = on ? "var(--brand-soft)" : "";
    chip.style.color = on ? "var(--brand-strong)" : "";
    chip.style.borderColor = on ? "var(--brand)" : "";
  }
  drawer.querySelectorAll("#day-chips [data-day]").forEach((chip) => {
    paintDayChip(chip);
    chip.addEventListener("click", () => {
      chip.dataset.selected = chip.dataset.selected === "1" ? "0" : "1";
      paintDayChip(chip);
    });
  });

  function closeDrawer() { root.innerHTML = ""; }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDrawer(); });
  drawer.querySelector("#drawer-close").addEventListener("click", closeDrawer);
  drawer.querySelector("#drawer-cancel").addEventListener("click", closeDrawer);

  drawer.querySelector("#campaign-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const errorBox = drawer.querySelector("#form-error");
    errorBox.hidden = true;
    const saveBtn = drawer.querySelector("#drawer-save");
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      const kind = form.elements.kind.value;
      const eligibleDays = Array.from(drawer.querySelectorAll("#day-chips [data-day]"))
        .filter((c) => c.dataset.selected === "1").map((c) => Number(c.dataset.day));
      const formValues = {
        internalName: form.elements.internalName.value.trim(),
        title: form.elements.title.value.trim(),
        subtitle: form.elements.subtitle.value.trim(),
        description: form.elements.description.value.trim(),
        kind,
        displayType: form.elements.displayType.value,
        section: form.elements.section.value,
        window: seed.window || "daily",
        startAt: datetimeLocalToEpoch(form.elements.startAt.value),
        endAt: datetimeLocalToEpoch(form.elements.endAt.value),
        eligibleDays,
        timezone: form.elements.timezone.value.trim() || "Asia/Kolkata",
        priority: intOrUndefined(form.elements.priority.value) ?? 100,
        stacking: form.elements.stacking.value,
        visible: form.elements.visible.checked,
        active: form.elements.active.checked,
        cityNames: linesToArray(form.elements.cityNames.value),
        zoneNames: linesToArray(form.elements.zoneNames.value),
        restaurantIds: linesToArray(form.elements.restaurantIds.value),
        riderIds: linesToArray(form.elements.riderIds.value),
        eligibleRiderTypes: linesToArray(form.elements.eligibleRiderTypes.value),
        vehicleTypes: linesToArray(form.elements.vehicleTypes.value),
        minCompletedTrips: intOrUndefined(form.elements.minCompletedTrips.value),
        minRating: floatOrUndefined(form.elements.minRating.value),
        firstNCompletedTrips: intOrUndefined(form.elements.firstNCompletedTrips.value),
        minimumAccountAgeDays: intOrUndefined(form.elements.minimumAccountAgeDays.value),
        orderTotalMinPaise: moneyToPaise(form.elements.orderTotalMin.value) || undefined,
        rainOnly: form.elements.rainOnly.checked,
      };
      if (kind === "per_order_bonus") {
        formValues.rewardAmountPaise = moneyToPaise(form.elements.rewardAmount.value);
        formValues.timeSlots = draft.timeSlots
          .filter((s) => s.label.trim() && s.start && s.end)
          .map((s) => ({label: s.label.trim(), startMinute: timeMinuteFromHHMM(s.start), endMinute: timeMinuteFromHHMM(s.end)}))
          .filter((s) => s.startMinute !== null && s.endMinute !== null && s.startMinute !== s.endMinute);
      } else {
        formValues.milestones = draft.milestones
          .filter((m) => m.target !== "" && m.reward !== "")
          .map((m) => ({target: intOrUndefined(m.target), rewardAmountPaise: moneyToPaise(m.reward), label: m.label.trim()}))
          .filter((m) => m.target && m.rewardAmountPaise);
      }

      const payload = buildCampaignPayload(isEdit ? sourceCampaign : null, formValues);
      const campaignId = isEdit ? sourceCampaign.campaignId : slug(formValues.internalName || formValues.title) + "-" + Date.now().toString(36).slice(-6);
      await callFunction("upsertRiderRewardCampaignPolicy", {
        operationId: operationId("reward_campaign"),
        campaignId,
        expectedUpdatedAt: isEdit ? sourceCampaign.updatedAt : undefined,
        campaign: payload,
      });
      toast(isEdit ? "Campaign saved." : "Campaign created.", "success");
      closeDrawer();
      await loadDashboard(false);
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || "Campaign save failed.";
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  });
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
function findCampaign(id) {
  const view = (state.dashboard.campaigns || []).find((v) => v.campaign.campaignId === id);
  return view ? view.campaign : null;
}

document.getElementById("campaign-rows").addEventListener("click", (event) => {
  const actionBtn = event.target.closest("[data-action]");
  if (actionBtn) {
    const id = actionBtn.dataset.id;
    const action = actionBtn.dataset.action;
    if (action === "edit") return openDrawer(findCampaign(id), "edit");
    if (action === "duplicate") return openDrawer(findCampaign(id), "duplicate");
    if (action === "toggle") {
      const c = findCampaign(id);
      return mutateCampaign(id, (draft) => Object.assign(draft, {active: !draft.active}), "Campaign visibility updated.");
    }
    if (action === "archive") return mutateCampaign(id, (draft) => Object.assign(draft, {archived: true, active: false}), "Campaign archived.");
    if (action === "restore") return mutateCampaign(id, (draft) => Object.assign(draft, {archived: false}), "Campaign restored from archive. It is paused until you Resume it.");
    return;
  }
  const row = event.target.closest("tr[data-open]");
  if (row) openDrawer(findCampaign(row.dataset.open), "edit");
});

document.getElementById("tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  state.tab = tab.dataset.tab;
  renderTabs();
  renderTable();
});

document.getElementById("search-input").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderTable();
});
document.getElementById("refresh-btn").addEventListener("click", () => loadDashboard(true));
document.getElementById("new-campaign-btn").addEventListener("click", () => openDrawer(null, "new"));
document.getElementById("settings-toggle").addEventListener("click", () => {
  state.settingsOpen = !state.settingsOpen;
  renderSettings();
});
document.getElementById("signout-btn").addEventListener("click", () => signOutUser());

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
requireAdminSession().then((sessionState) => {
  if (!sessionState) return;
  document.getElementById("app-shell").hidden = false;
  document.getElementById("sidebar-who").textContent = sessionState.user.email + " · " + sessionState.claims.savrivoRole;
  loadDashboard(true);
});

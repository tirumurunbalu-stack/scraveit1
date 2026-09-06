#!/usr/bin/env node

import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {isDeepStrictEqual} from "node:util";

const DEFAULT_PROJECT_ID = "savrivo-app";
const REWARDS_ROOT = "/feastly/private/riderRewards";
const WINDOW_START_AT = Date.parse("2026-08-24T00:00:00+05:30");
const WINDOW_END_AT = Date.parse("2026-09-01T00:00:00+05:30");

function usage() {
  return [
    "Seed editable staging rider reward campaigns (dry-run by default).",
    "",
    "Options:",
    "  --project=<id>     Firebase project id. Defaults to savrivo-app.",
    "  --apply            Write the staging settings/campaigns.",
    "  --help             Show this help.",
    "",
    "Safety:",
    "  Apply requires SAVRIVO_CONFIRM_PROJECT_ID to exactly match the selected project.",
  ].join("\n");
}

function parseOptions(argv) {
  const options = {
    projectId: DEFAULT_PROJECT_ID,
    apply: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--project=")) options.projectId = String(arg.slice("--project=".length) || "").trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.projectId) throw new Error("A Firebase project id is required.");
  return options;
}

function firebaseJson(projectId, path) {
  try {
    const raw = execFileSync("firebase", ["database:get", path, "--project", projectId], {encoding: "utf8"});
    return JSON.parse(raw || "null");
  } catch (error) {
    const output = String(error?.stderr || error?.stdout || error?.message || "").toLowerCase();
    if (output.includes("path not found") || output.includes("null")) return null;
    throw error;
  }
}

function firebaseSet(projectId, path, value) {
  const directory = mkdtempSync(join(tmpdir(), "savrivo-rider-reward-seed-"));
  const file = join(directory, "payload.json");
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
    execFileSync("firebase", [
      "database:set",
      path,
      file,
      "--project",
      projectId,
      "--force",
      "--disable-triggers",
    ], {encoding: "utf8"});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

function upsertTarget(projectId, path, nextValue, apply, counters) {
  const current = firebaseJson(projectId, path);
  if (isDeepStrictEqual(current, nextValue)) {
    counters.unchanged += 1;
    return;
  }
  if (!apply) {
    counters.planned += 1;
    return;
  }
  firebaseSet(projectId, path, nextValue);
  counters.applied += 1;
}

function slot(label, startMinute, endMinute) {
  return {label, startMinute, endMinute};
}

function milestone(target, rupees, label) {
  return {
    target,
    rewardAmountPaise: rupees * 100,
    label,
  };
}

function seedPayload(now) {
  const settings = {
    schemaVersion: 1,
    payoutMinimumPaise: 30000,
    referralProgramActive: true,
    inviterRewardPaise: 50_000,
    inviteeRewardPaise: 0,
    referralMinCompletedTrips: 25,
    referralMaxRewardsPerRider: 0,
    updatedAt: now,
    updatedBy: "codex-staging-seed",
    updatedByRole: "owner",
    lastOperationId: "stg-20260828-rider-reward-settings",
  };

  const base = {
    schemaVersion: 1,
    startAt: WINDOW_START_AT,
    endAt: WINDOW_END_AT,
    eligibleDays: [0, 1, 2, 3, 4, 5, 6],
    cityNames: [],
    zoneNames: [],
    restaurantIds: [],
    riderIds: [],
    minCompletedTrips: undefined,
    minRating: undefined,
    firstNCompletedTrips: undefined,
    orderTotalMinPaise: undefined,
    rainOnly: false,
    visible: true,
    active: true,
    archived: false,
    updatedAt: now,
    updatedBy: "codex-staging-seed",
    updatedByRole: "owner",
  };

  const campaigns = {
    "live-20260828-daily-extra-earnings": {
      ...base,
      internalName: "live-daily-extra-earnings",
      title: "Daily Extra Earnings",
      subtitle: "Complete 8, 13, 18, 23, 28 and 32 orders today to unlock bigger bonuses",
      description: "Server-authoritative daily incentives with grouped login conditions, daily resets and payout-safe milestone crediting.",
      kind: "milestone_bonus",
      displayType: "daily_incentive",
      section: "special",
      requireDailyLoginSession: true,
      minimumCompletedSessionsPerDay: 2,
      conditionGroups: [
        {
          groupId: "login_group_1",
          title: "Login Group 1",
          minimumSlotsRequired: 1,
          slots: [
            {slotId: "g1_6_8", label: "6 AM – 8 AM", startMinute: 6 * 60, endMinute: 8 * 60, offlineToleranceMinutes: 10, gracePeriodMinutes: 0, overlapMode: "no_double_count", disabledCityNames: []},
            {slotId: "g1_8_11", label: "8 AM – 11 AM", startMinute: 8 * 60, endMinute: 11 * 60, offlineToleranceMinutes: 10, gracePeriodMinutes: 0, overlapMode: "no_double_count", disabledCityNames: []},
            {slotId: "g1_16_19", label: "4 PM – 7 PM", startMinute: 16 * 60, endMinute: 19 * 60, offlineToleranceMinutes: 10, gracePeriodMinutes: 0, overlapMode: "no_double_count", disabledCityNames: []},
          ],
        },
        {
          groupId: "login_group_2",
          title: "Login Group 2",
          minimumSlotsRequired: 1,
          slots: [
            {slotId: "g2_11_16", label: "11 AM – 4 PM", startMinute: 11 * 60, endMinute: 16 * 60, offlineToleranceMinutes: 10, gracePeriodMinutes: 0, overlapMode: "no_double_count", disabledCityNames: []},
            {slotId: "g2_19_23", label: "7 PM – 11 PM", startMinute: 19 * 60, endMinute: 23 * 60, offlineToleranceMinutes: 10, gracePeriodMinutes: 0, overlapMode: "no_double_count", disabledCityNames: []},
          ],
        },
      ],
      otherConditions: [
        {conditionId: "max_rejected_orders", type: "max_rejected_orders", title: "Order rejections", maximumCount: 1, enabled: true},
        {conditionId: "max_cancelled_shifts", type: "max_cancelled_booked_shifts", title: "Cancelled booked shifts", maximumCount: 1, enabled: true},
        {conditionId: "max_incomplete_shifts", type: "max_incomplete_shifts", title: "Incomplete shifts", maximumCount: 1, enabled: true},
      ],
      milestones: [
        milestone(8, 50, "Complete 8 orders"),
        milestone(13, 85, "Complete 13 orders"),
        milestone(18, 125, "Complete 18 orders"),
        milestone(23, 175, "Complete 23 orders"),
        milestone(28, 225, "Complete 28 orders"),
        milestone(32, 300, "Complete 32 orders"),
      ],
      window: "daily",
      timeSlots: [
        slot("6 AM – 8 AM", 6 * 60, 8 * 60),
        slot("8 AM – 11 AM", 8 * 60, 11 * 60),
        slot("11 AM – 4 PM", 11 * 60, 16 * 60),
        slot("4 PM – 7 PM", 16 * 60, 19 * 60),
        slot("7 PM – 11 PM", 19 * 60, 23 * 60),
      ],
      stacking: "highest_only",
      priority: 400,
      lastOperationId: "live-20260829-daily-extra-earnings-milestones",
    },
    "live-20260828-weekly-incentive-v2": {
      ...base,
      internalName: "live-weekly-incentive-v2",
      title: "Legacy weekly incentive",
      subtitle: "Archived after switching staging to the daily rider cycle",
      description: "Kept only as an archived record so staging no longer serves the older weekly login-cycle incentive.",
      kind: "milestone_bonus",
      displayType: "weekly_incentive",
      section: "special",
      milestones: [
        milestone(8, 50, "Complete 8 orders"),
        milestone(13, 80, "Complete 13 orders"),
        milestone(18, 125, "Complete 18 orders"),
        milestone(23, 175, "Complete 23 orders"),
        milestone(28, 225, "Complete 28 orders"),
        milestone(32, 300, "Complete 32 orders"),
      ],
      window: "weekly",
      requireDailyLoginSession: true,
      minimumCompletedSessionsPerDay: 2,
      timeSlots: [
        slot("Breakfast", 6 * 60, 8 * 60),
        slot("Morning", 8 * 60, 11 * 60),
        slot("Lunch", 11 * 60, 16 * 60),
        slot("Evening", 16 * 60, 19 * 60),
        slot("Night", 19 * 60, 23 * 60),
        slot("Late night", 23 * 60, 2 * 60),
        slot("Early morning", 2 * 60, 6 * 60),
      ],
      stacking: "highest_only",
      priority: 500,
      visible: false,
      active: false,
      archived: true,
      lastOperationId: "live-20260828-weekly-incentive-v2-archived",
    },
    "stg-20260827-weekly-incentive": {
      ...base,
      internalName: "stg-weekly-incentive",
      title: "Legacy weekly incentive",
      subtitle: "Archived after switching staging to the daily rider cycle",
      description: "Kept only as an archived record so staging does not keep rendering the older weekly login rule.",
      kind: "milestone_bonus",
      displayType: "weekly_incentive",
      section: "special",
      milestones: [milestone(18, 125, "Complete 18 orders")],
      window: "weekly",
      timeSlots: [slot("Night", 19 * 60, 23 * 60)],
      stacking: "highest_only",
      priority: 350,
      visible: false,
      active: false,
      archived: true,
      lastOperationId: "stg-20260828-weekly-archived",
    },
    "stg-20260827-lunch-maxx-bonus": {
      ...base,
      internalName: "stg-lunch-maxx-bonus",
      title: "Maxx Bonus",
      subtitle: "₹10 extra per order",
      description: "Valid across the lunch rush.",
      kind: "per_order_bonus",
      displayType: "surge",
      section: "lunch",
      rewardAmountPaise: 1000,
      milestones: [],
      window: "daily",
      timeSlots: [slot("Lunch", 12 * 60, 15 * 60)],
      stacking: "stack",
      priority: 300,
      lastOperationId: "stg-20260827-lunch-maxx-bonus",
    },
    "stg-20260827-snacks-surge": {
      ...base,
      internalName: "stg-snacks-surge",
      title: "Surge",
      subtitle: "₹10 extra per order",
      description: "Valid for the snacks window.",
      kind: "per_order_bonus",
      displayType: "surge",
      section: "snacks",
      rewardAmountPaise: 1000,
      milestones: [],
      window: "daily",
      timeSlots: [slot("Snacks", 17 * 60, 19 * 60)],
      stacking: "stack",
      priority: 250,
      lastOperationId: "stg-20260827-snacks-surge",
    },
    "live-20260828-late-night-fee": {
      ...base,
      internalName: "live-late-night-fee",
      title: "Late-night extra",
      subtitle: "₹10 extra per order",
      description: "Valid for eligible completed orders in the 11 PM – 2 AM slot.",
      kind: "per_order_bonus",
      displayType: "surge",
      section: "late_night",
      rewardAmountPaise: 1000,
      milestones: [],
      window: "daily",
      timeSlots: [slot("Late night", 23 * 60, 2 * 60)],
      stacking: "stack",
      priority: 240,
      lastOperationId: "live-20260828-late-night-fee",
    },
    "live-20260828-early-morning-fee": {
      ...base,
      internalName: "live-early-morning-fee",
      title: "Early-morning extra",
      subtitle: "₹10 extra per order",
      description: "Default 2 AM – 6 AM extra pay. Admin can change the amount or city scope later.",
      kind: "per_order_bonus",
      displayType: "surge",
      section: "late_night",
      rewardAmountPaise: 1000,
      milestones: [],
      window: "daily",
      timeSlots: [slot("Early morning", 2 * 60, 6 * 60)],
      stacking: "stack",
      priority: 235,
      lastOperationId: "live-20260828-early-morning-fee",
    },
  };

  return {settings, campaigns};
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.apply) {
    const confirmation = String(process.env.SAVRIVO_CONFIRM_PROJECT_ID ?? "").trim();
    if (confirmation !== options.projectId) {
      throw new Error("SAVRIVO_CONFIRM_PROJECT_ID must exactly match the selected project id.");
    }
  }

  const now = Date.now();
  const payload = seedPayload(now);
  const counters = {planned: 0, applied: 0, unchanged: 0};

  upsertTarget(options.projectId, `${REWARDS_ROOT}/settings`, payload.settings, options.apply, counters);
  for (const [campaignId, campaign] of Object.entries(payload.campaigns)) {
    upsertTarget(options.projectId, `${REWARDS_ROOT}/campaigns/${campaignId}`, campaign, options.apply, counters);
  }

  console.log(JSON.stringify({
    projectId: options.projectId,
    apply: options.apply,
    settingsPath: `${REWARDS_ROOT}/settings`,
    campaignCount: Object.keys(payload.campaigns).length,
    plannedWrites: counters.planned,
    appliedWrites: counters.applied,
    unchanged: counters.unchanged,
    activeWindow: {
      startAt: WINDOW_START_AT,
      endAt: WINDOW_END_AT,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});

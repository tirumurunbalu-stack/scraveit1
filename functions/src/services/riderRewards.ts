import {createHash} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
import {financePayoutAutomationSummary} from "../domain/financePolicy";
import {createLedgerJournal, validateLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {DomainError} from "../errors";
import type {
  AdminRiderRewardsDashboardQueryInput,
  RiderRewardsDashboardQueryInput,
  UpdateRiderRewardSettingsInput,
  UpsertRiderRewardCampaignInput,
} from "../schemas";
import type {SavrivoOrder} from "../types";
import {
  requireApprovedRider,
  requirePlatformConfigAdminClaim,
  type PlatformConfigAdminRole,
} from "./authz";
import {LEDGER_JOURNALS_ROOT, persistLedgerJournal, type LedgerTransactionDatabase} from "./ledger";
import {notifyRiderRewardUpdate} from "./notifications";
import {loadFinancePolicy} from "./platformConfig";
import {readRiderFinancialSummary, type RiderFinancialSummary} from "./riderFinance";

const IST_OFFSET_MS = 330 * 60 * 1_000;
const DEFAULT_REWARD_TIMEZONE = "Asia/Kolkata";
const PRESENCE_HEARTBEAT_TIMEOUT_MS = 90_000;

export const RIDER_REWARDS_ROOT = `${ROOT}/private/riderRewards`;
export const RIDER_REWARD_CAMPAIGNS_ROOT = `${RIDER_REWARDS_ROOT}/campaigns`;
export const RIDER_REWARD_SETTINGS_ROOT = `${RIDER_REWARDS_ROOT}/settings`;
export const RIDER_REWARD_SESSION_DAYS_ROOT = `${RIDER_REWARDS_ROOT}/sessionDays`;
export const RIDER_REWARD_ACTIVITY_EVENTS_ROOT = `${RIDER_REWARDS_ROOT}/activityEvents`;
export const RIDER_REWARD_PROGRESS_ROOT = `${RIDER_REWARDS_ROOT}/progress`;
export const RIDER_REWARD_CAMPAIGN_PROGRESS_ROOT = `${RIDER_REWARDS_ROOT}/campaignProgress`;
export const RIDER_REWARD_REFERRAL_IDENTITIES_ROOT = `${RIDER_REWARDS_ROOT}/referralIdentities`;
export const RIDER_REWARD_REFERRAL_CODES_ROOT = `${RIDER_REWARDS_ROOT}/referralCodes`;

interface ValueSnapshot {
  val(): unknown;
}

interface TransactionResult {
  committed: boolean;
  snapshot: ValueSnapshot;
}

interface RewardReference {
  orderByChild(child: string): RewardReference;
  startAt(value: string | number): RewardReference;
  endAt(value: string | number): RewardReference;
  limitToLast(limit: number): RewardReference;
  limitToFirst(limit: number): RewardReference;
  get(): Promise<ValueSnapshot>;
  set(value: unknown): Promise<void>;
  transaction(
    update: (current: unknown) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<TransactionResult>;
}

export interface RiderRewardsDatabase extends LedgerTransactionDatabase {
  ref(path: string): RewardReference;
}

type RewardSection = "breakfast" | "lunch" | "snacks" | "dinner" | "late_night" | "special";
type RewardDisplayType =
  | "trip_milestone"
  | "surge"
  | "rain_surge"
  | "shift_bonus"
  | "daily_incentive"
  | "weekly_incentive"
  | "zone_bonus"
  | "special_campaign";
type RewardKind = "per_order_bonus" | "milestone_bonus";
type RewardWindow = "daily" | "weekly" | "custom";
type RewardStacking = "stack" | "highest_only";
type RewardMilestonePayoutMode = "highest_unlocked" | "cumulative";
type RewardTripAttribution = "delivered_at";
type RewardSlotOverlapMode = "no_double_count" | "allow_double_count";
type RiderRewardOfferStatus =
  | "available"
  | "future"
  | "unavailable"
  | "locked"
  | "eligible_delivery_match_required"
  | "completed"
  | "UPCOMING"
  | "ACTIVE"
  | "IN_PROGRESS"
  | "QUALIFIED"
  | "COMPLETED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "PAID";
type RiderRewardActivityEventType =
  | "ONLINE"
  | "HEARTBEAT"
  | "OFFLINE"
  | "ORDER_ASSIGNED"
  | "ORDER_ACCEPTED"
  | "ORDER_PICKED_UP"
  | "ORDER_DELIVERED"
  | "ORDER_REJECTED"
  | "ORDER_CANCELLED_AFTER_ACCEPT"
  | "SHIFT_CANCELLED"
  | "BREAK_STARTED"
  | "BREAK_ENDED"
  | "APP_DISCONNECTED";
type RiderRewardOtherConditionType =
  | "max_rejected_orders"
  | "max_cancelled_booked_shifts"
  | "max_incomplete_shifts"
  | "max_cancelled_accepted_orders"
  | "min_acceptance_rate"
  | "min_completion_rate"
  | "min_customer_rating"
  | "max_offline_duration_minutes"
  | "min_active_duration_minutes"
  | "min_completed_trips";

export interface RiderRewardConditionSlot {
  readonly slotId: string;
  readonly label: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly requiredDurationMinutes: number | null;
  readonly requiredActiveDurationMinutes: number | null;
  readonly requiredOnlinePercentage: number | null;
  readonly minimumOrdersAccepted: number | null;
  readonly minimumCompletedDeliveries: number | null;
  readonly offlineToleranceMinutes: number;
  readonly gracePeriodMinutes: number;
  readonly overlapMode: RewardSlotOverlapMode;
  readonly disabledCityNames: readonly string[];
}

export interface RiderRewardConditionGroup {
  readonly groupId: string;
  readonly title: string;
  readonly minimumSlotsRequired: number;
  readonly slots: readonly RiderRewardConditionSlot[];
}

export interface RiderRewardOtherCondition {
  readonly conditionId: string;
  readonly type: RiderRewardOtherConditionType;
  readonly title: string;
  readonly maximumCount: number | null;
  readonly minimumCount: number | null;
  readonly minimumPercentage: number | null;
  readonly maximumMinutes: number | null;
  readonly minimumMinutes: number | null;
  readonly minimumRating: number | null;
  readonly enabled: boolean;
}

export interface RiderRewardSettings {
  readonly schemaVersion: 1;
  readonly payoutMinimumPaise: number;
  readonly referralProgramActive: boolean;
  readonly inviterRewardPaise: number;
  readonly inviteeRewardPaise: number;
  readonly referralMinCompletedTrips: number;
  readonly referralMaxRewardsPerRider: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
  readonly updatedByRole: "" | PlatformConfigAdminRole;
  readonly lastOperationId: string;
}

export interface RiderRewardMilestone {
  readonly target: number;
  readonly rewardAmountPaise: number;
  readonly label: string;
}

export interface RiderRewardTimeSlot {
  readonly label: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface RiderRewardCampaign {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly internalName: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly kind: RewardKind;
  readonly displayType: RewardDisplayType;
  readonly section: RewardSection;
  readonly rewardAmountPaise: number | null;
  readonly milestones: readonly RiderRewardMilestone[];
  readonly window: RewardWindow;
  readonly startAt: number;
  readonly endAt: number;
  readonly eligibleDays: readonly number[];
  readonly timeSlots: readonly RiderRewardTimeSlot[];
  readonly cityNames: readonly string[];
  readonly zoneNames: readonly string[];
  readonly restaurantIds: readonly string[];
  readonly riderIds: readonly string[];
  readonly minCompletedTrips: number | null;
  readonly minRating: number | null;
  readonly firstNCompletedTrips: number | null;
  readonly orderTotalMinPaise: number | null;
  readonly rainOnly: boolean;
  readonly requireDailyLoginSession: boolean;
  readonly minimumCompletedSessionsPerDay: number | null;
  readonly conditionGroups: readonly RiderRewardConditionGroup[];
  readonly otherConditions: readonly RiderRewardOtherCondition[];
  readonly milestonePayoutMode: RewardMilestonePayoutMode;
  readonly timezone: string;
  readonly tripAttribution: RewardTripAttribution;
  readonly allowOverlappingSlotCredit: boolean;
  readonly eligibleRiderTypes: readonly string[];
  readonly vehicleTypes: readonly string[];
  readonly minimumAccountAgeDays: number | null;
  readonly stacking: RewardStacking;
  readonly priority: number;
  readonly visible: boolean;
  readonly active: boolean;
  readonly archived: boolean;
  readonly updatedAt: number;
  readonly updatedBy: string;
  readonly updatedByRole: "" | PlatformConfigAdminRole;
  readonly lastOperationId: string;
}

export interface RiderRewardDailyBar {
  readonly dayKey: string;
  readonly label: string;
  readonly totalEarnedPaise: number;
  readonly tripEarningsPaise: number;
  readonly incentivePaise: number;
  readonly referralPaise: number;
  readonly tipPaise: number;
  readonly payoutPaise: number;
  readonly hasOffer?: boolean;
  readonly hasCompletedIncentive?: boolean;
  readonly hasSpecialOffer?: boolean;
}

export interface RiderRewardBreakdown {
  readonly dayKey: string;
  readonly completedTrips: number;
  readonly tripEarningsPaise: number;
  readonly incentivePaise: number;
  readonly referralPaise: number;
  readonly tipPaise: number;
  readonly payoutPaise: number;
  readonly codCollectedPaise: number;
}

export interface RiderRewardOffer {
  readonly campaignId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly displayType: RewardDisplayType;
  readonly section: RewardSection;
  readonly window: RewardWindow;
  readonly status: RiderRewardOfferStatus;
  readonly rewardAmountPaise: number | null;
  readonly stacking: RewardStacking;
  readonly priority: number;
  readonly conditions: readonly string[];
  readonly eligibilityMessage: string;
  readonly progressCurrent: number;
  readonly progressTarget: number;
  readonly milestones: readonly {
    target: number;
    rewardAmountPaise: number;
    reached: boolean;
    label: string;
  }[];
  readonly activeNow: boolean;
  readonly earnedPaiseForPeriod: number;
  readonly timezone?: string;
  readonly potentialRewardPaise?: number;
  readonly currentUnlockedRewardPaise?: number;
  readonly creditedRewardPaise?: number;
  readonly nextMilestone?: {
    target: number;
    rewardAmountPaise: number;
    remainingTrips: number;
  } | null;
  readonly conditionGroups?: readonly RiderRewardConditionGroupProgress[];
  readonly otherConditionProgress?: readonly RiderRewardOtherConditionProgress[];
  readonly selectedDayGroups?: readonly RiderRewardConditionGroupProgress[];
  readonly liabilityRewardPaise?: number;
  readonly periodLabel?: string;
}

export interface RiderRewardConditionSlotProgress {
  readonly slotId: string;
  readonly label: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly state: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "UPCOMING" | "LOCKED";
  readonly qualifiedOnlineMs: number;
  readonly requiredOnlineMs: number;
  readonly offlineToleranceMs: number;
  readonly qualifiedActiveMs: number;
  readonly requiredActiveMs: number;
  readonly acceptedOrders: number;
  readonly requiredAcceptedOrders: number;
  readonly completedDeliveries: number;
  readonly requiredCompletedDeliveries: number;
  readonly progressPercent: number;
  readonly remainingOnlineMs: number;
}

export interface RiderRewardConditionGroupProgress {
  readonly groupId: string;
  readonly title: string;
  readonly minimumSlotsRequired: number;
  readonly completedSlots: number;
  readonly qualified: boolean;
  readonly status: "PENDING" | "COMPLETED" | "FAILED";
  readonly message: string;
  readonly slots: readonly RiderRewardConditionSlotProgress[];
}

export interface RiderRewardOtherConditionProgress {
  readonly conditionId: string;
  readonly type: RiderRewardOtherConditionType;
  readonly title: string;
  readonly status: "PENDING" | "ELIGIBLE" | "FAILED";
  readonly currentValue: number;
  readonly thresholdValue: number;
  readonly unit: "count" | "percent" | "minutes" | "rating";
  readonly message: string;
}

export interface RiderRewardActivityEvent {
  readonly schemaVersion: 1;
  readonly riderId: string;
  readonly eventId: string;
  readonly type: RiderRewardActivityEventType;
  readonly occurredAt: number;
  readonly orderId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

interface RiderRewardProgressSnapshot {
  readonly schemaVersion: 1;
  readonly progressId: string;
  readonly riderId: string;
  readonly campaignId: string;
  readonly title: string;
  readonly periodKey: string;
  readonly periodStartAt: number;
  readonly periodEndAt: number;
  readonly timezone: string;
  readonly status: RiderRewardOfferStatus;
  readonly qualified: boolean;
  readonly failed: boolean;
  readonly activeNow: boolean;
  readonly offerActive: boolean;
  readonly tripsCompleted: number;
  readonly acceptedOrders: number;
  readonly rejectedOrders: number;
  readonly currentUnlockedRewardPaise: number;
  readonly potentialRewardPaise: number;
  readonly creditedRewardPaise: number;
  readonly requiredSessionsPerDay: number;
  readonly completedSessionsByDay: Readonly<Record<string, number>>;
  readonly loginSessionRequirementStatus: "DISABLED" | "PENDING" | "ELIGIBLE" | "FAILED";
  readonly loginSessionRequirementMessage: string;
  readonly groups: readonly RiderRewardConditionGroupProgress[];
  readonly selectedDayGroups: readonly RiderRewardConditionGroupProgress[];
  readonly otherConditions: readonly RiderRewardOtherConditionProgress[];
  readonly generatedAt: number;
  readonly settlementJournalId: string;
  readonly conditionsSummary: readonly string[];
}

export interface RiderPayoutEntry {
  readonly journalId: string;
  readonly occurredAt: number;
  readonly amountPaise: number;
  readonly status: "paid";
  readonly reference: string;
}

export interface RiderPayoutSummary {
  readonly status: "pending" | "paid" | "reconciliation_required";
  readonly payableNowPaise: number | null;
  readonly amountPaidInWindowPaise: number;
  readonly minimumPayoutPaise: number;
  readonly entries: readonly RiderPayoutEntry[];
  readonly automation?: {
    readonly enabled: boolean;
    readonly ridersEnabled: boolean;
    readonly scheduleLabel: string;
    readonly currentPeriodKey: string | null;
    readonly nextRunDayKey: string | null;
  };
}

export interface RiderReferralSummary {
  readonly active: boolean;
  readonly referralCode: string;
  readonly inviterRewardPaise: number;
  readonly inviteeRewardPaise: number;
  readonly minCompletedTrips: number;
  readonly maxRewardsPerRider: number;
  readonly referredRiderCount: number;
  readonly earnedRewardPaise: number;
}

export interface RiderRewardLoginSessionTrackerDay {
  readonly dayKey: string;
  readonly label: string;
  readonly sessionRecorded: boolean;
  readonly required: boolean;
  readonly today: boolean;
  readonly status: "recorded" | "pending" | "missed" | "upcoming" | "inactive";
}

export interface RiderRewardLoginSessionTracker {
  readonly enabled: boolean;
  readonly campaignId: string;
  readonly title: string;
  readonly weekLabel: string;
  readonly requiredSessionsPerDay: number;
  readonly loggedDaysInWeek: number;
  readonly requiredDaysCompletedSoFar: number;
  readonly requiredDaysSoFar: number;
  readonly totalWeekDays: number;
  readonly remainingRequiredDays: number;
  readonly todayCompletedSessions: number;
  readonly todayRecorded: boolean;
  readonly locked: boolean;
  readonly message: string;
  readonly days: readonly RiderRewardLoginSessionTrackerDay[];
}

export interface RiderRewardsDashboard {
  readonly generatedAt: number;
  readonly riderId: string;
  readonly referenceAt: number;
  readonly financial: RiderFinancialSummary;
  readonly selectedDayKey: string;
  readonly weekBars: readonly RiderRewardDailyBar[];
  readonly selectedDay: RiderRewardBreakdown;
  readonly payout: RiderPayoutSummary;
  readonly offers: readonly RiderRewardOffer[];
  readonly referral: RiderReferralSummary;
  readonly loginSessionTracker: RiderRewardLoginSessionTracker;
}

export interface RiderRewardCampaignAdminView {
  readonly campaign: RiderRewardCampaign;
  readonly eligibleRiderCount: number;
  readonly rewardJournalCount: number;
  readonly totalAccruedPaise: number;
  readonly totalRidersEnrolled: number;
  readonly currentlyEligibleCount: number;
  readonly qualifiedCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly rewardLiabilityPaise: number;
  readonly rewardsPaidPaise: number;
  readonly riderProgressPreview: readonly {
    riderId: string;
    riderName: string;
    status: RiderRewardOfferStatus;
    tripsCompleted: number;
    currentUnlockedRewardPaise: number;
    potentialRewardPaise: number;
    creditedRewardPaise: number;
    rejectedOrders: number;
    groupsCompleted: number;
    groupsRequired: number;
    nextMilestone: RiderRewardOffer["nextMilestone"];
    conditionsSummary: readonly string[];
  }[];
}

export interface RiderRewardsAdminDashboard {
  readonly generatedAt: number;
  readonly settings: RiderRewardSettings;
  readonly campaigns: readonly RiderRewardCampaignAdminView[];
}

interface RiderRewardSessionDay {
  readonly schemaVersion: 1;
  readonly riderId: string;
  readonly dayKey: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly completedSessions: number;
  readonly updatedAt: number;
}

interface RiderReferralIdentity {
  readonly schemaVersion: 1;
  readonly riderId: string;
  readonly referralCode: string;
  readonly assignedAt: number;
}

const DEFAULT_RIDER_REWARD_SETTINGS: RiderRewardSettings = Object.freeze({
  schemaVersion: 1,
  payoutMinimumPaise: 0,
  referralProgramActive: true,
  inviterRewardPaise: 50_000,
  inviteeRewardPaise: 0,
  referralMinCompletedTrips: 25,
  referralMaxRewardsPerRider: 0,
  updatedAt: 0,
  updatedBy: "",
  updatedByRole: "",
  lastOperationId: "",
});

function defaultDatabase(): RiderRewardsDatabase {
  return db as unknown as RiderRewardsDatabase;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown, fallback = 0, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed))) : fallback;
}

function decimal(value: unknown, fallback: number | null = null, minimum = 0, maximum = 5): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function truthy(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function text(value: unknown, maximum: number, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function identifier(value: unknown, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(normalized) ? normalized : fallback;
}

function normalizeSixDigitReferralCode(value: unknown): string {
  const normalized = String(value ?? "").trim().replace(/\s+/g, "");
  return /^\d{6}$/.test(normalized) ? normalized : "";
}

function legacyReferralCodeForRider(riderId: string): string {
  return `SRV-${Buffer.from(riderId, "utf8").toString("hex").toUpperCase()}`;
}

function legacyRiderIdFromReferralCode(code: string): string | null {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!normalized.startsWith("SRV-")) return null;
  try {
    const payload = normalized.slice(4);
    if (!/^[0-9A-F]{2,240}$/.test(payload) || payload.length % 2 !== 0) return null;
    const decoded = Buffer.from(payload, "hex").toString("utf8");
    return identifier(decoded) || null;
  } catch {
    return null;
  }
}

function normalizeReferralInput(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const directCode = normalizeSixDigitReferralCode(raw);
  if (directCode) return directCode;
  const legacyCode = raw.toUpperCase();
  if (legacyRiderIdFromReferralCode(legacyCode)) return legacyCode;
  const queryMatch = raw.match(/[?&#](?:ref|code)=([0-9]{6})(?:[&#/]|$)/i);
  if (queryMatch?.[1]) return queryMatch[1];
  const tokenMatch = raw.match(/(?:^|[^0-9])([0-9]{6})(?:[^0-9]|$)/);
  return tokenMatch?.[1] ?? "";
}

function normalizeReferralIdentity(riderId: string, value: unknown): RiderReferralIdentity | null {
  const source = record(value);
  const normalizedRiderId = identifier(source.riderId);
  const referralCode = normalizeSixDigitReferralCode(source.referralCode);
  if (normalizedRiderId !== riderId || !referralCode) return null;
  return {
    schemaVersion: 1,
    riderId: normalizedRiderId,
    referralCode,
    assignedAt: integer(source.assignedAt, 0, 1),
  };
}

function referralIdentityPath(riderId: string): string {
  return `${RIDER_REWARD_REFERRAL_IDENTITIES_ROOT}/${riderId}`;
}

function referralCodePath(referralCode: string): string {
  return `${RIDER_REWARD_REFERRAL_CODES_ROOT}/${referralCode}`;
}

function referralCodeCandidateForRider(riderId: string, attempt: number): string {
  const seed = createHash("sha256")
    .update(`rider-referral:v2:${riderId}:${attempt}`)
    .digest("hex")
    .slice(0, 12);
  const numeric = parseInt(seed, 16) % 900_000 + 100_000;
  return String(numeric).padStart(6, "0");
}

async function reserveReferralCode(
  database: RiderRewardsDatabase,
  referralCode: string,
  riderId: string,
  assignedAt: number,
): Promise<boolean> {
  const result = await database.ref(referralCodePath(referralCode)).transaction((current) => {
    const existing = record(current);
    const existingRiderId = identifier(existing.riderId);
    if (existingRiderId && existingRiderId !== riderId) return undefined;
    return {
      schemaVersion: 1,
      riderId,
      referralCode,
      assignedAt: integer(existing.assignedAt, assignedAt, 1),
    };
  }, undefined, false);
  return result.committed;
}

async function ensureRiderReferralIdentity(
  riderId: string,
  database: RiderRewardsDatabase,
  now: () => number = Date.now,
): Promise<RiderReferralIdentity> {
  const existingSnapshot = await database.ref(referralIdentityPath(riderId)).get();
  const existing = normalizeReferralIdentity(riderId, existingSnapshot.val());
  if (existing && await reserveReferralCode(database, existing.referralCode, riderId, existing.assignedAt)) {
    return existing;
  }
  const assignedAt = now();
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    const referralCode = referralCodeCandidateForRider(riderId, attempt);
    if (!await reserveReferralCode(database, referralCode, riderId, assignedAt)) continue;
    const result = await database.ref(referralIdentityPath(riderId)).transaction((current) => {
      const currentIdentity = normalizeReferralIdentity(riderId, current);
      if (currentIdentity && currentIdentity.referralCode === referralCode) return currentIdentity;
      return {
        schemaVersion: 1,
        riderId,
        referralCode,
        assignedAt,
      };
    }, undefined, false);
    const identity = normalizeReferralIdentity(riderId, result.snapshot.val());
    if (result.committed && identity) return identity;
  }
  throw new DomainError("resource-exhausted", "Referral code could not be assigned safely.");
}

async function inviterIdFromReferralInput(
  value: unknown,
  database: RiderRewardsDatabase,
): Promise<string | null> {
  const normalized = normalizeReferralInput(value);
  if (!normalized) return null;
  const sixDigitCode = normalizeSixDigitReferralCode(normalized);
  if (sixDigitCode) {
    const snapshot = await database.ref(referralCodePath(sixDigitCode)).get();
    const riderId = identifier(record(snapshot.val()).riderId);
    if (riderId) return riderId;
  }
  return legacyRiderIdFromReferralCode(normalized);
}

function referralInputMatchesRider(value: unknown, identity: RiderReferralIdentity): boolean {
  const normalized = normalizeReferralInput(value);
  return !!normalized && (
    normalized === identity.referralCode ||
    normalized === legacyReferralCodeForRider(identity.riderId)
  );
}

function normalizeNameList(value: unknown, maximum = 50, itemMax = 120): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value.slice(0, maximum)) {
    const normalized = text(entry, itemMax);
    if (!normalized) continue;
    const key = searchKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeIdentifierList(value: unknown, maximum = 100): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value.slice(0, maximum)) {
    const normalized = identifier(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeDays(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => integer(entry, -1, 0, 6))
    .filter((entry) => entry >= 0)
  )].sort((left, right) => left - right);
}

function normalizeMilestones(value: unknown): readonly RiderRewardMilestone[] {
  if (!Array.isArray(value)) return [];
  const out = value.map((entry) => {
    const source = record(entry);
    return {
      target: integer(source.target, 0, 1, 100_000),
      rewardAmountPaise: integer(source.rewardAmountPaise, 0, 1, 1_000_000_000),
      label: text(source.label, 80),
    };
  }).filter((entry) => entry.target > 0 && entry.rewardAmountPaise > 0);
  out.sort((left, right) => left.target - right.target || left.rewardAmountPaise - right.rewardAmountPaise);
  const unique: RiderRewardMilestone[] = [];
  let previous = -1;
  for (const entry of out) {
    if (entry.target === previous) continue;
    previous = entry.target;
    unique.push(entry);
  }
  return unique;
}

function normalizeTimeSlots(value: unknown): readonly RiderRewardTimeSlot[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const source = record(entry);
    return {
      label: text(source.label, 80, "Offer window"),
      startMinute: integer(source.startMinute, 0, 0, 1_439),
      endMinute: integer(source.endMinute, 0, 0, 1_439),
    };
  }).filter((entry) => entry.startMinute !== entry.endMinute);
}

function normalizeTextList(value: unknown, maximum = 20, itemMax = 80): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, maximum)) {
    const normalized = text(entry, itemMax);
    if (!normalized) continue;
    const key = searchKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeConditionGroups(value: unknown): readonly RiderRewardConditionGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, groupIndex) => {
    const source = record(entry);
    const slots = Array.isArray(source.slots) ? source.slots.map((slotEntry, slotIndex) => {
      const slot = record(slotEntry);
      const startMinute = integer(slot.startMinute, -1, -1, 1_439);
      const endMinute = integer(slot.endMinute, -1, -1, 1_439);
      if (startMinute < 0 || endMinute < 0 || startMinute === endMinute) return null;
      const overlapMode = slot.overlapMode === "allow_double_count" ? "allow_double_count" : "no_double_count";
      return {
        slotId: identifier(slot.slotId, `slot_${groupIndex + 1}_${slotIndex + 1}`),
        label: text(slot.label, 80, `Slot ${slotIndex + 1}`),
        startMinute,
        endMinute,
        requiredDurationMinutes: slot.requiredDurationMinutes === undefined ? null :
          integer(slot.requiredDurationMinutes, 0, 0, 1_440),
        requiredActiveDurationMinutes: slot.requiredActiveDurationMinutes === undefined ? null :
          integer(slot.requiredActiveDurationMinutes, 0, 0, 1_440),
        requiredOnlinePercentage: slot.requiredOnlinePercentage === undefined ? null :
          decimal(slot.requiredOnlinePercentage, 0, 0, 100),
        minimumOrdersAccepted: slot.minimumOrdersAccepted === undefined ? null :
          integer(slot.minimumOrdersAccepted, 0, 0, 10_000),
        minimumCompletedDeliveries: slot.minimumCompletedDeliveries === undefined ? null :
          integer(slot.minimumCompletedDeliveries, 0, 0, 10_000),
        offlineToleranceMinutes: integer(slot.offlineToleranceMinutes, 10, 0, 240),
        gracePeriodMinutes: integer(slot.gracePeriodMinutes, 0, 0, 240),
        overlapMode,
        disabledCityNames: normalizeNameList(slot.disabledCityNames, 50, 80),
      } satisfies RiderRewardConditionSlot;
    }).filter((slot): slot is RiderRewardConditionSlot => slot !== null) : [];
    if (!slots.length) return [];
    return [{
      groupId: identifier(source.groupId, `group_${groupIndex + 1}`),
      title: text(source.title, 80, `Login condition group ${groupIndex + 1}`),
      minimumSlotsRequired: integer(source.minimumSlotsRequired, 1, 1, slots.length),
      slots,
    } satisfies RiderRewardConditionGroup];
  });
}

function normalizeOtherConditions(value: unknown): readonly RiderRewardOtherCondition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const source = record(entry);
    const type = [
      "max_rejected_orders",
      "max_cancelled_booked_shifts",
      "max_incomplete_shifts",
      "max_cancelled_accepted_orders",
      "min_acceptance_rate",
      "min_completion_rate",
      "min_customer_rating",
      "max_offline_duration_minutes",
      "min_active_duration_minutes",
      "min_completed_trips",
    ].includes(String(source.type))
      ? source.type as RiderRewardOtherConditionType
      : null;
    if (!type) return [];
    return [{
      conditionId: identifier(source.conditionId, `condition_${index + 1}`),
      type,
      title: text(source.title, 120),
      maximumCount: source.maximumCount === undefined ? null : integer(source.maximumCount, 0, 0, 100_000),
      minimumCount: source.minimumCount === undefined ? null : integer(source.minimumCount, 0, 0, 100_000),
      minimumPercentage: source.minimumPercentage === undefined ? null : decimal(source.minimumPercentage, 0, 0, 100),
      maximumMinutes: source.maximumMinutes === undefined ? null : integer(source.maximumMinutes, 0, 0, 100_000),
      minimumMinutes: source.minimumMinutes === undefined ? null : integer(source.minimumMinutes, 0, 0, 100_000),
      minimumRating: source.minimumRating === undefined ? null : decimal(source.minimumRating, 0, 0, 5),
      enabled: truthy(source.enabled, true),
    } satisfies RiderRewardOtherCondition];
  });
}

export function normalizeRewardSettings(value: unknown): RiderRewardSettings {
  const source = record(value);
  const role = source.updatedByRole === "owner" || source.updatedByRole === "ops_admin"
    ? source.updatedByRole
    : "";
  return {
    schemaVersion: 1,
    payoutMinimumPaise: integer(source.payoutMinimumPaise, DEFAULT_RIDER_REWARD_SETTINGS.payoutMinimumPaise, 0, 1_000_000_000),
    referralProgramActive: truthy(source.referralProgramActive, DEFAULT_RIDER_REWARD_SETTINGS.referralProgramActive),
    inviterRewardPaise: integer(source.inviterRewardPaise, DEFAULT_RIDER_REWARD_SETTINGS.inviterRewardPaise, 0, 1_000_000_000),
    inviteeRewardPaise: integer(source.inviteeRewardPaise, DEFAULT_RIDER_REWARD_SETTINGS.inviteeRewardPaise, 0, 1_000_000_000),
    referralMinCompletedTrips: integer(source.referralMinCompletedTrips, DEFAULT_RIDER_REWARD_SETTINGS.referralMinCompletedTrips, 0, 100_000),
    referralMaxRewardsPerRider: integer(source.referralMaxRewardsPerRider, DEFAULT_RIDER_REWARD_SETTINGS.referralMaxRewardsPerRider, 0, 100_000),
    updatedAt: integer(source.updatedAt, 0, 0),
    updatedBy: text(source.updatedBy, 128),
    updatedByRole: role,
    lastOperationId: text(source.lastOperationId, 128),
  };
}

function normalizeRewardCampaign(campaignId: string, value: unknown): RiderRewardCampaign | null {
  const source = record(value);
  const kind = source.kind === "per_order_bonus" || source.kind === "milestone_bonus"
    ? source.kind
    : null;
  const displayType = [
    "trip_milestone",
    "surge",
    "rain_surge",
    "shift_bonus",
    "daily_incentive",
    "weekly_incentive",
    "zone_bonus",
    "special_campaign",
  ].includes(String(source.displayType))
    ? source.displayType as RewardDisplayType
    : null;
  const section = ["breakfast", "lunch", "snacks", "dinner", "late_night", "special"].includes(String(source.section))
    ? source.section as RewardSection
    : "special";
  const window = ["daily", "weekly", "custom"].includes(String(source.window))
    ? source.window as RewardWindow
    : "daily";
  const stacking = source.stacking === "highest_only" ? "highest_only" : "stack";
  const role = source.updatedByRole === "owner" || source.updatedByRole === "ops_admin"
    ? source.updatedByRole
    : "";
  const normalizedId = identifier(campaignId);
  const startAt = integer(source.startAt, 0, 1);
  const endAt = integer(source.endAt, 0, 1);
  if (!normalizedId || !kind || !displayType || endAt <= startAt) return null;
  const milestones = normalizeMilestones(source.milestones);
  const rewardAmountPaise = source.rewardAmountPaise === null || source.rewardAmountPaise === undefined
    ? null
    : integer(source.rewardAmountPaise, 0, 1, 1_000_000_000);
  if (kind === "per_order_bonus" && !rewardAmountPaise) return null;
  if (kind === "milestone_bonus" && milestones.length === 0) return null;
  const conditionGroups = normalizeConditionGroups(source.conditionGroups);
  const otherConditions = normalizeOtherConditions(source.otherConditions);
  const milestonePayoutMode = source.milestonePayoutMode === "cumulative" ? "cumulative" : "highest_unlocked";
  const timezone = text(source.timezone, 80, DEFAULT_REWARD_TIMEZONE) || DEFAULT_REWARD_TIMEZONE;
  const tripAttribution = source.tripAttribution === "delivered_at" ? "delivered_at" : "delivered_at";
  return {
    schemaVersion: 1,
    campaignId: normalizedId,
    internalName: text(source.internalName, 120),
    title: text(source.title, 120),
    subtitle: text(source.subtitle, 160),
    description: text(source.description, 500),
    kind,
    displayType,
    section,
    rewardAmountPaise,
    milestones,
    window,
    startAt,
    endAt,
    eligibleDays: normalizeDays(source.eligibleDays),
    timeSlots: normalizeTimeSlots(source.timeSlots),
    cityNames: normalizeNameList(source.cityNames, 50, 80),
    zoneNames: normalizeNameList(source.zoneNames, 50, 120),
    restaurantIds: normalizeIdentifierList(source.restaurantIds, 100),
    riderIds: normalizeIdentifierList(source.riderIds, 200),
    minCompletedTrips: source.minCompletedTrips === undefined ? null : integer(source.minCompletedTrips, 0, 0, 100_000),
    minRating: decimal(source.minRating, null, 0, 5),
    firstNCompletedTrips: source.firstNCompletedTrips === undefined ? null : integer(source.firstNCompletedTrips, 0, 1, 100_000),
    orderTotalMinPaise: source.orderTotalMinPaise === undefined ? null : integer(source.orderTotalMinPaise, 0, 0, 1_000_000_000),
    rainOnly: truthy(source.rainOnly, false),
    requireDailyLoginSession: truthy(source.requireDailyLoginSession, false),
    minimumCompletedSessionsPerDay: source.minimumCompletedSessionsPerDay === undefined ? null :
      integer(source.minimumCompletedSessionsPerDay, 0, 1, 24),
    conditionGroups,
    otherConditions,
    milestonePayoutMode,
    timezone,
    tripAttribution,
    allowOverlappingSlotCredit: truthy(source.allowOverlappingSlotCredit, false),
    eligibleRiderTypes: normalizeTextList(source.eligibleRiderTypes, 20, 80),
    vehicleTypes: normalizeTextList(source.vehicleTypes, 20, 80),
    minimumAccountAgeDays: source.minimumAccountAgeDays === undefined ? null :
      integer(source.minimumAccountAgeDays, 0, 0, 10_000),
    stacking,
    priority: integer(source.priority, 100, 0, 1_000),
    visible: truthy(source.visible, true),
    active: truthy(source.active, true),
    archived: truthy(source.archived, false),
    updatedAt: integer(source.updatedAt, 0, 0),
    updatedBy: text(source.updatedBy, 128),
    updatedByRole: role,
    lastOperationId: text(source.lastOperationId, 128),
  };
}

function rewardSettingsHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function searchKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function istShifted(referenceAt: number): Date {
  return new Date(referenceAt + IST_OFFSET_MS);
}

function startOfIstDay(referenceAt: number): number {
  const shifted = istShifted(referenceAt);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - IST_OFFSET_MS;
}

function endOfIstDay(referenceAt: number): number {
  return startOfIstDay(referenceAt) + 24 * 60 * 60 * 1_000;
}

function startOfIstWeek(referenceAt: number): number {
  const shifted = istShifted(referenceAt);
  const weekday = shifted.getUTCDay();
  const mondayDistance = (weekday + 6) % 7;
  return startOfIstDay(referenceAt) - mondayDistance * 24 * 60 * 60 * 1_000;
}

function periodBounds(window: RewardWindow, referenceAt: number, campaign: RiderRewardCampaign): {startAt: number; endAt: number; key: string} {
  const bounds = periodBoundsAtTimeZone(window, referenceAt, campaign);
  return {startAt: bounds.startAt, endAt: bounds.endAt, key: bounds.key};
}

function referenceDayKey(referenceAt: number): string {
  const shifted = istShifted(referenceAt);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function matchesTimeSlot(slot: RiderRewardTimeSlot, referenceAt: number, timeZone = DEFAULT_REWARD_TIMEZONE): boolean {
  const minute = minuteOfDayAtTimeZone(referenceAt, timeZone);
  return slot.startMinute < slot.endMinute
    ? minute >= slot.startMinute && minute < slot.endMinute
    : minute >= slot.startMinute || minute < slot.endMinute;
}

function matchesDay(campaign: RiderRewardCampaign, referenceAt: number): boolean {
  if (campaign.eligibleDays.length === 0) return true;
  return campaign.eligibleDays.includes(zonedParts(referenceAt, campaign.timezone).weekday);
}

function matchesStaticCampaignWindow(campaign: RiderRewardCampaign, referenceAt: number): boolean {
  if (referenceAt < campaign.startAt || referenceAt >= campaign.endAt) return false;
  if (!matchesDay(campaign, referenceAt)) return false;
  return true;
}

function requiredCompletedSessionsPerDay(campaign: RiderRewardCampaign): number {
  if (!campaign.requireDailyLoginSession) return 0;
  if (campaign.minimumCompletedSessionsPerDay !== null) return campaign.minimumCompletedSessionsPerDay;
  const baseline = 2;
  const groupedMinimum = campaign.conditionGroups.reduce((total, group) =>
    total + Math.max(1, integer(group.minimumSlotsRequired, 1, 1, 24)), 0);
  return groupedMinimum > 0 ? Math.max(baseline, groupedMinimum) : baseline;
}

function rewardSessionConditionCopy(campaign: RiderRewardCampaign): string {
  const required = Math.max(1, requiredCompletedSessionsPerDay(campaign) || 1);
  const phrase = `${required} valid login session${required === 1 ? "" : "s"}/shift${required === 1 ? "" : "s"}`;
  if (campaign.window === "weekly") {
    return `Complete at least ${phrase} every required day in this week to receive incentives. Missing a day removes this week's incentive.`;
  }
  if (campaign.window === "daily") {
    return `Complete at least ${phrase} during this day to receive incentives.`;
  }
  return `Complete at least ${phrase} on every required day in this incentive period to receive incentives.`;
}

function rewardTimeSlotAsConditionSlot(slot: RiderRewardTimeSlot, index: number): RiderRewardConditionSlot {
  return {
    slotId: `time_slot_${index + 1}`,
    label: slot.label,
    startMinute: slot.startMinute,
    endMinute: slot.endMinute,
    requiredDurationMinutes: null,
    requiredActiveDurationMinutes: null,
    requiredOnlinePercentage: null,
    minimumOrdersAccepted: null,
    minimumCompletedDeliveries: null,
    offlineToleranceMinutes: 10,
    gracePeriodMinutes: 0,
    overlapMode: "no_double_count",
    disabledCityNames: [],
  };
}

function campaignSessionTrackingSlots(campaign: RiderRewardCampaign): readonly RiderRewardConditionSlot[] {
  const sourceSlots = campaign.conditionGroups.length
    ? campaign.conditionGroups.flatMap((group) => group.slots)
    : campaign.timeSlots.map((slot, index) => rewardTimeSlotAsConditionSlot(slot, index));
  const unique = new Map<string, RiderRewardConditionSlot>();
  for (const slot of sourceSlots) {
    const key = `${slot.startMinute}:${slot.endMinute}:${searchKey(slot.label || slot.slotId)}`;
    if (!unique.has(key)) unique.set(key, slot);
  }
  return [...unique.values()].sort((left, right) =>
    left.startMinute - right.startMinute ||
    left.endMinute - right.endMinute ||
    left.slotId.localeCompare(right.slotId));
}

function campaignHasConfiguredSessionSlots(campaign: RiderRewardCampaign): boolean {
  return campaignSessionTrackingSlots(campaign).length > 0;
}

function mergedSessionTrackingGroup(
  campaign: RiderRewardCampaign,
  minimumSlotsRequired: number,
  title: string,
): readonly RiderRewardConditionGroup[] {
  const slots = campaignSessionTrackingSlots(campaign);
  if (!slots.length) return [];
  return [{
    groupId: "session_tracking",
    title,
    minimumSlotsRequired: Math.min(Math.max(1, minimumSlotsRequired), slots.length),
    slots,
  }];
}

function progressConditionGroups(campaign: RiderRewardCampaign): readonly RiderRewardConditionGroup[] {
  if (campaign.conditionGroups.length) return campaign.conditionGroups;
  if (campaign.requireDailyLoginSession && campaign.timeSlots.length) {
    return mergedSessionTrackingGroup(campaign, Math.max(1, requiredCompletedSessionsPerDay(campaign) || 1), "Session slots");
  }
  return [];
}

function rewardConditions(campaign: RiderRewardCampaign, settings?: RiderRewardSettings): string[] {
  const conditions: string[] = [];
  if (campaign.requireDailyLoginSession) {
    conditions.push(rewardSessionConditionCopy(campaign));
  }
  if (campaign.timeSlots.length) {
    conditions.push(campaign.timeSlots.map((slot) => `${slot.label}: ${formatMinute(slot.startMinute)} – ${formatMinute(slot.endMinute)}`).join(" • "));
  }
  if (campaign.cityNames.length) conditions.push(`Cities: ${campaign.cityNames.join(", ")}`);
  if (campaign.zoneNames.length) conditions.push(`Zones: ${campaign.zoneNames.join(", ")}`);
  if (campaign.restaurantIds.length) conditions.push(`Selected restaurants only`);
  if (campaign.rainOnly) conditions.push("Valid only on rain-verified deliveries");
  if (campaign.minCompletedTrips) conditions.push(`Minimum ${campaign.minCompletedTrips} completed trips`);
  if (campaign.firstNCompletedTrips) conditions.push(`Only first ${campaign.firstNCompletedTrips} completed trips`);
  if (campaign.orderTotalMinPaise) conditions.push(`Order total at least ₹${(campaign.orderTotalMinPaise / 100).toFixed(0)}`);
  if (campaign.minRating !== null) conditions.push(`Minimum rating ${campaign.minRating.toFixed(1)}★`);
  if (settings && settings.referralProgramActive) {
    conditions.push(`Stacking: ${campaign.stacking === "highest_only" ? "Highest eligible reward only" : "Can stack with compatible rewards"}`);
  } else {
    conditions.push(`Stacking: ${campaign.stacking === "highest_only" ? "Highest eligible reward only" : "Can stack"}`);
  }
  return conditions;
}

function formatMinute(minute: number): string {
  const normalized = ((minute % 1_440) + 1_440) % 1_440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function sessionDay(value: unknown, riderId: string, dayKey: string): RiderRewardSessionDay | null {
  const source = record(value);
  if (!source) return null;
  const normalizedDayKey = text(source.dayKey, 20);
  const normalizedRiderId = text(source.riderId, 128);
  const firstSeenAt = integer(source.firstSeenAt, 0, 0);
  const lastSeenAt = integer(source.lastSeenAt, 0, 0);
  const completedSessions = integer(source.completedSessions, 0, 0, 24);
  const updatedAt = integer(source.updatedAt, Math.max(lastSeenAt, firstSeenAt), 0);
  const hasPresenceWindow = firstSeenAt > 0 && lastSeenAt >= firstSeenAt;
  const hasCompletionData = completedSessions > 0 || updatedAt > 0;
  if (normalizedDayKey !== dayKey || normalizedRiderId !== riderId || (!hasPresenceWindow && !hasCompletionData)) {
    return null;
  }
  return {
    schemaVersion: 1,
    riderId,
    dayKey,
    firstSeenAt: hasPresenceWindow ? firstSeenAt : 0,
    lastSeenAt: hasPresenceWindow ? lastSeenAt : 0,
    completedSessions,
    updatedAt,
  };
}

function sessionDayKeys(value: unknown, riderId: string): ReadonlySet<string> {
  const source = record(value);
  const keys = new Set<string>();
  if (!source) return keys;
  for (const [dayKey, entry] of Object.entries(source)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
    const parsed = sessionDay(entry, riderId, dayKey);
    if (parsed && parsed.completedSessions > 0) keys.add(dayKey);
  }
  return keys;
}

async function readSessionDayKeys(database: RiderRewardsDatabase, riderId: string): Promise<ReadonlySet<string>> {
  const snapshot = await database.ref(`${RIDER_REWARD_SESSION_DAYS_ROOT}/${riderId}`).get();
  return sessionDayKeys(snapshot.val(), riderId);
}

function formatRewardDayKey(dayKey: string): string {
  const parsed = Date.parse(`${dayKey}T12:00:00+05:30`);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleDateString("en-IN", {weekday: "short", day: "numeric", month: "short"})
    : dayKey;
}

function formatRewardWeekLabel(startAt: number): string {
  const startKey = referenceDayKey(startAt);
  const endKey = referenceDayKey(startAt + 6 * 24 * 60 * 60 * 1_000);
  const start = Date.parse(`${startKey}T12:00:00+05:30`);
  const end = Date.parse(`${endKey}T12:00:00+05:30`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return `${startKey} – ${endKey}`;
  return `${new Date(start).toLocaleDateString("en-IN", {day: "numeric", month: "short"})} – ${new Date(end).toLocaleDateString("en-IN", {day: "numeric", month: "short"})}`;
}

function weekdayShortLabel(dayKey: string): string {
  const parsed = Date.parse(`${dayKey}T12:00:00+05:30`);
  if (!Number.isFinite(parsed)) return dayKey;
  return new Date(parsed).toLocaleDateString("en-IN", {weekday: "short"});
}

function missingDailyLoginSessionLegacy(
  campaign: RiderRewardCampaign,
  sessionKeys: ReadonlySet<string>,
  referenceAt: number,
): {missing: boolean; missingDayKey: string | null} {
  if (!campaign.requireDailyLoginSession) return {missing: false, missingDayKey: null};
  const period = periodBounds(campaign.window, referenceAt, campaign);
  const effectiveStartAt = Math.max(period.startAt, startOfIstDay(Math.max(campaign.startAt, campaign.updatedAt || campaign.startAt)));
  const auditEndAt = Math.min(startOfIstDay(referenceAt), period.endAt);
  for (let cursor = effectiveStartAt; cursor < auditEndAt; cursor += 24 * 60 * 60 * 1_000) {
    const dayKey = referenceDayKey(cursor);
    if (!sessionKeys.has(dayKey)) {
      return {missing: true, missingDayKey: dayKey};
    }
  }
  return {missing: false, missingDayKey: null};
}

function rewardRequiredDayEntries(
  campaign: RiderRewardCampaign,
  periodStartAt: number,
  periodEndAt: number,
  timeZone: string,
): readonly {dayKey: string; startAt: number}[] {
  const entries: Array<{dayKey: string; startAt: number}> = [];
  const effectiveStartReferenceAt = Math.max(periodStartAt, campaign.startAt, campaign.updatedAt || campaign.startAt);
  let cursor = startOfZonedDay(effectiveStartReferenceAt, timeZone);
  while (cursor < periodEndAt) {
    const dayReferenceAt = cursor + 12 * 60 * 60 * 1_000;
    if (matchesDay(campaign, dayReferenceAt)) {
      entries.push({
        dayKey: referenceDayKeyAtTimeZone(dayReferenceAt, timeZone),
        startAt: cursor,
      });
    }
    cursor = startOfZonedDay(cursor + 36 * 60 * 60 * 1_000, timeZone);
  }
  return entries;
}

function evaluateCompletedSessionRequirement(input: {
  campaign: RiderRewardCampaign;
  completedSessionsByDay: Readonly<Record<string, number>>;
  referenceAt: number;
  periodStartAt: number;
  periodEndAt: number;
  timeZone: string;
}): {
  status: "DISABLED" | "PENDING" | "ELIGIBLE" | "FAILED";
  requiredSessionsPerDay: number;
  todayDayKey: string;
  todayCompletedSessions: number;
  missingDayKey: string | null;
  message: string;
} {
  const requiredSessionsPerDay = Math.max(0, requiredCompletedSessionsPerDay(input.campaign));
  const effectiveEndAt = Math.min(input.periodEndAt, input.campaign.endAt);
  const effectiveReferenceAt = Math.max(input.periodStartAt, Math.min(input.referenceAt, Math.max(input.periodStartAt, effectiveEndAt - 1)));
  const todayDayKey = referenceDayKeyAtTimeZone(effectiveReferenceAt, input.timeZone);
  const todayCompletedSessions = Math.max(0, Number(input.completedSessionsByDay[todayDayKey] ?? 0));
  if (!input.campaign.requireDailyLoginSession || requiredSessionsPerDay <= 0 || !campaignHasConfiguredSessionSlots(input.campaign)) {
    return {
      status: "DISABLED",
      requiredSessionsPerDay,
      todayDayKey,
      todayCompletedSessions,
      missingDayKey: null,
      message: "",
    };
  }
  const requiredDays = rewardRequiredDayEntries(input.campaign, input.periodStartAt, effectiveEndAt, input.timeZone);
  const currentDayStartAt = startOfZonedDay(effectiveReferenceAt, input.timeZone);
  const periodEnded = input.referenceAt >= effectiveEndAt;
  for (const day of requiredDays) {
    const completedSessions = Math.max(0, Number(input.completedSessionsByDay[day.dayKey] ?? 0));
    if (completedSessions >= requiredSessionsPerDay) continue;
    if (day.startAt === currentDayStartAt && !periodEnded) {
      return {
        status: "PENDING",
        requiredSessionsPerDay,
        todayDayKey,
        todayCompletedSessions,
        missingDayKey: null,
        message: `${completedSessions} / ${requiredSessionsPerDay} valid session${requiredSessionsPerDay === 1 ? "" : "s"} completed today.`,
      };
    }
    return {
      status: "FAILED",
      requiredSessionsPerDay,
      todayDayKey,
      todayCompletedSessions,
      missingDayKey: day.dayKey,
      message: day.startAt === currentDayStartAt
        ? `Only ${completedSessions} / ${requiredSessionsPerDay} valid session${requiredSessionsPerDay === 1 ? "" : "s"} were completed for this day.`
        : `A required login session was missed on ${formatRewardDayKey(day.dayKey)}.`,
    };
  }
  return {
    status: "ELIGIBLE",
    requiredSessionsPerDay,
    todayDayKey,
    todayCompletedSessions,
    missingDayKey: null,
    message: input.campaign.window === "weekly"
      ? "Required login sessions are complete for every required day so far."
      : `${todayCompletedSessions} / ${requiredSessionsPerDay} valid session${requiredSessionsPerDay === 1 ? "" : "s"} completed today.`,
  };
}

function primaryWeeklyLoginSessionCampaign(
  campaigns: readonly RiderRewardCampaign[],
  referenceAt: number,
): RiderRewardCampaign | null {
  return campaigns
    .filter((campaign) =>
      campaign.visible &&
      !campaign.archived &&
      campaign.active &&
      campaign.window === "weekly" &&
      campaign.requireDailyLoginSession &&
      campaignHasConfiguredSessionSlots(campaign) &&
      referenceAt >= campaign.startAt &&
      referenceAt < campaign.endAt
    )
    .sort((left, right) => right.priority - left.priority || right.updatedAt - left.updatedAt || left.campaignId.localeCompare(right.campaignId))[0] ?? null;
}

function buildLoginSessionTracker(
  campaigns: readonly RiderRewardCampaign[],
  snapshots: readonly RiderRewardProgressSnapshot[],
  referenceAt: number,
): RiderRewardLoginSessionTracker {
  const weekStartAt = startOfIstWeek(referenceAt);
  const todayStartAt = startOfIstDay(referenceAt);
  const totalWeekDays = 7;
  const campaign = primaryWeeklyLoginSessionCampaign(campaigns, referenceAt);
  const snapshot = campaign ? snapshots.find((entry) => entry.campaignId === campaign.campaignId) ?? null : null;
  const requiredSessionsPerDay = campaign ? Math.max(1, requiredCompletedSessionsPerDay(campaign) || 1) : 1;
  const completedSessionsByDay = snapshot?.completedSessionsByDay ?? {};
  const emptyDays = Array.from({length: totalWeekDays}, (_, index): RiderRewardLoginSessionTrackerDay => {
    const dayStartAt = weekStartAt + index * 24 * 60 * 60 * 1_000;
    const dayKey = referenceDayKey(dayStartAt);
    const completedSessions = Math.max(0, Number(completedSessionsByDay[dayKey] ?? 0));
    const sessionRecorded = !!campaign && completedSessions >= requiredSessionsPerDay;
    return {
      dayKey,
      label: weekdayShortLabel(dayKey),
      sessionRecorded,
      required: false,
      today: dayStartAt === todayStartAt,
      status: sessionRecorded ? "recorded" : "inactive",
    };
  });
  if (!campaign) {
    return {
      enabled: false,
      campaignId: "",
      title: "",
      weekLabel: formatRewardWeekLabel(weekStartAt),
      requiredSessionsPerDay,
      loggedDaysInWeek: emptyDays.filter((day) => day.sessionRecorded).length,
      requiredDaysCompletedSoFar: 0,
      requiredDaysSoFar: 0,
      totalWeekDays,
      remainingRequiredDays: 0,
      todayCompletedSessions: 0,
      todayRecorded: emptyDays.some((day) => day.today && day.sessionRecorded),
      locked: false,
      message: "",
      days: emptyDays,
    };
  }
  const period = periodBounds(campaign.window, referenceAt, campaign);
  const effectiveStartAt = Math.max(period.startAt, startOfIstDay(Math.max(campaign.startAt, campaign.updatedAt || campaign.startAt)));
  const requiredEndAt = Math.min(period.endAt, campaign.endAt);
  const days = Array.from({length: totalWeekDays}, (_, index): RiderRewardLoginSessionTrackerDay => {
    const dayStartAt = weekStartAt + index * 24 * 60 * 60 * 1_000;
    const dayKey = referenceDayKey(dayStartAt);
    const completedSessions = Math.max(0, Number(completedSessionsByDay[dayKey] ?? 0));
    const sessionRecorded = completedSessions >= requiredSessionsPerDay;
    const today = dayStartAt === todayStartAt;
    const required = dayStartAt >= effectiveStartAt && dayStartAt < requiredEndAt;
    const status: RiderRewardLoginSessionTrackerDay["status"] = sessionRecorded
      ? "recorded"
      : !required
        ? "inactive"
        : dayStartAt < todayStartAt
          ? "missed"
          : today
            ? "pending"
            : "upcoming";
    return {
      dayKey,
      label: weekdayShortLabel(dayKey),
      sessionRecorded,
      required,
      today,
      status,
    };
  });
  const loggedDaysInWeek = days.filter((day) => day.sessionRecorded).length;
  const requiredDaysSoFar = days.filter((day) => day.required && (day.today || Date.parse(`${day.dayKey}T00:00:00+05:30`) < todayStartAt)).length;
  const requiredDaysCompletedSoFar = days.filter((day) => day.required && day.sessionRecorded && (day.today || Date.parse(`${day.dayKey}T00:00:00+05:30`) < todayStartAt)).length;
  const remainingRequiredDays = days.filter((day) => day.required && !day.sessionRecorded && (day.today || Date.parse(`${day.dayKey}T00:00:00+05:30`) > todayStartAt)).length;
  const missedDays = days.filter((day) => day.status === "missed");
  const todayRecorded = days.some((day) => day.today && day.sessionRecorded);
  const todayCompletedSessions = Math.max(0, Number(completedSessionsByDay[referenceDayKey(todayStartAt)] ?? 0));
  const requirementCopy = `Complete at least ${requiredSessionsPerDay} valid login session${requiredSessionsPerDay === 1 ? "" : "s"} on every required day`;
  const message = missedDays.length
    ? `Missed ${formatRewardDayKey(missedDays[0]!.dayKey)}. This week's incentive is locked until the next week starts.`
    : todayRecorded
      ? remainingRequiredDays > 0
        ? `Today's required session target is complete. Keep ${requirementCopy.toLowerCase()} to protect this week's incentive.`
        : "All required login sessions for this week's incentive are complete."
      : `${requirementCopy} to keep this week's incentive active.`;
  return {
    enabled: true,
    campaignId: campaign.campaignId,
    title: campaign.title,
    weekLabel: formatRewardWeekLabel(weekStartAt),
    requiredSessionsPerDay,
    loggedDaysInWeek,
    requiredDaysCompletedSoFar,
    requiredDaysSoFar,
    totalWeekDays,
    remainingRequiredDays,
    todayCompletedSessions,
    todayRecorded,
    locked: missedDays.length > 0,
    message,
    days,
  };
}

interface TimeInterval {
  readonly startAt: number;
  readonly endAt: number;
}

interface RiderRewardSlotInstance {
  readonly instanceId: string;
  readonly dayKey: string;
  readonly groupId: string;
  readonly groupTitle: string;
  readonly minimumSlotsRequired: number;
  readonly slot: RiderRewardConditionSlot;
  readonly startAt: number;
  readonly endAt: number;
  readonly selectedDay: boolean;
}

interface RiderRewardActivitySummary {
  readonly onlineIntervals: readonly TimeInterval[];
  readonly acceptedOrderIds: ReadonlySet<string>;
  readonly rejectedOrderCount: number;
  readonly deliveredOrderIds: ReadonlySet<string>;
  readonly cancelledAcceptedOrderIds: ReadonlySet<string>;
  readonly cancelledBookedShiftIds: ReadonlySet<string>;
  readonly completedTrips: number;
  readonly acceptedOrders: number;
  readonly onlineDurationMs: number;
  readonly activeDurationMs: number;
  readonly offlineDurationMs: number;
}

function safeTimeZone(value: string): string {
  const candidate = text(value, 80, DEFAULT_REWARD_TIMEZONE) || DEFAULT_REWARD_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: candidate}).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_REWARD_TIMEZONE;
  }
}

function zonedPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function zonedWeekday(value: string): number {
  const normalized = value.slice(0, 3).toLowerCase();
  if (normalized === "sun") return 0;
  if (normalized === "mon") return 1;
  if (normalized === "tue") return 2;
  if (normalized === "wed") return 3;
  if (normalized === "thu") return 4;
  if (normalized === "fri") return 5;
  if (normalized === "sat") return 6;
  return 0;
}

function zonedParts(referenceAt: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  dayKey: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(referenceAt));
  const year = integer(zonedPart(parts, "year"), 1970, 1970, 9999);
  const month = integer(zonedPart(parts, "month"), 1, 1, 12);
  const day = integer(zonedPart(parts, "day"), 1, 1, 31);
  const hour = integer(zonedPart(parts, "hour"), 0, 0, 23);
  const minute = integer(zonedPart(parts, "minute"), 0, 0, 59);
  const second = integer(zonedPart(parts, "second"), 0, 0, 59);
  const weekday = zonedWeekday(zonedPart(parts, "weekday"));
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    dayKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function timeZoneOffsetMinutes(referenceAt: number, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTimeZone(timeZone),
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(new Date(referenceAt));
    const token = zonedPart(parts, "timeZoneName");
    const match = token.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
    if (!match) return 330;
    const sign = match[1] === "-" ? -1 : 1;
    const hours = integer(match[2], 0, 0, 23);
    const minutes = integer(match[3] ?? 0, 0, 0, 59);
    return sign * (hours * 60 + minutes);
  } catch {
    return 330;
  }
}

function startOfZonedDay(referenceAt: number, timeZone: string): number {
  const parts = zonedParts(referenceAt, timeZone);
  const approxUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  let offset = timeZoneOffsetMinutes(approxUtc, timeZone);
  let startAt = approxUtc - offset * 60 * 1_000;
  const corrected = timeZoneOffsetMinutes(startAt, timeZone);
  if (corrected !== offset) {
    offset = corrected;
    startAt = approxUtc - offset * 60 * 1_000;
  }
  return startAt;
}

function startOfZonedWeek(referenceAt: number, timeZone: string): number {
  const dayStartAt = startOfZonedDay(referenceAt, timeZone);
  const weekday = zonedParts(dayStartAt + 12 * 60 * 60 * 1_000, timeZone).weekday;
  const mondayDistance = (weekday + 6) % 7;
  return dayStartAt - mondayDistance * 24 * 60 * 60 * 1_000;
}

function referenceDayKeyAtTimeZone(referenceAt: number, timeZone: string): string {
  return zonedParts(referenceAt, timeZone).dayKey;
}

function minuteOfDayAtTimeZone(referenceAt: number, timeZone: string): number {
  const parts = zonedParts(referenceAt, timeZone);
  return parts.hour * 60 + parts.minute;
}

function periodBoundsAtTimeZone(
  window: RewardWindow,
  referenceAt: number,
  campaign: RiderRewardCampaign,
): {startAt: number; endAt: number; key: string; timezone: string} {
  const timeZone = safeTimeZone(campaign.timezone);
  if (window === "weekly") {
    const startAt = startOfZonedWeek(referenceAt, timeZone);
    const endAt = startAt + 7 * 24 * 60 * 60 * 1_000;
    return {startAt, endAt, key: `week:${startAt}`, timezone: timeZone};
  }
  if (window === "custom") {
    return {
      startAt: campaign.startAt,
      endAt: campaign.endAt,
      key: `custom:${campaign.startAt}:${campaign.endAt}`,
      timezone: timeZone,
    };
  }
  const startAt = startOfZonedDay(referenceAt, timeZone);
  return {
    startAt,
    endAt: startAt + 24 * 60 * 60 * 1_000,
    key: `day:${startAt}`,
    timezone: timeZone,
  };
}

function intervalDuration(interval: TimeInterval): number {
  return Math.max(0, interval.endAt - interval.startAt);
}

function intersectInterval(left: TimeInterval, right: TimeInterval): TimeInterval | null {
  const startAt = Math.max(left.startAt, right.startAt);
  const endAt = Math.min(left.endAt, right.endAt);
  return endAt > startAt ? {startAt, endAt} : null;
}

function mergeIntervals(intervals: readonly TimeInterval[]): readonly TimeInterval[] {
  const sorted = [...intervals].filter((interval) => interval.endAt > interval.startAt)
    .sort((left, right) => left.startAt - right.startAt || left.endAt - right.endAt);
  const merged: TimeInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.startAt > previous.endAt) {
      merged.push(interval);
      continue;
    }
    merged[merged.length - 1] = {
      startAt: previous.startAt,
      endAt: Math.max(previous.endAt, interval.endAt),
    };
  }
  return merged;
}

function subtractInterval(source: TimeInterval, blocked: readonly TimeInterval[]): readonly TimeInterval[] {
  let parts: TimeInterval[] = [source];
  for (const blocker of blocked) {
    const next: TimeInterval[] = [];
    for (const part of parts) {
      const overlap = intersectInterval(part, blocker);
      if (!overlap) {
        next.push(part);
        continue;
      }
      if (overlap.startAt > part.startAt) {
        next.push({startAt: part.startAt, endAt: overlap.startAt});
      }
      if (overlap.endAt < part.endAt) {
        next.push({startAt: overlap.endAt, endAt: part.endAt});
      }
    }
    parts = next;
    if (!parts.length) break;
  }
  return parts;
}

function activityEvent(value: unknown, riderId: string, eventId: string): RiderRewardActivityEvent | null {
  const source = record(value);
  const type = [
    "ONLINE",
    "HEARTBEAT",
    "OFFLINE",
    "ORDER_ASSIGNED",
    "ORDER_ACCEPTED",
    "ORDER_PICKED_UP",
    "ORDER_DELIVERED",
    "ORDER_REJECTED",
    "ORDER_CANCELLED_AFTER_ACCEPT",
    "SHIFT_CANCELLED",
    "BREAK_STARTED",
    "BREAK_ENDED",
    "APP_DISCONNECTED",
  ].includes(String(source.type)) ? source.type as RiderRewardActivityEventType : null;
  if (!type) return null;
  const occurredAt = integer(source.occurredAt, 0, 1);
  const normalizedRiderId = text(source.riderId, 128);
  const normalizedEventId = text(source.eventId, 180);
  if (occurredAt <= 0 || normalizedRiderId !== riderId || normalizedEventId !== eventId) return null;
  const metadataSource = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? source.metadata as Record<string, unknown>
    : {};
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(metadataSource)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) {
      metadata[text(key, 80)] = entry;
    }
  }
  return {
    schemaVersion: 1,
    riderId,
    eventId,
    type,
    occurredAt,
    orderId: text(source.orderId, 120),
    metadata,
  };
}

async function recordRiderRewardActivityEvent(
  riderIdInput: string,
  event: {
    eventId: string;
    type: RiderRewardActivityEventType;
    occurredAt: number;
    orderId?: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<void> {
  const riderId = identifier(riderIdInput);
  const eventId = text(event.eventId, 180);
  if (!riderId || !eventId) return;
  const path = `${RIDER_REWARD_ACTIVITY_EVENTS_ROOT}/${riderId}/${eventId}`;
  const candidate = {
    schemaVersion: 1,
    riderId,
    eventId,
    type: event.type,
    occurredAt: integer(event.occurredAt, Date.now(), 1),
    orderId: text(event.orderId, 120),
    metadata: event.metadata ?? {},
  } satisfies RiderRewardActivityEvent;
  await database.ref(path).transaction((current) => current ?? candidate, undefined, false);
}

async function readActivityEvents(
  database: RiderRewardsDatabase,
  riderId: string,
  startAt: number,
  endAt: number,
  limit = 5_000,
): Promise<readonly RiderRewardActivityEvent[]> {
  if (endAt < startAt) return [];
  const snapshot = await database.ref(`${RIDER_REWARD_ACTIVITY_EVENTS_ROOT}/${riderId}`)
    .orderByChild("occurredAt")
    .startAt(startAt)
    .endAt(endAt)
    .limitToLast(limit)
    .get();
  const source = record(snapshot.val());
  return Object.entries(source)
    .map(([eventId, value]) => activityEvent(value, riderId, eventId))
    .filter((entry): entry is RiderRewardActivityEvent => entry !== null)
    .sort((left, right) => left.occurredAt - right.occurredAt || left.eventId.localeCompare(right.eventId));
}

function buildOnlineIntervals(
  events: readonly RiderRewardActivityEvent[],
  referenceAt: number,
  timeoutMs = PRESENCE_HEARTBEAT_TIMEOUT_MS,
): readonly TimeInterval[] {
  const intervals: TimeInterval[] = [];
  let onlineStartAt: number | null = null;
  let lastHeartbeatAt: number | null = null;
  const closeCurrent = (endAt: number): void => {
    if (onlineStartAt === null || lastHeartbeatAt === null) return;
    const boundedEndAt = Math.min(endAt, lastHeartbeatAt + timeoutMs);
    if (boundedEndAt > onlineStartAt) intervals.push({startAt: onlineStartAt, endAt: boundedEndAt});
    onlineStartAt = null;
    lastHeartbeatAt = null;
  };
  for (const event of events) {
    if (event.type === "ONLINE" || event.type === "HEARTBEAT") {
      if (onlineStartAt === null || lastHeartbeatAt === null) {
        onlineStartAt = event.occurredAt;
        lastHeartbeatAt = event.occurredAt;
        continue;
      }
      if (event.occurredAt > lastHeartbeatAt + timeoutMs) {
        closeCurrent(lastHeartbeatAt + timeoutMs);
        onlineStartAt = event.occurredAt;
      }
      lastHeartbeatAt = event.occurredAt;
      continue;
    }
    if (event.type === "OFFLINE" || event.type === "APP_DISCONNECTED" || event.type === "BREAK_STARTED") {
      closeCurrent(event.occurredAt);
      continue;
    }
    if (event.type === "BREAK_ENDED" && onlineStartAt === null) {
      onlineStartAt = event.occurredAt;
      lastHeartbeatAt = event.occurredAt;
    }
  }
  closeCurrent(referenceAt);
  return mergeIntervals(intervals);
}

function hasAnyMeaningfulProgress(slot: RiderRewardConditionSlotProgress): boolean {
  return slot.qualifiedOnlineMs > 0 || slot.qualifiedActiveMs > 0 || slot.acceptedOrders > 0 || slot.completedDeliveries > 0;
}

function countEventsInInterval(
  events: readonly RiderRewardActivityEvent[],
  type: RiderRewardActivityEventType,
  interval: TimeInterval,
): number {
  const ids = new Set<string>();
  let count = 0;
  for (const event of events) {
    if (event.type !== type || event.occurredAt < interval.startAt || event.occurredAt >= interval.endAt) continue;
    if (event.orderId) {
      if (ids.has(event.orderId)) continue;
      ids.add(event.orderId);
    }
    count += 1;
  }
  return count;
}

function uniqueEventCounterKey(event: RiderRewardActivityEvent): string {
  const shiftId = text(event.metadata.shiftId, 120);
  if (shiftId) return `shift:${shiftId}`;
  if (event.orderId) return `order:${event.orderId}`;
  return `event:${event.eventId}`;
}

function slotDurationMs(slot: RiderRewardConditionSlot): number {
  return (slot.endMinute > slot.startMinute
    ? slot.endMinute - slot.startMinute
    : slot.endMinute + 1_440 - slot.startMinute) * 60 * 1_000;
}

function slotOfflineToleranceMs(slot: RiderRewardConditionSlot): number {
  return Math.max(0, slot.offlineToleranceMinutes) * 60 * 1_000;
}

function slotRequiredOnlineMs(slot: RiderRewardConditionSlot): number {
  const durationMs = slotDurationMs(slot);
  const byDuration = (slot.requiredDurationMinutes ?? 0) * 60 * 1_000;
  const byPercentage = slot.requiredOnlinePercentage === null ? 0 : Math.ceil(durationMs * slot.requiredOnlinePercentage / 100);
  const byTimeline = Math.max(60 * 1_000, durationMs - slotOfflineToleranceMs(slot));
  return Math.max(byDuration, byPercentage, byTimeline, 60 * 1_000);
}

function buildSlotInstances(
  campaign: RiderRewardCampaign,
  groups: readonly RiderRewardConditionGroup[],
  period: {startAt: number; endAt: number; timezone: string},
  selectedDayKey: string,
  riderProfile: Record<string, unknown>,
): readonly RiderRewardSlotInstance[] {
  const timeZone = safeTimeZone(period.timezone);
  const periodStartDay = startOfZonedDay(Math.max(period.startAt, campaign.startAt), timeZone);
  const periodEndAt = Math.min(period.endAt, campaign.endAt);
  const riderCity = searchKey(riderProfile.city ?? "");
  const instances: RiderRewardSlotInstance[] = [];
  for (let cursor = periodStartDay; cursor < periodEndAt; cursor += 24 * 60 * 60 * 1_000) {
    const dayKey = referenceDayKeyAtTimeZone(cursor + 12 * 60 * 60 * 1_000, timeZone);
    if (campaign.eligibleDays.length && !campaign.eligibleDays.includes(zonedParts(cursor + 12 * 60 * 60 * 1_000, timeZone).weekday)) {
      continue;
    }
    for (const group of groups) {
      for (const slot of group.slots) {
        if (slot.disabledCityNames.length && riderCity &&
          slot.disabledCityNames.some((name) => searchKey(name) === riderCity)) {
          continue;
        }
        const startAt = cursor + slot.startMinute * 60 * 1_000;
        let endAt = cursor + slot.endMinute * 60 * 1_000;
        if (slot.endMinute <= slot.startMinute) endAt += 24 * 60 * 60 * 1_000;
        if (endAt <= campaign.startAt || startAt >= periodEndAt || endAt <= period.startAt) continue;
        instances.push({
          instanceId: `${group.groupId}:${slot.slotId}:${dayKey}`,
          dayKey,
          groupId: group.groupId,
          groupTitle: group.title,
          minimumSlotsRequired: group.minimumSlotsRequired,
          slot,
          startAt,
          endAt,
          selectedDay: dayKey === selectedDayKey,
        });
      }
    }
  }
  return instances.sort((left, right) => left.startAt - right.startAt || left.instanceId.localeCompare(right.instanceId));
}

function activitySummaryForPeriod(
  events: readonly RiderRewardActivityEvent[],
  periodStartAt: number,
  periodEndAt: number,
): RiderRewardActivitySummary {
  const scopedEvents = events.filter((event) => event.occurredAt >= periodStartAt && event.occurredAt <= periodEndAt);
  const onlineIntervals = buildOnlineIntervals(scopedEvents, periodEndAt);
  const acceptedOrderIds = new Set<string>();
  const deliveredOrderIds = new Set<string>();
  const cancelledAcceptedOrderIds = new Set<string>();
  const cancelledBookedShiftIds = new Set<string>();
  let rejectedOrderCount = 0;
  for (const event of scopedEvents) {
    if (event.type === "ORDER_ACCEPTED" && event.orderId) acceptedOrderIds.add(event.orderId);
    if (event.type === "ORDER_DELIVERED" && event.orderId) deliveredOrderIds.add(event.orderId);
    if (event.type === "ORDER_CANCELLED_AFTER_ACCEPT" && event.orderId) cancelledAcceptedOrderIds.add(event.orderId);
    if (event.type === "SHIFT_CANCELLED") cancelledBookedShiftIds.add(uniqueEventCounterKey(event));
    if (event.type === "ORDER_REJECTED") rejectedOrderCount += 1;
  }
  const onlineDurationMs = onlineIntervals.reduce((total, interval) => total + intervalDuration(interval), 0);
  const elapsedMs = Math.max(0, periodEndAt - periodStartAt);
  return {
    onlineIntervals,
    acceptedOrderIds,
    rejectedOrderCount,
    deliveredOrderIds,
    cancelledAcceptedOrderIds,
    cancelledBookedShiftIds,
    completedTrips: deliveredOrderIds.size,
    acceptedOrders: acceptedOrderIds.size,
    onlineDurationMs,
    activeDurationMs: onlineDurationMs,
    offlineDurationMs: Math.max(0, elapsedMs - onlineDurationMs),
  };
}

function defaultOtherConditionTitle(condition: RiderRewardOtherCondition): string {
  switch (condition.type) {
  case "max_rejected_orders": return "Order rejections";
  case "max_cancelled_booked_shifts": return "Cancelled booked shifts";
  case "max_incomplete_shifts": return "Incomplete shifts";
  case "max_cancelled_accepted_orders": return "Cancelled accepted orders";
  case "min_acceptance_rate": return "Acceptance rate";
  case "min_completion_rate": return "Completion rate";
  case "min_customer_rating": return "Customer rating";
  case "max_offline_duration_minutes": return "Offline duration";
  case "min_active_duration_minutes": return "Active duration";
  case "min_completed_trips": return "Completed trips";
  }
}

function evaluateOtherCondition(
  condition: RiderRewardOtherCondition,
  summary: RiderRewardActivitySummary,
  riderProfile: Record<string, unknown>,
  slotProgress: readonly RiderRewardConditionGroupProgress[],
): RiderRewardOtherConditionProgress {
  const title = condition.title || defaultOtherConditionTitle(condition);
  const incompleteShifts = slotProgress.reduce((total, group) =>
    total + group.slots.filter((slot) => slot.state === "FAILED" && hasAnyMeaningfulProgress(slot)).length, 0);
  const acceptanceDenominator = summary.acceptedOrders + summary.rejectedOrderCount;
  const acceptanceRate = acceptanceDenominator > 0 ? (summary.acceptedOrders / acceptanceDenominator) * 100 : 100;
  const completionRate = summary.acceptedOrders > 0 ? (summary.completedTrips / summary.acceptedOrders) * 100 : 100;
  switch (condition.type) {
  case "max_rejected_orders": {
    const threshold = condition.maximumCount ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: summary.rejectedOrderCount <= threshold ? "ELIGIBLE" : "FAILED",
      currentValue: summary.rejectedOrderCount,
      thresholdValue: threshold,
      unit: "count",
      message: `${summary.rejectedOrderCount} / Maximum ${threshold}`,
    };
  }
  case "max_cancelled_booked_shifts": {
    const threshold = condition.maximumCount ?? 0;
    const currentValue = summary.cancelledBookedShiftIds.size;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: currentValue <= threshold ? "ELIGIBLE" : "FAILED",
      currentValue,
      thresholdValue: threshold,
      unit: "count",
      message: `${currentValue} / Maximum ${threshold}`,
    };
  }
  case "max_incomplete_shifts": {
    const threshold = condition.maximumCount ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: incompleteShifts <= threshold ? "ELIGIBLE" : "FAILED",
      currentValue: incompleteShifts,
      thresholdValue: threshold,
      unit: "count",
      message: `${incompleteShifts} / Maximum ${threshold}`,
    };
  }
  case "max_cancelled_accepted_orders": {
    const currentValue = summary.cancelledAcceptedOrderIds.size;
    const threshold = condition.maximumCount ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: currentValue <= threshold ? "ELIGIBLE" : "FAILED",
      currentValue,
      thresholdValue: threshold,
      unit: "count",
      message: `${currentValue} / Maximum ${threshold}`,
    };
  }
  case "min_acceptance_rate": {
    const threshold = condition.minimumPercentage ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: acceptanceRate >= threshold ? "ELIGIBLE" : "FAILED",
      currentValue: Math.round(acceptanceRate * 100) / 100,
      thresholdValue: threshold,
      unit: "percent",
      message: `${Math.round(acceptanceRate)}% / Minimum ${Math.round(threshold)}%`,
    };
  }
  case "min_completion_rate": {
    const threshold = condition.minimumPercentage ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: completionRate >= threshold ? "ELIGIBLE" : "FAILED",
      currentValue: Math.round(completionRate * 100) / 100,
      thresholdValue: threshold,
      unit: "percent",
      message: `${Math.round(completionRate)}% / Minimum ${Math.round(threshold)}%`,
    };
  }
  case "min_customer_rating": {
    const currentValue = Number(riderProfile.rating ?? 0);
    const threshold = condition.minimumRating ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: currentValue >= threshold ? "ELIGIBLE" : "FAILED",
      currentValue,
      thresholdValue: threshold,
      unit: "rating",
      message: `${currentValue.toFixed(1)}★ / Minimum ${threshold.toFixed(1)}★`,
    };
  }
  case "max_offline_duration_minutes": {
    const currentValue = Math.round(summary.offlineDurationMs / 60_000);
    const threshold = condition.maximumMinutes ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: currentValue <= threshold ? "ELIGIBLE" : "FAILED",
      currentValue,
      thresholdValue: threshold,
      unit: "minutes",
      message: `${currentValue} / Maximum ${threshold} min`,
    };
  }
  case "min_active_duration_minutes": {
    const currentValue = Math.round(summary.activeDurationMs / 60_000);
    const threshold = condition.minimumMinutes ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: currentValue >= threshold ? "ELIGIBLE" : "FAILED",
      currentValue,
      thresholdValue: threshold,
      unit: "minutes",
      message: `${currentValue} / Minimum ${threshold} min`,
    };
  }
  case "min_completed_trips": {
    const threshold = condition.minimumCount ?? 0;
    return {
      conditionId: condition.conditionId,
      type: condition.type,
      title,
      status: summary.completedTrips >= threshold ? "ELIGIBLE" : "FAILED",
      currentValue: summary.completedTrips,
      thresholdValue: threshold,
      unit: "count",
      message: `${summary.completedTrips} / Minimum ${threshold}`,
    };
  }
  }
}

function milestonePotentialRewardPaise(campaign: RiderRewardCampaign): number {
  if (!campaign.milestones.length) return campaign.rewardAmountPaise ?? 0;
  if (campaign.milestonePayoutMode === "cumulative") {
    return campaign.milestones.reduce((total, milestone) => total + milestone.rewardAmountPaise, 0);
  }
  return campaign.milestones[campaign.milestones.length - 1]?.rewardAmountPaise ?? 0;
}

function unlockedMilestoneRewardPaise(campaign: RiderRewardCampaign, completedTrips: number): number {
  const reached = campaign.milestones.filter((milestone) => completedTrips >= milestone.target);
  if (!reached.length) return 0;
  if (campaign.milestonePayoutMode === "cumulative") {
    return reached.reduce((total, milestone) => total + milestone.rewardAmountPaise, 0);
  }
  return reached[reached.length - 1]?.rewardAmountPaise ?? 0;
}

function nextMilestoneFor(campaign: RiderRewardCampaign, completedTrips: number): RiderRewardOffer["nextMilestone"] {
  const next = campaign.milestones.find((milestone) => completedTrips < milestone.target) ?? null;
  if (!next) return null;
  return {
    target: next.target,
    rewardAmountPaise: next.rewardAmountPaise,
    remainingTrips: Math.max(0, next.target - completedTrips),
  };
}

function creditedRewardPaiseForPeriod(
  journals: readonly LedgerJournal[],
  riderId: string,
  campaignId: string,
  periodKey: string,
): {creditedRewardPaise: number; journalId: string} {
  let creditedRewardPaise = 0;
  let journalId = "";
  for (const journal of journals) {
    if (journal.eventType !== "rider_incentive") continue;
    if (String(journal.metadata.campaignId ?? "") !== campaignId) continue;
    if (String(journal.metadata.periodKey ?? "") !== periodKey) continue;
    const movement = riderLedgerMovement(journal, riderId);
    creditedRewardPaise += Math.max(0, movement.earningsMovementPaise);
    journalId ||= journal.journalId;
  }
  return {creditedRewardPaise, journalId};
}

function staticOfferEligibility(
  campaign: RiderRewardCampaign,
  riderId: string,
  riderProfile: Record<string, unknown>,
  referenceAt: number,
  completedTripsAfter: number,
  sessionKeys: ReadonlySet<string>,
): {visible: boolean; status: RiderRewardOfferStatus; eligibilityMessage: string} {
  if (campaign.archived || !campaign.visible) {
    return {visible: false, status: "CANCELLED", eligibilityMessage: ""};
  }
  if (!campaign.active) {
    return {visible: true, status: "CANCELLED", eligibilityMessage: "This incentive is currently inactive."};
  }
  if (referenceAt < campaign.startAt) {
    return {visible: true, status: "UPCOMING", eligibilityMessage: ""};
  }
  if (referenceAt >= campaign.endAt) {
    return {visible: true, status: "EXPIRED", eligibilityMessage: ""};
  }
  if (!matchesDay(campaign, referenceAt)) {
    return {visible: true, status: "unavailable", eligibilityMessage: ""};
  }
  if (campaign.riderIds.length && !campaign.riderIds.includes(riderId)) {
    return {visible: true, status: "locked", eligibilityMessage: "This offer is not assigned to this rider."};
  }
  if (campaign.cityNames.length) {
    const riderCity = searchKey(riderProfile.city ?? "");
    if (!campaign.cityNames.some((name) => searchKey(name) === riderCity)) {
      return {visible: true, status: "locked", eligibilityMessage: "This offer is not available in the rider's city."};
    }
  }
  if (campaign.eligibleRiderTypes.length) {
    const riderType = searchKey(riderProfile.riderType ?? riderProfile.category ?? riderProfile.partnerType ?? "");
    if (!campaign.eligibleRiderTypes.some((entry) => searchKey(entry) === riderType)) {
      return {visible: true, status: "locked", eligibilityMessage: "This offer is limited to selected rider categories."};
    }
  }
  if (campaign.vehicleTypes.length) {
    const vehicleType = searchKey(riderProfile.vehicleType ?? "");
    if (!campaign.vehicleTypes.some((entry) => searchKey(entry) === vehicleType)) {
      return {visible: true, status: "locked", eligibilityMessage: "This offer is limited to selected vehicle types."};
    }
  }
  if (campaign.minimumAccountAgeDays !== null) {
    const accountStartAt = integer(
      riderProfile.approvedAt ?? riderProfile.createdAt ?? riderProfile.submittedAt ?? riderProfile.updatedAt,
      0,
      0,
    );
    if (!accountStartAt || referenceAt - accountStartAt < campaign.minimumAccountAgeDays * 24 * 60 * 60 * 1_000) {
      return {visible: true, status: "locked", eligibilityMessage: `Minimum account age is ${campaign.minimumAccountAgeDays} days.`};
    }
  }
  if (campaign.minRating !== null) {
    const rating = Number(riderProfile.rating ?? 0);
    if (!Number.isFinite(rating) || rating < campaign.minRating) {
      return {visible: true, status: "locked", eligibilityMessage: `Minimum rider rating is ${campaign.minRating.toFixed(1)}★.`};
    }
  }
  if (campaign.minCompletedTrips !== null && completedTripsAfter < campaign.minCompletedTrips) {
    return {visible: true, status: "locked", eligibilityMessage: `Complete at least ${campaign.minCompletedTrips} deliveries before joining this offer.`};
  }
  if (campaign.firstNCompletedTrips !== null && completedTripsAfter > campaign.firstNCompletedTrips) {
    return {visible: true, status: "locked", eligibilityMessage: `This offer is only for the first ${campaign.firstNCompletedTrips} completed trips.`};
  }
  if (campaign.requireDailyLoginSession && !campaignHasConfiguredSessionSlots(campaign)) {
    return {
      visible: true,
      status: "locked",
      eligibilityMessage: "Login-session slots are not configured for this incentive yet.",
    };
  }
  return {visible: true, status: "ACTIVE", eligibilityMessage: ""};
}

function formatProgressDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function computeCampaignProgressSnapshot(input: {
  campaign: RiderRewardCampaign;
  riderId: string;
  riderProfile: Record<string, unknown>;
  referenceAt: number;
  activityEvents: readonly RiderRewardActivityEvent[];
  riderSessionKeys: ReadonlySet<string>;
  riderJournals: readonly LedgerJournal[];
  completedTripsLifetime: number;
}): RiderRewardProgressSnapshot {
  const staticEligibility = staticOfferEligibility(
    input.campaign,
    input.riderId,
    input.riderProfile,
    input.referenceAt,
    input.completedTripsLifetime,
    input.riderSessionKeys,
  );
  const period = periodBoundsAtTimeZone(input.campaign.window, input.referenceAt, input.campaign);
  const effectiveStartAt = Math.max(period.startAt, input.campaign.startAt);
  const effectiveEndAt = Math.min(period.endAt, input.campaign.endAt);
  const effectiveReferenceAt = Math.max(effectiveStartAt, Math.min(input.referenceAt, effectiveEndAt));
  const selectedDayKey = referenceDayKeyAtTimeZone(input.referenceAt, period.timezone);
  const activeProgressGroups = progressConditionGroups(input.campaign);
  const progressId = createHash("sha1")
    .update(`${input.campaign.campaignId}|${input.riderId}|${period.key}`)
    .digest("hex")
    .slice(0, 40);
  const activitySummary = activitySummaryForPeriod(input.activityEvents, effectiveStartAt, effectiveReferenceAt);
  const slotInstances = buildSlotInstances(input.campaign, activeProgressGroups, period, selectedDayKey, input.riderProfile);
  const usedIntervals: TimeInterval[] = [];
  const slotProgressByInstance = new Map<string, RiderRewardConditionSlotProgress>();
  for (const instance of slotInstances) {
    const rawPieces = activitySummary.onlineIntervals
      .map((interval) => intersectInterval(interval, {
        startAt: instance.startAt,
        endAt: instance.endAt + instance.slot.gracePeriodMinutes * 60 * 1_000,
      }))
      .filter((interval): interval is TimeInterval => interval !== null);
    const effectivePieces = (input.campaign.allowOverlappingSlotCredit || instance.slot.overlapMode === "allow_double_count")
      ? rawPieces
      : rawPieces.flatMap((piece) => subtractInterval(piece, usedIntervals));
    if (!(input.campaign.allowOverlappingSlotCredit || instance.slot.overlapMode === "allow_double_count")) {
      usedIntervals.push(...effectivePieces);
    }
    const qualifiedOnlineMs = effectivePieces.reduce((total, interval) => total + intervalDuration(interval), 0);
    const qualifiedActiveMs = qualifiedOnlineMs;
    const acceptedOrders = countEventsInInterval(input.activityEvents, "ORDER_ACCEPTED", {
      startAt: instance.startAt,
      endAt: instance.endAt + instance.slot.gracePeriodMinutes * 60 * 1_000,
    });
    const completedDeliveries = countEventsInInterval(input.activityEvents, "ORDER_DELIVERED", {
      startAt: instance.startAt,
      endAt: instance.endAt + instance.slot.gracePeriodMinutes * 60 * 1_000,
    });
    const requiredOnlineMs = slotRequiredOnlineMs(instance.slot);
    const requiredActiveMs = Math.max(0, (instance.slot.requiredActiveDurationMinutes ?? 0) * 60 * 1_000);
    const requiredAcceptedOrders = Math.max(0, instance.slot.minimumOrdersAccepted ?? 0);
    const requiredCompletedDeliveries = Math.max(0, instance.slot.minimumCompletedDeliveries ?? 0);
    const onlineRatio = requiredOnlineMs > 0 ? qualifiedOnlineMs / requiredOnlineMs : 1;
    const activeRatio = requiredActiveMs > 0 ? qualifiedActiveMs / requiredActiveMs : 1;
    const acceptedRatio = requiredAcceptedOrders > 0 ? acceptedOrders / requiredAcceptedOrders : 1;
    const deliveryRatio = requiredCompletedDeliveries > 0 ? completedDeliveries / requiredCompletedDeliveries : 1;
    const progressPercent = Math.max(0, Math.min(100, Math.round(Math.min(onlineRatio, activeRatio, acceptedRatio, deliveryRatio) * 100)));
    const completed = qualifiedOnlineMs >= requiredOnlineMs &&
      qualifiedActiveMs >= requiredActiveMs &&
      acceptedOrders >= requiredAcceptedOrders &&
      completedDeliveries >= requiredCompletedDeliveries;
    let state: RiderRewardConditionSlotProgress["state"];
    const slotDeadlineAt = instance.endAt + instance.slot.gracePeriodMinutes * 60 * 1_000;
    if (completed) state = "COMPLETED";
    else if (effectiveReferenceAt < instance.startAt) state = "UPCOMING";
    else if (effectiveReferenceAt >= slotDeadlineAt) state = "FAILED";
    else if (qualifiedOnlineMs > 0 || acceptedOrders > 0 || completedDeliveries > 0) state = "IN_PROGRESS";
    else state = "NOT_STARTED";
    slotProgressByInstance.set(instance.instanceId, {
      slotId: instance.slot.slotId,
      label: instance.slot.label,
      startMinute: instance.slot.startMinute,
      endMinute: instance.slot.endMinute,
      state,
      qualifiedOnlineMs,
      requiredOnlineMs,
      offlineToleranceMs: slotOfflineToleranceMs(instance.slot),
      qualifiedActiveMs,
      requiredActiveMs,
      acceptedOrders,
      requiredAcceptedOrders,
      completedDeliveries,
      requiredCompletedDeliveries,
      progressPercent,
      remainingOnlineMs: Math.max(0, requiredOnlineMs - qualifiedOnlineMs),
    });
  }
  const completedSessionsByDay: Record<string, number> = {};
  const completedSessionKeys = new Set<string>();
  for (const instance of slotInstances) {
    const slotProgress = slotProgressByInstance.get(instance.instanceId);
    if (!slotProgress || slotProgress.state !== "COMPLETED") continue;
    const completionKey = `${instance.dayKey}:${instance.slot.startMinute}:${instance.slot.endMinute}:${searchKey(instance.slot.label || instance.slot.slotId)}`;
    if (completedSessionKeys.has(completionKey)) continue;
    completedSessionKeys.add(completionKey);
    completedSessionsByDay[instance.dayKey] = (completedSessionsByDay[instance.dayKey] ?? 0) + 1;
  }
  const sessionRequirement = evaluateCompletedSessionRequirement({
    campaign: input.campaign,
    completedSessionsByDay,
    referenceAt: input.referenceAt,
    periodStartAt: effectiveStartAt,
    periodEndAt: effectiveEndAt,
    timeZone: period.timezone,
  });
  const groupProgress = activeProgressGroups.map((group): RiderRewardConditionGroupProgress => {
    const slots = slotInstances
      .filter((instance) => instance.groupId === group.groupId)
      .map((instance) => slotProgressByInstance.get(instance.instanceId))
      .filter((slot): slot is RiderRewardConditionSlotProgress => slot !== undefined);
    const completedSlots = slots.filter((slot) => slot.state === "COMPLETED").length;
    const qualified = completedSlots >= group.minimumSlotsRequired;
    const possibleSlots = slots.filter((slot) => slot.state !== "FAILED").length;
    const failed = !qualified && possibleSlots < group.minimumSlotsRequired;
    const pendingNeeded = Math.max(0, group.minimumSlotsRequired - completedSlots);
    return {
      groupId: group.groupId,
      title: group.title,
      minimumSlotsRequired: group.minimumSlotsRequired,
      completedSlots,
      qualified,
      status: qualified ? "COMPLETED" : failed ? "FAILED" : "PENDING",
      message: qualified
        ? "Login condition completed"
        : failed
          ? "Not enough qualifying slots remain for this group."
          : `${pendingNeeded} more slot${pendingNeeded === 1 ? "" : "s"} needed from this group.`,
      slots,
    };
  });
  const selectedDayGroups = activeProgressGroups.map((group): RiderRewardConditionGroupProgress => {
    const slots = slotInstances
      .filter((instance) => instance.groupId === group.groupId && instance.selectedDay)
      .map((instance) => slotProgressByInstance.get(instance.instanceId))
      .filter((slot): slot is RiderRewardConditionSlotProgress => slot !== undefined);
    const overall = groupProgress.find((entry) => entry.groupId === group.groupId);
    return {
      groupId: group.groupId,
      title: group.title,
      minimumSlotsRequired: group.minimumSlotsRequired,
      completedSlots: overall?.completedSlots ?? 0,
      qualified: overall?.qualified ?? false,
      status: overall?.status ?? "PENDING",
      message: overall?.message ?? "",
      slots,
    };
  });
  const currentDaySlotProgress = slotInstances
    .filter((instance) => instance.dayKey === sessionRequirement.todayDayKey)
    .map((instance) => slotProgressByInstance.get(instance.instanceId))
    .filter((slot): slot is RiderRewardConditionSlotProgress => slot !== undefined);
  const maximumPossibleSessionsToday = currentDaySlotProgress
    .filter((slot) => slot.state !== "FAILED" && slot.state !== "LOCKED")
    .length;
  const dailySessionRequirementIrrecoverable = input.campaign.window === "daily" &&
    sessionRequirement.status === "PENDING" &&
    (
      groupProgress.some((group) => group.status === "FAILED") ||
      maximumPossibleSessionsToday < sessionRequirement.requiredSessionsPerDay
    );
  const effectiveSessionRequirement = dailySessionRequirementIrrecoverable
    ? {
      ...sessionRequirement,
      status: "FAILED" as const,
      message: `Only ${sessionRequirement.todayCompletedSessions} / ${sessionRequirement.requiredSessionsPerDay} valid session${sessionRequirement.requiredSessionsPerDay === 1 ? "" : "s"} were completed for this day.`,
    }
    : sessionRequirement;
  const otherConditions = input.campaign.otherConditions
    .filter((condition) => condition.enabled)
    .map((condition) => evaluateOtherCondition(condition, activitySummary, input.riderProfile, groupProgress));
  const allGroupsSatisfied = groupProgress.every((group) => group.qualified);
  const allOtherSatisfied = otherConditions.every((condition) => condition.status !== "FAILED");
  const loginRequirementSatisfied = effectiveSessionRequirement.status === "DISABLED" || effectiveSessionRequirement.status === "ELIGIBLE";
  const currentUnlockedRewardPaise = unlockedMilestoneRewardPaise(input.campaign, activitySummary.completedTrips);
  const potentialRewardPaise = milestonePotentialRewardPaise(input.campaign);
  const credited = creditedRewardPaiseForPeriod(input.riderJournals, input.riderId, input.campaign.campaignId, period.key);
  const qualified = allGroupsSatisfied &&
    allOtherSatisfied &&
    loginRequirementSatisfied &&
    currentUnlockedRewardPaise > 0 &&
    staticEligibility.status !== "locked" &&
    staticEligibility.status !== "FAILED";
  const anyProgress = activitySummary.completedTrips > 0 ||
    activitySummary.acceptedOrders > 0 ||
    activitySummary.rejectedOrderCount > 0 ||
    activitySummary.onlineDurationMs > 0;
  const periodEnded = effectiveReferenceAt >= effectiveEndAt;
  const failed = staticEligibility.status === "FAILED" ||
    effectiveSessionRequirement.status === "FAILED" ||
    groupProgress.some((group) => group.status === "FAILED") ||
    otherConditions.some((condition) => condition.status === "FAILED");
  let status: RiderRewardOfferStatus = staticEligibility.status;
  if (staticEligibility.status === "locked" || staticEligibility.status === "unavailable") {
    status = staticEligibility.status;
  } else if (staticEligibility.status === "FAILED" || failed) {
    status = "FAILED";
  } else if (staticEligibility.status === "UPCOMING") {
    status = "UPCOMING";
  } else if (periodEnded) {
    status = credited.creditedRewardPaise > 0 ? "COMPLETED" : qualified ? "QUALIFIED" : "EXPIRED";
  } else if (qualified && currentUnlockedRewardPaise >= potentialRewardPaise && potentialRewardPaise > 0) {
    status = "QUALIFIED";
  } else if (anyProgress) {
    status = "IN_PROGRESS";
  } else {
    status = "ACTIVE";
  }
  const conditionsSummary = [
    input.campaign.requireDailyLoginSession
      ? `${rewardSessionConditionCopy(input.campaign)}${effectiveSessionRequirement.message ? ` ${effectiveSessionRequirement.message}` : ""}`.trim()
      : "",
    ...groupProgress.map((group) => `${group.title}: ${group.completedSlots}/${group.minimumSlotsRequired} completed`),
    ...otherConditions.map((condition) => `${condition.title}: ${condition.message}`),
    input.campaign.milestones.length
      ? `Trips completed: ${activitySummary.completedTrips} / ${input.campaign.milestones[input.campaign.milestones.length - 1]?.target ?? 0}`
      : "",
  ].filter(Boolean);
  return {
    schemaVersion: 1,
    progressId,
    riderId: input.riderId,
    campaignId: input.campaign.campaignId,
    title: input.campaign.title,
    periodKey: period.key,
    periodStartAt: effectiveStartAt,
    periodEndAt: effectiveEndAt,
    timezone: period.timezone,
    status,
    qualified,
    failed,
    activeNow: input.referenceAt >= input.campaign.startAt && input.referenceAt < input.campaign.endAt,
    offerActive: staticEligibility.status !== "locked" && staticEligibility.status !== "CANCELLED",
    tripsCompleted: activitySummary.completedTrips,
    acceptedOrders: activitySummary.acceptedOrders,
    rejectedOrders: activitySummary.rejectedOrderCount,
    currentUnlockedRewardPaise,
    potentialRewardPaise,
    creditedRewardPaise: credited.creditedRewardPaise,
    requiredSessionsPerDay: effectiveSessionRequirement.requiredSessionsPerDay,
    completedSessionsByDay,
    loginSessionRequirementStatus: effectiveSessionRequirement.status,
    loginSessionRequirementMessage: effectiveSessionRequirement.message,
    groups: groupProgress,
    selectedDayGroups,
    otherConditions,
    generatedAt: input.referenceAt,
    settlementJournalId: credited.journalId,
    conditionsSummary,
  };
}

function rewardProgressSnapshot(value: unknown): RiderRewardProgressSnapshot | null {
  const source = record(value);
  const riderId = identifier(source.riderId);
  const campaignId = identifier(source.campaignId);
  const progressId = text(source.progressId, 80);
  const periodKey = text(source.periodKey, 120);
  if (!riderId || !campaignId || !progressId || !periodKey) return null;
  const statusValue = String(source.status ?? "");
  const validStatuses: readonly RiderRewardOfferStatus[] = [
    "available",
    "future",
    "unavailable",
    "locked",
    "eligible_delivery_match_required",
    "completed",
    "UPCOMING",
    "ACTIVE",
    "IN_PROGRESS",
    "QUALIFIED",
    "COMPLETED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "PAID",
  ];
  if (!validStatuses.includes(statusValue as RiderRewardOfferStatus)) return null;
  const parseSlotProgressList = (value: unknown): readonly RiderRewardConditionSlotProgress[] => {
    if (!Array.isArray(value)) return [];
    const parsed: RiderRewardConditionSlotProgress[] = [];
    for (const slot of value) {
      const slotValue = record(slot);
      const state = String(slotValue.state ?? "");
      if (!["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "FAILED", "UPCOMING", "LOCKED"].includes(state)) continue;
      parsed.push({
        slotId: text(slotValue.slotId, 120),
        label: text(slotValue.label, 120),
        startMinute: integer(slotValue.startMinute, 0, 0, 1_439),
        endMinute: integer(slotValue.endMinute, 0, 0, 1_439),
        state: state as RiderRewardConditionSlotProgress["state"],
        qualifiedOnlineMs: integer(slotValue.qualifiedOnlineMs, 0, 0),
        requiredOnlineMs: integer(slotValue.requiredOnlineMs, 0, 0),
        offlineToleranceMs: integer(slotValue.offlineToleranceMs, 0, 0),
        qualifiedActiveMs: integer(slotValue.qualifiedActiveMs, 0, 0),
        requiredActiveMs: integer(slotValue.requiredActiveMs, 0, 0),
        acceptedOrders: integer(slotValue.acceptedOrders, 0, 0),
        requiredAcceptedOrders: integer(slotValue.requiredAcceptedOrders, 0, 0),
        completedDeliveries: integer(slotValue.completedDeliveries, 0, 0),
        requiredCompletedDeliveries: integer(slotValue.requiredCompletedDeliveries, 0, 0),
        progressPercent: integer(slotValue.progressPercent, 0, 0, 100),
        remainingOnlineMs: integer(slotValue.remainingOnlineMs, 0, 0),
      });
    }
    return parsed;
  };
  const parseGroupProgressList = (value: unknown): readonly RiderRewardConditionGroupProgress[] => {
    if (!Array.isArray(value)) return [];
    const parsed: RiderRewardConditionGroupProgress[] = [];
    for (const group of value) {
      const candidate = record(group);
      const status = String(candidate.status ?? "");
      if (!["PENDING", "COMPLETED", "FAILED"].includes(status)) continue;
      parsed.push({
        groupId: text(candidate.groupId, 120),
        title: text(candidate.title, 120),
        minimumSlotsRequired: integer(candidate.minimumSlotsRequired, 1, 1, 24),
        completedSlots: integer(candidate.completedSlots, 0, 0, 24),
        qualified: truthy(candidate.qualified),
        status: status as RiderRewardConditionGroupProgress["status"],
        message: text(candidate.message, 240),
        slots: parseSlotProgressList(candidate.slots),
      });
    }
    return parsed;
  };
  const groupProgress = parseGroupProgressList(source.groups);
  const selectedDayGroups = parseGroupProgressList(source.selectedDayGroups);
  const completedSessionsByDay = Object.fromEntries(Object.entries(record(source.completedSessionsByDay))
    .filter(([dayKey]) => /^\d{4}-\d{2}-\d{2}$/.test(dayKey))
    .map(([dayKey, count]) => [dayKey, integer(count, 0, 0, 24)]));
  const otherConditions = Array.isArray(source.otherConditions) ? source.otherConditions.reduce<RiderRewardOtherConditionProgress[]>((parsed, condition) => {
    const candidate = record(condition);
    const type = String(candidate.type ?? "");
    const status = String(candidate.status ?? "");
    if (![
      "max_rejected_orders",
      "max_cancelled_booked_shifts",
      "max_incomplete_shifts",
      "max_cancelled_accepted_orders",
      "min_acceptance_rate",
      "min_completion_rate",
      "min_customer_rating",
      "max_offline_duration_minutes",
      "min_active_duration_minutes",
      "min_completed_trips",
    ].includes(type) || !["PENDING", "ELIGIBLE", "FAILED"].includes(status)) return parsed;
    const unit = String(candidate.unit ?? "");
    if (!["count", "percent", "minutes", "rating"].includes(unit)) return parsed;
    parsed.push({
      conditionId: text(candidate.conditionId, 120),
      type: type as RiderRewardOtherConditionType,
      title: text(candidate.title, 120),
      status: status as RiderRewardOtherConditionProgress["status"],
      currentValue: Number(candidate.currentValue ?? 0),
      thresholdValue: Number(candidate.thresholdValue ?? 0),
      unit: unit as RiderRewardOtherConditionProgress["unit"],
      message: text(candidate.message, 240),
    });
    return parsed;
  }, []) : [];
  return {
    schemaVersion: 1,
    progressId,
    riderId,
    campaignId,
    title: text(source.title, 120),
    periodKey,
    periodStartAt: integer(source.periodStartAt, 0, 1),
    periodEndAt: integer(source.periodEndAt, 0, 1),
    timezone: text(source.timezone, 80, DEFAULT_REWARD_TIMEZONE),
    status: statusValue as RiderRewardOfferStatus,
    qualified: truthy(source.qualified),
    failed: truthy(source.failed),
    activeNow: truthy(source.activeNow),
    offerActive: truthy(source.offerActive),
    tripsCompleted: integer(source.tripsCompleted, 0, 0),
    acceptedOrders: integer(source.acceptedOrders, 0, 0),
    rejectedOrders: integer(source.rejectedOrders, 0, 0),
    currentUnlockedRewardPaise: integer(source.currentUnlockedRewardPaise, 0, 0),
    potentialRewardPaise: integer(source.potentialRewardPaise, 0, 0),
    creditedRewardPaise: integer(source.creditedRewardPaise, 0, 0),
    requiredSessionsPerDay: integer(source.requiredSessionsPerDay, 0, 0, 24),
    completedSessionsByDay,
    loginSessionRequirementStatus: ["DISABLED", "PENDING", "ELIGIBLE", "FAILED"].includes(String(source.loginSessionRequirementStatus ?? ""))
      ? source.loginSessionRequirementStatus as RiderRewardProgressSnapshot["loginSessionRequirementStatus"]
      : "DISABLED",
    loginSessionRequirementMessage: text(source.loginSessionRequirementMessage, 240),
    groups: groupProgress,
    selectedDayGroups,
    otherConditions,
    generatedAt: integer(source.generatedAt, 0, 1),
    settlementJournalId: text(source.settlementJournalId, 120),
    conditionsSummary: Array.isArray(source.conditionsSummary)
      ? source.conditionsSummary.map((entry) => text(entry, 240)).filter(Boolean)
      : [],
  };
}

function riderCampaignNeedsProgressTracking(campaign: RiderRewardCampaign): boolean {
  return campaign.kind === "milestone_bonus" ||
    campaign.conditionGroups.length > 0 ||
    campaign.otherConditions.length > 0 ||
    campaign.requireDailyLoginSession;
}

function campaignProgressPath(snapshot: RiderRewardProgressSnapshot): string {
  return `${RIDER_REWARD_CAMPAIGN_PROGRESS_ROOT}/${snapshot.campaignId}/${snapshot.progressId}`;
}

function riderProgressPath(snapshot: RiderRewardProgressSnapshot): string {
  return `${RIDER_REWARD_PROGRESS_ROOT}/${snapshot.riderId}/${snapshot.campaignId}/${snapshot.progressId}`;
}

async function persistRewardProgressSnapshot(
  snapshot: RiderRewardProgressSnapshot,
  database: RiderRewardsDatabase,
): Promise<void> {
  await Promise.all([
    database.ref(riderProgressPath(snapshot)).set(snapshot),
    database.ref(campaignProgressPath(snapshot)).set(snapshot),
  ]);
}

async function persistCompletedSessionDays(
  riderIdInput: string,
  snapshots: readonly RiderRewardProgressSnapshot[],
  recordedAtInput: number,
  database: RiderRewardsDatabase,
): Promise<void> {
  const riderId = identifier(riderIdInput);
  if (!riderId) return;
  const recordedAt = integer(recordedAtInput, Date.now(), 1);
  const perDayCounts = new Map<string, number>();
  for (const snapshot of snapshots) {
    for (const [dayKey, rawCount] of Object.entries(snapshot.completedSessionsByDay)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
      const count = integer(rawCount, 0, 0, 24);
      if (count <= 0) continue;
      perDayCounts.set(dayKey, Math.max(perDayCounts.get(dayKey) ?? 0, count));
    }
  }
  await Promise.all([...perDayCounts.entries()].map(async ([dayKey, completedSessions]) => {
    await database.ref(`${RIDER_REWARD_SESSION_DAYS_ROOT}/${riderId}/${dayKey}`).transaction((current) => {
      const existing = sessionDay(current, riderId, dayKey);
      return {
        schemaVersion: 1,
        riderId,
        dayKey,
        firstSeenAt: existing?.firstSeenAt ?? 0,
        lastSeenAt: existing?.lastSeenAt ?? 0,
        completedSessions: Math.max(existing?.completedSessions ?? 0, completedSessions),
        updatedAt: Math.max(existing?.updatedAt ?? 0, recordedAt),
      };
    }, undefined, false);
  }));
}

async function readCampaignProgressSnapshots(
  database: RiderRewardsDatabase,
  campaignId: string,
  limit: number,
): Promise<readonly RiderRewardProgressSnapshot[]> {
  const snapshot = await database.ref(`${RIDER_REWARD_CAMPAIGN_PROGRESS_ROOT}/${campaignId}`)
    .orderByChild("generatedAt")
    .limitToLast(limit)
    .get();
  const source = record(snapshot.val());
  return Object.values(source)
    .map((entry) => rewardProgressSnapshot(entry))
    .filter((entry): entry is RiderRewardProgressSnapshot => entry !== null)
    .sort((left, right) => right.generatedAt - left.generatedAt || left.progressId.localeCompare(right.progressId));
}

function rewardActivityWindow(
  campaigns: readonly RiderRewardCampaign[],
  referenceAt: number,
): {startAt: number; endAt: number} {
  const activeCampaigns = campaigns.filter((campaign) => riderCampaignNeedsProgressTracking(campaign));
  let startAt = referenceAt - 8 * 24 * 60 * 60 * 1_000;
  let endAt = referenceAt;
  for (const campaign of activeCampaigns) {
    const period = periodBoundsAtTimeZone(campaign.window, referenceAt, campaign);
    startAt = Math.min(startAt, Math.max(period.startAt, campaign.startAt) - 24 * 60 * 60 * 1_000);
    endAt = Math.max(endAt, Math.min(period.endAt, campaign.endAt));
  }
  return {startAt: Math.max(1, startAt), endAt: Math.max(startAt, endAt)};
}

function formatRewardMoneyPaise(paise: number): string {
  const rupees = Math.max(0, paise) / 100;
  return `₹${Number.isInteger(rupees) ? rupees.toFixed(0) : rupees.toFixed(2)}`;
}

interface RiderRewardNotificationInput {
  readonly riderId: string;
  readonly campaignId: string;
  readonly periodKey: string;
  readonly eventType: string;
  readonly deduplicationKey: string;
  readonly title: string;
  readonly body: string;
  readonly data?: Record<string, string>;
}

function rewardProgressNotificationInputs(
  campaign: RiderRewardCampaign,
  snapshot: RiderRewardProgressSnapshot,
): readonly RiderRewardNotificationInput[] {
  const notifications: RiderRewardNotificationInput[] = [];
  const nextMilestone = nextMilestoneFor(campaign, snapshot.tripsCompleted);
  if (snapshot.currentUnlockedRewardPaise > 0 && campaign.kind === "milestone_bonus") {
    const body = nextMilestone
      ? `${formatRewardMoneyPaise(snapshot.currentUnlockedRewardPaise)} unlocked. Complete ${nextMilestone.remainingTrips} more deliveries to reach ${formatRewardMoneyPaise(nextMilestone.rewardAmountPaise)}.`
      : `You have unlocked ${formatRewardMoneyPaise(snapshot.currentUnlockedRewardPaise)} in this offer.`;
    notifications.push({
      riderId: snapshot.riderId,
      campaignId: campaign.campaignId,
      periodKey: snapshot.periodKey,
      eventType: "RIDER_REWARD_MILESTONE_UNLOCKED",
      deduplicationKey: `reward-unlocked:${snapshot.riderId}:${campaign.campaignId}:${snapshot.periodKey}:${snapshot.currentUnlockedRewardPaise}`,
      title: `🔥 ${formatRewardMoneyPaise(snapshot.currentUnlockedRewardPaise)} unlocked`,
      body,
      data: {status: snapshot.status},
    });
  }
  for (const group of snapshot.groups.filter((entry) => entry.qualified)) {
    notifications.push({
      riderId: snapshot.riderId,
      campaignId: campaign.campaignId,
      periodKey: snapshot.periodKey,
      eventType: "RIDER_REWARD_GROUP_COMPLETED",
      deduplicationKey: `reward-group:${snapshot.riderId}:${campaign.campaignId}:${snapshot.periodKey}:${group.groupId}:${group.completedSlots}`,
      title: "✅ Login condition completed",
      body: `${group.title} is complete. ${group.completedSlots}/${group.minimumSlotsRequired} slot requirements passed.`,
      data: {groupId: group.groupId},
    });
  }
  for (const condition of snapshot.otherConditions) {
    if (condition.type === "max_rejected_orders" &&
        condition.status === "ELIGIBLE" &&
        condition.currentValue === condition.thresholdValue) {
      notifications.push({
        riderId: snapshot.riderId,
        campaignId: campaign.campaignId,
        periodKey: snapshot.periodKey,
        eventType: "RIDER_REWARD_WARNING",
        deduplicationKey: `reward-warning-rejections:${snapshot.riderId}:${campaign.campaignId}:${snapshot.periodKey}:${condition.conditionId}:${condition.currentValue}`,
        title: "⚠️ Incentive eligibility warning",
        body: `You have already rejected ${condition.currentValue} order${condition.currentValue === 1 ? "" : "s"}. Rejecting another order can remove this incentive.`,
        data: {conditionId: condition.conditionId},
      });
    }
  }
  for (const slot of snapshot.selectedDayGroups.flatMap((group) => group.slots)) {
    if (slot.state !== "IN_PROGRESS" || slot.remainingOnlineMs <= 0 || slot.remainingOnlineMs > 45 * 60 * 1_000) continue;
    notifications.push({
      riderId: snapshot.riderId,
      campaignId: campaign.campaignId,
      periodKey: snapshot.periodKey,
      eventType: "RIDER_REWARD_SLOT_WARNING",
      deduplicationKey: `reward-slot-warning:${snapshot.riderId}:${campaign.campaignId}:${snapshot.periodKey}:${slot.slotId}`,
      title: "⏰ Keep this incentive slot active",
      body: `You still need ${formatProgressDuration(slot.remainingOnlineMs)} online in ${slot.label} to complete this slot.`,
      data: {slotId: slot.slotId},
    });
  }
  if (snapshot.creditedRewardPaise > 0 && ["COMPLETED", "PAID"].includes(snapshot.status)) {
    notifications.push({
      riderId: snapshot.riderId,
      campaignId: campaign.campaignId,
      periodKey: snapshot.periodKey,
      eventType: "RIDER_REWARD_COMPLETED",
      deduplicationKey: `reward-completed:${snapshot.riderId}:${campaign.campaignId}:${snapshot.periodKey}:${snapshot.creditedRewardPaise}`,
      title: "🎉 Offer completed",
      body: `You earned ${formatRewardMoneyPaise(snapshot.creditedRewardPaise)} extra from ${campaign.title}.`,
      data: {journalId: snapshot.settlementJournalId},
    });
  }
  return notifications;
}

async function emitRewardProgressNotifications(
  campaign: RiderRewardCampaign,
  snapshot: RiderRewardProgressSnapshot,
): Promise<void> {
  const notifications = rewardProgressNotificationInputs(campaign, snapshot)
    .map((input) => notifyRiderRewardUpdate(input));
  await Promise.all(notifications.map((job) => job.catch((error) => {
    logger.warn("RIDER_REWARD_NOTIFICATION_FAILED", {
      riderId: snapshot.riderId,
      campaignId: campaign.campaignId,
      error,
    });
  })));
}

interface JournalMovement {
  readonly earningsMovementPaise: number;
  readonly tipMovementPaise: number;
  readonly codMovementPaise: number;
}

function riderLedgerMovement(journal: LedgerJournal, riderId: string): JournalMovement {
  const earningsAccount = `liability:rider-earnings:${riderId}`;
  const tipAccount = `liability:rider-tips:${riderId}`;
  const codAccount = `asset:cod-receivable:${riderId}`;
  let earningsMovementPaise = 0;
  let tipMovementPaise = 0;
  let codMovementPaise = 0;
  for (const entry of journal.entries) {
    if (entry.accountId === earningsAccount) {
      earningsMovementPaise += entry.side === "credit" ? entry.amountPaise : -entry.amountPaise;
    } else if (entry.accountId === tipAccount) {
      tipMovementPaise += entry.side === "credit" ? entry.amountPaise : -entry.amountPaise;
    } else if (entry.accountId === codAccount) {
      codMovementPaise += entry.side === "debit" ? entry.amountPaise : -entry.amountPaise;
    }
  }
  return {earningsMovementPaise, tipMovementPaise, codMovementPaise};
}

function validJournalPage(value: unknown): readonly LedgerJournal[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const journals: LedgerJournal[] = [];
  for (const candidate of Object.values(value as Record<string, unknown>)) {
    try {
      validateLedgerJournal(candidate as LedgerJournal);
      journals.push(candidate as LedgerJournal);
    } catch {
      // Invalid journals stay excluded here; the authoritative finance summary
      // already exposes reconciliation status for fail-closed consumer screens.
    }
  }
  return journals.sort((left, right) => right.occurredAt - left.occurredAt);
}

async function readRecentLedgerJournals(
  limit: number,
  database: RiderRewardsDatabase,
): Promise<readonly LedgerJournal[]> {
  const page = await database.ref(LEDGER_JOURNALS_ROOT).orderByChild("occurredAt").limitToLast(limit).get();
  return validJournalPage(page.val());
}

function relevantRiderJournal(journal: LedgerJournal, riderId: string): boolean {
  const movement = riderLedgerMovement(journal, riderId);
  return movement.earningsMovementPaise !== 0 || movement.tipMovementPaise !== 0 || movement.codMovementPaise !== 0;
}

function isCompletedDeliveryJournal(journal: LedgerJournal, riderId: string): boolean {
  if (!["cod_delivery", "payment"].includes(journal.eventType)) return false;
  const movement = riderLedgerMovement(journal, riderId);
  return movement.earningsMovementPaise > 0 || movement.tipMovementPaise > 0 || movement.codMovementPaise > 0;
}

function completedDeliveriesInWindow(
  journals: readonly LedgerJournal[],
  riderId: string,
  startAt: number,
  endAt: number,
): number {
  return journals.filter((journal) =>
    journal.occurredAt >= startAt &&
    journal.occurredAt < endAt &&
    isCompletedDeliveryJournal(journal, riderId)
  ).length;
}

function positiveReferralRewardInWindow(
  journals: readonly LedgerJournal[],
  riderId: string,
): number {
  return journals.reduce((total, journal) => {
    if (journal.eventType !== "rider_referral_reward") return total;
    return total + Math.max(0, riderLedgerMovement(journal, riderId).earningsMovementPaise);
  }, 0);
}

function payoutEntriesFromHistory(summary: RiderFinancialSummary): readonly RiderPayoutEntry[] {
  return summary.history
    .filter((row) => row.eventType === "rider_payout")
    .map((row) => ({
      journalId: row.journalId,
      occurredAt: row.occurredAt,
      amountPaise: Math.abs(row.earningsMovementPaise + row.tipsMovementPaise),
      status: "paid" as const,
      reference: row.journalId,
    }));
}

function dayBreakdownFromHistory(
  summary: RiderFinancialSummary,
  riderId: string,
  referenceAt: number,
): {bars: readonly RiderRewardDailyBar[]; selected: RiderRewardBreakdown} {
  const startAt = startOfIstWeek(referenceAt);
  const requestedDayKey = referenceDayKey(referenceAt);
  const bars: RiderRewardDailyBar[] = [];
  const buckets = new Map<string, RiderRewardBreakdown>();
  for (let index = 0; index < 7; index++) {
    const dayStart = startAt + index * 24 * 60 * 60 * 1_000;
    const key = referenceDayKey(dayStart);
    buckets.set(key, {
      dayKey: key,
      completedTrips: 0,
      tripEarningsPaise: 0,
      incentivePaise: 0,
      referralPaise: 0,
      tipPaise: 0,
      payoutPaise: 0,
      codCollectedPaise: 0,
    });
  }
  for (const row of summary.history) {
    const key = referenceDayKey(row.occurredAt);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const next = {...bucket};
    if (["cod_delivery", "payment"].includes(row.eventType) && row.earningsMovementPaise > 0) {
      next.completedTrips += 1;
      next.tripEarningsPaise += row.earningsMovementPaise;
      next.tipPaise += Math.max(0, row.tipsMovementPaise);
      next.codCollectedPaise += Math.max(0, row.codMovementPaise);
    } else if (row.eventType === "rider_incentive") {
      next.incentivePaise += row.earningsMovementPaise;
    } else if (row.eventType === "rider_referral_reward") {
      next.referralPaise += row.earningsMovementPaise;
    } else if (row.eventType === "rider_payout") {
      next.payoutPaise += Math.abs(row.earningsMovementPaise + row.tipsMovementPaise);
    }
    buckets.set(key, next);
  }
  for (let index = 0; index < 7; index++) {
    const dayStart = startAt + index * 24 * 60 * 60 * 1_000;
    const key = referenceDayKey(dayStart);
    const bucket = buckets.get(key)!;
    const label = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index] ?? "Day";
    bars.push({
      dayKey: key,
      label,
      totalEarnedPaise: bucket.tripEarningsPaise + bucket.incentivePaise + bucket.referralPaise + bucket.tipPaise,
      tripEarningsPaise: bucket.tripEarningsPaise,
      incentivePaise: bucket.incentivePaise,
      referralPaise: bucket.referralPaise,
      tipPaise: bucket.tipPaise,
      payoutPaise: bucket.payoutPaise,
    });
  }
  const requested = buckets.get(requestedDayKey) ?? null;
  const latestEarnedDay = [...buckets.values()]
    .filter((bucket) =>
      bucket.tripEarningsPaise > 0 ||
      bucket.incentivePaise > 0 ||
      bucket.referralPaise > 0 ||
      bucket.tipPaise > 0)
    .sort((left, right) => left.dayKey.localeCompare(right.dayKey))
    .slice(-1)[0] ?? null;
  const selectedDayKey = requested && (
    requested.tripEarningsPaise > 0 ||
    requested.incentivePaise > 0 ||
    requested.referralPaise > 0 ||
    requested.tipPaise > 0
  )
    ? requestedDayKey
    : latestEarnedDay?.dayKey ?? requestedDayKey;
  return {
    bars,
    selected: buckets.get(selectedDayKey) ?? {
      dayKey: selectedDayKey,
      completedTrips: 0,
      tripEarningsPaise: 0,
      incentivePaise: 0,
      referralPaise: 0,
      tipPaise: 0,
      payoutPaise: 0,
      codCollectedPaise: 0,
    },
  };
}

function riderStaticEligibility(
  campaign: RiderRewardCampaign,
  riderId: string,
  riderProfile: Record<string, unknown>,
  completedTripsAfter: number,
  referenceAt: number,
  sessionKeys: ReadonlySet<string>,
): {status: RiderRewardOffer["status"]; matchesStatic: boolean; eligibilityMessage: string} {
  const verdict = staticOfferEligibility(
    campaign,
    riderId,
    riderProfile,
    referenceAt,
    completedTripsAfter,
    sessionKeys,
  );
  if (!verdict.visible) return {status: "unavailable", matchesStatic: false, eligibilityMessage: ""};
  if (verdict.status === "UPCOMING") return {status: "future", matchesStatic: false, eligibilityMessage: verdict.eligibilityMessage};
  if (["EXPIRED", "CANCELLED", "unavailable"].includes(verdict.status)) {
    return {status: "unavailable", matchesStatic: false, eligibilityMessage: verdict.eligibilityMessage};
  }
  if (verdict.status === "locked" || verdict.status === "FAILED") {
    return {status: "locked", matchesStatic: false, eligibilityMessage: verdict.eligibilityMessage};
  }
  return {
    status: (campaign.restaurantIds.length || campaign.zoneNames.length || campaign.rainOnly || campaign.orderTotalMinPaise !== null)
      ? "eligible_delivery_match_required"
      : "available",
    matchesStatic: true,
    eligibilityMessage: verdict.eligibilityMessage,
  };
}

function deliveryMatchesCampaign(
  campaign: RiderRewardCampaign,
  order: SavrivoOrder,
  riderProfile: Record<string, unknown>,
  completedTripsAfter: number,
  referenceAt: number,
  sessionKeys: ReadonlySet<string>,
): boolean {
  const timeZone = safeTimeZone(campaign.timezone);
  const staticEligibility = staticOfferEligibility(
    campaign,
    String(order.riderId ?? ""),
    riderProfile,
    referenceAt,
    completedTripsAfter,
    sessionKeys,
  );
  if (!staticEligibility.visible || ["locked", "FAILED", "EXPIRED", "CANCELLED", "UPCOMING", "unavailable"].includes(staticEligibility.status)) return false;
  if (campaign.timeSlots.length && !campaign.timeSlots.some((slot) => matchesTimeSlot(slot, referenceAt, timeZone))) return false;
  if (campaign.restaurantIds.length && !campaign.restaurantIds.includes(order.restaurantId)) return false;
  if (campaign.zoneNames.length) {
    const area = searchKey(order.address?.area ?? order.address?.label ?? "");
    if (!campaign.zoneNames.some((name) => searchKey(name) === area)) return false;
  }
  if (campaign.orderTotalMinPaise !== null && integer(order.total * 100, 0, 0) < campaign.orderTotalMinPaise) return false;
  if (campaign.rainOnly && !(Number(order.pricing?.rainFee ?? 0) > 0 || text(order.pricingContext?.weatherSeverity, 80))) return false;
  return true;
}

function campaignRewardEventId(campaignId: string, orderId: string, suffix = ""): string {
  return `reward:${campaignId}:${orderId}${suffix ? `:${suffix}` : ""}`;
}

function buildRiderRewardJournal(input: {
  campaign: RiderRewardCampaign;
  riderId: string;
  occurredAt: number;
  eventId: string;
  amountPaise: number;
  orderId?: string;
  actorId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}): LedgerJournal {
  return createLedgerJournal({
    eventType: "rider_incentive",
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    ...(input.orderId ? {orderId: input.orderId} : {}),
    actorId: input.actorId ?? "system:rider-rewards",
    metadata: {
      campaignId: input.campaign.campaignId,
      displayType: input.campaign.displayType,
      stacking: input.campaign.stacking,
      ...input.metadata,
    },
    postings: [
      {
        accountId: `expense:rider-rewards:${input.campaign.displayType}`,
        side: "debit",
        amountPaise: input.amountPaise,
        memo: `${input.campaign.title} accrued`,
      },
      {
        accountId: `liability:rider-earnings:${input.riderId}`,
        side: "credit",
        amountPaise: input.amountPaise,
        memo: input.campaign.title,
      },
    ],
  });
}

function buildReferralRewardJournal(input: {
  riderId: string;
  relatedRiderId: string;
  amountPaise: number;
  occurredAt: number;
  beneficiaryRole: "inviter" | "invitee";
  thresholdTrips: number;
}): LedgerJournal {
  return createLedgerJournal({
    eventType: "rider_referral_reward",
    eventId: `referral:${input.relatedRiderId}:${input.beneficiaryRole}:${input.thresholdTrips}`,
    occurredAt: input.occurredAt,
    actorId: "system:rider-referral",
    metadata: {
      beneficiaryRole: input.beneficiaryRole,
      relatedRiderId: input.relatedRiderId,
      thresholdTrips: input.thresholdTrips,
    },
    postings: [
      {
        accountId: "expense:rider-rewards:referral",
        side: "debit",
        amountPaise: input.amountPaise,
        memo: "Referral reward accrued",
      },
      {
        accountId: `liability:rider-earnings:${input.riderId}`,
        side: "credit",
        amountPaise: input.amountPaise,
        memo: `Referral reward (${input.beneficiaryRole})`,
      },
    ],
  });
}

function amountForMilestone(campaign: RiderRewardCampaign, currentCount: number): number {
  return unlockedMilestoneRewardPaise(campaign, currentCount);
}

async function readRiderProfile(database: RiderRewardsDatabase, riderId: string): Promise<Record<string, unknown>> {
  const snapshot = await database.ref(`${ROOT}/riders/${riderId}`).get();
  return record(snapshot.val());
}

async function readAllRiders(database: RiderRewardsDatabase): Promise<Record<string, Record<string, unknown>>> {
  const snapshot = await database.ref(`${ROOT}/riders`).get();
  const out: Record<string, Record<string, unknown>> = {};
  const source = record(snapshot.val());
  for (const [riderId, value] of Object.entries(source)) {
    out[riderId] = record(value);
  }
  return out;
}

async function readCampaigns(
  database: RiderRewardsDatabase,
  limit: number,
): Promise<readonly RiderRewardCampaign[]> {
  const snapshot = await database.ref(RIDER_REWARD_CAMPAIGNS_ROOT).get();
  const source = record(snapshot.val());
  const campaigns = Object.entries(source)
    .map(([campaignId, value]) => normalizeRewardCampaign(campaignId, value))
    .filter((campaign): campaign is RiderRewardCampaign => campaign !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.campaignId.localeCompare(right.campaignId));
  return campaigns.slice(0, limit);
}

function latestSnapshotPerRider(
  snapshots: readonly RiderRewardProgressSnapshot[],
): readonly RiderRewardProgressSnapshot[] {
  const latest = new Map<string, RiderRewardProgressSnapshot>();
  for (const snapshot of snapshots) {
    const existing = latest.get(snapshot.riderId);
    if (!existing || snapshot.generatedAt > existing.generatedAt || (
      snapshot.generatedAt === existing.generatedAt &&
      snapshot.periodEndAt > existing.periodEndAt
    )) {
      latest.set(snapshot.riderId, snapshot);
    }
  }
  return [...latest.values()].sort((left, right) =>
    right.generatedAt - left.generatedAt ||
    right.currentUnlockedRewardPaise - left.currentUnlockedRewardPaise ||
    left.riderId.localeCompare(right.riderId));
}

function riderDisplayName(riderProfile: Record<string, unknown>, riderId: string): string {
  return text(riderProfile.fullName ?? riderProfile.name ?? riderProfile.displayName, 160, riderId) || riderId;
}

function completedTripsLifetimeForRider(
  riderProfile: Record<string, unknown>,
  riderJournals: readonly LedgerJournal[],
  riderId: string,
): number {
  return Math.max(
    integer(
      riderProfile.completedTrips ??
      riderProfile.completedDeliveryCount ??
      riderProfile.deliveryCount ??
      riderProfile.totalDeliveries,
      0,
      0,
    ),
    completedDeliveriesInWindow(riderJournals, riderId, 0, Number.MAX_SAFE_INTEGER),
  );
}

function buildRiderRewardSettlementJournal(input: {
  campaign: RiderRewardCampaign;
  riderId: string;
  periodKey: string;
  periodStartAt: number;
  periodEndAt: number;
  amountPaise: number;
}): LedgerJournal {
  const scopeHash = createHash("sha1")
    .update(`${input.campaign.campaignId}|${input.riderId}|${input.periodKey}`)
    .digest("hex")
    .slice(0, 32);
  return buildRiderRewardJournal({
    campaign: input.campaign,
    riderId: input.riderId,
    occurredAt: input.periodEndAt,
    eventId: `reward:settlement:${scopeHash}`,
    amountPaise: input.amountPaise,
    actorId: "system:rider-reward-settlement",
    metadata: {
      periodKey: input.periodKey,
      periodStartAt: input.periodStartAt,
      periodEndAt: input.periodEndAt,
      payoutMode: input.campaign.milestonePayoutMode,
      window: input.campaign.window,
      settlementType: "period_close",
    },
  });
}

async function settleSnapshotIfNeeded(
  campaign: RiderRewardCampaign,
  snapshot: RiderRewardProgressSnapshot,
  database: RiderRewardsDatabase,
  settlementAt = Date.now(),
): Promise<{journalId: string; amountPaise: number} | null> {
  if (campaign.kind !== "milestone_bonus") return null;
  if (!snapshot.qualified || snapshot.periodEndAt > settlementAt) return null;
  if (snapshot.currentUnlockedRewardPaise <= 0 || snapshot.creditedRewardPaise > 0) return null;
  const persisted = await persistLedgerJournal(buildRiderRewardSettlementJournal({
    campaign,
    riderId: snapshot.riderId,
    periodKey: snapshot.periodKey,
    periodStartAt: snapshot.periodStartAt,
    periodEndAt: snapshot.periodEndAt,
    amountPaise: snapshot.currentUnlockedRewardPaise,
  }), database);
  return {
    journalId: persisted.journal.journalId,
    amountPaise: snapshot.currentUnlockedRewardPaise,
  };
}

export async function refreshRiderRewardProgress(
  riderIdInput: string,
  referenceAtInput: number,
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<readonly RiderRewardProgressSnapshot[]> {
  const riderId = identifier(riderIdInput);
  if (!riderId) return [];
  const referenceAt = integer(referenceAtInput, Date.now(), 1);
  const campaigns = (await readCampaigns(database, 250))
    .filter((campaign) => !campaign.archived && campaign.visible && riderCampaignNeedsProgressTracking(campaign));
  if (!campaigns.length) return [];
  const [riderProfile, riderSessionKeys, recentJournals] = await Promise.all([
    readRiderProfile(database, riderId),
    readSessionDayKeys(database, riderId),
    readRecentLedgerJournals(2_000, database),
  ]);
  const riderJournals = recentJournals.filter((journal) => relevantRiderJournal(journal, riderId));
  const completedTripsLifetime = completedTripsLifetimeForRider(riderProfile, riderJournals, riderId);
  const activityWindow = rewardActivityWindow(campaigns, referenceAt);
  const activityEvents = await readActivityEvents(database, riderId, activityWindow.startAt, activityWindow.endAt);
  const snapshots = campaigns.map((campaign) => computeCampaignProgressSnapshot({
    campaign,
    riderId,
    riderProfile,
    referenceAt,
    activityEvents,
    riderSessionKeys,
    riderJournals,
    completedTripsLifetime,
  }));
  const settledSnapshots: RiderRewardProgressSnapshot[] = [];
  for (const snapshot of snapshots) {
    const campaign = campaigns.find((candidate) => candidate.campaignId === snapshot.campaignId);
    if (!campaign) {
      settledSnapshots.push(snapshot);
      continue;
    }
    const settlement = await settleSnapshotIfNeeded(campaign, snapshot, database, referenceAt);
    settledSnapshots.push(settlement ? {
      ...snapshot,
      creditedRewardPaise: settlement.amountPaise,
      settlementJournalId: settlement.journalId,
      status: "COMPLETED",
      generatedAt: referenceAt,
    } : snapshot);
  }
  await Promise.all(settledSnapshots.map((snapshot) => persistRewardProgressSnapshot(snapshot, database)));
  await persistCompletedSessionDays(riderId, settledSnapshots, referenceAt, database);
  await Promise.all(settledSnapshots.map(async (snapshot) => {
    const campaign = campaigns.find((candidate) => candidate.campaignId === snapshot.campaignId);
    if (!campaign) return;
    await emitRewardProgressNotifications(campaign, snapshot);
  }));
  return settledSnapshots;
}

export async function settleQualifiedRiderRewardPeriods(
  referenceAtInput: number,
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<{settledCount: number; journalIds: readonly string[]}> {
  const referenceAt = integer(referenceAtInput, Date.now(), 1);
  const campaigns = (await readCampaigns(database, 250)).filter((campaign) => !campaign.archived);
  const journalIds: string[] = [];
  for (const campaign of campaigns) {
    if (campaign.kind !== "milestone_bonus") continue;
    const snapshots = latestSnapshotPerRider(await readCampaignProgressSnapshots(database, campaign.campaignId, 1_000))
      .filter((snapshot) => snapshot.periodEndAt <= referenceAt);
    for (const snapshot of snapshots) {
      const settlement = await settleSnapshotIfNeeded(campaign, snapshot, database, referenceAt);
      if (!settlement) continue;
      journalIds.push(settlement.journalId);
      await persistRewardProgressSnapshot({
        ...snapshot,
        creditedRewardPaise: settlement.amountPaise,
        status: "COMPLETED",
        settlementJournalId: settlement.journalId,
        generatedAt: referenceAt,
      }, database);
    }
  }
  return {settledCount: journalIds.length, journalIds};
}

async function recordAndRefreshRewardActivity(
  riderIdInput: string,
  event: {
    eventId: string;
    type: RiderRewardActivityEventType;
    occurredAt: number;
    orderId?: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
  database: RiderRewardsDatabase,
): Promise<void> {
  const riderId = identifier(riderIdInput);
  if (!riderId) return;
  await recordRiderRewardActivityEvent(riderId, event, database);
  await refreshRiderRewardProgress(riderId, event.occurredAt, database);
}

export async function recordRiderRewardPresenceUpdate(
  riderIdInput: string,
  before: {online?: unknown; updatedAt?: unknown; activeOrderId?: unknown; city?: unknown} | null,
  after: {online?: unknown; updatedAt?: unknown; activeOrderId?: unknown; city?: unknown} | null,
  recordedAtInput: number,
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<void> {
  const riderId = identifier(riderIdInput);
  if (!riderId) return;
  const recordedAt = integer(recordedAtInput, Date.now(), 1);
  const beforeOnline = truthy(before?.online);
  const afterOnline = truthy(after?.online);
  if (!beforeOnline && !afterOnline) return;
  const type: RiderRewardActivityEventType = afterOnline
    ? (beforeOnline ? "HEARTBEAT" : "ONLINE")
    : (after ? "OFFLINE" : "APP_DISCONNECTED");
  await recordAndRefreshRewardActivity(riderId, {
    eventId: `presence:${recordedAt}:${type.toLowerCase()}`,
    type,
    occurredAt: recordedAt,
    orderId: text(after?.activeOrderId ?? before?.activeOrderId, 120),
    metadata: {
      city: text(after?.city ?? before?.city, 120),
      clientUpdatedAt: integer(after?.updatedAt ?? before?.updatedAt, 0, 0),
    },
  }, database);
}

export async function recordRiderRewardOrderAccepted(
  riderIdInput: string,
  orderIdInput: string,
  occurredAtInput: number,
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<void> {
  const riderId = identifier(riderIdInput);
  const orderId = identifier(orderIdInput);
  if (!riderId || !orderId) return;
  await recordAndRefreshRewardActivity(riderId, {
    eventId: `order:${orderId}:accepted`,
    type: "ORDER_ACCEPTED",
    occurredAt: integer(occurredAtInput, Date.now(), 1),
    orderId,
  }, database);
}

export async function recordRiderRewardOrderRejected(
  riderIdInput: string,
  orderIdInput: string,
  occurredAtInput: number,
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<void> {
  const riderId = identifier(riderIdInput);
  const orderId = identifier(orderIdInput);
  if (!riderId || !orderId) return;
  await recordAndRefreshRewardActivity(riderId, {
    eventId: `order:${orderId}:rejected:${integer(occurredAtInput, Date.now(), 1)}`,
    type: "ORDER_REJECTED",
    occurredAt: integer(occurredAtInput, Date.now(), 1),
    orderId,
  }, database);
}

export async function recordRiderRewardOrderPickedUp(
  riderIdInput: string,
  orderIdInput: string,
  occurredAtInput: number,
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<void> {
  const riderId = identifier(riderIdInput);
  const orderId = identifier(orderIdInput);
  if (!riderId || !orderId) return;
  await recordAndRefreshRewardActivity(riderId, {
    eventId: `order:${orderId}:picked-up`,
    type: "ORDER_PICKED_UP",
    occurredAt: integer(occurredAtInput, Date.now(), 1),
    orderId,
  }, database);
}

export async function recordRiderRewardOrderCancelledAfterAccept(
  riderIdInput: string,
  orderIdInput: string,
  occurredAtInput: number,
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<void> {
  const riderId = identifier(riderIdInput);
  const orderId = identifier(orderIdInput);
  if (!riderId || !orderId) return;
  await recordAndRefreshRewardActivity(riderId, {
    eventId: `order:${orderId}:cancelled-after-accept`,
    type: "ORDER_CANCELLED_AFTER_ACCEPT",
    occurredAt: integer(occurredAtInput, Date.now(), 1),
    orderId,
  }, database);
}

function eligibleRiderCount(
  campaign: RiderRewardCampaign,
  riders: Record<string, Record<string, unknown>>,
): number {
  return Object.entries(riders).filter(([riderId, rider]) => {
    if (String(rider.status ?? "") !== "approved") return false;
    if (campaign.riderIds.length && !campaign.riderIds.includes(riderId)) return false;
    if (campaign.cityNames.length && !campaign.cityNames.some((name) => searchKey(name) === searchKey(rider.city))) return false;
    if (campaign.eligibleRiderTypes.length) {
      const riderType = searchKey(rider.riderType ?? rider.category ?? rider.partnerType ?? "");
      if (!campaign.eligibleRiderTypes.some((name) => searchKey(name) === riderType)) return false;
    }
    if (campaign.vehicleTypes.length) {
      const vehicleType = searchKey(rider.vehicleType ?? "");
      if (!campaign.vehicleTypes.some((name) => searchKey(name) === vehicleType)) return false;
    }
    if (campaign.minimumAccountAgeDays !== null) {
      const accountStartAt = integer(rider.approvedAt ?? rider.createdAt ?? rider.submittedAt ?? rider.updatedAt, 0, 0);
      if (!accountStartAt || Date.now() - accountStartAt < campaign.minimumAccountAgeDays * 24 * 60 * 60 * 1_000) return false;
    }
    if (campaign.minRating !== null) {
      const rating = Number(rider.rating ?? 0);
      if (!Number.isFinite(rating) || rating < campaign.minRating) return false;
    }
    return true;
  }).length;
}

function campaignAccrualSummary(
  campaign: RiderRewardCampaign,
  journals: readonly LedgerJournal[],
): {rewardJournalCount: number; totalAccruedPaise: number} {
  let rewardJournalCount = 0;
  let totalAccruedPaise = 0;
  for (const journal of journals) {
    if (!["rider_incentive", "rider_referral_reward"].includes(journal.eventType)) continue;
    if (String(journal.metadata.campaignId ?? "") !== campaign.campaignId) continue;
    rewardJournalCount += 1;
    for (const entry of journal.entries) {
      if (entry.accountId.startsWith("liability:rider-earnings:")) {
        totalAccruedPaise += entry.side === "credit" ? entry.amountPaise : -entry.amountPaise;
      }
    }
  }
  return {rewardJournalCount, totalAccruedPaise};
}

export async function readRiderRewardsAdminDashboard(
  token: DecodedIdToken,
  input: AdminRiderRewardsDashboardQueryInput,
  database: RiderRewardsDatabase = defaultDatabase(),
  now: () => number = Date.now,
): Promise<RiderRewardsAdminDashboard> {
  requirePlatformConfigAdminClaim(token);
  const [settingsSnapshot, campaigns, riders, journals] = await Promise.all([
    database.ref(RIDER_REWARD_SETTINGS_ROOT).get(),
    readCampaigns(database, input.campaignLimit),
    readAllRiders(database),
    readRecentLedgerJournals(input.ledgerLimit, database),
  ]);
  return {
    generatedAt: now(),
    settings: normalizeRewardSettings(settingsSnapshot.val()),
    campaigns: await Promise.all(campaigns.map(async (campaign) => {
      const accrual = campaignAccrualSummary(campaign, journals);
      const snapshots = latestSnapshotPerRider(await readCampaignProgressSnapshots(
        database,
        campaign.campaignId,
        input.progressLimit,
      ));
      const riderProgressPreview = snapshots
        .slice(0, input.riderPreviewLimit)
        .map((snapshot) => {
          const riderProfile = riders[snapshot.riderId] ?? {};
          return {
            riderId: snapshot.riderId,
            riderName: riderDisplayName(riderProfile, snapshot.riderId),
            status: snapshot.status,
            tripsCompleted: snapshot.tripsCompleted,
            currentUnlockedRewardPaise: snapshot.currentUnlockedRewardPaise,
            potentialRewardPaise: snapshot.potentialRewardPaise,
            creditedRewardPaise: snapshot.creditedRewardPaise,
            rejectedOrders: snapshot.rejectedOrders,
            groupsCompleted: snapshot.groups.filter((group) => group.qualified).length,
            groupsRequired: snapshot.groups.length,
            nextMilestone: nextMilestoneFor(campaign, snapshot.tripsCompleted),
            conditionsSummary: snapshot.conditionsSummary,
          };
        });
      const currentlyEligibleCount = snapshots.filter((snapshot) =>
        ["ACTIVE", "IN_PROGRESS", "QUALIFIED", "COMPLETED", "PAID"].includes(snapshot.status) &&
        !snapshot.failed
      ).length;
      const qualifiedCount = snapshots.filter((snapshot) => snapshot.qualified).length;
      const completedCount = snapshots.filter((snapshot) =>
        snapshot.creditedRewardPaise > 0 || ["COMPLETED", "PAID"].includes(snapshot.status)
      ).length;
      const failedCount = snapshots.filter((snapshot) =>
        snapshot.failed || snapshot.status === "FAILED"
      ).length;
      return {
        campaign,
        eligibleRiderCount: eligibleRiderCount(campaign, riders),
        rewardJournalCount: accrual.rewardJournalCount,
        totalAccruedPaise: accrual.totalAccruedPaise,
        totalRidersEnrolled: snapshots.length,
        currentlyEligibleCount,
        qualifiedCount,
        completedCount,
        failedCount,
        rewardLiabilityPaise: snapshots.reduce((total, snapshot) =>
          total + Math.max(snapshot.creditedRewardPaise, snapshot.qualified ? snapshot.currentUnlockedRewardPaise : 0), 0),
        rewardsPaidPaise: snapshots.reduce((total, snapshot) => total + snapshot.creditedRewardPaise, 0),
        riderProgressPreview,
      };
    })),
  };
}

export async function upsertRiderRewardCampaign(
  uid: string,
  token: DecodedIdToken,
  input: UpsertRiderRewardCampaignInput,
  database: RiderRewardsDatabase = defaultDatabase(),
  now: () => number = Date.now,
): Promise<{campaign: RiderRewardCampaign; idempotent: boolean}> {
  const actorRole = requirePlatformConfigAdminClaim(token);
  const path = `${RIDER_REWARD_CAMPAIGNS_ROOT}/${input.campaignId}`;
  const requestHash = rewardSettingsHash(input);
  let abort: DomainError | null = null;
  const result = await database.ref(path).transaction((current) => {
    abort = null;
    const existing = record(current);
    const existingUpdatedAt = integer(existing.updatedAt, 0, 0);
    const existingOperationId = text(existing.lastOperationId, 128);
    const existingRequestHash = text(existing.lastRequestHash, 128);
    if (existingOperationId && existingOperationId === input.operationId) {
      if (existingRequestHash !== requestHash) {
        abort = new DomainError("already-exists", "Operation id was already used for a different reward campaign change.");
        return undefined;
      }
      return existing;
    }
    if (input.expectedUpdatedAt !== undefined && existingUpdatedAt !== input.expectedUpdatedAt) {
      abort = new DomainError("aborted", "Reward campaign changed; refresh and retry.");
      return undefined;
    }
    return {
      ...input.campaign,
      schemaVersion: 1,
      updatedAt: now(),
      updatedBy: uid,
      updatedByRole: actorRole,
      lastOperationId: input.operationId,
      lastRequestHash: requestHash,
    };
  }, undefined, false);
  if (!result.committed) throw abort ?? new DomainError("aborted", "Reward campaign could not be updated safely.");
  const campaign = normalizeRewardCampaign(input.campaignId, result.snapshot.val());
  if (!campaign) throw new DomainError("data-loss", "The reward campaign could not be verified after save.");
  await database.ref(`${ROOT}/audit/rider-reward-${campaign.campaignId}-${input.operationId.slice(0, 24)}`).set({
    id: `rider-reward-${campaign.campaignId}-${input.operationId.slice(0, 24)}`,
    action: "rider_reward_campaign.upsert",
    target: campaign.campaignId,
    detail: campaign.title.slice(0, 180),
    actorId: uid,
    actorEmail: String(token.email ?? "").slice(0, 254),
    actorRole,
    at: campaign.updatedAt,
  });
  return {campaign, idempotent: campaign.lastOperationId === input.operationId && text(record(result.snapshot.val()).lastRequestHash, 128) === requestHash};
}

export async function updateRiderRewardSettings(
  uid: string,
  token: DecodedIdToken,
  input: UpdateRiderRewardSettingsInput,
  database: RiderRewardsDatabase = defaultDatabase(),
  now: () => number = Date.now,
): Promise<RiderRewardSettings> {
  const actorRole = requirePlatformConfigAdminClaim(token);
  const requestHash = rewardSettingsHash(input);
  let abort: DomainError | null = null;
  const result = await database.ref(RIDER_REWARD_SETTINGS_ROOT).transaction((current) => {
    abort = null;
    const existing = normalizeRewardSettings(current);
    const raw = record(current);
    const existingRequestHash = text(raw.lastRequestHash, 128);
    if (existing.lastOperationId && existing.lastOperationId === input.operationId) {
      if (existingRequestHash !== requestHash) {
        abort = new DomainError("already-exists", "Operation id was already used for a different reward settings change.");
        return undefined;
      }
      return raw;
    }
    if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) {
      abort = new DomainError("aborted", "Reward settings changed; refresh and retry.");
      return undefined;
    }
    return {
      schemaVersion: 1,
      payoutMinimumPaise: input.payoutMinimumPaise ?? existing.payoutMinimumPaise,
      referralProgramActive: input.referralProgramActive ?? existing.referralProgramActive,
      inviterRewardPaise: input.inviterRewardPaise ?? existing.inviterRewardPaise,
      inviteeRewardPaise: input.inviteeRewardPaise ?? existing.inviteeRewardPaise,
      referralMinCompletedTrips: input.referralMinCompletedTrips ?? existing.referralMinCompletedTrips,
      referralMaxRewardsPerRider: input.referralMaxRewardsPerRider ?? existing.referralMaxRewardsPerRider,
      updatedAt: now(),
      updatedBy: uid,
      updatedByRole: actorRole,
      lastOperationId: input.operationId,
      lastRequestHash: requestHash,
    };
  }, undefined, false);
  if (!result.committed) throw abort ?? new DomainError("aborted", "Reward settings could not be updated safely.");
  return normalizeRewardSettings(result.snapshot.val());
}

function rewardJournalEarnedInPeriod(
  summary: RiderFinancialSummary,
  campaignId: string,
  period: {startAt: number; endAt: number},
): number {
  return summary.history.reduce((total, row) => {
    if (row.occurredAt < period.startAt || row.occurredAt >= period.endAt) return total;
    if (!["rider_incentive", "rider_referral_reward"].includes(row.eventType)) return total;
    if (String((row as unknown as {campaignId?: string}).campaignId ?? "") !== campaignId) return total;
    return total + row.earningsMovementPaise;
  }, 0);
}

function journalMetadataMap(journals: readonly LedgerJournal[]): Map<string, LedgerJournal> {
  return new Map(journals.map((journal) => [journal.journalId, journal]));
}

function rewardDayReferenceAt(dayKey: string): number {
  const parsed = Date.parse(`${dayKey}T12:00:00+05:30`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function campaignVisibleOnDay(campaign: RiderRewardCampaign, dayKey: string): boolean {
  const referenceAt = rewardDayReferenceAt(dayKey);
  if (referenceAt < campaign.startAt || referenceAt >= campaign.endAt) return false;
  return matchesDay(campaign, referenceAt);
}

function decorateWeekBarsWithOfferMeta(
  bars: readonly RiderRewardDailyBar[],
  campaigns: readonly RiderRewardCampaign[],
  snapshots: readonly RiderRewardProgressSnapshot[],
): readonly RiderRewardDailyBar[] {
  const completedDays = new Set<string>(bars
    .filter((bar) => bar.incentivePaise > 0)
    .map((bar) => bar.dayKey));
  return bars.map((bar) => {
    const dayCampaigns = campaigns.filter((campaign) => campaignVisibleOnDay(campaign, bar.dayKey));
    const campaignCompleted = snapshots.some((snapshot) =>
      snapshot.creditedRewardPaise > 0 &&
      rewardDayReferenceAt(bar.dayKey) >= snapshot.periodStartAt &&
      rewardDayReferenceAt(bar.dayKey) < snapshot.periodEndAt,
    );
    return {
      ...bar,
      hasOffer: dayCampaigns.length > 0,
      hasSpecialOffer: dayCampaigns.some((campaign) =>
        campaign.section === "special" || campaign.displayType === "special_campaign"),
      hasCompletedIncentive: completedDays.has(bar.dayKey) || campaignCompleted,
    };
  });
}

export async function readRiderRewardsDashboard(
  requesterUid: string,
  token: DecodedIdToken,
  input: RiderRewardsDashboardQueryInput,
  database: RiderRewardsDatabase = defaultDatabase(),
  now: () => number = Date.now,
): Promise<RiderRewardsDashboard> {
  const riderId = identifier(input.riderId ?? requesterUid, requesterUid);
  if (riderId === requesterUid) await requireApprovedRider(requesterUid);
  else requirePlatformConfigAdminClaim(token);
  const referenceAt = integer(input.referenceAt ?? now(), now(), 1);
  const [financial, settingsSnapshot, campaigns, riderProfile, riders, riderSessionKeys, recentJournals, financePolicy, referralIdentity] = await Promise.all([
    readRiderFinancialSummary(requesterUid, token, {
      riderId,
      ledgerLimit: Math.min(input.ledgerLimit, 250),
      historyLimit: Math.min(input.historyLimit, 100),
    }, database as Parameters<typeof readRiderFinancialSummary>[3], {
      requireRider: requireApprovedRider,
      requireAdmin: requirePlatformConfigAdminClaim,
    }, now),
    database.ref(RIDER_REWARD_SETTINGS_ROOT).get(),
    readCampaigns(database, input.campaignLimit),
    readRiderProfile(database, riderId),
    readAllRiders(database),
    readSessionDayKeys(database, riderId),
    readRecentLedgerJournals(Math.min(Math.max(input.ledgerLimit, 500), 2_000), database),
    loadFinancePolicy(referenceAt),
    ensureRiderReferralIdentity(riderId, database, now),
  ]);
  const settings = normalizeRewardSettings(settingsSnapshot.val());
  const rewardJournals = journalMetadataMap(recentJournals.filter((journal) => relevantRiderJournal(journal, riderId)));
  const riderJournals = Array.from(rewardJournals.values());
  const completedTripsAfter = completedTripsLifetimeForRider(riderProfile, riderJournals, riderId);
  const progressSnapshots = await refreshRiderRewardProgress(riderId, referenceAt, database);
  const progressByCampaign = new Map(progressSnapshots.map((snapshot) => [snapshot.campaignId, snapshot]));
  const offers = campaigns
    .filter((campaign) => !campaign.archived && campaign.visible)
    .map((campaign): RiderRewardOffer => {
      const staticEligibility = staticOfferEligibility(
        campaign,
        riderId,
        riderProfile,
        referenceAt,
        completedTripsAfter,
        riderSessionKeys,
      );
      const period = periodBoundsAtTimeZone(campaign.window, referenceAt, campaign);
      const effectivePeriod = {
        startAt: Math.max(period.startAt, campaign.startAt),
        endAt: Math.min(period.endAt, campaign.endAt),
      };
      const snapshot = progressByCampaign.get(campaign.campaignId) ?? null;
      const currentCount = snapshot?.tripsCompleted ?? (campaign.kind === "milestone_bonus"
        ? completedDeliveriesInWindow(riderJournals, riderId, effectivePeriod.startAt, effectivePeriod.endAt)
        : 0);
      const lastMilestone = campaign.kind === "milestone_bonus" && campaign.milestones.length
        ? campaign.milestones[campaign.milestones.length - 1]
        : null;
      const progressTarget = lastMilestone ? lastMilestone.target : 0;
      const milestones = campaign.milestones.map((milestone) => ({
        target: milestone.target,
        rewardAmountPaise: milestone.rewardAmountPaise,
        reached: currentCount >= milestone.target,
        label: milestone.label,
      }));
      const earnedPaiseForPeriod = snapshot?.creditedRewardPaise ?? riderJournals.reduce((total, journal) => {
        if (journal.occurredAt < effectivePeriod.startAt || journal.occurredAt >= effectivePeriod.endAt) return total;
        if (String(journal.metadata.campaignId ?? "") !== campaign.campaignId) return total;
        const movement = riderLedgerMovement(journal, riderId);
        return total + movement.earningsMovementPaise;
      }, 0);
      const currentUnlockedRewardPaise = snapshot?.currentUnlockedRewardPaise ?? (
        campaign.kind === "milestone_bonus" ? unlockedMilestoneRewardPaise(campaign, currentCount) : 0
      );
      const potentialRewardPaise = snapshot?.potentialRewardPaise ?? (
        campaign.kind === "milestone_bonus" ? milestonePotentialRewardPaise(campaign) : campaign.rewardAmountPaise ?? 0
      );
      const nextMilestone = campaign.kind === "milestone_bonus" ? nextMilestoneFor(campaign, currentCount) : null;
      const rewardRequiresDeliveryMatch = campaign.restaurantIds.length > 0 ||
        campaign.zoneNames.length > 0 ||
        campaign.rainOnly ||
        campaign.orderTotalMinPaise !== null;
      const status = snapshot?.status ?? (
        rewardRequiresDeliveryMatch && staticEligibility.status === "ACTIVE"
          ? "eligible_delivery_match_required"
          : staticEligibility.status
      );
      const failedGroup = snapshot?.groups.find((group) => group.status === "FAILED") ?? null;
      const failedOtherCondition = snapshot?.otherConditions.find((condition) => condition.status === "FAILED") ?? null;
      const eligibilityMessage = staticEligibility.eligibilityMessage ||
        (snapshot?.failed
          ? failedGroup?.message || failedOtherCondition?.message || snapshot.loginSessionRequirementMessage || "Offer conditions were not completed."
          : "");
      const periodLabel = campaign.window === "weekly"
        ? formatRewardWeekLabel(effectivePeriod.startAt)
        : campaign.window === "daily"
          ? formatRewardDayKey(referenceDayKeyAtTimeZone(effectivePeriod.startAt + 12 * 60 * 60 * 1_000, period.timezone))
          : `${formatRewardDayKey(referenceDayKeyAtTimeZone(effectivePeriod.startAt + 12 * 60 * 60 * 1_000, period.timezone))} – ${formatRewardDayKey(referenceDayKeyAtTimeZone(Math.max(effectivePeriod.startAt, effectivePeriod.endAt - 1), period.timezone))}`;
      return {
        campaignId: campaign.campaignId,
        title: campaign.title,
        subtitle: campaign.subtitle,
        description: campaign.description,
        displayType: campaign.displayType,
        section: campaign.section,
        window: campaign.window,
        status,
        rewardAmountPaise: campaign.rewardAmountPaise ?? amountForMilestone(campaign, currentCount),
        stacking: campaign.stacking,
        priority: campaign.priority,
        conditions: snapshot?.conditionsSummary.length ? snapshot.conditionsSummary : rewardConditions(campaign, settings),
        eligibilityMessage,
        progressCurrent: currentCount,
        progressTarget,
        milestones,
        activeNow: matchesStaticCampaignWindow(campaign, referenceAt),
        earnedPaiseForPeriod,
        timezone: period.timezone,
        potentialRewardPaise,
        currentUnlockedRewardPaise,
        creditedRewardPaise: snapshot?.creditedRewardPaise ?? earnedPaiseForPeriod,
        nextMilestone,
        conditionGroups: snapshot?.groups ?? [],
        selectedDayGroups: snapshot?.selectedDayGroups ?? [],
        otherConditionProgress: snapshot?.otherConditions ?? [],
        liabilityRewardPaise: snapshot?.qualified ? currentUnlockedRewardPaise : 0,
        periodLabel,
      };
    })
    .sort((left, right) => {
      const sectionOrder: Record<RewardSection, number> = {
        breakfast: 0, lunch: 1, snacks: 2, dinner: 3, late_night: 4, special: 5,
      };
      return sectionOrder[left.section] - sectionOrder[right.section] ||
        right.priority - left.priority ||
        left.title.localeCompare(right.title);
    });
  const {bars, selected} = dayBreakdownFromHistory(financial, riderId, referenceAt);
  const payouts = payoutEntriesFromHistory(financial);
  const payoutAutomation = financePayoutAutomationSummary(financePolicy, referenceAt);
  const payout: RiderPayoutSummary = {
    status: !financial.complete ? "reconciliation_required" :
      (financial.payableEarningsPaise ?? 0) > 0 ? "pending" : "paid",
    payableNowPaise: financial.complete ? financial.payableEarningsPaise : null,
    amountPaidInWindowPaise: payouts.reduce((total, entry) => total + entry.amountPaise, 0),
    minimumPayoutPaise: settings.payoutMinimumPaise,
    entries: payouts,
    automation: {
      enabled: payoutAutomation.enabled,
      ridersEnabled: payoutAutomation.ridersEnabled,
      scheduleLabel: payoutAutomation.scheduleLabel,
      currentPeriodKey: payoutAutomation.currentPeriodKey,
      nextRunDayKey: payoutAutomation.nextRunDayKey,
    },
  };
  const referredRiderCount = Object.values(riders).filter((candidate) =>
    referralInputMatchesRider(candidate.referredByCode, referralIdentity)
  ).length;
  return {
    generatedAt: now(),
    riderId,
    referenceAt,
    financial,
    selectedDayKey: selected.dayKey,
    weekBars: decorateWeekBarsWithOfferMeta(bars, campaigns.filter((campaign) => !campaign.archived && campaign.visible), progressSnapshots),
    selectedDay: selected,
    payout,
    offers,
    referral: {
      active: settings.referralProgramActive,
      referralCode: referralIdentity.referralCode,
      inviterRewardPaise: settings.inviterRewardPaise,
      inviteeRewardPaise: settings.inviteeRewardPaise,
      minCompletedTrips: settings.referralMinCompletedTrips,
      maxRewardsPerRider: settings.referralMaxRewardsPerRider,
      referredRiderCount,
      earnedRewardPaise: positiveReferralRewardInWindow(Array.from(rewardJournals.values()), riderId),
    },
    loginSessionTracker: buildLoginSessionTracker(campaigns, progressSnapshots, referenceAt),
  };
}

export async function evaluateRiderRewardsForDeliveredOrder(
  order: SavrivoOrder,
  database: RiderRewardsDatabase = defaultDatabase(),
  now: () => number = Date.now,
): Promise<{awardedJournalIds: readonly string[]}> {
  const riderId = identifier(order.riderId);
  if (!riderId || order.status !== "Delivered") return {awardedJournalIds: []};
  const deliveredAt = integer(order.deliveredAt ?? order.updatedAt ?? now(), now(), 1);
  await recordAndRefreshRewardActivity(riderId, {
    eventId: `order:${order.id}:delivered`,
    type: "ORDER_DELIVERED",
    occurredAt: deliveredAt,
    orderId: order.id,
  }, database);
  const [campaigns, settingsSnapshot, riderProfile, journals, riderSessionKeys] = await Promise.all([
    readCampaigns(database, 250),
    database.ref(RIDER_REWARD_SETTINGS_ROOT).get(),
    readRiderProfile(database, riderId),
    readRecentLedgerJournals(1_000, database),
    readSessionDayKeys(database, riderId),
  ]);
  const settings = normalizeRewardSettings(settingsSnapshot.val());
  const riderJournals = journals.filter((journal) => relevantRiderJournal(journal, riderId));
  const completedTripsAfter = completedDeliveriesInWindow(riderJournals, riderId, 0, Number.MAX_SAFE_INTEGER);
  const rewardCandidates: Array<{journal: LedgerJournal; amountPaise: number; stacking: RewardStacking; priority: number}> = [];

  for (const campaign of campaigns) {
    if (!campaign.active || campaign.archived) continue;
    if (!deliveryMatchesCampaign(campaign, order, riderProfile, completedTripsAfter, deliveredAt, riderSessionKeys)) continue;
    if (campaign.kind === "per_order_bonus" && campaign.rewardAmountPaise) {
      rewardCandidates.push({
        journal: buildRiderRewardJournal({
          campaign,
          riderId,
          occurredAt: deliveredAt,
          orderId: order.id,
          eventId: campaignRewardEventId(campaign.campaignId, order.id),
          amountPaise: campaign.rewardAmountPaise,
          metadata: {periodKey: periodBounds(campaign.window, deliveredAt, campaign).key},
        }),
        amountPaise: campaign.rewardAmountPaise,
        stacking: campaign.stacking,
        priority: campaign.priority,
      });
      continue;
    }
  }

  const chosen: typeof rewardCandidates = [];
  const stack = rewardCandidates.filter((candidate) => candidate.stacking === "stack");
  chosen.push(...stack);
  const highestOnly = rewardCandidates
    .filter((candidate) => candidate.stacking === "highest_only")
    .sort((left, right) => right.amountPaise - left.amountPaise || right.priority - left.priority);
  if (highestOnly[0]) chosen.push(highestOnly[0]);

  const awardedJournalIds: string[] = [];
  for (const candidate of chosen) {
    const persisted = await persistLedgerJournal(candidate.journal, database);
    awardedJournalIds.push(persisted.journal.journalId);
  }

  if (settings.referralProgramActive && settings.referralMinCompletedTrips > 0) {
    const referredByCode = text(riderProfile.referredByCode, 200);
    const inviterId = await inviterIdFromReferralInput(referredByCode, database);
    if (inviterId && inviterId !== riderId && completedTripsAfter >= settings.referralMinCompletedTrips) {
      const referralJournals: LedgerJournal[] = [];
      if (settings.inviterRewardPaise > 0) {
        referralJournals.push(buildReferralRewardJournal({
          riderId: inviterId,
          relatedRiderId: riderId,
          amountPaise: settings.inviterRewardPaise,
          occurredAt: deliveredAt,
          beneficiaryRole: "inviter",
          thresholdTrips: settings.referralMinCompletedTrips,
        }));
      }
      if (settings.inviteeRewardPaise > 0) {
        referralJournals.push(buildReferralRewardJournal({
          riderId,
          relatedRiderId: inviterId,
          amountPaise: settings.inviteeRewardPaise,
          occurredAt: deliveredAt,
          beneficiaryRole: "invitee",
          thresholdTrips: settings.referralMinCompletedTrips,
        }));
      }
      for (const journal of referralJournals) {
        const persisted = await persistLedgerJournal(journal, database);
        awardedJournalIds.push(persisted.journal.journalId);
      }
    }
  }

  if (awardedJournalIds.length) {
    logger.info("RIDER_REWARDS_ACCRUED", {
      orderId: order.id,
      riderId,
      awardedJournalIds,
    });
  }
  return {awardedJournalIds};
}

export async function recordRiderRewardSessionDay(
  riderIdInput: string,
  recordedAt: number,
  database: RiderRewardsDatabase = defaultDatabase(),
): Promise<void> {
  const riderId = identifier(riderIdInput);
  if (!riderId) return;
  const occurredAt = integer(recordedAt, Date.now(), 1);
  const dayKey = referenceDayKey(occurredAt);
  const path = `${RIDER_REWARD_SESSION_DAYS_ROOT}/${riderId}/${dayKey}`;
  await database.ref(path).transaction((current) => {
    const existing = sessionDay(current, riderId, dayKey);
    return {
      schemaVersion: 1,
      riderId,
      dayKey,
      firstSeenAt: existing?.firstSeenAt ? Math.min(existing.firstSeenAt, occurredAt) : occurredAt,
      lastSeenAt: existing?.lastSeenAt ? Math.max(existing.lastSeenAt, occurredAt) : occurredAt,
      completedSessions: existing?.completedSessions ?? 0,
      updatedAt: Math.max(existing?.updatedAt ?? 0, occurredAt),
    };
  }, undefined, false);
}

export const __test = {
  buildOnlineIntervals,
  activitySummaryForPeriod,
  computeCampaignProgressSnapshot,
  dayBreakdownFromHistory,
  periodBoundsAtTimeZone,
  buildRiderRewardSettlementJournal,
  settleSnapshotIfNeeded,
  missingDailyLoginSessionLegacy,
  rewardProgressNotificationInputs,
  normalizeReferralInput,
  legacyReferralCodeForRider,
  ensureRiderReferralIdentity,
  inviterIdFromReferralInput,
};

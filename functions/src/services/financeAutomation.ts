import {createHash} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {firestoreDb} from "../admin";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import {sweepRiderContractorTds} from "./riderTds";
import {
  createLedgerJournal,
  validateLedgerJournal,
  type LedgerJournal,
} from "../domain/ledger";
import {
  financePayoutAutomationCurrentPeriodKey,
  financePayoutAutomationNextRunDayKey,
  financePayoutAutomationScheduleLabel,
  selectFinancePayoutMethodForAutomation,
  type FinancePolicy,
  type FinancePayoutAutomationBlockedReason,
  type FinancePayoutMethod,
} from "../domain/financePolicy";
import {DomainError} from "../errors";
import {LEDGER_JOURNALS_COLLECTION, persistLedgerJournal} from "./ledger";
import {loadFinancePolicy} from "./platformConfig";
import {withPrivatePayoutProfiles} from "./restaurantPayoutProfiles";
import {riderLedgerCoverageRef} from "./riderFinance";
import {riderRewardSettingsRef, normalizeRewardSettings} from "./riderRewards";
import {buildRestaurantSettlementJournal, restaurantLedgerCoverageRef} from "./restaurantSettlements";

// Nested collection/document paths mirror the RTDB tree this replaces
// (private/financeAutomation/weeklyRuns/{periodKey}, etc.) - Firestore allows
// this exact alternating collection/doc/collection/doc shape, so the only
// change is how each segment is addressed, not the shape itself.
function financeAutomationDoc(database: FirestoreLike): DocumentReferenceLike {
  return database.collection("private").doc("financeAutomation");
}
function weeklyRunRef(database: FirestoreLike, periodKey: string): DocumentReferenceLike {
  return financeAutomationDoc(database).collection("weeklyRuns").doc(periodKey);
}
function weeklyRunItemRef(database: FirestoreLike, periodKey: string, itemIdValue: string): DocumentReferenceLike {
  return weeklyRunRef(database, periodKey).collection("items").doc(itemIdValue);
}
function runLockRef(database: FirestoreLike, periodKey: string): DocumentReferenceLike {
  return financeAutomationDoc(database).collection("locks").doc(periodKey);
}
// Shared with payouts.ts's manual/admin-triggered payout endpoint - both
// acquire the same lock so a manual payout and this weekly automation can
// never race on the same rider/restaurant.
export function riderPayoutLockRef(database: FirestoreLike, riderId: string): DocumentReferenceLike {
  return database.collection("private").doc("financeOperations").collection("riderPayoutLocks").doc(riderId);
}
export function restaurantSettlementLockRef(database: FirestoreLike, restaurantId: string): DocumentReferenceLike {
  return database.collection("private").doc("financeOperations").collection("restaurantSettlementLocks").doc(restaurantId);
}
function auditRef(database: FirestoreLike, id: string): DocumentReferenceLike {
  return database.collection("audit").doc(id);
}

const RUN_LOCK_LEASE_MS = 5 * 60_000;
const ENTITY_LOCK_LEASE_MS = 2 * 60_000;
const SYSTEM_ACTOR_ID = "system:weekly-finance-automation";
const SYSTEM_TOKEN = {
  uid: SYSTEM_ACTOR_ID,
  email: "system@scraveit.local",
  savrivoRole: "owner",
} as unknown as DecodedIdToken;

export type FinanceAutomationDatabase = FirestoreLike;

export type FinanceAutomationEntityType = "rider" | "restaurant";

export type FinanceAutomationItemStatus =
  | "completed"
  | "held_minimum"
  | "blocked_missing_entity"
  | "blocked_missing_coverage"
  | "blocked_invalid_balance"
  | "blocked_profile"
  | "blocked_provider"
  /** Preview run only: this payout would have been sent; nothing moved. */
  | "previewed";

export interface FinanceAutomationItemRecord {
  schemaVersion: 1;
  itemId: string;
  periodKey: string;
  entityType: FinanceAutomationEntityType;
  entityId: string;
  amountPaise: number;
  method: FinancePayoutMethod | null;
  status: FinanceAutomationItemStatus;
  reason: string;
  beneficiaryLabel: string;
  referenceId: string;
  provider: string;
  providerOperationId: string;
  ledgerJournalId: string;
  attemptedAt: number;
  completedAt: number;
  minimumThresholdPaise: number;
}

export interface FinanceAutomationRunSummary {
  schemaVersion: 1;
  periodKey: string | null;
  status:
    | "disabled"
    | "not_due"
    | "busy"
    | "completed"
    | "completed_with_blocks"
    | "preview";
  attemptedAt: number;
  scheduleLabel: string;
  nextRunDayKey: string | null;
  riderMinimumPayoutPaise: number;
  restaurantMinimumSettlementPaise: number;
  counts: {
    completed: number;
    heldMinimum: number;
    blockedMissingEntity: number;
    blockedMissingCoverage: number;
    blockedInvalidBalance: number;
    blockedProfile: number;
    blockedProvider: number;
    previewed?: number;
  };
  /** Total that would be (preview) or was sent in this run. */
  totalPaise?: number;
  preview?: boolean;
  journalIds: readonly string[];
  message: string;
}

interface PayoutGatewayRequest {
  readonly entityType: FinanceAutomationEntityType;
  readonly entityId: string;
  readonly amountPaise: number;
  readonly method: FinancePayoutMethod;
  readonly operationId: string;
  readonly beneficiaryLabel: string;
  readonly upiId: string;
  readonly bankAccountHolderName: string;
  readonly bankAccountNumber: string;
  readonly bankIfsc: string;
}

interface PayoutGatewayResult {
  readonly provider: string;
  readonly providerOperationId: string;
  readonly referenceId: string;
  readonly completedAt?: number;
  /** Preview only: nothing was sent and nothing may be recorded as paid. */
  readonly simulated?: boolean;
}

export interface FinancePayoutGateway {
  readonly configured: boolean;
  executePayout(request: PayoutGatewayRequest): Promise<PayoutGatewayResult>;
}

export class UnconfiguredFinancePayoutGateway implements FinancePayoutGateway {
  readonly configured = false;

  async executePayout(_request: PayoutGatewayRequest): Promise<PayoutGatewayResult> {
    throw new DomainError(
      "failed-precondition",
      "Automatic weekly payouts need a live bank-transfer gateway before money can be sent.",
      {reason: "PAYOUT_GATEWAY_UNCONFIGURED"},
    );
  }
}

/** Preview: says what would be paid without contacting any bank. */
export class PreviewPayoutGateway implements FinancePayoutGateway {
  readonly configured = true;
  async executePayout(request: PayoutGatewayRequest): Promise<PayoutGatewayResult> {
    return {provider: "preview", providerOperationId: "", referenceId: `preview-${request.operationId}`.slice(0, 120), simulated: true};
  }
}

/**
 * Wraps the real bank connector with the owner's safety caps: a ceiling per
 * transfer and per weekly run. A payout over a cap is held for a manual
 * payout (it shows in the run as blocked, with the reason) instead of sent.
 */
export class GuardedPayoutGateway implements FinancePayoutGateway {
  private sentPaise = 0;
  constructor(private readonly inner: FinancePayoutGateway, private readonly maxPerPayoutPaise: number, private readonly maxPerRunPaise: number) {}
  get configured(): boolean { return this.inner.configured; }
  async executePayout(request: PayoutGatewayRequest): Promise<PayoutGatewayResult> {
    if (request.amountPaise > this.maxPerPayoutPaise) {
      throw new DomainError("failed-precondition",
        `Held: above the automatic limit of Rs ${Math.round(this.maxPerPayoutPaise / 100)} per payout. Pay it manually or raise the limit.`,
        {reason: "PAYOUT_ABOVE_LIMIT"});
    }
    if (this.sentPaise + request.amountPaise > this.maxPerRunPaise) {
      throw new DomainError("failed-precondition",
        `Held: this week's automatic total would pass Rs ${Math.round(this.maxPerRunPaise / 100)}. Pay it manually or raise the limit.`,
        {reason: "PAYOUT_RUN_LIMIT"});
    }
    this.sentPaise += request.amountPaise;
    try {
      return await this.inner.executePayout(request);
    } catch (error) {
      this.sentPaise -= request.amountPaise;
      throw error;
    }
  }
}

/**
 * The bank connector for live payouts. None is connected yet: HDFC API
 * Banking (or a payouts provider) plugs in here once its credentials and
 * specification are issued; until then live runs hold every payout.
 */
export function selectPayoutGateway(): {gateway: FinancePayoutGateway; name: string} {
  return {gateway: new UnconfiguredFinancePayoutGateway(), name: ""};
}

type UnknownRecord = Record<string, unknown>;

interface EntityLock {
  schemaVersion: 1;
  operationId: string;
  entityId: string;
  actorId: string;
  acquiredAt: number;
  leaseUntil: number;
}

interface RiderOutstandingBalance {
  earningsPaise: number;
  tipsPaise: number;
}

interface RestaurantOutstandingBalance {
  pendingSettlementPaise: number;
}

interface AutomationBeneficiaryProfile {
  beneficiaryLabel: string;
  preferredMethod: FinancePayoutMethod;
  upiId: string;
  bankAccountHolderName: string;
  bankAccountNumber: string;
  bankIfsc: string;
  upiReady: boolean;
  bankReady: boolean;
}

function defaultDatabase(): FinanceAutomationDatabase {
  return firestoreDb as unknown as FinanceAutomationDatabase;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown, maximum = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new DomainError("data-loss", "Finance automation total overflowed.");
  return result;
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function itemId(entityType: FinanceAutomationEntityType, entityId: string): string {
  return `${entityType}_${hashKey(`${entityType}:${entityId}`).slice(0, 24)}`;
}

function operationId(entityType: FinanceAutomationEntityType, entityId: string, periodKey: string): string {
  return `weekly:${entityType}:${periodKey}:${hashKey(entityId).slice(0, 24)}`.slice(0, 120);
}

function payoutReference(seed: string): string {
  return `AUTO-${hashKey(seed).slice(0, 20).toUpperCase()}`;
}

function entityLockRef(
  database: FirestoreLike,
  entityType: FinanceAutomationEntityType,
  entityId: string,
): DocumentReferenceLike {
  return entityType === "rider" ?
    riderPayoutLockRef(database, entityId) :
    restaurantSettlementLockRef(database, entityId);
}

function validUpiId(value: string): boolean {
  return /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/.test(value);
}

function validBankAccountNumber(value: string): boolean {
  return /^[0-9]{6,20}$/.test(value);
}

function validIfsc(value: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value);
}

function lockRecord(value: unknown, entityId: string): EntityLock | null {
  const candidate = record(value);
  if (!Object.keys(candidate).length) return null;
  if (candidate.schemaVersion !== 1 ||
      typeof candidate.operationId !== "string" ||
      typeof candidate.entityId !== "string" ||
      candidate.entityId !== entityId ||
      typeof candidate.actorId !== "string" ||
      !Number.isSafeInteger(candidate.acquiredAt) ||
      !Number.isSafeInteger(candidate.leaseUntil)) {
    return null;
  }
  return candidate as unknown as EntityLock;
}

function itemRecord(
  value: unknown,
  itemIdValue: string,
  entityType: FinanceAutomationEntityType,
  entityId: string,
  periodKey: string,
): FinanceAutomationItemRecord | null {
  const candidate = record(value);
  if (!Object.keys(candidate).length) return null;
  const validMethod = candidate.method === null ||
    candidate.method === "upi" ||
    candidate.method === "imps" ||
    candidate.method === "neft";
  const validStatus = [
    "completed",
    "held_minimum",
    "blocked_missing_entity",
    "blocked_missing_coverage",
    "blocked_invalid_balance",
    "blocked_profile",
    "blocked_provider",
  ].includes(String(candidate.status ?? ""));
  if (
    candidate.schemaVersion !== 1 ||
    candidate.itemId !== itemIdValue ||
    candidate.periodKey !== periodKey ||
    candidate.entityType !== entityType ||
    candidate.entityId !== entityId ||
    !Number.isSafeInteger(candidate.amountPaise) ||
    !validMethod ||
    !validStatus ||
    typeof candidate.reason !== "string" ||
    typeof candidate.beneficiaryLabel !== "string" ||
    typeof candidate.referenceId !== "string" ||
    typeof candidate.provider !== "string" ||
    typeof candidate.providerOperationId !== "string" ||
    typeof candidate.ledgerJournalId !== "string" ||
    !Number.isSafeInteger(candidate.attemptedAt) ||
    !Number.isSafeInteger(candidate.completedAt) ||
    !Number.isSafeInteger(candidate.minimumThresholdPaise)
  ) {
    return null;
  }
  return candidate as unknown as FinanceAutomationItemRecord;
}

function runSummaryRecord(value: unknown, periodKey: string): FinanceAutomationRunSummary | null {
  const candidate = record(value);
  if (!Object.keys(candidate).length) return null;
  const validStatus = [
    "disabled",
    "not_due",
    "busy",
    "completed",
    "completed_with_blocks",
    "preview",
  ].includes(String(candidate.status ?? ""));
  const counts = record(candidate.counts);
  const journalIds = Array.isArray(candidate.journalIds) ?
    candidate.journalIds.filter((entry) => typeof entry === "string") :
    [];
  if (
    candidate.schemaVersion !== 1 ||
    candidate.periodKey !== periodKey ||
    !validStatus ||
    !Number.isSafeInteger(candidate.attemptedAt) ||
    typeof candidate.scheduleLabel !== "string" ||
    !(candidate.nextRunDayKey === null || typeof candidate.nextRunDayKey === "string") ||
    !Number.isSafeInteger(candidate.riderMinimumPayoutPaise) ||
    !Number.isSafeInteger(candidate.restaurantMinimumSettlementPaise) ||
    !Number.isSafeInteger(counts.completed) ||
    !Number.isSafeInteger(counts.heldMinimum) ||
    !Number.isSafeInteger(counts.blockedMissingEntity) ||
    !Number.isSafeInteger(counts.blockedMissingCoverage) ||
    !Number.isSafeInteger(counts.blockedInvalidBalance) ||
    !Number.isSafeInteger(counts.blockedProfile) ||
    !Number.isSafeInteger(counts.blockedProvider) ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    periodKey,
    status: candidate.status as FinanceAutomationRunSummary["status"],
    attemptedAt: candidate.attemptedAt as number,
    scheduleLabel: candidate.scheduleLabel as string,
    nextRunDayKey: candidate.nextRunDayKey as string | null,
    riderMinimumPayoutPaise: candidate.riderMinimumPayoutPaise as number,
    restaurantMinimumSettlementPaise: candidate.restaurantMinimumSettlementPaise as number,
    counts: {
      completed: counts.completed as number,
      heldMinimum: counts.heldMinimum as number,
      blockedMissingEntity: counts.blockedMissingEntity as number,
      blockedMissingCoverage: counts.blockedMissingCoverage as number,
      blockedInvalidBalance: counts.blockedInvalidBalance as number,
      blockedProfile: counts.blockedProfile as number,
      blockedProvider: counts.blockedProvider as number,
      ...(Number.isSafeInteger(counts.previewed) ? {previewed: counts.previewed as number} : {}),
    },
    ...(Number.isSafeInteger(candidate.totalPaise) ? {totalPaise: candidate.totalPaise as number} : {}),
    ...(candidate.preview === true ? {preview: true} : {}),
    journalIds,
    message: candidate.message as string,
  };
}

async function acquireLock(
  database: FinanceAutomationDatabase,
  ref: DocumentReferenceLike,
  entityId: string,
  operationKey: string,
  now: number,
  leaseMs: number,
): Promise<void> {
  await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    const existing = current == null ? null : lockRecord(current, entityId);
    if (current != null && !existing) {
      throw new DomainError("data-loss", "A finance automation lock is invalid and needs review.");
    }
    if (existing && existing.operationId !== operationKey && existing.leaseUntil > now) {
      throw new DomainError("aborted", "A finance automation lock is busy.", {reason: "FINANCE_AUTOMATION_LOCK_BUSY"});
    }
    transaction.set(ref, {
      schemaVersion: 1,
      operationId: operationKey,
      entityId,
      actorId: SYSTEM_ACTOR_ID,
      acquiredAt: now,
      leaseUntil: now + leaseMs,
    } satisfies EntityLock);
  });
}

async function releaseLock(
  database: FinanceAutomationDatabase,
  ref: DocumentReferenceLike,
  entityId: string,
  operationKey: string,
): Promise<void> {
  await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    const existing = current == null ? null : lockRecord(current, entityId);
    if (!existing || existing.operationId === operationKey) {
      transaction.delete(ref);
    }
  });
}

function parseLedgerSnapshot(entries: ReadonlyArray<{id: string; data: unknown}>): {
  journals: readonly LedgerJournal[];
  invalidJournalCount: number;
} {
  const journals: LedgerJournal[] = [];
  let invalidJournalCount = 0;
  for (const {id: key, data: value} of entries) {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID");
      const journal = value as LedgerJournal;
      validateLedgerJournal(journal);
      if (journal.journalId !== key) throw new Error("MISMATCH");
      journals.push(journal);
    } catch {
      invalidJournalCount += 1;
    }
  }
  journals.sort((left, right) => left.occurredAt - right.occurredAt || left.journalId.localeCompare(right.journalId));
  return {journals, invalidJournalCount};
}

function aggregateOutstandingBalances(journals: readonly LedgerJournal[]): {
  riders: ReadonlyMap<string, RiderOutstandingBalance>;
  restaurants: ReadonlyMap<string, RestaurantOutstandingBalance>;
} {
  const riders = new Map<string, RiderOutstandingBalance>();
  const restaurants = new Map<string, RestaurantOutstandingBalance>();
  for (const journal of journals) {
    for (const entry of journal.entries) {
      if (entry.accountId.startsWith("liability:rider-earnings:")) {
        const riderId = entry.accountId.slice("liability:rider-earnings:".length);
        const current = riders.get(riderId) ?? {earningsPaise: 0, tipsPaise: 0};
        current.earningsPaise = safeAdd(
          current.earningsPaise,
          entry.side === "credit" ? entry.amountPaise : -entry.amountPaise,
        );
        riders.set(riderId, current);
      } else if (entry.accountId.startsWith("liability:rider-tips:")) {
        const riderId = entry.accountId.slice("liability:rider-tips:".length);
        const current = riders.get(riderId) ?? {earningsPaise: 0, tipsPaise: 0};
        current.tipsPaise = safeAdd(
          current.tipsPaise,
          entry.side === "credit" ? entry.amountPaise : -entry.amountPaise,
        );
        riders.set(riderId, current);
      } else if (entry.accountId.startsWith("liability:restaurant-payable:")) {
        const restaurantId = entry.accountId.slice("liability:restaurant-payable:".length);
        const current = restaurants.get(restaurantId) ?? {pendingSettlementPaise: 0};
        current.pendingSettlementPaise = safeAdd(
          current.pendingSettlementPaise,
          entry.side === "credit" ? entry.amountPaise : -entry.amountPaise,
        );
        restaurants.set(restaurantId, current);
      }
    }
  }
  return {riders, restaurants};
}

async function readAllLedgerBalances(
  database: FinanceAutomationDatabase,
): Promise<{
  riders: ReadonlyMap<string, RiderOutstandingBalance>;
  restaurants: ReadonlyMap<string, RestaurantOutstandingBalance>;
  invalidJournalCount: number;
}> {
  const snapshot = await database.collection(LEDGER_JOURNALS_COLLECTION).get();
  const parsed = parseLedgerSnapshot(snapshot.docs.map((doc) => ({id: doc.id, data: doc.data()})));
  const aggregates = aggregateOutstandingBalances(parsed.journals);
  return {
    ...aggregates,
    invalidJournalCount: parsed.invalidJournalCount,
  };
}

async function currentRiderOutstanding(
  database: FinanceAutomationDatabase,
  riderId: string,
): Promise<RiderOutstandingBalance | null> {
  const balances = await readAllLedgerBalances(database);
  if (balances.invalidJournalCount > 0) return null;
  return balances.riders.get(riderId) ?? {earningsPaise: 0, tipsPaise: 0};
}

async function currentRestaurantOutstanding(
  database: FinanceAutomationDatabase,
  restaurantId: string,
): Promise<RestaurantOutstandingBalance | null> {
  const balances = await readAllLedgerBalances(database);
  if (balances.invalidJournalCount > 0) return null;
  return balances.restaurants.get(restaurantId) ?? {pendingSettlementPaise: 0};
}

function riderCoverageSet(raw: unknown): ReadonlySet<string> {
  const container = record(raw);
  const covered = new Set<string>();
  for (const [riderId, value] of Object.entries(container)) {
    const source = record(value);
    if (source.schemaVersion === 1 &&
        source.riderId === riderId &&
        source.historicalBackfillComplete === true &&
        Number.isSafeInteger(source.verifiedAt) &&
        Number(source.verifiedAt) > 0) {
      covered.add(riderId);
    }
  }
  return covered;
}

function restaurantCoverageSet(raw: unknown): ReadonlySet<string> {
  const container = record(raw);
  const covered = new Set<string>();
  for (const [restaurantId, value] of Object.entries(container)) {
    const source = record(value);
    if (source.schemaVersion === 1 &&
        source.restaurantId === restaurantId &&
        source.historicalBackfillComplete === true &&
        Number.isSafeInteger(source.verifiedAt) &&
        Number(source.verifiedAt) > 0) {
      covered.add(restaurantId);
    }
  }
  return covered;
}

function riderProfileFromRecord(riderId: string, rider: unknown): AutomationBeneficiaryProfile {
  const source = record(rider);
  const profile = record(source.payoutProfile);
  const upiId = text(profile.upiId, 120);
  const bankAccountHolderName = text(profile.bankAccountHolderName || source.fullName || source.name, 120);
  const bankAccountNumber = text(profile.bankAccountNumber, 40).replace(/\s+/g, "");
  const bankIfsc = text(profile.bankIfsc, 20).toUpperCase();
  const beneficiaryLabel = text(profile.beneficiaryName || source.fullName || source.name, 160) || riderId;
  const preferredMethod = profile.preferredMethod === "imps" || profile.preferredMethod === "neft"
    ? profile.preferredMethod
    : "upi";
  return {
    beneficiaryLabel,
    preferredMethod,
    upiId,
    bankAccountHolderName,
    bankAccountNumber,
    bankIfsc,
    upiReady: !!beneficiaryLabel && validUpiId(upiId),
    bankReady: !!bankAccountHolderName && validBankAccountNumber(bankAccountNumber) && validIfsc(bankIfsc),
  };
}

function restaurantProfileFromRecord(restaurantId: string, restaurant: unknown): AutomationBeneficiaryProfile {
  const source = record(restaurant);
  const profile = record(source.payoutProfile);
  const upiId = text(profile.upiId, 120);
  const bankAccountHolderName = text(profile.bankAccountHolderName || source.name, 120);
  const bankAccountNumber = text(profile.bankAccountNumber, 40).replace(/\s+/g, "");
  const bankIfsc = text(profile.bankIfsc, 20).toUpperCase();
  const beneficiaryLabel = text(profile.legalBusinessName || profile.beneficiaryName || source.name, 160) || restaurantId;
  const preferredMethod = profile.preferredMethod === "upi" || profile.preferredMethod === "imps"
    ? profile.preferredMethod
    : "neft";
  return {
    beneficiaryLabel,
    preferredMethod,
    upiId,
    bankAccountHolderName,
    bankAccountNumber,
    bankIfsc,
    upiReady: !!beneficiaryLabel && validUpiId(upiId),
    bankReady: !!bankAccountHolderName && validBankAccountNumber(bankAccountNumber) && validIfsc(bankIfsc),
  };
}

function humanBlockedReason(reason: FinancePayoutAutomationBlockedReason): string {
  switch (reason) {
  case "HIGH_VALUE_REQUIRES_BANK":
    return "High-value weekly payout needs verified bank details.";
  case "UPI_OR_BANK_DETAILS_REQUIRED":
    return "Add a valid UPI ID or bank account before weekly payout.";
  case "PREFERRED_RAIL_UNAVAILABLE":
    return "Preferred payout rail is not available with the current profile or policy.";
  case "NO_ENABLED_RAIL":
    return "No payout rail is enabled for this weekly payout.";
  default:
    return "Automatic payout is disabled.";
  }
}

function buildRiderPayoutJournal(input: {
  payoutId: string;
  riderId: string;
  amountPaise: number;
  paidEarningsPaise: number;
  paidTipsPaise: number;
  occurredAt: number;
  actorId: string;
  method: FinancePayoutMethod;
  referenceId: string;
  provider: string;
  periodKey: string;
}): LedgerJournal {
  return createLedgerJournal({
    eventType: "rider_payout",
    eventId: `payout:${input.payoutId}`,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    metadata: {
      riderId: input.riderId,
      payoutMethod: input.method,
      referenceId: input.referenceId,
      provider: input.provider,
      periodKey: input.periodKey,
      earningsSettledPaise: input.paidEarningsPaise,
      tipsSettledPaise: input.paidTipsPaise,
      allocationStrategy: "earnings_first",
      settlementMode: "weekly_automation",
    },
    postings: [
      ...(input.paidEarningsPaise > 0 ? [{
        accountId: `liability:rider-earnings:${input.riderId}`,
        side: "debit" as const,
        amountPaise: input.paidEarningsPaise,
        memo: "Rider earnings settled",
      }] : []),
      ...(input.paidTipsPaise > 0 ? [{
        accountId: `liability:rider-tips:${input.riderId}`,
        side: "debit" as const,
        amountPaise: input.paidTipsPaise,
        memo: "Rider tips settled",
      }] : []),
      {
        accountId: "asset:rider-payout-clearing",
        side: "credit" as const,
        amountPaise: input.amountPaise,
        memo: "Rider payout released",
      },
    ],
  });
}

async function upsertItemRecord(
  database: FinanceAutomationDatabase,
  periodKey: string,
  item: FinanceAutomationItemRecord,
): Promise<void> {
  const ref = weeklyRunItemRef(database, periodKey, item.itemId);
  await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? record(snapshot.data()) : {};
    transaction.set(ref, {...current, ...item});
  });
}

async function writeAudit(
  database: FinanceAutomationDatabase,
  id: string,
  action: string,
  target: string,
  detail: string,
  at: number,
): Promise<void> {
  const auditRecord = {
    id,
    action,
    target: target.slice(0, 200),
    detail: detail.slice(0, 500),
    actorId: SYSTEM_ACTOR_ID,
    actorEmail: String(SYSTEM_TOKEN.email ?? ""),
    actorRole: "owner",
    at,
  };
  const ref = auditRef(database, id);
  await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) transaction.set(ref, auditRecord);
  });
}

function emptySummary(
  policy: FinancePolicy,
  attemptedAt: number,
  status: FinanceAutomationRunSummary["status"],
  message: string,
  riderMinimumPayoutPaise: number,
): FinanceAutomationRunSummary {
  return {
    schemaVersion: 1,
    periodKey: financePayoutAutomationCurrentPeriodKey(policy, attemptedAt),
    status,
    attemptedAt,
    scheduleLabel: financePayoutAutomationScheduleLabel(policy),
    nextRunDayKey: financePayoutAutomationNextRunDayKey(policy, attemptedAt),
    riderMinimumPayoutPaise,
    restaurantMinimumSettlementPaise: policy.payouts.automation.minimumRestaurantSettlementPaise,
    counts: {
      completed: 0,
      heldMinimum: 0,
      blockedMissingEntity: 0,
      blockedMissingCoverage: 0,
      blockedInvalidBalance: 0,
      blockedProfile: 0,
      blockedProvider: 0,
    },
    journalIds: [],
    message,
  };
}

async function processRider(
  riderId: string,
  periodKey: string,
  attemptedAt: number,
  policy: FinancePolicy,
  minimumPayoutPaise: number,
  riderRecords: UnknownRecord,
  coveredRiders: ReadonlySet<string>,
  gateway: FinancePayoutGateway,
  database: FinanceAutomationDatabase,
): Promise<FinanceAutomationItemRecord> {
  const itemKey = itemId("rider", riderId);
  const lockKey = operationId("rider", riderId, periodKey);
  const priorItemSnapshot = await weeklyRunItemRef(database, periodKey, itemKey).get();
  const priorItem = itemRecord(
    priorItemSnapshot.exists ? priorItemSnapshot.data() : null,
    itemKey,
    "rider",
    riderId,
    periodKey,
  );
  if (priorItem?.status === "completed") return priorItem;
  const rider = record(riderRecords[riderId]);
  if (!Object.keys(rider).length) {
    return {
      schemaVersion: 1,
      itemId: itemKey,
      periodKey,
      entityType: "rider",
      entityId: riderId,
      amountPaise: 0,
      method: null,
      status: "blocked_missing_entity",
      reason: "Rider record is missing for weekly payout.",
      beneficiaryLabel: riderId,
      referenceId: "",
      provider: "",
      providerOperationId: "",
      ledgerJournalId: "",
      attemptedAt,
      completedAt: 0,
      minimumThresholdPaise: minimumPayoutPaise,
    };
  }
  if (!coveredRiders.has(riderId)) {
    return {
      schemaVersion: 1,
      itemId: itemKey,
      periodKey,
      entityType: "rider",
      entityId: riderId,
      amountPaise: 0,
      method: null,
      status: "blocked_missing_coverage",
      reason: "Rider ledger coverage is not verified yet.",
      beneficiaryLabel: text(rider.fullName || rider.name, 160) || riderId,
      referenceId: "",
      provider: "",
      providerOperationId: "",
      ledgerJournalId: "",
      attemptedAt,
      completedAt: 0,
      minimumThresholdPaise: minimumPayoutPaise,
    };
  }

  await acquireLock(database, entityLockRef(database, "rider", riderId), riderId, lockKey, attemptedAt, ENTITY_LOCK_LEASE_MS);
  try {
    const current = await currentRiderOutstanding(database, riderId);
    const profile = riderProfileFromRecord(riderId, rider);
    if (!current) {
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "rider",
        entityId: riderId,
        amountPaise: 0,
        method: null,
        status: "blocked_invalid_balance",
        reason: "Rider ledger data needs finance review before automatic weekly payout.",
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumPayoutPaise,
      };
    }
    const totalPaise = current.earningsPaise + current.tipsPaise;
    if (!Number.isSafeInteger(totalPaise) || current.earningsPaise < 0 || current.tipsPaise < 0 || totalPaise < 0) {
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "rider",
        entityId: riderId,
        amountPaise: Math.max(0, totalPaise || 0),
        method: null,
        status: "blocked_invalid_balance",
        reason: "Rider payable balance became invalid during weekly payout reconciliation.",
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumPayoutPaise,
      };
    }
    if (totalPaise < minimumPayoutPaise || totalPaise <= 0) {
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "rider",
        entityId: riderId,
        amountPaise: totalPaise,
        method: null,
        status: "held_minimum",
        reason: totalPaise <= 0 ?
          "Nothing is payable for this rider in the weekly run." :
          "Rider payout is below the minimum weekly payout threshold.",
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumPayoutPaise,
      };
    }
    const selected = selectFinancePayoutMethodForAutomation(policy, totalPaise, {
      preferredMethod: profile.preferredMethod,
      upiReady: profile.upiReady,
      bankReady: profile.bankReady,
    });
    if (!selected.method || selected.blockedReason) {
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "rider",
        entityId: riderId,
        amountPaise: totalPaise,
        method: selected.method,
        status: "blocked_profile",
        reason: humanBlockedReason(selected.blockedReason ?? "UPI_OR_BANK_DETAILS_REQUIRED"),
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumPayoutPaise,
      };
    }
    let gatewayResult: PayoutGatewayResult;
    try {
      gatewayResult = await gateway.executePayout({
        entityType: "rider",
        entityId: riderId,
        amountPaise: totalPaise,
        method: selected.method,
        operationId: lockKey,
        beneficiaryLabel: profile.beneficiaryLabel,
        upiId: profile.upiId,
        bankAccountHolderName: profile.bankAccountHolderName,
        bankAccountNumber: profile.bankAccountNumber,
        bankIfsc: profile.bankIfsc,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automatic rider payout could not be sent.";
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "rider",
        entityId: riderId,
        amountPaise: totalPaise,
        method: selected.method,
        status: "blocked_provider",
        reason: message,
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumPayoutPaise,
      };
    }
    if (gatewayResult.simulated) {
      return {
        schemaVersion: 1, itemId: itemKey, periodKey, entityType: "rider", entityId: riderId, amountPaise: totalPaise,
        method: selected.method, status: "previewed", reason: "Would be paid in the weekly run.",
        beneficiaryLabel: profile.beneficiaryLabel, referenceId: "", provider: "preview", providerOperationId: "",
        ledgerJournalId: "", attemptedAt, completedAt: 0, minimumThresholdPaise: minimumPayoutPaise,
      };
    }
    const referenceId = text(gatewayResult.referenceId, 120) || payoutReference(lockKey);
    const completedAt = Number.isSafeInteger(gatewayResult.completedAt) && Number(gatewayResult.completedAt) > 0 ?
      Number(gatewayResult.completedAt) : attemptedAt;
    const journal = buildRiderPayoutJournal({
      payoutId: lockKey,
      riderId,
      amountPaise: totalPaise,
      paidEarningsPaise: current.earningsPaise,
      paidTipsPaise: current.tipsPaise,
      occurredAt: completedAt,
      actorId: SYSTEM_ACTOR_ID,
      method: selected.method,
      referenceId,
      provider: text(gatewayResult.provider, 80) || "automation",
      periodKey,
    });
    const persisted = await persistLedgerJournal(journal, database);
    await writeAudit(
      database,
      `finance-weekly-rider-${hashKey(`${periodKey}:${riderId}`).slice(0, 36)}`,
      "finance_automation.rider_payout_completed",
      `riders/${riderId}`,
      `${selected.method}; ${totalPaise} paise; ref ${referenceId}; period ${periodKey}`,
      completedAt,
    );
    return {
      schemaVersion: 1,
      itemId: itemKey,
      periodKey,
      entityType: "rider",
      entityId: riderId,
      amountPaise: totalPaise,
      method: selected.method,
      status: "completed",
      reason: persisted.outcome === "idempotent" ? "Weekly rider payout was already recorded." : "Weekly rider payout completed.",
      beneficiaryLabel: profile.beneficiaryLabel,
      referenceId,
      provider: text(gatewayResult.provider, 80) || "automation",
      providerOperationId: text(gatewayResult.providerOperationId, 120) || payoutReference(`${lockKey}:provider`),
      ledgerJournalId: persisted.journal.journalId,
      attemptedAt,
      completedAt,
      minimumThresholdPaise: minimumPayoutPaise,
    };
  } finally {
    await releaseLock(database, entityLockRef(database, "rider", riderId), riderId, lockKey);
  }
}

async function processRestaurant(
  restaurantId: string,
  periodKey: string,
  attemptedAt: number,
  policy: FinancePolicy,
  restaurantRecords: UnknownRecord,
  coveredRestaurants: ReadonlySet<string>,
  gateway: FinancePayoutGateway,
  database: FinanceAutomationDatabase,
): Promise<FinanceAutomationItemRecord> {
  const itemKey = itemId("restaurant", restaurantId);
  const lockKey = operationId("restaurant", restaurantId, periodKey);
  const priorItemSnapshot = await weeklyRunItemRef(database, periodKey, itemKey).get();
  const priorItem = itemRecord(
    priorItemSnapshot.exists ? priorItemSnapshot.data() : null,
    itemKey,
    "restaurant",
    restaurantId,
    periodKey,
  );
  if (priorItem?.status === "completed") return priorItem;
  const restaurant = record(restaurantRecords[restaurantId]);
  const minimumSettlementPaise = policy.payouts.automation.minimumRestaurantSettlementPaise;
  if (!Object.keys(restaurant).length) {
    return {
      schemaVersion: 1,
      itemId: itemKey,
      periodKey,
      entityType: "restaurant",
      entityId: restaurantId,
      amountPaise: 0,
      method: null,
      status: "blocked_missing_entity",
      reason: "Restaurant record is missing for weekly settlement.",
      beneficiaryLabel: restaurantId,
      referenceId: "",
      provider: "",
      providerOperationId: "",
      ledgerJournalId: "",
      attemptedAt,
      completedAt: 0,
      minimumThresholdPaise: minimumSettlementPaise,
    };
  }
  if (!coveredRestaurants.has(restaurantId)) {
    return {
      schemaVersion: 1,
      itemId: itemKey,
      periodKey,
      entityType: "restaurant",
      entityId: restaurantId,
      amountPaise: 0,
      method: null,
      status: "blocked_missing_coverage",
      reason: "Restaurant ledger coverage is not verified yet.",
      beneficiaryLabel: text(restaurant.name, 160) || restaurantId,
      referenceId: "",
      provider: "",
      providerOperationId: "",
      ledgerJournalId: "",
      attemptedAt,
      completedAt: 0,
      minimumThresholdPaise: minimumSettlementPaise,
    };
  }

  await acquireLock(
    database,
    entityLockRef(database, "restaurant", restaurantId),
    restaurantId,
    lockKey,
    attemptedAt,
    ENTITY_LOCK_LEASE_MS,
  );
  try {
    const current = await currentRestaurantOutstanding(database, restaurantId);
    const profile = restaurantProfileFromRecord(restaurantId, restaurant);
    if (!current) {
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "restaurant",
        entityId: restaurantId,
        amountPaise: 0,
        method: null,
        status: "blocked_invalid_balance",
        reason: "Restaurant ledger data needs finance review before automatic weekly settlement.",
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumSettlementPaise,
      };
    }
    const totalPaise = current.pendingSettlementPaise;
    if (!Number.isSafeInteger(totalPaise) || totalPaise < 0) {
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "restaurant",
        entityId: restaurantId,
        amountPaise: Math.max(0, totalPaise || 0),
        method: null,
        status: "blocked_invalid_balance",
        reason: "Restaurant pending settlement became invalid during weekly reconciliation.",
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumSettlementPaise,
      };
    }
    if (totalPaise < minimumSettlementPaise || totalPaise <= 0) {
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "restaurant",
        entityId: restaurantId,
        amountPaise: totalPaise,
        method: null,
        status: "held_minimum",
        reason: totalPaise <= 0 ?
          "Nothing is pending for this restaurant in the weekly run." :
          "Restaurant settlement is below the minimum weekly settlement threshold.",
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumSettlementPaise,
      };
    }
    const selected = selectFinancePayoutMethodForAutomation(policy, totalPaise, {
      preferredMethod: profile.preferredMethod,
      upiReady: profile.upiReady,
      bankReady: profile.bankReady,
    });
    if (!selected.method || selected.blockedReason) {
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "restaurant",
        entityId: restaurantId,
        amountPaise: totalPaise,
        method: selected.method,
        status: "blocked_profile",
        reason: humanBlockedReason(selected.blockedReason ?? "UPI_OR_BANK_DETAILS_REQUIRED"),
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumSettlementPaise,
      };
    }
    let gatewayResult: PayoutGatewayResult;
    try {
      gatewayResult = await gateway.executePayout({
        entityType: "restaurant",
        entityId: restaurantId,
        amountPaise: totalPaise,
        method: selected.method,
        operationId: lockKey,
        beneficiaryLabel: profile.beneficiaryLabel,
        upiId: profile.upiId,
        bankAccountHolderName: profile.bankAccountHolderName,
        bankAccountNumber: profile.bankAccountNumber,
        bankIfsc: profile.bankIfsc,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automatic restaurant settlement could not be sent.";
      return {
        schemaVersion: 1,
        itemId: itemKey,
        periodKey,
        entityType: "restaurant",
        entityId: restaurantId,
        amountPaise: totalPaise,
        method: selected.method,
        status: "blocked_provider",
        reason: message,
        beneficiaryLabel: profile.beneficiaryLabel,
        referenceId: "",
        provider: "",
        providerOperationId: "",
        ledgerJournalId: "",
        attemptedAt,
        completedAt: 0,
        minimumThresholdPaise: minimumSettlementPaise,
      };
    }
    if (gatewayResult.simulated) {
      return {
        schemaVersion: 1, itemId: itemKey, periodKey, entityType: "restaurant", entityId: restaurantId, amountPaise: totalPaise,
        method: selected.method, status: "previewed", reason: "Would be paid in the weekly run.",
        beneficiaryLabel: profile.beneficiaryLabel, referenceId: "", provider: "preview", providerOperationId: "",
        ledgerJournalId: "", attemptedAt, completedAt: 0, minimumThresholdPaise: minimumSettlementPaise,
      };
    }
    const referenceId = text(gatewayResult.referenceId, 120) || payoutReference(lockKey);
    const completedAt = Number.isSafeInteger(gatewayResult.completedAt) && Number(gatewayResult.completedAt) > 0 ?
      Number(gatewayResult.completedAt) : attemptedAt;
    const journal = buildRestaurantSettlementJournal({
      settlementId: lockKey,
      restaurantId,
      amountPaise: totalPaise,
      occurredAt: completedAt,
      actorId: SYSTEM_ACTOR_ID,
      method: selected.method,
      referenceId,
    });
    const persisted = await persistLedgerJournal(journal, database);
    await writeAudit(
      database,
      `finance-weekly-restaurant-${hashKey(`${periodKey}:${restaurantId}`).slice(0, 36)}`,
      "finance_automation.restaurant_settlement_completed",
      `catalog/restaurants/${restaurantId}`,
      `${selected.method}; ${totalPaise} paise; ref ${referenceId}; period ${periodKey}`,
      completedAt,
    );
    return {
      schemaVersion: 1,
      itemId: itemKey,
      periodKey,
      entityType: "restaurant",
      entityId: restaurantId,
      amountPaise: totalPaise,
      method: selected.method,
      status: "completed",
      reason: persisted.outcome === "idempotent" ?
        "Weekly restaurant settlement was already recorded." :
        "Weekly restaurant settlement completed.",
      beneficiaryLabel: profile.beneficiaryLabel,
      referenceId,
      provider: text(gatewayResult.provider, 80) || "automation",
      providerOperationId: text(gatewayResult.providerOperationId, 120) || payoutReference(`${lockKey}:provider`),
      ledgerJournalId: persisted.journal.journalId,
      attemptedAt,
      completedAt,
      minimumThresholdPaise: minimumSettlementPaise,
    };
  } finally {
    await releaseLock(database, entityLockRef(database, "restaurant", restaurantId), restaurantId, lockKey);
  }
}

function summarizeItems(
  policy: FinancePolicy,
  attemptedAt: number,
  periodKey: string,
  riderMinimumPayoutPaise: number,
  items: readonly FinanceAutomationItemRecord[],
  preview = false,
): FinanceAutomationRunSummary {
  const counts = {
    completed: 0,
    heldMinimum: 0,
    blockedMissingEntity: 0,
    blockedMissingCoverage: 0,
    blockedInvalidBalance: 0,
    blockedProfile: 0,
    blockedProvider: 0,
    previewed: 0,
  };
  let totalPaise = 0;
  for (const item of items) {
    if (item.status === "completed" || item.status === "previewed") totalPaise += item.amountPaise;
    if (item.status === "previewed") counts.previewed += 1;
    if (item.status === "completed") counts.completed += 1;
    else if (item.status === "held_minimum") counts.heldMinimum += 1;
    else if (item.status === "blocked_missing_entity") counts.blockedMissingEntity += 1;
    else if (item.status === "blocked_missing_coverage") counts.blockedMissingCoverage += 1;
    else if (item.status === "blocked_invalid_balance") counts.blockedInvalidBalance += 1;
    else if (item.status === "blocked_profile") counts.blockedProfile += 1;
    else if (item.status === "blocked_provider") counts.blockedProvider += 1;
  }
  const blockedCount = counts.blockedMissingEntity + counts.blockedMissingCoverage +
    counts.blockedInvalidBalance + counts.blockedProfile + counts.blockedProvider;
  return {
    schemaVersion: 1,
    periodKey,
    status: preview ? "preview" : blockedCount > 0 ? "completed_with_blocks" : "completed",
    attemptedAt,
    scheduleLabel: financePayoutAutomationScheduleLabel(policy),
    nextRunDayKey: financePayoutAutomationNextRunDayKey(policy, attemptedAt),
    riderMinimumPayoutPaise,
    restaurantMinimumSettlementPaise: policy.payouts.automation.minimumRestaurantSettlementPaise,
    counts,
    totalPaise,
    ...(preview ? {preview: true} : {}),
    journalIds: items.filter((item) => item.ledgerJournalId).map((item) => item.ledgerJournalId),
    message: preview ? "Preview only: no money moved and nothing was recorded as paid." : blockedCount > 0 ?
      "Weekly payout automation completed with some blocked items." :
      "Weekly payout automation completed successfully.",
  };
}

export async function runWeeklyFinanceAutomation(
  referenceAt = Date.now(),
  database: FinanceAutomationDatabase = defaultDatabase(),
  gateway: FinancePayoutGateway = new UnconfiguredFinancePayoutGateway(),
  loadPolicy: (nowValue?: number) => Promise<FinancePolicy> = loadFinancePolicy,
  options: {preview?: boolean} = {},
): Promise<FinanceAutomationRunSummary> {
  const attemptedAt = Number.isSafeInteger(referenceAt) && referenceAt > 0 ? referenceAt : Date.now();
  const preview = options.preview === true;
  const [policy, settingsSnapshot] = await Promise.all([
    loadPolicy(attemptedAt),
    riderRewardSettingsRef(database).get(),
  ]);
  const riderMinimumPayoutPaise = normalizeRewardSettings(
    settingsSnapshot.exists ? settingsSnapshot.data() : null,
  ).payoutMinimumPaise;
  if (!preview && !policy.payouts.automation.enabled) {
    return emptySummary(policy, attemptedAt, "disabled", "Weekly payout automation is disabled.", riderMinimumPayoutPaise);
  }
  // A preview has its own key, so it can never stand in for (or block) the real week's run.
  const periodKey = preview ? `preview-${attemptedAt}` : financePayoutAutomationCurrentPeriodKey(policy, attemptedAt);
  if (!periodKey) {
    return emptySummary(policy, attemptedAt, "not_due", "Weekly payout automation is not due yet.", riderMinimumPayoutPaise);
  }
  if (!preview) {
    const runSnapshot = await weeklyRunRef(database, periodKey).get();
    const existingSummary = runSummaryRecord(runSnapshot.exists ? runSnapshot.data() : null, periodKey);
    if (existingSummary) return existingSummary;
  }
  const payoutGateway: FinancePayoutGateway = preview ? new PreviewPayoutGateway() :
    new GuardedPayoutGateway(gateway, policy.payouts.automation.maxPerPayoutPaise, policy.payouts.automation.maxPerRunPaise);

  try {
    await acquireLock(database, runLockRef(database, periodKey), periodKey, periodKey, attemptedAt, RUN_LOCK_LEASE_MS);
  } catch (error) {
    if (error instanceof DomainError && error.code === "aborted") {
      return emptySummary(policy, attemptedAt, "busy", "Weekly payout automation is already running.", riderMinimumPayoutPaise);
    }
    throw error;
  }

  try {
    // Rider contractor TDS on every credit first, so balances are net of it.
    // A preview writes no tax journals, so its rider amounts are before this sweep.
    if (!preview) await sweepRiderContractorTds(database as unknown as FirestoreLike, attemptedAt);
    const [balances, riderCoverageSnapshot, restaurantCoverageSnapshot, ridersSnapshot, restaurantsSnapshot] =
      await Promise.all([
        readAllLedgerBalances(database),
        riderLedgerCoverageRef(database).get(),
        restaurantLedgerCoverageRef(database).get(),
        database.collection("riders").get(),
        database.collection("restaurants").get(),
      ]);

    if (balances.invalidJournalCount > 0) {
      const summary = emptySummary(
        policy,
        attemptedAt,
        "completed_with_blocks",
        "Weekly payout automation stopped because invalid ledger data needs finance review.",
        riderMinimumPayoutPaise,
      );
      await weeklyRunRef(database, periodKey).set(summary);
      await writeAudit(
        database,
        `finance-weekly-run-${hashKey(periodKey).slice(0, 36)}`,
        "finance_automation.weekly_run_blocked",
        "financeAutomation",
        `period ${periodKey}; invalidJournals ${balances.invalidJournalCount}`,
        attemptedAt,
      );
      return summary;
    }

    const riderRecords: UnknownRecord = {};
    for (const doc of ridersSnapshot.docs) riderRecords[doc.id] = doc.data();
    const publicRestaurantRecords: UnknownRecord = {};
    for (const doc of restaurantsSnapshot.docs) publicRestaurantRecords[doc.id] = doc.data();
    const restaurantRecords = await withPrivatePayoutProfiles(
      database as unknown as FirestoreLike, publicRestaurantRecords) as UnknownRecord;
    const coveredRiders = riderCoverageSet(riderCoverageSnapshot.exists ? riderCoverageSnapshot.data() : null);
    const coveredRestaurants = restaurantCoverageSet(
      restaurantCoverageSnapshot.exists ? restaurantCoverageSnapshot.data() : null,
    );
    const riderIds = policy.payouts.automation.ridersEnabled ?
      [...balances.riders.entries()]
        .filter(([, balance]) => balance.earningsPaise + balance.tipsPaise > 0)
        .map(([riderId]) => riderId) :
      [];
    const restaurantIds = policy.payouts.automation.restaurantsEnabled ?
      [...balances.restaurants.entries()]
        .filter(([, balance]) => balance.pendingSettlementPaise > 0)
        .map(([restaurantId]) => restaurantId) :
      [];

    const items: FinanceAutomationItemRecord[] = [];
    for (const riderId of riderIds) {
      const item = await processRider(
        riderId,
        periodKey,
        attemptedAt,
        policy,
        riderMinimumPayoutPaise,
        riderRecords,
        coveredRiders,
        payoutGateway,
        database,
      );
      await upsertItemRecord(database, periodKey, item);
      items.push(item);
    }
    for (const restaurantId of restaurantIds) {
      const item = await processRestaurant(
        restaurantId,
        periodKey,
        attemptedAt,
        policy,
        restaurantRecords,
        coveredRestaurants,
        payoutGateway,
        database,
      );
      await upsertItemRecord(database, periodKey, item);
      items.push(item);
    }

    const summary = summarizeItems(policy, attemptedAt, periodKey, riderMinimumPayoutPaise, items, preview);
    await weeklyRunRef(database, periodKey).set(summary);
    await writeAudit(
      database,
      `finance-weekly-run-${hashKey(periodKey).slice(0, 36)}`,
      summary.status === "completed" ? "finance_automation.weekly_run_completed" : "finance_automation.weekly_run_completed_with_blocks",
      "financeAutomation",
      `period ${periodKey}; completed ${summary.counts.completed}; blocked ${summary.counts.blockedMissingEntity + summary.counts.blockedMissingCoverage + summary.counts.blockedInvalidBalance + summary.counts.blockedProfile + summary.counts.blockedProvider}; held ${summary.counts.heldMinimum}`,
      attemptedAt,
    );
    return summary;
  } finally {
    await releaseLock(database, runLockRef(database, periodKey), periodKey, periodKey);
  }
}

/** One run's items (who, how much, what happened), for the Admin payouts panel. */
export async function readWeeklyRunItems(periodKey: string, database: FinanceAutomationDatabase = defaultDatabase()): Promise<FinanceAutomationItemRecord[]> {
  const snapshot = await weeklyRunRef(database, periodKey).collection("items").limit(500).get();
  return snapshot.docs.map((doc) => doc.data() as FinanceAutomationItemRecord)
    .sort((a, b) => b.amountPaise - a.amountPaise);
}

/** The latest real (not preview) weekly run, if any. */
export async function readLatestWeeklyRun(database: FinanceAutomationDatabase = defaultDatabase()): Promise<FinanceAutomationRunSummary | null> {
  const snapshot = await financeAutomationDoc(database).collection("weeklyRuns").orderBy("attemptedAt", "desc").limit(20).get();
  const run = snapshot.docs.map((doc) => doc.data() as FinanceAutomationRunSummary).find((r) => !r.preview);
  return run ?? null;
}

import {createHash} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {db} from "../admin";
import {ROOT} from "../config";
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
import {LEDGER_JOURNALS_ROOT, persistLedgerJournal, type LedgerTransactionDatabase} from "./ledger";
import {loadFinancePolicy} from "./platformConfig";
import {RIDER_REWARD_SETTINGS_ROOT, normalizeRewardSettings} from "./riderRewards";
import {buildRestaurantSettlementJournal} from "./restaurantSettlements";

export const FINANCE_AUTOMATION_ROOT = `${ROOT}/private/financeAutomation`;
export const FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT = `${FINANCE_AUTOMATION_ROOT}/weeklyRuns`;
export const FINANCE_AUTOMATION_LOCKS_ROOT = `${FINANCE_AUTOMATION_ROOT}/locks`;
export const RIDER_PAYOUT_LOCKS_ROOT = `${ROOT}/private/financeOperations/riderPayoutLocks`;
export const RESTAURANT_SETTLEMENT_LOCKS_ROOT = `${ROOT}/private/financeOperations/restaurantSettlementLocks`;
export const RIDER_LEDGER_COVERAGE_ROOT = `${ROOT}/private/financialLedger/coverage/riders`;
export const RESTAURANT_LEDGER_COVERAGE_ROOT = `${ROOT}/private/financialLedger/coverage/restaurants`;

const RUN_LOCK_LEASE_MS = 5 * 60_000;
const ENTITY_LOCK_LEASE_MS = 2 * 60_000;
const SYSTEM_ACTOR_ID = "system:weekly-finance-automation";
const SYSTEM_TOKEN = {
  uid: SYSTEM_ACTOR_ID,
  email: "system@scraveit.local",
  savrivoRole: "owner",
} as unknown as DecodedIdToken;

interface ValueSnapshot {
  val(): unknown;
}

interface TransactionResult {
  committed: boolean;
  snapshot: ValueSnapshot;
}

interface FinanceAutomationReference {
  get(): Promise<ValueSnapshot>;
  transaction(
    update: (current: unknown) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<TransactionResult>;
}

export interface FinanceAutomationDatabase extends LedgerTransactionDatabase {
  ref(path: string): FinanceAutomationReference;
}

export type FinanceAutomationEntityType = "rider" | "restaurant";

export type FinanceAutomationItemStatus =
  | "completed"
  | "held_minimum"
  | "blocked_missing_entity"
  | "blocked_missing_coverage"
  | "blocked_invalid_balance"
  | "blocked_profile"
  | "blocked_provider";

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
    | "completed_with_blocks";
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
  };
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
  return db as unknown as FinanceAutomationDatabase;
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

function entityLockPath(entityType: FinanceAutomationEntityType, entityId: string): string {
  return entityType === "rider" ?
    `${RIDER_PAYOUT_LOCKS_ROOT}/${entityId}` :
    `${RESTAURANT_SETTLEMENT_LOCKS_ROOT}/${entityId}`;
}

function runLockPath(periodKey: string): string {
  return `${FINANCE_AUTOMATION_LOCKS_ROOT}/${periodKey}`;
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
    },
    journalIds,
    message: candidate.message as string,
  };
}

async function acquireLock(
  database: FinanceAutomationDatabase,
  path: string,
  entityId: string,
  operationKey: string,
  now: number,
  leaseMs: number,
): Promise<void> {
  let abort: DomainError | null = null;
  const result = await database.ref(path).transaction((current) => {
    abort = null;
    const existing = current == null ? null : lockRecord(current, entityId);
    if (current != null && !existing) {
      abort = new DomainError("data-loss", "A finance automation lock is invalid and needs review.");
      return undefined;
    }
    if (existing && existing.operationId !== operationKey && existing.leaseUntil > now) {
      abort = new DomainError("aborted", "A finance automation lock is busy.", {reason: "FINANCE_AUTOMATION_LOCK_BUSY"});
      return undefined;
    }
    return {
      schemaVersion: 1,
      operationId: operationKey,
      entityId,
      actorId: SYSTEM_ACTOR_ID,
      acquiredAt: now,
      leaseUntil: now + leaseMs,
    } satisfies EntityLock;
  }, undefined, false);
  if (!result.committed) throw abort ?? new DomainError("aborted", "A finance automation lock could not be acquired.");
}

async function releaseLock(
  database: FinanceAutomationDatabase,
  path: string,
  entityId: string,
  operationKey: string,
): Promise<void> {
  await database.ref(path).transaction((current) => {
    const existing = current == null ? null : lockRecord(current, entityId);
    if (!existing) return null;
    return existing.operationId === operationKey ? null : current;
  }, undefined, false);
}

function parseLedgerSnapshot(raw: unknown): {journals: readonly LedgerJournal[]; invalidJournalCount: number} {
  const container = record(raw);
  const journals: LedgerJournal[] = [];
  let invalidJournalCount = 0;
  for (const [key, value] of Object.entries(container)) {
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
  const snapshot = await database.ref(LEDGER_JOURNALS_ROOT).get();
  const parsed = parseLedgerSnapshot(snapshot.val());
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
  await database.ref(`${FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT}/${periodKey}/items/${item.itemId}`)
    .transaction((current) => ({
      ...(record(current)),
      ...item,
    }), undefined, false);
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
  await database.ref(`${ROOT}/audit/${id}`).transaction((current) => current ?? auditRecord, undefined, false);
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
  const priorItem = itemRecord(
    (await database.ref(`${FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT}/${periodKey}/items/${itemKey}`).get()).val(),
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

  await acquireLock(database, entityLockPath("rider", riderId), riderId, lockKey, attemptedAt, ENTITY_LOCK_LEASE_MS);
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
    await releaseLock(database, entityLockPath("rider", riderId), riderId, lockKey);
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
  const priorItem = itemRecord(
    (await database.ref(`${FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT}/${periodKey}/items/${itemKey}`).get()).val(),
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
    entityLockPath("restaurant", restaurantId),
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
    await releaseLock(database, entityLockPath("restaurant", restaurantId), restaurantId, lockKey);
  }
}

function summarizeItems(
  policy: FinancePolicy,
  attemptedAt: number,
  periodKey: string,
  riderMinimumPayoutPaise: number,
  items: readonly FinanceAutomationItemRecord[],
): FinanceAutomationRunSummary {
  const counts = {
    completed: 0,
    heldMinimum: 0,
    blockedMissingEntity: 0,
    blockedMissingCoverage: 0,
    blockedInvalidBalance: 0,
    blockedProfile: 0,
    blockedProvider: 0,
  };
  for (const item of items) {
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
    status: blockedCount > 0 ? "completed_with_blocks" : "completed",
    attemptedAt,
    scheduleLabel: financePayoutAutomationScheduleLabel(policy),
    nextRunDayKey: financePayoutAutomationNextRunDayKey(policy, attemptedAt),
    riderMinimumPayoutPaise,
    restaurantMinimumSettlementPaise: policy.payouts.automation.minimumRestaurantSettlementPaise,
    counts,
    journalIds: items.filter((item) => item.ledgerJournalId).map((item) => item.ledgerJournalId),
    message: blockedCount > 0 ?
      "Weekly payout automation completed with some blocked items." :
      "Weekly payout automation completed successfully.",
  };
}

export async function runWeeklyFinanceAutomation(
  referenceAt = Date.now(),
  database: FinanceAutomationDatabase = defaultDatabase(),
  gateway: FinancePayoutGateway = new UnconfiguredFinancePayoutGateway(),
  loadPolicy: (nowValue?: number) => Promise<FinancePolicy> = loadFinancePolicy,
): Promise<FinanceAutomationRunSummary> {
  const attemptedAt = Number.isSafeInteger(referenceAt) && referenceAt > 0 ? referenceAt : Date.now();
  const [policy, settingsSnapshot] = await Promise.all([
    loadPolicy(attemptedAt),
    database.ref(RIDER_REWARD_SETTINGS_ROOT).get(),
  ]);
  const riderMinimumPayoutPaise = normalizeRewardSettings(settingsSnapshot.val()).payoutMinimumPaise;
  if (!policy.payouts.automation.enabled) {
    return emptySummary(policy, attemptedAt, "disabled", "Weekly payout automation is disabled.", riderMinimumPayoutPaise);
  }
  const periodKey = financePayoutAutomationCurrentPeriodKey(policy, attemptedAt);
  if (!periodKey) {
    return emptySummary(policy, attemptedAt, "not_due", "Weekly payout automation is not due yet.", riderMinimumPayoutPaise);
  }
  const existingSummary = runSummaryRecord(
    (await database.ref(`${FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT}/${periodKey}/meta`).get()).val(),
    periodKey,
  );
  if (existingSummary) return existingSummary;

  try {
    await acquireLock(database, runLockPath(periodKey), periodKey, periodKey, attemptedAt, RUN_LOCK_LEASE_MS);
  } catch (error) {
    if (error instanceof DomainError && error.code === "aborted") {
      return emptySummary(policy, attemptedAt, "busy", "Weekly payout automation is already running.", riderMinimumPayoutPaise);
    }
    throw error;
  }

  try {
    const [balances, riderCoverageSnapshot, restaurantCoverageSnapshot, ridersSnapshot, restaurantsSnapshot] =
      await Promise.all([
        readAllLedgerBalances(database),
        database.ref(RIDER_LEDGER_COVERAGE_ROOT).get(),
        database.ref(RESTAURANT_LEDGER_COVERAGE_ROOT).get(),
        database.ref(`${ROOT}/riders`).get(),
        database.ref(`${ROOT}/catalog/restaurants`).get(),
      ]);

    if (balances.invalidJournalCount > 0) {
      const summary = emptySummary(
        policy,
        attemptedAt,
        "completed_with_blocks",
        "Weekly payout automation stopped because invalid ledger data needs finance review.",
        riderMinimumPayoutPaise,
      );
      await database.ref(`${FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT}/${periodKey}/meta`)
        .transaction(() => summary, undefined, false);
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

    const riderRecords = record(ridersSnapshot.val());
    const restaurantRecords = record(restaurantsSnapshot.val());
    const coveredRiders = riderCoverageSet(riderCoverageSnapshot.val());
    const coveredRestaurants = restaurantCoverageSet(restaurantCoverageSnapshot.val());
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
        gateway,
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
        gateway,
        database,
      );
      await upsertItemRecord(database, periodKey, item);
      items.push(item);
    }

    const summary = summarizeItems(policy, attemptedAt, periodKey, riderMinimumPayoutPaise, items);
    await database.ref(`${FINANCE_AUTOMATION_WEEKLY_RUNS_ROOT}/${periodKey}/meta`)
      .transaction(() => summary, undefined, false);
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
    await releaseLock(database, runLockPath(periodKey), periodKey, periodKey);
  }
}

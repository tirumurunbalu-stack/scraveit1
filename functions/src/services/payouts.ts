import {randomUUID} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {db} from "../admin";
import {ROOT} from "../config";
import {createLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {
  recommendedFinancePayoutMethod,
  type FinancePolicy,
  type FinancePayoutMethod,
} from "../domain/financePolicy";
import {platformConfigHash, platformConfigOperationKey} from "../domain/platformConfigControl";
import {DomainError} from "../errors";
import type {
  RecordRestaurantSettlementInput,
  RecordRiderPayoutInput,
} from "../schemas";
import {persistLedgerJournal, type LedgerTransactionDatabase} from "./ledger";
import {loadFinancePolicy} from "./platformConfig";
import {
  readRiderFinancialSummary,
  type RiderFinanceDatabase,
  type RiderFinancialSummary,
} from "./riderFinance";
import {
  buildRestaurantSettlementJournal,
  getRestaurantSettlementSummary,
  type RestaurantSettlementDatabase,
  type RestaurantSettlementMethod,
} from "./restaurantSettlements";
import {
  requirePlatformConfigAdminClaim,
  type PlatformConfigAdminRole,
} from "./authz";

type UnknownRecord = Record<string, unknown>;

const PAYOUT_LOCK_LEASE_MS = 2 * 60_000;
const RIDER_PAYOUT_OPERATIONS_ROOT = `${ROOT}/private/financeOperations/riderPayouts`;
const RIDER_PAYOUT_LOCKS_ROOT = `${ROOT}/private/financeOperations/riderPayoutLocks`;
const RESTAURANT_SETTLEMENT_OPERATIONS_ROOT = `${ROOT}/private/financeOperations/restaurantSettlements`;
const RESTAURANT_SETTLEMENT_LOCKS_ROOT = `${ROOT}/private/financeOperations/restaurantSettlementLocks`;

interface ValueSnapshot {
  val(): unknown;
}

interface TransactionResult {
  committed: boolean;
  snapshot: ValueSnapshot;
}

interface FinanceReference {
  orderByChild(child: string): FinanceReference;
  limitToLast(limit: number): FinanceReference;
  get(): Promise<ValueSnapshot>;
  transaction(
    update: (current: unknown) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<TransactionResult>;
}

export interface FinancePayoutDatabase extends LedgerTransactionDatabase, RiderFinanceDatabase, RestaurantSettlementDatabase {
  ref(path: string): FinanceReference;
}

interface FinanceEntityLock {
  schemaVersion: 1;
  operationId: string;
  requestHash: string;
  requestInstanceId: string;
  actorId: string;
  actorRole: PlatformConfigAdminRole;
  entityId: string;
  acquiredAt: number;
  leaseUntil: number;
}

interface RiderPayoutOperationRecord {
  schemaVersion: 1;
  operationId: string;
  requestHash: string;
  requestInstanceId: string;
  actorId: string;
  actorRole: PlatformConfigAdminRole;
  riderId: string;
  amountPaise: number;
  method: FinancePayoutMethod;
  referenceId: string;
  status: "registered" | "completed";
  registeredAt: number;
  completedAt?: number;
  ledgerJournalId?: string;
  paidEarningsPaise?: number;
  paidTipsPaise?: number;
  remainingPayablePaise?: number;
  recommendedMethod?: FinancePayoutMethod;
  beneficiaryLabel?: string;
}

interface RestaurantSettlementOperationRecord {
  schemaVersion: 1;
  operationId: string;
  requestHash: string;
  requestInstanceId: string;
  actorId: string;
  actorRole: PlatformConfigAdminRole;
  restaurantId: string;
  amountPaise: number;
  method: FinancePayoutMethod;
  referenceId: string;
  status: "registered" | "completed";
  registeredAt: number;
  completedAt?: number;
  ledgerJournalId?: string;
  remainingPendingSettlementPaise?: number;
  recommendedMethod?: FinancePayoutMethod;
  beneficiaryLabel?: string;
}

export interface RiderPayoutResponse {
  operationId: string;
  riderId: string;
  amountPaise: number;
  method: FinancePayoutMethod;
  recommendedMethod: FinancePayoutMethod;
  status: "completed";
  ledgerJournalId: string;
  completedAt: number;
  paidEarningsPaise: number;
  paidTipsPaise: number;
  remainingPayablePaise: number;
  beneficiaryLabel: string;
  idempotent: boolean;
}

export interface RestaurantSettlementResponse {
  operationId: string;
  restaurantId: string;
  amountPaise: number;
  method: FinancePayoutMethod;
  recommendedMethod: FinancePayoutMethod;
  status: "completed";
  ledgerJournalId: string;
  completedAt: number;
  remainingPendingSettlementPaise: number;
  beneficiaryLabel: string;
  idempotent: boolean;
}

interface RiderPayoutProfile {
  beneficiaryName: string;
  preferredMethod: FinancePayoutMethod;
  upiId: string;
  bankAccountHolderName: string;
  bankAccountNumber: string;
  bankIfsc: string;
}

interface RestaurantPayoutProfile {
  legalBusinessName: string;
  beneficiaryName: string;
  preferredMethod: FinancePayoutMethod;
  upiId: string;
  bankAccountHolderName: string;
  bankAccountNumber: string;
  bankIfsc: string;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown, maximum = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function payoutMethod(value: unknown, fallback: FinancePayoutMethod): FinancePayoutMethod {
  return value === "upi" || value === "imps" || value === "neft" ? value : fallback;
}

function safePositivePaise(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new DomainError("invalid-argument", code);
  return value;
}

function safeNonNegativePaise(value: number, reason: string, message: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("failed-precondition", message, {reason});
  }
  return value;
}

function safeId(value: string, code: string, maximum = 128): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(normalized)) {
    throw new DomainError("invalid-argument", code);
  }
  return normalized;
}

function requestHash(value: unknown): string {
  return platformConfigHash(value);
}

function riderPayoutOperationPath(operationKey: string): string {
  return `${RIDER_PAYOUT_OPERATIONS_ROOT}/${operationKey}`;
}

function riderPayoutLockPath(riderId: string): string {
  return `${RIDER_PAYOUT_LOCKS_ROOT}/${riderId}`;
}

function restaurantSettlementOperationPath(operationKey: string): string {
  return `${RESTAURANT_SETTLEMENT_OPERATIONS_ROOT}/${operationKey}`;
}

function restaurantSettlementLockPath(restaurantId: string): string {
  return `${RESTAURANT_SETTLEMENT_LOCKS_ROOT}/${restaurantId}`;
}

function financeLock(raw: unknown, entityId: string): FinanceEntityLock | null {
  const candidate = record(raw);
  if (!Object.keys(candidate).length) return null;
  if (candidate.schemaVersion !== 1 || typeof candidate.operationId !== "string" ||
      typeof candidate.requestHash !== "string" || typeof candidate.requestInstanceId !== "string" ||
      typeof candidate.actorId !== "string" ||
      (candidate.actorRole !== "owner" && candidate.actorRole !== "ops_admin") ||
      typeof candidate.entityId !== "string" || candidate.entityId !== entityId ||
      !Number.isSafeInteger(candidate.acquiredAt) || !Number.isSafeInteger(candidate.leaseUntil)) {
    return null;
  }
  return candidate as unknown as FinanceEntityLock;
}

function riderPayoutOperation(raw: unknown): RiderPayoutOperationRecord | null {
  const candidate = record(raw);
  if (!Object.keys(candidate).length) return null;
  if (candidate.schemaVersion !== 1 || typeof candidate.operationId !== "string" ||
      typeof candidate.requestHash !== "string" || typeof candidate.requestInstanceId !== "string" ||
      typeof candidate.actorId !== "string" ||
      (candidate.actorRole !== "owner" && candidate.actorRole !== "ops_admin") ||
      typeof candidate.riderId !== "string" || !Number.isSafeInteger(candidate.amountPaise) ||
      (candidate.method !== "upi" && candidate.method !== "imps" && candidate.method !== "neft") ||
      typeof candidate.referenceId !== "string" ||
      (candidate.status !== "registered" && candidate.status !== "completed") ||
      !Number.isSafeInteger(candidate.registeredAt)) {
    return null;
  }
  if (candidate.completedAt !== undefined && !Number.isSafeInteger(candidate.completedAt)) return null;
  if (candidate.ledgerJournalId !== undefined && typeof candidate.ledgerJournalId !== "string") return null;
  if (candidate.paidEarningsPaise !== undefined && !Number.isSafeInteger(candidate.paidEarningsPaise)) return null;
  if (candidate.paidTipsPaise !== undefined && !Number.isSafeInteger(candidate.paidTipsPaise)) return null;
  if (candidate.remainingPayablePaise !== undefined && !Number.isSafeInteger(candidate.remainingPayablePaise)) {
    return null;
  }
  if (candidate.recommendedMethod !== undefined &&
      candidate.recommendedMethod !== "upi" &&
      candidate.recommendedMethod !== "imps" &&
      candidate.recommendedMethod !== "neft") {
    return null;
  }
  if (candidate.beneficiaryLabel !== undefined && typeof candidate.beneficiaryLabel !== "string") return null;
  return candidate as unknown as RiderPayoutOperationRecord;
}

function restaurantSettlementOperation(raw: unknown): RestaurantSettlementOperationRecord | null {
  const candidate = record(raw);
  if (!Object.keys(candidate).length) return null;
  if (candidate.schemaVersion !== 1 || typeof candidate.operationId !== "string" ||
      typeof candidate.requestHash !== "string" || typeof candidate.requestInstanceId !== "string" ||
      typeof candidate.actorId !== "string" ||
      (candidate.actorRole !== "owner" && candidate.actorRole !== "ops_admin") ||
      typeof candidate.restaurantId !== "string" || !Number.isSafeInteger(candidate.amountPaise) ||
      (candidate.method !== "upi" && candidate.method !== "imps" && candidate.method !== "neft") ||
      typeof candidate.referenceId !== "string" ||
      (candidate.status !== "registered" && candidate.status !== "completed") ||
      !Number.isSafeInteger(candidate.registeredAt)) {
    return null;
  }
  if (candidate.completedAt !== undefined && !Number.isSafeInteger(candidate.completedAt)) return null;
  if (candidate.ledgerJournalId !== undefined && typeof candidate.ledgerJournalId !== "string") return null;
  if (candidate.remainingPendingSettlementPaise !== undefined &&
      !Number.isSafeInteger(candidate.remainingPendingSettlementPaise)) {
    return null;
  }
  if (candidate.recommendedMethod !== undefined &&
      candidate.recommendedMethod !== "upi" &&
      candidate.recommendedMethod !== "imps" &&
      candidate.recommendedMethod !== "neft") {
    return null;
  }
  if (candidate.beneficiaryLabel !== undefined && typeof candidate.beneficiaryLabel !== "string") return null;
  return candidate as unknown as RestaurantSettlementOperationRecord;
}

function sameEntityOperation(
  operation: Pick<FinanceEntityLock, "operationId" | "requestHash" | "actorId">,
  operationId: string,
  hash: string,
  actorId: string,
): boolean {
  return operation.operationId === operationId &&
    operation.requestHash === hash &&
    operation.actorId === actorId;
}

function sameRiderPayout(
  operation: Pick<RiderPayoutOperationRecord, "operationId" | "requestHash" | "actorId" | "riderId">,
  input: RecordRiderPayoutInput,
  hash: string,
  actorId: string,
): boolean {
  return operation.operationId === input.operationId &&
    operation.requestHash === hash &&
    operation.actorId === actorId &&
    operation.riderId === input.riderId;
}

function sameRestaurantSettlement(
  operation: Pick<RestaurantSettlementOperationRecord, "operationId" | "requestHash" | "actorId" | "restaurantId">,
  input: RecordRestaurantSettlementInput,
  hash: string,
  actorId: string,
): boolean {
  return operation.operationId === input.operationId &&
    operation.requestHash === hash &&
    operation.actorId === actorId &&
    operation.restaurantId === input.restaurantId;
}

async function acquireEntityLock(
  database: FinancePayoutDatabase,
  path: string,
  entityId: string,
  operationId: string,
  hash: string,
  actorId: string,
  actorRole: PlatformConfigAdminRole,
  requestInstanceId: string,
  now: number,
  busyMessage: string,
): Promise<FinanceEntityLock> {
  let abort: DomainError | null = null;
  const result = await database.ref(path).transaction((rawLock) => {
    abort = null;
    if (rawLock !== null && rawLock !== undefined) {
      const existing = financeLock(rawLock, entityId);
      if (!existing) {
        abort = new DomainError("data-loss", "An in-flight payout lock is invalid and needs finance review.");
        return undefined;
      }
      const sameOperation = sameEntityOperation(existing, operationId, hash, actorId);
      if (!sameOperation && existing.leaseUntil > now) {
        abort = new DomainError("aborted", busyMessage, {reason: "FINANCE_PAYOUT_LOCK_BUSY"});
        return undefined;
      }
    }
    const lock: FinanceEntityLock = {
      schemaVersion: 1,
      operationId,
      requestHash: hash,
      requestInstanceId,
      actorId,
      actorRole,
      entityId,
      acquiredAt: now,
      leaseUntil: now + PAYOUT_LOCK_LEASE_MS,
    };
    return lock;
  }, undefined, false);
  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "The payout lock could not be acquired safely.");
  }
  const lock = financeLock(result.snapshot.val(), entityId);
  if (!lock || !sameEntityOperation(lock, operationId, hash, actorId)) {
    throw new DomainError("internal", "The payout lock could not be verified.");
  }
  return lock;
}

async function releaseEntityLock(
  database: FinancePayoutDatabase,
  path: string,
  entityId: string,
  operationId: string,
  hash: string,
  actorId: string,
): Promise<void> {
  await database.ref(path).transaction((rawLock) => {
    if (rawLock === null || rawLock === undefined) return rawLock;
    const existing = financeLock(rawLock, entityId);
    if (!existing) return null;
    return sameEntityOperation(existing, operationId, hash, actorId) ? null : rawLock;
  }, undefined, false);
}

function riderPayoutProfile(value: unknown): RiderPayoutProfile {
  const source = record(value);
  return {
    beneficiaryName: text(source.beneficiaryName || source.legalName, 160),
    preferredMethod: payoutMethod(source.preferredMethod, "upi"),
    upiId: text(source.upiId, 120),
    bankAccountHolderName: text(source.bankAccountHolderName, 120),
    bankAccountNumber: text(source.bankAccountNumber, 40),
    bankIfsc: text(source.bankIfsc, 20).toUpperCase(),
  };
}

function restaurantPayoutProfile(value: unknown): RestaurantPayoutProfile {
  const source = record(value);
  return {
    legalBusinessName: text(source.legalBusinessName || source.legalName, 160),
    beneficiaryName: text(source.beneficiaryName, 160),
    preferredMethod: payoutMethod(source.preferredMethod, "neft"),
    upiId: text(source.upiId, 120),
    bankAccountHolderName: text(source.bankAccountHolderName, 120),
    bankAccountNumber: text(source.bankAccountNumber, 40),
    bankIfsc: text(source.bankIfsc, 20).toUpperCase(),
  };
}

function profileHasUpi(profile: Pick<RiderPayoutProfile | RestaurantPayoutProfile, "upiId">): boolean {
  return /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/.test(profile.upiId);
}

function profileHasBank(profile: Pick<RiderPayoutProfile | RestaurantPayoutProfile, "bankAccountHolderName" | "bankAccountNumber" | "bankIfsc">): boolean {
  return !!profile.bankAccountHolderName &&
    /^[0-9]{6,20}$/.test(profile.bankAccountNumber) &&
    /^[A-Z]{4}0[A-Z0-9]{6}$/.test(profile.bankIfsc);
}

function validatePayoutMethod(
  policy: FinancePolicy,
  method: FinancePayoutMethod,
  amountPaise: number,
): FinancePayoutMethod {
  if (method === "upi" && !policy.payouts.upiEnabled) {
    throw new DomainError("failed-precondition", "UPI payouts are disabled in secure platform controls.", {
      reason: "PAYOUT_METHOD_DISABLED",
      method,
    });
  }
  if (method === "imps" && !policy.payouts.impsEnabled) {
    throw new DomainError("failed-precondition", "IMPS payouts are disabled in secure platform controls.", {
      reason: "PAYOUT_METHOD_DISABLED",
      method,
    });
  }
  if (method === "neft" && !policy.payouts.neftEnabled) {
    throw new DomainError("failed-precondition", "NEFT payouts are disabled in secure platform controls.", {
      reason: "PAYOUT_METHOD_DISABLED",
      method,
    });
  }
  const recommendedMethod = recommendedFinancePayoutMethod(policy, amountPaise);
  if (method === "upi" && amountPaise > policy.payouts.upiPreferredMaximumPaise) {
    throw new DomainError(
      "failed-precondition",
      "This payout exceeds the UPI threshold. Use IMPS or NEFT for the verified release.",
      {
        reason: "PAYOUT_HIGH_VALUE_UPI_BLOCKED",
        recommendedMethod,
      },
    );
  }
  return recommendedMethod;
}

function validateRiderBeneficiary(
  profile: RiderPayoutProfile,
  riderLabel: string,
  method: FinancePayoutMethod,
): string {
  const label = profile.beneficiaryName || riderLabel;
  if (method === "upi" && !profileHasUpi(profile)) {
    throw new DomainError(
      "failed-precondition",
      "The rider payout profile is missing a valid UPI ID for this settlement.",
      {reason: "RIDER_PAYOUT_UPI_PROFILE_INCOMPLETE"},
    );
  }
  if (method !== "upi" && !profileHasBank(profile)) {
    throw new DomainError(
      "failed-precondition",
      "The rider payout profile is missing verified bank details for this settlement.",
      {reason: "RIDER_PAYOUT_BANK_PROFILE_INCOMPLETE"},
    );
  }
  return label;
}

function validateRestaurantBeneficiary(
  profile: RestaurantPayoutProfile,
  restaurantLabel: string,
  method: FinancePayoutMethod,
): string {
  const label = profile.legalBusinessName || profile.beneficiaryName || restaurantLabel;
  if (method === "upi" && !profileHasUpi(profile)) {
    throw new DomainError(
      "failed-precondition",
      "The restaurant settlement profile is missing a valid UPI ID for this release.",
      {reason: "RESTAURANT_SETTLEMENT_UPI_PROFILE_INCOMPLETE"},
    );
  }
  if (method !== "upi" && !profileHasBank(profile)) {
    throw new DomainError(
      "failed-precondition",
      "The restaurant settlement profile is missing verified bank details for this release.",
      {reason: "RESTAURANT_SETTLEMENT_BANK_PROFILE_INCOMPLETE"},
    );
  }
  return label;
}

function authoritativeRiderPayable(summary: RiderFinancialSummary): {
  totalPaise: number;
  earningsOutstandingPaise: number;
  tipsOutstandingPaise: number;
} {
  if (!summary.complete || summary.payableEarningsPaise === null) {
    throw new DomainError(
      "failed-precondition",
      "The rider payable balance is not authoritative yet. Refresh after finance reconciliation completes.",
      {reason: "RIDER_PAYOUT_RECONCILIATION_REQUIRED"},
    );
  }
  const earningsOutstandingPaise = safeNonNegativePaise(
    summary.window.earningsCreditedPaise - summary.window.earningsSettledOrAdjustedPaise,
    "RIDER_PAYOUT_EARNINGS_NEGATIVE",
    "The rider earnings balance requires finance review before payout.",
  );
  const tipsOutstandingPaise = safeNonNegativePaise(
    summary.window.tipsCreditedPaise - summary.window.tipsSettledOrAdjustedPaise,
    "RIDER_PAYOUT_TIPS_NEGATIVE",
    "The rider tips balance requires finance review before payout.",
  );
  const totalPaise = safeNonNegativePaise(
    summary.payableEarningsPaise,
    "RIDER_PAYOUT_TOTAL_NEGATIVE",
    "The rider payable balance requires finance review before payout.",
  );
  if (earningsOutstandingPaise + tipsOutstandingPaise !== totalPaise) {
    throw new DomainError(
      "failed-precondition",
      "The rider payable breakdown is inconsistent and needs finance review.",
      {reason: "RIDER_PAYOUT_COMPONENT_MISMATCH"},
    );
  }
  return {totalPaise, earningsOutstandingPaise, tipsOutstandingPaise};
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
  recommendedMethod: FinancePayoutMethod;
}): LedgerJournal {
  const riderId = safeId(input.riderId, "RIDER_PAYOUT_INVALID_RIDER_ID");
  const payoutId = safeId(input.payoutId, "RIDER_PAYOUT_INVALID_ID");
  const actorId = safeId(input.actorId, "RIDER_PAYOUT_INVALID_ACTOR_ID");
  const referenceId = safeId(input.referenceId, "RIDER_PAYOUT_INVALID_REFERENCE_ID");
  const amountPaise = safePositivePaise(input.amountPaise, "RIDER_PAYOUT_INVALID_AMOUNT");
  const paidEarningsPaise = safeNonNegativePaise(
    input.paidEarningsPaise,
    "RIDER_PAYOUT_EARNINGS_INVALID",
    "The rider payout breakdown is invalid.",
  );
  const paidTipsPaise = safeNonNegativePaise(
    input.paidTipsPaise,
    "RIDER_PAYOUT_TIPS_INVALID",
    "The rider payout breakdown is invalid.",
  );
  if (paidEarningsPaise + paidTipsPaise !== amountPaise) {
    throw new DomainError("invalid-argument", "Rider payout amount does not match its ledger breakdown.");
  }
  const postings = [];
  if (paidEarningsPaise > 0) {
    postings.push({
      accountId: `liability:rider-earnings:${riderId}`,
      side: "debit" as const,
      amountPaise: paidEarningsPaise,
      memo: "Rider earnings settled",
    });
  }
  if (paidTipsPaise > 0) {
    postings.push({
      accountId: `liability:rider-tips:${riderId}`,
      side: "debit" as const,
      amountPaise: paidTipsPaise,
      memo: "Rider tips settled",
    });
  }
  postings.push({
    accountId: "asset:rider-payout-clearing",
    side: "credit" as const,
    amountPaise,
    memo: "Rider payout released",
  });
  return createLedgerJournal({
    eventType: "rider_payout",
    eventId: `payout:${payoutId}`,
    occurredAt: input.occurredAt,
    actorId,
    metadata: {
      riderId,
      payoutMethod: input.method,
      referenceId,
      recommendedMethod: input.recommendedMethod,
      earningsSettledPaise: paidEarningsPaise,
      tipsSettledPaise: paidTipsPaise,
      allocationStrategy: "earnings_first",
    },
    postings,
  });
}

function riderPayoutResponse(operation: RiderPayoutOperationRecord, idempotent: boolean): RiderPayoutResponse {
  if (operation.status !== "completed" || !operation.ledgerJournalId || !Number.isSafeInteger(operation.completedAt) ||
      !Number.isSafeInteger(operation.paidEarningsPaise) || !Number.isSafeInteger(operation.paidTipsPaise) ||
      !Number.isSafeInteger(operation.remainingPayablePaise) || !operation.recommendedMethod ||
      !operation.beneficiaryLabel) {
    throw new DomainError("data-loss", "The rider payout operation is incomplete and needs finance review.");
  }
  const completedAt = operation.completedAt as number;
  const paidEarningsPaise = operation.paidEarningsPaise as number;
  const paidTipsPaise = operation.paidTipsPaise as number;
  const remainingPayablePaise = operation.remainingPayablePaise as number;
  return {
    operationId: operation.operationId,
    riderId: operation.riderId,
    amountPaise: operation.amountPaise,
    method: operation.method,
    recommendedMethod: operation.recommendedMethod,
    status: "completed",
    ledgerJournalId: operation.ledgerJournalId,
    completedAt,
    paidEarningsPaise,
    paidTipsPaise,
    remainingPayablePaise,
    beneficiaryLabel: operation.beneficiaryLabel,
    idempotent,
  };
}

function restaurantSettlementResponse(
  operation: RestaurantSettlementOperationRecord,
  idempotent: boolean,
): RestaurantSettlementResponse {
  if (operation.status !== "completed" || !operation.ledgerJournalId || !Number.isSafeInteger(operation.completedAt) ||
      !Number.isSafeInteger(operation.remainingPendingSettlementPaise) || !operation.recommendedMethod ||
      !operation.beneficiaryLabel) {
    throw new DomainError("data-loss", "The restaurant settlement operation is incomplete and needs finance review.");
  }
  const completedAt = operation.completedAt as number;
  const remainingPendingSettlementPaise = operation.remainingPendingSettlementPaise as number;
  return {
    operationId: operation.operationId,
    restaurantId: operation.restaurantId,
    amountPaise: operation.amountPaise,
    method: operation.method,
    recommendedMethod: operation.recommendedMethod,
    status: "completed",
    ledgerJournalId: operation.ledgerJournalId,
    completedAt,
    remainingPendingSettlementPaise,
    beneficiaryLabel: operation.beneficiaryLabel,
    idempotent,
  };
}

async function registerRiderPayoutOperation(
  database: FinancePayoutDatabase,
  input: RecordRiderPayoutInput,
  actorId: string,
  actorRole: PlatformConfigAdminRole,
  hash: string,
  operationKey: string,
  requestInstanceId: string,
  now: number,
): Promise<RiderPayoutOperationRecord> {
  let abort: DomainError | null = null;
  const path = riderPayoutOperationPath(operationKey);
  const result = await database.ref(path).transaction((rawOperation) => {
    abort = null;
    if (rawOperation !== null && rawOperation !== undefined) {
      const existing = riderPayoutOperation(rawOperation);
      if (!existing) {
        abort = new DomainError("data-loss", "The rider payout operation record is invalid.", {
          reason: "RIDER_PAYOUT_OPERATION_INVALID",
        });
        return undefined;
      }
      if (!sameRiderPayout(existing, input, hash, actorId)) {
        abort = new DomainError("already-exists", "Operation id was already used for a different rider payout.", {
          reason: "RIDER_PAYOUT_OPERATION_CONFLICT",
        });
        return undefined;
      }
      return existing;
    }
    const operation: RiderPayoutOperationRecord = {
      schemaVersion: 1,
      operationId: input.operationId,
      requestHash: hash,
      requestInstanceId,
      actorId,
      actorRole,
      riderId: input.riderId,
      amountPaise: input.amountPaise,
      method: input.method,
      referenceId: input.referenceId,
      status: "registered",
      registeredAt: now,
    };
    return operation;
  }, undefined, false);
  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "The rider payout could not be registered safely.");
  }
  const operation = riderPayoutOperation(result.snapshot.val());
  if (!operation || !sameRiderPayout(operation, input, hash, actorId)) {
    throw new DomainError("internal", "The rider payout registration could not be verified.");
  }
  return operation;
}

async function completeRiderPayoutOperation(
  database: FinancePayoutDatabase,
  input: RecordRiderPayoutInput,
  actorId: string,
  hash: string,
  operationKey: string,
  completed: Omit<RiderPayoutOperationRecord, "schemaVersion" | "operationId" | "requestHash" | "requestInstanceId" | "actorId" | "actorRole" | "riderId" | "amountPaise" | "method" | "referenceId" | "status" | "registeredAt">,
): Promise<RiderPayoutOperationRecord> {
  let abort: DomainError | null = null;
  const path = riderPayoutOperationPath(operationKey);
  const result = await database.ref(path).transaction((rawOperation) => {
    abort = null;
    const existing = riderPayoutOperation(rawOperation);
    if (!existing) {
      abort = new DomainError("not-found", "The rider payout operation record was not found.");
      return undefined;
    }
    if (!sameRiderPayout(existing, input, hash, actorId)) {
      abort = new DomainError("already-exists", "Operation id was already used for a different rider payout.");
      return undefined;
    }
    if (existing.status === "completed") return existing;
    return {
      ...existing,
      status: "completed" as const,
      completedAt: completed.completedAt,
      ledgerJournalId: completed.ledgerJournalId,
      paidEarningsPaise: completed.paidEarningsPaise,
      paidTipsPaise: completed.paidTipsPaise,
      remainingPayablePaise: completed.remainingPayablePaise,
      recommendedMethod: completed.recommendedMethod,
      beneficiaryLabel: completed.beneficiaryLabel,
    };
  }, undefined, false);
  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "The rider payout completion could not be committed safely.");
  }
  const operation = riderPayoutOperation(result.snapshot.val());
  if (!operation || operation.status !== "completed") {
    throw new DomainError("internal", "The rider payout completion could not be verified.");
  }
  return operation;
}

async function registerRestaurantSettlementOperation(
  database: FinancePayoutDatabase,
  input: RecordRestaurantSettlementInput,
  actorId: string,
  actorRole: PlatformConfigAdminRole,
  hash: string,
  operationKey: string,
  requestInstanceId: string,
  now: number,
): Promise<RestaurantSettlementOperationRecord> {
  let abort: DomainError | null = null;
  const path = restaurantSettlementOperationPath(operationKey);
  const result = await database.ref(path).transaction((rawOperation) => {
    abort = null;
    if (rawOperation !== null && rawOperation !== undefined) {
      const existing = restaurantSettlementOperation(rawOperation);
      if (!existing) {
        abort = new DomainError("data-loss", "The restaurant settlement operation record is invalid.", {
          reason: "RESTAURANT_SETTLEMENT_OPERATION_INVALID",
        });
        return undefined;
      }
      if (!sameRestaurantSettlement(existing, input, hash, actorId)) {
        abort = new DomainError(
          "already-exists",
          "Operation id was already used for a different restaurant settlement.",
          {reason: "RESTAURANT_SETTLEMENT_OPERATION_CONFLICT"},
        );
        return undefined;
      }
      return existing;
    }
    const operation: RestaurantSettlementOperationRecord = {
      schemaVersion: 1,
      operationId: input.operationId,
      requestHash: hash,
      requestInstanceId,
      actorId,
      actorRole,
      restaurantId: input.restaurantId,
      amountPaise: input.amountPaise,
      method: input.method,
      referenceId: input.referenceId,
      status: "registered",
      registeredAt: now,
    };
    return operation;
  }, undefined, false);
  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "The restaurant settlement could not be registered safely.");
  }
  const operation = restaurantSettlementOperation(result.snapshot.val());
  if (!operation || !sameRestaurantSettlement(operation, input, hash, actorId)) {
    throw new DomainError("internal", "The restaurant settlement registration could not be verified.");
  }
  return operation;
}

async function completeRestaurantSettlementOperation(
  database: FinancePayoutDatabase,
  input: RecordRestaurantSettlementInput,
  actorId: string,
  hash: string,
  operationKey: string,
  completed: Omit<
    RestaurantSettlementOperationRecord,
    "schemaVersion" | "operationId" | "requestHash" | "requestInstanceId" | "actorId" |
    "actorRole" | "restaurantId" | "amountPaise" | "method" | "referenceId" | "status" | "registeredAt"
  >,
): Promise<RestaurantSettlementOperationRecord> {
  let abort: DomainError | null = null;
  const path = restaurantSettlementOperationPath(operationKey);
  const result = await database.ref(path).transaction((rawOperation) => {
    abort = null;
    const existing = restaurantSettlementOperation(rawOperation);
    if (!existing) {
      abort = new DomainError("not-found", "The restaurant settlement operation record was not found.");
      return undefined;
    }
    if (!sameRestaurantSettlement(existing, input, hash, actorId)) {
      abort = new DomainError(
        "already-exists",
        "Operation id was already used for a different restaurant settlement.",
      );
      return undefined;
    }
    if (existing.status === "completed") return existing;
    return {
      ...existing,
      status: "completed" as const,
      completedAt: completed.completedAt,
      ledgerJournalId: completed.ledgerJournalId,
      remainingPendingSettlementPaise: completed.remainingPendingSettlementPaise,
      recommendedMethod: completed.recommendedMethod,
      beneficiaryLabel: completed.beneficiaryLabel,
    };
  }, undefined, false);
  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "The restaurant settlement completion could not be committed safely.");
  }
  const operation = restaurantSettlementOperation(result.snapshot.val());
  if (!operation || operation.status !== "completed") {
    throw new DomainError("internal", "The restaurant settlement completion could not be verified.");
  }
  return operation;
}

async function loadRiderRecord(database: FinancePayoutDatabase, riderId: string): Promise<UnknownRecord> {
  const snapshot = await database.ref(`${ROOT}/riders/${riderId}`).get();
  const rider = record(snapshot.val());
  if (!Object.keys(rider).length) {
    throw new DomainError("not-found", "The rider account could not be found for payout.");
  }
  return rider;
}

async function loadRestaurantRecord(database: FinancePayoutDatabase, restaurantId: string): Promise<UnknownRecord> {
  const snapshot = await database.ref(`${ROOT}/catalog/restaurants/${restaurantId}`).get();
  const restaurant = record(snapshot.val());
  if (!Object.keys(restaurant).length) {
    throw new DomainError("not-found", "The restaurant record could not be found for settlement.");
  }
  return restaurant;
}

export async function recordRiderPayout(
  actorId: string,
  token: DecodedIdToken,
  input: RecordRiderPayoutInput,
  database: FinancePayoutDatabase = db as unknown as FinancePayoutDatabase,
  now = Date.now(),
  loadPolicy: (nowValue?: number) => Promise<FinancePolicy> = loadFinancePolicy,
): Promise<RiderPayoutResponse> {
  const actorRole = requirePlatformConfigAdminClaim(token);
  const riderId = safeId(input.riderId, "The rider id is invalid.");
  const amountPaise = safePositivePaise(input.amountPaise, "The rider payout amount is invalid.");
  const operationId = safeId(input.operationId, "The rider payout operation id is invalid.");
  const referenceId = safeId(input.referenceId, "The rider payout reference is invalid.");
  const hash = requestHash({operationId, riderId, amountPaise, method: input.method, referenceId});
  const operationKey = platformConfigOperationKey(operationId);
  const requestInstanceId = randomUUID();
  const operation = await registerRiderPayoutOperation(
    database,
    {...input, riderId, amountPaise, operationId, referenceId},
    actorId,
    actorRole,
    hash,
    operationKey,
    requestInstanceId,
    now,
  );
  if (operation.status === "completed") return riderPayoutResponse(operation, true);

  await acquireEntityLock(
    database,
    riderPayoutLockPath(riderId),
    riderId,
    operationId,
    hash,
    actorId,
    actorRole,
    requestInstanceId,
    now,
    "Another rider payout is already in progress for this delivery partner.",
  );

  try {
    const [policy, riderRecord, summary] = await Promise.all([
      loadPolicy(now),
      loadRiderRecord(database, riderId),
      readRiderFinancialSummary(actorId, token, {riderId, ledgerLimit: 250, historyLimit: 50}, database),
    ]);
    const riderLabel = text(riderRecord.fullName || riderRecord.name, 160) || riderId;
    const profile = riderPayoutProfile(riderRecord.payoutProfile);
    const recommendedMethod = validatePayoutMethod(policy, input.method, amountPaise);
    const beneficiaryLabel = validateRiderBeneficiary(profile, riderLabel, input.method);
    const payable = authoritativeRiderPayable(summary);
    if (amountPaise > payable.totalPaise) {
      throw new DomainError(
        "failed-precondition",
        "The requested payout exceeds the rider's authoritative payable balance.",
        {
          reason: "RIDER_PAYOUT_EXCEEDS_AVAILABLE",
          availablePaise: payable.totalPaise,
        },
      );
    }
    const paidEarningsPaise = Math.min(amountPaise, payable.earningsOutstandingPaise);
    const paidTipsPaise = amountPaise - paidEarningsPaise;
    const journal = buildRiderPayoutJournal({
      payoutId: operationId,
      riderId,
      amountPaise,
      paidEarningsPaise,
      paidTipsPaise,
      occurredAt: now,
      actorId,
      method: input.method,
      referenceId,
      recommendedMethod,
    });
    const persisted = await persistLedgerJournal(journal, database);
    const completed = await completeRiderPayoutOperation(
      database,
      {...input, riderId, amountPaise, operationId, referenceId},
      actorId,
      hash,
      operationKey,
      {
        completedAt: now,
        ledgerJournalId: persisted.journal.journalId,
        paidEarningsPaise,
        paidTipsPaise,
        remainingPayablePaise: payable.totalPaise - amountPaise,
        recommendedMethod,
        beneficiaryLabel,
      },
    );
    const auditId = `rider-payout-${operationKey.slice(0, 40)}`;
    const auditRecord = {
      id: auditId,
      action: "rider_finance.payout_recorded",
      target: `riders/${riderId}`.slice(0, 200),
      detail: `${input.method}; ${amountPaise} paise; ref ${referenceId}`.slice(0, 500),
      actorId,
      actorEmail: text(token.email, 254),
      actorRole,
      at: completed.completedAt ?? now,
    };
    await database.ref(`${ROOT}/audit/${auditId}`).transaction((current) => current ?? auditRecord, undefined, false);
    return riderPayoutResponse(
      completed,
      operation.requestInstanceId !== requestInstanceId || persisted.outcome === "idempotent",
    );
  } finally {
    await releaseEntityLock(database, riderPayoutLockPath(riderId), riderId, operationId, hash, actorId);
  }
}

export async function recordRestaurantSettlement(
  actorId: string,
  token: DecodedIdToken,
  input: RecordRestaurantSettlementInput,
  database: FinancePayoutDatabase = db as unknown as FinancePayoutDatabase,
  now = Date.now(),
  loadPolicy: (nowValue?: number) => Promise<FinancePolicy> = loadFinancePolicy,
): Promise<RestaurantSettlementResponse> {
  const actorRole = requirePlatformConfigAdminClaim(token);
  const restaurantId = safeId(input.restaurantId, "The restaurant id is invalid.");
  const amountPaise = safePositivePaise(input.amountPaise, "The restaurant settlement amount is invalid.");
  const operationId = safeId(input.operationId, "The restaurant settlement operation id is invalid.");
  const referenceId = safeId(input.referenceId, "The restaurant settlement reference is invalid.");
  const hash = requestHash({operationId, restaurantId, amountPaise, method: input.method, referenceId});
  const operationKey = platformConfigOperationKey(operationId);
  const requestInstanceId = randomUUID();
  const operation = await registerRestaurantSettlementOperation(
    database,
    {...input, restaurantId, amountPaise, operationId, referenceId},
    actorId,
    actorRole,
    hash,
    operationKey,
    requestInstanceId,
    now,
  );
  if (operation.status === "completed") return restaurantSettlementResponse(operation, true);

  await acquireEntityLock(
    database,
    restaurantSettlementLockPath(restaurantId),
    restaurantId,
    operationId,
    hash,
    actorId,
    actorRole,
    requestInstanceId,
    now,
    "Another restaurant settlement is already in progress for this outlet.",
  );

  try {
    const [policy, restaurantRecord, summary] = await Promise.all([
      loadPolicy(now),
      loadRestaurantRecord(database, restaurantId),
      getRestaurantSettlementSummary(actorId, token, {restaurantId, ledgerLimit: 1_000, historyLimit: 50}, database),
    ]);
    if (!summary.complete || summary.pendingSettlementPaise === null) {
      throw new DomainError(
        "failed-precondition",
        "The restaurant settlement balance is not authoritative yet. Refresh after finance reconciliation completes.",
        {reason: "RESTAURANT_SETTLEMENT_RECONCILIATION_REQUIRED"},
      );
    }
    const recommendedMethod = validatePayoutMethod(policy, input.method, amountPaise);
    const restaurantLabel = text(restaurantRecord.name, 160) || restaurantId;
    const profile = restaurantPayoutProfile(restaurantRecord.payoutProfile);
    const beneficiaryLabel = validateRestaurantBeneficiary(profile, restaurantLabel, input.method);
    if (amountPaise > summary.pendingSettlementPaise) {
      throw new DomainError(
        "failed-precondition",
        "The requested settlement exceeds the restaurant's authoritative pending payable balance.",
        {
          reason: "RESTAURANT_SETTLEMENT_EXCEEDS_AVAILABLE",
          availablePaise: summary.pendingSettlementPaise,
        },
      );
    }
    const journal = buildRestaurantSettlementJournal({
      settlementId: operationId,
      restaurantId,
      amountPaise,
      occurredAt: now,
      actorId,
      method: input.method as RestaurantSettlementMethod,
      referenceId,
    });
    const persisted = await persistLedgerJournal(journal, database);
    const completed = await completeRestaurantSettlementOperation(
      database,
      {...input, restaurantId, amountPaise, operationId, referenceId},
      actorId,
      hash,
      operationKey,
      {
        completedAt: now,
        ledgerJournalId: persisted.journal.journalId,
        remainingPendingSettlementPaise: summary.pendingSettlementPaise - amountPaise,
        recommendedMethod,
        beneficiaryLabel,
      },
    );
    const auditId = `restaurant-settlement-${operationKey.slice(0, 40)}`;
    const auditRecord = {
      id: auditId,
      action: "restaurant_finance.settlement_recorded",
      target: `catalog/restaurants/${restaurantId}`.slice(0, 200),
      detail: `${input.method}; ${amountPaise} paise; ref ${referenceId}`.slice(0, 500),
      actorId,
      actorEmail: text(token.email, 254),
      actorRole,
      at: completed.completedAt ?? now,
    };
    await database.ref(`${ROOT}/audit/${auditId}`).transaction((current) => current ?? auditRecord, undefined, false);
    return restaurantSettlementResponse(
      completed,
      operation.requestInstanceId !== requestInstanceId || persisted.outcome === "idempotent",
    );
  } finally {
    await releaseEntityLock(
      database,
      restaurantSettlementLockPath(restaurantId),
      restaurantId,
      operationId,
      hash,
      actorId,
    );
  }
}

import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
import {financePayoutAutomationSummary} from "../domain/financePolicy";
import {createLedgerJournal, validateLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {
  summarizeRestaurantSettlement,
  type RestaurantSettlementSummary,
} from "../domain/restaurantSettlement";
import {
  isActiveMembershipForRestaurant,
  type RestaurantMembership,
} from "../domain/restaurantAccess";
import {DomainError} from "../errors";
import {LEDGER_JOURNALS_ROOT} from "./ledger";
import {loadFinancePolicy} from "./platformConfig";

export const RESTAURANT_SETTLEMENT_DEFAULT_LEDGER_LIMIT = 1_000;
export const RESTAURANT_SETTLEMENT_MAX_LEDGER_LIMIT = 2_000;
export const RESTAURANT_SETTLEMENT_DEFAULT_HISTORY_LIMIT = 50;
export const RESTAURANT_SETTLEMENT_MAX_HISTORY_LIMIT = 100;
export const RESTAURANT_LEDGER_COVERAGE_ROOT = `${ROOT}/private/financialLedger/coverage/restaurants`;

export interface RestaurantSettlementQueryInput {
  restaurantId: string;
  ledgerLimit?: number;
  historyLimit?: number;
}

interface Snapshot {
  val(): unknown;
}

interface SettlementReference {
  orderByChild(child: string): SettlementReference;
  limitToLast(limit: number): SettlementReference;
  get(): Promise<Snapshot>;
}

export interface RestaurantSettlementDatabase {
  ref(path: string): SettlementReference;
}

export type RestaurantSettlementMethod = "bank_transfer" | "upi" | "imps" | "neft";

export interface RestaurantSettlementJournalInput {
  settlementId: string;
  restaurantId: string;
  amountPaise: number;
  occurredAt: number;
  actorId: string;
  method: RestaurantSettlementMethod;
  referenceId: string;
}

export interface RestaurantRefundRecoveryAllocationInput {
  adjustmentId: string;
  restaurantId: string;
  orderId: string;
  amountPaise: number;
  occurredAt: number;
  actorId: string;
  reason: string;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  code: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(code);
  return value;
}

function safeId(value: string, code: string, maxLength = 128): string {
  const normalized = String(value ?? "").trim();
  if (normalized.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}

function positivePaise(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("RESTAURANT_SETTLEMENT_INVALID_AMOUNT");
  return value;
}

function privileged(token: DecodedIdToken): boolean {
  return token.savrivoRole === "owner" || token.savrivoRole === "ops_admin";
}

function membershipAllowsFinance(
  member: RestaurantMembership | null,
  restaurantId: string,
  source: "path-scoped" | "legacy-global",
): boolean {
  return isActiveMembershipForRestaurant(member, restaurantId, source) &&
    ["restaurant_owner", "restaurant_manager"].includes(member?.role ?? "");
}

async function authorizeRestaurantFinanceRead(
  uid: string,
  token: DecodedIdToken,
  restaurantId: string,
  database: RestaurantSettlementDatabase,
): Promise<void> {
  if (privileged(token)) return;
  const [normalized, legacy] = await Promise.all([
    database.ref(`${ROOT}/restaurantMembers/${restaurantId}/${uid}`).get(),
    database.ref(`${ROOT}/staff/${uid}`).get(),
  ]);
  const normalizedMember = normalized.val() as RestaurantMembership | null;
  const legacyMember = legacy.val() as RestaurantMembership | null;
  if (membershipAllowsFinance(normalizedMember, restaurantId, "path-scoped") ||
      membershipAllowsFinance(legacyMember, restaurantId, "legacy-global")) return;
  throw new DomainError("permission-denied", "Restaurant financial access is not permitted.");
}

interface ParsedPage {
  journals: LedgerJournal[];
  scannedJournalCount: number;
  invalidJournalCount: number;
  truncated: boolean;
}

interface RestaurantLedgerCoverageMarker {
  schemaVersion: 1;
  restaurantId: string;
  historicalBackfillComplete: true;
  verifiedAt: number;
}

function coverageMarker(value: unknown, restaurantId: string): RestaurantLedgerCoverageMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<RestaurantLedgerCoverageMarker>;
  if (candidate.schemaVersion !== 1 || candidate.restaurantId !== restaurantId ||
      candidate.historicalBackfillComplete !== true || !Number.isSafeInteger(candidate.verifiedAt) ||
      Number(candidate.verifiedAt) <= 0) return null;
  return candidate as RestaurantLedgerCoverageMarker;
}

function parseJournalPage(raw: unknown, requestedLimit: number): ParsedPage {
  if (raw === null || raw === undefined) {
    return {journals: [], scannedJournalCount: 0, invalidJournalCount: 0, truncated: false};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {journals: [], scannedJournalCount: 1, invalidJournalCount: 1, truncated: false};
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const valid: LedgerJournal[] = [];
  let invalidJournalCount = 0;
  for (const [key, candidate] of entries) {
    try {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("INVALID");
      const journal = candidate as LedgerJournal;
      validateLedgerJournal(journal);
      if (key !== journal.journalId) throw new Error("PATH_ID_MISMATCH");
      valid.push(journal);
    } catch {
      invalidJournalCount += 1;
    }
  }
  valid.sort((left, right) =>
    right.occurredAt - left.occurredAt || right.journalId.localeCompare(left.journalId));
  return {
    journals: valid.slice(0, requestedLimit),
    scannedJournalCount: entries.length,
    invalidJournalCount,
    truncated: entries.length > requestedLimit,
  };
}

/**
 * A bounded, read-only finance query. It fetches limit + 1 so completeness is
 * never guessed. When the global immutable ledger no longer fits the bound,
 * the response remains useful as history but withholds an authoritative
 * pending payout until a server-maintained restaurant projection is deployed.
 */
export async function getRestaurantSettlementSummary(
  uid: string,
  token: DecodedIdToken,
  input: RestaurantSettlementQueryInput,
  database: RestaurantSettlementDatabase = db as unknown as RestaurantSettlementDatabase,
): Promise<RestaurantSettlementSummary> {
  const restaurantId = safeId(input.restaurantId, "RESTAURANT_SETTLEMENT_INVALID_RESTAURANT_ID");
  const ledgerLimit = boundedInteger(
    input.ledgerLimit,
    RESTAURANT_SETTLEMENT_DEFAULT_LEDGER_LIMIT,
    RESTAURANT_SETTLEMENT_MAX_LEDGER_LIMIT,
    "RESTAURANT_SETTLEMENT_INVALID_LEDGER_LIMIT",
  );
  const historyLimit = boundedInteger(
    input.historyLimit,
    RESTAURANT_SETTLEMENT_DEFAULT_HISTORY_LIMIT,
    RESTAURANT_SETTLEMENT_MAX_HISTORY_LIMIT,
    "RESTAURANT_SETTLEMENT_INVALID_HISTORY_LIMIT",
  );
  await authorizeRestaurantFinanceRead(uid, token, restaurantId, database);
  const referenceAt = Date.now();

  const [snapshot, coverageSnapshot, financePolicy] = await Promise.all([
    database.ref(LEDGER_JOURNALS_ROOT)
      .orderByChild("occurredAt")
      .limitToLast(ledgerLimit + 1)
      .get(),
    database.ref(`${RESTAURANT_LEDGER_COVERAGE_ROOT}/${restaurantId}`).get(),
    loadFinancePolicy(referenceAt),
  ]);
  const page = parseJournalPage(snapshot.val(), ledgerLimit);
  const coverageVerified = coverageMarker(coverageSnapshot.val(), restaurantId) !== null;
  if (page.invalidJournalCount > 0) {
    logger.error("RESTAURANT_SETTLEMENT_JOURNAL_VALIDATION_FAILED", {
      restaurantId,
      invalidJournalCount: page.invalidJournalCount,
      scannedJournalCount: page.scannedJournalCount,
    });
  }
  const summary = summarizeRestaurantSettlement(page.journals, {
    restaurantId,
    coverageVerified,
    complete: coverageVerified && !page.truncated && page.invalidJournalCount === 0,
    truncated: page.truncated,
    scannedJournalCount: page.scannedJournalCount,
    invalidJournalCount: page.invalidJournalCount,
    historyLimit,
  });
  const automation = financePayoutAutomationSummary(financePolicy, referenceAt);
  return {
    ...summary,
    automation: {
      enabled: automation.enabled,
      restaurantsEnabled: automation.restaurantsEnabled,
      scheduleLabel: automation.scheduleLabel,
      currentPeriodKey: automation.currentPeriodKey,
      nextRunDayKey: automation.nextRunDayKey,
      minimumSettlementPaise: automation.minimumRestaurantSettlementPaise,
    },
  };
}

/** Creates a balanced, immutable proof of an actual restaurant payout. */
export function buildRestaurantSettlementJournal(input: RestaurantSettlementJournalInput): LedgerJournal {
  const restaurantId = safeId(input.restaurantId, "RESTAURANT_SETTLEMENT_INVALID_RESTAURANT_ID");
  const referenceId = safeId(input.referenceId, "RESTAURANT_SETTLEMENT_INVALID_REFERENCE_ID");
  if (!(["bank_transfer", "upi", "imps", "neft"] as const).includes(input.method)) {
    throw new Error("RESTAURANT_SETTLEMENT_INVALID_METHOD");
  }
  return createLedgerJournal({
    eventType: "restaurant_payable",
    eventId: `settlement:${safeId(input.settlementId, "RESTAURANT_SETTLEMENT_INVALID_ID")}`,
    occurredAt: input.occurredAt,
    actorId: safeId(input.actorId, "RESTAURANT_SETTLEMENT_INVALID_ACTOR_ID"),
    metadata: {
      restaurantId,
      settlementMethod: input.method,
      referenceId,
    },
    postings: [
      {
        accountId: `liability:restaurant-payable:${restaurantId}`,
        side: "debit",
        amountPaise: positivePaise(input.amountPaise),
        memo: "Restaurant payable settled",
      },
      {
        accountId: "asset:restaurant-settlement-clearing",
        side: "credit",
        amountPaise: positivePaise(input.amountPaise),
        memo: "Restaurant payout sent",
      },
    ],
  });
}

/**
 * Explicitly allocates a post-delivery refund recovery to one restaurant.
 * Merely recording a gateway refund never reduces restaurant payable.
 */
export function buildRestaurantRefundRecoveryAllocationJournal(
  input: RestaurantRefundRecoveryAllocationInput,
): LedgerJournal {
  const restaurantId = safeId(input.restaurantId, "RESTAURANT_SETTLEMENT_INVALID_RESTAURANT_ID");
  const orderId = safeId(input.orderId, "RESTAURANT_SETTLEMENT_INVALID_ORDER_ID");
  const reason = String(input.reason ?? "").trim();
  if (!reason || reason.length > 300) throw new Error("RESTAURANT_SETTLEMENT_INVALID_ADJUSTMENT_REASON");
  return createLedgerJournal({
    eventType: "adjustment",
    eventId: `restaurant-refund-recovery:${safeId(
      input.adjustmentId,
      "RESTAURANT_SETTLEMENT_INVALID_ADJUSTMENT_ID",
    )}`,
    occurredAt: input.occurredAt,
    orderId,
    actorId: safeId(input.actorId, "RESTAURANT_SETTLEMENT_INVALID_ACTOR_ID"),
    metadata: {
      restaurantId,
      adjustmentKind: "restaurant_refund_recovery",
      reason,
    },
    postings: [
      {
        accountId: `liability:restaurant-payable:${restaurantId}`,
        side: "debit",
        amountPaise: positivePaise(input.amountPaise),
        memo: "Restaurant allocation of post-delivery refund recovery",
      },
      {
        accountId: `asset:refund-settlement-recovery:${orderId}`,
        side: "credit",
        amountPaise: positivePaise(input.amountPaise),
        memo: "Post-delivery refund recovery allocated",
      },
    ],
  });
}

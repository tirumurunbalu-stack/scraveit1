import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
import {validateLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {DomainError} from "../errors";
import type {RiderFinancialSummaryQueryInput} from "../schemas";
import {requireApprovedRider, requirePlatformConfigAdminClaim} from "./authz";
import {LEDGER_JOURNALS_ROOT} from "./ledger";

export const RIDER_FINANCE_LEDGER_MAX_PAGE = 250;
export const RIDER_FINANCE_HISTORY_MAX_PAGE = 100;
export const RIDER_FINANCE_WALLET_ROOT = `${ROOT}/riderWallets`;
export const RIDER_LEDGER_COVERAGE_ROOT = `${ROOT}/private/financialLedger/coverage/riders`;

interface ValueSnapshot {
  val(): unknown;
}

interface RiderFinanceReference {
  orderByChild(child: string): RiderFinanceReference;
  limitToLast(limit: number): RiderFinanceReference;
  get(): Promise<ValueSnapshot>;
}

export interface RiderFinanceDatabase {
  ref(path: string): RiderFinanceReference;
}

export interface RiderCodPosition {
  readonly source: "authoritative_wallet_projection";
  readonly outstandingPaise: number;
  readonly limitPaise: number;
  readonly reservedPaise: number;
  readonly availableToRemitPaise: number;
  readonly blocked: boolean;
}

export interface RiderFinancialWindow {
  readonly oldestOccurredAt: number;
  readonly newestOccurredAt: number;
  readonly completedDeliveryCount: number;
  readonly earningsCreditedPaise: number;
  readonly tipsCreditedPaise: number;
  /** Debits clear or adjust a payable. They do not prove an external bank payout. */
  readonly earningsSettledOrAdjustedPaise: number;
  readonly tipsSettledOrAdjustedPaise: number;
  readonly payableMovementPaise: number;
  /** Customer cash entrusted to the rider. This is a receivable/liability, never rider income. */
  readonly codCollectedPaise: number;
  readonly codRemittedPaise: number;
  readonly codOffsetAgainstEarningsPaise: number;
  readonly codOtherClearedPaise: number;
  readonly codClearedPaise: number;
  readonly codMovementPaise: number;
}

export interface RiderFinancialHistoryRow {
  readonly journalId: string;
  readonly eventType: LedgerJournal["eventType"];
  readonly occurredAt: number;
  readonly orderId?: string;
  readonly earningsMovementPaise: number;
  readonly tipsMovementPaise: number;
  readonly codMovementPaise: number;
  readonly category: "delivery" | "cod_remittance" | "cod_earnings_offset" | "adjustment" | "other";
}

export interface RiderFinancialSummary {
  readonly generatedAt: number;
  readonly riderId: string;
  readonly currency: "INR";
  readonly scope: "complete_ledger" | "bounded_recent_journals";
  /** True only when the complete ledger fit in the bounded query and reconciled to the exact wallet. */
  readonly complete: boolean;
  /** Server-verified proof that any pre-ledger rider history was backfilled. */
  readonly coverageVerified: boolean;
  readonly truncated: boolean;
  readonly reconciliationStatus:
    | "reconciled"
    | "unknown_ledger_coverage"
    | "unverified_bounded_window"
    | "duplicate_order_accrual"
    | "wallet_mismatch"
    | "invalid_ledger_data"
    | "invalid_payable_balance";
  readonly requestedJournalLimit: number;
  readonly journalCount: number;
  readonly relevantJournalCount: number;
  readonly invalidJournalCount: number;
  readonly duplicateDeliveryAccrualCount: number;
  readonly window: RiderFinancialWindow;
  /** Null means the bounded result must not be presented as an authoritative current payable. */
  readonly payableEarningsPaise: number | null;
  readonly cod: RiderCodPosition;
  readonly history: readonly RiderFinancialHistoryRow[];
}

export interface RiderFinanceAuthorization {
  requireRider(uid: string): Promise<unknown>;
  requireAdmin(token: DecodedIdToken): unknown;
}

const defaultAuthorization: RiderFinanceAuthorization = {
  requireRider: requireApprovedRider,
  requireAdmin: requirePlatformConfigAdminClaim,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function bounded(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function safeRiderId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 128 || /[.#$\/\[\]\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new DomainError("invalid-argument", "The rider id is invalid.");
  }
  return normalized;
}

function safeNonNegativePaise(value: unknown, reason: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DomainError("data-loss", "The rider financial projection requires finance review.", {reason});
  }
  return parsed;
}

function safePaiseFromRupees(value: unknown): number {
  const rupees = Number(value ?? 0);
  const paise = Math.round(rupees * 100);
  if (!Number.isFinite(rupees) || !Number.isSafeInteger(paise) || paise < 0 ||
      Math.abs(rupees * 100 - paise) > 0.000_001) {
    throw new DomainError("data-loss", "The rider COD projection requires finance review.", {
      reason: "COD_WALLET_BALANCE_INVALID",
    });
  }
  return paise;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new DomainError("data-loss", "The rider financial projection overflowed safe integer limits.", {
      reason: "RIDER_FINANCE_TOTAL_OVERFLOW",
    });
  }
  return result;
}

function signed(side: "debit" | "credit", amountPaise: number): number {
  return side === "credit" ? amountPaise : -amountPaise;
}

function parseWallet(raw: unknown): RiderCodPosition {
  if (raw === null || raw === undefined) {
    return {
      source: "authoritative_wallet_projection",
      outstandingPaise: 0,
      limitPaise: 0,
      reservedPaise: 0,
      availableToRemitPaise: 0,
      blocked: false,
    };
  }
  const source = record(raw);
  if (!source) {
    throw new DomainError("data-loss", "The rider COD projection requires finance review.", {
      reason: "COD_WALLET_INVALID",
    });
  }
  const outstandingPaise = safePaiseFromRupees(source.codOutstanding);
  const limitPaise = safeNonNegativePaise(source.codOutstandingLimitPaise, "COD_LIMIT_INVALID");
  const reservedPaise = safeNonNegativePaise(source.codRemittanceReservedPaise, "COD_RESERVATION_INVALID");
  if (reservedPaise > outstandingPaise ||
      (source.codBlocked !== undefined && typeof source.codBlocked !== "boolean")) {
    throw new DomainError("data-loss", "The rider COD projection requires finance review.", {
      reason: reservedPaise > outstandingPaise ? "COD_RESERVATION_EXCEEDS_BALANCE" : "COD_BLOCK_STATE_INVALID",
    });
  }
  return {
    source: "authoritative_wallet_projection",
    outstandingPaise,
    limitPaise,
    reservedPaise,
    availableToRemitPaise: outstandingPaise - reservedPaise,
    blocked: source.codBlocked === true || (limitPaise > 0 && outstandingPaise >= limitPaise),
  };
}

interface ParsedLedgerPage {
  readonly journals: readonly LedgerJournal[];
  readonly invalidJournalCount: number;
  readonly truncated: boolean;
}

interface RiderLedgerCoverageMarker {
  readonly schemaVersion: 1;
  readonly riderId: string;
  readonly historicalBackfillComplete: true;
  readonly verifiedAt: number;
}

function coverageMarker(value: unknown, riderId: string): RiderLedgerCoverageMarker | null {
  const candidate = record(value) as Partial<RiderLedgerCoverageMarker> | null;
  if (!candidate || candidate.schemaVersion !== 1 || candidate.riderId !== riderId ||
      candidate.historicalBackfillComplete !== true || !Number.isSafeInteger(candidate.verifiedAt) ||
      Number(candidate.verifiedAt) <= 0) return null;
  return candidate as RiderLedgerCoverageMarker;
}

function parseLedgerPage(raw: unknown, requestedLimit: number): ParsedLedgerPage {
  if (raw === null || raw === undefined) {
    return {journals: [], invalidJournalCount: 0, truncated: false};
  }
  const container = record(raw);
  if (!container) return {journals: [], invalidJournalCount: 1, truncated: false};

  const rawEntries = Object.entries(container);
  const truncated = rawEntries.length > requestedLimit;
  const byJournalId = new Map<string, LedgerJournal>();
  let invalidJournalCount = 0;
  for (const [storedKey, candidate] of rawEntries) {
    try {
      validateLedgerJournal(candidate as LedgerJournal);
      const journal = candidate as LedgerJournal;
      if (storedKey !== journal.journalId) throw new Error("LEDGER_STORAGE_KEY_MISMATCH");
      const existing = byJournalId.get(journal.journalId);
      if (existing && existing.fingerprint !== journal.fingerprint) {
        throw new Error("LEDGER_DUPLICATE_FINGERPRINT_CONFLICT");
      }
      byJournalId.set(journal.journalId, journal);
    } catch {
      invalidJournalCount += 1;
    }
  }
  const journals = [...byJournalId.values()]
    .sort((left, right) => right.occurredAt - left.occurredAt || left.journalId.localeCompare(right.journalId))
    .slice(0, requestedLimit);
  return {journals, invalidJournalCount, truncated};
}

function category(journal: LedgerJournal): RiderFinancialHistoryRow["category"] {
  if (journal.eventType === "cod_remittance") return "cod_remittance";
  if (journal.metadata.adjustmentKind === "cod_against_rider_earnings") return "cod_earnings_offset";
  if (journal.eventType === "cod_delivery" || journal.eventType === "rider_earning" ||
      journal.eventType === "rider_tip" || journal.eventType === "payment") return "delivery";
  if (journal.eventType === "adjustment") return "adjustment";
  return "other";
}

interface JournalMovement {
  earnings: number;
  tips: number;
  cod: number;
  earningsCredit: number;
  earningsDebit: number;
  tipsCredit: number;
  tipsDebit: number;
  codDebit: number;
  codCredit: number;
}

function journalMovement(journal: LedgerJournal, riderId: string): JournalMovement {
  const earningAccount = `liability:rider-earnings:${riderId}`;
  const tipAccount = `liability:rider-tips:${riderId}`;
  const codAccount = `asset:cod-receivable:${riderId}`;
  const movement: JournalMovement = {
    earnings: 0, tips: 0, cod: 0,
    earningsCredit: 0, earningsDebit: 0, tipsCredit: 0, tipsDebit: 0, codDebit: 0, codCredit: 0,
  };
  for (const entry of journal.entries) {
    if (entry.accountId === earningAccount) {
      movement.earnings = checkedAdd(movement.earnings, signed(entry.side, entry.amountPaise));
      if (entry.side === "credit") movement.earningsCredit = checkedAdd(movement.earningsCredit, entry.amountPaise);
      else movement.earningsDebit = checkedAdd(movement.earningsDebit, entry.amountPaise);
    } else if (entry.accountId === tipAccount) {
      movement.tips = checkedAdd(movement.tips, signed(entry.side, entry.amountPaise));
      if (entry.side === "credit") movement.tipsCredit = checkedAdd(movement.tipsCredit, entry.amountPaise);
      else movement.tipsDebit = checkedAdd(movement.tipsDebit, entry.amountPaise);
    } else if (entry.accountId === codAccount) {
      // Debit increases the asset owed by the rider; credit clears it.
      movement.cod = checkedAdd(movement.cod, entry.side === "debit" ? entry.amountPaise : -entry.amountPaise);
      if (entry.side === "debit") movement.codDebit = checkedAdd(movement.codDebit, entry.amountPaise);
      else movement.codCredit = checkedAdd(movement.codCredit, entry.amountPaise);
    }
  }
  return movement;
}

export function summarizeRiderFinancialJournals(
  riderId: string,
  page: ParsedLedgerPage,
  wallet: RiderCodPosition,
  coverageVerified: boolean,
  historyLimit: number,
  generatedAt: number,
  requestedJournalLimit: number,
): RiderFinancialSummary {
  const deliveryOrders = new Set<string>();
  const history: RiderFinancialHistoryRow[] = [];
  let relevantJournalCount = 0;
  let earningsCreditedPaise = 0;
  let tipsCreditedPaise = 0;
  let earningsSettledOrAdjustedPaise = 0;
  let tipsSettledOrAdjustedPaise = 0;
  let payableMovementPaise = 0;
  let codCollectedPaise = 0;
  let codRemittedPaise = 0;
  let codOffsetAgainstEarningsPaise = 0;
  let codOtherClearedPaise = 0;
  let codMovementPaise = 0;
  let duplicateDeliveryAccrualCount = 0;
  let oldestOccurredAt = 0;
  let newestOccurredAt = 0;

  for (const journal of page.journals) {
    const movement = journalMovement(journal, riderId);
    if (movement.earnings === 0 && movement.tips === 0 && movement.cod === 0) continue;
    relevantJournalCount += 1;
    oldestOccurredAt = oldestOccurredAt === 0 ? journal.occurredAt : Math.min(oldestOccurredAt, journal.occurredAt);
    newestOccurredAt = Math.max(newestOccurredAt, journal.occurredAt);
    earningsCreditedPaise = checkedAdd(earningsCreditedPaise, movement.earningsCredit);
    tipsCreditedPaise = checkedAdd(tipsCreditedPaise, movement.tipsCredit);
    earningsSettledOrAdjustedPaise = checkedAdd(earningsSettledOrAdjustedPaise, movement.earningsDebit);
    tipsSettledOrAdjustedPaise = checkedAdd(tipsSettledOrAdjustedPaise, movement.tipsDebit);
    payableMovementPaise = checkedAdd(payableMovementPaise, checkedAdd(movement.earnings, movement.tips));
    codCollectedPaise = checkedAdd(codCollectedPaise, movement.codDebit);
    codMovementPaise = checkedAdd(codMovementPaise, movement.cod);
    if (movement.codCredit > 0) {
      if (journal.eventType === "cod_remittance") {
        codRemittedPaise = checkedAdd(codRemittedPaise, movement.codCredit);
      } else if (journal.metadata.adjustmentKind === "cod_against_rider_earnings") {
        codOffsetAgainstEarningsPaise = checkedAdd(codOffsetAgainstEarningsPaise, movement.codCredit);
      } else {
        codOtherClearedPaise = checkedAdd(codOtherClearedPaise, movement.codCredit);
      }
    }
    if (journal.orderId && (journal.eventType === "cod_delivery" || journal.eventType === "payment") &&
        (movement.earningsCredit > 0 || movement.tipsCredit > 0)) {
      if (deliveryOrders.has(journal.orderId)) duplicateDeliveryAccrualCount += 1;
      deliveryOrders.add(journal.orderId);
    }
    history.push({
      journalId: journal.journalId,
      eventType: journal.eventType,
      occurredAt: journal.occurredAt,
      ...(journal.orderId ? {orderId: journal.orderId} : {}),
      earningsMovementPaise: movement.earnings,
      tipsMovementPaise: movement.tips,
      codMovementPaise: movement.cod,
      category: category(journal),
    });
  }

  const codClearedPaise = checkedAdd(
    checkedAdd(codRemittedPaise, codOffsetAgainstEarningsPaise),
    codOtherClearedPaise,
  );
  let reconciliationStatus: RiderFinancialSummary["reconciliationStatus"];
  if (!coverageVerified) reconciliationStatus = "unknown_ledger_coverage";
  else if (page.invalidJournalCount > 0) reconciliationStatus = "invalid_ledger_data";
  else if (duplicateDeliveryAccrualCount > 0) reconciliationStatus = "duplicate_order_accrual";
  else if (page.truncated) reconciliationStatus = "unverified_bounded_window";
  else if (codMovementPaise !== wallet.outstandingPaise) reconciliationStatus = "wallet_mismatch";
  else if (payableMovementPaise < 0) reconciliationStatus = "invalid_payable_balance";
  else reconciliationStatus = "reconciled";
  const complete = reconciliationStatus === "reconciled";

  return {
    generatedAt,
    riderId,
    currency: "INR",
    scope: complete ? "complete_ledger" : "bounded_recent_journals",
    complete,
    coverageVerified,
    truncated: page.truncated,
    reconciliationStatus,
    requestedJournalLimit,
    journalCount: page.journals.length,
    relevantJournalCount,
    invalidJournalCount: page.invalidJournalCount,
    duplicateDeliveryAccrualCount,
    window: {
      oldestOccurredAt,
      newestOccurredAt,
      completedDeliveryCount: deliveryOrders.size,
      earningsCreditedPaise,
      tipsCreditedPaise,
      earningsSettledOrAdjustedPaise,
      tipsSettledOrAdjustedPaise,
      payableMovementPaise,
      codCollectedPaise,
      codRemittedPaise,
      codOffsetAgainstEarningsPaise,
      codOtherClearedPaise,
      codClearedPaise,
      codMovementPaise,
    },
    payableEarningsPaise: complete ? payableMovementPaise : null,
    cod: wallet,
    history: history.slice(0, bounded(historyLimit, RIDER_FINANCE_HISTORY_MAX_PAGE)),
  };
}

export async function readRiderFinancialSummary(
  requesterUid: string,
  token: DecodedIdToken,
  input: RiderFinancialSummaryQueryInput,
  database: RiderFinanceDatabase = db as unknown as RiderFinanceDatabase,
  authorization: RiderFinanceAuthorization = defaultAuthorization,
  now: () => number = Date.now,
): Promise<RiderFinancialSummary> {
  const requesterId = safeRiderId(requesterUid);
  const riderId = safeRiderId(input.riderId ?? requesterId);
  if (riderId === requesterId) await authorization.requireRider(requesterId);
  else authorization.requireAdmin(token);

  const journalLimit = bounded(input.ledgerLimit, RIDER_FINANCE_LEDGER_MAX_PAGE);
  const historyLimit = bounded(input.historyLimit, RIDER_FINANCE_HISTORY_MAX_PAGE);
  const [ledgerSnapshot, walletSnapshot, coverageSnapshot] = await Promise.all([
    database.ref(LEDGER_JOURNALS_ROOT)
      .orderByChild("occurredAt")
      .limitToLast(journalLimit + 1)
      .get(),
    database.ref(`${RIDER_FINANCE_WALLET_ROOT}/${riderId}`).get(),
    database.ref(`${RIDER_LEDGER_COVERAGE_ROOT}/${riderId}`).get(),
  ]);
  const page = parseLedgerPage(ledgerSnapshot.val(), journalLimit);
  const wallet = parseWallet(walletSnapshot.val());
  const coverageVerified = coverageMarker(coverageSnapshot.val(), riderId) !== null;
  if (page.invalidJournalCount > 0) {
    logger.error("RIDER_FINANCE_JOURNAL_VALIDATION_FAILED", {
      riderId,
      invalidJournalCount: page.invalidJournalCount,
      requestedJournalLimit: journalLimit,
    });
  }
  const result = summarizeRiderFinancialJournals(
    riderId,
    page,
    wallet,
    coverageVerified,
    historyLimit,
    now(),
    journalLimit,
  );
  if (!result.complete) {
    logger.warn("RIDER_FINANCE_SUMMARY_INCOMPLETE", {
      riderId,
      reconciliationStatus: result.reconciliationStatus,
      truncated: result.truncated,
    });
  }
  return result;
}

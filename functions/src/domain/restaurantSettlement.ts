import {
  ledgerJournalsEqual,
  validateLedgerJournal,
  type LedgerEntry,
  type LedgerJournal,
} from "./ledger";

export const RESTAURANT_SETTLEMENT_CURRENCY = "INR" as const;

export type RestaurantSettlementActivityType =
  | "order_accrual"
  | "settlement"
  | "adjustment"
  | "refund_recovery_pending"
  | "refund_recovery_allocated";

export interface RestaurantSettlementActivity {
  readonly journalId: string;
  readonly activityType: RestaurantSettlementActivityType;
  readonly eventType: LedgerJournal["eventType"];
  readonly occurredAt: number;
  readonly orderId?: string;
  readonly paymentMethod?: "cod" | "online";
  /** Positive increases the restaurant payable; negative reduces it. */
  readonly payableMovementPaise: number;
  /** Present only for an order-delivery accrual. */
  readonly customerGrossPaise?: number;
  /** Present only for a post-delivery refund recovery event. */
  readonly refundRecoveryPaise?: number;
}

export interface RestaurantSettlementSummaryOptions {
  readonly restaurantId: string;
  /** Verified server-side marker that all pre-ledger history was backfilled. */
  readonly coverageVerified: boolean;
  /** True only if this set contains the complete immutable journal history. */
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly scannedJournalCount: number;
  readonly invalidJournalCount: number;
  readonly historyLimit: number;
}

export interface RestaurantSettlementSummary {
  readonly schemaVersion: 1;
  readonly restaurantId: string;
  readonly currency: typeof RESTAURANT_SETTLEMENT_CURRENCY;
  readonly scope: "complete_ledger" | "bounded_recent_journals";
  /**
   * False means window totals are diagnostic only. In that case an
   * authoritative pending balance is deliberately not returned.
   */
  readonly complete: boolean;
  readonly coverageVerified: boolean;
  readonly truncated: boolean;
  readonly scannedJournalCount: number;
  readonly includedJournalCount: number;
  readonly invalidJournalCount: number;
  readonly duplicateJournalCount: number;
  /** Semantic ledger anomalies that make the derived balance unsafe. */
  readonly integrityViolationCount: number;
  readonly oldestOccurredAt: number;
  readonly newestOccurredAt: number;
  readonly completedOrderCount: number;
  readonly codOrderCount: number;
  readonly onlineOrderCount: number;
  readonly customerGrossPaise: number;
  readonly menuConsiderationPaise: number;
  readonly accruedRestaurantPayablePaise: number;
  readonly platformCommissionPaise: number;
  readonly platformFeePaise: number;
  readonly taxPayablePaise: number;
  readonly alreadySettledPaise: number;
  readonly adjustmentCreditsPaise: number;
  readonly adjustmentDebitsPaise: number;
  readonly refundRecoveryReportedPaise: number;
  readonly refundRecoveryAllocatedPaise: number;
  readonly refundRecoveryPendingAllocationPaise: number;
  /** Signed credit-minus-debit movement in the bounded journal window. */
  readonly windowNetPayableMovementPaise: number;
  /** Available only when the journal set is complete and valid. */
  readonly pendingSettlementPaise: number | null;
  /** Available only when the journal set is complete and valid. */
  readonly restaurantDebitBalancePaise: number | null;
  readonly automation?: {
    readonly enabled: boolean;
    readonly restaurantsEnabled: boolean;
    readonly scheduleLabel: string;
    readonly currentPeriodKey: string | null;
    readonly nextRunDayKey: string | null;
    readonly minimumSettlementPaise: number;
  };
  readonly requiresFinanceReview: boolean;
  readonly activities: readonly RestaurantSettlementActivity[];
  readonly settlementHistory: readonly RestaurantSettlementActivity[];
}

interface RefundRecovery {
  journal: LedgerJournal;
  amountPaise: number;
}

function fail(code: string): never {
  throw new Error(code);
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail("RESTAURANT_SETTLEMENT_TOTAL_OVERFLOW");
  return result;
}

function requireRestaurantId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(normalized)) {
    fail("RESTAURANT_SETTLEMENT_INVALID_RESTAURANT_ID");
  }
  return normalized;
}

function boundedHistoryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    fail("RESTAURANT_SETTLEMENT_INVALID_HISTORY_LIMIT");
  }
  return value;
}

function entryTotal(
  entries: readonly LedgerEntry[],
  accountId: string,
  side: LedgerEntry["side"],
): number {
  return entries.reduce((total, entry) =>
    entry.accountId === accountId && entry.side === side ? safeAdd(total, entry.amountPaise) : total, 0);
}

function accountPrefixTotal(
  entries: readonly LedgerEntry[],
  accountPrefix: string,
  side: LedgerEntry["side"],
): number {
  return entries.reduce((total, entry) =>
    entry.accountId.startsWith(accountPrefix) && entry.side === side ?
      safeAdd(total, entry.amountPaise) : total, 0);
}

function paymentMethod(journal: LedgerJournal): "cod" | "online" | undefined {
  if (journal.eventType === "cod_delivery") return "cod";
  return journal.metadata.paymentMethod === "online" ? "online" : undefined;
}

function isDeliveryAccrual(journal: LedgerJournal, restaurantCreditPaise: number): boolean {
  if (restaurantCreditPaise <= 0) return false;
  // Any payment journal that credits a restaurant payable is economically a
  // delivery accrual. A missing/unknown paymentMethod is handled as a hard
  // semantic integrity violation below rather than silently reclassifying the
  // payable movement as a generic adjustment.
  return journal.eventType === "cod_delivery" || journal.eventType === "payment";
}

function grossAmount(journal: LedgerJournal): number {
  const metadataAmount = journal.metadata.grossAmountPaise;
  if (typeof metadataAmount === "number" && Number.isSafeInteger(metadataAmount) && metadataAmount > 0) {
    return metadataAmount;
  }
  // Historical delivery journals may predate component metadata. Their
  // balanced debit total remains the immutable customer consideration.
  return journal.debitTotalPaise;
}

function uniqueValidatedJournals(journals: readonly LedgerJournal[]): {
  journals: LedgerJournal[];
  duplicateJournalCount: number;
} {
  const byId = new Map<string, LedgerJournal>();
  let duplicateJournalCount = 0;
  for (const journal of journals) {
    validateLedgerJournal(journal);
    const existing = byId.get(journal.journalId);
    if (!existing) {
      byId.set(journal.journalId, journal);
      continue;
    }
    if (!ledgerJournalsEqual(existing, journal)) fail("RESTAURANT_SETTLEMENT_DUPLICATE_JOURNAL_CONFLICT");
    duplicateJournalCount += 1;
  }
  return {
    journals: [...byId.values()].sort((left, right) =>
      left.occurredAt - right.occurredAt || left.journalId.localeCompare(right.journalId)),
    duplicateJournalCount,
  };
}

/**
 * Derives one restaurant's finances strictly from validated immutable ledger
 * journals. A post-delivery refund is reported as pending recovery but never
 * reduces the restaurant payable unless a separate immutable allocation
 * journal actually debits that restaurant account.
 */
export function summarizeRestaurantSettlement(
  sourceJournals: readonly LedgerJournal[],
  options: RestaurantSettlementSummaryOptions,
): RestaurantSettlementSummary {
  const restaurantId = requireRestaurantId(options.restaurantId);
  const historyLimit = boundedHistoryLimit(options.historyLimit);
  if (!Number.isSafeInteger(options.scannedJournalCount) || options.scannedJournalCount < 0 ||
      !Number.isSafeInteger(options.invalidJournalCount) || options.invalidJournalCount < 0) {
    fail("RESTAURANT_SETTLEMENT_INVALID_SCAN_COUNTS");
  }

  const unique = uniqueValidatedJournals(sourceJournals);
  const accountId = `liability:restaurant-payable:${restaurantId}`;
  const deliveryOrderIds = new Set<string>();
  const codOrderIds = new Set<string>();
  const onlineOrderIds = new Set<string>();
  const refundRecoveries = new Map<string, RefundRecovery[]>();
  const recoveryAllocations = new Map<string, number>();
  const activities: RestaurantSettlementActivity[] = [];
  let customerGrossPaise = 0;
  let accruedRestaurantPayablePaise = 0;
  let platformCommissionPaise = 0;
  let platformFeePaise = 0;
  let taxPayablePaise = 0;
  let alreadySettledPaise = 0;
  let adjustmentCreditsPaise = 0;
  let adjustmentDebitsPaise = 0;
  let windowNetPayableMovementPaise = 0;
  let integrityViolationCount = 0;
  let requiresFinanceReview = options.invalidJournalCount > 0 || options.truncated ||
    !options.complete || !options.coverageVerified;
  const markIntegrityViolation = (): void => {
    integrityViolationCount += 1;
    requiresFinanceReview = true;
  };

  for (const journal of unique.journals) {
    const credit = entryTotal(journal.entries, accountId, "credit");
    const debit = entryTotal(journal.entries, accountId, "debit");
    windowNetPayableMovementPaise = safeAdd(windowNetPayableMovementPaise, credit - debit);

    if (isDeliveryAccrual(journal, credit)) {
      accruedRestaurantPayablePaise = safeAdd(accruedRestaurantPayablePaise, credit);
      customerGrossPaise = safeAdd(customerGrossPaise, grossAmount(journal));
      platformCommissionPaise = safeAdd(
        platformCommissionPaise,
        entryTotal(journal.entries, "revenue:platform-commission", "credit"),
      );
      platformFeePaise = safeAdd(
        platformFeePaise,
        entryTotal(journal.entries, "revenue:platform-fees", "credit"),
      );
      taxPayablePaise = safeAdd(
        taxPayablePaise,
        entryTotal(journal.entries, "liability:tax-payable", "credit"),
      );
      const orderKey = journal.orderId ?? `missing:${journal.journalId}`;
      if (!journal.orderId) markIntegrityViolation();
      if (deliveryOrderIds.has(orderKey)) markIntegrityViolation();
      deliveryOrderIds.add(orderKey);
      const method = paymentMethod(journal);
      if (method === "cod") codOrderIds.add(orderKey);
      else if (method === "online") onlineOrderIds.add(orderKey);
      else markIntegrityViolation();
      activities.push({
        journalId: journal.journalId,
        activityType: "order_accrual",
        eventType: journal.eventType,
        occurredAt: journal.occurredAt,
        ...(journal.orderId ? {orderId: journal.orderId} : {}),
        ...(method ? {paymentMethod: method} : {}),
        payableMovementPaise: credit,
        customerGrossPaise: grossAmount(journal),
      });
      continue;
    }

    if (journal.eventType === "restaurant_payable" && debit > 0) {
      alreadySettledPaise = safeAdd(alreadySettledPaise, debit);
      if (credit > 0) markIntegrityViolation();
      activities.push({
        journalId: journal.journalId,
        activityType: "settlement",
        eventType: journal.eventType,
        occurredAt: journal.occurredAt,
        ...(journal.orderId ? {orderId: journal.orderId} : {}),
        payableMovementPaise: credit - debit,
      });
      continue;
    }

    if (credit > 0 || debit > 0) {
      adjustmentCreditsPaise = safeAdd(adjustmentCreditsPaise, credit);
      adjustmentDebitsPaise = safeAdd(adjustmentDebitsPaise, debit);
      const isRecoveryAllocation = journal.metadata.adjustmentKind === "restaurant_refund_recovery" &&
        debit > 0 && Boolean(journal.orderId);
      if (isRecoveryAllocation && journal.orderId) {
        const recoveryCredit = entryTotal(
          journal.entries,
          `asset:refund-settlement-recovery:${journal.orderId}`,
          "credit",
        );
        if (recoveryCredit !== debit) markIntegrityViolation();
        recoveryAllocations.set(
          journal.orderId,
          safeAdd(recoveryAllocations.get(journal.orderId) ?? 0, Math.min(recoveryCredit, debit)),
        );
      }
      activities.push({
        journalId: journal.journalId,
        activityType: isRecoveryAllocation ? "refund_recovery_allocated" : "adjustment",
        eventType: journal.eventType,
        occurredAt: journal.occurredAt,
        ...(journal.orderId ? {orderId: journal.orderId} : {}),
        payableMovementPaise: credit - debit,
      });
    }
  }

  for (const journal of unique.journals) {
    if (journal.eventType !== "refund" || journal.metadata.requiresSettlementRecovery !== true ||
        !journal.orderId || !deliveryOrderIds.has(journal.orderId)) continue;
    const amountPaise = entryTotal(
      journal.entries,
      `asset:refund-settlement-recovery:${journal.orderId}`,
      "debit",
    );
    if (amountPaise <= 0) {
      markIntegrityViolation();
      continue;
    }
    const recoveries = refundRecoveries.get(journal.orderId) ?? [];
    recoveries.push({journal, amountPaise});
    refundRecoveries.set(journal.orderId, recoveries);
  }

  let refundRecoveryReportedPaise = 0;
  let refundRecoveryAllocatedPaise = 0;
  let refundRecoveryPendingAllocationPaise = 0;
  for (const [orderId, recoveries] of refundRecoveries) {
    const reported = recoveries.reduce((total, recovery) => safeAdd(total, recovery.amountPaise), 0);
    const allocated = recoveryAllocations.get(orderId) ?? 0;
    if (allocated > reported) markIntegrityViolation();
    const boundedAllocated = Math.min(allocated, reported);
    refundRecoveryReportedPaise = safeAdd(refundRecoveryReportedPaise, reported);
    refundRecoveryAllocatedPaise = safeAdd(refundRecoveryAllocatedPaise, boundedAllocated);
    refundRecoveryPendingAllocationPaise = safeAdd(
      refundRecoveryPendingAllocationPaise,
      reported - boundedAllocated,
    );
    for (const recovery of recoveries) {
      activities.push({
        journalId: recovery.journal.journalId,
        activityType: "refund_recovery_pending",
        eventType: recovery.journal.eventType,
        occurredAt: recovery.journal.occurredAt,
        orderId,
        payableMovementPaise: 0,
        refundRecoveryPaise: recovery.amountPaise,
      });
    }
  }
  for (const orderId of recoveryAllocations.keys()) {
    if (!refundRecoveries.has(orderId)) markIntegrityViolation();
  }
  if (refundRecoveryPendingAllocationPaise > 0) requiresFinanceReview = true;

  const complete = options.coverageVerified && options.complete &&
    !options.truncated && options.invalidJournalCount === 0 && integrityViolationCount === 0;
  const authoritativeNet = complete ? windowNetPayableMovementPaise : null;
  const sortedActivities = activities.sort((left, right) =>
    right.occurredAt - left.occurredAt || right.journalId.localeCompare(left.journalId));
  const settlementHistory = sortedActivities.filter((activity) =>
    activity.activityType === "settlement" ||
    activity.activityType === "refund_recovery_allocated" ||
    activity.activityType === "adjustment");

  return {
    schemaVersion: 1,
    restaurantId,
    currency: RESTAURANT_SETTLEMENT_CURRENCY,
    scope: complete ? "complete_ledger" : "bounded_recent_journals",
    complete,
    coverageVerified: options.coverageVerified,
    truncated: options.truncated,
    scannedJournalCount: options.scannedJournalCount,
    includedJournalCount: unique.journals.length,
    invalidJournalCount: options.invalidJournalCount,
    duplicateJournalCount: unique.duplicateJournalCount,
    integrityViolationCount,
    oldestOccurredAt: unique.journals[0]?.occurredAt ?? 0,
    newestOccurredAt: unique.journals[unique.journals.length - 1]?.occurredAt ?? 0,
    completedOrderCount: deliveryOrderIds.size,
    codOrderCount: codOrderIds.size,
    onlineOrderCount: onlineOrderIds.size,
    customerGrossPaise,
    menuConsiderationPaise: safeAdd(accruedRestaurantPayablePaise, platformCommissionPaise),
    accruedRestaurantPayablePaise,
    platformCommissionPaise,
    platformFeePaise,
    taxPayablePaise,
    alreadySettledPaise,
    adjustmentCreditsPaise,
    adjustmentDebitsPaise,
    refundRecoveryReportedPaise,
    refundRecoveryAllocatedPaise,
    refundRecoveryPendingAllocationPaise,
    windowNetPayableMovementPaise,
    pendingSettlementPaise: authoritativeNet === null ? null : Math.max(0, authoritativeNet),
    restaurantDebitBalancePaise: authoritativeNet === null ? null : Math.max(0, -authoritativeNet),
    requiresFinanceReview,
    activities: sortedActivities.slice(0, historyLimit),
    settlementHistory: settlementHistory.slice(0, historyLimit),
  };
}

import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }},
}));
import {createLedgerJournal} from "../src/domain/ledger";
import {summarizeRestaurantSettlement} from "../src/domain/restaurantSettlement";
import {
  buildCodOrderDeliveryJournal,
  buildOnlineOrderDeliveryJournal,
  buildOnlinePaymentRefundJournal,
} from "../src/services/ledger";
import {
  buildRestaurantRefundRecoveryAllocationJournal,
  buildRestaurantSettlementJournal,
} from "../src/services/restaurantSettlements";

const amounts = {
  grossAmountPaise: 14_000,
  restaurantPayablePaise: 10_000,
  platformCommissionPaise: 1_500,
  platformFeePaise: 1_000,
  taxPayablePaise: 500,
  riderDeliveryEarningPaise: 800,
  riderTipPaise: 200,
};

function cod(orderId = "order-cod-1", occurredAt = 1_000) {
  return buildCodOrderDeliveryJournal({
    ...amounts,
    orderId,
    restaurantId: "restaurant-1",
    riderId: "rider-1",
    occurredAt,
  });
}

function online(orderId = "order-online-1", occurredAt = 2_000) {
  return buildOnlineOrderDeliveryJournal({
    ...amounts,
    orderId,
    restaurantId: "restaurant-1",
    riderId: "rider-2",
    occurredAt,
    paymentProvider: "phonepe",
    providerTransactionId: `provider-${orderId}`,
  });
}

function summary(journals: Parameters<typeof summarizeRestaurantSettlement>[0], complete = true) {
  return summarizeRestaurantSettlement(journals, {
    restaurantId: "restaurant-1",
    coverageVerified: true,
    complete,
    truncated: !complete,
    scannedJournalCount: journals.length,
    invalidJournalCount: 0,
    historyLimit: 50,
  });
}

describe("ledger-derived restaurant settlements", () => {
  it("derives COD and online accruals, commission, fees, tax and settled balance", () => {
    const settlement = buildRestaurantSettlementJournal({
      settlementId: "settlement-1",
      restaurantId: "restaurant-1",
      amountPaise: 12_000,
      occurredAt: 3_000,
      actorId: "admin-1",
      method: "bank_transfer",
      referenceId: "UTR-0001",
    });
    const result = summary([cod(), online(), settlement]);

    expect(result).toMatchObject({
      scope: "complete_ledger",
      complete: true,
      completedOrderCount: 2,
      codOrderCount: 1,
      onlineOrderCount: 1,
      customerGrossPaise: 28_000,
      menuConsiderationPaise: 23_000,
      accruedRestaurantPayablePaise: 20_000,
      platformCommissionPaise: 3_000,
      platformFeePaise: 2_000,
      taxPayablePaise: 1_000,
      alreadySettledPaise: 12_000,
      windowNetPayableMovementPaise: 8_000,
      pendingSettlementPaise: 8_000,
      restaurantDebitBalancePaise: 0,
      requiresFinanceReview: false,
    });
    expect(result.activities.map((activity) => activity.activityType))
      .toEqual(["settlement", "order_accrual", "order_accrual"]);
    expect(result.settlementHistory).toHaveLength(1);
  });

  it("does not silently reduce payable for a post-delivery refund without an allocation journal", () => {
    const refund = buildOnlinePaymentRefundJournal({
      paymentId: "payment-1",
      orderId: "order-online-1",
      paymentProvider: "phonepe",
      providerTransactionId: "refund-provider-1",
      amountPaise: 14_000,
      occurredAt: 3_000,
      settlementReleased: true,
    });
    const result = summary([online(), refund]);

    expect(result).toMatchObject({
      accruedRestaurantPayablePaise: 10_000,
      windowNetPayableMovementPaise: 10_000,
      pendingSettlementPaise: 10_000,
      refundRecoveryReportedPaise: 14_000,
      refundRecoveryAllocatedPaise: 0,
      refundRecoveryPendingAllocationPaise: 14_000,
      requiresFinanceReview: true,
    });
    expect(result.activities[0]).toMatchObject({
      activityType: "refund_recovery_pending",
      payableMovementPaise: 0,
      refundRecoveryPaise: 14_000,
    });
  });

  it("reduces payable only after an explicit immutable refund-recovery allocation", () => {
    const refund = buildOnlinePaymentRefundJournal({
      paymentId: "payment-1",
      orderId: "order-online-1",
      paymentProvider: "phonepe",
      providerTransactionId: "refund-provider-2",
      amountPaise: 14_000,
      occurredAt: 3_000,
      settlementReleased: true,
    });
    const allocation = buildRestaurantRefundRecoveryAllocationJournal({
      adjustmentId: "adjustment-1",
      restaurantId: "restaurant-1",
      orderId: "order-online-1",
      amountPaise: 10_000,
      occurredAt: 4_000,
      actorId: "admin-1",
      reason: "Restaurant share of verified full refund",
    });
    const result = summary([online(), refund, allocation]);

    expect(result).toMatchObject({
      adjustmentDebitsPaise: 10_000,
      windowNetPayableMovementPaise: 0,
      pendingSettlementPaise: 0,
      refundRecoveryReportedPaise: 14_000,
      refundRecoveryAllocatedPaise: 10_000,
      refundRecoveryPendingAllocationPaise: 4_000,
      requiresFinanceReview: true,
    });
    expect(result.settlementHistory[0]).toMatchObject({
      activityType: "refund_recovery_allocated",
      payableMovementPaise: -10_000,
    });
  });

  it("reports an exact smaller recovery journal without implying partial-refund workflow support", () => {
    // The canonical payment state machine separately rejects arbitrary partial
    // refunds. This protects read-side compatibility if an audited recovery
    // journal with a smaller amount exists; it never invents a payable debit.
    const recovery = buildOnlinePaymentRefundJournal({
      paymentId: "payment-compat",
      orderId: "order-online-1",
      paymentProvider: "phonepe",
      providerTransactionId: "refund-compat-smaller",
      amountPaise: 2_500,
      occurredAt: 3_000,
      settlementReleased: true,
    });
    const result = summary([online(), recovery]);
    expect(result).toMatchObject({
      pendingSettlementPaise: 10_000,
      refundRecoveryReportedPaise: 2_500,
      refundRecoveryPendingAllocationPaise: 2_500,
    });
  });

  it("does not accrue cancelled/pre-delivery refunded orders that never reached delivery", () => {
    const preDeliveryRefund = buildOnlinePaymentRefundJournal({
      paymentId: "payment-cancelled",
      orderId: "order-cancelled",
      paymentProvider: "phonepe",
      providerTransactionId: "refund-cancelled",
      amountPaise: 14_000,
      occurredAt: 2_000,
      settlementReleased: false,
    });
    const result = summary([preDeliveryRefund]);
    expect(result).toMatchObject({
      completedOrderCount: 0,
      accruedRestaurantPayablePaise: 0,
      pendingSettlementPaise: 0,
      refundRecoveryReportedPaise: 0,
    });
  });

  it("withholds an authoritative balance for a truncated journal window", () => {
    const result = summary([cod()], false);
    expect(result).toMatchObject({
      scope: "bounded_recent_journals",
      complete: false,
      truncated: true,
      windowNetPayableMovementPaise: 10_000,
      pendingSettlementPaise: null,
      restaurantDebitBalancePaise: null,
      requiresFinanceReview: true,
    });
  });

  it("deduplicates exact retries but rejects conflicting journals sharing the deterministic id", () => {
    const original = cod();
    const exactRetry = structuredClone(original);
    expect(summary([original, exactRetry])).toMatchObject({
      includedJournalCount: 1,
      duplicateJournalCount: 1,
      accruedRestaurantPayablePaise: 10_000,
    });

    const conflict = buildCodOrderDeliveryJournal({
      ...amounts,
      restaurantPayablePaise: 9_999,
      platformFeePaise: 1_001,
      orderId: "order-cod-1",
      restaurantId: "restaurant-1",
      riderId: "rider-1",
      occurredAt: 1_000,
    });
    expect(() => summary([original, conflict])).toThrow("RESTAURANT_SETTLEMENT_DUPLICATE_JOURNAL_CONFLICT");
  });

  it("fails the authoritative balance closed for duplicate order accruals", () => {
    const result = summary([cod("duplicate-order"), online("duplicate-order", 2_000)]);

    expect(result).toMatchObject({
      complete: false,
      integrityViolationCount: 1,
      pendingSettlementPaise: null,
      restaurantDebitBalancePaise: null,
      requiresFinanceReview: true,
    });
  });

  it("fails closed when a restaurant delivery accrual lacks its order and payment method", () => {
    const malformedAccrual = createLedgerJournal({
      eventType: "payment",
      eventId: "legacy-delivery-without-context",
      occurredAt: 2_500,
      postings: [
        {accountId: "liability:customer-order-funds:unknown", side: "debit", amountPaise: 10_000},
        {accountId: "liability:restaurant-payable:restaurant-1", side: "credit", amountPaise: 10_000},
      ],
    });
    const result = summary([malformedAccrual]);

    expect(result).toMatchObject({
      complete: false,
      completedOrderCount: 1,
      integrityViolationCount: 2,
      pendingSettlementPaise: null,
      requiresFinanceReview: true,
    });
  });

  it("fails closed for a mismatched refund-recovery allocation", () => {
    const refund = buildOnlinePaymentRefundJournal({
      paymentId: "payment-mismatch",
      orderId: "order-online-1",
      paymentProvider: "phonepe",
      providerTransactionId: "refund-provider-mismatch",
      amountPaise: 14_000,
      occurredAt: 3_000,
      settlementReleased: true,
    });
    const mismatch = createLedgerJournal({
      eventType: "adjustment",
      eventId: "restaurant-refund-recovery:mismatch",
      orderId: "order-online-1",
      occurredAt: 4_000,
      metadata: {adjustmentKind: "restaurant_refund_recovery"},
      postings: [
        {accountId: "liability:restaurant-payable:restaurant-1", side: "debit", amountPaise: 10_000},
        {accountId: "asset:refund-settlement-recovery:order-online-1", side: "credit", amountPaise: 8_000},
        {accountId: "asset:finance-review-suspense", side: "credit", amountPaise: 2_000},
      ],
    });
    const result = summary([online(), refund, mismatch]);

    expect(result).toMatchObject({
      complete: false,
      integrityViolationCount: 1,
      pendingSettlementPaise: null,
      requiresFinanceReview: true,
    });
  });

  it("fails closed when recovery allocation exceeds the verified recovery", () => {
    const refund = buildOnlinePaymentRefundJournal({
      paymentId: "payment-over-allocation",
      orderId: "order-online-1",
      paymentProvider: "phonepe",
      providerTransactionId: "refund-provider-over-allocation",
      amountPaise: 14_000,
      occurredAt: 3_000,
      settlementReleased: true,
    });
    const allocation = buildRestaurantRefundRecoveryAllocationJournal({
      adjustmentId: "adjustment-over-allocation",
      restaurantId: "restaurant-1",
      orderId: "order-online-1",
      amountPaise: 15_000,
      occurredAt: 4_000,
      actorId: "admin-1",
      reason: "Invalid allocation intentionally exercised by the regression test",
    });
    const result = summary([online(), refund, allocation]);

    expect(result).toMatchObject({
      complete: false,
      integrityViolationCount: 1,
      pendingSettlementPaise: null,
      refundRecoveryAllocatedPaise: 14_000,
      requiresFinanceReview: true,
    });
  });

  it("surfaces an over-settled debit balance instead of hiding it", () => {
    const settlement = buildRestaurantSettlementJournal({
      settlementId: "settlement-over",
      restaurantId: "restaurant-1",
      amountPaise: 12_000,
      occurredAt: 2_000,
      actorId: "admin-1",
      method: "upi",
      referenceId: "UTR-over",
    });
    const result = summary([cod(), settlement]);
    expect(result).toMatchObject({
      windowNetPayableMovementPaise: -2_000,
      pendingSettlementPaise: 0,
      restaurantDebitBalancePaise: 2_000,
    });
  });

  it("keeps unrelated restaurant journals out of the requested balance", () => {
    const other = createLedgerJournal({
      eventType: "cod_delivery",
      eventId: "order:other:delivered:cod",
      orderId: "other",
      occurredAt: 1_500,
      metadata: {paymentMethod: "cod", grossAmountPaise: 1_000},
      postings: [
        {accountId: "asset:cod-receivable:rider-x", side: "debit", amountPaise: 1_000},
        {accountId: "liability:restaurant-payable:restaurant-2", side: "credit", amountPaise: 1_000},
      ],
    });
    const result = summary([cod(), other]);
    expect(result).toMatchObject({completedOrderCount: 1, accruedRestaurantPayablePaise: 10_000});
    expect(JSON.stringify(result)).not.toContain("restaurant-2");
  });
});

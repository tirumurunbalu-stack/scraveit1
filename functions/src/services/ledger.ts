import {db} from "../admin";
import {ROOT} from "../config";
import {
  createLedgerJournal,
  deterministicJournalId,
  resolveImmutableJournalWrite,
  validateLedgerJournal,
  type ImmutableJournalWrite,
  type LedgerJournal,
  type LedgerPostingInput,
} from "../domain/ledger";
import type {SavrivoOrder} from "../types";

/**
 * Client rules deny this entire subtree. Only trusted backend code may append
 * journals. Existing riderWallets/COD values remain a mutable compatibility
 * projection; this service deliberately never reads from or writes to them.
 */
export const LEDGER_JOURNALS_ROOT = `${ROOT}/private/financialLedger/journals`;

export interface LedgerTransactionSnapshot {
  val(): unknown;
}

export interface LedgerTransactionResult {
  committed: boolean;
  snapshot: LedgerTransactionSnapshot;
}

export interface LedgerTransactionReference {
  transaction(update: (current: unknown) => unknown): Promise<LedgerTransactionResult>;
}

export interface LedgerTransactionDatabase {
  ref(path: string): LedgerTransactionReference;
}

export type PersistedLedgerJournalResult = ImmutableJournalWrite & {readonly path: string};

export interface OrderDeliveryAmounts {
  /** Total customer consideration allocated by this delivery journal. */
  grossAmountPaise: number;
  restaurantPayablePaise: number;
  platformCommissionPaise: number;
  /** Platform-owned fees after separately recognizing statutory tax. */
  platformFeePaise: number;
  taxPayablePaise: number;
  riderDeliveryEarningPaise: number;
  riderTipPaise: number;
}

export interface OrderDeliveryJournalInput extends OrderDeliveryAmounts {
  orderId: string;
  restaurantId: string;
  riderId: string;
  occurredAt: number;
  actorId?: string;
}

export interface OnlineOrderDeliveryJournalInput extends OrderDeliveryJournalInput {
  paymentProvider: string;
  providerTransactionId: string;
}

export interface OnlinePaymentReceiptJournalInput {
  paymentId: string;
  orderId: string;
  paymentProvider: string;
  providerTransactionId: string;
  amountPaise: number;
  occurredAt: number;
}

export interface OnlinePaymentRefundJournalInput extends OnlinePaymentReceiptJournalInput {
  /** A delivered order has already released held funds to settlement accounts. */
  settlementReleased: boolean;
}

export type CodRemittanceMethod = "cash_deposit" | "bank_transfer" | "upi";

export interface CodRemittanceJournalInput {
  remittanceId: string;
  riderId: string;
  amountPaise: number;
  occurredAt: number;
  actorId: string;
  method: CodRemittanceMethod;
  referenceId?: string;
}

export interface CodEarningsOffsetJournalInput {
  adjustmentId: string;
  riderId: string;
  amountPaise: number;
  occurredAt: number;
  actorId: string;
  reason: string;
}

function moneyToPaise(value: number): number {
  const paise = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(paise) || paise < 0) fail("LEDGER_INVALID_ORDER_MONEY");
  return paise;
}

/**
 * Converts the server pricing snapshot into a balanced delivery allocation.
 * Platform fees are deliberately the residual after restaurant, rider and tip
 * obligations so rounding can never make the immutable journal unbalanced.
 */
export function orderDeliveryAmounts(
  order: Pick<SavrivoOrder, "total" | "pricing">,
  restaurantCommissionBps: number,
): OrderDeliveryAmounts {
  if (!Number.isSafeInteger(restaurantCommissionBps) || restaurantCommissionBps < 0 ||
    restaurantCommissionBps > 5_000) fail("LEDGER_INVALID_COMMISSION_BPS");
  const grossAmountPaise = moneyToPaise(order.total);
  const menuConsiderationPaise = Math.max(
    0,
    moneyToPaise(order.pricing.subtotal) - moneyToPaise(order.pricing.discount),
  );
  const platformCommissionPaise = Math.round(menuConsiderationPaise * restaurantCommissionBps / 10_000);
  const restaurantPayablePaise = menuConsiderationPaise - platformCommissionPaise;
  const riderDeliveryEarningPaise = moneyToPaise(order.pricing.deliveryFee);
  const riderTipPaise = moneyToPaise(order.pricing.tip);
  const taxPayablePaise = moneyToPaise(order.pricing.tax);
  const platformFeePaise = grossAmountPaise - restaurantPayablePaise - platformCommissionPaise -
    taxPayablePaise - riderDeliveryEarningPaise - riderTipPaise;
  if (platformFeePaise < 0) fail("LEDGER_ORDER_ALLOCATION_NEGATIVE_PLATFORM_RESIDUAL");
  return normalizedAmounts({
    grossAmountPaise,
    restaurantPayablePaise,
    platformCommissionPaise,
    platformFeePaise,
    taxPayablePaise,
    riderDeliveryEarningPaise,
    riderTipPaise,
  });
}

export async function persistCodOrderDeliveryLedger(
  order: SavrivoOrder,
  restaurantCommissionBps: number,
): Promise<PersistedLedgerJournalResult> {
  if (order.paymentMethod !== "cod" || order.status !== "Delivered" || !order.riderId) {
    fail("LEDGER_ORDER_NOT_DELIVERED_COD");
  }
  const existingJournalId = deterministicJournalId("cod_delivery", `order:${order.id}:delivered:cod`);
  const existingPath = `${LEDGER_JOURNALS_ROOT}/${existingJournalId}`;
  const existingSnapshot = await db.ref(existingPath).get();
  if (existingSnapshot.exists()) {
    const existing = persistedJournal(existingSnapshot.val());
    if (existing.eventType !== "cod_delivery" || existing.orderId !== order.id) {
      fail("LEDGER_IMMUTABLE_CONFLICT");
    }
    return {outcome: "idempotent", journal: existing, path: existingPath};
  }
  const amounts = orderDeliveryAmounts(order, restaurantCommissionBps);
  return persistLedgerJournal(buildCodOrderDeliveryJournal({
    ...amounts,
    orderId: order.id,
    restaurantId: order.restaurantId,
    riderId: order.riderId,
    occurredAt: Number(order.deliveredAt ?? order.updatedAt),
  }));
}

const COMPONENT_KEYS = [
  "restaurantPayablePaise",
  "platformCommissionPaise",
  "platformFeePaise",
  "taxPayablePaise",
  "riderDeliveryEarningPaise",
  "riderTipPaise",
] as const satisfies readonly (keyof OrderDeliveryAmounts)[];

function fail(code: string): never {
  throw new Error(code);
}

function requirePositivePaise(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail("LEDGER_INVALID_GROSS_AMOUNT_PAISE");
  return value;
}

function requireNonNegativePaise(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("LEDGER_INVALID_COMPONENT_AMOUNT_PAISE");
  return value;
}

function addPaise(total: number, amount: number): number {
  const result = total + amount;
  if (!Number.isSafeInteger(result)) fail("LEDGER_TOTAL_OVERFLOW");
  return result;
}

function normalizedAmounts(amounts: OrderDeliveryAmounts): OrderDeliveryAmounts {
  const normalized: OrderDeliveryAmounts = {
    grossAmountPaise: requirePositivePaise(amounts.grossAmountPaise),
    restaurantPayablePaise: requireNonNegativePaise(amounts.restaurantPayablePaise),
    platformCommissionPaise: requireNonNegativePaise(amounts.platformCommissionPaise),
    platformFeePaise: requireNonNegativePaise(amounts.platformFeePaise),
    taxPayablePaise: requireNonNegativePaise(amounts.taxPayablePaise),
    riderDeliveryEarningPaise: requireNonNegativePaise(amounts.riderDeliveryEarningPaise),
    riderTipPaise: requireNonNegativePaise(amounts.riderTipPaise),
  };
  const allocated = COMPONENT_KEYS.reduce(
    (total, key) => addPaise(total, normalized[key]),
    0,
  );
  if (allocated !== normalized.grossAmountPaise) fail("LEDGER_DELIVERY_ALLOCATION_MISMATCH");
  return normalized;
}

function allocationCredits(
  input: Pick<OrderDeliveryJournalInput, "restaurantId" | "riderId">,
  amounts: OrderDeliveryAmounts,
): LedgerPostingInput[] {
  const postings: LedgerPostingInput[] = [];
  const addCredit = (accountId: string, amountPaise: number, memo: string): void => {
    if (amountPaise > 0) postings.push({accountId, side: "credit", amountPaise, memo});
  };
  addCredit(
    `liability:restaurant-payable:${input.restaurantId}`,
    amounts.restaurantPayablePaise,
    "Restaurant settlement payable",
  );
  addCredit("revenue:platform-commission", amounts.platformCommissionPaise, "Platform commission earned");
  addCredit("revenue:platform-fees", amounts.platformFeePaise, "Platform fees earned");
  addCredit("liability:tax-payable", amounts.taxPayablePaise, "Tax collected and payable");
  addCredit(
    `liability:rider-earnings:${input.riderId}`,
    amounts.riderDeliveryEarningPaise,
    "Rider delivery earning payable",
  );
  addCredit(`liability:rider-tips:${input.riderId}`, amounts.riderTipPaise, "Rider tip payable");
  return postings;
}

function allocationMetadata(amounts: OrderDeliveryAmounts) {
  return {
    grossAmountPaise: amounts.grossAmountPaise,
    restaurantPayablePaise: amounts.restaurantPayablePaise,
    platformCommissionPaise: amounts.platformCommissionPaise,
    platformFeePaise: amounts.platformFeePaise,
    taxPayablePaise: amounts.taxPayablePaise,
    riderDeliveryEarningPaise: amounts.riderDeliveryEarningPaise,
    riderTipPaise: amounts.riderTipPaise,
  } as const;
}

/**
 * Records delivery-time COD allocation. The debit is the platform's claim on
 * cash held by the rider; a later cod_remittance journal clears that asset.
 */
export function buildCodOrderDeliveryJournal(input: OrderDeliveryJournalInput): LedgerJournal {
  const amounts = normalizedAmounts(input);
  return createLedgerJournal({
    eventType: "cod_delivery",
    eventId: `order:${input.orderId}:delivered:cod`,
    occurredAt: input.occurredAt,
    orderId: input.orderId,
    actorId: input.actorId ?? "system:order-delivery-ledger",
    metadata: {paymentMethod: "cod", ...allocationMetadata(amounts)},
    postings: [
      {
        accountId: `asset:cod-receivable:${input.riderId}`,
        side: "debit",
        amountPaise: amounts.grossAmountPaise,
        memo: "COD collected by rider",
      },
      ...allocationCredits(input, amounts),
    ],
  });
}

/**
 * Allocates previously verified and held online customer funds at delivery.
 * The gateway receipt is recorded separately when the verified callback is
 * accepted, so debiting gateway clearing again here would double-count cash.
 */
export function buildOnlineOrderDeliveryJournal(input: OnlineOrderDeliveryJournalInput): LedgerJournal {
  const amounts = normalizedAmounts(input);
  return createLedgerJournal({
    eventType: "payment",
    eventId: `order:${input.orderId}:delivered:online`,
    occurredAt: input.occurredAt,
    orderId: input.orderId,
    actorId: input.actorId ?? "system:order-delivery-ledger",
    metadata: {
      paymentMethod: "online",
      paymentProvider: input.paymentProvider,
      providerTransactionId: input.providerTransactionId,
      ...allocationMetadata(amounts),
    },
    postings: [
      {
        accountId: `liability:customer-order-funds:${input.orderId}`,
        side: "debit",
        amountPaise: amounts.grossAmountPaise,
        memo: "Release verified customer funds at delivery",
      },
      ...allocationCredits(input, amounts),
    ],
  });
}

/**
 * Records a verified gateway receipt exactly once. This journal only moves
 * cash into an order-scoped holding liability; restaurant/rider allocation is
 * intentionally deferred until the authoritative delivery transition.
 */
export function buildOnlinePaymentReceiptJournal(input: OnlinePaymentReceiptJournalInput): LedgerJournal {
  const amountPaise = requirePositivePaise(input.amountPaise);
  return createLedgerJournal({
    eventType: "payment",
    eventId: `provider:${input.paymentProvider}:payment:${input.providerTransactionId}`,
    occurredAt: input.occurredAt,
    orderId: input.orderId,
    actorId: `gateway:${input.paymentProvider}`,
    metadata: {
      paymentId: input.paymentId,
      paymentProvider: input.paymentProvider,
      providerTransactionId: input.providerTransactionId,
      ledgerStage: "gateway_receipt",
    },
    postings: [
      {
        accountId: `asset:payment-gateway-clearing:${input.paymentProvider}`,
        side: "debit",
        amountPaise,
        memo: "Verified customer payment received by gateway",
      },
      {
        accountId: `liability:customer-order-funds:${input.orderId}`,
        side: "credit",
        amountPaise,
        memo: "Customer funds held until fulfillment",
      },
    ],
  });
}

/**
 * Records a verified full refund without rewriting the receipt journal. Before
 * delivery it releases held order funds. After settlement release it creates
 * an explicit settlement-recovery asset for the later clawback/adjustment
 * workflow instead of pretending held funds still exist.
 */
export function buildOnlinePaymentRefundJournal(input: OnlinePaymentRefundJournalInput): LedgerJournal {
  const amountPaise = requirePositivePaise(input.amountPaise);
  return createLedgerJournal({
    eventType: "refund",
    eventId: `provider:${input.paymentProvider}:refund:${input.providerTransactionId}`,
    occurredAt: input.occurredAt,
    orderId: input.orderId,
    actorId: `gateway:${input.paymentProvider}`,
    metadata: {
      paymentId: input.paymentId,
      paymentProvider: input.paymentProvider,
      providerTransactionId: input.providerTransactionId,
      ledgerStage: "gateway_refund",
      settlementReleased: input.settlementReleased,
      requiresSettlementRecovery: input.settlementReleased,
    },
    postings: [
      {
        accountId: input.settlementReleased ?
          `asset:refund-settlement-recovery:${input.orderId}` :
          `liability:customer-order-funds:${input.orderId}`,
        side: "debit",
        amountPaise,
        memo: input.settlementReleased ?
          "Refund paid after settlement; recovery required" :
          "Release held customer funds for refund",
      },
      {
        accountId: `asset:payment-gateway-clearing:${input.paymentProvider}`,
        side: "credit",
        amountPaise,
        memo: "Verified customer refund paid by gateway",
      },
    ],
  });
}

/**
 * Records physical/electronic return of COD cash. The original delivery
 * journal remains untouched; this second journal clears only the rider's COD
 * receivable and therefore preserves a complete collection/remittance trail.
 */
export function buildCodRemittanceJournal(input: CodRemittanceJournalInput): LedgerJournal {
  const amountPaise = requirePositivePaise(input.amountPaise);
  if (!["cash_deposit", "bank_transfer", "upi"].includes(input.method)) {
    fail("LEDGER_INVALID_COD_REMITTANCE_METHOD");
  }
  return createLedgerJournal({
    eventType: "cod_remittance",
    eventId: `remittance:${input.remittanceId}`,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    metadata: {
      riderId: input.riderId,
      remittanceMethod: input.method,
      ...(input.referenceId ? {referenceId: input.referenceId} : {}),
    },
    postings: [
      {
        accountId: "asset:cod-settlement-clearing",
        side: "debit",
        amountPaise,
        memo: "COD remittance received",
      },
      {
        accountId: `asset:cod-receivable:${input.riderId}`,
        side: "credit",
        amountPaise,
        memo: "Rider COD outstanding cleared",
      },
    ],
  });
}

/**
 * Makes a permitted COD-to-earnings settlement explicit. It never rewrites or
 * deletes the rider earning created by the delivery journal; the offset is a
 * separate balanced adjustment with its own immutable operation identity.
 */
export function buildCodEarningsOffsetJournal(input: CodEarningsOffsetJournalInput): LedgerJournal {
  const amountPaise = requirePositivePaise(input.amountPaise);
  const reason = String(input.reason ?? "").trim();
  if (!reason || reason.length > 300) fail("LEDGER_INVALID_COD_ADJUSTMENT_REASON");
  return createLedgerJournal({
    eventType: "adjustment",
    eventId: `cod-offset:${input.adjustmentId}`,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    metadata: {
      riderId: input.riderId,
      adjustmentKind: "cod_against_rider_earnings",
      reason,
    },
    postings: [
      {
        accountId: `liability:rider-earnings:${input.riderId}`,
        side: "debit",
        amountPaise,
        memo: "Explicit COD settlement against rider earnings",
      },
      {
        accountId: `asset:cod-receivable:${input.riderId}`,
        side: "credit",
        amountPaise,
        memo: "Rider COD outstanding cleared by earnings offset",
      },
    ],
  });
}

export async function persistCodRemittanceLedger(
  input: CodRemittanceJournalInput,
  database: LedgerTransactionDatabase = db as unknown as LedgerTransactionDatabase,
): Promise<PersistedLedgerJournalResult> {
  return persistLedgerJournal(buildCodRemittanceJournal(input), database);
}

export async function persistCodEarningsOffsetLedger(
  input: CodEarningsOffsetJournalInput,
  database: LedgerTransactionDatabase = db as unknown as LedgerTransactionDatabase,
): Promise<PersistedLedgerJournalResult> {
  return persistLedgerJournal(buildCodEarningsOffsetJournal(input), database);
}

export function ledgerJournalPath(journal: Pick<LedgerJournal, "journalId">): string {
  if (!/^lj_[a-f0-9]{40}$/.test(journal.journalId)) fail("LEDGER_INVALID_JOURNAL_ID");
  return `${LEDGER_JOURNALS_ROOT}/${journal.journalId}`;
}

function persistedJournal(value: unknown): LedgerJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("LEDGER_INVALID_OR_TAMPERED_JOURNAL");
  }
  const journal = value as LedgerJournal;
  validateLedgerJournal(journal);
  return journal;
}

function serializableJournal(journal: LedgerJournal): LedgerJournal {
  return JSON.parse(JSON.stringify(journal)) as LedgerJournal;
}

/**
 * Appends one immutable journal through an RTDB transaction. Exact retries
 * return the stored value. Any different value at the deterministic path is
 * rejected; an existing journal is never replaced or merged.
 */
export async function persistLedgerJournal(
  candidate: LedgerJournal,
  database: LedgerTransactionDatabase = db as unknown as LedgerTransactionDatabase,
): Promise<PersistedLedgerJournalResult> {
  validateLedgerJournal(candidate);
  const path = ledgerJournalPath(candidate);
  const candidateValue = serializableJournal(candidate);
  let outcome: ImmutableJournalWrite["outcome"] | undefined;
  const result = await database.ref(path).transaction((current) => {
    if (current === null || current === undefined) {
      outcome = "insert";
      return candidateValue;
    }
    const existing = persistedJournal(current);
    const resolution = resolveImmutableJournalWrite(existing, candidate);
    outcome = resolution.outcome;
    // Abort an exact retry rather than issuing a no-op write. The transaction
    // snapshot still returns the authoritative stored journal for validation.
    return undefined;
  });
  if (!result.committed && outcome !== "idempotent") fail("LEDGER_TRANSACTION_ABORTED");
  const stored = persistedJournal(result.snapshot.val());
  resolveImmutableJournalWrite(stored, candidate);
  if (outcome !== "insert" && outcome !== "idempotent") fail("LEDGER_TRANSACTION_RESULT_MISMATCH");
  return {outcome, journal: stored, path};
}

import {db} from "../admin";
import {
  resolveImmutableJournalWrite,
  type LedgerJournal,
} from "../domain/ledger";
import {
  paymentCompatibilityProjection,
  type PaymentAggregate,
  type PaymentTransitionEvent,
} from "../domain/paymentState";
import type {SavrivoOrder} from "../types";
import {
  buildOnlineOrderDeliveryJournal,
  buildOnlinePaymentReceiptJournal,
  ledgerJournalPath,
  orderDeliveryAmounts,
  persistLedgerJournal,
  type LedgerTransactionResult,
  type PersistedLedgerJournalResult,
} from "./ledger";
import {canonicalPaymentPath} from "./payments";

interface OnlineDeliveryLedgerSnapshot {
  val(): unknown;
}

interface OnlineDeliveryLedgerReference {
  get(): Promise<OnlineDeliveryLedgerSnapshot>;
  transaction(update: (current: unknown) => unknown): Promise<LedgerTransactionResult>;
}

export interface OnlineDeliveryLedgerDatabase {
  ref(path: string): OnlineDeliveryLedgerReference;
}

interface StoredPaymentRecord {
  schemaVersion: 1;
  aggregate: PaymentAggregate;
  events: Record<string, PaymentTransitionEvent>;
}

function fail(code: string): never {
  throw new Error(code);
}

function safeReference(value: unknown, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(normalized)) fail(code);
  return normalized;
}

function amountPaise(order: Pick<SavrivoOrder, "total">): number {
  const amount = Math.round(Number(order.total) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0) fail("LEDGER_INVALID_ONLINE_ORDER_AMOUNT");
  return amount;
}

function storedPaymentRecord(value: unknown, order: SavrivoOrder): StoredPaymentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("LEDGER_ONLINE_PAYMENT_RECORD_MISSING");
  }
  const candidate = value as Partial<StoredPaymentRecord>;
  if (candidate.schemaVersion !== 1 || !candidate.aggregate) {
    fail("LEDGER_ONLINE_PAYMENT_RECORD_INVALID");
  }
  // Reuse the canonical payment-domain validation rather than trusting a
  // hand-picked subset of fields from the private record.
  paymentCompatibilityProjection(candidate.aggregate);
  const aggregate = candidate.aggregate;
  if (
    aggregate.orderId !== order.id ||
    aggregate.customerId !== order.customerId ||
    aggregate.method !== order.paymentMethod ||
    aggregate.currency !== "INR" ||
    aggregate.amountPaise !== amountPaise(order)
  ) {
    fail("LEDGER_ONLINE_PAYMENT_ORDER_MISMATCH");
  }
  if (
    aggregate.state !== "paid" ||
    aggregate.paidAmountPaise !== aggregate.amountPaise ||
    aggregate.refundedAmountPaise !== 0 ||
    order.paymentState !== "paid"
  ) {
    fail("LEDGER_ONLINE_PAYMENT_NOT_VERIFIED_PAID");
  }
  if (!aggregate.provider) fail("LEDGER_ONLINE_PAYMENT_PROVIDER_MISSING");
  if (!candidate.events || typeof candidate.events !== "object" || Array.isArray(candidate.events)) {
    fail("LEDGER_ONLINE_PAYMENT_VERIFICATION_EVENT_MISSING");
  }
  return {schemaVersion: 1, aggregate, events: candidate.events};
}

function verifiedPaidEvent(record: StoredPaymentRecord): PaymentTransitionEvent {
  const paidEvents = Object.values(record.events)
    .filter((event) => event?.newState === "paid")
    .sort((left, right) => left.revision - right.revision);
  if (paidEvents.length !== 1) fail("LEDGER_ONLINE_PAYMENT_VERIFICATION_EVENT_INVALID");
  const event = paidEvents[0];
  if (!event) fail("LEDGER_ONLINE_PAYMENT_VERIFICATION_EVENT_INVALID");
  if (
    event.schemaVersion !== 1 ||
    event.paymentId !== record.aggregate.paymentId ||
    event.orderId !== record.aggregate.orderId ||
    event.revision !== record.aggregate.revision ||
    event.occurredAt !== record.aggregate.updatedAt ||
    !record.aggregate.currentAttemptId ||
    event.attemptId !== record.aggregate.currentAttemptId ||
    !["initiated", "pending", "authorized"].includes(event.previousState) ||
    event.actor?.role !== "gateway" ||
    event.actor.id !== record.aggregate.provider ||
    !Number.isSafeInteger(event.occurredAt) ||
    event.occurredAt <= 0
  ) {
    fail("LEDGER_ONLINE_PAYMENT_VERIFICATION_EVENT_INVALID");
  }
  safeReference(event.providerReference, "LEDGER_ONLINE_PAYMENT_PROVIDER_REFERENCE_MISSING");
  return event;
}

function storedJournal(value: unknown): LedgerJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("LEDGER_ONLINE_PAYMENT_RECEIPT_MISSING");
  }
  return value as LedgerJournal;
}

/**
 * Releases a verified online payment's order-scoped holding liability only
 * after the canonical order reaches Delivered. Both the verified gateway
 * receipt and this allocation use deterministic immutable journals, so a
 * retried database trigger can never create a second settlement release.
 */
export async function persistOnlineOrderDeliveryLedger(
  order: SavrivoOrder,
  restaurantCommissionBps: number,
  database: OnlineDeliveryLedgerDatabase = db as unknown as OnlineDeliveryLedgerDatabase,
): Promise<PersistedLedgerJournalResult> {
  if (
    order.status !== "Delivered" ||
    order.paymentMethod === "cod" ||
    !["upi", "card"].includes(order.paymentMethod) ||
    !order.riderId
  ) {
    fail("LEDGER_ORDER_NOT_DELIVERED_ONLINE");
  }

  const record = storedPaymentRecord(
    (await database.ref(canonicalPaymentPath(order.id)).get()).val(),
    order,
  );
  const paidEvent = verifiedPaidEvent(record);
  const provider = safeReference(record.aggregate.provider, "LEDGER_ONLINE_PAYMENT_PROVIDER_MISSING");
  const providerTransactionId = safeReference(
    paidEvent.providerReference,
    "LEDGER_ONLINE_PAYMENT_PROVIDER_REFERENCE_MISSING",
  );

  // A canonical `paid` state commits before the immutable receipt journal.
  // Delivery settlement therefore verifies that the holding liability was
  // actually created, rather than releasing money from an unposted receipt.
  const expectedReceipt = buildOnlinePaymentReceiptJournal({
    paymentId: record.aggregate.paymentId,
    orderId: order.id,
    paymentProvider: provider,
    providerTransactionId,
    amountPaise: record.aggregate.amountPaise,
    occurredAt: paidEvent.occurredAt,
  });
  const receipt = storedJournal((await database.ref(ledgerJournalPath(expectedReceipt)).get()).val());
  resolveImmutableJournalWrite(receipt, expectedReceipt);

  const amounts = orderDeliveryAmounts(order, restaurantCommissionBps);
  return persistLedgerJournal(buildOnlineOrderDeliveryJournal({
    ...amounts,
    orderId: order.id,
    restaurantId: order.restaurantId,
    riderId: order.riderId,
    occurredAt: Number(order.deliveredAt ?? order.updatedAt),
    paymentProvider: provider,
    providerTransactionId,
  }), database);
}

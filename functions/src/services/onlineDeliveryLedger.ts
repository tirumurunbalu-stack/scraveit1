import {firestoreDb} from "../admin";
import {
  createLedgerJournal,
  resolveImmutableJournalWrite,
  type LedgerJournal,
} from "../domain/ledger";
import {chargedAfterPickup} from "../domain/foodRescue";
import {chargedCancelFee} from "../domain/customerCancel";
import {cancelledAtOf} from "../domain/partnerCancelPay";
import {
  paymentCompatibilityProjection,
  type PaymentAggregate,
  type PaymentTransitionEvent,
} from "../domain/paymentState";
import type {FirestoreLike} from "../firestoreTypes";
import type {SavrivoOrder} from "../types";
import {
  LEDGER_JOURNALS_COLLECTION,
  buildCustomerCancelFeeJournal,
  buildOnlineOrderDeliveryJournal,
  buildOnlinePaymentReceiptJournal,
  type OrderDeliveryAmounts,
  orderDeliveryAmounts,
  type DeliveryLedgerOptions,
  persistLedgerJournal,
  validatedLedgerJournalId,
  type PersistedLedgerJournalResult,
} from "./ledger";
import {canonicalPaymentRef} from "./payments";

export type OnlineDeliveryLedgerDatabase = FirestoreLike;

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
  database: OnlineDeliveryLedgerDatabase = firestoreDb as unknown as OnlineDeliveryLedgerDatabase,
  options: DeliveryLedgerOptions = {},
): Promise<PersistedLedgerJournalResult> {
  if (
    // Cancelled after pickup on the customer's side is settled exactly as if delivered (founder 22 Nov 2026).
    (order.status !== "Delivered" && !chargedAfterPickup(order)) ||
    order.paymentMethod === "cod" ||
    !["upi", "card"].includes(order.paymentMethod) ||
    !order.riderId ||
    order.foodRescue
  ) {
    fail("LEDGER_ORDER_NOT_DELIVERED_ONLINE");
  }
  const {provider, providerTransactionId} = await verifiedOnlineReceipt(order, database);
  const amounts = orderDeliveryAmounts(order, restaurantCommissionBps, {finalTripPayPaise: options.finalTripPayPaise});
  return persistLedgerJournal(buildOnlineOrderDeliveryJournal({
    ...amounts,
    orderId: order.id,
    restaurantId: order.restaurantId,
    riderId: order.riderId,
    customerId: order.customerId,
    ...(options.attribution ? {attribution: options.attribution} : {}),
    occurredAt: Number(order.deliveredAt ?? order.updatedAt),
    paymentProvider: provider,
    providerTransactionId,
    ...(order.selfDelivery === true ? {storeDelivered: true} : {}),
  }), database);
}

/**
 * The customer cancelled with the 100% fee before pickup (domain/customerCancel.ts): the verified
 * payment is released as at delivery, with the trip's share kept by Scraveit (services/ledger.ts).
 */
export async function persistCustomerCancelFeeLedger(
  order: SavrivoOrder,
  amounts: OrderDeliveryAmounts,
  database: OnlineDeliveryLedgerDatabase = firestoreDb as unknown as OnlineDeliveryLedgerDatabase,
): Promise<PersistedLedgerJournalResult> {
  if (!chargedCancelFee(order) || !["upi", "card"].includes(order.paymentMethod) || order.foodRescue) {
    fail("LEDGER_ORDER_NOT_CANCEL_FEE");
  }
  const {provider, providerTransactionId} = await verifiedOnlineReceipt(order, database);
  return persistLedgerJournal(buildCustomerCancelFeeJournal({
    ...amounts,
    orderId: order.id,
    restaurantId: order.restaurantId,
    customerId: order.customerId,
    occurredAt: cancelledAtOf(order),
    paymentProvider: provider,
    providerTransactionId,
    reason: String(order.cancelReason ?? ""),
  }), database);
}

/**
 * A Food Rescue order delivered (domain/foodRescue.ts): the buyer's money is released, the
 * delivery fee to the partner as their trip pay and the food price to Scraveit
 * (revenue:food-rescue). The restaurant was already paid on the cancelled order.
 * GST on this resale is left for the CA to decide: it is not booked here.
 */
export function buildFoodRescueDeliveryJournal(input: {
  orderId: string;
  fromOrderId: string;
  riderId: string;
  grossAmountPaise: number;
  riderDeliveryEarningPaise: number;
  occurredAt: number;
  paymentProvider: string;
  providerTransactionId: string;
}): LedgerJournal {
  const rider = Math.max(0, Math.min(input.grossAmountPaise, Math.round(input.riderDeliveryEarningPaise)));
  const food = input.grossAmountPaise - rider;
  return createLedgerJournal({
    eventType: "payment",
    eventId: `order:${input.orderId}:delivered:food-rescue`,
    occurredAt: Math.round(input.occurredAt),
    orderId: input.orderId,
    actorId: "system:order-delivery-ledger",
    metadata: {
      paymentMethod: "online",
      paymentProvider: input.paymentProvider,
      providerTransactionId: input.providerTransactionId,
      settlementType: "food_rescue",
      fromOrderId: input.fromOrderId,
      grossAmountPaise: input.grossAmountPaise,
      riderDeliveryEarningPaise: rider,
      foodRescuePaise: food,
      gstTreatment: "pending_ca_review",
    },
    postings: [
      {
        accountId: `liability:customer-order-funds:${input.orderId}`,
        side: "debit",
        amountPaise: input.grossAmountPaise,
        memo: "Release Food Rescue buyer funds at delivery",
      },
      ...(rider > 0 ? [{
        accountId: `liability:rider-earnings:${input.riderId}`,
        side: "credit" as const,
        amountPaise: rider,
        memo: "Food Rescue delivery earning payable",
      }] : []),
      ...(food > 0 ? [{
        accountId: "revenue:food-rescue",
        side: "credit" as const,
        amountPaise: food,
        memo: "Food Rescue food sale",
      }] : []),
    ],
  });
}

export async function persistFoodRescueDeliveryLedger(
  order: SavrivoOrder,
  database: OnlineDeliveryLedgerDatabase = firestoreDb as unknown as OnlineDeliveryLedgerDatabase,
): Promise<PersistedLedgerJournalResult> {
  if (!order.foodRescue || (order.status !== "Delivered" && !chargedAfterPickup(order)) ||
    !["upi", "card"].includes(order.paymentMethod) || !order.riderId) {
    fail("LEDGER_FOOD_RESCUE_NOT_DELIVERED");
  }
  const {provider, providerTransactionId} = await verifiedOnlineReceipt(order, database);
  return persistLedgerJournal(buildFoodRescueDeliveryJournal({
    orderId: order.id,
    fromOrderId: order.foodRescue.fromOrderId,
    riderId: order.riderId,
    grossAmountPaise: amountPaise(order),
    riderDeliveryEarningPaise: Math.round(Number(order.pricing.deliveryFee) * 100),
    occurredAt: Number(order.deliveredAt ?? order.updatedAt),
    paymentProvider: provider,
    providerTransactionId,
  }), database);
}

/** The verified gateway receipt behind an online order, checked against its posted receipt journal. */
async function verifiedOnlineReceipt(
  order: SavrivoOrder,
  database: OnlineDeliveryLedgerDatabase,
): Promise<{provider: string; providerTransactionId: string}> {
  const paymentSnapshot = await canonicalPaymentRef(database, order.id).get();
  const record = storedPaymentRecord(paymentSnapshot.exists ? paymentSnapshot.data() : null, order);
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
  const receiptSnapshot = await database.collection(LEDGER_JOURNALS_COLLECTION)
    .doc(validatedLedgerJournalId(expectedReceipt))
    .get();
  const receipt = storedJournal(receiptSnapshot.exists ? receiptSnapshot.data() : null);
  resolveImmutableJournalWrite(receipt, expectedReceipt);
  return {provider, providerTransactionId};
}

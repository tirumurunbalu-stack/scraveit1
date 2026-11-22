import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {SavrivoOrder} from "../src/types";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}, storage: {}, auth: {}, messaging: {}};
});
vi.mock("../src/services/authz", () => ({
  authorizeTransition: vi.fn(async () => "customer"),
  requireApprovedRider: vi.fn(async () => ({})),
}));
vi.mock("../src/services/orderProjection", () => ({
  reconcileRestaurantOrderProjection: vi.fn(async () => undefined),
}));
vi.mock("../src/services/workload", () => ({
  reconcileRestaurantWorkload: vi.fn(async () => undefined),
}));

const {firestoreDb} = await import("../src/admin");
const {buildOrderTransitionCandidate, canTransition} = await import("../src/domain/order");
const cancel = await import("../src/domain/customerCancel");
const {afterPickupPlan} = await import("../src/domain/foodRescue");
const {buildOrderCancelledNotice} = await import("../src/domain/notificationMessages");
const {buildCustomerCancelFeeJournal} = await import("../src/services/ledger");
const {buildCustomerCancelFeeRestaurantJournal} = await import("../src/services/customerCancelFee");
const {cancelOrderByCustomer, transitionOrder} = await import("../src/services/orders");
const {refundCancelledOrderPayment} = await import("../src/services/payments");
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore;
const NOW = Date.now() - 60_000;
const ID = "100000000000077";
const CUSTOMER = "cust-1";

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: ID,
    schemaVersion: 3,
    idempotencyKey: "key-0123456789abcdef",
    customerId: CUSTOMER,
    customerName: "Asha",
    customerPhone: "9999999999",
    restaurantId: "rest-1",
    restaurant: "Spicy Box",
    restaurantLocation: {address: "Store", lat: 14.44, lng: 79.98},
    items: [{itemId: "i1", name: "Chicken Biryani", quantity: 1, price: 200, variant: "", variantPrice: 0, addOns: [], addOnTotal: 0, note: "", diet: "nonveg"}],
    pricing: {subtotal: 200, discount: 0, deliveryFee: 35, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0,
      riderIncentiveFee: 0, platformFee: 5, tax: 10, tip: 0, currency: "INR", source: "catalog_snapshot_v3"},
    pricingContext: {distanceKm: 3, platformFeeRule: "server_authoritative", weatherSeverity: "", surgeActiveOrders: 0, pricedAt: NOW},
    total: 250,
    coupon: "",
    paymentMethod: "upi",
    paymentProvider: "cashfree",
    paymentState: "paid",
    deliveryMode: "asap",
    address: {id: "a1", label: "Home", area: "Magunta", address: "1 Main Rd", phone: "9999999999", source: "manual",
      updatedAt: NOW, lat: 14.45, lng: 79.99, city: "Nellore"},
    instructions: "",
    contactless: false,
    status: "Accepted",
    statusHistory: {},
    createdAt: NOW - 600_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  } as SavrivoOrder;
}

const stored = () => database.read(`orders/${ID}`) as SavrivoOrder;
const noPayments = vi.fn(async () => undefined);

beforeEach(async () => {
  for (const path of database.paths()) await database.doc(path).delete();
  noPayments.mockClear();
});

describe("customer's own cancel: when the 100% fee applies", () => {
  it("is free before the restaurant accepts, 100% of the total from Accept until delivery", () => {
    expect(cancel.customerCancelFee(order({status: "Order placed"}), NOW)).toBeNull();
    for (const status of ["Accepted", "Preparing", "Ready for pickup", "Assigned", "Handed to rider", "Out for delivery", "Near you", "Arrived"] as const) {
      expect(cancel.customerCancelFee(order({status}), NOW)).toEqual({percent: 100, amountPaise: 25_000, acceptedAt: NOW});
    }
    expect(cancel.customerCancelFee(order({status: "Delivered"}), NOW)).toBeNull();
    expect(cancel.customerCancelFee(order({status: "Cancelled"}), NOW)).toBeNull();
  });
  it("names the reason so reports and the after-pickup rules read it the same way", () => {
    expect(cancel.customerCancelReason("Order placed", false)).toBe("Customer cancelled before the restaurant accepted");
    expect(cancel.customerCancelReason("Preparing", true)).toBe("Customer cancelled after the restaurant accepted");
    expect(cancel.customerCancelReason("Out for delivery", true)).toBe("Customer cancelled after pickup");
  });
  it("lets the customer (not the restaurant or the system) cancel once the partner has the food", () => {
    for (const from of ["Handed to rider", "Out for delivery", "Near you", "Arrived"] as const) {
      expect(canTransition(from, "Cancelled", "customer")).toBe(true);
      expect(canTransition(from, "Cancelled", "staff")).toBe(false);
      expect(canTransition(from, "Cancelled", "system")).toBe(false);
    }
    expect(canTransition("Delivered", "Cancelled", "customer")).toBe(false);
  });
  it("stamps the accepted fee on the cancelled order", () => {
    const fee = {percent: 100, amountPaise: 25_000, acceptedAt: NOW};
    const before = order({status: "Preparing"});
    const after = buildOrderTransitionCandidate(before, before, {
      toStatus: "Cancelled", actorRole: "customer", eventId: "e1",
      event: {status: "Cancelled", at: NOW, actorId: CUSTOMER, actorRole: "customer"}, now: NOW,
      reason: "Customer cancelled after the restaurant accepted", cancellationFee: fee,
    });
    expect(after).toMatchObject({status: "Cancelled", statusBeforeTerminal: "Preparing", cancelledByRole: "customer", cancellationFee: fee});
  });
});

describe("customer's own cancel: the money", () => {
  const fee = {percent: 100, amountPaise: 25_000, acceptedAt: NOW};
  const cancelledWithFee = (overrides: Partial<SavrivoOrder> = {}) => order({
    status: "Cancelled", statusBeforeTerminal: "Preparing", cancelledByRole: "customer",
    cancelReason: "Customer cancelled after the restaurant accepted", cancellationFee: fee, ...overrides,
  });
  it("keeps an online payment (no refund) and turns cash on delivery off for a cash order", () => {
    expect(cancel.chargedCancelFee(cancelledWithFee())).toBe(true);
    expect(cancel.keptOnCancel(cancelledWithFee())).toBe(true);
    const cash = cancelledWithFee({paymentMethod: "cod", paymentState: "pending"});
    expect(cancel.chargedCancelFee(cash)).toBe(false);
    expect(cancel.cancelledWithFeeBeforePickup(cash)).toBe(true);
  });
  it("leaves free cancels and every older cancel refunded as before", () => {
    expect(cancel.keptOnCancel(cancelledWithFee({cancellationFee: undefined}))).toBe(false);
    expect(cancel.keptOnCancel(order({status: "Cancelled", statusBeforeTerminal: "Preparing", cancelledByRole: "customer"}))).toBe(false);
    expect(cancel.keptOnCancel(order({status: "Cancelled", statusBeforeTerminal: "Preparing", cancelledByRole: "staff"}))).toBe(false);
  });
  it("after pickup follows the cancel-after-pickup rules: charged online, cash on delivery off for cash", () => {
    const picked = cancelledWithFee({statusBeforeTerminal: "Out for delivery", cancelReason: "Customer cancelled after pickup"});
    expect(cancel.cancelledWithFeeBeforePickup(picked)).toBe(false);
    expect(afterPickupPlan(picked)).toMatchObject({cause: "customer", charged: true, refund: false});
    expect(cancel.keptOnCancel(picked)).toBe(true);
    expect(afterPickupPlan({...picked, paymentMethod: "cod", paymentState: "pending"})).toMatchObject({cause: "customer", charged: false, blockCod: true});
  });
  it("never refunds a charged cancel", async () => {
    database.seed(`orders/${ID}`, cancelledWithFee());
    const gateway = {provider: "cashfree", refund: vi.fn()} as never;
    expect(await refundCancelledOrderPayment(ID, gateway, database as never)).toBe("charged_cancel_fee");
  });
  it("pays the restaurant as delivered and keeps the delivery fee and tip, with Scraveit's top-up unspent", () => {
    const journal = buildCustomerCancelFeeJournal({
      orderId: ID, restaurantId: "rest-1", customerId: CUSTOMER, occurredAt: NOW,
      paymentProvider: "cashfree", providerTransactionId: "cf-1", reason: "Customer cancelled after the restaurant accepted",
      grossAmountPaise: 26_000, restaurantPayablePaise: 17_000, platformCommissionPaise: 3_000, platformFeePaise: 500,
      taxPayablePaise: 1_000, riderDeliveryEarningPaise: 4_000, riderTipPaise: 1_000, riderTripSubsidyPaise: 500,
      platformPromotionPaise: 0,
    });
    const sum = (side: "debit" | "credit") => journal.entries.filter((e) => e.side === side).reduce((t, e) => t + e.amountPaise, 0);
    const credit = (account: string) => journal.entries.filter((e) => e.accountId === account && e.side === "credit")
      .reduce((t, e) => t + e.amountPaise, 0);
    expect(sum("debit")).toBe(26_000);
    expect(sum("credit")).toBe(26_000);
    expect(credit("liability:restaurant-payable:rest-1")).toBe(17_000);
    expect(credit("revenue:cancellation-fees")).toBe(4_500);
    expect(journal.entries.some((e) => e.accountId.startsWith("liability:rider"))).toBe(false);
    expect(journal.entries.some((e) => e.accountId === "expense:rider-trip-subsidy")).toBe(false);
    expect(journal.eventId).toBe(`order:${ID}:cancelled:fee`);
  });
  it("on a cash order, Scraveit pays the restaurant itself", () => {
    const journal = buildCustomerCancelFeeRestaurantJournal({orderId: ID, restaurantId: "rest-1", amountPaise: 17_000, occurredAt: NOW, reason: "x"});
    expect(journal.entries.map((e) => [e.accountId, e.side, e.amountPaise])).toEqual([
      ["expense:customer-cancel-fee", "debit", 17_000],
      ["liability:restaurant-payable:rest-1", "credit", 17_000],
    ]);
  });
  it("tells the restaurant it is paid in full", () => {
    const notice = buildOrderCancelledNotice({order: cancelledWithFee(), audience: "restaurant", customerCause: true});
    expect(notice.notification?.body).toContain("You are paid for this order as if it was delivered");
    const free = buildOrderCancelledNotice({order: cancelledWithFee({cancellationFee: undefined}), audience: "restaurant", customerCause: true});
    expect(free.notification?.body).toBe("The customer cancelled it. Please don't prepare or hand it over.");
  });
});

describe("customer's own cancel: Cancel order in the app", () => {
  it("shows the fee first when the restaurant has accepted and the customer hasn't agreed to it", async () => {
    database.seed(`orders/${ID}`, order({status: "Accepted"}));
    const result = await cancelOrderByCustomer(CUSTOMER, ID, false, noPayments);
    expect(result.feeRequired).toBe(true);
    expect(stored().status).toBe("Accepted");
  });
  it("cancels with the 100% fee once accepted", async () => {
    database.seed(`orders/${ID}`, order({status: "Preparing"}));
    const result = await cancelOrderByCustomer(CUSTOMER, ID, true, noPayments);
    expect(result.cancellationFee).toMatchObject({percent: 100, amountPaise: 25_000});
    expect(stored()).toMatchObject({status: "Cancelled", statusBeforeTerminal: "Preparing", cancelledByRole: "customer",
      cancelReason: "Customer cancelled after the restaurant accepted", cancellationFee: {percent: 100, amountPaise: 25_000}});
  });
  it("is free before the restaurant accepts, even if the app offered the fee", async () => {
    database.seed(`orders/${ID}`, order({status: "Order placed"}));
    const result = await cancelOrderByCustomer(CUSTOMER, ID, true, noPayments);
    expect(result.cancellationFee).toBeUndefined();
    expect(stored()).toMatchObject({status: "Cancelled", cancelledByRole: "customer", cancelReason: "Customer cancelled before the restaurant accepted"});
    expect(stored().cancellationFee).toBeUndefined();
  });
  it("after pickup uses the after-pickup customer reason, so Food Rescue and the partner's full trip follow", async () => {
    database.seed(`orders/${ID}`, order({status: "Out for delivery", riderId: "rider-1"}));
    await cancelOrderByCustomer(CUSTOMER, ID, true, noPayments);
    expect(stored()).toMatchObject({status: "Cancelled", statusBeforeTerminal: "Out for delivery", cancelReason: "Customer cancelled after pickup"});
    expect(afterPickupPlan(stored())).toMatchObject({cause: "customer", charged: true});
  });
  it("closes an unpaid online payment instead of charging anything", async () => {
    database.seed(`orders/${ID}`, order({status: "Order placed", paymentState: "pending"}));
    await cancelOrderByCustomer(CUSTOMER, ID, false, noPayments);
    expect(noPayments).toHaveBeenCalledWith(ID);
    expect(stored()).toMatchObject({status: "Cancelled", cancelledByRole: "system"});
  });
  it("refuses a delivered order and anyone else's order, and repeats safely", async () => {
    database.seed(`orders/${ID}`, order({status: "Delivered"}));
    await expect(cancelOrderByCustomer(CUSTOMER, ID, true, noPayments)).rejects.toThrow("already delivered");
    database.seed(`orders/${ID}`, order({status: "Accepted"}));
    await expect(cancelOrderByCustomer("someone-else", ID, true, noPayments)).rejects.toThrow("Order not found");
    await cancelOrderByCustomer(CUSTOMER, ID, true, noPayments);
    const again = await cancelOrderByCustomer(CUSTOMER, ID, true, noPayments);
    expect(again.order.status).toBe("Cancelled");
    expect(again.cancellationFee).toMatchObject({percent: 100});
  });
  it("can't skip the fee through the plain status call", async () => {
    database.seed(`orders/${ID}`, order({status: "Preparing"}));
    const token = {uid: CUSTOMER} as unknown as DecodedIdToken;
    await expect(transitionOrder(CUSTOMER, token, {customerId: CUSTOMER, orderId: ID, toStatus: "Cancelled", reason: "Other", cashCollected: false}))
      .rejects.toThrow("cancellation fee");
    expect(stored().status).toBe("Preparing");
  });
});

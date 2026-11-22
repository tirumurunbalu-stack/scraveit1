import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}, storage: {}, auth: {}, messaging: {}};
});

const {canTransition} = await import("../src/domain/order");
const {partnerCancelPayDecision} = await import("../src/domain/partnerCancelPay");
const {isAfterPickupCancelReason, isAfterPickupStatus} = await import("../src/domain/afterPickup");
const rescue = await import("../src/domain/foodRescue");
const {buildOrderCancelledNotice, cancelNoticeTargets} = await import("../src/domain/notificationMessages");
const {buildFoodRescueDeliveryJournal} = await import("../src/services/onlineDeliveryLedger");
const {buildAfterPickupPartnerJournal, buildAfterPickupRestaurantJournal} = await import("../src/services/afterPickupCancel");
const {rescueAlertCopy, rescueAudience} = await import("../src/services/foodRescue");
import type {SavrivoOrder} from "../src/types";

const NOW = 1_800_000_000_000;
const PARTNER = {lat: 14.4426, lng: 79.9865};
/** About 1 km north of the partner. */
const NEAR = {lat: 14.4516, lng: 79.9865};
/** About 5 km north. */
const FAR = {lat: 14.4876, lng: 79.9865};

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "100000000000001",
    schemaVersion: 3,
    idempotencyKey: "key-0123456789abcdef",
    customerId: "cust-1",
    customerName: "Asha",
    customerPhone: "9999999999",
    restaurantId: "rest-1",
    restaurant: "Spicy Box",
    restaurantLocation: {address: "Store", lat: 14.44, lng: 79.98},
    items: [
      {itemId: "i1", name: "Chicken Biryani", quantity: 1, price: 200, variant: "", variantPrice: 0, addOns: [], addOnTotal: 0, note: "", diet: "nonveg"},
      {itemId: "i2", name: "Raita", quantity: 2, price: 30, variant: "", variantPrice: 0, addOns: [], addOnTotal: 0, note: "", diet: "veg"},
    ],
    pricing: {subtotal: 260, discount: 0, deliveryFee: 35, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0,
      riderIncentiveFee: 0, platformFee: 5, tax: 13, tip: 0, currency: "INR", source: "catalog_snapshot_v3"},
    pricingContext: {distanceKm: 3, platformFeeRule: "server_authoritative", weatherSeverity: "", surgeActiveOrders: 0, pricedAt: NOW},
    total: 313,
    coupon: "",
    paymentMethod: "upi",
    paymentProvider: "cashfree",
    paymentState: "paid",
    deliveryMode: "asap",
    address: {id: "a1", label: "Home", area: "Magunta", address: "1 Main Rd", phone: "9999999999", source: "manual",
      updatedAt: NOW, lat: 14.45, lng: 79.99, city: "Nellore"},
    instructions: "",
    contactless: false,
    status: "Cancelled",
    statusBeforeTerminal: "Out for delivery",
    cancelledByRole: "ops_admin",
    cancelReason: "Customer cancelled after pickup",
    riderId: "rider-1",
    riderName: "Ravi",
    statusHistory: {},
    createdAt: NOW - 1_800_000,
    updatedAt: NOW,
    etaMin: 30,
    etaMax: 40,
    ...overrides,
  } as SavrivoOrder;
}

describe("cancel after pickup: who can cancel", () => {
  it("Scraveit's admin, or the customer with the 100% fee, once the partner has the food", () => {
    for (const from of ["Handed to rider", "Out for delivery", "Near you", "Arrived"] as const) {
      expect(isAfterPickupStatus(from)).toBe(true);
      expect(canTransition(from, "Cancelled", "owner")).toBe(true);
      expect(canTransition(from, "Cancelled", "ops_admin")).toBe(true);
      // The customer's own Cancel order, with the fee (test/customerCancel.test.ts).
      expect(canTransition(from, "Cancelled", "customer")).toBe(true);
      expect(canTransition(from, "Cancelled", "staff")).toBe(false);
      expect(canTransition(from, "Cancelled", "system")).toBe(false);
    }
    // Before pickup nothing changed.
    expect(canTransition("Preparing", "Cancelled", "customer")).toBe(true);
    expect(canTransition("Delivered", "Cancelled", "owner")).toBe(false);
  });
  it("needs one of the three fixed reasons", () => {
    expect(isAfterPickupCancelReason("Customer cancelled after pickup")).toBe(true);
    expect(isAfterPickupCancelReason("customer not reachable at door")).toBe(true);
    expect(isAfterPickupCancelReason("Delivery problem")).toBe(true);
    expect(isAfterPickupCancelReason("Duplicate order")).toBe(false);
    expect(isAfterPickupCancelReason("")).toBe(false);
  });
});

describe("cancel after pickup: the money", () => {
  it("online, the customer's side: no refund, settled as delivered", () => {
    expect(rescue.afterPickupPlan(order())).toEqual({cause: "customer", charged: true, refund: false, scraveitPays: false, blockCod: false});
    expect(rescue.afterPickupPlan(order({cancelReason: "Customer not reachable at door"}))?.charged).toBe(true);
    expect(rescue.chargedAfterPickup(order())).toBe(true);
  });
  it("cash, the customer's side: Scraveit pays and cash on delivery goes off", () => {
    const plan = rescue.afterPickupPlan(order({paymentMethod: "cod", paymentState: "cash_due"}));
    expect(plan).toEqual({cause: "customer", charged: false, refund: false, scraveitPays: true, blockCod: true});
  });
  it("delivery problem: full refund, Scraveit pays the restaurant and the partner", () => {
    expect(rescue.afterPickupPlan(order({cancelReason: "Delivery problem"})))
      .toEqual({cause: "scraveit", charged: false, refund: true, scraveitPays: true, blockCod: false});
    expect(rescue.afterPickupPlan(order({cancelReason: "Delivery problem", paymentMethod: "cod", paymentState: "cash_due"}))?.blockCod).toBe(false);
  });
  it("leaves every other cancel alone", () => {
    expect(rescue.afterPickupPlan(order({statusBeforeTerminal: "Preparing"}))).toBeNull();
    expect(rescue.afterPickupPlan(order({status: "Delivered"}))).toBeNull();
    expect(rescue.chargedAfterPickup(order({statusBeforeTerminal: "Assigned"}))).toBe(false);
  });
  it("pays the partner the full trip, not ₹15", () => {
    const decision = partnerCancelPayDecision({order: order(), arrival: {status: "verified", riderId: "rider-1", arrivedAt: 1}, cancelledAt: NOW});
    expect(decision).toEqual({payPaise: 0, outcome: "after_pickup", cause: "customer"});
  });
  it("posts Scraveit's payments to the restaurant and the partner once each", () => {
    const restaurantJournal = buildAfterPickupRestaurantJournal({orderId: "100000000000001", restaurantId: "rest-1",
      amountPaise: 23_400, occurredAt: NOW, paymentMethod: "cod", reason: "Customer cancelled after pickup"});
    expect(restaurantJournal.eventId).toBe("after-pickup-cancel:restaurant:100000000000001");
    expect(restaurantJournal.entries.find((entry) => entry.side === "credit"))
      .toMatchObject({accountId: "liability:restaurant-payable:rest-1", amountPaise: 23_400});
    expect(restaurantJournal.entries.find((entry) => entry.side === "debit")?.accountId).toBe("expense:cancel-after-pickup");
    expect(restaurantJournal.metadata.settlementType).toBe("cancel_after_pickup");
    const partnerJournal = buildAfterPickupPartnerJournal({orderId: "100000000000001", riderId: "rider-1", amountPaise: 3_500,
      occurredAt: NOW, cause: "customer"});
    expect(partnerJournal.eventId).toBe("after-pickup-cancel:partner:100000000000001");
    expect(partnerJournal.entries.find((entry) => entry.side === "credit"))
      .toMatchObject({accountId: "liability:rider-earnings:rider-1", amountPaise: 3_500});
    expect(partnerJournal.journalId).toBe(buildAfterPickupPartnerJournal({orderId: "100000000000001", riderId: "rider-1",
      amountPaise: 3_500, occurredAt: NOW, cause: "customer"}).journalId);
  });
});

describe("cancel after pickup: what people are told", () => {
  it("tells the partner to wait when the food is offered nearby", () => {
    const notice = buildOrderCancelledNotice({order: order(), audience: "partner", customerCause: true, partnerPayPaise: 3_500,
      afterPickup: {rescue: true}});
    expect(notice.notification?.body).toBe("Spicy Box: the customer cancelled. You get ₹35 for the full trip. " +
      "Please wait where you are for up to 15 min. A customer nearby may buy this food.");
  });
  it("tells the partner the food is theirs when it isn't offered", () => {
    const notice = buildOrderCancelledNotice({order: order({cancelReason: "Delivery problem"}), audience: "partner",
      customerCause: false, partnerPayPaise: 3_550, afterPickup: {rescue: false}});
    expect(notice.notification?.body).toBe("Spicy Box: cancelled after pickup. You get ₹35.50 for the full trip. The food is yours to keep.");
  });
  it("tells the restaurant it is paid in full", () => {
    const notice = buildOrderCancelledNotice({order: order(), audience: "restaurant", customerCause: true, afterPickup: {rescue: true}});
    expect(notice.notification?.body).toBe("It was cancelled after pickup. You are paid for this order as if it was delivered.");
  });
  it("never tells a store about a Food Rescue buy", () => {
    const buy = order({foodRescue: {fromOrderId: "x", offerExpiresAt: NOW, menuPaise: 1, foodPaise: 1}, cancelledByRole: "system",
      statusBeforeTerminal: "Out for delivery"});
    expect(cancelNoticeTargets(buy).restaurant).toBe(false);
    expect(cancelNoticeTargets(order()).restaurant).toBe(true);
  });
});

describe("Food Rescue: which cancels become an offer", () => {
  const point = {...PARTNER, updatedAt: NOW - 30_000};
  const check = (o: SavrivoOrder, extra: Partial<Parameters<typeof rescue.rescueEligibility>[1]> = {}) =>
    rescue.rescueEligibility(o, {storeKind: "restaurant", partnerPoint: point, now: NOW, ...extra});

  it("offers restaurant food cancelled on the customer's side", () => {
    expect(check(order())).toEqual({ok: true});
    expect(check(order({paymentMethod: "cod", paymentState: "cash_due"}))).toEqual({ok: true});
  });
  it("skips Scraveit's own problems, groceries, medicines and dairy", () => {
    expect(check(order({cancelReason: "Delivery problem"}))).toEqual({ok: false, reason: "not_customer_side"});
    for (const storeKind of ["grocery", "dairy", "pharmacy"]) expect(check(order(), {storeKind})).toEqual({ok: false, reason: "not_food"});
  });
  it("skips food that melts", () => {
    const iceCream = order({items: [{itemId: "i9", name: "Butterscotch Ice Cream", quantity: 1, price: 90, variant: "",
      variantPrice: 0, addOns: [], addOnTotal: 0, note: "", diet: "veg"}]});
    expect(check(iceCream)).toEqual({ok: false, reason: "melts"});
    for (const name of ["Oreo Milkshake", "Mango Smoothie", "Royal Falooda", "Kulfi"]) expect(rescue.rescueMeltsItem(name)).toBe(true);
    for (const name of ["Chicken Biryani", "Masala Dosa", "Cold Coffee"]) expect(rescue.rescueMeltsItem(name)).toBe(false);
  });
  it("skips shared trips, store deliveries, an old location and a rescue of a rescue", () => {
    expect(check(order({batch: {orderIds: ["a", "b"]} as SavrivoOrder["batch"]}))).toEqual({ok: false, reason: "shared_trip"});
    expect(check(order({selfDelivery: true}))).toEqual({ok: false, reason: "self_delivery"});
    expect(check(order(), {partnerPoint: {...PARTNER, updatedAt: NOW - 6 * 60_000}})).toEqual({ok: false, reason: "no_location"});
    expect(check(order(), {partnerPoint: {lat: 0, lng: 0}})).toEqual({ok: false, reason: "no_location"});
    expect(check(order({foodRescue: {fromOrderId: "x", offerExpiresAt: NOW, menuPaise: 1, foodPaise: 1}})))
      .toEqual({ok: false, reason: "already_rescue"});
  });
});

describe("Food Rescue: the offer", () => {
  const offer = rescue.buildRescueOffer(order(), PARTNER, NOW);

  it("is half the menu price, for 15 minutes, where the partner waits", () => {
    expect(offer.items.map((item) => [item.name, item.quantity, item.unitPaise])).toEqual([["Chicken Biryani", 1, 10_000], ["Raita", 2, 1_500]]);
    expect(offer.pricePaise).toBe(13_000);
    expect(offer.menuPaise).toBe(26_000);
    expect(offer.expiresAt).toBe(NOW + 15 * 60_000);
    expect(offer.point).toEqual(PARTNER);
    expect(offer.vegOnly).toBe(false);
    expect(offer.status).toBe("open");
  });
  it("is never shown to the customer who cancelled, and stops taking buyers 3 minutes before the end", () => {
    expect(rescue.rescueOpenFor(offer, "cust-1", NOW)).toBe(false);
    expect(rescue.rescueOpenFor(offer, "cust-2", NOW)).toBe(true);
    expect(rescue.rescueClaimUntil(offer)).toBe(NOW + 12 * 60_000);
    expect(rescue.rescueOpenFor(offer, "cust-2", NOW + 12 * 60_000)).toBe(false);
    // The partner still waits until the window ends.
    expect(rescue.rescueHoldsPartner(offer, NOW + 14 * 60_000)).toBe(true);
    expect(rescue.rescueHoldsPartner(offer, NOW + 15 * 60_000)).toBe(false);
  });
  it("is held for one payer at a time", () => {
    const held = {...offer, status: "held" as const, heldBy: "cust-2", holdUntil: NOW + 3 * 60_000, claimOrderId: "200000000000002"};
    expect(rescue.rescueOpenFor(held, "cust-2", NOW + 60_000)).toBe(true);
    expect(rescue.rescueOpenFor(held, "cust-3", NOW + 60_000)).toBe(false);
    expect(rescue.rescueOpenFor(held, "cust-2", NOW + 3 * 60_000)).toBe(false);
    expect(rescue.publicRescue(held, NEAR, "cust-2")).toMatchObject({heldByYou: true, claimOrderId: "200000000000002", expiresAt: NOW + 3 * 60_000});
    expect(rescue.publicRescue(held, NEAR, "cust-3")).not.toHaveProperty("claimOrderId");
  });
  it("shows customers within 3 km only, testers test food only, nearest first", () => {
    const testOffer = {...offer, id: "t1", testOrder: true};
    expect(rescue.nearbyRescues([offer, testOffer], NEAR, "cust-2", NOW, false).map((entry) => entry.id)).toEqual([offer.id]);
    expect(rescue.nearbyRescues([offer, testOffer], NEAR, "cust-2", NOW, true).map((entry) => entry.id)).toEqual(["t1"]);
    expect(rescue.nearbyRescues([offer], FAR, "cust-2", NOW, false)).toEqual([]);
    const shown = rescue.nearbyRescues([offer], NEAR, "cust-2", NOW, false)[0]!;
    expect(shown.distanceKm).toBe(1);
    // No partner name or exact spot in what the app gets.
    expect(JSON.stringify(shown)).not.toContain("Ravi");
    expect(shown).not.toHaveProperty("point");
  });
});

describe("Food Rescue: the buy", () => {
  const offer = rescue.buildRescueOffer(order(), PARTNER, NOW);
  const address = {...order().address, id: "a2", lat: NEAR.lat, lng: NEAR.lng};
  const buy = rescue.buildRescueOrder({
    orderId: "200000000000002", idempotencyKey: "key-abcdef0123456789", schemaVersion: 3, offer,
    customer: {uid: "cust-2", name: "Bala"}, address, deliveryFee: 25, distanceKm: 1, roadKm: 1.3,
    paymentMethod: "upi", paymentProvider: "cashfree", now: NOW, eventId: "e1",
  });

  it("is an unpaid online order from the partner's spot: half-price food + the delivery fee", () => {
    expect(buy.status).toBe("Order placed");
    expect(buy.paymentState).toBe("pending");
    expect(buy.paymentMethod).toBe("upi");
    expect(buy.pricing).toMatchObject({subtotal: 130, deliveryFee: 25, platformFee: 0, tax: 0, tip: 0});
    expect(buy.total).toBe(155);
    expect(buy.restaurantLocation).toMatchObject(PARTNER);
    expect(buy.foodRescue).toEqual({fromOrderId: offer.id, offerExpiresAt: offer.expiresAt, menuPaise: 26_000, foodPaise: 13_000});
    expect(buy.items.map((item) => item.price)).toEqual([100, 15]);
    expect(buy.riderId).toBeUndefined();
  });
  it("goes straight to the same partner once paid", () => {
    expect(rescue.buildRescueStartCandidate(buy, offer, NOW + 1_000, "e2")).toBeUndefined();
    const started = rescue.buildRescueStartCandidate({...buy, paymentState: "paid"}, offer, NOW + 1_000, "e2")!;
    expect(started.status).toBe("Out for delivery");
    expect(started.riderId).toBe("rider-1");
    expect(started.statusHistory.e2).toMatchObject({status: "Out for delivery", actorRole: "system"});
  });
  it("settles the delivery fee to the partner and the food to Scraveit", () => {
    const journal = buildFoodRescueDeliveryJournal({orderId: "200000000000002", fromOrderId: offer.id, riderId: "rider-1",
      grossAmountPaise: 15_500, riderDeliveryEarningPaise: 2_500, occurredAt: NOW, paymentProvider: "cashfree", providerTransactionId: "cf_1"});
    expect(journal.debitTotalPaise).toBe(15_500);
    expect(journal.entries.find((entry) => entry.accountId === "liability:rider-earnings:rider-1")?.amountPaise).toBe(2_500);
    expect(journal.entries.find((entry) => entry.accountId === "revenue:food-rescue")?.amountPaise).toBe(13_000);
    expect(journal.entries.some((entry) => entry.accountId.startsWith("liability:restaurant-payable"))).toBe(false);
    expect(journal.metadata.gstTreatment).toBe("pending_ca_review");
  });
});

describe("Food Rescue: who hears about it", () => {
  const offer = rescue.buildRescueOffer(order(), PARTNER, NOW);
  const at = (uid: string, point: {lat: number; lng: number}, preferences: Record<string, unknown> = {}) =>
    ({uid, profile: {addresses: [{id: "h", ...point}], selectedAddressId: "h", preferences}});

  it("nearby customers with alerts on, never the one who cancelled or the partner", () => {
    const audience = rescueAudience(offer, [
      at("near-2", {lat: 14.4606, lng: 79.9865}),
      at("near-1", NEAR),
      at("far", FAR),
      at("cust-1", NEAR),
      at("rider-1", NEAR),
      at("muted", NEAR, {notifications: false}),
      at("veg", NEAR, {vegetarian: true}),
      at("tester", NEAR),
    ], new Set(["tester"]));
    expect(audience.map((entry) => entry.uid)).toEqual(["near-1", "near-2"]);
  });
  it("says what, where, the price and the time left", () => {
    expect(rescueAlertCopy(offer, 1.04, NOW)).toEqual({
      title: "Food Rescue near you: half price",
      body: "Chicken Biryani + 1 more from Spicy Box, 1 km away. ₹130 + delivery. Ready now, only for 12 min.",
    });
  });
});

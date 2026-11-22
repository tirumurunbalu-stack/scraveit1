import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, storage: {}, db: {}, auth: {}, messaging: {}}));
vi.mock("../src/services/faceVerification", () => ({faceSimilarity: vi.fn()}));

const {partnerCancelPayDecision, buildPartnerCancelPayJournal, cancelledAtOf, cancelCause, isCustomerCancellation, PARTNER_CANCEL_PAY_PAISE} =
  await import("../src/domain/partnerCancelPay");
const {nextPairState, readPairState, samePhone, pairDocId, PAIR_DAY_LIMIT, PAIR_WEEK_LIMIT} = await import("../src/domain/pairWatch");
const {peakSlotAt, sampleKey, countOnlinePartners, summarizePeakSlot, combinePeakSlots, peakAdvice} = await import("../src/domain/peakMetrics");
const {payoutAccountKeys, licenceHolderKey, summarizeIdentity} = await import("../src/services/riderIdentity");

const IST = (date: string, time: string) => Date.parse(`${date}T${time}:00+05:30`);

describe("partner pay when the customer cancels", () => {
  const arrival = {status: "verified", riderId: "r1", arrivedAt: 1_000};
  const cancelled = {status: "Cancelled", riderId: "r1", cancelledByRole: "customer"};

  it("pays ₹15 when the partner had reached the restaurant", () => {
    expect(partnerCancelPayDecision({order: cancelled, arrival, cancelledAt: 2_000})).toEqual({payPaise: 1_500, outcome: "paid", cause: "customer"});
    expect(PARTNER_CANCEL_PAY_PAISE).toBe(1_500);
  });
  it("counts the admin's 'Customer cancellation approved' as the customer's cancel", () => {
    const admin = {...cancelled, cancelledByRole: "ops_admin", cancelReason: "Customer cancellation approved"};
    expect(isCustomerCancellation(admin)).toBe(true);
    expect(partnerCancelPayDecision({order: admin, arrival, cancelledAt: 2_000}).payPaise).toBe(1_500);
    expect(isCustomerCancellation({...admin, cancelReason: "Restaurant unable to fulfil"})).toBe(false);
    // The founder's admin app cancels as the platform owner.
    expect(isCustomerCancellation({...admin, cancelledByRole: "owner"})).toBe(true);
    expect(isCustomerCancellation({...admin, cancelledByRole: "staff"})).toBe(false);
    expect(cancelCause({...admin, cancelReason: "Item unavailable"})).toBe("restaurant");
    expect(cancelCause({...admin, cancelReason: "Restaurant unable to fulfil", cancelledByRole: "owner"})).toBe("restaurant");
    expect(cancelCause({...admin, cancelReason: "Duplicate order"})).toBe("scraveit");
    expect(cancelCause({...admin, cancelReason: "Serviceability issue"})).toBe("scraveit");
    expect(cancelCause({...admin, cancelledByRole: "system", cancelReason: "online payment not completed"})).toBeNull();
  });
  it("pays ₹15 when the restaurant cancels after the partner arrived", () => {
    const restaurant = {...cancelled, cancelledByRole: "staff", cancelReason: "Kitchen closed"};
    expect(partnerCancelPayDecision({order: restaurant, arrival, cancelledAt: 2_000})).toEqual({payPaise: 1_500, outcome: "paid", cause: "restaurant"});
    const journal = buildPartnerCancelPayJournal({orderId: "123456789012345", riderId: "r1", amountPaise: 1_500, occurredAt: 2_000, cause: "restaurant"});
    expect(journal.metadata.reason).toBe("restaurant_cancelled_after_partner_arrived");
  });
  it("pays nothing before arrival, to another partner's arrival, or for other cancels", () => {
    expect(partnerCancelPayDecision({order: cancelled, arrival: null, cancelledAt: 2_000}).outcome).toBe("not_arrived");
    expect(partnerCancelPayDecision({order: cancelled, arrival: {...arrival, riderId: "r2"}, cancelledAt: 2_000}).outcome).toBe("not_arrived");
    expect(partnerCancelPayDecision({order: cancelled, arrival: {...arrival, status: "verifying"}, cancelledAt: 2_000}).outcome).toBe("not_arrived");
    expect(partnerCancelPayDecision({order: cancelled, arrival: {...arrival, arrivedAt: 3_000}, cancelledAt: 2_000}).outcome).toBe("not_arrived");
    expect(partnerCancelPayDecision({order: {...cancelled, cancelledByRole: "owner", cancelReason: "Duplicate order"}, arrival, cancelledAt: 2_000}))
      .toEqual({payPaise: 1_500, outcome: "paid", cause: "scraveit"});
    expect(partnerCancelPayDecision({order: {...cancelled, cancelledByRole: "system"}, arrival, cancelledAt: 2_000}).outcome).toBe("not_covered");
    expect(partnerCancelPayDecision({order: {...cancelled, riderId: ""}, arrival, cancelledAt: 2_000}).outcome).toBe("no_partner");
    expect(partnerCancelPayDecision({order: {...cancelled, selfDelivery: true}, arrival, cancelledAt: 2_000}).outcome).toBe("self_delivery");
    expect(partnerCancelPayDecision({order: {...cancelled, status: "Delivered"}, arrival, cancelledAt: 2_000}).outcome).toBe("not_cancelled");
  });
  it("posts one journal per order: Scraveit's expense to the partner's earnings", () => {
    const journal = buildPartnerCancelPayJournal({orderId: "123456789012345", riderId: "r1", amountPaise: 1_500, occurredAt: 2_000});
    const again = buildPartnerCancelPayJournal({orderId: "123456789012345", riderId: "r1", amountPaise: 1_500, occurredAt: 2_000});
    expect(journal.journalId).toBe(again.journalId);
    expect(journal.eventType).toBe("rider_incentive");
    expect(journal.metadata.settlementType).toBe("cancellation_pay");
    const credit = journal.entries.find((entry) => entry.side === "credit");
    expect(credit).toMatchObject({accountId: "liability:rider-earnings:r1", amountPaise: 1_500});
    expect(journal.entries.find((entry) => entry.side === "debit")?.accountId).toBe("expense:rider-cancellation-pay");
  });
  it("takes the cancel time from the Cancelled event", () => {
    expect(cancelledAtOf({statusHistory: {a: {status: "Assigned", at: 5}, b: {status: "Cancelled", at: 9}}, updatedAt: 20})).toBe(9);
    expect(cancelledAtOf({statusHistory: {}, updatedAt: 20})).toBe(20);
  });
});

describe("same partner and customer again", () => {
  const day = (time: string) => IST("2026-11-21", time);

  it("flags the 3rd delivery to one customer in a day, once a week", () => {
    let state = readPairState(null);
    let result = nextPairState(state, {orderId: "o1", at: day("12:00")});
    expect(result.flag).toBeNull();
    state = result.state;
    result = nextPairState(state, {orderId: "o2", at: day("13:00")});
    expect(result.flag).toBeNull();
    state = result.state;
    result = nextPairState(state, {orderId: "o3", at: day("20:00")});
    expect(result.dayCount).toBe(PAIR_DAY_LIMIT);
    expect(result.flag).toBe("repeat_pair");
    state = result.state;
    // A 4th the same day doesn't alert again.
    expect(nextPairState(state, {orderId: "o4", at: day("21:00")}).flag).toBeNull();
  });
  it("flags 6 in 7 days spread over days", () => {
    let state = readPairState(null);
    let flag: string | null = null;
    for (let index = 0; index < PAIR_WEEK_LIMIT; index++) {
      const result = nextPairState(state, {orderId: `o${index}`, at: IST(`2026-11-${String(15 + index).padStart(2, "0")}`, "13:00")});
      state = result.state;
      flag = result.flag;
    }
    expect(flag).toBe("repeat_pair");
  });
  it("ignores a repeat of the same order", () => {
    const first = nextPairState(readPairState(null), {orderId: "o1", at: day("12:00")});
    const repeat = nextPairState(first.state, {orderId: "o1", at: day("12:00")});
    expect(repeat.duplicate).toBe(true);
    expect(repeat.state.deliveries).toHaveLength(1);
  });
  it("flags a delivery to the partner's own phone at once", () => {
    expect(samePhone("+91 98765 43210", "9876543210")).toBe(true);
    expect(samePhone("", "")).toBe(false);
    expect(nextPairState(readPairState(null), {orderId: "o1", at: day("12:00")}, true).flag).toBe("own_phone");
    expect(pairDocId("r/1", "c 1")).toBe("r_1__c_1");
  });
});

describe("orders per partner per peak hour", () => {
  it("knows the lunch and dinner windows in IST", () => {
    expect(peakSlotAt(IST("2026-11-21", "11:29"))).toBeNull();
    expect(peakSlotAt(IST("2026-11-21", "11:30"))).toMatchObject({date: "2026-11-21", slot: "lunch"});
    expect(peakSlotAt(IST("2026-11-21", "14:59"))?.slot).toBe("lunch");
    expect(peakSlotAt(IST("2026-11-21", "15:00"))).toBeNull();
    expect(peakSlotAt(IST("2026-11-21", "19:00"))?.slot).toBe("dinner");
    expect(peakSlotAt(IST("2026-11-21", "23:00"))).toBeNull();
    expect(sampleKey(11 * 60 + 37)).toBe("1135");
  });
  it("counts online partners: busy ones always, idle ones only with a fresh ping", () => {
    const now = 1_000_000;
    expect(countOnlinePartners([
      {online: true, updatedAt: now - 10_000},
      {online: true, updatedAt: now - 600_000},
      {online: true, updatedAt: now - 600_000, activeOrderId: "o1"},
      {online: false, updatedAt: now},
    ], now, 90_000)).toBe(2);
  });
  it("divides orders by partner-hours and says when to add partners", () => {
    // 12 samples × 4 partners × 5 min = 4 partner-hours; 8 orders → 2 an hour.
    const counts = Object.fromEntries(Array.from({length: 12}, (_, index) => [String(1130 + index * 5), 4]));
    const busy = summarizePeakSlot("lunch", {counts, orders: 8});
    expect(busy).toMatchObject({orders: 8, samples: 12, partnerHours: 4, averageOnline: 4, ordersPerPartnerHour: 2, advice: "add_partners"});
    expect(summarizePeakSlot("lunch", {counts, orders: 6}).advice).toBe("on_target");
    expect(summarizePeakSlot("lunch", {counts, orders: 2}).advice).toBe("partners_waiting");
    expect(summarizePeakSlot("dinner", undefined)).toMatchObject({orders: 0, ordersPerPartnerHour: null, advice: "no_data"});
    expect(peakAdvice(null, 3)).toBe("add_partners");
    const week = combinePeakSlots("lunch", [busy, summarizePeakSlot("lunch", {counts, orders: 4})]);
    expect(week).toMatchObject({orders: 12, partnerHours: 8, ordersPerPartnerHour: 1.5, advice: "on_target"});
  });
});

describe("one account per licence and bank account", () => {
  it("hashes the bank account and UPI ID, never storing them", () => {
    const keys = payoutAccountKeys({bankIfsc: "sbin0001234", bankAccountNumber: "1234 5678 9012", upiId: "Ravi@ybl"});
    expect(keys.bankKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.upiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keys)).not.toContain("123456789012");
    expect(payoutAccountKeys({bankIfsc: "SBIN0001234", bankAccountNumber: "123456789012", upiId: "ravi@ybl"})).toEqual(keys);
    expect(payoutAccountKeys({})).toEqual({bankKey: "", upiKey: "", checkedFor: ""});
    expect(licenceHolderKey("AP0320210012345")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("puts a duplicate licence or bank account in the admin's review list", () => {
    const rider = {panNumber: "ABCPP1234F", faceReferenceObjectPath: "ref", vehicleType: "Motorcycle", dlNumber: "AP03 2021 0012345", dlValidTill: "2040-01-01",
      payoutProfile: {bankIfsc: "SBIN0001234", bankAccountNumber: "123456789012"}};
    const aadhaar = {last4: "1234", name: "Ravi Prasad", dob: "1990-01-01", gender: "M", address: {}, keyId: "k", issuedAt: 1, verifiedAt: 2};
    const identity = {aadhaar, faceSimilarity: 93, faceComparedFor: "ref", panDuplicateOf: "", panRegistry: {pan: "ABCPP1234F", result: "active_match", checkedAt: 5},
      licenceCheckedFor: "AP0320210012345", licenceDuplicateOf: "other", payoutCheckedFor: payoutAccountKeys(rider.payoutProfile).checkedFor, bankDuplicateOf: "other2"};
    const summary = summarizeIdentity(rider, identity, Date.UTC(2026, 10, 21));
    expect(summary.status).toBe("review");
    expect(summary.duplicateLicenceOf).toBe("other");
    expect(summary.duplicateBankOf).toBe("other2");
    expect(summary.reasons).toEqual([
      "This driving licence is already used by another delivery partner account",
      "This bank account or UPI ID is already used by another delivery partner account",
    ]);
    // A changed bank account isn't flagged until it is checked again.
    const changed = summarizeIdentity({...rider, payoutProfile: {bankIfsc: "HDFC0000001", bankAccountNumber: "999999999"}}, identity, Date.UTC(2026, 10, 21));
    expect(changed.duplicateBankOf).toBe("");
  });
});

describe("cancel notices to the store and the delivery partner", () => {
  it("tells the store unless it cancelled itself or never saw the order, and always the partner on it", async () => {
    const {cancelNoticeTargets, buildOrderCancelledNotice} = await import("../src/domain/notificationMessages");
    const base = {id: "123456789012345", restaurantId: "s1", restaurant: "Spicy Box", riderId: "r1", statusBeforeTerminal: "Preparing" as const};
    expect(cancelNoticeTargets({...base, cancelledByRole: "owner"})).toEqual({restaurant: true, partner: true});
    expect(cancelNoticeTargets({...base, cancelledByRole: "staff"})).toEqual({restaurant: false, partner: true});
    expect(cancelNoticeTargets({...base, riderId: "", cancelledByRole: "customer"})).toEqual({restaurant: true, partner: false});
    expect(cancelNoticeTargets({...base, riderId: "", cancelledByRole: "system", statusBeforeTerminal: "Order placed"})).toEqual({restaurant: false, partner: false});
    expect(cancelNoticeTargets({...base, selfDelivery: true, cancelledByRole: "owner"}).partner).toBe(false);

    const store = buildOrderCancelledNotice({order: {...base, cancelledByRole: "owner", cancelReason: "Item unavailable"}, audience: "restaurant", customerCause: false});
    expect(store.notification).toEqual({title: "Order #2345 cancelled", body: "Scraveit cancelled it: Item unavailable. Please don't prepare or hand it over."});
    expect(store.data).toMatchObject({type: "ORDER_STATUS", status: "Cancelled", orderId: base.id});
    const customer = buildOrderCancelledNotice({order: {...base, cancelledByRole: "owner", cancelReason: "Customer cancellation approved"}, audience: "restaurant", customerCause: true});
    expect(customer.notification?.body).toBe("The customer cancelled it. Please don't prepare or hand it over.");
    const paid = buildOrderCancelledNotice({order: {...base, cancelledByRole: "owner"}, audience: "partner", customerCause: true, partnerPayPaise: 1_500});
    expect(paid.notification?.body).toBe("Spicy Box: cancelled after you reached the restaurant. You get ₹15.");
    const unpaid = buildOrderCancelledNotice({order: {...base, cancelledByRole: "owner"}, audience: "partner", customerCause: true});
    expect(unpaid.notification?.body).toBe("Spicy Box: don't pick it up. The order was cancelled.");
  });
});

describe("who a cancel is counted against", () => {
  it("counts admin cancels by the reason picked, not as the restaurant rejecting", async () => {
    const {cancellationKindFor} = await import("../src/domain/order");
    expect(cancellationKindFor("customer")).toBe("customer_cancelled");
    expect(cancellationKindFor("staff", "Kitchen closed")).toBe("restaurant_rejected");
    expect(cancellationKindFor("owner", "Customer cancellation approved")).toBe("customer_cancelled");
    expect(cancellationKindFor("ops_admin", "Item unavailable")).toBe("restaurant_rejected");
    expect(cancellationKindFor("owner", "Restaurant unable to fulfil")).toBe("restaurant_rejected");
    expect(cancellationKindFor("owner", "Duplicate order")).toBe("system_cancelled");
    expect(cancellationKindFor("owner")).toBe("system_cancelled");
    expect(cancellationKindFor("system", "Payment not completed")).toBe("system_cancelled");
  });

  it("keeps a customer cancel on the customer, whatever reason text it carries", async () => {
    const {cancellationKindFor} = await import("../src/domain/order");
    // A customer must not be able to shift the cancel onto the restaurant by sending an admin reason.
    expect(cancellationKindFor("customer", "Restaurant unable to fulfil")).toBe("customer_cancelled");
    expect(cancellationKindFor("customer", "Changed my mind")).toBe("customer_cancelled");
    expect(cancelCause({cancelledByRole: "customer", cancelReason: "Item unavailable"})).toBe("customer");
    expect(cancelCause({cancelledByRole: "owner", cancelReason: "Serviceability issue"})).toBe("scraveit");
    expect(cancelCause({cancelledByRole: "staff", cancelReason: "Duplicate order"})).toBe("restaurant");
  });
});

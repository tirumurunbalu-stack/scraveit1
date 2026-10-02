import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {
  DEFAULT_RIDER_TRIP_PAY_POLICY,
  calculateRiderTripPay,
  normalizeRiderTripPayVersions,
  resolveRiderTripPayPolicy,
  type RiderTripPayPolicy,
} from "../src/domain/riderTripPay";
import {computeOrderEconomics, normalizeEconomicsPolicy, settlementTerms} from "../src/domain/economics";
import {normalizeEconomicsControl} from "../src/domain/economicsControl";
import {buildPricing} from "../src/domain/order";
import {
  buildCodOrderDeliveryJournal,
  orderDeliveryAmounts,
} from "../src/services/ledger";
import {
  clearEconomicsControlCache,
  finalizeOrderEconomics,
  orderEconomicsRecord,
  planCheckoutEconomics,
} from "../src/services/economics";
import {finalizeRiderTripPay, resolveDeliverySettlementOptions} from "../src/services/deliverySettlement";
import type {SavrivoOrder} from "../src/types";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const policy: RiderTripPayPolicy = {...DEFAULT_RIDER_TRIP_PAY_POLICY, slotAddons: [], vehicleMultiplierBps: {}};
const noon = 12 * 60;

describe("rider trip pay policy", () => {
  it("pays the documented example: 1.5 km pickup, 4 km drop = ₹34", () => {
    const pay = calculateRiderTripPay(policy, {pickupMeters: 1_500, dropMeters: 4_000, waitMinutes: 0, minuteOfDay: noon});
    expect(pay).toMatchObject({basePickupPaise: 2_000, pickupDistancePaise: 200, dropDistancePaise: 1_200, totalPaise: 3_400});
  });

  it("lifts a very short trip to the minimum trip pay", () => {
    const pay = calculateRiderTripPay(policy, {pickupMeters: 300, dropMeters: 800, waitMinutes: 0, minuteOfDay: noon});
    expect(pay.minimumTopUpPaise).toBe(500);
    expect(pay.totalPaise).toBe(2_500);
  });

  it("adds the long-distance component beyond the threshold", () => {
    const pay = calculateRiderTripPay(policy, {pickupMeters: 1_000, dropMeters: 10_000, waitMinutes: 0, minuteOfDay: noon});
    // 20 + 8 km × 6 + 3 km × 3 = 20 + 48 + 9 = ₹77.
    expect(pay).toMatchObject({dropDistancePaise: 4_800, longDistancePaise: 900, totalPaise: 7_700});
  });

  it("pays waiting time after the free minutes, up to the cap", () => {
    expect(calculateRiderTripPay(policy, {pickupMeters: 0, dropMeters: 4_000, waitMinutes: 8, minuteOfDay: noon}).waitingPaise).toBe(0);
    expect(calculateRiderTripPay(policy, {pickupMeters: 0, dropMeters: 4_000, waitMinutes: 25, minuteOfDay: noon}).waitingPaise).toBe(1_500);
    expect(calculateRiderTripPay(policy, {pickupMeters: 0, dropMeters: 4_000, waitMinutes: 90, minuteOfDay: noon}).waitingPaise).toBe(3_000);
  });

  it("adds slot pay for late-night and early-morning windows, including across midnight", () => {
    const night: RiderTripPayPolicy = {...policy, slotAddons: [
      {label: "Late night", startMinute: 23 * 60, endMinute: 2 * 60, amountPaise: 1_500},
      {label: "Early morning", startMinute: 2 * 60, endMinute: 6 * 60, amountPaise: 1_000},
    ]};
    expect(calculateRiderTripPay(night, {pickupMeters: 1_500, dropMeters: 4_000, waitMinutes: 0, minuteOfDay: 30}).slotPaise).toBe(1_500);
    expect(calculateRiderTripPay(night, {pickupMeters: 1_500, dropMeters: 4_000, waitMinutes: 0, minuteOfDay: 3 * 60}).slotLabels).toEqual(["Early morning"]);
    expect(calculateRiderTripPay(night, {pickupMeters: 1_500, dropMeters: 4_000, waitMinutes: 0, minuteOfDay: noon}).slotPaise).toBe(0);
  });

  it("applies a vehicle multiplier and a maximum", () => {
    const bicycle = {...policy, vehicleMultiplierBps: {bicycle: 12_000}, maximumTripPaise: 4_000};
    const pay = calculateRiderTripPay(bicycle, {pickupMeters: 1_500, dropMeters: 4_000, waitMinutes: 0, minuteOfDay: noon, vehicleType: "Bicycle"});
    expect(pay.vehicleAdjustmentPaise).toBe(680);
    expect(pay.totalPaise).toBe(4_000);
    expect(pay.maximumCapPaise).toBe(80);
  });

  it("layers city and zone versions only while they are in force", () => {
    const layers = {
      global: normalizeRiderTripPayVersions([{effectiveFrom: 0, override: {dropPerKmPaise: 500}}]),
      cities: {nellore: normalizeRiderTripPayVersions([{effectiveFrom: 100, effectiveTo: 200, override: {basePickupPaise: 2_500}}])},
      zones: {"nellore|stonehousepet": normalizeRiderTripPayVersions([{effectiveFrom: 0, override: {minimumTripPaise: 3_000}}])},
    };
    const during = resolveRiderTripPayPolicy(layers, {cityKey: "nellore", zoneKey: "stonehousepet"}, 150);
    expect(during).toMatchObject({dropPerKmPaise: 500, basePickupPaise: 2_500, minimumTripPaise: 3_000});
    const after = resolveRiderTripPayPolicy(layers, {cityKey: "nellore", zoneKey: ""}, 250);
    expect(after).toMatchObject({dropPerKmPaise: 500, basePickupPaise: 2_000, minimumTripPaise: 2_500});
  });
});

describe("customer delivery fee and rider trip pay are separate", () => {
  const economicsPolicy = normalizeEconomicsPolicy({codHandlingCostPaise: 300, refundReserveBpsOfGmv: 0,
    supportCostPaisePerOrder: 200, otherVariableCostPaisePerOrder: 0});
  const order = (deliveryFeePaise: number, tripPaise: number) => computeOrderEconomics({
    cityKey: "nellore", zoneKey: "z", restaurantId: "r1", paymentMethod: "cod", itemSubtotalPaise: 35_000,
    restaurantDiscountPaise: 0, platformDiscountPaise: 0, deliveryFeePaise, platformFeePaise: 700,
    smallOrderFeePaise: 0, lateNightFeePaise: 0, rainFeePaise: 0, surgeFeePaise: 0, riderIncentiveFeePaise: 0,
    taxPaise: 0, tipPaise: 0, commissionBps: 1_000, riderDeliveryPayPaise: tripPaise, riderIncentivePayPaise: 0,
  }, economicsPolicy);

  it("shows a ₹9 delivery subsidy when the customer pays ₹25 and the rider earns ₹34", () => {
    const snapshot = order(2_500, 3_400);
    expect(snapshot.platform.deliveryMarginPaise).toBe(-900);
    const pricing = buildPricing({subtotal: 350, discount: 0, deliveryFee: 25, platformFee: 7, taxRate: 0, tip: 0});
    const amounts = orderDeliveryAmounts({...pricing, economics: settlementTerms(snapshot)}, 1_500);
    expect(amounts.riderDeliveryEarningPaise).toBe(3_400);
    expect(amounts.riderTripSubsidyPaise).toBe(900);
  });

  it("shows a ₹9 delivery margin when the customer pays ₹40 and the rider earns ₹31", () => {
    const snapshot = order(4_000, 3_100);
    expect(snapshot.platform.deliveryMarginPaise).toBe(900);
    const pricing = buildPricing({subtotal: 350, discount: 0, deliveryFee: 40, platformFee: 7, taxRate: 0, tip: 0});
    const amounts = orderDeliveryAmounts({...pricing, economics: settlementTerms(snapshot)}, 1_500);
    expect(amounts.riderDeliveryEarningPaise).toBe(3_100);
    expect(amounts.riderTripSubsidyPaise ?? 0).toBe(0);
    // The ₹9 margin stays with Scraveit as platform fee revenue.
    expect(amounts.platformFeePaise).toBe(700 + 900);
  });

  it("pays the rider 70% of rain and the restaurant 70% of the busy-kitchen fee at delivery", () => {
    const snapshot = computeOrderEconomics({
      cityKey: "nellore", zoneKey: "z", restaurantId: "r1", paymentMethod: "cod", itemSubtotalPaise: 35_000,
      restaurantDiscountPaise: 0, platformDiscountPaise: 0, deliveryFeePaise: 3_900, platformFeePaise: 1_499,
      smallOrderFeePaise: 0, lateNightFeePaise: 0, rainFeePaise: 2_900, surgeFeePaise: 1_900, riderIncentiveFeePaise: 0,
      taxPaise: 0, tipPaise: 0, commissionBps: 1_500, riderDeliveryPayPaise: 2_800, riderIncentivePayPaise: 0,
    }, economicsPolicy);
    const pricing = buildPricing({subtotal: 350, discount: 0, deliveryFee: 39, platformFee: 14.99, taxRate: 0, tip: 0,
      rainFee: 29, surgeFee: 19});
    const amounts = orderDeliveryAmounts({...pricing, economics: settlementTerms(snapshot)}, 1_500);
    expect(amounts.riderDeliveryEarningPaise).toBe(2_800 + 2_030);
    expect(amounts.restaurantPayablePaise).toBe(35_000 - 5_250 + 1_330);
    expect(amounts.riderTripSubsidyPaise ?? 0).toBe(0);
    // Scraveit: commission ₹52.50 + platform ₹14.99 + delivery margin ₹11 + 30% of rain ₹8.70 + 30% of kitchen ₹5.70.
    expect(amounts.platformCommissionPaise + amounts.platformFeePaise).toBe(5_250 + 1_499 + 1_100 + 870 + 570);
  });

  it("pays the rider correctly on free delivery", () => {
    const snapshot = order(0, 3_400);
    const pricing = buildPricing({subtotal: 350, discount: 0, deliveryFee: 0, platformFee: 7, taxRate: 0, tip: 0});
    const amounts = orderDeliveryAmounts({...pricing, economics: settlementTerms(snapshot)}, 1_500);
    expect(amounts.riderDeliveryEarningPaise).toBe(3_400);
    expect(amounts.riderTripSubsidyPaise).toBe(3_400);
  });
});

describe("final trip pay at delivery", () => {
  let database: InMemoryFirestore;
  const NOW = Date.UTC(2026, 9, 1, 8, 0);

  beforeEach(() => {
    database = new InMemoryFirestore();
    clearEconomicsControlCache();
  });

  function deliveredOrder(): SavrivoOrder {
    const control = normalizeEconomicsControl({});
    const plan = planCheckoutEconomics({
      control, restaurant: {id: "r1", city: "Nellore"}, address: {area: "Stonehousepet", label: "Home"}, subtotal: 350,
      fees: {deliveryFee: 25, platformFee: 7, lateNightFee: 0, rainFee: 0, surgeFee: 0, riderIncentiveFee: 0,
        smallOrderThreshold: 0, smallOrderFee: 0, distanceKm: 4},
      paymentMethod: "cod", tip: 0, promotion: null, defaultCommissionBps: 1_000, now: NOW,
    });
    const {pricing, total} = buildPricing({subtotal: 350, discount: 0, deliveryFee: 25, platformFee: 7, taxRate: 0, tip: 0});
    const snapshot = finalizeOrderEconomics(plan, pricing, total, "r1", "cod", []);
    const order = {
      id: "SV-1", customerId: "c1", restaurantId: "r1", riderId: "rider1", createdAt: NOW, updatedAt: NOW + 3_600_000,
      deliveredAt: NOW + 3_600_000, status: "Delivered", paymentMethod: "cod", total, pricing,
      pricingContext: {distanceKm: 4}, economics: settlementTerms(snapshot),
      statusHistory: {h: {status: "Handed to rider", at: NOW + 1_800_000, actorId: "s", actorRole: "staff"}},
    } as unknown as SavrivoOrder;
    database.seed("orderEconomics/SV-1", orderEconomicsRecord(order, snapshot, {tripPayPolicy: plan.tripPayPolicy, distanceMeters: 4_000}));
    return order;
  }

  it("uses the real pickup distance and verified waiting time, and fixes the result once", async () => {
    const order = deliveredOrder();
    // Estimate at checkout: expected 1.5 km pickup, 4 km drop = ₹34.
    expect(order.economics?.rider.deliveryPayPaise).toBe(3_400);
    database.seed("dispatchQueue/SV-1", {candidates: [{riderId: "rider1", distanceKm: 3}]});
    // Rider arrived 25 minutes before handover: 15 paid minutes at ₹1.
    database.seed("riderRestaurantArrivals/SV-1", {riderId: "rider1", arrivedAt: NOW + 1_800_000 - 25 * 60_000});
    database.seed("riders/rider1", {city: "Nellore", vehicleType: "bike"});
    const final = await finalizeRiderTripPay(order, database);
    // 20 + (3 − 1) × 4 + (4 − 2) × 6 + 15 wait = 20 + 8 + 12 + 15 = ₹55.
    expect(final).toMatchObject({pickupDistancePaise: 800, waitingPaise: 1_500, totalPaise: 5_500,
      pickupSource: "dispatch_gps_straight_line", waitSource: "verified_arrival_to_handover"});
    database.seed("dispatchQueue/SV-1", {candidates: [{riderId: "rider1", distanceKm: 9}]});
    expect((await finalizeRiderTripPay(order, database))?.totalPaise).toBe(5_500);

    const options = await resolveDeliverySettlementOptions(order, database);
    expect(options.finalTripPayPaise).toBe(5_500);
    expect(options.attribution).toMatchObject({countryKey: "in", stateKey: "andhra-pradesh", cityKey: "nellore",
      zoneKey: "stonehousepet", restaurantId: "r1", customerId: "c1", riderId: "rider1"});
    const amounts = orderDeliveryAmounts(order, 1_500, {finalTripPayPaise: options.finalTripPayPaise});
    const journal = buildCodOrderDeliveryJournal({...amounts, orderId: order.id, restaurantId: "r1", riderId: "rider1",
      customerId: "c1", occurredAt: NOW, attribution: options.attribution});
    expect(journal.debitTotalPaise).toBe(journal.creditTotalPaise);
    expect(journal.metadata).toMatchObject({cityKey: "nellore", zoneKey: "stonehousepet", riderTripSubsidyPaise: 3_000});
  });
});

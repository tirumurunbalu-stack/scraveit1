import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {normalizeEconomicsControl} from "../src/domain/economicsControl";
import {planCheckoutEconomics, restaurantCommissionBps, type ServerFees} from "../src/services/economics";

const NOW = Date.UTC(2026, 9, 5, 9, 0);
const fees: ServerFees = {
  deliveryFee: 29, platformFee: 15, lateNightFee: 0, rainFee: 0, surgeFee: 0,
  riderIncentiveFee: 0, smallOrderThreshold: 0, smallOrderFee: 0,
};

function plan(restaurant: {id: string; city: string; commissionBps?: number}, plans: Record<string, unknown> = {}) {
  return planCheckoutEconomics({
    control: normalizeEconomicsControl({commercialPlans: plans}),
    restaurant,
    address: {area: "Naidupeta", label: "Home"},
    subtotal: 300,
    fees,
    paymentMethod: "cod",
    tip: 0,
    promotion: null,
    defaultCommissionBps: 1_500,
    now: NOW,
  });
}

describe("each restaurant's own commission", () => {
  it("uses the rate Scraveit set on the restaurant", () => {
    expect(plan({id: "r1", city: "Nellore", commissionBps: 1_200}).commissionBps).toBe(1_200);
  });

  it("keeps the platform default when no rate is set", () => {
    expect(plan({id: "r1", city: "Nellore"}).commissionBps).toBe(1_500);
    expect(restaurantCommissionBps({commissionBps: "" as unknown as number}, 1_500)).toBe(1_500);
    expect(restaurantCommissionBps({commissionBps: null as unknown as number}, 1_500)).toBe(1_500);
  });

  it("accepts an agreed 0% rate but never an out-of-range one", () => {
    expect(restaurantCommissionBps({commissionBps: 0}, 1_500)).toBe(0);
    expect(restaurantCommissionBps({commissionBps: 9_000}, 1_500)).toBe(1_500);
    expect(restaurantCommissionBps({commissionBps: -5}, 1_500)).toBe(1_500);
  });

  it("lets an active dated commercial plan win over the restaurant rate", () => {
    const plans = {r1: [{planId: "launch", label: "Launch", commissionBps: 800, effectiveFrom: NOW - 1_000, effectiveTo: 0}]};
    expect(plan({id: "r1", city: "Nellore", commissionBps: 1_200}, plans).commissionBps).toBe(800);
  });
});

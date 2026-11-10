import {describe, expect, it} from "vitest";
import {clusterPlanFeatures, planClusterDelivery, straightKm, type ClusterLegInput} from "../src/domain/clusterPlan";

const customer = {lat: 14.4426, lng: 79.9865};
// ~0.0018 deg latitude is about 200 m; ~0.018 deg is about 2 km.
const leg = (id: string, dLat: number, dLng: number, extra: Partial<ClusterLegInput> = {}): ClusterLegInput => ({
  restaurantId: id, lat: customer.lat + dLat, lng: customer.lng + dLng,
  prepMinutes: 20, temperature: "hot", riderReachMinutes: 5, ...extra,
});

describe("planClusterDelivery", () => {
  it("sends one rider when the restaurants are next to each other", () => {
    const plan = planClusterDelivery(customer, [leg("biryani", 0.02, 0), leg("meals", 0.0205, 0.0004)]);
    expect(plan.riders).toBe(1);
    expect(plan.trips[0]?.pickups).toHaveLength(2);
  });

  it("sends a rider per restaurant when they are far apart, arriving together", () => {
    const plan = planClusterDelivery(customer, [
      leg("biryani", 0.018, 0),
      leg("icecream", -0.018, 0, {temperature: "frozen", prepMinutes: 5}),
      leg("meals", 0, 0.019),
    ]);
    expect(plan.riders).toBe(3);
    expect(plan.arrivalSpreadMinutes).toBeLessThanOrEqual(5);
    // Ice cream is quick to pack, so that kitchen waits instead of melting on a bike.
    expect(plan.kitchenStartDelayMinutes.icecream).toBeGreaterThan(5);
    expect(plan.kitchenStartDelayMinutes.biryani).toBe(0);
  });

  it("always collects frozen food last on a shared trip", () => {
    const plan = planClusterDelivery(customer, [
      leg("icecream", 0.01, 0, {temperature: "frozen", prepMinutes: 5}),
      leg("biryani", 0.0102, 0.0003),
    ]);
    for (const trip of plan.trips) {
      if (trip.pickups.includes("icecream")) expect(trip.pickups[trip.pickups.length - 1]).toBe("icecream");
    }
  });

  it("pairs the two close restaurants and gives the far one its own rider", () => {
    const plan = planClusterDelivery(customer, [
      leg("a", 0.015, 0), leg("b", 0.0152, 0.0003), leg("c", -0.03, 0),
    ]);
    expect(plan.riders).toBe(2);
    const shared = plan.trips.find((trip) => trip.pickups.length === 2);
    expect(shared?.pickups.slice().sort()).toEqual(["a", "b"]);
  });

  it("uses a rider near the restaurant when known, and a default reach when not", () => {
    const near = planClusterDelivery(customer, [leg("a", 0.02, 0, {riderReachMinutes: 2, prepMinutes: 0})]);
    const unknown = planClusterDelivery(customer, [leg("a", 0.02, 0, {riderReachMinutes: null, prepMinutes: 0})]);
    expect(unknown.etaMinutes).toBeGreaterThan(near.etaMinutes);
  });

  it("is deterministic and rejects bad input", () => {
    const legs = [leg("a", 0.01, 0), leg("b", -0.01, 0.002)];
    expect(planClusterDelivery(customer, legs)).toEqual(planClusterDelivery(customer, legs));
    expect(() => planClusterDelivery(customer, [])).toThrow("CLUSTER_PLAN_NO_LEGS");
    expect(() => planClusterDelivery(customer, [leg("a", 0, 0), leg("a", 0.01, 0)])).toThrow("CLUSTER_PLAN_DUPLICATE_RESTAURANT");
    expect(() => planClusterDelivery(customer, [leg("a", 0, 0), leg("b", 0, 0), leg("c", 0, 0), leg("d", 0, 0)])).toThrow("CLUSTER_PLAN_TOO_MANY_LEGS");
  });

  it("records the numbers it decided on", () => {
    const legs = [leg("a", 0.01, 0), leg("b", -0.01, 0)];
    const features = clusterPlanFeatures(customer, legs, planClusterDelivery(customer, legs));
    expect(features.legs).toBe(2);
    expect(features.gap01_km).toBeCloseTo(straightKm(legs[0] as ClusterLegInput, legs[1] as ClusterLegInput), 1);
  });
});

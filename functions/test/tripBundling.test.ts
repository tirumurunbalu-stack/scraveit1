import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
  db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_RTDB"); }},
}));

import {planClusterDelivery, DEFAULT_CLUSTER_POLICY, type ClusterLegInput} from "../src/domain/clusterPlan";
import {estimateDelivery} from "../src/domain/deliveryEstimate";
import {buildRiderJobProjection} from "../src/domain/riderJob";
import {bundleClaimAllowed, planBundle} from "../src/services/dispatch";
import type {SavrivoOrder} from "../src/types";

const trip = {clusterId: "CL1", orderIds: ["SVA", "SVB"], leadOrderId: "SVA"};

function part(id: string, overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id, customerId: "c1", restaurantId: `r_${id}`, restaurant: `Kitchen ${id}`, status: "Accepted", createdAt: 1, updatedAt: 1,
    restaurantLocation: {address: "", lat: 14.44, lng: 79.98}, address: {lat: 14.46, lng: 79.99, area: "Area"},
    items: [{quantity: 1}], etaMax: 40, statusHistory: {}, total: 300, paymentMethod: "cod",
    pricing: {subtotal: 250, deliveryFee: 25, platformFee: 7, tip: 0, discount: 0, total: 300},
    clusterTrip: {...trip, stop: id === "SVA" ? 0 : 1},
    ...overrides,
  } as unknown as SavrivoOrder;
}

describe("shared-trip dispatch", () => {
  const follower = part("SVB", {restaurantLocation: {address: "", lat: 14.45, lng: 79.985}});

  it("offers a later pickup only to the rider who took the first one", () => {
    const lead = part("SVA", {riderId: "rider-1", riderName: "Ravi"});
    const decision = planBundle(follower, null, lead);
    expect(decision.kind).toBe("offer");
    if (decision.kind !== "offer") return;
    expect(decision.candidate.riderId).toBe("rider-1");
    expect(decision.candidate.distanceKm).toBeGreaterThan(0.5);
    expect(decision.bundle).toEqual({leadOrderId: "SVA", riderId: "rider-1", stop: 1, stops: 2});
  });

  it("waits for the first pickup's rider while this kitchen is still cooking", () => {
    expect(planBundle(follower, null, part("SVA")).kind).toBe("wait");
  });

  it("stops waiting once this food is ready", () => {
    expect(planBundle(part("SVB", {status: "Ready for pickup"}), null, part("SVA")).kind).toBe("normal");
  });

  it("goes to any rider when the first pickup is cancelled, delivered, or already riding to the customer", () => {
    for (const status of ["Cancelled", "Delivered", "Out for delivery", "Near you", "Arrived"]) {
      expect(planBundle(follower, null, part("SVA", {status: status as SavrivoOrder["status"], riderId: "rider-1"})).kind).toBe("normal");
    }
    expect(planBundle(follower, null, null).kind).toBe("normal");
  });

  it("asks the trip's rider only once", () => {
    const lead = part("SVA", {riderId: "rider-1"});
    expect(planBundle(follower, {bundle: {leadOrderId: "SVA", riderId: "rider-1", stop: 1, stops: 2}}, lead).kind).toBe("normal");
    expect(planBundle(follower, {bundleTried: true}, lead).kind).toBe("normal");
  });

  it("dispatches the first pickup, and any single-restaurant order, as usual", () => {
    expect(planBundle(part("SVA"), null, null).kind).toBe("normal");
    expect(planBundle(part("SVX", {clusterTrip: undefined}), null, null).kind).toBe("normal");
  });

  it("lets the trip's rider accept the extra pickup while carrying the first", () => {
    const queue = {bundle: {leadOrderId: "SVA", riderId: "rider-1", stop: 1, stops: 2}};
    expect(bundleClaimAllowed(queue, "rider-1", {"rider-1_SVA": {status: "active"}})).toBe(true);
    expect(bundleClaimAllowed(queue, "rider-2", {"rider-2_SVA": {status: "active"}})).toBe(false);
    expect(bundleClaimAllowed(queue, "rider-1", {"rider-1_SVA": {status: "completed"}})).toBe(false);
    expect(bundleClaimAllowed({}, "rider-1", {"rider-1_SVA": {status: "active"}})).toBe(false);
  });

  it("tells the rider app which trip a job belongs to", () => {
    const projection = buildRiderJobProjection(part("SVB", {riderId: "rider-1"}));
    expect(projection.trip).toEqual({clusterId: "CL1", orderIds: ["SVA", "SVB"], leadOrderId: "SVA", stop: 1, stops: 2});
    expect(buildRiderJobProjection(part("SVX", {clusterTrip: undefined})).trip).toBeUndefined();
  });
});

describe("learned numbers in the promise and the plan", () => {
  const base = {kitchenEtaMinMinutes: 15, kitchenEtaMaxMinutes: 25, distanceKm: 3, activeOrders: 0, availableRiders: 5,
    occurredAt: Date.parse("2026-10-31T16:00:00+05:30")};

  it("uses learned prep and ride times when given, and keeps the stated ones for training", () => {
    const rule = estimateDelivery(base);
    const learned = estimateDelivery({...base, learned: {prepLow: 28, prepHigh: 36, travelMinutes: 16}});
    expect(learned.etaMinMinutes).toBeGreaterThan(rule.etaMinMinutes);
    expect(learned.basis).toMatchObject({prepMinMinutes: 28, prepMaxMinutes: 36, statedPrepMinMinutes: 15, statedPrepMaxMinutes: 25,
      prepSource: "learned", travelSource: "learned", travelMinutes: 18});
    expect(rule.basis).toMatchObject({prepSource: "stated", travelSource: "rule", statedPrepMinMinutes: 15});
  });

  it("keeps the rules for whatever was not learned", () => {
    const prepOnly = estimateDelivery({...base, learned: {prepLow: 10, prepHigh: 14, travelMinutes: null}});
    expect(prepOnly.basis.travelSource).toBe("rule");
    expect(prepOnly.basis.prepSource).toBe("learned");
  });

  it("plans with the city's learned riding speed", () => {
    const legs: ClusterLegInput[] = [
      {restaurantId: "a", lat: 14.44, lng: 79.98, prepMinutes: 15, temperature: "hot", riderReachMinutes: 5},
      {restaurantId: "b", lat: 14.47, lng: 79.99, prepMinutes: 15, temperature: "hot", riderReachMinutes: 5},
    ];
    const customer = {lat: 14.46, lng: 80.0};
    const slow = planClusterDelivery(customer, legs, {...DEFAULT_CLUSTER_POLICY, minutesPerStraightKm: 6});
    const fast = planClusterDelivery(customer, legs, {...DEFAULT_CLUSTER_POLICY, minutesPerStraightKm: 2});
    expect(slow.etaMinutes).toBeGreaterThan(fast.etaMinutes);
  });
});

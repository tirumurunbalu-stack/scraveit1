import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
  db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_RTDB"); }},
}));

import {normalizeDispatchPolicy} from "../src/domain/dispatchPolicy";
import {
  DEFAULT_BATCH_POLICY,
  expectedReadyAt,
  planOrderBatch,
  type BatchDecision,
  type BatchOrderInput,
  type BatchPlan,
} from "../src/domain/orderBatch";
import {buildRiderJobProjection} from "../src/domain/riderJob";
import {batchLeadsNear, batchLinkFor, batchLinkFrom, batchOrderInput, bundleClaimAllowed} from "../src/services/dispatch";
import type {SavrivoOrder} from "../src/types";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const at = (lat: number, lng: number) => ({lat, lng});

// Nellore-sized distances: 0.001 degree is about 110 m.
const RIDER = at(14.4350, 79.9780); // about 600 m before the first restaurant
function lead(overrides: Partial<BatchOrderInput> = {}): BatchOrderInput {
  return {
    id: "A", createdAt: NOW - 10 * MIN, status: "Preparing",
    restaurant: at(14.4400, 79.9800), drop: at(14.4520, 79.9900),
    readyAt: NOW + 4 * MIN, promiseAt: NOW + 30 * MIN, temperature: "hot", itemCount: 2, locked: false,
    ...overrides,
  };
}
function next(overrides: Partial<BatchOrderInput> = {}): BatchOrderInput {
  return {
    id: "B", createdAt: NOW - MIN, status: "Preparing",
    restaurant: at(14.4420, 79.9810), drop: at(14.4560, 79.9920),
    readyAt: NOW + 6 * MIN, promiseAt: NOW + 35 * MIN, temperature: "hot", itemCount: 2, locked: false,
    ...overrides,
  };
}
function planOf(decision: BatchDecision): BatchPlan {
  if (!decision.ok) throw new Error(`expected a plan, got ${decision.reason}`);
  return decision;
}
const reasonOf = (decision: BatchDecision) => decision.ok ? "ok" : decision.reason;

describe("two-order batch planner", () => {
  it("adds a nearby order: both kitchens, then the earlier customer first, both on time", () => {
    const plan = planOf(planOrderBatch(lead(), next(), RIDER, NOW));
    expect(plan.pickupOrder).toEqual(["A", "B"]);
    expect(plan.dropOrder).toEqual(["A", "B"]);
    expect(plan.leadExtraMinutes).toBeGreaterThan(0);
    expect(plan.leadExtraMinutes).toBeLessThanOrEqual(DEFAULT_BATCH_POLICY.maxExtraMinutes);
    expect(plan.slackMinutes.A).toBeGreaterThan(0);
    expect(plan.slackMinutes.B).toBeGreaterThan(0);
    expect(plan.deliverAt.A).toBeLessThan(plan.deliverAt.B!);
    expect(plan.restaurantGapKm).toBeLessThanOrEqual(1);
    expect(plan.dropGapKm).toBeLessThanOrEqual(1.5);
    expect(plan.reasons.length).toBeGreaterThan(1);
  });

  it("delivers the order placed first first, even when it is the added one", () => {
    const plan = planOf(planOrderBatch(lead(), next({createdAt: NOW - 20 * MIN, drop: at(14.4530, 79.9905)}), RIDER, NOW));
    expect(plan.dropOrder).toEqual(["B", "A"]);
    expect(plan.deliverAt.B).toBeLessThan(plan.deliverAt.A!);
  });

  it("checks time, not only distance: the same addresses fail when the first customer would become late", () => {
    expect(planOrderBatch(lead(), next(), RIDER, NOW).ok).toBe(true);
    expect(reasonOf(planOrderBatch(lead({promiseAt: NOW + 17 * MIN}), next(), RIDER, NOW))).toBe("lead_promise");
  });

  it("lets an order that is already late slip only a little", () => {
    const extra = planOf(planOrderBatch(lead(), next(), RIDER, NOW)).leadExtraMinutes;
    const lateLead = lead({promiseAt: NOW + 10 * MIN});
    expect(reasonOf(planOrderBatch(lateLead, next(), RIDER, NOW,
      {...DEFAULT_BATCH_POLICY, lateLeadExtraMinutes: extra - 0.5}))).toBe("lead_promise");
    expect(planOrderBatch(lateLead, next(), RIDER, NOW,
      {...DEFAULT_BATCH_POLICY, lateLeadExtraMinutes: extra + 0.5}).ok).toBe(true);
  });

  it("never caps the first customer's delay above the limit, however early they are", () => {
    const plan = planOrderBatch(lead({promiseAt: NOW + 90 * MIN}), next(), RIDER, NOW,
      {...DEFAULT_BATCH_POLICY, maxExtraMinutes: 1});
    expect(reasonOf(plan)).toBe("lead_delay");
  });

  it("keeps the added customer's promise", () => {
    expect(reasonOf(planOrderBatch(lead(), next({promiseAt: NOW + 20 * MIN}), RIDER, NOW))).toBe("order_promise");
  });

  it("does not make the rider stand at the second kitchen", () => {
    expect(reasonOf(planOrderBatch(lead(), next({readyAt: NOW + 20 * MIN}), RIDER, NOW))).toBe("kitchen_wait");
  });

  it("does not leave the added order's packed food waiting long for the rider", () => {
    const farRider = at(14.4100, 79.9700);
    expect(reasonOf(planOrderBatch(lead({promiseAt: NOW + 60 * MIN}), next({status: "Ready for pickup", readyAt: NOW - 5 * MIN,
      promiseAt: NOW + 60 * MIN}), farRider, NOW))).toBe("food_waiting");
  });

  it("only batches customers who live near each other", () => {
    expect(reasonOf(planOrderBatch(lead(), next({drop: at(14.4700, 79.9900)}), RIDER, NOW))).toBe("customers_far");
  });

  it("only batches restaurants near each other", () => {
    expect(reasonOf(planOrderBatch(lead(), next({restaurant: at(14.4520, 79.9800)}), RIDER, NOW))).toBe("restaurants_far");
  });

  it("refuses a bag too big for one bike", () => {
    expect(reasonOf(planOrderBatch(lead({itemCount: 10}), next({itemCount: 6}), RIDER, NOW))).toBe("too_many_items");
  });

  it("keeps each bag's ride short", () => {
    expect(reasonOf(planOrderBatch(lead(), next(), RIDER, NOW, {...DEFAULT_BATCH_POLICY, maxCarryMinutes: 10}))).toBe("carry_too_long");
  });

  it("picks frozen food up last", () => {
    const plan = planOf(planOrderBatch(lead(), next({temperature: "frozen", promiseAt: NOW + 40 * MIN}), RIDER, NOW,
      {...DEFAULT_BATCH_POLICY, maxFrozenCarryMinutes: 30}));
    expect(plan.pickupOrder).toEqual(["A", "B"]);
    expect(plan.reasons.join(" ")).toMatch(/Frozen/);
  });

  it("gives ice cream on the bike less extra time", () => {
    // Frozen lead: its kitchen must be the last stop, which costs the first customer about 6 minutes.
    const frozenLead = lead({temperature: "frozen"});
    expect(reasonOf(planOrderBatch(frozenLead, next(), RIDER, NOW,
      {...DEFAULT_BATCH_POLICY, maxFrozenCarryMinutes: 30}))).toBe("lead_delay");
    const plan = planOf(planOrderBatch(frozenLead, next(), RIDER, NOW,
      {...DEFAULT_BATCH_POLICY, maxFrozenCarryMinutes: 30, maxExtraFrozenMinutes: 8}));
    expect(plan.pickupOrder).toEqual(["B", "A"]);
  });

  it("collects the second order after the first bag is already on the bike", () => {
    const pickedUp = lead({status: "Handed to rider", pickedUpAt: NOW - MIN, readyAt: NOW - 3 * MIN});
    const atKitchen = at(14.4400, 79.9800);
    const plan = planOf(planOrderBatch(pickedUp, next({readyAt: NOW + 3 * MIN}), atKitchen, NOW));
    expect(plan.pickupOrder).toEqual(["A", "B"]);
    expect(reasonOf(planOrderBatch(pickedUp, next({readyAt: NOW + 10 * MIN}), atKitchen, NOW))).toBe("kitchen_wait");
  });

  it("tries the other kitchen first when that is better for the first customer", () => {
    // The first order's kitchen is slow; the added order is ready on the way.
    const plan = planOf(planOrderBatch(lead({readyAt: NOW + 9 * MIN}), next({status: "Ready for pickup", readyAt: NOW - MIN,
      restaurant: at(14.4375, 79.9790)}), RIDER, NOW));
    expect(plan.pickupOrder).toEqual(["B", "A"]);
    expect(plan.leadExtraMinutes).toBeLessThanOrEqual(DEFAULT_BATCH_POLICY.maxExtraMinutes);
  });

  it("uses learned riding speed when known", () => {
    const usual = planOf(planOrderBatch(lead(), next(), RIDER, NOW));
    const quick = planOf(planOrderBatch(lead(), next(), RIDER, NOW, {...DEFAULT_BATCH_POLICY, minutesPerStraightKm: 2}));
    expect(quick.deliverAt.B).toBeLessThan(usual.deliverAt.B!);
    expect(reasonOf(planOrderBatch(lead(), next(), RIDER, NOW, {...DEFAULT_BATCH_POLICY, minutesPerStraightKm: 9}))).not.toBe("ok");
  });

  it("refuses orders that cannot join", () => {
    for (const status of ["Out for delivery", "Near you", "Arrived", "Delivered", "Cancelled"]) {
      expect(reasonOf(planOrderBatch(lead({status}), next(), RIDER, NOW))).toBe("lead_not_joinable");
    }
    expect(reasonOf(planOrderBatch(lead({locked: true}), next(), RIDER, NOW))).toBe("lead_not_joinable");
    expect(reasonOf(planOrderBatch(lead(), next({locked: true}), RIDER, NOW))).toBe("order_not_joinable");
    expect(reasonOf(planOrderBatch(lead(), next({status: "Assigned"}), RIDER, NOW))).toBe("order_not_joinable");
    expect(reasonOf(planOrderBatch(lead(), next({status: "Order placed"}), RIDER, NOW))).toBe("order_not_joinable");
    expect(reasonOf(planOrderBatch(lead(), lead(), RIDER, NOW))).toBe("order_not_joinable");
  });

  it("needs every location", () => {
    expect(reasonOf(planOrderBatch(lead(), next({drop: at(0, 0)}), RIDER, NOW))).toBe("no_location");
    expect(reasonOf(planOrderBatch(lead(), next(), at(Number.NaN, 79.98), NOW))).toBe("no_location");
  });

  it("is deterministic", () => {
    expect(planOrderBatch(lead(), next(), RIDER, NOW)).toEqual(planOrderBatch(lead(), next(), RIDER, NOW));
  });
});

describe("kitchen ready time", () => {
  it("counts prep from acceptance, never in the past while still cooking", () => {
    const accepted = {status: "Preparing", createdAt: NOW - 20 * MIN, statusHistory: {e1: {status: "Accepted", at: NOW - 15 * MIN}}};
    expect(expectedReadyAt(accepted, 20, NOW)).toBe(NOW + 5 * MIN);
    expect(expectedReadyAt(accepted, 10, NOW)).toBe(NOW + 2 * MIN);
  });

  it("uses the group-order kitchen start when later", () => {
    expect(expectedReadyAt({status: "Accepted", createdAt: NOW - 5 * MIN, kitchenStartAt: NOW + 5 * MIN}, 15, NOW)).toBe(NOW + 20 * MIN);
  });

  it("is when the food was packed once it is ready", () => {
    expect(expectedReadyAt({status: "Ready for pickup", createdAt: NOW - 30 * MIN,
      statusHistory: {e: {status: "Ready for pickup", at: NOW - 4 * MIN}}}, 20, NOW)).toBe(NOW - 4 * MIN);
    expect(expectedReadyAt({status: "Assigned", createdAt: NOW - 30 * MIN}, 20, NOW)).toBe(NOW);
  });
});

function order(id: string, overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id, customerId: `c_${id}`, restaurantId: `r_${id}`, restaurant: `Kitchen ${id}`, status: "Preparing",
    createdAt: NOW - 10 * MIN, updatedAt: NOW, deliveryMode: "asap",
    restaurantLocation: {address: "", lat: 14.44, lng: 79.98}, address: {lat: 14.452, lng: 79.99, area: "Magunta Layout"},
    items: [{name: "Chicken biryani", quantity: 2}], etaMax: 40, statusHistory: {}, total: 300, paymentMethod: "cod",
    pricing: {subtotal: 250, deliveryFee: 25, platformFee: 7, tip: 0, discount: 0, total: 300},
    ...overrides,
  } as unknown as SavrivoOrder;
}

describe("batch dispatch helpers", () => {
  it("reads an order for the planner", () => {
    const input = batchOrderInput(order("A", {items: [{name: "Butterscotch ice cream", quantity: 1}, {name: "Dosa", quantity: 3}] as never}), 15, NOW);
    expect(input).toMatchObject({id: "A", itemCount: 4, temperature: "frozen", promiseAt: NOW + 30 * MIN, locked: false});
    const handed = batchOrderInput(order("A", {status: "Handed to rider", statusHistory: {e: {status: "Handed to rider", at: NOW - 2 * MIN}} as never}), 15, NOW);
    expect(handed.pickedUpAt).toBe(NOW - 2 * MIN);
  });

  it("never batches group-order parts, scheduled or already batched orders", () => {
    expect(batchOrderInput(order("A", {clusterId: "CL1"}), 15, NOW).locked).toBe(true);
    expect(batchOrderInput(order("A", {deliveryMode: "scheduled"}), 15, NOW).locked).toBe(true);
    expect(batchOrderInput(order("A", {batch: {} as never}), 15, NOW).locked).toBe(true);
  });

  it("finds riders with one order whose restaurant is close, nearest first", () => {
    const point = at(14.44, 79.98);
    const job = (riderId: string, orderId: string, lat: number, extra: Record<string, unknown> = {}) =>
      ({riderId, orderId, status: "active", orderStatus: "Assigned", restaurantLat: lat, restaurantLng: 79.98, ...extra});
    const leads = batchLeadsNear([
      job("r1", "o1", 14.4460),
      job("r2", "o2", 14.4410),
      job("r3", "o3", 14.4405), job("r3", "o4", 14.4405), // already carrying two
      job("r4", "o5", 14.4402, {orderStatus: "Out for delivery"}), // left the restaurant
      job("r5", "o6", 14.4402, {trip: {clusterId: "CL"}}), // on a group trip
      job("r6", "o7", 14.4600), // restaurant 2 km away
      job("r7", "o8", 14.4401, {status: "completed"}),
      job("r8", "o9", 14.4403, {orderStatus: "Handed to rider"}),
    ], point, 1);
    expect(leads.map((entry) => entry.riderId)).toEqual(["r8", "r2", "r1"]);
    expect(leads[0]?.leadOrderId).toBe("o9");
  });

  it("lets the rider claim the added order only with just that one order, before leaving its restaurant", () => {
    const queue = {bundle: {kind: "batch" as const, leadOrderId: "A", riderId: "r1", stop: 1, stops: 2}};
    expect(bundleClaimAllowed(queue, "r1", {r1_A: {status: "active", orderStatus: "Assigned"}})).toBe(true);
    expect(bundleClaimAllowed(queue, "r1", {r1_A: {status: "active", orderStatus: "Handed to rider"}})).toBe(true);
    expect(bundleClaimAllowed(queue, "r1", {r1_A: {status: "active", orderStatus: "Out for delivery"}})).toBe(false);
    expect(bundleClaimAllowed(queue, "r1", {r1_A: {status: "active", orderStatus: "Assigned"}, r1_C: {status: "active"}})).toBe(false);
    expect(bundleClaimAllowed(queue, "r1", {r1_A: {status: "completed", orderStatus: "Delivered"}})).toBe(false);
    expect(bundleClaimAllowed(queue, "r2", {r2_A: {status: "active", orderStatus: "Assigned"}})).toBe(false);
  });

  it("still lets a group trip's rider take its later pickups as before", () => {
    const queue = {bundle: {leadOrderId: "A", riderId: "r1", stop: 1, stops: 3}};
    expect(bundleClaimAllowed(queue, "r1", {r1_A: {status: "active", orderStatus: "Out for delivery"}, r1_B: {status: "active"}})).toBe(true);
  });

  it("links both orders: doors in the order placed, each knowing its turn", () => {
    const first = order("A", {createdAt: NOW - 10 * MIN});
    const added = order("B", {createdAt: NOW - MIN});
    const link = batchLinkFrom({kind: "batch", leadOrderId: "A", riderId: "r1", stop: 1, stops: 2,
      pickupOrder: ["B", "A"], dropOrder: ["A", "B"], leadExtraMinutes: 4}, added, first, NOW);
    expect(link).toMatchObject({orderIds: ["A", "B"], dropOrder: ["A", "B"], pickupOrder: ["B", "A"], position: 2, size: 2,
      leadOrderId: "A", leadExtraMinutes: 4});
    expect(batchLinkFor(link, "A").position).toBe(1);
    const earlier = batchLinkFrom({leadOrderId: "A", riderId: "r1", stop: 1, stops: 2}, order("B", {createdAt: NOW - 30 * MIN}), first, NOW);
    expect(earlier.dropOrder).toEqual(["B", "A"]);
    expect(earlier.position).toBe(1);
    expect(earlier.pickupOrder).toEqual(["A", "B"]);
  });

  it("puts the batch on the rider's job without the other customer's details", () => {
    const link = batchLinkFrom({kind: "batch", leadOrderId: "A", riderId: "r1", stop: 1, stops: 2, pickupOrder: ["A", "B"]},
      order("B", {createdAt: NOW - MIN}), order("A"), NOW);
    const projection = buildRiderJobProjection(order("B", {riderId: "r1", batch: link}));
    expect(projection.batch).toEqual({id: link.id, orderIds: ["A", "B"], leadOrderId: "A", pickupOrder: ["A", "B"],
      dropOrder: ["A", "B"], position: 2, size: 2});
    expect(buildRiderJobProjection(order("C", {riderId: "r1"})).batch).toBeUndefined();
  });

  it("can be switched off from admin settings", () => {
    expect(normalizeDispatchPolicy({}).batchingEnabled).toBeUndefined();
    expect(normalizeDispatchPolicy({batchingEnabled: false}).batchingEnabled).toBe(false);
    expect(normalizeDispatchPolicy({batchingEnabled: "no"}).batchingEnabled).toBeUndefined();
  });
});

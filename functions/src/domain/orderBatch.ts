/**
 * Two-order batching: a rider already on the way to one order (the lead) also collects a second
 * customer's order nearby, then delivers them one after the other, the order that was placed
 * first delivered first.
 *
 * A batch is only made when it is good for both customers, judged on time, not just distance:
 *
 *  - the two restaurants are close (1 km) and so are the two customers (1.5 km);
 *  - the rider waits at most 5 minutes at the second kitchen, and the second order's food
 *    does not sit on the counter for more than 10 minutes;
 *  - the lead customer gets their food at most 8 minutes later than if the rider went straight
 *    there (5 when the bag holds ice cream), and never later than the time they were promised
 *    (an order already running late may slip by 3 minutes at most);
 *  - the second customer still gets their food within the time they were promised;
 *  - no bag rides longer than 30 minutes (15 for frozen food), and frozen food is picked up last.
 *
 * Pure and deterministic: the same inputs always give the same plan, and every plan carries the
 * numbers it was chosen on so the decision can be logged.
 */
import {straightKm, type FoodTemperature} from "./clusterPlan";

export interface BatchPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface BatchOrderInput {
  readonly id: string;
  /** When the customer placed it: the earlier order is delivered first. */
  readonly createdAt: number;
  readonly status: string;
  readonly restaurant: BatchPoint;
  readonly drop: BatchPoint;
  /** When the food is expected to be packed (already past when it is ready). */
  readonly readyAt: number;
  /** Set when the bag is already with the rider. */
  readonly pickedUpAt?: number;
  /** The latest delivery time the customer was promised. */
  readonly promiseAt: number;
  readonly temperature: FoodTemperature;
  readonly itemCount: number;
  /** Part of a multi-restaurant trip, already batched, or scheduled: never batched. */
  readonly locked: boolean;
}

export interface BatchPolicy {
  readonly maxRestaurantGapKm: number;
  readonly maxDropGapKm: number;
  /** Longest the rider may stand at the second kitchen waiting for food. */
  readonly maxKitchenWaitMinutes: number;
  /** Longest the added order's packed food may wait on the counter for the rider. */
  readonly maxCounterMinutes: number;
  readonly maxExtraMinutes: number;
  readonly maxExtraFrozenMinutes: number;
  /** How much later a lead order that is already late may become. */
  readonly lateLeadExtraMinutes: number;
  readonly maxCarryMinutes: number;
  readonly maxFrozenCarryMinutes: number;
  readonly maxItems: number;
  readonly pickupMinutes: number;
  readonly handoverMinutes: number;
  readonly speedKmph: number;
  readonly roadFactor: number;
  /** Learned riding minutes per straight-line km for this city and hour (replaces speed x road factor). */
  readonly minutesPerStraightKm?: number;
}

export const DEFAULT_BATCH_POLICY: BatchPolicy = {
  maxRestaurantGapKm: 1,
  maxDropGapKm: 1.5,
  maxKitchenWaitMinutes: 5,
  maxCounterMinutes: 10,
  maxExtraMinutes: 8,
  maxExtraFrozenMinutes: 5,
  lateLeadExtraMinutes: 3,
  maxCarryMinutes: 30,
  maxFrozenCarryMinutes: 15,
  maxItems: 15,
  pickupMinutes: 3,
  handoverMinutes: 3,
  speedKmph: 22,
  roadFactor: 1.3,
};

/** Lead statuses a second order can still join: before the rider leaves the first restaurant. */
const LEAD_JOINABLE = new Set(["Accepted", "Preparing", "Ready for pickup", "Assigned", "Handed to rider"]);
/** Statuses an order can be added to a rider's trip in: dispatch has not given it a rider yet. */
const NEXT_JOINABLE = new Set(["Accepted", "Preparing", "Ready for pickup"]);

export type BatchRejection =
  | "lead_not_joinable"
  | "order_not_joinable"
  | "no_location"
  | "restaurants_far"
  | "customers_far"
  | "too_many_items"
  | "kitchen_wait"
  | "food_waiting"
  | "lead_delay"
  | "lead_promise"
  | "order_promise"
  | "carry_too_long";

export interface BatchPlan {
  readonly ok: true;
  /** Restaurants in the order the rider collects them (order ids). */
  readonly pickupOrder: [string, string];
  /** Doors in the order the rider delivers them: the earlier-placed order first. */
  readonly dropOrder: [string, string];
  /** How much later the lead customer gets their food than if the rider went straight there. */
  readonly leadExtraMinutes: number;
  /** Expected delivery times. */
  readonly deliverAt: Readonly<Record<string, number>>;
  /** Minutes to spare before each customer's promised time (negative: late). */
  readonly slackMinutes: Readonly<Record<string, number>>;
  readonly kitchenWaitMinutes: number;
  readonly longestCarryMinutes: number;
  readonly restaurantGapKm: number;
  readonly dropGapKm: number;
  readonly reasons: readonly string[];
}

export type BatchDecision = BatchPlan | {readonly ok: false; readonly reason: BatchRejection};

function rideMs(a: BatchPoint, b: BatchPoint, policy: BatchPolicy): number {
  const perKm = policy.minutesPerStraightKm;
  const minutes = typeof perKm === "number" && Number.isFinite(perKm) && perKm > 0 ?
    straightKm(a, b) * perKm :
    straightKm(a, b) * policy.roadFactor / policy.speedKmph * 60;
  return minutes * 60_000;
}

function validPoint(point: BatchPoint | undefined): point is BatchPoint {
  return Boolean(point) && Number.isFinite(point!.lat) && Number.isFinite(point!.lng) &&
    !(point!.lat === 0 && point!.lng === 0);
}

interface Run {
  deliverAt: Record<string, number>;
  pickedAt: Record<string, number>;
  /** Minutes the rider stood at each kitchen waiting for food. */
  kitchenWait: Record<string, number>;
  /** Minutes packed food waited on the counter for the rider. */
  counterWait: Record<string, number>;
}

/** Rides the route from where the rider is now; bags already on the bike are not collected again. */
function simulate(rider: BatchPoint, now: number, pickups: readonly BatchOrderInput[],
  drops: readonly BatchOrderInput[], policy: BatchPolicy): Run {
  const run: Run = {deliverAt: {}, pickedAt: {}, kitchenWait: {}, counterWait: {}};
  let t = now;
  let at = rider;
  for (const order of pickups) {
    if (order.pickedUpAt !== undefined) {
      run.pickedAt[order.id] = order.pickedUpAt;
      run.kitchenWait[order.id] = 0;
      run.counterWait[order.id] = 0;
      continue;
    }
    const arrive = t + rideMs(at, order.restaurant, policy);
    const collect = Math.max(arrive, order.readyAt);
    run.kitchenWait[order.id] = (collect - arrive) / 60_000;
    run.counterWait[order.id] = Math.max(0, arrive - Math.max(order.readyAt, now)) / 60_000;
    t = collect + policy.pickupMinutes * 60_000;
    run.pickedAt[order.id] = t;
    at = order.restaurant;
  }
  for (const order of drops) {
    t += rideMs(at, order.drop, policy);
    t += policy.handoverMinutes * 60_000;
    run.deliverAt[order.id] = t;
    at = order.drop;
  }
  return run;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Whether the rider carrying `lead` should also take `next`, and how. `rider` is where the rider
 * is now. Returns the best plan that keeps both customers' times, or why there is none.
 */
export function planOrderBatch(lead: BatchOrderInput, next: BatchOrderInput, rider: BatchPoint, now: number,
  policy: BatchPolicy = DEFAULT_BATCH_POLICY): BatchDecision {
  if (lead.locked || !LEAD_JOINABLE.has(lead.status)) return {ok: false, reason: "lead_not_joinable"};
  if (next.locked || !NEXT_JOINABLE.has(next.status) || next.id === lead.id) return {ok: false, reason: "order_not_joinable"};
  if (![lead.restaurant, lead.drop, next.restaurant, next.drop, rider].every(validPoint)) return {ok: false, reason: "no_location"};
  const restaurantGapKm = straightKm(lead.restaurant, next.restaurant);
  if (restaurantGapKm > policy.maxRestaurantGapKm) return {ok: false, reason: "restaurants_far"};
  const dropGapKm = straightKm(lead.drop, next.drop);
  if (dropGapKm > policy.maxDropGapKm) return {ok: false, reason: "customers_far"};
  if (lead.itemCount + next.itemCount > policy.maxItems) return {ok: false, reason: "too_many_items"};

  // The lead on its own: the plan every batch is compared with.
  const solo = simulate(rider, now, [lead], [lead], policy);
  const soloDeliver = solo.deliverAt[lead.id]!;
  const leadOnTimeAlone = soloDeliver <= lead.promiseAt;

  const dropOrder: [BatchOrderInput, BatchOrderInput] = next.createdAt < lead.createdAt ? [next, lead] : [lead, next];
  // A bag already on the bike stays first; otherwise try both kitchens first. Frozen food last.
  const pickupOrders: Array<[BatchOrderInput, BatchOrderInput]> = lead.pickedUpAt !== undefined ?
    [[lead, next]] : [[lead, next], [next, lead]];
  const allowed = pickupOrders.filter(([first, second]) =>
    !(first.temperature === "frozen" && second.temperature !== "frozen"));

  let best: {plan: BatchPlan; score: number} | null = null;
  let firstFailure: BatchRejection | null = null;
  const fail = (reason: BatchRejection) => { if (!firstFailure) firstFailure = reason; };
  for (const [first, second] of allowed) {
    const run = simulate(rider, now, [first, second], dropOrder, policy);
    // The rider must not stand at the second kitchen while the first bag cools.
    if (run.kitchenWait[second.id]! > policy.maxKitchenWaitMinutes) { fail("kitchen_wait"); continue; }
    // Nor may the added order's packed food wait long on the counter for the rider.
    if (run.counterWait[next.id]! > policy.maxCounterMinutes) { fail("food_waiting"); continue; }
    const leadDeliver = run.deliverAt[lead.id]!;
    const extra = (leadDeliver - soloDeliver) / 60_000;
    const maxExtra = lead.temperature === "frozen" ? policy.maxExtraFrozenMinutes : policy.maxExtraMinutes;
    if (extra > maxExtra) { fail("lead_delay"); continue; }
    if (leadOnTimeAlone ? leadDeliver > lead.promiseAt : extra > policy.lateLeadExtraMinutes) { fail("lead_promise"); continue; }
    if (run.deliverAt[next.id]! > next.promiseAt) { fail("order_promise"); continue; }
    const carry = (order: BatchOrderInput) => (run.deliverAt[order.id]! - run.pickedAt[order.id]!) / 60_000;
    const carryOk = [lead, next].every((order) =>
      carry(order) <= (order.temperature === "frozen" ? policy.maxFrozenCarryMinutes : policy.maxCarryMinutes));
    if (!carryOk) { fail("carry_too_long"); continue; }
    const slack = (order: BatchOrderInput) => round1((order.promiseAt - run.deliverAt[order.id]!) / 60_000);
    const reasons = [
      `Restaurants ${round1(restaurantGapKm)} km apart, customers ${round1(dropGapKm)} km apart.`,
      `${dropOrder[0].id === lead.id ? "First" : "Second"} customer (placed ${dropOrder[0].id === lead.id ? "first" : "later"}) gets food ${round1(Math.max(0, extra))} min later than a solo trip.`,
      `Both orders on time: ${slack(lead)} and ${slack(next)} min to spare.`,
      ...(allowed.length < pickupOrders.length || [lead, next].some((order) => order.temperature === "frozen") ?
        ["Frozen food is picked up last."] : []),
    ];
    const plan: BatchPlan = {
      ok: true,
      pickupOrder: [first.id, second.id],
      dropOrder: [dropOrder[0].id, dropOrder[1].id],
      leadExtraMinutes: round1(Math.max(0, extra)),
      deliverAt: {[lead.id]: Math.round(leadDeliver), [next.id]: Math.round(run.deliverAt[next.id]!)},
      slackMinutes: {[lead.id]: slack(lead), [next.id]: slack(next)},
      kitchenWaitMinutes: round1(run.kitchenWait[second.id]!),
      longestCarryMinutes: round1(Math.max(carry(lead), carry(next))),
      restaurantGapKm: round1(restaurantGapKm),
      dropGapKm: round1(dropGapKm),
      reasons,
    };
    // Prefer the lead's smallest delay, then the earliest delivery of the added order.
    const score = extra * 2 + (run.deliverAt[next.id]! - now) / 60_000;
    if (!best || score < best.score) best = {plan, score};
  }
  if (best) return best.plan;
  return {ok: false, reason: firstFailure ?? "lead_delay"};
}

type StatusTimeline = {statusHistory?: Record<string, {status?: string; at?: number} | undefined>};

/** When the order first reached this status, or null. */
export function statusEventAt(order: StatusTimeline, status: string): number | null {
  let earliest: number | null = null;
  for (const event of Object.values(order.statusHistory ?? {})) {
    const at = Number(event?.at);
    if (event?.status === status && Number.isFinite(at)) earliest = earliest === null ? at : Math.min(earliest, at);
  }
  return earliest;
}

/** When the kitchen is expected to have the food packed (now or earlier once it is ready). */
export function expectedReadyAt(order: StatusTimeline & {status: string; createdAt: number; kitchenStartAt?: number},
  prepMinutes: number, now: number): number {
  if (!["Order placed", "Accepted", "Preparing"].includes(order.status)) return Math.min(now, statusEventAt(order, "Ready for pickup") ?? now);
  const start = Math.max(Number(order.kitchenStartAt) || 0, statusEventAt(order, "Accepted") ?? order.createdAt);
  // A kitchen running past its estimate is expected to finish shortly, not in the past.
  return Math.max(start + prepMinutes * 60_000, now + 2 * 60_000);
}

/**
 * Multi-restaurant ("cluster") orders: one customer, one cart, food from up to three
 * restaurants. Each restaurant still gets its own normal order; this module decides how
 * the food reaches the customer together:
 *
 *  - which restaurants one rider can collect in a single trip, and when more riders are
 *    needed (every way of grouping the restaurants is scored; three restaurants have five);
 *  - the pickup order inside a trip (frozen food is always collected last);
 *  - how long each kitchen should wait before starting, so food is ready when its rider
 *    arrives and every rider reaches the customer within a few minutes of the others.
 *
 * Pure and deterministic: the same inputs always give the same plan, and every plan
 * carries the numbers it was chosen on, so decisions can be logged and later used to
 * train prep-time and travel-time models (see clusterPlanFeatures).
 */

export type FoodTemperature = "hot" | "cold" | "frozen";

const FROZEN = /ice\s?cream|kulfi|gelato|sundae|frozen|popsicle|softy|cone/i;
const COLD = /juice|shake|smoothie|lassi|cold\s?coffee|mojito|falooda|soda|salad|curd|raita/i;

/** The coldest item decides how a restaurant's bag must travel. */
export function partTemperature(names: readonly string[]): FoodTemperature {
  if (names.some((name) => FROZEN.test(name))) return "frozen";
  if (names.some((name) => COLD.test(name))) return "cold";
  return "hot";
}

/** Kitchen minutes when nothing has been learned yet: the restaurant's window less the ride. */
export function fallbackPrepMinutes(restaurant: {etaMin?: unknown; etaMax?: unknown} | null | undefined): number {
  const low = Number(restaurant?.etaMin), high = Number(restaurant?.etaMax);
  if (Number.isFinite(low) && Number.isFinite(high) && high > 0) return Math.max(3, Math.min(60, (low + high) / 2 - 8));
  return 18;
}

/** The restaurant's own prep figure, as the delivery promise reads it (middle of its window). */
export function statedPrepMinutes(restaurant: {etaMin?: unknown; etaMax?: unknown} | null | undefined): number {
  const low = Number(restaurant?.etaMin), high = Number(restaurant?.etaMax);
  return Number.isFinite(low) && Number.isFinite(high) && high > 0 ? (Math.max(3, low) + Math.max(3, high)) / 2 : 20;
}

export interface ClusterPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface ClusterLegInput extends ClusterPoint {
  readonly restaurantId: string;
  /** Expected minutes from the kitchen starting until the food is packed. */
  readonly prepMinutes: number;
  /** Coldest item in this restaurant's part of the order. */
  readonly temperature: FoodTemperature;
  /** Minutes until the nearest free rider could reach this restaurant; null when unknown. */
  readonly riderReachMinutes: number | null;
}

export interface ClusterPolicy {
  readonly speedKmph: number;
  /** Road distance is longer than a straight line; straight-line km are multiplied by this. */
  readonly roadFactor: number;
  /** Minutes spent at each restaurant collecting the bag. */
  readonly pickupMinutes: number;
  /** Minutes at the door handing over. */
  readonly handoverMinutes: number;
  /** Assumed rider reach when supply is unknown. */
  readonly defaultReachMinutes: number;
  /** Longest a hot or cold bag may ride before delivery. */
  readonly maxCarryMinutes: number;
  /** Longest frozen food may ride before delivery. */
  readonly maxFrozenCarryMinutes: number;
  /** How much later a shared trip may arrive than the fastest plan and still be chosen. */
  readonly maxSharedDelayMinutes: number;
  /** Riders on separate trips must reach the door within this many minutes of each other. */
  readonly maxArrivalSpreadMinutes: number;
  /** Cost of sending one more rider, in minutes of customer waiting it is worth. */
  readonly riderCostMinutes: number;
  readonly maxLegs: number;
  /** Learned riding minutes per straight-line km for this city and hour (replaces speed x road factor). */
  readonly minutesPerStraightKm?: number;
}

export const DEFAULT_CLUSTER_POLICY: ClusterPolicy = {
  speedKmph: 22,
  roadFactor: 1.3,
  pickupMinutes: 3,
  handoverMinutes: 3,
  defaultReachMinutes: 7,
  maxCarryMinutes: 30,
  maxFrozenCarryMinutes: 15,
  maxSharedDelayMinutes: 10,
  maxArrivalSpreadMinutes: 5,
  riderCostMinutes: 12,
  maxLegs: 3,
};

export interface ClusterTrip {
  /** Restaurants this rider collects from, in pickup order. */
  readonly pickups: readonly string[];
  /** Minutes after the order is placed that the rider reaches the customer, before handover. */
  readonly arriveMinutes: number;
  /** Minutes the longest-carried bag spends on the bike. */
  readonly longestCarryMinutes: number;
}

export interface ClusterPlan {
  readonly riders: number;
  readonly trips: readonly ClusterTrip[];
  /** Minutes each kitchen should wait after the order is accepted before it starts cooking. */
  readonly kitchenStartDelayMinutes: Readonly<Record<string, number>>;
  /** Minutes after the order is placed that the last of the food is handed over. */
  readonly etaMinutes: number;
  /** Gap between the first and last rider reaching the door. */
  readonly arrivalSpreadMinutes: number;
  readonly score: number;
  /** Plain-language reasons, shown to ops and stored with the decision. */
  readonly reasons: readonly string[];
}

const EARTH_KM = 6371;

export function straightKm(a: ClusterPoint, b: ClusterPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function rideMinutes(a: ClusterPoint, b: ClusterPoint, policy: ClusterPolicy): number {
  const perKm = policy.minutesPerStraightKm;
  if (typeof perKm === "number" && Number.isFinite(perKm) && perKm > 0) return straightKm(a, b) * perKm;
  return straightKm(a, b) * policy.roadFactor / policy.speedKmph * 60;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

/** Every way of splitting the restaurants into rider trips (set partitions). */
function partitions<T>(items: readonly T[]): T[][][] {
  if (!items.length) return [[]];
  const [first, ...rest] = items;
  return partitions(rest).flatMap((partition) => [
    [[first as T], ...partition],
    ...partition.map((_, index) => partition.map((group, at) => at === index ? [first as T, ...group] : group)),
  ]);
}

interface TripEvaluation {
  readonly order: ClusterLegInput[];
  readonly arrive: number;
  readonly pickupAt: number[];
  readonly longestCarry: number;
  readonly ok: boolean;
}

/**
 * One rider collects `order` in sequence. Kitchens can be told to start late, never early,
 * so a bag is ready at max(rider arrives, prepMinutes). Each bag's carry time is measured
 * from its pickup to the door.
 */
function evaluateTrip(order: ClusterLegInput[], customer: ClusterPoint, policy: ClusterPolicy): TripEvaluation {
  const first = order[0] as ClusterLegInput;
  let clock = first.riderReachMinutes ?? policy.defaultReachMinutes;
  let at: ClusterPoint = first;
  const pickupAt: number[] = [];
  order.forEach((leg, index) => {
    if (index > 0) clock += rideMinutes(at, leg, policy);
    clock = Math.max(clock, leg.prepMinutes) + policy.pickupMinutes;
    pickupAt.push(clock);
    at = leg;
  });
  const arrive = clock + rideMinutes(at, customer, policy);
  let longestCarry = 0;
  let ok = true;
  order.forEach((leg, index) => {
    const carry = arrive - (pickupAt[index] as number);
    longestCarry = Math.max(longestCarry, carry);
    if (carry > (leg.temperature === "frozen" ? policy.maxFrozenCarryMinutes : policy.maxCarryMinutes)) ok = false;
  });
  // Frozen food never waits on the bike while the rider collects something else.
  const frozenIndex = order.findIndex((leg) => leg.temperature === "frozen");
  if (frozenIndex >= 0 && frozenIndex !== order.length - 1) ok = false;
  return {order, arrive, pickupAt, longestCarry, ok};
}

function bestTrip(group: ClusterLegInput[], customer: ClusterPoint, policy: ClusterPolicy): TripEvaluation | null {
  let best: TripEvaluation | null = null;
  for (const order of permutations(group)) {
    const trip = evaluateTrip(order, customer, policy);
    if (!trip.ok) continue;
    if (!best || trip.arrive < best.arrive - 1e-9 || (Math.abs(trip.arrive - best.arrive) < 1e-9 && trip.longestCarry < best.longestCarry)) best = trip;
  }
  return best;
}

const round = (value: number) => Math.round(value);

export function planClusterDelivery(
  customer: ClusterPoint,
  legsInput: readonly ClusterLegInput[],
  policy: ClusterPolicy = DEFAULT_CLUSTER_POLICY,
): ClusterPlan {
  if (!legsInput.length) throw new Error("CLUSTER_PLAN_NO_LEGS");
  if (legsInput.length > policy.maxLegs) throw new Error("CLUSTER_PLAN_TOO_MANY_LEGS");
  if (new Set(legsInput.map((leg) => leg.restaurantId)).size !== legsInput.length) throw new Error("CLUSTER_PLAN_DUPLICATE_RESTAURANT");
  const legs = legsInput.map((leg) => ({
    ...leg,
    prepMinutes: Math.max(0, Number.isFinite(leg.prepMinutes) ? leg.prepMinutes : 20),
    riderReachMinutes: leg.riderReachMinutes === null || !Number.isFinite(leg.riderReachMinutes) ? null : Math.max(0, leg.riderReachMinutes),
  }));

  // The fastest possible plan: a rider per restaurant. Shared trips are judged against it.
  const solo = legs.map((leg) => evaluateTrip([leg], customer, policy).arrive);
  const fastest = Math.max(...solo);

  let best: {trips: TripEvaluation[]; score: number; eta: number; spread: number} | null = null;
  for (const partition of partitions(legs)) {
    const trips = partition.map((group) => bestTrip(group, customer, policy));
    if (trips.some((trip) => !trip)) continue;
    const evaluated = trips as TripEvaluation[];
    const latest = Math.max(...evaluated.map((trip) => trip.arrive));
    if (latest - fastest > policy.maxSharedDelayMinutes + 1e-9) continue;
    // Separate riders are held back (by starting kitchens later) to reach the door
    // together, so the plan's spread is what remains after that alignment.
    const score = latest + policy.riderCostMinutes * (evaluated.length - 1) +
      evaluated.reduce((sum, trip) => sum + trip.longestCarry, 0) / 10;
    if (!best || score < best.score - 1e-9) best = {trips: evaluated, score, eta: latest, spread: 0};
  }
  // A rider per restaurant always works when bags travel alone, so this only
  // happens when a single leg already breaks its own carry limit (a very far restaurant).
  if (!best) {
    const trips = legs.map((leg) => evaluateTrip([leg], customer, policy));
    best = {trips, score: Infinity, eta: fastest, spread: 0};
  }

  // Align arrivals: every trip that would arrive early has its kitchens start later.
  const target = best.eta;
  const kitchenStartDelayMinutes: Record<string, number> = {};
  const trips: ClusterTrip[] = [];
  let earliestArrival = Infinity;
  for (const trip of best.trips) {
    // An early trip is shifted later as a whole (its rider is sent later), and each of its
    // kitchens starts so the bag is packed just as that rider walks in.
    const hold = Math.max(0, target - trip.arrive);
    trip.order.forEach((leg, index) => {
      const riderAt = (trip.pickupAt[index] as number) - policy.pickupMinutes + hold;
      kitchenStartDelayMinutes[leg.restaurantId] = round(Math.max(0, riderAt - leg.prepMinutes));
    });
    const arrive = trip.arrive + hold;
    earliestArrival = Math.min(earliestArrival, arrive);
    trips.push({pickups: trip.order.map((leg) => leg.restaurantId), arriveMinutes: round(arrive), longestCarryMinutes: round(trip.longestCarry)});
  }
  const spread = round(Math.max(0, target - earliestArrival));

  const reasons: string[] = [];
  if (trips.length === 1 && legs.length > 1) {
    reasons.push(`One rider collects all ${legs.length} restaurants; that is at most ${round(target - fastest)} min slower than separate riders.`);
  } else if (trips.length === legs.length && legs.length > 1) {
    reasons.push(`Restaurants are too far apart for one trip, so ${legs.length} riders go at once.`);
  } else if (legs.length > 1) {
    reasons.push(`${trips.length} riders: restaurants close together share a rider.`);
  }
  if (legs.some((leg) => leg.temperature === "frozen")) reasons.push("Frozen food is picked up last.");
  const held = Object.entries(kitchenStartDelayMinutes).filter(([, minutes]) => minutes >= 2);
  if (held.length) reasons.push("Faster kitchens start later so all the food arrives fresh and together.");
  if (spread > policy.maxArrivalSpreadMinutes) reasons.push(`Riders may reach you up to ${spread} min apart.`);

  return {
    riders: trips.length,
    trips,
    kitchenStartDelayMinutes,
    etaMinutes: round(target + policy.handoverMinutes),
    arrivalSpreadMinutes: spread,
    score: Number.isFinite(best.score) ? Math.round(best.score * 10) / 10 : -1,
    reasons,
  };
}

/** The numbers a plan was decided on, flattened for the decision log and later model training. */
export function clusterPlanFeatures(customer: ClusterPoint, legs: readonly ClusterLegInput[], plan: ClusterPlan): Record<string, number | string> {
  const features: Record<string, number | string> = {
    legs: legs.length,
    riders: plan.riders,
    etaMinutes: plan.etaMinutes,
    spreadMinutes: plan.arrivalSpreadMinutes,
    frozenLegs: legs.filter((leg) => leg.temperature === "frozen").length,
  };
  legs.forEach((leg, index) => {
    features[`leg${index}_restaurantId`] = leg.restaurantId;
    features[`leg${index}_prep`] = leg.prepMinutes;
    features[`leg${index}_reach`] = leg.riderReachMinutes ?? -1;
    features[`leg${index}_toCustomerKm`] = Math.round(straightKm(leg, customer) * 100) / 100;
    features[`leg${index}_hold`] = plan.kitchenStartDelayMinutes[leg.restaurantId] ?? 0;
  });
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      features[`gap${i}${j}_km`] = Math.round(straightKm(legs[i] as ClusterLegInput, legs[j] as ClusterLegInput) * 100) / 100;
    }
  }
  return features;
}

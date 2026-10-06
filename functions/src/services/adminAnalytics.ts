import type {DecodedIdToken} from "firebase-admin/auth";
import {firestoreDb} from "../admin";
import {
  AGE_BANDS,
  CUSTOMER_DEMOGRAPHICS_COLLECTION,
  type AgeBand,
  type CustomerSegment,
  type Gender,
  areaKey,
  segmentFrom,
  segmentLabel,
} from "../domain/customerSegments";
import type {FirestoreLike} from "../firestoreTypes";
import {requirePlatformConfigAdminClaim} from "./authz";

/**
 * Customer insights for the owner: who orders (women/men, age groups), from
 * where, what, when, and how offers perform - so offers can be aimed at the
 * dishes and groups that will actually use them.
 *
 * Everything returned is an aggregate. No names, phone numbers or customer
 * IDs leave this function; gender and age come only from customers who chose
 * to share them, and anyone who didn't is counted as "Not shared".
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 90;
const MAX_ORDERS = 15_000;
const LAPSED_AFTER_DAYS = 21;
const HEAT_CELL_DEG = 0.004;
const CACHE_MS = 5 * 60 * 1000;

type Rec = Record<string, unknown>;
type GenderKey = Gender | "unknown";
type AgeKey = AgeBand | "unknown";
export type StoreKind = "restaurant" | "grocery" | "dairy";

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? v as Rec : {});
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const paise = (rupees: unknown) => Math.round(num(rupees) * 100);

export interface AnalyticsOrder {
  id: string;
  customerId: string;
  restaurantId: string;
  restaurantName: string;
  status: string;
  createdAt: number;
  deliveredAt: number;
  subtotalPaise: number;
  discountPaise: number;
  coupon: string;
  paymentMethod: string;
  area: string;
  lat: number | null;
  lng: number | null;
  cancelReason: string;
  cancelledBy: string;
  items: Array<{itemId: string; name: string; quantity: number; linePaise: number; diet: string}>;
}

export function analyticsOrderFrom(id: string, value: unknown): AnalyticsOrder {
  const o = rec(value), pricing = rec(o.pricing), address = rec(o.address);
  const items = Array.isArray(o.items) ? o.items.map((raw) => {
    const item = rec(raw), quantity = Math.max(1, Math.round(num(item.quantity) || 1));
    return {
      itemId: String(item.itemId ?? item.id ?? item.name ?? ""),
      name: String(item.name ?? "Item").slice(0, 120),
      quantity,
      linePaise: paise((num(item.price) + num(item.variantPrice) + num(item.addOnTotal)) * quantity),
      diet: String(item.diet ?? "").toLowerCase(),
    };
  }) : [];
  const lat = Number(address.lat), lng = Number(address.lng);
  return {
    id,
    customerId: String(o.customerId ?? ""),
    restaurantId: String(o.restaurantId ?? ""),
    restaurantName: String(o.restaurant ?? ""),
    status: String(o.status ?? ""),
    createdAt: num(o.createdAt),
    deliveredAt: num(o.deliveredAt),
    subtotalPaise: paise(pricing.subtotal),
    discountPaise: paise(pricing.discount),
    coupon: String(o.coupon ?? "").trim().toUpperCase(),
    paymentMethod: String(o.paymentMethod ?? ""),
    area: String(address.area ?? "").trim(),
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
    cancelReason: String(o.cancelReason ?? "").slice(0, 120),
    cancelledBy: String(o.cancelledByRole ?? ""),
    items,
  };
}

interface Tally {orders: number; customers: Set<string>; gmvPaise: number; delivered: number}
const tally = (): Tally => ({orders: 0, customers: new Set(), gmvPaise: 0, delivered: 0});
function add(t: Tally, o: AnalyticsOrder) {
  t.orders++;
  t.customers.add(o.customerId);
  if (o.status === "Delivered") {t.delivered++; t.gmvPaise += o.subtotalPaise;}
}
function slice(t: Tally, totalOrders: number) {
  return {orders: t.orders, sharePct: pct(t.orders, totalOrders), customers: t.customers.size, gmvPaise: t.gmvPaise,
    aovPaise: t.delivered ? Math.round(t.gmvPaise / t.delivered) : 0};
}
const genderKey = (s: CustomerSegment): GenderKey => s.gender || "unknown";
const ageKey = (s: CustomerSegment): AgeKey => s.ageBand || "unknown";
const GENDER_LABEL: Record<GenderKey, string> = {female: "Women", male: "Men", other: "Other", unknown: "Not shared"};

/** Monday = 0 ... Sunday = 6, and the hour, in India. */
function istSlot(at: number): {day: number; hour: number} {
  const d = new Date(at + IST_OFFSET_MS);
  return {day: (d.getUTCDay() + 6) % 7, hour: d.getUTCHours()};
}
const istDayKey = (at: number) => new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);

export interface AnalyticsInput {
  orders: AnalyticsOrder[];
  segments: Map<string, CustomerSegment>;
  kindOf: (restaurantId: string) => StoreKind;
  restaurantName: (restaurantId: string) => string;
  periodStart: number;
  now: number;
  days: number;
  kind: StoreKind | "all";
}

export function buildAnalytics(input: AnalyticsInput) {
  const segOf = (id: string): CustomerSegment => input.segments.get(id) ?? {gender: "", ageBand: ""};
  const inKind = (o: AnalyticsOrder) => input.kind === "all" || input.kindOf(o.restaurantId) === input.kind;
  const all = input.orders.filter(inKind);
  const period = all.filter((o) => o.createdAt >= input.periodStart && o.createdAt <= input.now);
  const placed = period.filter((o) => o.status !== "Cancelled");
  const delivered = period.filter((o) => o.status === "Delivered");
  const totalPlaced = placed.length;

  // ---- customers: new, returning, repeat, lapsed ----
  const firstSeen = new Map<string, number>(), lastSeen = new Map<string, number>();
  for (const o of all) {
    if (!o.customerId || o.status === "Cancelled") continue;
    firstSeen.set(o.customerId, Math.min(firstSeen.get(o.customerId) ?? Infinity, o.createdAt));
    lastSeen.set(o.customerId, Math.max(lastSeen.get(o.customerId) ?? 0, o.createdAt));
  }
  const periodCustomers = new Set(placed.map((o) => o.customerId).filter(Boolean));
  let newCustomers = 0;
  for (const id of periodCustomers) if ((firstSeen.get(id) ?? 0) >= input.periodStart) newCustomers++;
  const deliveredPerCustomer = new Map<string, number>();
  for (const o of delivered) deliveredPerCustomer.set(o.customerId, (deliveredPerCustomer.get(o.customerId) ?? 0) + 1);
  const repeatCustomers = [...deliveredPerCustomer.values()].filter((n) => n >= 2).length;
  const lapsedCutoff = input.now - LAPSED_AFTER_DAYS * DAY_MS;
  const lapsedBySegment = new Map<string, number>();
  let lapsedCustomers = 0;
  for (const [id, last] of lastSeen) {
    if (last >= lapsedCutoff) continue;
    lapsedCustomers++;
    const s = segOf(id), key = `${genderKey(s)}|${ageKey(s)}`;
    lapsedBySegment.set(key, (lapsedBySegment.get(key) ?? 0) + 1);
  }

  // ---- who: gender, age, and both ----
  const byGender = new Map<GenderKey, Tally>(), byAge = new Map<AgeKey, Tally>(), byCell = new Map<string, Tally>();
  for (const o of placed) {
    const s = segOf(o.customerId);
    const g = genderKey(s), a = ageKey(s);
    if (!byGender.has(g)) byGender.set(g, tally());
    if (!byAge.has(a)) byAge.set(a, tally());
    add(byGender.get(g)!, o); add(byAge.get(a)!, o);
    const cell = `${g}|${a}`;
    if (!byCell.has(cell)) byCell.set(cell, tally());
    add(byCell.get(cell)!, o);
  }
  const genders = (["female", "male", "other", "unknown"] as GenderKey[]).filter((g) => byGender.has(g))
    .map((g) => ({key: g, label: GENDER_LABEL[g], ...slice(byGender.get(g)!, totalPlaced)}));
  const ageBands = ([...AGE_BANDS, "unknown"] as AgeKey[]).filter((a) => byAge.has(a))
    .map((a) => ({key: a, label: a === "unknown" ? "Not shared" : a, ...slice(byAge.get(a)!, totalPlaced)}));
  const matrix = [...byCell.entries()].map(([cell, t]) => {
    const [gender, ageBand] = cell.split("|");
    return {gender, ageBand, orders: t.orders, customers: t.customers.size, sharePct: pct(t.orders, totalPlaced)};
  });
  let withGender = 0, withAge = 0;
  for (const id of periodCustomers) {
    const s = segOf(id);
    if (s.gender) withGender++;
    if (s.ageBand) withAge++;
  }

  // ---- what: dishes, restaurants, pairs ----
  interface ItemTally {itemId: string; name: string; restaurantId: string; quantity: number; orders: number;
    customers: Set<string>; revenuePaise: number; diet: string; genders: Record<GenderKey, number>;
    ages: Record<AgeKey, number>; areas: Map<string, number>}
  const items = new Map<string, ItemTally>();
  const qtyBySegment = new Map<string, Map<string, number>>(), segmentQty = new Map<string, number>();
  let totalQty = 0, itemLines = 0;
  const dietQty: Record<"veg" | "nonveg" | "egg" | "other", number> = {veg: 0, nonveg: 0, egg: 0, other: 0};
  const pairs = new Map<string, {a: string; b: string; restaurantId: string; orders: number}>();
  const segKeysFor = (s: CustomerSegment) => {
    const keys: string[] = [];
    if (s.gender) keys.push(`${s.gender}|`);
    if (s.ageBand) keys.push(`|${s.ageBand}`);
    if (s.gender && s.ageBand) keys.push(`${s.gender}|${s.ageBand}`);
    return keys;
  };
  for (const o of placed) {
    const s = segOf(o.customerId), keys = segKeysFor(s), area = areaKey(o.area);
    const names = new Set<string>();
    for (const line of o.items) {
      const key = `${o.restaurantId}::${line.itemId || line.name}`;
      if (!items.has(key)) {
        items.set(key, {itemId: line.itemId, name: line.name, restaurantId: o.restaurantId, quantity: 0, orders: 0,
          customers: new Set(), revenuePaise: 0, diet: line.diet,
          genders: {female: 0, male: 0, other: 0, unknown: 0},
          ages: {"18-24": 0, "25-34": 0, "35-44": 0, "45-54": 0, "55+": 0, "unknown": 0}, areas: new Map()});
      }
      const t = items.get(key)!;
      t.quantity += line.quantity; t.orders++; t.customers.add(o.customerId);
      if (o.status === "Delivered") t.revenuePaise += line.linePaise;
      t.genders[genderKey(s)] += line.quantity; t.ages[ageKey(s)] += line.quantity;
      if (area) t.areas.set(area, (t.areas.get(area) ?? 0) + line.quantity);
      totalQty += line.quantity; itemLines++;
      for (const k of keys) {
        if (!qtyBySegment.has(k)) qtyBySegment.set(k, new Map());
        const m = qtyBySegment.get(k)!;
        m.set(key, (m.get(key) ?? 0) + line.quantity);
        segmentQty.set(k, (segmentQty.get(k) ?? 0) + line.quantity);
      }
      const diet: keyof typeof dietQty = /non|chicken|mutton|fish|egg/.test(line.diet) ?
        (line.diet.includes("egg") ? "egg" : "nonveg") : line.diet.includes("veg") ? "veg" : "other";
      dietQty[diet] += line.quantity;
      names.add(line.name);
    }
    const list = [...names].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${o.restaurantId}::${list[i]}::${list[j]}`;
        if (!pairs.has(key)) pairs.set(key, {a: list[i]!, b: list[j]!, restaurantId: o.restaurantId, orders: 0});
        pairs.get(key)!.orders++;
      }
    }
  }
  const itemRows = [...items.entries()].sort((a, b) => b[1].quantity - a[1].quantity).slice(0, 40).map(([, t]) => {
    const topArea = [...t.areas.entries()].sort((a, b) => b[1] - a[1])[0];
    return {itemId: t.itemId, name: t.name, restaurantId: t.restaurantId, restaurantName: input.restaurantName(t.restaurantId),
      quantity: t.quantity, orders: t.orders, customers: t.customers.size, revenuePaise: t.revenuePaise, diet: t.diet,
      genders: t.genders, ageBands: t.ages, topAreaKey: topArea ? topArea[0] : ""};
  });

  const byRestaurant = new Map<string, Tally & {cancelled: number; deliveryMinutes: number[]; perCustomer: Map<string, number>}>();
  for (const o of period) {
    if (!byRestaurant.has(o.restaurantId)) {
      byRestaurant.set(o.restaurantId, {...tally(), cancelled: 0, deliveryMinutes: [], perCustomer: new Map()});
    }
    const t = byRestaurant.get(o.restaurantId)!;
    if (o.status === "Cancelled") {t.cancelled++; continue;}
    add(t, o);
    t.perCustomer.set(o.customerId, (t.perCustomer.get(o.customerId) ?? 0) + 1);
    if (o.status === "Delivered" && o.deliveredAt > o.createdAt) {
      const minutes = (o.deliveredAt - o.createdAt) / 60_000;
      if (minutes > 0 && minutes < 240) t.deliveryMinutes.push(minutes);
    }
  }
  const avg = (list: number[]) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
  const topItemOf = (restaurantId: string) => itemRows.find((i) => i.restaurantId === restaurantId)?.name ?? "";
  const restaurants = [...byRestaurant.entries()].map(([id, t]) => ({
    restaurantId: id, name: input.restaurantName(id), kind: input.kindOf(id),
    ...slice(t, totalPlaced), delivered: t.delivered, cancelled: t.cancelled,
    cancelRatePct: pct(t.cancelled, t.orders + t.cancelled),
    repeatCustomers: [...t.perCustomer.values()].filter((n) => n >= 2).length,
    avgDeliveryMinutes: avg(t.deliveryMinutes), topItem: topItemOf(id),
  })).sort((a, b) => b.orders - a.orders).slice(0, 30);

  // Group picks: for each group, the dishes it orders most - and how much more
  // than everyone else ("lift"), which is what makes an offer land.
  const groupDefs: Array<{gender: Gender | ""; ageBand: AgeBand | ""}> = [];
  for (const g of ["female", "male"] as Gender[]) groupDefs.push({gender: g, ageBand: ""});
  for (const a of AGE_BANDS) groupDefs.push({gender: "", ageBand: a});
  for (const g of ["female", "male"] as Gender[]) for (const a of AGE_BANDS) groupDefs.push({gender: g, ageBand: a});
  const groupPicks = groupDefs.map((group) => {
    const key = `${group.gender}|${group.ageBand}`;
    const quantities = qtyBySegment.get(key);
    const cellCustomers = new Set(placed.filter((o) => {
      const s = segOf(o.customerId);
      return (!group.gender || s.gender === group.gender) && (!group.ageBand || s.ageBand === group.ageBand);
    }).map((o) => o.customerId));
    const cellOrders = placed.filter((o) => {
      const s = segOf(o.customerId);
      return (!group.gender || s.gender === group.gender) && (!group.ageBand || s.ageBand === group.ageBand);
    });
    if (!quantities || cellCustomers.size < 1) return null;
    const groupTotal = segmentQty.get(key) ?? 0;
    const picks = [...quantities.entries()].map(([itemKey, quantity]) => {
      const t = items.get(itemKey)!;
      const lift = totalQty && groupTotal ? (quantity / groupTotal) / (t.quantity / totalQty) : 1;
      return {itemId: t.itemId, name: t.name, restaurantId: t.restaurantId, restaurantName: input.restaurantName(t.restaurantId),
        quantity, lift: Math.round(lift * 10) / 10};
    }).sort((a, b) => b.quantity - a.quantity || b.lift - a.lift).slice(0, 5);
    const rCounts = new Map<string, number>();
    for (const o of cellOrders) rCounts.set(o.restaurantId, (rCounts.get(o.restaurantId) ?? 0) + 1);
    return {
      gender: group.gender, ageBand: group.ageBand, label: segmentLabel(group).replace(/^Not shared /, "Age "),
      orders: cellOrders.length, customers: cellCustomers.size, sharePct: pct(cellOrders.length, totalPlaced),
      // Under 5 customers it's a hint, not a pattern; the apps say so.
      earlySignal: cellCustomers.size < 5,
      lapsedCustomers: [...lapsedBySegment.entries()].filter(([k]) => {
        const [g, a] = k.split("|");
        return (!group.gender || g === group.gender) && (!group.ageBand || a === group.ageBand);
      }).reduce((s, [, n]) => s + n, 0),
      items: picks,
      restaurants: [...rCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([id, orders]) => ({restaurantId: id, name: input.restaurantName(id), orders})),
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  // ---- where: areas and a heat grid ----
  const byArea = new Map<string, Tally & {names: Map<string, number>; lat: number; lng: number; points: number;
    cancelled: number; minutes: number[]; segs: Map<string, number>; itemQty: Map<string, number>}>();
  const heat = new Map<string, {lat: number; lng: number; orders: number}>();
  for (const o of period) {
    const key = areaKey(o.area) || "unknown";
    if (!byArea.has(key)) {
      byArea.set(key, {...tally(), names: new Map(), lat: 0, lng: 0, points: 0, cancelled: 0, minutes: [],
        segs: new Map(), itemQty: new Map()});
    }
    const a = byArea.get(key)!;
    a.names.set(o.area || "Area not given", (a.names.get(o.area || "Area not given") ?? 0) + 1);
    if (o.status === "Cancelled") {a.cancelled++; continue;}
    add(a, o);
    if (o.lat !== null && o.lng !== null) {
      a.lat += o.lat; a.lng += o.lng; a.points++;
      const cellLat = Math.round(o.lat / HEAT_CELL_DEG) * HEAT_CELL_DEG, cellLng = Math.round(o.lng / HEAT_CELL_DEG) * HEAT_CELL_DEG;
      const cell = `${cellLat.toFixed(3)},${cellLng.toFixed(3)}`;
      if (!heat.has(cell)) heat.set(cell, {lat: Number(cellLat.toFixed(4)), lng: Number(cellLng.toFixed(4)), orders: 0});
      heat.get(cell)!.orders++;
    }
    if (o.status === "Delivered" && o.deliveredAt > o.createdAt) {
      const minutes = (o.deliveredAt - o.createdAt) / 60_000;
      if (minutes > 0 && minutes < 240) a.minutes.push(minutes);
    }
    const s = segOf(o.customerId);
    if (s.gender || s.ageBand) {
      const label = segmentLabel(s);
      a.segs.set(label, (a.segs.get(label) ?? 0) + 1);
    }
    for (const line of o.items) a.itemQty.set(line.name, (a.itemQty.get(line.name) ?? 0) + line.quantity);
  }
  const areas = [...byArea.entries()].map(([key, a]) => ({
    key, name: [...a.names.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? key,
    ...slice(a, totalPlaced), cancelRatePct: pct(a.cancelled, a.orders + a.cancelled),
    avgDeliveryMinutes: avg(a.minutes),
    lat: a.points ? Math.round((a.lat / a.points) * 1e5) / 1e5 : null,
    lng: a.points ? Math.round((a.lng / a.points) * 1e5) / 1e5 : null,
    topItem: [...a.itemQty.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "",
    topGroup: [...a.segs.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "",
  })).sort((a, b) => b.orders - a.orders).slice(0, 40);

  // ---- when ----
  const grid = Array.from({length: 7}, () => Array.from({length: 24}, () => 0));
  for (const o of placed) {const s = istSlot(o.createdAt); grid[s.day]![s.hour]!++;}
  let peak = {day: 0, hour: 0, orders: 0};
  grid.forEach((row, day) => row.forEach((orders, hour) => {if (orders > peak.orders) peak = {day, hour, orders};}));
  const daily = new Map<string, {orders: number; gmvPaise: number}>();
  for (let t = input.periodStart; t <= input.now; t += DAY_MS) daily.set(istDayKey(t), {orders: 0, gmvPaise: 0});
  for (const o of placed) {
    const d = daily.get(istDayKey(o.createdAt));
    if (d) {d.orders++; if (o.status === "Delivered") d.gmvPaise += o.subtotalPaise;}
  }

  // ---- money: payments, offers, cancellations ----
  const payments = new Map<string, number>();
  for (const o of placed) payments.set(o.paymentMethod || "unknown", (payments.get(o.paymentMethod || "unknown") ?? 0) + 1);
  const offers = new Map<string, {orders: number; discountPaise: number; gmvPaise: number; newCustomers: Set<string>}>();
  for (const o of placed) {
    if (!o.coupon) continue;
    if (!offers.has(o.coupon)) offers.set(o.coupon, {orders: 0, discountPaise: 0, gmvPaise: 0, newCustomers: new Set()});
    const t = offers.get(o.coupon)!;
    t.orders++; t.discountPaise += o.discountPaise;
    if (o.status === "Delivered") t.gmvPaise += o.subtotalPaise;
    if ((firstSeen.get(o.customerId) ?? -1) === o.createdAt) t.newCustomers.add(o.customerId);
  }
  const cancellations = new Map<string, number>();
  for (const o of period) {
    if (o.status !== "Cancelled") continue;
    const key = `${o.cancelledBy || "unknown"}|${o.cancelReason || "No reason given"}`;
    cancellations.set(key, (cancellations.get(key) ?? 0) + 1);
  }

  const deliveryMinutes = delivered.filter((o) => o.deliveredAt > o.createdAt)
    .map((o) => (o.deliveredAt - o.createdAt) / 60_000).filter((m) => m > 0 && m < 240);
  const gmvPaise = delivered.reduce((s, o) => s + o.subtotalPaise, 0);
  return {
    generatedAt: input.now, days: input.days, periodStart: input.periodStart, kind: input.kind,
    summary: {
      orders: period.length, placed: totalPlaced, delivered: delivered.length,
      cancelled: period.length - totalPlaced, cancelRatePct: pct(period.length - totalPlaced, period.length),
      gmvPaise, aovPaise: delivered.length ? Math.round(gmvPaise / delivered.length) : 0,
      customers: periodCustomers.size, newCustomers, returningCustomers: periodCustomers.size - newCustomers,
      repeatCustomers, repeatRatePct: pct(repeatCustomers, deliveredPerCustomer.size),
      avgItemsPerOrder: totalPlaced ? Math.round((totalQty / totalPlaced) * 10) / 10 : 0,
      avgDeliveryMinutes: avg(deliveryMinutes),
      discountPaise: placed.reduce((s, o) => s + o.discountPaise, 0),
      offerOrders: placed.filter((o) => o.coupon).length,
      lapsedCustomers, lapsedAfterDays: LAPSED_AFTER_DAYS,
    },
    coverage: {customers: periodCustomers.size, withGender, withAge,
      genderPct: pct(withGender, periodCustomers.size), agePct: pct(withAge, periodCustomers.size)},
    genders, ageBands, matrix,
    items: itemRows,
    restaurants,
    groupPicks,
    pairs: [...pairs.values()].filter((p) => p.orders >= 2).sort((a, b) => b.orders - a.orders).slice(0, 12)
      .map((p) => ({...p, restaurantName: input.restaurantName(p.restaurantId)})),
    areas,
    heat: [...heat.values()].sort((a, b) => b.orders - a.orders).slice(0, 400),
    timing: {grid, peak},
    daily: [...daily.entries()].map(([day, d]) => ({day, ...d})),
    payments: [...payments.entries()].map(([key, orders]) => ({key, orders, sharePct: pct(orders, totalPlaced)}))
      .sort((a, b) => b.orders - a.orders),
    diet: {...dietQty, totalQuantity: totalQty, lines: itemLines},
    offers: [...offers.entries()].map(([code, t]) => ({code, orders: t.orders, discountPaise: t.discountPaise,
      gmvPaise: t.gmvPaise, newCustomers: t.newCustomers.size})).sort((a, b) => b.orders - a.orders).slice(0, 20),
    cancellations: [...cancellations.entries()].map(([key, orders]) => {
      const [by, reason] = key.split("|");
      return {by, reason, orders};
    }).sort((a, b) => b.orders - a.orders).slice(0, 15),
  };
}

export type AdminAnalytics = ReturnType<typeof buildAnalytics>;

const cache = new Map<string, {at: number; value: AdminAnalytics}>();

export async function readAdminAnalytics(
  token: DecodedIdToken,
  input: {days: number; kind: StoreKind | "all"; fresh?: boolean},
  database: FirestoreLike = firestoreDb,
  now = Date.now(),
): Promise<AdminAnalytics> {
  requirePlatformConfigAdminClaim(token);
  const days = [7, 30, 90].includes(input.days) ? input.days : 30;
  const key = `${days}:${input.kind}`;
  const hit = cache.get(key);
  if (!input.fresh && hit && now - hit.at < CACHE_MS) return hit.value;

  const periodStart = now - days * DAY_MS;
  const lookbackStart = periodStart - LOOKBACK_DAYS * DAY_MS;
  const [ordersSnap, restaurantsSnap] = await Promise.all([
    database.collection("orders").where("createdAt", ">=", lookbackStart).orderBy("createdAt", "desc").limit(MAX_ORDERS).get(),
    database.collection("restaurants").get(),
  ]);
  const orders = ordersSnap.docs.map((doc) => analyticsOrderFrom(doc.id, doc.data()));
  const kinds = new Map<string, StoreKind>(), names = new Map<string, string>();
  for (const doc of restaurantsSnap.docs) {
    const r = doc.data() as Rec, type = String(r.storeType ?? "restaurant");
    kinds.set(doc.id, type === "grocery" || type === "dairy" ? type : "restaurant");
    names.set(doc.id, String(r.name ?? doc.id));
  }
  // Only customers who ordered in the period need their (consented) details.
  const ids = [...new Set(orders.filter((o) => o.createdAt >= lookbackStart).map((o) => o.customerId).filter(Boolean))];
  const segments = new Map<string, CustomerSegment>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const snaps = await Promise.all(chunk.map((id) => database.collection(CUSTOMER_DEMOGRAPHICS_COLLECTION).doc(id).get()));
    snaps.forEach((snap, index) => {
      if (snap.exists) segments.set(chunk[index]!, segmentFrom(snap.data(), now));
    });
  }
  const value = buildAnalytics({
    orders, segments, periodStart, now, days, kind: input.kind,
    kindOf: (id) => kinds.get(id) ?? "restaurant",
    restaurantName: (id) => names.get(id) ?? orders.find((o) => o.restaurantId === id)?.restaurantName ?? "Store",
  });
  cache.set(key, {at: now, value});
  return value;
}

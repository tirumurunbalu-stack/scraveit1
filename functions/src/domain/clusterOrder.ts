import {gridDisk, latLngToCell} from "h3-js";
import {isValidDispatchCoordinate} from "./dispatch";
import {haversineKm} from "./order";
import type {OrderCluster, OrderClusterStop} from "../types";

export type {OrderCluster, OrderClusterStop};

/**
 * Cluster orders: one order from several restaurants in the same area, picked up by one rider.
 * A family wants biryani from one place, veg meals from another, coffee from a cafe and ice cream
 * from a parlour: they check out once, and one rider collects everything and brings it together.
 *
 * Each restaurant's part is an ordinary order of its own (the restaurant accepts, cooks and is
 * paid exactly as today), linked to the others by order.cluster. The rider collects them in an
 * order that keeps the food at its best: what keeps well first, what melts last.
 */

/** Hexagon resolution for cluster areas: cells about 0.5 km along an edge (0.7 km²). */
export const CLUSTER_HEX_RESOLUTION = 8;

/** Restaurants count as one area when within this many rings of the first one: about 2 km apart at most. */
export const CLUSTER_HEX_RINGS = 1;

export const CLUSTER_MAX_RESTAURANTS_LIMIT = 5;

export interface ClusterSettings {
  enabled: boolean;
  /** What each extra restaurant adds to the bill, in rupees (instead of a second delivery fee). */
  stopFee: number;
  maxRestaurants: number;
}

export function clusterSettings(value: unknown): ClusterSettings {
  const settings = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const stopFee = Number(settings.clusterStopFee);
  const max = Math.round(Number(settings.clusterMaxRestaurants));
  return {
    enabled: settings.clusterOrdersEnabled !== false,
    stopFee: Number.isFinite(stopFee) ? Math.min(200, Math.max(0, stopFee)) : 20,
    maxRestaurants: Number.isFinite(max) ? Math.min(CLUSTER_MAX_RESTAURANTS_LIMIT, Math.max(2, max)) : 4,
  };
}

/** A restaurant's cluster hexagon and the hexagons around it, stored on the listing for the app. */
export function clusterCellsFor(lat: unknown, lng: unknown): {clusterCell: string; clusterCells: string[]} | null {
  if (!isValidDispatchCoordinate(lat, lng)) return null;
  try {
    const clusterCell = latLngToCell(Number(lat), Number(lng), CLUSTER_HEX_RESOLUTION);
    return {clusterCell, clusterCells: gridDisk(clusterCell, CLUSTER_HEX_RINGS).sort()};
  } catch {
    return null;
  }
}

/**
 * Whether these restaurants form one area: each must be in the first restaurant's hexagon or one
 * of the 6 around it. The first is the one the customer started their cart with.
 */
export function inOneClusterArea(restaurants: Array<{lat: unknown; lng: unknown}>): boolean {
  const first = restaurants[0] ? clusterCellsFor(restaurants[0].lat, restaurants[0].lng) : null;
  if (!first) return false;
  return restaurants.every((restaurant) => {
    const cells = clusterCellsFor(restaurant.lat, restaurant.lng);
    return !!cells && first.clusterCells.includes(cells.clusterCell);
  });
}

/**
 * How carefully the food has to travel, from the dish names: 0 keeps hot well (biryani, meals,
 * curries, tiffin), 1 is best eaten fresh (fries, burgers, pizza, dosa go soggy), 2 is a hot or
 * cold drink, 3 melts (ice cream, kulfi). Higher is picked up later.
 */
export type CareLevel = 0 | 1 | 2 | 3;

export const CARE_LABELS: Record<CareLevel, string> = {
  0: "Keeps well",
  1: "Best fresh",
  2: "Drinks",
  3: "Melts fast",
};

const CARE_WORDS: Array<[CareLevel, RegExp]> = [
  [3, /\b(ice ?-?creams?|kulfi|gelato|sundaes?|softy|sorbet|popsicles?|frozen|falooda|cassata|cone)\b/],
  [2, /\b(coffee|tea|chai|latte|cappuccino|espresso|mocha|frappe|americano|shakes?|milkshakes?|juices?|smoothies?|lassi|mojito|soda|cola|lemonade|buttermilk|chaas|cold ?drinks?|badam milk|horlicks|boost)\b/],
  [1, /\b(fries|burgers?|pizzas?|sandwich(es)?|momos?|dosas?|vadas?|bajjis?|pakoras?|pakodas?|samosas?|rolls?|wraps?|noodles|manchurian|pani ?puri|chaat|nuggets|crispy|fried chicken|popcorn|puffs?|cutlets?)\b/],
];

export function itemCare(name: string): CareLevel {
  const text = String(name ?? "").toLowerCase();
  for (const [level, words] of CARE_WORDS) if (words.test(text)) return level;
  return 0;
}

/** A restaurant's part is as delicate as its most delicate dish. */
export function partCare(items: Array<{name: string}>): CareLevel {
  return items.reduce<CareLevel>((level, item) => Math.max(level, itemCare(item.name)) as CareLevel, 0);
}

export interface ClusterPart {
  restaurantId: string;
  lat: number;
  lng: number;
  care: CareLevel;
  /** The kitchen's usual time to cook, in minutes. */
  kitchenMinutes: number;
}

/**
 * The order the rider collects in. What keeps well goes first and what melts goes last, so the
 * ice cream spends the least time in the bag. Within the same care, the slowest kitchen first
 * (what packs fast is collected last); then the nearest, so the route stays short.
 */
export function pickupOrder<T extends ClusterPart>(parts: T[]): T[] {
  const start = parts[0];
  return parts.slice().sort((a, b) =>
    a.care - b.care ||
    b.kitchenMinutes - a.kitchenMinutes ||
    (start ? haversineKm(start, a) - haversineKm(start, b) : 0) ||
    a.restaurantId.localeCompare(b.restaurantId));
}

/** Distance from the previous pickup, in metres, for a stop's rider pay. */
export function stopPickupMeters(previous: {lat: number; lng: number}, stop: {lat: number; lng: number}): number {
  const km = haversineKm(previous, stop);
  return Number.isFinite(km) ? Math.round(km * 1_000) : 0;
}

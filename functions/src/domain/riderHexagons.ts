import {cellToBoundary, cellToLatLng, gridDisk, latLngToCell} from "h3-js";
import {isValidDispatchCoordinate} from "./dispatch";
import {haversineKm} from "./order";
import type {GeoPoint} from "../types";

/**
 * Riders are filed by the hexagon they are in (Uber's H3 grid), so finding riders for an order
 * reads the hexagons around the restaurant, nearest ring first, instead of every rider in the
 * city and the distance to each.
 *
 * Hexagons rather than squares: a square's corner neighbours are 1.4 times farther away than its
 * side neighbours, but all six neighbours of a hexagon are the same distance away, so each ring
 * grows evenly in every direction and "the next ring" really is "a bit farther out".
 *
 * Resolution 7: hexagons about 1.4 km along an edge and 5 km² in area. A rider's hexagon is
 * worked out from their latest location every time it is written (riderAvailability.hexCell).
 */
export const RIDER_HEX_RESOLUTION = 7;

/**
 * The rings read in turn. 1 ring is the restaurant's hexagon and its 6 neighbours (7 hexagons,
 * everyone within about 2 km); 8 rings is 217 hexagons, everyone within about 15 km.
 */
export const RIDER_HEX_RINGS: readonly number[] = [1, 2, 4, 6, 8];

/** Firestore takes up to 30 values in one "in" query. */
export const HEXAGONS_PER_QUERY = 30;

/** The hexagon a location is in, or null when the location isn't a usable one. */
export function riderHexagon(lat: unknown, lng: unknown): string | null {
  if (!isValidDispatchCoordinate(lat, lng)) return null;
  try {
    return latLngToCell(Number(lat), Number(lng), RIDER_HEX_RESOLUTION);
  } catch {
    return null;
  }
}

/** The hexagons within `rings` rings of `origin`, including it. */
export function hexagonsWithin(origin: string, rings: number): string[] {
  return gridDisk(origin, rings);
}

/**
 * How far from `point` (inside `origin`) every rider is certain to have been found once the
 * hexagons within `rings` rings have been read. Anywhere outside them is reached only by passing
 * through a hexagon of the next ring, so it is at least as far as the nearest point of that ring:
 * no closer than the hexagon's centre minus the distance from its centre to its farthest corner.
 * 50 m is taken off for the difference between the grid's edges and the curve of the Earth.
 */
export function coveredRadiusKm(point: GeoPoint, origin: string, rings: number): number {
  const inside = new Set(gridDisk(origin, rings));
  let nearest = Infinity;
  for (const cell of gridDisk(origin, rings + 1)) {
    if (inside.has(cell)) continue;
    const [lat, lng] = cellToLatLng(cell);
    const centre = {lat, lng};
    const cornerKm = Math.max(...cellToBoundary(cell).map(([cornerLat, cornerLng]) =>
      haversineKm(centre, {lat: cornerLat, lng: cornerLng})));
    nearest = Math.min(nearest, haversineKm(point, centre) - cornerKm);
  }
  return Math.max(0, nearest - 0.05);
}

export function inQueryBatches(cells: string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < cells.length; i += HEXAGONS_PER_QUERY) batches.push(cells.slice(i, i + HEXAGONS_PER_QUERY));
  return batches;
}

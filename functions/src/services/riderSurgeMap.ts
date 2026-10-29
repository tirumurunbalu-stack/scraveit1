import type {DecodedIdToken} from "firebase-admin/auth";
import {firestoreDb} from "../admin";
import {availabilityCityKey} from "../domain/dispatch";
import {DEFAULT_DISPATCH_POLICY} from "../domain/dispatchPolicy";
import {hexagonCorners, hexagonsWithin, riderHexagon} from "../domain/riderHexagons";
import {
  SURGE_RINGS,
  riderSupply,
  riderSurgeFee,
  riderSurgeLevel,
  riderSurgeMinOnline,
  type RiderSupply,
  type RiderSurgeSettings,
} from "../domain/riderSurge";
import type {FirestoreLike} from "../firestoreTypes";
import {riderAvailabilityCollectionRef} from "../firestorePaths";
import {requirePlatformConfigAdminClaim} from "./authz";

/**
 * Rider surge by hexagon (part two of finding riders by hexagon, domain/riderHexagons.ts): the
 * surge a restaurant charges comes from the riders in the hexagons around it, not from the whole
 * city, so a busy neighbourhood surges while the rest of the city stays at the normal price.
 */

type RiderRecord = {online?: unknown; activeOrderId?: unknown; updatedAt?: unknown; lat?: unknown; lng?: unknown};

const FRESH_MS = DEFAULT_DISPATCH_POLICY.presenceFreshMs;

/**
 * The rider surge fee for an order from this restaurant: from the riders within SURGE_RINGS rings
 * of hexagons (about 3 km). When they are too few to price on (a quiet area, or riders not yet
 * filed in hexagons) the city's riders decide, as before. A failed read never blocks checkout: no fee.
 */
export async function riderSurgeFeeNear(
  settings: RiderSurgeSettings,
  restaurant: {lat?: unknown; lng?: unknown; city?: unknown},
  database: FirestoreLike = firestoreDb,
  now = Date.now(),
): Promise<number> {
  if (settings.riderSurgeEnabled !== true) return 0;
  try {
    const origin = riderHexagon(restaurant.lat, restaurant.lng);
    if (origin) {
      const snapshot = await riderAvailabilityCollectionRef(database)
        .where("hexCell", "in", hexagonsWithin(origin, SURGE_RINGS)).limit(500).get();
      const supply = riderSupply(snapshot.docs.map((doc) => doc.data() as RiderRecord), now, FRESH_MS);
      if (supply.onlineRiders >= riderSurgeMinOnline(settings)) return riderSurgeFee(settings, supply);
    }
    const snapshot = await riderAvailabilityCollectionRef(database)
      .where("cityKey", "==", availabilityCityKey(restaurant.city)).limit(500).get();
    return riderSurgeFee(settings, riderSupply(snapshot.docs.map((doc) => doc.data() as RiderRecord), now, FRESH_MS));
  } catch {
    return 0;
  }
}

export interface SurgeHexagon {
  cell: string;
  corners: Array<[number, number]>;
  /** Riders in this hexagon itself. */
  here: number;
  /** Riders online and busy within SURGE_RINGS rings: what a restaurant in this hexagon prices on. */
  online: number;
  busy: number;
  /** riderSurgeLevel: -1 too few riders to tell, 0 calm, 1 to 3 the surge tiers. */
  level: number;
  /** The rider surge fee a restaurant in this hexagon charges now (0 when surge is off). */
  fee: number;
}

export interface RiderSurgeMap {
  enabled: boolean;
  minOnline: number;
  rings: number;
  riders: number;
  hexagons: SurgeHexagon[];
  truncated: boolean;
  at: number;
}

const MAX_HEXAGONS = 600;

/**
 * For Admin's Live riders map: every hexagon with riders in or next to it, coloured by how many
 * riders around it are busy, with the surge a restaurant there would charge right now.
 */
export async function readRiderSurgeMap(
  token: DecodedIdToken,
  database: FirestoreLike = firestoreDb,
  now = Date.now(),
): Promise<RiderSurgeMap> {
  requirePlatformConfigAdminClaim(token);
  const [settingsSnapshot, ridersSnapshot] = await Promise.all([
    database.collection("settings").doc("customer").get(),
    riderAvailabilityCollectionRef(database).where("online", "==", true).limit(2000).get(),
  ]);
  const settings = (settingsSnapshot.exists ? settingsSnapshot.data() : {}) as RiderSurgeSettings;
  // Riders by hexagon, worked out from their location so riders not yet filed still count.
  const byCell = new Map<string, RiderRecord[]>();
  let riders = 0;
  for (const doc of ridersSnapshot.docs) {
    const rider = doc.data() as RiderRecord;
    const cell = riderHexagon(rider.lat, rider.lng);
    if (!cell || riderSupply([rider], now, FRESH_MS).onlineRiders === 0) continue;
    riders++;
    byCell.set(cell, [...(byCell.get(cell) ?? []), rider]);
  }
  const shown = new Set<string>();
  for (const cell of byCell.keys()) for (const near of hexagonsWithin(cell, 1)) shown.add(near);
  const cells = [...shown];
  const hexagons = cells.slice(0, MAX_HEXAGONS).map((cell): SurgeHexagon => {
    const around = hexagonsWithin(cell, SURGE_RINGS).flatMap((near) => byCell.get(near) ?? []);
    const supply: RiderSupply = riderSupply(around, now, FRESH_MS);
    return {
      cell,
      corners: hexagonCorners(cell),
      here: byCell.get(cell)?.length ?? 0,
      online: supply.onlineRiders,
      busy: supply.busyRiders,
      level: riderSurgeLevel(settings, supply),
      fee: riderSurgeFee(settings, supply),
    };
  });
  return {
    enabled: settings.riderSurgeEnabled === true,
    minOnline: riderSurgeMinOnline(settings),
    rings: SURGE_RINGS,
    riders,
    hexagons,
    truncated: cells.length > MAX_HEXAGONS,
    at: now,
  };
}

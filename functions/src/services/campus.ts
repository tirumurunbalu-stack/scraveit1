import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  campusZoneFromPlace, campusZoneWithGates, learnCampusGate, normalizeCampusGates, normalizeCampusZone, placesContainingPin,
  type CampusZone,
} from "../domain/campus";
import {campusPinRef, campusPlaceRef, deliveryCampusRef} from "../firestorePaths";
import {db} from "../admin";
import {ROOT} from "../config";
import type {SavrivoOrder} from "../types";
import {mapsAllowed, recordMapsUsage} from "./mapsGuard";

/**
 * Asks Google once per delivery pin whether it is inside a college, school or
 * hospital (see domain/campus.ts), and stores the answer for the order so the
 * arrival check can use it. Any failure simply leaves the order on the normal
 * rules.
 */

const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const PLACE_ENDPOINT = "https://places.googleapis.com/v1/places/";
const PIN_CACHE_MS = 60 * 24 * 60 * 60 * 1000;
const ORDER_RECORD_MS = 3 * 24 * 60 * 60 * 1000;
/** Pin answers saved before per-place sizing (v2) are asked again. */
const PIN_CACHE_VERSION = 2;
// Runs inside the order trigger: worst case 4 calls x 3 s stays well inside its 60 s limit.
const GOOGLE_TIMEOUT_MS = 3_000;

export function campusPinKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)}_${lng.toFixed(4)}`;
}

type Fetch = typeof fetch;

/** Google's answer for one pin: the campus it is inside, or null. Throws when Google could not answer. */
export async function lookupCampusAt(lat: number, lng: number, apiKey: string, fetchImpl: Fetch = fetch):
  Promise<{campus: CampusZone | null; calls: number}> {
  let calls = 1;
  const geocode = await fetchImpl(`${GEOCODE_ENDPOINT}?latlng=${lat},${lng}&extra_computations=ADDRESS_DESCRIPTORS` +
    `&key=${encodeURIComponent(apiKey)}`, {signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS)});
  const body = await geocode.json().catch(() => null) as {status?: string; address_descriptor?: unknown} | null;
  if (!geocode.ok || !body || !["OK", "ZERO_RESULTS"].includes(String(body.status))) {
    throw new Error(`geocode ${geocode.status} ${String(body?.status ?? "")}`);
  }
  for (const place of placesContainingPin(body.address_descriptor)) {
    calls++;
    const details = await fetchImpl(`${PLACE_ENDPOINT}${encodeURIComponent(place.placeId)}`, {
      headers: {"X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "types,viewport,location"},
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!details.ok) throw new Error(`place ${details.status}`);
    const campus = campusZoneFromPlace(place, await details.json().catch(() => null));
    if (campus) return {campus, calls};
  }
  return {campus: null, calls};
}

/** Checks the order's pin (cached per pin) and saves the result for the arrival check. */
export async function recordDeliveryCampus(order: SavrivoOrder, apiKey: string, now = Date.now()): Promise<CampusZone | null> {
  const lat = Number(order.address?.lat), lng = Number(order.address?.lng);
  if (!apiKey || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  const pinRef = campusPinRef(firestoreDb, campusPinKey(lat, lng));
  let campus: CampusZone | null;
  const cached = await pinRef.get();
  const stored = cached.exists ? cached.data() as {campus?: unknown; expiresAt?: number; v?: number} : null;
  if (stored && Number(stored.expiresAt) > now && stored.v === PIN_CACHE_VERSION) {
    campus = normalizeCampusZone(stored.campus);
  } else {
    // One reverse geocode plus at most 3 place lookups.
    if (!await mapsAllowed("places", 4, now)) return null;
    let result: {campus: CampusZone | null; calls: number};
    try {
      result = await lookupCampusAt(lat, lng, apiKey);
    } catch (error) {
      await recordMapsUsage("places", 1, now);
      logger.warn("CAMPUS_LOOKUP_FAILED", {orderId: order.id, error: String(error)});
      return null;
    }
    await recordMapsUsage("places", result.calls, now);
    campus = result.campus;
    await pinRef.set({campus, checkedAt: now, expiresAt: now + PIN_CACHE_MS, v: PIN_CACHE_VERSION});
  }
  if (campus?.placeId) {
    // Grow the box to the gates this campus's orders were really handed over at.
    const place = await campusPlaceRef(firestoreDb, campus.placeId).get().catch(() => null);
    const gates = normalizeCampusGates(place?.exists ? (place.data() as {gates?: unknown})?.gates : null);
    if (gates.length) campus = campusZoneWithGates(campus, gates);
  }
  await deliveryCampusRef(firestoreDb, order.id).set({orderId: order.id, campus, checkedAt: now, expiresAt: now + ORDER_RECORD_MS});
  if (campus) logger.info("DELIVERY_TO_CAMPUS", {orderId: order.id, campus: campus.name});
  return campus;
}

/** The campus saved for this order, or null (normal order, or not checked). */
export async function deliveryCampusFor(orderId: string): Promise<CampusZone | null> {
  const snapshot = await deliveryCampusRef(firestoreDb, orderId).get();
  return snapshot.exists ? normalizeCampusZone((snapshot.data() as {campus?: unknown}).campus) : null;
}

/**
 * At delivery: if a campus order was handed over outside the campus box (a
 * gate Google doesn't know about), remember that spot for this campus so the
 * next order's gate wait and gate swipe work there. Reads the partner's last
 * live reading, so it must run before the tracking data is cleared.
 */
export async function recordCampusHandover(order: SavrivoOrder, now = Date.now()): Promise<void> {
  const campus = await deliveryCampusFor(order.id);
  if (!campus?.placeId) return;
  const fixSnapshot = await db.ref(`${ROOT}/tracking/${order.id}`).get();
  const fix = fixSnapshot.exists() ? fixSnapshot.val() as {lat?: unknown; lng?: unknown; accuracy?: unknown; updatedAt?: unknown} : null;
  const lat = Number(fix?.lat), lng = Number(fix?.lng), accuracy = Number(fix?.accuracy), updatedAt = Number(fix?.updatedAt);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy) || !(updatedAt > now - 3 * 60_000)) return;
  // Same document as campusPlaceRef, typed for the transaction.
  const ref = firestoreDb.collection("private").doc("deliveryCampus").collection("places").doc(campus.placeId);
  await firestoreDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const gates = normalizeCampusGates(snapshot.exists ? (snapshot.data() as {gates?: unknown})?.gates : null);
    const next = learnCampusGate(campus, gates, {lat, lng, accuracy}, now);
    if (!next) return;
    tx.set(ref, {placeId: campus.placeId, name: campus.name, gates: next, updatedAt: now}, {merge: true});
    logger.info("CAMPUS_GATE_LEARNED", {orderId: order.id, campus: campus.name, gates: next.length});
  });
}

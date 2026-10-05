import {logger} from "firebase-functions";
import {db, firestoreDb} from "../admin";
import {ROOT} from "../config";
import {orderRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";
import {decodePolyline, distanceToRouteMeters, type LatLng, mapsAllowed, recordMapsUsage} from "./mapsGuard";

/**
 * Google Maps Platform for the live map, without ever giving the apps the key:
 * - map tiles (Map Tiles API, 2D roadmap) are fetched here and served through
 *   Firebase Hosting's CDN, so each tile is paid for once per area, not per view;
 * - two-wheeler routes (Routes API, traffic-aware) for the rider's road line
 *   and a traffic-based arrival time.
 * Uses the same Google key as the weather check (Map Tiles API and Routes API
 * must be enabled for it in Google Cloud).
 */

const TILE_SESSION_ENDPOINT = "https://tile.googleapis.com/v1/createSession";
const TILE_ENDPOINT = "https://tile.googleapis.com/v1/2dtiles";
const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

export type MapStyle = "day" | "night";

/** A calm dark map for night, same roads and labels. */
const NIGHT_STYLES = [
  {featureType: "all", elementType: "geometry", stylers: [{color: "#16213a"}]},
  {featureType: "all", elementType: "labels.text.fill", stylers: [{color: "#9fb0cf"}]},
  {featureType: "all", elementType: "labels.text.stroke", stylers: [{color: "#0f1726"}]},
  {featureType: "road", elementType: "geometry", stylers: [{color: "#2a3552"}]},
  {featureType: "road.arterial", elementType: "geometry", stylers: [{color: "#334166"}]},
  {featureType: "road.highway", elementType: "geometry", stylers: [{color: "#4a4430"}]},
  {featureType: "water", elementType: "geometry", stylers: [{color: "#13294a"}]},
  {featureType: "poi.park", elementType: "geometry", stylers: [{color: "#173229"}]},
  {featureType: "poi", elementType: "labels.icon", stylers: [{visibility: "off"}]},
  {featureType: "transit", stylers: [{visibility: "simplified"}]},
];

const sessions = new Map<MapStyle, {session: string; expiresAt: number}>();

async function tileSession(style: MapStyle, apiKey: string): Promise<string> {
  const cached = sessions.get(style);
  if (cached && cached.expiresAt - Date.now() > 60 * 60 * 1000) return cached.session;
  const response = await fetch(`${TILE_SESSION_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      mapType: "roadmap", language: "en-IN", region: "IN", scale: "scaleFactor2x", highDpi: true,
      ...(style === "night" ? {styles: NIGHT_STYLES} : {}),
    }),
  });
  if (!response.ok) {
    logger.warn("MAP_TILE_SESSION_FAILED", {status: response.status, body: (await response.text()).slice(0, 300)});
    throw new Error(`MAP_TILE_SESSION_${response.status}`);
  }
  const body = await response.json() as {session?: string; expiry?: string};
  if (!body.session) throw new Error("MAP_TILE_SESSION_EMPTY");
  const expiresAt = Number(body.expiry) * 1000 || Date.now() + 24 * 60 * 60 * 1000;
  sessions.set(style, {session: body.session, expiresAt});
  return body.session;
}

/** Only real map tiles over India, at the zooms the apps use. */
export function parseTilePath(path: string): {style: MapStyle; z: number; x: number; y: number} | null {
  const match = /\/maptile\/(day|night)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:\.png)?$/.exec(path);
  if (!match) return null;
  const z = Number(match[2]); const x = Number(match[3]); const y = Number(match[4]);
  if (z < 4 || z > 19) return null;
  const n = 2 ** z;
  if (x >= n || y >= n) return null;
  // India with a margin: longitude 66..99 E, latitude 5..38 N.
  const lngWest = x / n * 360 - 180; const lngEast = (x + 1) / n * 360 - 180;
  const latAt = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
  const latNorth = latAt(y); const latSouth = latAt(y + 1);
  if (lngEast < 66 || lngWest > 99 || latNorth < 5 || latSouth > 38) return null;
  return {style: match[1] as MapStyle, z, x, y};
}

// Per-device speed limit (per server instance): a person panning around the map
// stays far below this; a bot copying the map does not.
const TILE_BURST_PER_MINUTE = 300;
const tileClients = new Map<string, {minute: number; count: number}>();
export function tileClientAllowed(client: string, now = Date.now()): boolean {
  const minute = Math.floor(now / 60_000);
  const entry = tileClients.get(client);
  if (!entry || entry.minute !== minute) {
    if (tileClients.size > 5_000) tileClients.clear();
    tileClients.set(client, {minute, count: 1});
    return true;
  }
  entry.count += 1;
  return entry.count <= TILE_BURST_PER_MINUTE;
}

export async function fetchMapTile(path: string, apiKey: string, client = ""):
  Promise<{status: number; body: Buffer; contentType: string; cacheControl: string}> {
  const tile = parseTilePath(path);
  const refuse = (status: number) => ({status, body: Buffer.from(""), contentType: "text/plain", cacheControl: "no-store"});
  if (!tile) return refuse(404);
  if (client && !tileClientAllowed(client)) return refuse(429);
  // Switched off or past today's cap: the apps fall back to the free map by themselves.
  if (!await mapsAllowed("tiles")) return refuse(503);
  let session = await tileSession(tile.style, apiKey);
  const url = (s: string) => `${TILE_ENDPOINT}/${tile.z}/${tile.x}/${tile.y}?session=${encodeURIComponent(s)}&key=${encodeURIComponent(apiKey)}`;
  let response = await fetch(url(session));
  if (response.status === 400 || response.status === 401) {
    // An expired session: start a fresh one once.
    sessions.delete(tile.style);
    session = await tileSession(tile.style, apiKey);
    response = await fetch(url(session));
  }
  if (!response.ok) {
    logger.warn("MAP_TILE_FAILED", {status: response.status, z: tile.z});
    return {status: 502, body: Buffer.from(""), contentType: "text/plain", cacheControl: "no-store"};
  }
  const body = Buffer.from(await response.arrayBuffer());
  await recordMapsUsage("tiles");
  return {status: 200, body, contentType: response.headers.get("content-type") || "image/png",
    // The CDN keeps a tile for a day, so a busy area is fetched from Google about once a day.
    cacheControl: "public, max-age=86400, s-maxage=86400"};
}

/** Decimal degrees "lng,lat", inside India. */
export function parsePoint(value: string | undefined): LatLng | null {
  const parts = String(value ?? "").split(",").map(Number);
  const lng = Number(parts[0]); const lat = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 5 || lat > 38 || lng < 66 || lng > 99) return null;
  return {lat, lng};
}

export interface GoogleRoute {polyline: string; distance: number; duration: number}

/** One two-wheeler, traffic-aware route from Google. Billed once at the two-wheeler price. */
export async function googleTwoWheelerRoute(origin: LatLng, destination: LatLng, apiKey: string): Promise<GoogleRoute | null> {
  const response = await fetch(ROUTES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration",
    },
    body: JSON.stringify({
      origin: {location: {latLng: {latitude: origin.lat, longitude: origin.lng}}},
      destination: {location: {latLng: {latitude: destination.lat, longitude: destination.lng}}},
      travelMode: "TWO_WHEELER", routingPreference: "TRAFFIC_AWARE",
      polylineEncoding: "ENCODED_POLYLINE", languageCode: "en-IN", regionCode: "IN", units: "METRIC",
    }),
  });
  if (!response.ok) {
    logger.warn("ROUTES_API_FAILED", {status: response.status, body: (await response.text()).slice(0, 300)});
    return null;
  }
  const body = await response.json() as {routes?: {polyline?: {encodedPolyline?: string}; distanceMeters?: number; duration?: string}[]};
  const route = body.routes?.[0];
  if (!route?.polyline?.encodedPolyline) return null;
  return {polyline: route.polyline.encodedPolyline, distance: Number(route.distanceMeters ?? 0),
    duration: Number(String(route.duration ?? "0s").replace(/s$/, "")) || 0};
}

const ROUTE_STATUSES = new Set(["Handed to rider", "Out for delivery", "Near you", "Arrived"]);
const ROUTE_MAX_ORDER_AGE_MS = 2 * 60 * 60 * 1000;
const ROUTE_MIN_GAP_MS = 60_000;
const ROUTE_MAX_PER_ORDER = 6;
const ON_ROUTE_METERS = 150;

export interface OrderRouteRequest {
  uid: string;
  privileged: boolean;
  orderId: string;
  /** The app's latest idea of where the rider is, used if the server has no fresh fix. */
  from: LatLng | null;
  apiKey: string;
  now?: number;
}

function routePayload(route: {polyline: string; distance: number; duration: number}): unknown {
  return {code: "Ok", source: "google", beta: true, routes: [{geometry: route.polyline, distance: route.distance, duration: route.duration}]};
}

/**
 * The road line from the rider to the door, after handover. One route per
 * order, kept on the server and shared by everyone watching it. A new route is
 * asked from Google only when the rider is clearly off the current one, at most
 * once a minute and 6 times per order, never for orders over two hours old,
 * and never past our daily cap or when routes are switched off.
 */
export async function deliveryRouteForOrder(input: OrderRouteRequest): Promise<{status: number; payload: unknown}> {
  const now = input.now ?? Date.now();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.orderId)) return {status: 400, payload: {code: "InvalidOrder"}};
  const orderSnapshot = await orderRef(firestoreDb, input.orderId).get();
  const order = orderSnapshot.exists ? orderSnapshot.data() as SavrivoOrder : null;
  // The customer, or a friend in the same squad order (they share this one route).
  const watcher = order && (order.customerId === input.uid || (Array.isArray(order.squadMemberUids) && order.squadMemberUids.includes(input.uid)));
  if (!order || (!watcher && !input.privileged)) return {status: 404, payload: {code: "NotFound"}};
  if (!ROUTE_STATUSES.has(order.status)) return {status: 409, payload: {code: "NotOnTheWay"}};
  if (now - Number(order.createdAt || 0) > ROUTE_MAX_ORDER_AGE_MS) return {status: 410, payload: {code: "TooOld"}};
  const destination = {lat: Number(order.address?.lat), lng: Number(order.address?.lng)};
  if (!Number.isFinite(destination.lat) || !Number.isFinite(destination.lng)) return {status: 409, payload: {code: "NoAddress"}};

  // Where the rider really is: the server's own live fix when fresh, else the app's.
  const fix = (await db.ref(`${ROOT}/tracking/${input.orderId}`).get()).val() as {lat?: number; lng?: number; updatedAt?: number} | null;
  const origin = fix && Number.isFinite(Number(fix.lat)) && now - Number(fix.updatedAt || 0) < 120_000
    ? {lat: Number(fix.lat), lng: Number(fix.lng)} : input.from;
  if (!origin) return {status: 409, payload: {code: "NoRiderLocation"}};

  const ref = firestoreDb.collection("orderRoutes").doc(input.orderId);
  type Stored = {polyline?: string; distance?: number; duration?: number; count?: number; lastAt?: number; pendingUntil?: number};
  const decision = await firestoreDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = (snapshot.exists ? snapshot.data() : {}) as Stored;
    const has = typeof stored.polyline === "string" && stored.polyline.length > 1;
    const onRoute = has && distanceToRouteMeters(origin, decodePolyline(stored.polyline!)) <= ON_ROUTE_METERS;
    if (has && (onRoute || now - Number(stored.lastAt || 0) < ROUTE_MIN_GAP_MS || Number(stored.count || 0) >= ROUTE_MAX_PER_ORDER)) {
      return {kind: "stored" as const, stored};
    }
    if (Number(stored.pendingUntil || 0) > now) return {kind: "wait" as const, stored};
    if (!await mapsAllowed("routes")) return {kind: has ? "stored" as const : "off" as const, stored};
    transaction.set(ref, {orderId: input.orderId, customerId: order.customerId, count: Number(stored.count || 0) + 1,
      lastAt: now, pendingUntil: now + 10_000}, {merge: true});
    return {kind: "ask" as const, stored};
  });

  if (decision.kind === "stored") return {status: 200, payload: routePayload(decision.stored as GoogleRoute)};
  if (decision.kind === "off") return {status: 503, payload: {code: "RoutesOff"}};
  if (decision.kind === "wait") {
    // Someone else's request is asking Google right now: wait briefly for it.
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const latest = (await ref.get()).data() as Stored | undefined;
      if (latest?.polyline && Number(latest.pendingUntil || 0) <= Date.now()) return {status: 200, payload: routePayload(latest as GoogleRoute)};
    }
    return decision.stored.polyline ? {status: 200, payload: routePayload(decision.stored as GoogleRoute)} : {status: 503, payload: {code: "Pending"}};
  }
  const route = await googleTwoWheelerRoute(origin, destination, input.apiKey);
  await recordMapsUsage("routes");
  if (!route) {
    await ref.set({pendingUntil: 0}, {merge: true});
    return decision.stored.polyline ? {status: 200, payload: routePayload(decision.stored as GoogleRoute)} : {status: 502, payload: {code: "NoRoute"}};
  }
  await ref.set({...route, pendingUntil: 0, updatedAt: Date.now(), expiresAt: now + 24 * 60 * 60 * 1000}, {merge: true});
  return {status: 200, payload: routePayload(route)};
}

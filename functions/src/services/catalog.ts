import {firestoreDb} from "../admin";
import {haversineKm, roundMoney} from "../domain/order";
import {trustedActiveOrderCount} from "../domain/workload";
import {DomainError} from "../errors";
import {campaignsCollectionRef, menuItemsCollectionRef, restaurantRef, riderAvailabilityCollectionRef} from "../firestorePaths";
import {availabilityCityKey} from "../domain/dispatch";
import {riderSurgeFee, type RiderSurgeSettings} from "../domain/riderSurge";
import {
  checkoutEligibleRiderIncentiveCampaigns,
  normalizeCheckoutCampaign,
  resolveCheckoutRiderIncentiveFeePaise,
  resolveCheckoutRiderIncentiveLineItems,
} from "../domain/riderIncentiveEligibility";
import {restaurantWorkloadRef} from "./workload";
import {loadEconomicsControl, promotionDiscountPaise, resolveCheckoutPromotion} from "./economics";
import {economicsScopeKey, rupeesToPaise} from "../domain/economics";
import {applyCustomerPricingOverride, resolveCustomerPricing} from "../domain/customerPricing";
import {returnTripFee, returnTripPolicy, type StorePoint} from "../domain/returnTrip";
import {roadDistanceKm} from "./roadDistance";
import type {Address, CatalogItem, CatalogRestaurant} from "../types";

type UnknownRecord = Record<string, unknown>;

function records<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter(Boolean) as T[];
  if (value && typeof value === "object") return Object.entries(value as Record<string, T>)
    .filter(([, entry]) => entry != null)
    .map(([id, entry]) => ({id, ...(entry as object)} as T));
  return [];
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function loadRestaurantAndMenu(restaurantId: string): Promise<{
  restaurant: CatalogRestaurant;
  menuById: Record<string, CatalogItem>;
}> {
  const [restaurantSnapshot, menuSnapshot] = await Promise.all([
    restaurantRef(firestoreDb, restaurantId).get(),
    menuItemsCollectionRef(firestoreDb, restaurantId).get(),
  ]);
  const restaurant = (restaurantSnapshot.exists ? restaurantSnapshot.data() : null) as CatalogRestaurant | null;
  if (!restaurant || restaurant.id !== restaurantId) throw new DomainError("not-found", "Restaurant not found.");
  if (restaurant.archived === true || restaurant.open !== true) {
    throw new DomainError("failed-precondition", "Restaurant is not accepting orders.");
  }
  if (![restaurant.lat, restaurant.lng, restaurant.deliveryFee, restaurant.etaMin, restaurant.etaMax]
    .every((value) => Number.isFinite(Number(value)))) {
    throw new DomainError("failed-precondition", "Restaurant delivery configuration is incomplete.");
  }

  const normalized = menuSnapshot.docs.map((doc) => ({id: doc.id, ...(doc.data() as object)} as CatalogItem));
  const embedded = records<CatalogItem>(restaurant.menu);
  const selected = normalized.length ? normalized : embedded;
  const menuById = Object.fromEntries(selected.filter((item) => item.id).map((item) => [item.id, item]));
  if (!Object.keys(menuById).length) throw new DomainError("failed-precondition", "Restaurant menu is unavailable.");
  return {restaurant, menuById};
}

export async function loadCustomerAddress(uid: string, addressId: string): Promise<{
  address: Address;
  profile: UnknownRecord;
}> {
  const profileSnapshot = await firestoreDb.collection("users").doc(uid).get();
  const profile = (profileSnapshot.exists ? profileSnapshot.data() : null) as UnknownRecord | null;
  if (!profile) throw new DomainError("failed-precondition", "Complete the customer profile before ordering.");
  const raw = records<Address>(profile.addresses).find((candidate) => candidate.id === addressId);
  if (!raw) throw new DomainError("not-found", "Saved delivery address not found.");
  if (!Number.isFinite(Number(raw.lat)) || !Number.isFinite(Number(raw.lng))) {
    throw new DomainError("failed-precondition", "The delivery address needs a map pin.");
  }
  const phone = String(raw.phone ?? profile.phone ?? "").trim();
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) throw new DomainError("failed-precondition", "The delivery address needs a valid phone number.");
  const fullAddress = String(raw.address ?? "").trim();
  const area = String(raw.area ?? raw.city ?? "").trim();
  if (!fullAddress || !area) throw new DomainError("failed-precondition", "The delivery address is incomplete.");
  const address: Address = {
    id: String(raw.id),
    label: String(raw.label || "Delivery address").trim().slice(0, 80),
    area: area.slice(0, 180),
    address: fullAddress.slice(0, 600),
    phone: phone.slice(0, 24),
    source: raw.source === "gps" ? "gps" : "manual",
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now(),
    lat: Number(raw.lat),
    lng: Number(raw.lng),
    ...(raw.details ? {details: String(raw.details).slice(0, 600)} : {}),
    ...(raw.city ? {city: String(raw.city).slice(0, 120)} : {}),
    ...(raw.house ? {house: String(raw.house).trim().slice(0, 160)} : {}),
    ...(raw.landmark ? {landmark: String(raw.landmark).trim().slice(0, 160)} : {}),
    ...(raw.street ? {street: String(raw.street).trim().slice(0, 300)} : {}),
    ...(addressPhotoUrl(uid, raw.photoUrl) ? {photoUrl: addressPhotoUrl(uid, raw.photoUrl)} : {}),
  };
  return {address, profile};
}

/**
 * The customer's photo of their place goes on the order only when it is one of
 * their own uploads (addressPhotos/{uid}/...) in this project's Storage, so a
 * profile edit can't put some other link in front of the rider.
 */
export function addressPhotoUrl(uid: string, value: unknown): string {
  const url = String(value ?? "").trim();
  if (!url || url.length > 600) return "";
  const prefix = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/(savrivo-app-mumbai|savrivo-app\.firebasestorage\.app)\/o\/addressPhotos%2F([A-Za-z0-9_-]+)%2F[A-Za-z0-9_.-]+\?alt=media&token=[A-Za-z0-9-]+$/.exec(url);
  return prefix && prefix[2] === uid ? url : "";
}

/** Rider surge for the restaurant's city; a failed read never blocks checkout (no fee). */
async function cityRiderSurgeFee(settings: RiderSurgeSettings, city: unknown): Promise<number> {
  if (settings.riderSurgeEnabled !== true) return 0;
  try {
    const snapshot = await riderAvailabilityCollectionRef(firestoreDb)
      .where("cityKey", "==", availabilityCityKey(city)).limit(500).get();
    const riders = snapshot.docs.map((doc) => doc.data() as {online?: unknown; activeOrderId?: unknown});
    const online = riders.filter((rider) => rider.online === true);
    return riderSurgeFee(settings, {onlineRiders: online.length, busyRiders: online.filter((rider) => Boolean(rider.activeOrderId)).length});
  } catch {
    return 0;
  }
}

/** Base fee plus a per-km rate, or null when Admin has not set per-km pricing. */
export function distanceDeliveryFee(settings: UnknownRecord, distanceKm: number): number | null {
  const base = Number(settings.deliveryBaseFee);
  const perKm = Number(settings.deliveryPerKm);
  if (!Number.isFinite(base) || !Number.isFinite(perKm) || base < 0 || perKm < 0 || base + perKm <= 0) return null;
  // Paise kept (founder 18 Nov): every 0.1 km at ₹5/km is ₹0.50, never rounded to the rupee.
  return Math.round((base + perKm * Math.max(0, distanceKm)) * 100) / 100;
}

/** settings/customer deliveryDistanceMode "road" = charge road km (Google two-wheeler route); else straight line. */
export function usesRoadDistance(settings: UnknownRecord): boolean {
  return settings.deliveryDistanceMode === "road";
}

// Store locations for return-trip pay, read at most every 10 minutes per server copy.
let storePointsCache: {at: number; points: StorePoint[]} | null = null;
async function loadStorePoints(): Promise<StorePoint[]> {
  if (storePointsCache && Date.now() - storePointsCache.at < 10 * 60 * 1000) return storePointsCache.points;
  const snapshot = await firestoreDb.collection("restaurants").select("lat", "lng", "archived").get();
  const points = snapshot.docs
    .map((doc) => doc.data() as UnknownRecord)
    .filter((data) => data.archived !== true)
    .map((data) => ({lat: Number(data.lat), lng: Number(data.lng)}))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && !(point.lat === 0 && point.lng === 0));
  storePointsCache = {at: Date.now(), points};
  return points;
}

export async function loadServerFees(
  restaurant: CatalogRestaurant,
  address: Address,
  subtotal: number,
): Promise<{
  deliveryFee: number;
  platformFee: number;
  taxRate: number;
  smallOrderThreshold: number;
  smallOrderFee: number;
  lateNightFee: number;
  rainFee: number;
  surgeFee: number;
  riderIncentiveFee: number;
  /** What riders are paid for the matched per-order campaigns (may differ from the customer fee). */
  riderIncentivePay: number;
  riderSurgeFee: number;
  riderIncentiveCampaignIds: string[];
  riderIncentiveItems: {label: string; amount: number}[];
  /** Part of deliveryFee paid for riding back from a drop far from every store (domain/returnTrip.ts). */
  returnTripFee: number;
  returnTripKm: number;
  /** Road km charged (null when the fee uses straight-line km). */
  roadKm: number | null;
  distanceKm: number;
  activeOrders: number;
  pricingScopes: string[];
}> {
  const [settingsSnapshot, loadSnapshot, signalSnapshot, campaignsSnapshot] = await Promise.all([
    firestoreDb.collection("settings").doc("customer").get(),
    restaurantWorkloadRef(firestoreDb, restaurant.id).get(),
    firestoreDb.collection("pricingSignals").doc(restaurant.id).get(),
    // A read failure here must never block checkout - it just means no
    // rider-incentive surcharge is applied, same "fail closed" idiom as rain.
    campaignsCollectionRef(firestoreDb).get().catch(() => null),
  ]);
  // City and zone price lists (Admin → Economics → Zones) layer over the
  // global customer settings; they set customer prices only, never rider pay.
  const control = await loadEconomicsControl();
  const pricing = resolveCustomerPricing(
    control.customerPricing,
    economicsScopeKey(restaurant.city),
    economicsScopeKey(address.area || address.label),
  );
  const settings = applyCustomerPricingOverride(
    (settingsSnapshot.exists ? settingsSnapshot.data() : {}) as UnknownRecord,
    pricing.override,
  );
  if (finite(settings.minimumOrder) > 0 && subtotal < finite(settings.minimumOrder)) {
    throw new DomainError("failed-precondition", `The minimum order here is ₹${finite(settings.minimumOrder)}.`);
  }
  const load = (loadSnapshot.exists ? loadSnapshot.data() : {}) as UnknownRecord;
  const signal = (signalSnapshot.exists ? signalSnapshot.data() : {}) as UnknownRecord;
  const riderCampaigns = (campaignsSnapshot?.docs ?? [])
    .map((doc) => normalizeCheckoutCampaign(doc.id, doc.data()))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const distanceKm = haversineKm(restaurant, address);
  // A store may deliver less far than the area allows (e.g. a store delivering its own orders).
  const areaMaxKm = finite(settings.maxDeliveryKm, 7);
  const storeMaxKm = finite((restaurant as {deliveryRadiusKm?: unknown}).deliveryRadiusKm, 0);
  const maxDeliveryKm = storeMaxKm > 0 && (areaMaxKm <= 0 || storeMaxKm < areaMaxKm) ? storeMaxKm : areaMaxKm;
  if (maxDeliveryKm > 0 && distanceKm > maxDeliveryKm) {
    throw new DomainError("out-of-range", "Delivery address is outside the service radius.");
  }

  let deliveryFee = finite(restaurant.deliveryFee);
  const slabs = records<{maxKm: number; fee: number}>(settings.deliverySlabs)
    .filter((entry) => Number.isFinite(Number(entry.maxKm)) && Number.isFinite(Number(entry.fee)))
    .sort((a, b) => Number(a.maxKm) - Number(b.maxKm));
  const matchingSlab = slabs.find((entry) => distanceKm <= Number(entry.maxKm));
  if (matchingSlab) deliveryFee = Number(matchingSlab.fee);
  // Per-km pricing (Admin: base fee + per-km rate) replaces the slabs when set. Part kilometres
  // are charged pro rata (0.7 km at ₹2/km is ₹1.40) and the total is rounded to the rupee.
  // Road km (founder 18 Nov 2026) when deliveryDistanceMode is "road": the per-km fee and the
  // ride back use the road the delivery partner actually rides; the service radius stays straight-line.
  const road = usesRoadDistance(settings) ? await roadDistanceKm(restaurant, address, distanceKm) : null;
  const feeKm = road ? road.km : distanceKm;
  const perKmFee = distanceDeliveryFee(settings, feeKm);
  if (perKmFee !== null) deliveryFee = perKmFee;
  if (finite(settings.freeDeliveryAbove) > 0 && subtotal >= finite(settings.freeDeliveryAbove)) deliveryFee = 0;
  // Far drop: the delivery partner rides back empty to the nearest store. Included in
  // the delivery fee, so the delivery partner is paid all of it. A failed read = no extra.
  const returnPolicy = returnTripPolicy(settings);
  const roadFactor = road && distanceKm > 0.05 ? road.km / distanceKm : 1;
  const returnTrip = returnPolicy.perKm > 0 ?
    returnTripFee(address, [restaurant, ...await loadStorePoints().catch(() => [] as StorePoint[])], returnPolicy, roadFactor) :
    {km: 0, fee: 0};
  deliveryFee = Math.round((deliveryFee + returnTrip.fee) * 100) / 100;

  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23",
  }).format(new Date()));
  const lateStart = finite(settings.lateNightStartHour, 23);
  const lateEnd = finite(settings.lateNightEndHour, 5);
  const lateWindow = lateStart > lateEnd ? hour >= lateStart || hour < lateEnd : hour >= lateStart && hour < lateEnd;
  const lateNightFee = settings.lateNightFeeEnabled === true && lateWindow ? finite(settings.lateNightFee) : 0;

  const activeOrders = trustedActiveOrderCount(load, restaurant.id);
  const backendOwnedLoad = load.source === "functions" && load.restaurantId === restaurant.id;
  let surgeFee = 0;
  if (settings.surgeEnabled === true && backendOwnedLoad) {
    const low = finite(settings.surgeLowOrders, 4);
    const medium = finite(settings.surgeMediumOrders, 8);
    const high = finite(settings.surgeHighOrders, 12);
    surgeFee = activeOrders >= high ? finite(settings.surgeHighFee, 29) :
      activeOrders >= medium ? finite(settings.surgeMediumFee, 19) :
        activeOrders >= low ? finite(settings.surgeLowFee, 9) : 0;
    surgeFee = Math.min(surgeFee, finite(settings.maxSurgeFee, 39));
  }

  // Rain is accepted only from a fresh backend-owned signal. The client cannot
  // submit weather or fee values. A scheduled weather adapter may populate it.
  const validUntil = finite(signal.validUntil);
  const rainFee = settings.rainFeeEnabled === true && validUntil > Date.now() && signal.kind === "verified_weather"
    ? Math.min(500, Math.max(0, finite(signal.rainFee))) : 0;

  // Mirrors, at checkout time, exactly which per-order rider bonuses will
  // actually be credited to whichever rider ends up delivering this order -
  // same time-window/day/restaurant/zone/order-value/rain-only checks, and
  // the same stack-vs-highest-only payout rule, as the delivery-time
  // crediting path in services/riderRewards.ts.
  const eligibleRiderIncentiveCampaigns = checkoutEligibleRiderIncentiveCampaigns(riderCampaigns, Date.now(), {
    restaurantId: restaurant.id,
    area: address.area || address.label || "",
    subtotalPaise: Math.round(subtotal * 100),
    rainFeeApplied: rainFee > 0,
  });
  const riderIncentive = resolveCheckoutRiderIncentiveFeePaise(eligibleRiderIncentiveCampaigns);
  const riderIncentiveItems = resolveCheckoutRiderIncentiveLineItems(eligibleRiderIncentiveCampaigns)
    .map((item) => ({label: item.label, amount: roundMoney(item.amountPaise / 100)}))
    .filter((item) => item.amount > 0);

  return {
    deliveryFee: roundMoney(Math.max(0, deliveryFee)),
    platformFee: roundMoney(Math.max(0, finite(settings.platformFee, finite(restaurant.platformFee, 9)))),
    taxRate: Math.min(100, Math.max(0, finite(settings.taxRate))),
    smallOrderThreshold: settings.smallOrderFeeEnabled === true ? Math.max(0, finite(settings.smallOrderThreshold)) : 0,
    smallOrderFee: settings.smallOrderFeeEnabled === true ? Math.max(0, finite(settings.smallOrderFee)) : 0,
    lateNightFee: Math.max(0, lateNightFee),
    rainFee,
    surgeFee: Math.max(0, surgeFee),
    riderIncentiveFee: roundMoney(riderIncentive.amountPaise / 100),
    riderIncentivePay: roundMoney(riderIncentive.riderPaise / 100),
    riderSurgeFee: await cityRiderSurgeFee(settings as RiderSurgeSettings, restaurant.city),
    riderIncentiveCampaignIds: riderIncentive.campaignIds,
    riderIncentiveItems,
    returnTripFee: returnTrip.fee,
    returnTripKm: returnTrip.km,
    roadKm: road ? road.km : null,
    distanceKm,
    activeOrders,
    pricingScopes: pricing.scopes,
  };
}

/**
 * Gross discount (in rupees) a coupon gives this cart, after every
 * eligibility rule - first order only, per-customer limit, restaurant/city
 * scope, minimum order, dates and remaining budget. Who pays for it, and how
 * much of a Scraveit-funded share the order can safely afford, is decided by
 * planCheckoutEconomics; this stays as the simple "is the code valid" entry.
 */
export async function calculateDiscount(
  code: string,
  subtotal: number,
  restaurantId: string,
  customerId: string,
  cityKey = "",
): Promise<number> {
  const subtotalPaise = rupeesToPaise(subtotal);
  const promotion = await resolveCheckoutPromotion(code, {
    subtotalPaise,
    restaurantId,
    cityKey,
    customerId,
    at: Date.now(),
  });
  if (!promotion) return 0;
  return promotionDiscountPaise(promotion.terms, subtotalPaise) / 100;
}

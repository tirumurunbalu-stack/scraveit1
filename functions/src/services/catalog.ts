import {db} from "../admin";
import {ROOT} from "../config";
import {haversineKm, roundMoney} from "../domain/order";
import {trustedActiveOrderCount} from "../domain/workload";
import {DomainError} from "../errors";
import {
  checkoutEligibleRiderIncentiveCampaigns,
  normalizeCheckoutCampaign,
  resolveCheckoutRiderIncentiveFeePaise,
  resolveCheckoutRiderIncentiveLineItems,
} from "../domain/riderIncentiveEligibility";
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
    db.ref(`${ROOT}/catalog/restaurants/${restaurantId}`).get(),
    db.ref(`${ROOT}/menus/${restaurantId}`).get(),
  ]);
  const restaurant = restaurantSnapshot.val() as CatalogRestaurant | null;
  if (!restaurant || restaurant.id !== restaurantId) throw new DomainError("not-found", "Restaurant not found.");
  if (restaurant.archived === true || restaurant.open !== true) {
    throw new DomainError("failed-precondition", "Restaurant is not accepting orders.");
  }
  if (![restaurant.lat, restaurant.lng, restaurant.deliveryFee, restaurant.etaMin, restaurant.etaMax]
    .every((value) => Number.isFinite(Number(value)))) {
    throw new DomainError("failed-precondition", "Restaurant delivery configuration is incomplete.");
  }

  const normalized = records<CatalogItem>(menuSnapshot.val());
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
  const profile = (await db.ref(`${ROOT}/users/${uid}`).get()).val() as UnknownRecord | null;
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
  };
  return {address, profile};
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
  riderIncentiveCampaignIds: string[];
  riderIncentiveItems: {label: string; amount: number}[];
  distanceKm: number;
  activeOrders: number;
}> {
  const [settingsSnapshot, loadSnapshot, signalSnapshot, campaignsSnapshot] = await Promise.all([
    db.ref(`${ROOT}/settings/customer`).get(),
    db.ref(`${ROOT}/private/restaurantWorkload/${restaurant.id}`).get(),
    db.ref(`${ROOT}/pricingSignals/${restaurant.id}`).get(),
    // A read failure here must never block checkout - it just means no
    // rider-incentive surcharge is applied, same "fail closed" idiom as rain.
    db.ref(`${ROOT}/private/riderRewards/campaigns`).get().catch(() => null),
  ]);
  const settings = (settingsSnapshot.val() ?? {}) as UnknownRecord;
  const load = (loadSnapshot.val() ?? {}) as UnknownRecord;
  const signal = (signalSnapshot.val() ?? {}) as UnknownRecord;
  const riderCampaigns = records<{id: string}>(campaignsSnapshot?.val())
    .map((entry) => normalizeCheckoutCampaign(entry.id, entry))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const distanceKm = haversineKm(restaurant, address);
  const maxDeliveryKm = finite(settings.maxDeliveryKm, 15);
  if (maxDeliveryKm > 0 && distanceKm > maxDeliveryKm) {
    throw new DomainError("out-of-range", "Delivery address is outside the service radius.");
  }

  let deliveryFee = finite(restaurant.deliveryFee);
  const slabs = records<{maxKm: number; fee: number}>(settings.deliverySlabs)
    .filter((entry) => Number.isFinite(Number(entry.maxKm)) && Number.isFinite(Number(entry.fee)))
    .sort((a, b) => Number(a.maxKm) - Number(b.maxKm));
  const matchingSlab = slabs.find((entry) => distanceKm <= Number(entry.maxKm));
  if (matchingSlab) deliveryFee = Number(matchingSlab.fee);
  if (finite(settings.freeDeliveryAbove) > 0 && subtotal >= finite(settings.freeDeliveryAbove)) deliveryFee = 0;

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
    riderIncentiveCampaignIds: riderIncentive.campaignIds,
    riderIncentiveItems,
    distanceKm,
    activeOrders,
  };
}

export async function calculateDiscount(code: string, subtotal: number, restaurantId: string): Promise<number> {
  if (!code) return 0;
  const snapshot = await db.ref(`${ROOT}/promotions`).orderByChild("code").equalTo(code).limitToFirst(5).get();
  const promotions = records<UnknownRecord>(snapshot.val());
  const promotion = promotions.find((entry) => entry.active === true && String(entry.code) === code);
  if (!promotion) throw new DomainError("failed-precondition", "Coupon is not valid.");
  if (finite(promotion.expiresAt) > 0 && finite(promotion.expiresAt) <= Date.now()) {
    throw new DomainError("failed-precondition", "Coupon has expired.");
  }
  if (subtotal < finite(promotion.minimumOrder)) {
    throw new DomainError("failed-precondition", "Order does not meet the coupon minimum.");
  }
  const restaurants = Array.isArray(promotion.restaurantIds) ? promotion.restaurantIds.map(String) : [];
  if (restaurants.length && !restaurants.includes(restaurantId)) {
    throw new DomainError("failed-precondition", "Coupon is not valid for this restaurant.");
  }
  return roundMoney(Math.min(subtotal * finite(promotion.percent) / 100, finite(promotion.maxDiscount, subtotal)));
}

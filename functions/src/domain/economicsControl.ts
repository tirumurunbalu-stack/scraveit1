import {
  economicsScopeKey,
  normalizeCommercialPlans,
  normalizeEconomicsPolicyOverride,
  type EconomicsPolicy,
  type EconomicsPolicyLayers,
  type RestaurantCommercialPlan,
} from "./economics";
import {
  normalizeRiderTripPayVersions,
  type RiderTripPayLayers,
  type RiderTripPayVersion,
} from "./riderTripPay";
import {
  normalizeCustomerPricingOverride,
  normalizeCustomerReferralProgram,
  type CustomerPricingOverride,
  type CustomerReferralProgram,
} from "./customerPricing";
import {normalizeCityFinanceOverride, type CityFinancePolicy} from "./cityFinance";
import {normalizeWalletRules, type WalletRules} from "./wallet";
import {normalizeTaxVersions, type TaxVersion} from "./taxRules";

/**
 * The single economics control document (`economicsControl/current`). Kept in
 * one document on purpose: checkout reads it once (and caches it briefly), so
 * every pricing decision costs one read no matter how many cities, zones and
 * restaurant plans exist.
 */

export interface EconomicsFlags {
  /** Freeze an economics snapshot on every new order and settle from it. */
  economicsEngine: boolean;
  /** Limit Scraveit-funded discounts to what each order can safely give. */
  profitabilityGuardrail: boolean;
  /** Allow rider campaigns in earnings-guarantee mode to settle top-ups. */
  riderGuarantee: boolean;
  /** Let restaurants create their own (self-funded) offers. */
  restaurantOffers: boolean;
  /** Empty means every city; otherwise only these cities use the engine. */
  enabledCityKeys: string[];
}

export interface RiderPayRules {
  /**
   * A rider is never paid less than this for a completed trip, even when the
   * customer's delivery fee was waived. The gap is a Scraveit cost.
   */
  minimumTripPayPaise: number;
}

export interface RestaurantOfferAutoApproval {
  enabled: boolean;
  maxPercent: number;
  maxDiscountPaise: number;
}

/** Where a city sits, so every financial entry can carry country/state/city. */
export interface CityRegistryEntry {
  name: string;
  stateKey: string;
  countryKey: string;
  timezone: string;
}

export const DEFAULT_CITY_REGISTRY: Readonly<Record<string, CityRegistryEntry>> = Object.freeze({
  nellore: {name: "Nellore", stateKey: "andhra-pradesh", countryKey: "in", timezone: "Asia/Kolkata"},
});

export interface EconomicsControl {
  schemaVersion: 1;
  revision: number;
  flags: EconomicsFlags;
  policies: Required<EconomicsPolicyLayers>;
  commercialPlans: Record<string, RestaurantCommercialPlan[]>;
  riderPay: RiderPayRules;
  restaurantOfferAutoApproval: RestaurantOfferAutoApproval;
  /** Rider trip pay: independent of customer delivery fees, effective-dated per scope. */
  riderTripPay: RiderTripPayLayers;
  /** City / zone overrides of the global customer price list. */
  customerPricing: {cities: Record<string, CustomerPricingOverride>; zones: Record<string, CustomerPricingOverride>};
  cities: Record<string, CityRegistryEntry>;
  cityFinance: {global: Partial<CityFinancePolicy>; cities: Record<string, Partial<CityFinancePolicy>>};
  walletRules: WalletRules;
  customerReferral: CustomerReferralProgram;
  taxVersions: TaxVersion[];
  updatedAt: number;
  updatedBy: string;
}

export const DEFAULT_ECONOMICS_FLAGS: Readonly<EconomicsFlags> = Object.freeze({
  economicsEngine: true,
  profitabilityGuardrail: true,
  riderGuarantee: true,
  restaurantOffers: true,
  enabledCityKeys: [],
});

export const DEFAULT_RIDER_PAY_RULES: Readonly<RiderPayRules> = Object.freeze({minimumTripPayPaise: 2_000});

export const DEFAULT_RESTAURANT_OFFER_AUTO_APPROVAL: Readonly<RestaurantOfferAutoApproval> = Object.freeze({
  enabled: true,
  maxPercent: 30,
  maxDiscountPaise: 15_000,
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.min(maximum, Math.max(minimum, parsed))) : fallback;
}

function overrideMap(value: unknown, keyFn: (key: string) => string): Record<string, Partial<EconomicsPolicy>> {
  const output: Record<string, Partial<EconomicsPolicy>> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    const normalizedKey = keyFn(key);
    const override = normalizeEconomicsPolicyOverride(entry);
    if (normalizedKey && Object.keys(override).length) output[normalizedKey] = override;
  }
  return output;
}

export function zonePolicyKey(cityKey: string, zoneKey: string): string {
  const city = economicsScopeKey(cityKey);
  const zone = economicsScopeKey(zoneKey);
  return city && zone ? `${city}|${zone}` : "";
}

function restaurantIdKey(value: string): string {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,120}$/.test(trimmed) ? trimmed : "";
}

export function normalizeEconomicsFlags(value: unknown): EconomicsFlags {
  const input = record(value);
  return {
    economicsEngine: bool(input.economicsEngine, DEFAULT_ECONOMICS_FLAGS.economicsEngine),
    profitabilityGuardrail: bool(input.profitabilityGuardrail, DEFAULT_ECONOMICS_FLAGS.profitabilityGuardrail),
    riderGuarantee: bool(input.riderGuarantee, DEFAULT_ECONOMICS_FLAGS.riderGuarantee),
    restaurantOffers: bool(input.restaurantOffers, DEFAULT_ECONOMICS_FLAGS.restaurantOffers),
    enabledCityKeys: Array.isArray(input.enabledCityKeys) ?
      [...new Set(input.enabledCityKeys.map(economicsScopeKey).filter(Boolean))].slice(0, 100) : [],
  };
}

export function normalizeRiderPayRules(value: unknown): RiderPayRules {
  const input = record(value);
  return {
    minimumTripPayPaise: bounded(input.minimumTripPayPaise, DEFAULT_RIDER_PAY_RULES.minimumTripPayPaise, 0, 50_000),
  };
}

export function normalizeRestaurantOfferAutoApproval(value: unknown): RestaurantOfferAutoApproval {
  const input = record(value);
  return {
    enabled: bool(input.enabled, DEFAULT_RESTAURANT_OFFER_AUTO_APPROVAL.enabled),
    maxPercent: bounded(input.maxPercent, DEFAULT_RESTAURANT_OFFER_AUTO_APPROVAL.maxPercent, 0, 100),
    maxDiscountPaise: bounded(input.maxDiscountPaise, DEFAULT_RESTAURANT_OFFER_AUTO_APPROVAL.maxDiscountPaise, 0, 10_000_000),
  };
}

export function normalizeEconomicsControl(value: unknown): EconomicsControl {
  const input = record(value);
  const policies = record(input.policies);
  const plans: Record<string, RestaurantCommercialPlan[]> = {};
  for (const [restaurantId, entry] of Object.entries(record(input.commercialPlans))) {
    const key = restaurantIdKey(restaurantId);
    const normalized = normalizeCommercialPlans(entry);
    if (key && normalized.length) plans[key] = normalized;
  }
  const tripPay = record(input.riderTripPay);
  const versionMap = (value: unknown, keyFn: (key: string) => string) => {
    const output: Record<string, RiderTripPayVersion[]> = {};
    for (const [key, entry] of Object.entries(record(value))) {
      const normalizedKey = keyFn(key);
      const versions = normalizeRiderTripPayVersions(entry);
      if (normalizedKey && versions.length) output[normalizedKey] = versions;
    }
    return output;
  };
  const zoneKeyFn = (key: string) => {
    const [city = "", zone = ""] = key.split("|");
    return zonePolicyKey(city, zone);
  };
  const pricing = record(input.customerPricing);
  const pricingMap = (value: unknown, keyFn: (key: string) => string) => {
    const output: Record<string, CustomerPricingOverride> = {};
    for (const [key, entry] of Object.entries(record(value))) {
      const normalizedKey = keyFn(key);
      const override = normalizeCustomerPricingOverride(entry);
      if (normalizedKey && Object.keys(override).length) output[normalizedKey] = override;
    }
    return output;
  };
  const cities: Record<string, CityRegistryEntry> = {...DEFAULT_CITY_REGISTRY};
  for (const [key, entry] of Object.entries(record(input.cities))) {
    const cityKey = economicsScopeKey(key);
    const value = record(entry);
    if (!cityKey) continue;
    cities[cityKey] = {
      name: String(value.name ?? cityKey).slice(0, 80),
      stateKey: economicsScopeKey(value.stateKey),
      countryKey: economicsScopeKey(value.countryKey) || "in",
      timezone: String(value.timezone ?? "Asia/Kolkata").slice(0, 60),
    };
  }
  const finance = record(input.cityFinance);
  const financeCities: Record<string, Partial<CityFinancePolicy>> = {};
  for (const [key, entry] of Object.entries(record(finance.cities))) {
    const cityKey = economicsScopeKey(key);
    const override = normalizeCityFinanceOverride(entry);
    if (cityKey && Object.keys(override).length) financeCities[cityKey] = override;
  }
  return {
    riderTripPay: {
      global: normalizeRiderTripPayVersions(tripPay.global),
      cities: versionMap(tripPay.cities, economicsScopeKey),
      zones: versionMap(tripPay.zones, zoneKeyFn),
    },
    customerPricing: {
      cities: pricingMap(pricing.cities, economicsScopeKey),
      zones: pricingMap(pricing.zones, zoneKeyFn),
    },
    cities,
    cityFinance: {global: normalizeCityFinanceOverride(finance.global), cities: financeCities},
    walletRules: normalizeWalletRules(input.walletRules),
    customerReferral: normalizeCustomerReferralProgram(input.customerReferral),
    taxVersions: normalizeTaxVersions(input.taxVersions),
    schemaVersion: 1,
    revision: bounded(input.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    flags: normalizeEconomicsFlags(input.flags),
    policies: {
      global: normalizeEconomicsPolicyOverride(policies.global),
      cities: overrideMap(policies.cities, economicsScopeKey),
      zones: overrideMap(policies.zones, (key) => {
        const [city = "", zone = ""] = key.split("|");
        return zonePolicyKey(city, zone);
      }),
      restaurants: overrideMap(policies.restaurants, restaurantIdKey),
    },
    commercialPlans: plans,
    riderPay: normalizeRiderPayRules(input.riderPay),
    restaurantOfferAutoApproval: normalizeRestaurantOfferAutoApproval(input.restaurantOfferAutoApproval),
    updatedAt: bounded(input.updatedAt, 0, 0, Number.MAX_SAFE_INTEGER),
    updatedBy: String(input.updatedBy ?? "").slice(0, 160),
  };
}

export function economicsEnabledForCity(control: Pick<EconomicsControl, "flags">, cityKey: string): boolean {
  if (!control.flags.economicsEngine) return false;
  const list = control.flags.enabledCityKeys;
  return list.length === 0 || list.includes(economicsScopeKey(cityKey));
}

export type EconomicsControlUpdate =
  | {section: "flags"; value: unknown}
  | {section: "policy"; scopeType: "global" | "city" | "zone" | "restaurant"; scopeKey: string; value: unknown}
  | {section: "commercialPlans"; restaurantId: string; value: unknown}
  | {section: "riderPay"; value: unknown}
  | {section: "restaurantOfferAutoApproval"; value: unknown}
  | {section: "riderTripPay"; scopeType: "global" | "city" | "zone"; scopeKey: string; value: unknown}
  | {section: "customerPricing"; scopeType: "city" | "zone"; scopeKey: string; value: unknown}
  | {section: "city"; cityKey: string; value: unknown}
  | {section: "cityFinance"; scopeType: "global" | "city"; scopeKey: string; value: unknown}
  | {section: "walletRules"; value: unknown}
  | {section: "customerReferral"; value: unknown}
  | {section: "taxVersions"; value: unknown};

/**
 * Applies one change and returns the new document plus the exact before/after
 * of the part that changed, which is what the audit history records. A policy
 * override of `{}` (or null) removes that scope's override entirely.
 */
export function applyEconomicsControlUpdate(
  current: EconomicsControl,
  update: EconomicsControlUpdate,
): {next: EconomicsControl; before: unknown; after: unknown; target: string} {
  const next: EconomicsControl = JSON.parse(JSON.stringify(current));
  switch (update.section) {
  case "flags": {
    next.flags = normalizeEconomicsFlags({...current.flags, ...record(update.value)});
    return {next, before: current.flags, after: next.flags, target: "flags"};
  }
  case "riderPay": {
    next.riderPay = normalizeRiderPayRules({...current.riderPay, ...record(update.value)});
    return {next, before: current.riderPay, after: next.riderPay, target: "riderPay"};
  }
  case "restaurantOfferAutoApproval": {
    next.restaurantOfferAutoApproval = normalizeRestaurantOfferAutoApproval({
      ...current.restaurantOfferAutoApproval,
      ...record(update.value),
    });
    return {
      next,
      before: current.restaurantOfferAutoApproval,
      after: next.restaurantOfferAutoApproval,
      target: "restaurantOfferAutoApproval",
    };
  }
  case "riderTripPay": {
    const versions = normalizeRiderTripPayVersions(update.value);
    if (update.scopeType === "global") {
      next.riderTripPay.global = versions;
      return {next, before: current.riderTripPay.global, after: versions, target: "riderTripPay:global"};
    }
    const key = update.scopeType === "city" ? economicsScopeKey(update.scopeKey) :
      zonePolicyKey(...(update.scopeKey.split("|") as [string, string]));
    if (!key) throw new Error("ECONOMICS_INVALID_SCOPE_KEY");
    const bucket = update.scopeType === "city" ? "cities" : "zones";
    const before = current.riderTripPay[bucket][key] ?? [];
    if (versions.length) next.riderTripPay[bucket][key] = versions;
    else delete next.riderTripPay[bucket][key];
    return {next, before, after: versions, target: `riderTripPay:${update.scopeType}:${key}`};
  }
  case "customerPricing": {
    const key = update.scopeType === "city" ? economicsScopeKey(update.scopeKey) :
      zonePolicyKey(...(update.scopeKey.split("|") as [string, string]));
    if (!key) throw new Error("ECONOMICS_INVALID_SCOPE_KEY");
    const bucket = update.scopeType === "city" ? "cities" : "zones";
    const override = normalizeCustomerPricingOverride(update.value);
    const before = current.customerPricing[bucket][key] ?? {};
    if (Object.keys(override).length) next.customerPricing[bucket][key] = override;
    else delete next.customerPricing[bucket][key];
    return {next, before, after: override, target: `customerPricing:${update.scopeType}:${key}`};
  }
  case "city": {
    const key = economicsScopeKey(update.cityKey);
    if (!key) throw new Error("ECONOMICS_INVALID_SCOPE_KEY");
    const value = record(update.value);
    const entry: CityRegistryEntry = {
      name: String(value.name ?? key).slice(0, 80),
      stateKey: economicsScopeKey(value.stateKey),
      countryKey: economicsScopeKey(value.countryKey) || "in",
      timezone: String(value.timezone ?? "Asia/Kolkata").slice(0, 60),
    };
    const before = current.cities[key] ?? null;
    next.cities[key] = entry;
    return {next, before, after: entry, target: `city:${key}`};
  }
  case "cityFinance": {
    const override = normalizeCityFinanceOverride(update.value);
    if (update.scopeType === "global") {
      const before = current.cityFinance.global;
      next.cityFinance.global = override;
      return {next, before, after: override, target: "cityFinance:global"};
    }
    const key = economicsScopeKey(update.scopeKey);
    if (!key) throw new Error("ECONOMICS_INVALID_SCOPE_KEY");
    const before = current.cityFinance.cities[key] ?? {};
    if (Object.keys(override).length) next.cityFinance.cities[key] = override;
    else delete next.cityFinance.cities[key];
    return {next, before, after: override, target: `cityFinance:city:${key}`};
  }
  case "walletRules": {
    next.walletRules = normalizeWalletRules({...current.walletRules, ...record(update.value)});
    return {next, before: current.walletRules, after: next.walletRules, target: "walletRules"};
  }
  case "customerReferral": {
    next.customerReferral = normalizeCustomerReferralProgram({...current.customerReferral, ...record(update.value)});
    return {next, before: current.customerReferral, after: next.customerReferral, target: "customerReferral"};
  }
  case "taxVersions": {
    next.taxVersions = normalizeTaxVersions(update.value);
    return {next, before: current.taxVersions, after: next.taxVersions, target: "taxVersions"};
  }
  case "commercialPlans": {
    const restaurantId = restaurantIdKey(update.restaurantId);
    if (!restaurantId) throw new Error("ECONOMICS_INVALID_RESTAURANT_ID");
    const plans = normalizeCommercialPlans(update.value);
    const before = current.commercialPlans[restaurantId] ?? [];
    if (plans.length) next.commercialPlans[restaurantId] = plans;
    else delete next.commercialPlans[restaurantId];
    return {next, before, after: plans, target: `commercialPlans:${restaurantId}`};
  }
  case "policy": {
    const override = normalizeEconomicsPolicyOverride(update.value);
    const empty = Object.keys(override).length === 0;
    if (update.scopeType === "global") {
      const before = current.policies.global;
      next.policies.global = override;
      return {next, before, after: override, target: "policy:global"};
    }
    const bucket = update.scopeType === "city" ? "cities" : update.scopeType === "zone" ? "zones" : "restaurants";
    const key = update.scopeType === "city" ? economicsScopeKey(update.scopeKey) :
      update.scopeType === "zone" ? zonePolicyKey(...(update.scopeKey.split("|") as [string, string])) :
        restaurantIdKey(update.scopeKey);
    if (!key) throw new Error("ECONOMICS_INVALID_SCOPE_KEY");
    const before = current.policies[bucket][key] ?? {};
    if (empty) delete next.policies[bucket][key];
    else next.policies[bucket][key] = override;
    return {next, before, after: empty ? {} : override, target: `policy:${update.scopeType}:${key}`};
  }
  }
}

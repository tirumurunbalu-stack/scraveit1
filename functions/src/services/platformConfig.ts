import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
import {
  DEFAULT_DISPATCH_POLICY,
  normalizeDispatchPolicy,
  type DispatchPolicy,
} from "../domain/dispatchPolicy";
import {
  checkoutConfiguration,
  DEFAULT_FINANCE_POLICY,
  normalizeFinancePolicy,
  type CheckoutConfiguration,
  type FinancePolicy,
} from "../domain/financePolicy";

const CONFIG_CACHE_MS = 30_000;
let dispatchCache: {policy: DispatchPolicy; expiresAt: number} | null = null;
let financeCache: {policy: FinancePolicy; expiresAt: number} | null = null;

/**
 * Loads operations-controlled dispatch settings. Invalid or unavailable
 * configuration fails safely to the existing deployed sequential behavior.
 * In-flight queues persist their own policy snapshot.
 */
export async function loadDispatchPolicy(now = Date.now()): Promise<DispatchPolicy> {
  if (dispatchCache && dispatchCache.expiresAt > now) return dispatchCache.policy;
  try {
    const snapshot = await db.ref(`${ROOT}/platformConfig/dispatch`).get();
    const policy = normalizeDispatchPolicy(snapshot.val());
    dispatchCache = {policy, expiresAt: now + CONFIG_CACHE_MS};
    return policy;
  } catch (error) {
    logger.error("DISPATCH_POLICY_LOAD_FAILED", {error});
    const policy = {...DEFAULT_DISPATCH_POLICY};
    dispatchCache = {policy, expiresAt: now + Math.min(CONFIG_CACHE_MS, 5_000)};
    return policy;
  }
}

export async function loadFinancePolicy(now = Date.now()): Promise<FinancePolicy> {
  if (financeCache && financeCache.expiresAt > now) return financeCache.policy;
  try {
    const snapshot = await db.ref(`${ROOT}/platformConfig/finance`).get();
    const policy = normalizeFinancePolicy(snapshot.val());
    financeCache = {policy, expiresAt: now + CONFIG_CACHE_MS};
    return policy;
  } catch (error) {
    logger.error("FINANCE_POLICY_LOAD_FAILED", {error});
    const policy = {...DEFAULT_FINANCE_POLICY};
    financeCache = {policy, expiresAt: now + Math.min(CONFIG_CACHE_MS, 5_000)};
    return policy;
  }
}

export async function loadCheckoutConfiguration(
  onlineGatewayConfigured: boolean,
  now = Date.now(),
): Promise<CheckoutConfiguration> {
  return checkoutConfiguration(await loadFinancePolicy(now), onlineGatewayConfigured);
}

/** Test and administrative-process hook; never exposed as a callable. */
export function clearPlatformConfigCache(): void {
  dispatchCache = null;
  financeCache = null;
}

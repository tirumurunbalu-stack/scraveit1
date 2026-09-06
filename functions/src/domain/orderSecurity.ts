import type {OrderStatus, SavrivoOrder} from "../types";

const PRIVATE_ORDER_FIELDS = [
  "deliveryOtp",
  "deliveryOtpHash",
  "deliveryOtpSalt",
  "deliveryOtpVerifier",
] as const;

export interface LegacyOtpVerifier {
  verifier: string;
  salt: string;
}

/**
 * Removes legacy delivery-code material before an order is returned, mirrored,
 * or rewritten. The cast is intentional: old RTDB rows can contain fields that
 * no longer exist in the public SavrivoOrder type.
 */
export function stripPrivateOrderFields(order: SavrivoOrder): SavrivoOrder {
  const copy = {...order} as SavrivoOrder & Record<string, unknown>;
  for (const field of PRIVATE_ORDER_FIELDS) delete copy[field];
  return copy;
}

/** Reads only legacy rows so their verifier can be migrated server-side. */
export function legacyOtpVerifier(order: SavrivoOrder): LegacyOtpVerifier | null {
  const legacy = order as SavrivoOrder & Record<string, unknown>;
  const verifier = String(legacy.deliveryOtpHash ?? legacy.deliveryOtpVerifier ?? "");
  const salt = String(legacy.deliveryOtpSalt ?? "");
  return /^[a-f0-9]{64}$/i.test(verifier) && /^[a-f0-9]{16,128}$/i.test(salt)
    ? {verifier: verifier.toLowerCase(), salt}
    : null;
}

export function publicOrderContainsPrivateFields(order: unknown): boolean {
  if (!order || typeof order !== "object") return false;
  return PRIVATE_ORDER_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(order, field));
}

export function deliveryOtpRecoveryAllowed(status: OrderStatus): boolean {
  return ["Out for delivery", "Near you", "Arrived"].includes(status);
}

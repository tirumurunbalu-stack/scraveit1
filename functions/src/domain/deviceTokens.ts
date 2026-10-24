import {createHash} from "node:crypto";

export interface DeviceTokenRecord {
  token: string;
  app: "customer" | "restaurant" | "rider" | "admin";
  platform: "android" | "ios";
  appVersion: string;
  deviceModel: string;
  enabled: true;
  createdAt: number;
  updatedAt: number;
}

export function deviceTokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function upsertDeviceToken(
  current: Record<string, DeviceTokenRecord> | null,
  record: Omit<DeviceTokenRecord, "createdAt" | "updatedAt">,
  now: number,
  cap: number,
): {tokens: Record<string, DeviceTokenRecord>; key: string} {
  const tokens = {...(current ?? {})};
  const key = deviceTokenKey(record.token);
  if (!tokens[key] && Object.keys(tokens).length >= cap) throw new Error("DEVICE_TOKEN_CAP_REACHED");
  tokens[key] = {...record, createdAt: tokens[key]?.createdAt ?? now, updatedAt: now};
  return {tokens, key};
}

/**
 * A customer phone that hasn't opened Scraveit for this long is treated as gone
 * (sold, reset, or signed out on an old app version that never told the server)
 * and stops getting notifications. Every app start refreshes the registration,
 * so a phone in use is never affected. Firebase recommends pruning tokens
 * unrefreshed for about a month. Restaurant, rider and admin phones are left
 * out: a kitchen tablet can stay open for weeks and must not miss an order.
 */
export const STALE_CUSTOMER_TOKEN_MS = 30 * 24 * 60 * 60 * 1000;

export function isStaleDeviceToken(record: Pick<DeviceTokenRecord, "app" | "updatedAt">, now: number): boolean {
  return record.app === "customer" && Number(record.updatedAt || 0) < now - STALE_CUSTOMER_TOKEN_MS;
}

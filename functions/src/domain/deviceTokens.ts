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

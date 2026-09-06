import {describe, expect, it} from "vitest";
import {deviceTokenKey, type DeviceTokenRecord, upsertDeviceToken} from "../src/domain/deviceTokens";

const base = {
  token: "fcm-registration-token-that-is-long-enough-1",
  app: "customer" as const,
  platform: "android" as const,
  appVersion: "1.0.0",
  deviceModel: "Test phone",
  enabled: true as const,
};

describe("device token registry", () => {
  it("uses a deterministic non-secret database key", () => {
    expect(deviceTokenKey(base.token)).toMatch(/^[a-f0-9]{64}$/);
    expect(deviceTokenKey(base.token)).toBe(deviceTokenKey(base.token));
    expect(deviceTokenKey(base.token)).not.toContain(base.token);
  });

  it("preserves createdAt when the same token refreshes", () => {
    const first = upsertDeviceToken(null, base, 100, 20);
    const second = upsertDeviceToken(first.tokens, {...base, appVersion: "1.1.0"}, 200, 20);
    expect(second.tokens[second.key]).toMatchObject({createdAt: 100, updatedAt: 200, appVersion: "1.1.0"});
  });

  it("allows an existing token update at the cap", () => {
    const first = upsertDeviceToken(null, base, 100, 1);
    expect(() => upsertDeviceToken(first.tokens, base, 200, 1)).not.toThrow();
  });

  it("rejects a new token once the account cap is reached", () => {
    const first = upsertDeviceToken(null, base, 100, 1);
    expect(() => upsertDeviceToken(first.tokens, {...base, token: `${base.token}-2`}, 200, 1))
      .toThrow("DEVICE_TOKEN_CAP_REACHED");
  });
});

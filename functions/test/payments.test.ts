import {beforeAll, describe, expect, it} from "vitest";
import type {UnconfiguredPhonePeGateway as GatewayType} from "../src/services/payments";

let Gateway: new () => GatewayType;

beforeAll(async () => {
  process.env.FIREBASE_CONFIG = JSON.stringify({
    projectId: "demo-savrivo-test",
    databaseURL: "https://demo-savrivo-test-default-rtdb.firebaseio.com",
  });
  Gateway = (await import("../src/services/payments")).UnconfiguredPhonePeGateway;
});

describe("PhonePe fail-closed foundation", () => {
  it("never reports an unverified callback as successful", async () => {
    const gateway = new Gateway();
    await expect(gateway.verifyWebhook({}, Buffer.from('{"state":"COMPLETED"}')))
      .resolves.toEqual({verified: false, reason: "PHONEPE_VERIFIER_NOT_CONFIGURED"});
  });

  it("cannot create a pretend payment intent", async () => {
    const gateway = new Gateway();
    await expect(gateway.createIntent({} as never, {
      merchantOrderId: "test-merchant-order",
      idempotencyKey: "test-idempotency-key",
    })).rejects.toThrow("PhonePe is not configured");
  });
});

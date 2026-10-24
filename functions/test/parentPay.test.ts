import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}}));

const {parentPayOpen, shownEstimate, PARENT_PAY_TTL_MS, parentPayRequestId, orderMirror, parentStatusNotice} = await import("../src/services/parentPay");
import type {SavrivoOrder} from "../src/types";

describe("ask a parent to pay", () => {
  it("keeps a request open only while pending and unexpired", () => {
    const now = 1_000_000;
    expect(parentPayOpen({status: "pending", expiresAt: now + PARENT_PAY_TTL_MS}, now)).toBe(true);
    expect(parentPayOpen({status: "pending", expiresAt: now - 1}, now)).toBe(false);
    expect(parentPayOpen({status: "declined", expiresAt: now + 1000}, now)).toBe(false);
    expect(parentPayOpen(null, now)).toBe(false);
  });
  it("shows the child's checkout total only when it is plausible", () => {
    expect(shownEstimate(200, 262)).toBe(262);
    expect(shownEstimate(200, 150)).toBe(200);
    expect(shownEstimate(200, 5000)).toBe(200);
    expect(shownEstimate(200, undefined)).toBe(200);
  });
  it("finds the request behind a parent-paid order only", () => {
    expect(parentPayRequestId({idempotencyKey: "parentpay_pp_0123456789abcdef0123", payerUid: "mom"})).toBe("pp_0123456789abcdef0123");
    expect(parentPayRequestId({idempotencyKey: "parentpay_pp_0123456789abcdef0123"})).toBe("");
    expect(parentPayRequestId({idempotencyKey: "abc123abc123abc123", payerUid: "mom"})).toBe("");
  });
  it("tells the parent the status without the address or delivery code", () => {
    const mirror = orderMirror({status: "Delivered", updatedAt: 5, total: 262, paymentState: "paid", riderName: "Suresh Kumar", etaMax: 35,
      address: {address: "secret"}, deliveryOtpHash: "x"} as unknown as SavrivoOrder);
    expect(mirror).toMatchObject({orderStatus: "Delivered", deliveredAt: 5, riderName: "Suresh", total: 262});
    expect(JSON.stringify(mirror)).not.toMatch(/secret|deliveryOtp/);
  });
  it("pushes the parent only at the steps that matter", () => {
    expect(parentStatusNotice("Out for delivery", "Ravi")?.body).toMatch(/Ravi/);
    expect(parentStatusNotice("Delivered", "")?.title).toBe("Delivered");
    expect(parentStatusNotice("Preparing", "Ravi")).toBeNull();
  });
});

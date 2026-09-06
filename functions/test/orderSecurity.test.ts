import {describe, expect, it} from "vitest";
import {
  deliveryOtpRecoveryAllowed,
  publicOrderContainsPrivateFields,
  stripPrivateOrderFields,
} from "../src/domain/orderSecurity";
import type {SavrivoOrder} from "../src/types";

describe("public order OTP isolation", () => {
  it("does not expose OTP verifier fields in the public SavrivoOrder type", () => {
    const hasHash: "deliveryOtpHash" extends keyof SavrivoOrder ? true : false = false;
    const hasSalt: "deliveryOtpSalt" extends keyof SavrivoOrder ? true : false = false;
    const hasOtp: "deliveryOtp" extends keyof SavrivoOrder ? true : false = false;
    expect({hasHash, hasSalt, hasOtp}).toEqual({hasHash: false, hasSalt: false, hasOtp: false});
  });

  it("strips every known legacy OTP field before a public record is persisted", () => {
    const legacy = {
      id: "SV-LEGACY",
      deliveryOtp: "1234",
      deliveryOtpHash: "a".repeat(64),
      deliveryOtpSalt: "b".repeat(32),
      deliveryOtpVerifier: "c".repeat(64),
    } as unknown as SavrivoOrder;

    expect(publicOrderContainsPrivateFields(legacy)).toBe(true);
    const clean = stripPrivateOrderFields(legacy);
    expect(publicOrderContainsPrivateFields(clean)).toBe(false);
    expect(clean).toEqual({id: "SV-LEGACY"});
  });

  it("restores a delivery OTP only while doorstep verification is actionable", () => {
    expect(deliveryOtpRecoveryAllowed("Out for delivery")).toBe(true);
    expect(deliveryOtpRecoveryAllowed("Near you")).toBe(true);
    expect(deliveryOtpRecoveryAllowed("Arrived")).toBe(true);
    expect(deliveryOtpRecoveryAllowed("Ready for pickup")).toBe(false);
    expect(deliveryOtpRecoveryAllowed("Delivered")).toBe(false);
    expect(deliveryOtpRecoveryAllowed("Cancelled")).toBe(false);
  });
});

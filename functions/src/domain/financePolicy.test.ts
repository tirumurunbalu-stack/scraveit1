import {describe, expect, it} from "vitest";
import {
  checkoutConfiguration,
  normalizeFinancePolicy,
  recommendedFinancePayoutMethod,
  resolveFinancePaymentSelection,
} from "./financePolicy";

describe("finance payment policy", () => {
  it("falls back to COD when every persisted payment method is disabled", () => {
    const policy = normalizeFinancePolicy({
      payments: {
        codEnabled: false,
        upiEnabled: false,
        cardEnabled: false,
        defaultMethod: "upi",
      },
    });

    expect(policy.payments.codEnabled).toBe(true);
    expect(policy.payments.defaultMethod).toBe("cod");
  });

  it("resolves an enabled online method with its configured provider", () => {
    const policy = normalizeFinancePolicy({
      payments: {
        codEnabled: true,
        upiEnabled: true,
        cardEnabled: true,
        defaultMethod: "upi",
        upiProvider: "phonepe",
        cardProvider: "phonepe",
      },
    });

    expect(resolveFinancePaymentSelection(policy, {paymentMethod: "upi"})).toEqual({
      paymentMethod: "upi",
      paymentProvider: "phonepe",
    });
    expect(resolveFinancePaymentSelection(policy, {paymentMethod: "card"})).toEqual({
      paymentMethod: "card",
      paymentProvider: "phonepe",
    });
  });

  it("rejects disabled payment methods explicitly", () => {
    const policy = normalizeFinancePolicy({
      payments: {
        codEnabled: true,
        upiEnabled: false,
        cardEnabled: false,
        defaultMethod: "cod",
      },
    });

    expect(() => resolveFinancePaymentSelection(policy, {paymentMethod: "upi"}))
      .toThrowError("PAYMENT_METHOD_DISABLED:upi");
  });

  it("marks online methods unavailable until the gateway is configured", () => {
    const policy = normalizeFinancePolicy({
      payments: {
        codEnabled: true,
        upiEnabled: true,
        cardEnabled: true,
        defaultMethod: "upi",
      },
    });

    const pendingGateway = checkoutConfiguration(policy, false);
    expect(pendingGateway.methods.cod.available).toBe(true);
    expect(pendingGateway.methods.upi.enabled).toBe(true);
    expect(pendingGateway.methods.upi.available).toBe(false);
    expect(pendingGateway.methods.card.available).toBe(false);

    const readyGateway = checkoutConfiguration(policy, true);
    expect(readyGateway.methods.upi.available).toBe(true);
    expect(readyGateway.methods.card.available).toBe(true);
  });

  it("prefers UPI up to the configured threshold and NEFT above it by default", () => {
    const policy = normalizeFinancePolicy({
      payouts: {
        upiEnabled: true,
        impsEnabled: true,
        neftEnabled: true,
        upiPreferredMaximumPaise: 10_000_000,
        highValuePayoutMethod: "neft",
      },
    });

    expect(recommendedFinancePayoutMethod(policy, 5_000_000)).toBe("upi");
    expect(recommendedFinancePayoutMethod(policy, 10_000_001)).toBe("neft");
  });

  it("falls back safely when the preferred high-value rail is disabled", () => {
    const policy = normalizeFinancePolicy({
      payouts: {
        upiEnabled: false,
        impsEnabled: true,
        neftEnabled: false,
        highValuePayoutMethod: "neft",
      },
    });

    expect(policy.payouts.highValuePayoutMethod).toBe("imps");
    expect(recommendedFinancePayoutMethod(policy, 15_000_000)).toBe("imps");
  });
});

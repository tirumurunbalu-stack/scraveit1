import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}}));

const {orderingAllowed} = await import("../src/services/accountAge");

describe("account age and parent approval", () => {
  it("lets adults and older accounts without a date of birth order", () => {
    expect(orderingAllowed(null).ok).toBe(true);
    expect(orderingAllowed({minor: false, parentStatus: "not-needed"}).ok).toBe(true);
  });
  it("asks a parent before an under-18 can order", () => {
    expect(orderingAllowed({minor: true, parentStatus: "none"}).ok).toBe(false);
    expect(orderingAllowed({minor: true, parentStatus: "pending"}).message).toMatch(/hasn't approved/);
    expect(orderingAllowed({minor: true, parentStatus: "declined"}).ok).toBe(false);
    expect(orderingAllowed({minor: true, parentStatus: "approved"}).ok).toBe(true);
  });
});

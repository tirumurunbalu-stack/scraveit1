import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}};
});

vi.mock("../src/services/authz", () => ({
  authorizeTransition: vi.fn(async () => "staff"),
}));

vi.mock("../src/services/orderProjection", () => ({
  reconcileRestaurantOrderProjection: vi.fn(async () => undefined),
}));

vi.mock("../src/services/workload", () => ({
  reconcileRestaurantWorkload: vi.fn(async () => undefined),
}));

import {firestoreDb} from "../src/admin";
import {deterministicOrderId, legacyOrderId} from "../src/domain/order";
import {claimOrderId} from "../src/services/orders";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const database = firestoreDb as unknown as InMemoryFirestore;

describe("claimOrderId", () => {
  it("gives a new checkout its 15-digit number", async () => {
    const claim = await claimOrderId("customer-a", "key-new-1");
    expect(claim).toEqual({orderId: deterministicOrderId("customer-a", "key-new-1"), existing: null});
    expect(claim.orderId).toMatch(/^[1-9][0-9]{14}$/);
  });

  it("finds the order a retried checkout already placed", async () => {
    const orderId = deterministicOrderId("customer-a", "key-retry-1");
    database.seed(`orders/${orderId}`, {id: orderId, customerId: "customer-a", idempotencyKey: "key-retry-1"});
    const claim = await claimOrderId("customer-a", "key-retry-1");
    expect(claim.orderId).toBe(orderId);
    expect(claim.existing?.id).toBe(orderId);
  });

  it("keeps an SV- order placed before the switch", async () => {
    const orderId = legacyOrderId("customer-a", "key-old-1");
    database.seed(`orders/${orderId}`, {id: orderId, customerId: "customer-a", idempotencyKey: "key-old-1"});
    const claim = await claimOrderId("customer-a", "key-old-1");
    expect(claim.orderId).toBe(orderId);
    expect(claim.existing?.id).toBe(orderId);
  });

  it("moves on when another customer's order holds the number", async () => {
    const taken = deterministicOrderId("customer-a", "key-clash-1");
    database.seed(`orders/${taken}`, {id: taken, customerId: "customer-b", idempotencyKey: "other"});
    const claim = await claimOrderId("customer-a", "key-clash-1");
    expect(claim).toEqual({orderId: deterministicOrderId("customer-a", "key-clash-1", 1), existing: null});
  });
});

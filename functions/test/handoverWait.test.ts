import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}};
});

import {handoverAt} from "../src/services/deliverySettlement";
import type {ActorRole, SavrivoOrder} from "../src/types";

const MIN = 60_000;
function order(handedBy: ActorRole, handedAt: number, readyAt = 10 * MIN): SavrivoOrder {
  return {
    statusHistory: {
      ready: {status: "Ready for pickup", at: readyAt, actorId: "staff-1", actorRole: "staff"},
      handed: {status: "Handed to rider", at: handedAt, actorId: "rider-1", actorRole: handedBy},
    },
  } as unknown as SavrivoOrder;
}

describe("handoverAt (end of rider waiting time)", () => {
  it("keeps the staff handover time as it is", () => {
    expect(handoverAt(order("staff", 30 * MIN))).toBe(30 * MIN);
  });

  it("stops a rider-recorded pickup 2 minutes after the food was ready", () => {
    expect(handoverAt(order("rider", 30 * MIN))).toBe(12 * MIN);
    expect(handoverAt(order("rider", 11 * MIN))).toBe(11 * MIN);
  });

  it("is 0 before any handover", () => {
    expect(handoverAt({statusHistory: {}} as unknown as SavrivoOrder)).toBe(0);
  });
});

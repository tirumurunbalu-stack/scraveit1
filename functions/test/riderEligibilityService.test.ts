import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("firebase-functions", () => ({logger: {warn: vi.fn()}}));
vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  class TrackedFirestore extends InMemoryFirestore {
    collectionsAccessed: string[] = [];
    collection(name: string) {
      this.collectionsAccessed.push(name);
      return super.collection(name);
    }
  }
  return {firestoreDb: new TrackedFirestore()};
});

import {firestoreDb} from "../src/admin";
import {
  refreshRiderDispatchEligibility,
  riderDispatchEligibilityRef,
} from "../src/services/riderEligibility";
import {riderOperationalWorkloadRef} from "../src/services/riderWorkload";
import {riderRef} from "../src/firestorePaths";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

type TrackedFirestore = InMemoryFirestore & {collectionsAccessed: string[]};

const database = firestoreDb as unknown as TrackedFirestore;

const riderId = "rider-1";

function workload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: "functions",
    riderId,
    activeCount: 0,
    workloadEligible: true,
    overflow: false,
    activeOrders: {},
    recentOrders: {},
    updatedAt: 1_799_999_999_999,
    ...overrides,
  };
}

function seedRiderJob(orderId: string, job: Record<string, unknown>): void {
  database.seed(`riderJobs/${riderId}_${orderId}`, {...job, riderId});
}

describe("rider dispatch eligibility projection service", () => {
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
    database.collectionsAccessed.length = 0;
  });

  it("uses the bounded workload head instead of rereading full job history", async () => {
    database.seed(riderRef(database, riderId).path, {status: "approved", fullName: "Rider One"});
    database.seed("riderWallets/rider-1", {codBlocked: false, orderBlocked: false});
    database.seed(riderOperationalWorkloadRef(database, riderId).path, workload());

    const projection = await refreshRiderDispatchEligibility(riderId, 1_800_000_000_000);

    expect(projection).toMatchObject({riderId, riderName: "Rider One", eligible: true, activeLoad: 0});
    expect(database.collectionsAccessed).not.toContain("riderJobs");
    expect(database.read(riderDispatchEligibilityRef(database, riderId).path)).toEqual(projection);
  });

  it("never lets an older trigger invocation overwrite a newer projection", async () => {
    database.seed(riderRef(database, riderId).path, {status: "pending", fullName: "Rider One"});
    database.seed("riderWallets/rider-1", {});
    database.seed(riderOperationalWorkloadRef(database, riderId).path, workload());
    const newer = {
      version: 1,
      riderId,
      riderName: "Rider One",
      approved: true,
      codBlocked: false,
      orderBlocked: false,
      activeLoad: 0,
      workloadEligible: true,
      eligible: true,
      updatedAt: 1_800_000_000_001,
    };
    database.seed(riderDispatchEligibilityRef(database, riderId).path, newer);

    const derivedOlder = await refreshRiderDispatchEligibility(riderId, 1_800_000_000_000);

    expect(derivedOlder.eligible).toBe(false);
    expect(database.read(riderDispatchEligibilityRef(database, riderId).path)).toEqual(newer);
  });

  it("performs one full-history repair only when the workload head is missing", async () => {
    database.seed(riderRef(database, riderId).path, {status: "approved", fullName: "Rider One"});
    database.seed("riderWallets/rider-1", {});
    seedRiderJob("order-1", {status: "active", orderStatus: "Assigned", updatedAt: 1_800_000_000_000});

    const projection = await refreshRiderDispatchEligibility(riderId, 1_800_000_000_000);

    expect(projection).toMatchObject({activeLoad: 1, workloadEligible: false, eligible: false});
    expect(database.read(riderOperationalWorkloadRef(database, riderId).path)).toMatchObject({activeCount: 1, workloadEligible: false});
  });

  it("can force a workload rebuild when the cached workload is stuck busy", async () => {
    database.seed(riderRef(database, riderId).path, {status: "approved", fullName: "Rider One"});
    database.seed("riderWallets/rider-1", {});
    database.seed(riderOperationalWorkloadRef(database, riderId).path, workload({
      activeCount: 1,
      workloadEligible: false,
      activeOrders: {
        "order-1": {orderId: "order-1", status: "active", orderStatus: "Assigned", phase: "pickup", sourceUpdatedAt: 1_800_000_000_000, observedAt: 1_800_000_000_000},
      },
    }));
    seedRiderJob("order-1", {status: "completed", orderStatus: "Delivered", updatedAt: 1_800_000_000_100});

    const projection = await refreshRiderDispatchEligibility(riderId, 1_800_000_000_200, {
      forceWorkloadRebuild: true,
    });

    expect(projection).toMatchObject({activeLoad: 0, workloadEligible: true, eligible: true});
    expect(database.read(riderOperationalWorkloadRef(database, riderId).path)).toMatchObject({activeCount: 0, workloadEligible: true});
  });

  it("rejects an empty rider id before touching the database", async () => {
    await expect(refreshRiderDispatchEligibility(" ")).rejects.toThrow("RIDER_ELIGIBILITY_RIDER_ID_REQUIRED");
    expect(database.collectionsAccessed).toEqual([]);
  });
});

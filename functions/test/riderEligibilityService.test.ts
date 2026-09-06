import {beforeEach, describe, expect, it, vi} from "vitest";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  reads: [] as string[],
  transactions: [] as string[],
}));

vi.mock("firebase-functions", () => ({logger: {warn: vi.fn()}}));
vi.mock("../src/admin", () => ({
  db: {
    ref: (path: string) => ({
      get: async () => {
        memory.reads.push(path);
        return {val: () => memory.values.get(path) ?? null};
      },
      transaction: async (update: (current: unknown) => unknown) => {
        memory.transactions.push(path);
        const next = update(memory.values.get(path) ?? null);
        if (next !== undefined) memory.values.set(path, next);
        return {committed: next !== undefined, snapshot: {val: () => memory.values.get(path) ?? null}};
      },
    }),
  },
}));

import {ROOT} from "../src/config";
import {
  RIDER_DISPATCH_ELIGIBILITY_ROOT,
  refreshRiderDispatchEligibility,
} from "../src/services/riderEligibility";
import {RIDER_OPERATIONAL_WORKLOAD_ROOT} from "../src/services/riderWorkload";

const riderId = "rider-1";
const projectionPath = `${RIDER_DISPATCH_ELIGIBILITY_ROOT}/${riderId}`;
const workloadPath = `${RIDER_OPERATIONAL_WORKLOAD_ROOT}/${riderId}`;

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

describe("rider dispatch eligibility projection service", () => {
  beforeEach(() => {
    memory.values.clear();
    memory.reads.length = 0;
    memory.transactions.length = 0;
  });

  it("uses the bounded workload head instead of rereading full job history", async () => {
    memory.values.set(`${ROOT}/riders/${riderId}`, {status: "approved", fullName: "Rider One"});
    memory.values.set(`${ROOT}/riderWallets/${riderId}`, {codBlocked: false, orderBlocked: false});
    memory.values.set(workloadPath, workload());
    const projection = await refreshRiderDispatchEligibility(riderId, 1_800_000_000_000);
    expect(projection).toMatchObject({riderId, riderName: "Rider One", eligible: true, activeLoad: 0});
    expect(memory.reads.sort()).toEqual([
      workloadPath,
      `${ROOT}/riderWallets/${riderId}`,
      `${ROOT}/riders/${riderId}`,
    ].sort());
    expect(memory.transactions).toEqual([projectionPath]);
    expect(memory.values.get(projectionPath)).toEqual(projection);
  });

  it("never lets an older trigger invocation overwrite a newer projection", async () => {
    memory.values.set(`${ROOT}/riders/${riderId}`, {status: "pending", fullName: "Rider One"});
    memory.values.set(`${ROOT}/riderWallets/${riderId}`, {});
    memory.values.set(workloadPath, workload());
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
    memory.values.set(projectionPath, newer);
    const derivedOlder = await refreshRiderDispatchEligibility(riderId, 1_800_000_000_000);
    expect(derivedOlder.eligible).toBe(false);
    expect(memory.values.get(projectionPath)).toEqual(newer);
  });

  it("performs one full-history repair only when the workload head is missing", async () => {
    memory.values.set(`${ROOT}/riders/${riderId}`, {status: "approved", fullName: "Rider One"});
    memory.values.set(`${ROOT}/riderWallets/${riderId}`, {});
    memory.values.set(`${ROOT}/riderJobs/${riderId}`, {
      "order-1": {status: "active", orderStatus: "Assigned", updatedAt: 1_800_000_000_000},
    });
    const projection = await refreshRiderDispatchEligibility(riderId, 1_800_000_000_000);
    expect(projection).toMatchObject({activeLoad: 1, workloadEligible: false, eligible: false});
    expect(memory.reads).toContain(`${ROOT}/riderJobs/${riderId}`);
    expect(memory.transactions).toEqual([workloadPath, projectionPath]);
    expect(memory.values.get(workloadPath)).toMatchObject({activeCount: 1, workloadEligible: false});
  });

  it("can force a workload rebuild when the cached workload is stuck busy", async () => {
    memory.values.set(`${ROOT}/riders/${riderId}`, {status: "approved", fullName: "Rider One"});
    memory.values.set(`${ROOT}/riderWallets/${riderId}`, {});
    memory.values.set(workloadPath, workload({
      activeCount: 1,
      workloadEligible: false,
      activeOrders: {
        "order-1": {orderId: "order-1", status: "active", orderStatus: "Assigned", phase: "pickup", sourceUpdatedAt: 1_800_000_000_000, observedAt: 1_800_000_000_000},
      },
    }));
    memory.values.set(`${ROOT}/riderJobs/${riderId}`, {
      "order-1": {status: "completed", orderStatus: "Delivered", updatedAt: 1_800_000_000_100},
    });
    const projection = await refreshRiderDispatchEligibility(riderId, 1_800_000_000_200, {
      forceWorkloadRebuild: true,
    });
    expect(projection).toMatchObject({activeLoad: 0, workloadEligible: true, eligible: true});
    expect(memory.reads).toContain(`${ROOT}/riderJobs/${riderId}`);
    expect(memory.transactions).toEqual([workloadPath, projectionPath]);
    expect(memory.values.get(workloadPath)).toMatchObject({activeCount: 0, workloadEligible: true});
  });

  it("rejects an empty rider id before touching the database", async () => {
    await expect(refreshRiderDispatchEligibility(" ")).rejects.toThrow("RIDER_ELIGIBILITY_RIDER_ID_REQUIRED");
    expect(memory.reads).toEqual([]);
    expect(memory.transactions).toEqual([]);
  });
});

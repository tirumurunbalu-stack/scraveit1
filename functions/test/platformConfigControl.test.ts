import type {DecodedIdToken} from "firebase-admin/auth";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }}}));

import {DEFAULT_DISPATCH_POLICY} from "../src/domain/dispatchPolicy";
import {DEFAULT_FINANCE_POLICY} from "../src/domain/financePolicy";
import {
  applyPlatformConfigPatch,
  platformConfigState,
  updatePlatformConfigSchema,
} from "../src/domain/platformConfigControl";
import {
  readPlatformConfiguration,
  updatePlatformConfiguration,
  type PlatformConfigDatabase,
} from "../src/services/platformConfigControl";

class InMemoryDatabase implements PlatformConfigDatabase {
  readonly values = new Map<string, unknown>();
  readonly transactions: string[] = [];

  ref(path: string) {
    return {
      get: async () => ({val: () => this.values.get(path) ?? null}),
      transaction: async (update: (current: unknown) => unknown) => {
        this.transactions.push(path);
        const next = update(this.values.get(path) ?? null);
        if (next === undefined) {
          return {committed: false, snapshot: {val: () => this.values.get(path) ?? null}};
        }
        this.values.set(path, next);
        return {committed: true, snapshot: {val: () => this.values.get(path) ?? null}};
      },
    };
  }
}

function token(role?: string, email = "operator@example.test"): DecodedIdToken {
  return {savrivoRole: role, email} as unknown as DecodedIdToken;
}

const updateInput = {
  operationId: "dispatch-change-001",
  expectedRevision: 0,
  dispatch: {
    mode: "waves" as const,
    initialRadiusKm: 2,
    radiusExpansionKm: 2,
    maxRadiusKm: 12,
    ridersPerWave: 3,
    maxCandidates: 30,
    offerTimeoutSeconds: 45,
  },
  finance: {
    restaurantCommissionBps: 1_750,
    codOutstandingLimitPaise: 250_000,
  },
};

describe("platform configuration control domain", () => {
  it("normalizes missing persisted configuration to safe existing defaults", () => {
    expect(platformConfigState(null)).toEqual({
      dispatch: DEFAULT_DISPATCH_POLICY,
      finance: DEFAULT_FINANCE_POLICY,
      revision: 0,
      updatedAt: 0,
      updatedBy: "",
      updatedByRole: "",
    });
  });

  it("strictly rejects empty, unknown, and out-of-range operator input", () => {
    expect(updatePlatformConfigSchema.safeParse({operationId: "operation-001"}).success).toBe(false);
    expect(updatePlatformConfigSchema.safeParse({
      operationId: "operation-001",
      dispatch: {offerTimeoutSeconds: 4},
    }).success).toBe(false);
    expect(updatePlatformConfigSchema.safeParse({
      operationId: "operation-001",
      finance: {restaurantCommissionBps: 1500, secret: "no"},
    }).success).toBe(false);
  });

  it("rejects unsafe cross-field dispatch combinations", () => {
    const current = platformConfigState(null);
    expect(() => applyPlatformConfigPatch(current, {
      operationId: "operation-001",
      dispatch: {initialRadiusKm: 20, maxRadiusKm: 10},
    })).toThrow("DISPATCH_INITIAL_RADIUS_EXCEEDS_MAXIMUM");
    expect(() => applyPlatformConfigPatch(current, {
      operationId: "operation-002",
      dispatch: {mode: "waves", radiusExpansionKm: 2, maxCandidates: 1, ridersPerWave: 3},
    })).toThrow("DISPATCH_RIDERS_PER_WAVE_EXCEEDS_MAX_CANDIDATES");
    expect(() => applyPlatformConfigPatch(current, {
      operationId: "operation-003",
      dispatch: {ridersPerWave: 2},
    })).toThrow("DISPATCH_SEQUENTIAL_RIDERS_PER_WAVE_MUST_BE_ONE");
  });

  it("merges weekly payout automation updates without dropping sibling payout controls", () => {
    const current = platformConfigState({
      finance: {
        payouts: {
          upiEnabled: true,
          impsEnabled: false,
          neftEnabled: true,
          upiPreferredMaximumPaise: 125_000,
          highValuePayoutMethod: "neft",
          automation: {
            enabled: false,
            cadence: "weekly",
            timezone: "Asia/Kolkata",
            executionDayOfWeek: 1,
            executionMinuteOfDay: 630,
            ridersEnabled: true,
            restaurantsEnabled: true,
            minimumRestaurantSettlementPaise: 50_000,
          },
        },
      },
    });
    const next = applyPlatformConfigPatch(current, {
      operationId: "finance-automation-001",
      finance: {
        payouts: {
          automation: {
            enabled: true,
            executionDayOfWeek: 5,
            executionMinuteOfDay: 12 * 60,
          },
        },
      },
    });
    expect(next.finance.payouts.upiPreferredMaximumPaise).toBe(125_000);
    expect(next.finance.payouts.highValuePayoutMethod).toBe("neft");
    expect(next.finance.payouts.automation).toMatchObject({
      enabled: true,
      executionDayOfWeek: 5,
      executionMinuteOfDay: 12 * 60,
      ridersEnabled: true,
      restaurantsEnabled: true,
      minimumRestaurantSettlementPaise: 50_000,
    });
  });
});

describe("server-authoritative platform configuration service", () => {
  it("requires owner or operations-admin custom claims for reads and writes", async () => {
    const database = new InMemoryDatabase();
    await expect(readPlatformConfiguration(token(undefined), database)).rejects.toMatchObject({code: "permission-denied"});
    await expect(readPlatformConfiguration(token(undefined, "legacy-owner@example.test"), database))
      .rejects.toMatchObject({code: "permission-denied"});
    await expect(updatePlatformConfiguration("legacy-admin-uid", token(undefined), updateInput, database, 1_000))
      .rejects.toMatchObject({code: "permission-denied"});
    expect(database.transactions).toEqual([]);
  });

  it.each(["owner", "ops_admin"])("allows a verified %s claim to read configuration", async (role) => {
    const database = new InMemoryDatabase();
    await expect(readPlatformConfiguration(token(role), database)).resolves.toMatchObject({
      dispatch: DEFAULT_DISPATCH_POLICY,
      finance: DEFAULT_FINANCE_POLICY,
      revision: 0,
    });
  });

  it("atomically updates validated policies, revision metadata, and operation evidence", async () => {
    const database = new InMemoryDatabase();
    const result = await updatePlatformConfiguration("admin-1", token("ops_admin"), updateInput, database, 10_000);
    expect(result).toMatchObject({
      revision: 1,
      updatedAt: 10_000,
      updatedBy: "admin-1",
      updatedByRole: "ops_admin",
      changedSections: ["dispatch", "finance"],
      idempotent: false,
      dispatch: {mode: "waves", ridersPerWave: 3, offerTimeoutSeconds: 45},
      finance: {restaurantCommissionBps: 1_750, codOutstandingLimitPaise: 250_000},
    });
    const stored = database.values.get("feastly/platformConfig") as Record<string, unknown>;
    expect(stored._meta).toMatchObject({revision: 1, updatedBy: "admin-1", lastOperationId: updateInput.operationId});
    expect(Object.keys(stored._operations as Record<string, unknown>)).toHaveLength(1);
    const auditPath = database.transactions.find((path) => path.startsWith("feastly/audit/platform-config-"));
    expect(auditPath).toBeTruthy();
    expect(database.values.get(auditPath!)).toMatchObject({
      action: "platform_config.update",
      actorId: "admin-1",
      actorRole: "ops_admin",
      at: 10_000,
    });
  });

  it("makes an exact retry idempotent without increasing the revision", async () => {
    const database = new InMemoryDatabase();
    await updatePlatformConfiguration("admin-1", token("owner"), updateInput, database, 10_000);
    const retry = await updatePlatformConfiguration("admin-1", token("owner"), updateInput, database, 20_000);
    expect(retry.revision).toBe(1);
    expect(retry.idempotent).toBe(true);
    const stored = database.values.get("feastly/platformConfig") as Record<string, unknown>;
    expect(Object.keys(stored._operations as Record<string, unknown>)).toHaveLength(1);
  });

  it("rejects operation-id reuse with a changed payload or a different actor", async () => {
    const database = new InMemoryDatabase();
    await updatePlatformConfiguration("admin-1", token("owner"), updateInput, database, 10_000);
    await expect(updatePlatformConfiguration("admin-1", token("owner"), {
      ...updateInput,
      finance: {...updateInput.finance, restaurantCommissionBps: 1_900},
    }, database, 20_000)).rejects.toMatchObject({code: "already-exists"});
    await expect(updatePlatformConfiguration("admin-2", token("owner"), updateInput, database, 20_000))
      .rejects.toMatchObject({code: "already-exists"});
  });

  it("protects concurrent administrators with an expected revision", async () => {
    const database = new InMemoryDatabase();
    await updatePlatformConfiguration("admin-1", token("owner"), updateInput, database, 10_000);
    await expect(updatePlatformConfiguration("admin-2", token("ops_admin"), {
      operationId: "finance-change-002",
      expectedRevision: 0,
      finance: {restaurantCommissionBps: 1_600},
    }, database, 20_000)).rejects.toMatchObject({code: "aborted"});
    const current = await readPlatformConfiguration(token("ops_admin"), database);
    expect(current.revision).toBe(1);
    expect(current.finance.restaurantCommissionBps).toBe(1_750);
  });

  it("records a no-op operation without creating a fake configuration revision", async () => {
    const database = new InMemoryDatabase();
    const result = await updatePlatformConfiguration("admin-1", token("owner"), {
      operationId: "finance-noop-001",
      expectedRevision: 0,
      finance: {restaurantCommissionBps: DEFAULT_FINANCE_POLICY.restaurantCommissionBps},
    }, database, 10_000);
    expect(result.revision).toBe(0);
    expect(result.changedSections).toEqual([]);
    const auditPath = database.transactions.find((path) => path.startsWith("feastly/audit/platform-config-"));
    expect(database.values.get(auditPath!)).toMatchObject({action: "platform_config.noop"});
  });
});

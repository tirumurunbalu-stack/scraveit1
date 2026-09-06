import {describe, expect, it} from "vitest";
import {
  buildRiderOperationalWorkload,
  isRiderOperationalWorkloadUsable,
  reduceRiderOperationalWorkload,
  RIDER_OPERATIONAL_WORKLOAD_MAX_RECENT,
} from "../src/domain/riderWorkload";

describe("rider operational workload", () => {
  it("derives idle, active and arrived-at-customer eligibility", () => {
    expect(buildRiderOperationalWorkload("rider-1", {}, 1_000)).toMatchObject({
      activeCount: 0,
      workloadEligible: true,
      overflow: false,
    });
    expect(buildRiderOperationalWorkload("rider-1", {
      one: {status: "active", orderStatus: "Assigned"},
    }, 1_000)).toMatchObject({activeCount: 1, workloadEligible: false});
    expect(buildRiderOperationalWorkload("rider-1", {
      one: {status: "active", orderStatus: "Arrived", phase: "arrived"},
    }, 1_000)).toMatchObject({activeCount: 1, workloadEligible: true});
  });

  it("moves a job from active workload to bounded recent history", () => {
    const active = reduceRiderOperationalWorkload(
      null,
      "rider-1",
      "order-1",
      null,
      {status: "active", orderStatus: "Assigned"},
      2_000,
    );
    const completed = reduceRiderOperationalWorkload(
      active,
      "rider-1",
      "order-1",
      {status: "active", orderStatus: "Assigned"},
      {status: "completed", orderStatus: "Delivered"},
      3_000,
    );
    expect(completed).toMatchObject({activeCount: 0, workloadEligible: true});
    expect(completed.activeOrders["order-1"]).toBeUndefined();
    expect(completed.recentOrders["order-1"]).toMatchObject({orderStatus: "Delivered", terminalAt: 3_000});
  });

  it("ignores an out-of-order job event", () => {
    const newer = reduceRiderOperationalWorkload(
      null,
      "rider-1",
      "order-1",
      null,
      {status: "active", orderStatus: "Assigned", updatedAt: 4_000} as never,
      4_000,
    );
    const stale = reduceRiderOperationalWorkload(
      newer,
      "rider-1",
      "order-1",
      null,
      {status: "completed", orderStatus: "Delivered", updatedAt: 3_000} as never,
      3_000,
    );
    expect(stale).toBe(newer);
  });

  it("caps retained terminal summaries", () => {
    const jobs = Object.fromEntries(Array.from({length: RIDER_OPERATIONAL_WORKLOAD_MAX_RECENT + 10}, (_, index) => [
      `order-${index}`,
      {status: "completed", orderStatus: "Delivered", updatedAt: 10_000 + index},
    ]));
    const result = buildRiderOperationalWorkload("rider-1", jobs, 20_000);
    expect(Object.keys(result.recentOrders)).toHaveLength(RIDER_OPERATIONAL_WORKLOAD_MAX_RECENT);
  });

  it("validates ownership and structure of the private projection", () => {
    const workload = buildRiderOperationalWorkload("rider-1", {}, 1_000);
    expect(isRiderOperationalWorkloadUsable(workload, "rider-1")).toBe(true);
    expect(isRiderOperationalWorkloadUsable(workload, "rider-2")).toBe(false);
  });
});

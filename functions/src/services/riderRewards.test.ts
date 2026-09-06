import {beforeEach, describe, expect, it, vi} from "vitest";

const {notifyRiderRewardUpdateMock} = vi.hoisted(() => ({
  notifyRiderRewardUpdateMock: vi.fn(async () => undefined),
}));

vi.mock("../admin", () => ({
  db: {
    ref: () => {
      throw new Error("TEST_DB_NOT_AVAILABLE");
    },
  },
  messaging: {
    sendEachForMulticast: vi.fn(async () => ({
      successCount: 0,
      failureCount: 0,
      responses: [],
    })),
  },
  storage: {},
}));

vi.mock("./notifications", () => ({
  notifyRiderRewardUpdate: notifyRiderRewardUpdateMock,
}));

import {ROOT} from "../config";
import {persistLedgerJournal, LEDGER_JOURNALS_ROOT} from "./ledger";
import {
  __test,
  evaluateRiderRewardsForDeliveredOrder,
  recordRiderRewardPresenceUpdate,
  refreshRiderRewardProgress,
  RIDER_REWARD_ACTIVITY_EVENTS_ROOT,
  RIDER_REWARD_CAMPAIGNS_ROOT,
  RIDER_REWARD_PROGRESS_ROOT,
  RIDER_REWARD_SESSION_DAYS_ROOT,
  type RiderRewardActivityEvent,
  type RiderRewardCampaign,
  type RiderRewardConditionGroup,
  type RiderRewardConditionSlot,
  type RiderRewardOtherCondition,
  type RiderRewardsDatabase,
} from "./riderRewards";

type QueryState = {
  orderByChild?: string;
  startAt?: string | number;
  endAt?: string | number;
  limitToLast?: number;
  limitToFirst?: number;
};

class MemorySnapshot {
  constructor(private readonly value: unknown) {}

  val(): unknown {
    return deepClone(this.value);
  }
}

class MemoryRef {
  constructor(
    private readonly store: Record<string, unknown>,
    private readonly segments: readonly string[],
    private readonly query: QueryState = {},
  ) {}

  orderByChild(child: string): MemoryRef {
    return new MemoryRef(this.store, this.segments, {...this.query, orderByChild: child});
  }

  startAt(value: string | number): MemoryRef {
    return new MemoryRef(this.store, this.segments, {...this.query, startAt: value});
  }

  endAt(value: string | number): MemoryRef {
    return new MemoryRef(this.store, this.segments, {...this.query, endAt: value});
  }

  limitToLast(limit: number): MemoryRef {
    return new MemoryRef(this.store, this.segments, {...this.query, limitToLast: limit});
  }

  limitToFirst(limit: number): MemoryRef {
    return new MemoryRef(this.store, this.segments, {...this.query, limitToFirst: limit});
  }

  async get(): Promise<{val(): unknown}> {
    const raw = getAtPath(this.store, this.segments);
    return new MemorySnapshot(applyQuery(raw, this.query));
  }

  async set(value: unknown): Promise<void> {
    setAtPath(this.store, this.segments, deepClone(value));
  }

  async transaction(
    update: (current: unknown) => unknown,
  ): Promise<{committed: boolean; snapshot: {val(): unknown}}> {
    const current = getAtPath(this.store, this.segments);
    const next = update(deepClone(current));
    if (next === undefined) {
      return {committed: false, snapshot: new MemorySnapshot(current)};
    }
    setAtPath(this.store, this.segments, deepClone(next));
    return {committed: true, snapshot: new MemorySnapshot(next)};
  }
}

class MemoryDatabase implements RiderRewardsDatabase {
  readonly data: Record<string, unknown>;

  constructor(seed?: Record<string, unknown>) {
    this.data = deepClone(seed ?? {}) as Record<string, unknown>;
  }

  seed(path: string, value: unknown): void {
    setAtPath(this.data, pathSegments(path), deepClone(value));
  }

  ref(path: string): MemoryRef {
    return new MemoryRef(this.data, pathSegments(path));
  }

  read(path: string): unknown {
    return getAtPath(this.data, pathSegments(path));
  }
}

function deepClone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function pathSegments(path: string): string[] {
  return String(path || "").split("/").filter(Boolean);
}

function getAtPath(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return deepClone(current);
}

function setAtPath(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  if (!segments.length) return;
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1] as string] = value as never;
}

function compareScalar(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function applyQuery(value: unknown, query: QueryState): unknown {
  if (!query.orderByChild || !value || typeof value !== "object" || Array.isArray(value)) {
    return deepClone(value);
  }
  let entries = Object.entries(value as Record<string, Record<string, unknown>>)
    .filter(([, item]) => {
      const childValue = item?.[query.orderByChild as string];
      if (query.startAt !== undefined && compareScalar(childValue, query.startAt) < 0) return false;
      if (query.endAt !== undefined && compareScalar(childValue, query.endAt) > 0) return false;
      return true;
    })
    .sort((left, right) => {
      const leftValue = left[1]?.[query.orderByChild as string];
      const rightValue = right[1]?.[query.orderByChild as string];
      return compareScalar(leftValue, rightValue) || left[0].localeCompare(right[0]);
    });
  if (query.limitToFirst !== undefined) entries = entries.slice(0, query.limitToFirst);
  if (query.limitToLast !== undefined) entries = entries.slice(Math.max(0, entries.length - query.limitToLast));
  return Object.fromEntries(entries);
}

function at(localDateTime: string): number {
  return Date.parse(`${localDateTime}+05:30`);
}

function minute(value: string): number {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function slot(
  slotId: string,
  label: string,
  start: string,
  end: string,
  overrides: Partial<RiderRewardConditionSlot> = {},
): RiderRewardConditionSlot {
  return {
    slotId,
    label,
    startMinute: minute(start),
    endMinute: minute(end),
    requiredDurationMinutes: null,
    requiredActiveDurationMinutes: null,
    requiredOnlinePercentage: null,
    minimumOrdersAccepted: null,
    minimumCompletedDeliveries: null,
    offlineToleranceMinutes: 10,
    gracePeriodMinutes: 0,
    overlapMode: "no_double_count",
    disabledCityNames: [],
    ...overrides,
  };
}

function group(
  groupId: string,
  title: string,
  minimumSlotsRequired: number,
  slots: readonly RiderRewardConditionSlot[],
): RiderRewardConditionGroup {
  return {groupId, title, minimumSlotsRequired, slots};
}

function otherCondition(
  conditionId: string,
  type: RiderRewardOtherCondition["type"],
  overrides: Partial<RiderRewardOtherCondition> = {},
): RiderRewardOtherCondition {
  return {
    conditionId,
    type,
    title: conditionId,
    maximumCount: null,
    minimumCount: null,
    minimumPercentage: null,
    maximumMinutes: null,
    minimumMinutes: null,
    minimumRating: null,
    enabled: true,
    ...overrides,
  };
}

function campaign(overrides: Partial<RiderRewardCampaign> = {}): RiderRewardCampaign {
  return {
    schemaVersion: 1,
    campaignId: "weekly-extra",
    internalName: "Weekly Extra",
    title: "Weekly Extra",
    subtitle: "",
    description: "",
    kind: "milestone_bonus",
    displayType: "weekly_incentive",
    section: "special",
    rewardAmountPaise: null,
    milestones: [{target: 2, rewardAmountPaise: 5_000, label: "2 trips"}],
    window: "custom",
    startAt: at("2026-08-26T00:00:00"),
    endAt: at("2026-08-27T00:00:00"),
    eligibleDays: [],
    timeSlots: [],
    cityNames: [],
    zoneNames: [],
    restaurantIds: [],
    riderIds: [],
    minCompletedTrips: null,
    minRating: null,
    firstNCompletedTrips: null,
    orderTotalMinPaise: null,
    rainOnly: false,
    requireDailyLoginSession: false,
    minimumCompletedSessionsPerDay: null,
    conditionGroups: [],
    otherConditions: [],
    milestonePayoutMode: "highest_unlocked",
    timezone: "Asia/Kolkata",
    tripAttribution: "delivered_at",
    allowOverlappingSlotCredit: false,
    eligibleRiderTypes: [],
    vehicleTypes: [],
    minimumAccountAgeDays: null,
    stacking: "stack",
    priority: 100,
    visible: true,
    active: true,
    archived: false,
    updatedAt: at("2026-08-20T12:00:00"),
    updatedBy: "admin_test",
    updatedByRole: "owner",
    lastOperationId: "seed_campaign",
    ...overrides,
  };
}

function riderProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Tirumuru Balaji",
    city: "Naidupeta",
    riderType: "gold",
    vehicleType: "bike",
    rating: 4.8,
    approvedAt: at("2026-01-01T00:00:00"),
    completedTrips: 40,
    ...overrides,
  };
}

function activity(
  eventId: string,
  type: RiderRewardActivityEvent["type"],
  occurredAt: number,
  orderId = "",
): RiderRewardActivityEvent {
  return {
    schemaVersion: 1,
    riderId: "rider_1",
    eventId,
    type,
    occurredAt,
    orderId,
    metadata: {},
  };
}

function sessionEvents(prefix: string, startAt: number, endAt: number, heartbeatMs = 60_000): RiderRewardActivityEvent[] {
  const events = [activity(`${prefix}:online`, "ONLINE", startAt)];
  for (let cursor = startAt + heartbeatMs; cursor < endAt; cursor += heartbeatMs) {
    events.push(activity(`${prefix}:hb:${cursor}`, "HEARTBEAT", cursor));
  }
  events.push(activity(`${prefix}:offline`, "OFFLINE", endAt));
  return events;
}

function deliveryEvents(times: readonly number[], prefix = "order"): RiderRewardActivityEvent[] {
  return times.map((occurredAt, index) =>
    activity(`${prefix}:delivered:${index + 1}`, "ORDER_DELIVERED", occurredAt, `${prefix}_${index + 1}`));
}

function progressSnapshot(input: {
  campaign?: RiderRewardCampaign;
  events?: readonly RiderRewardActivityEvent[];
  referenceAt?: number;
  rider?: Record<string, unknown>;
  sessionKeys?: ReadonlySet<string>;
  completedTripsLifetime?: number;
}) {
  return __test.computeCampaignProgressSnapshot({
    campaign: input.campaign ?? campaign(),
    riderId: "rider_1",
    riderProfile: input.rider ?? riderProfile(),
    referenceAt: input.referenceAt ?? at("2026-08-26T23:00:00"),
    activityEvents: input.events ?? [],
    riderSessionKeys: input.sessionKeys ?? new Set<string>(),
    riderJournals: [],
    completedTripsLifetime: input.completedTripsLifetime ?? 40,
  });
}

describe("rider reward incentives engine", () => {
  beforeEach(() => {
    notifyRiderRewardUpdateMock.mockClear();
  });

  it("requires one completed slot from every login condition group", () => {
    const offer = campaign({
      conditionGroups: [
        group("g1", "Login Group 1", 1, [
          slot("g1_s1", "Breakfast", "06:00", "08:00"),
          slot("g1_s2", "Morning", "08:00", "11:00"),
          slot("g1_s3", "Evening", "16:00", "19:00"),
        ]),
        group("g2", "Login Group 2", 1, [
          slot("g2_s1", "Lunch", "11:00", "16:00"),
          slot("g2_s2", "Night", "19:00", "23:00"),
        ]),
      ],
    });
    const events = [
      ...sessionEvents("morning", at("2026-08-26T08:00:00"), at("2026-08-26T11:00:00")),
      ...sessionEvents("night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
      ...deliveryEvents([at("2026-08-26T12:00:00"), at("2026-08-26T22:30:00")]),
    ];

    const snapshot = progressSnapshot({
      campaign: offer,
      events,
      referenceAt: at("2026-08-26T23:10:00"),
    });

    expect(snapshot.groups.map((entry) => entry.qualified)).toEqual([true, true]);
    expect(snapshot.qualified).toBe(true);
    expect(snapshot.currentUnlockedRewardPaise).toBe(5_000);
  });

  it("does not combine completed slots across separate groups", () => {
    const offer = campaign({
      conditionGroups: [
        group("g1", "Login Group 1", 1, [
          slot("g1_s1", "Breakfast", "06:00", "08:00"),
          slot("g1_s2", "Morning", "08:00", "11:00"),
        ]),
        group("g2", "Login Group 2", 1, [
          slot("g2_s1", "Lunch", "11:00", "16:00"),
        ]),
      ],
    });
    const events = [
      ...sessionEvents("breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
      ...sessionEvents("morning", at("2026-08-26T08:00:00"), at("2026-08-26T11:00:00")),
      ...deliveryEvents([at("2026-08-26T12:00:00"), at("2026-08-26T12:30:00")]),
    ];

    const snapshot = progressSnapshot({
      campaign: offer,
      events,
      referenceAt: at("2026-08-27T00:05:00"),
    });

    expect(snapshot.groups[0]?.qualified).toBe(true);
    expect(snapshot.groups[1]?.qualified).toBe(false);
    expect(snapshot.groups[1]?.status).toBe("FAILED");
    expect(snapshot.qualified).toBe(false);
    expect(snapshot.failed).toBe(true);
  });

  it("stays unqualified when trips are below the milestone", () => {
    const offer = campaign({
      milestones: [{target: 3, rewardAmountPaise: 12_500, label: "3 trips"}],
      conditionGroups: [
        group("g1", "Login Group 1", 1, [slot("g1_s1", "Morning", "08:00", "11:00")]),
        group("g2", "Login Group 2", 1, [slot("g2_s1", "Night", "19:00", "23:00")]),
      ],
    });
    const events = [
      ...sessionEvents("morning", at("2026-08-26T08:00:00"), at("2026-08-26T11:00:00")),
      ...sessionEvents("night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
      ...deliveryEvents([at("2026-08-26T12:00:00"), at("2026-08-26T22:30:00")]),
    ];

    const snapshot = progressSnapshot({
      campaign: offer,
      events,
      referenceAt: at("2026-08-26T23:05:00"),
    });

    expect(snapshot.groups.every((entry) => entry.qualified)).toBe(true);
    expect(snapshot.tripsCompleted).toBe(2);
    expect(snapshot.currentUnlockedRewardPaise).toBe(0);
    expect(snapshot.qualified).toBe(false);
  });

  it("fails when the rejection threshold is broken", () => {
    const offer = campaign({
      conditionGroups: [
        group("g1", "Login Group 1", 1, [slot("g1_s1", "Morning", "08:00", "11:00")]),
      ],
      otherConditions: [
        otherCondition("max_rejections", "max_rejected_orders", {
          title: "Order rejections",
          maximumCount: 1,
        }),
      ],
    });
    const events = [
      ...sessionEvents("morning", at("2026-08-26T08:00:00"), at("2026-08-26T11:00:00")),
      ...deliveryEvents([at("2026-08-26T12:00:00"), at("2026-08-26T13:00:00")]),
      activity("reject:1", "ORDER_REJECTED", at("2026-08-26T14:00:00"), "rj1"),
      activity("reject:2", "ORDER_REJECTED", at("2026-08-26T14:30:00"), "rj2"),
    ];

    const snapshot = progressSnapshot({
      campaign: offer,
      events,
      referenceAt: at("2026-08-27T00:05:00"),
    });

    expect(snapshot.otherConditions[0]?.status).toBe("FAILED");
    expect(snapshot.otherConditions[0]?.message).toBe("2 / Maximum 1");
    expect(snapshot.failed).toBe(true);
  });

  it("counts exact slot boundaries as completed", () => {
    const offer = campaign({
      conditionGroups: [
        group("g1", "Boundary group", 1, [
          slot("boundary", "Exact slot", "08:00", "11:00"),
        ]),
      ],
    });
    const events = sessionEvents("boundary", at("2026-08-26T08:00:00"), at("2026-08-26T11:00:00"));

    const snapshot = progressSnapshot({
      campaign: offer,
      events,
      referenceAt: at("2026-08-26T11:00:00"),
    });
    const slotProgress = snapshot.groups[0]?.slots[0];

    expect(slotProgress?.state).toBe("COMPLETED");
    expect(slotProgress?.qualifiedOnlineMs).toBe(3 * 60 * 60 * 1_000);
    expect(slotProgress?.progressPercent).toBe(100);
  });

  it("does not count a brief 1 AM online burst as a completed midnight slot", () => {
    const offer = campaign({
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-27T06:00:00"),
      conditionGroups: [
        group("g1", "Late night", 1, [
          slot("late", "11 PM – 2 AM", "23:00", "02:00"),
        ]),
      ],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: sessionEvents("brief", at("2026-08-27T01:00:00"), at("2026-08-27T01:10:00")),
      referenceAt: at("2026-08-27T02:05:00"),
    });

    expect(snapshot.groups[0]?.slots[0]?.requiredOnlineMs).toBe(170 * 60 * 1_000);
    expect(snapshot.groups[0]?.slots[0]?.qualifiedOnlineMs).toBe(10 * 60 * 1_000);
    expect(snapshot.groups[0]?.slots[0]?.state).toBe("FAILED");
    expect(snapshot.qualified).toBe(false);
  });

  it("tolerates a single offline gap up to five minutes inside a slot", () => {
    const offer = campaign({
      conditionGroups: [
        group("g1", "Morning group", 1, [
          slot("morning", "Morning", "08:00", "11:00"),
        ]),
      ],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("morning-part-1", at("2026-08-26T08:00:00"), at("2026-08-26T09:00:00")),
        ...sessionEvents("morning-part-2", at("2026-08-26T09:05:00"), at("2026-08-26T11:00:00")),
      ],
      referenceAt: at("2026-08-26T11:00:00"),
    });

    expect(snapshot.groups[0]?.slots[0]?.qualifiedOnlineMs).toBe(175 * 60 * 1_000);
    expect(snapshot.groups[0]?.slots[0]?.requiredOnlineMs).toBe(170 * 60 * 1_000);
    expect(snapshot.groups[0]?.slots[0]?.state).toBe("COMPLETED");
  });

  it("tolerates multiple offline gaps when their total stays within ten minutes", () => {
    const offer = campaign({
      conditionGroups: [
        group("g1", "Morning group", 1, [
          slot("morning", "Morning", "08:00", "11:00"),
        ]),
      ],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("morning-a", at("2026-08-26T08:00:00"), at("2026-08-26T09:00:00")),
        ...sessionEvents("morning-b", at("2026-08-26T09:03:00"), at("2026-08-26T10:00:00")),
        ...sessionEvents("morning-c", at("2026-08-26T10:04:00"), at("2026-08-26T10:30:00")),
        ...sessionEvents("morning-d", at("2026-08-26T10:33:00"), at("2026-08-26T11:00:00")),
      ],
      referenceAt: at("2026-08-26T11:00:00"),
    });

    expect(snapshot.groups[0]?.slots[0]?.qualifiedOnlineMs).toBe(170 * 60 * 1_000);
    expect(snapshot.groups[0]?.slots[0]?.state).toBe("COMPLETED");
  });

  it("fails a slot once cumulative offline gaps exceed ten minutes", () => {
    const offer = campaign({
      conditionGroups: [
        group("g1", "Morning group", 1, [
          slot("morning", "Morning", "08:00", "11:00"),
        ]),
      ],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("morning-a", at("2026-08-26T08:00:00"), at("2026-08-26T09:00:00")),
        ...sessionEvents("morning-b", at("2026-08-26T09:03:00"), at("2026-08-26T10:00:00")),
        ...sessionEvents("morning-c", at("2026-08-26T10:04:00"), at("2026-08-26T10:30:00")),
        ...sessionEvents("morning-d", at("2026-08-26T10:34:00"), at("2026-08-26T11:00:00")),
      ],
      referenceAt: at("2026-08-26T11:00:00"),
    });

    expect(snapshot.groups[0]?.slots[0]?.qualifiedOnlineMs).toBe(169 * 60 * 1_000);
    expect(snapshot.groups[0]?.slots[0]?.requiredOnlineMs).toBe(170 * 60 * 1_000);
    expect(snapshot.groups[0]?.slots[0]?.state).toBe("FAILED");
  });

  it("requires exactly two completed sessions for a daily incentive by default", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Session choices", 1, [
          slot("breakfast", "Breakfast", "06:00", "08:00"),
          slot("lunch", "Lunch", "11:00", "16:00"),
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
        ...sessionEvents("night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
        ...deliveryEvents([at("2026-08-26T21:30:00")]),
      ],
      referenceAt: at("2026-08-26T23:30:00"),
    });

    expect(snapshot.requiredSessionsPerDay).toBe(2);
    expect(snapshot.completedSessionsByDay["2026-08-26"]).toBe(2);
    expect(snapshot.loginSessionRequirementStatus).toBe("ELIGIBLE");
    expect(snapshot.groups[0]?.minimumSlotsRequired).toBe(1);
    expect(snapshot.qualified).toBe(true);
  });

  it("keeps daily login groups independent even when two completed sessions come from the same group", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Login Group 1", 1, [
          slot("breakfast", "Breakfast", "06:00", "08:00"),
          slot("morning", "Morning", "08:00", "11:00"),
        ]),
        group("g2", "Login Group 2", 1, [
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
        ...sessionEvents("morning", at("2026-08-26T08:00:00"), at("2026-08-26T11:00:00")),
        ...deliveryEvents([at("2026-08-26T12:30:00")]),
      ],
      referenceAt: at("2026-08-26T23:30:00"),
    });

    expect(snapshot.requiredSessionsPerDay).toBe(2);
    expect(snapshot.completedSessionsByDay["2026-08-26"]).toBe(2);
    expect(snapshot.loginSessionRequirementStatus).toBe("ELIGIBLE");
    expect(snapshot.groups.map((entry) => entry.qualified)).toEqual([true, false]);
    expect(snapshot.qualified).toBe(false);
    expect(snapshot.failed).toBe(true);
  });

  it("fails a daily incentive when only one valid session is completed", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Session choices", 1, [
          slot("breakfast", "Breakfast", "06:00", "08:00"),
          slot("lunch", "Lunch", "11:00", "16:00"),
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
        ...deliveryEvents([at("2026-08-26T12:30:00")]),
      ],
      referenceAt: at("2026-08-26T23:30:00"),
    });

    expect(snapshot.requiredSessionsPerDay).toBe(2);
    expect(snapshot.completedSessionsByDay["2026-08-26"]).toBe(1);
    expect(snapshot.loginSessionRequirementStatus).toBe("FAILED");
    expect(snapshot.qualified).toBe(false);
    expect(snapshot.failed).toBe(true);
  });

  it("keeps a daily offer eligible when one booked shift is cancelled but the limit is one", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Session choices", 1, [
          slot("breakfast", "Breakfast", "06:00", "08:00"),
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      otherConditions: [
        otherCondition("max_shift_cancel", "max_cancelled_booked_shifts", {
          maximumCount: 1,
        }),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
        ...sessionEvents("night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
        ...deliveryEvents([at("2026-08-26T21:00:00")]),
        activity("shift-cancel-1", "SHIFT_CANCELLED", at("2026-08-26T10:00:00")),
      ],
      referenceAt: at("2026-08-26T23:30:00"),
    });

    expect(snapshot.otherConditions[0]?.message).toBe("1 / Maximum 1");
    expect(snapshot.otherConditions[0]?.status).toBe("ELIGIBLE");
    expect(snapshot.qualified).toBe(true);
  });

  it("fails a daily offer after two booked shift cancellations", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Session choices", 1, [
          slot("breakfast", "Breakfast", "06:00", "08:00"),
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      otherConditions: [
        otherCondition("max_shift_cancel", "max_cancelled_booked_shifts", {
          maximumCount: 1,
        }),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
        ...sessionEvents("night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
        ...deliveryEvents([at("2026-08-26T21:00:00")]),
        activity("shift-cancel-1", "SHIFT_CANCELLED", at("2026-08-26T10:00:00")),
        activity("shift-cancel-2", "SHIFT_CANCELLED", at("2026-08-26T17:00:00")),
      ],
      referenceAt: at("2026-08-26T23:30:00"),
    });

    expect(snapshot.otherConditions[0]?.message).toBe("2 / Maximum 1");
    expect(snapshot.otherConditions[0]?.status).toBe("FAILED");
    expect(snapshot.failed).toBe(true);
  });

  it("allows one incomplete shift when the configured maximum is one", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Session choices", 1, [
          slot("breakfast", "Breakfast", "06:00", "08:00"),
          slot("lunch", "Lunch", "11:00", "16:00"),
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      otherConditions: [
        otherCondition("max_incomplete", "max_incomplete_shifts", {
          maximumCount: 1,
        }),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
        ...sessionEvents("lunch-partial", at("2026-08-26T11:00:00"), at("2026-08-26T12:00:00")),
        ...sessionEvents("night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
        ...deliveryEvents([at("2026-08-26T21:00:00")]),
      ],
      referenceAt: at("2026-08-26T23:30:00"),
    });

    expect(snapshot.otherConditions[0]?.message).toBe("1 / Maximum 1");
    expect(snapshot.otherConditions[0]?.status).toBe("ELIGIBLE");
    expect(snapshot.qualified).toBe(true);
  });

  it("fails a daily offer after two incomplete shifts", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Session choices", 1, [
          slot("breakfast", "Breakfast", "06:00", "08:00"),
          slot("lunch", "Lunch", "11:00", "16:00"),
          slot("evening", "Evening", "16:00", "19:00"),
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      otherConditions: [
        otherCondition("max_incomplete", "max_incomplete_shifts", {
          maximumCount: 1,
        }),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
        ...sessionEvents("lunch-partial", at("2026-08-26T11:00:00"), at("2026-08-26T12:00:00")),
        ...sessionEvents("evening-partial", at("2026-08-26T16:00:00"), at("2026-08-26T17:00:00")),
        ...sessionEvents("night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
        ...deliveryEvents([at("2026-08-26T21:00:00")]),
      ],
      referenceAt: at("2026-08-26T23:30:00"),
    });

    expect(snapshot.otherConditions[0]?.message).toBe("2 / Maximum 1");
    expect(snapshot.otherConditions[0]?.status).toBe("FAILED");
    expect(snapshot.failed).toBe(true);
  });

  it("resets daily session and trip progress when the next service day starts", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T23:59:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Session choices", 1, [
          slot("breakfast", "Breakfast", "06:00", "08:00"),
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("day-1-breakfast", at("2026-08-26T06:00:00"), at("2026-08-26T08:00:00")),
        ...sessionEvents("day-1-night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
        ...deliveryEvents([at("2026-08-26T21:00:00")]),
      ],
      referenceAt: at("2026-08-27T10:00:00"),
    });

    expect(snapshot.completedSessionsByDay["2026-08-27"] ?? 0).toBe(0);
    expect(snapshot.tripsCompleted).toBe(0);
    expect(snapshot.currentUnlockedRewardPaise).toBe(0);
    expect(snapshot.loginSessionRequirementStatus).toBe("FAILED");
  });

  it("supports slot windows that cross midnight", () => {
    const offer = campaign({
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-27T06:00:00"),
      conditionGroups: [
        group("g1", "Late night", 1, [
          slot("night", "Late night", "22:00", "02:00"),
        ]),
      ],
      milestones: [{target: 1, rewardAmountPaise: 8_000, label: "1 trip"}],
    });
    const events = [
      ...sessionEvents("late-night", at("2026-08-26T22:00:00"), at("2026-08-27T02:00:00")),
      ...deliveryEvents([at("2026-08-27T01:30:00")], "night"),
    ];

    const snapshot = progressSnapshot({
      campaign: offer,
      events,
      referenceAt: at("2026-08-27T02:10:00"),
    });

    expect(snapshot.groups[0]?.slots[0]?.state).toBe("COMPLETED");
    expect(snapshot.currentUnlockedRewardPaise).toBe(8_000);
    expect(snapshot.qualified).toBe(true);
  });

  it("deduplicates duplicate delivered order events by order id", () => {
    const offer = campaign({
      milestones: [{target: 2, rewardAmountPaise: 17_500, label: "2 trips"}],
    });
    const deliveredAt = at("2026-08-26T15:00:00");
    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        activity("dup-1", "ORDER_DELIVERED", deliveredAt, "order_same"),
        activity("dup-2", "ORDER_DELIVERED", deliveredAt + 10_000, "order_same"),
      ],
      referenceAt: at("2026-08-26T16:00:00"),
    });

    expect(snapshot.tripsCompleted).toBe(1);
    expect(snapshot.currentUnlockedRewardPaise).toBe(0);
  });

  it("uses the highest unlocked milestone by default", () => {
    const offer = campaign({
      milestones: [
        {target: 18, rewardAmountPaise: 12_500, label: "18 trips"},
        {target: 23, rewardAmountPaise: 17_500, label: "23 trips"},
        {target: 28, rewardAmountPaise: 22_500, label: "28 trips"},
      ],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: deliveryEvents(Array.from({length: 23}, (_, index) => at("2026-08-26T01:00:00") + index * 60_000)),
      referenceAt: at("2026-08-26T23:00:00"),
    });

    expect(snapshot.tripsCompleted).toBe(23);
    expect(snapshot.currentUnlockedRewardPaise).toBe(17_500);
    expect(snapshot.potentialRewardPaise).toBe(22_500);
  });

  it("supports cumulative milestone payout mode", () => {
    const offer = campaign({
      milestonePayoutMode: "cumulative",
      milestones: [
        {target: 8, rewardAmountPaise: 5_000, label: "8 trips"},
        {target: 13, rewardAmountPaise: 8_000, label: "13 trips"},
        {target: 18, rewardAmountPaise: 12_500, label: "18 trips"},
      ],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: deliveryEvents(Array.from({length: 18}, (_, index) => at("2026-08-26T01:00:00") + index * 60_000)),
      referenceAt: at("2026-08-26T23:00:00"),
    });

    expect(snapshot.tripsCompleted).toBe(18);
    expect(snapshot.currentUnlockedRewardPaise).toBe(25_500);
    expect(snapshot.potentialRewardPaise).toBe(25_500);
  });

  it("persists settlement idempotently when the period-close job retries", async () => {
    const db = new MemoryDatabase();
    const offer = campaign({
      milestones: [{target: 2, rewardAmountPaise: 30_000, label: "2 trips"}],
    });
    const snapshot = progressSnapshot({
      campaign: offer,
      events: deliveryEvents([at("2026-08-26T10:00:00"), at("2026-08-26T11:00:00")]),
      referenceAt: at("2026-08-27T00:05:00"),
    });

    const first = await __test.settleSnapshotIfNeeded(offer, snapshot, db, at("2026-08-27T00:05:00"));
    const second = await __test.settleSnapshotIfNeeded(offer, snapshot, db, at("2026-08-27T00:10:00"));
    const journals = db.read(LEDGER_JOURNALS_ROOT) as Record<string, unknown>;

    expect(first?.amountPaise).toBe(30_000);
    expect(second?.journalId).toBe(first?.journalId);
    expect(Object.keys(journals || {})).toHaveLength(1);
  });

  it("cuts online time at heartbeat timeout and restarts after reconnect", () => {
    const intervals = __test.buildOnlineIntervals([
      activity("online-1", "ONLINE", at("2026-08-26T08:00:00")),
      activity("hb-1", "HEARTBEAT", at("2026-08-26T08:01:00")),
      activity("online-2", "ONLINE", at("2026-08-26T08:10:00")),
      activity("hb-2", "HEARTBEAT", at("2026-08-26T08:11:00")),
      activity("offline-2", "OFFLINE", at("2026-08-26T08:20:00")),
    ], at("2026-08-26T08:20:00"));

    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({
      startAt: at("2026-08-26T08:00:00"),
      endAt: at("2026-08-26T08:02:30"),
    });
    expect(intervals[1]).toEqual({
      startAt: at("2026-08-26T08:10:00"),
      endAt: at("2026-08-26T08:12:30"),
    });
  });

  it("records presence with server timestamps instead of trusting the client clock", async () => {
    const db = new MemoryDatabase();
    const recordedAt = at("2026-08-26T09:00:00");

    await recordRiderRewardPresenceUpdate(
      "rider_1",
      null,
      {online: true, updatedAt: 12345, activeOrderId: "order_1", city: "Naidupeta"},
      recordedAt,
      db,
    );

    const event = db.read(`${RIDER_REWARD_ACTIVITY_EVENTS_ROOT}/rider_1/presence:${recordedAt}:online`) as Record<string, unknown>;
    expect(event?.occurredAt).toBe(recordedAt);
    expect(event?.metadata).toEqual({city: "Naidupeta", clientUpdatedAt: 12345});
    expect(db.read(`${RIDER_REWARD_SESSION_DAYS_ROOT}/rider_1/2026-08-26`)).toBeUndefined();
  });

  it("stores a completed session day only after a slot is truly completed", async () => {
    const db = new MemoryDatabase();
    const offer = campaign({
      campaignId: "daily-sessions",
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Login Group 1", 1, [
          slot("morning", "Morning", "08:00", "11:00"),
        ]),
        group("g2", "Login Group 2", 1, [
          slot("night", "Night", "19:00", "23:00"),
        ]),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });
    db.seed(`${RIDER_REWARD_CAMPAIGNS_ROOT}/${offer.campaignId}`, offer);
    db.seed(`${ROOT}/riders/rider_1`, riderProfile());

    await recordRiderRewardPresenceUpdate(
      "rider_1",
      null,
      {online: true, updatedAt: 12345, activeOrderId: "order_1", city: "Naidupeta"},
      at("2026-08-26T08:05:00"),
      db,
    );

    expect(db.read(`${RIDER_REWARD_SESSION_DAYS_ROOT}/rider_1/2026-08-26`)).toBeUndefined();

    for (const event of [
      ...sessionEvents("morning", at("2026-08-26T08:00:00"), at("2026-08-26T11:00:00")),
      ...sessionEvents("night", at("2026-08-26T19:00:00"), at("2026-08-26T23:00:00")),
      ...deliveryEvents([at("2026-08-26T22:30:00")]),
    ]) {
      db.seed(`${RIDER_REWARD_ACTIVITY_EVENTS_ROOT}/rider_1/${event.eventId}`, event);
    }

    await refreshRiderRewardProgress("rider_1", at("2026-08-26T23:10:00"), db);

    expect(db.read(`${RIDER_REWARD_SESSION_DAYS_ROOT}/rider_1/2026-08-26`)).toMatchObject({
      riderId: "rider_1",
      dayKey: "2026-08-26",
      completedSessions: 2,
    });
  });

  it("ignores city-disabled slots even if the rider stays online for the full slot", () => {
    const offer = campaign({
      window: "daily",
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Login Group 1", 1, [
          slot("late", "Late night", "23:00", "02:00", {
            disabledCityNames: ["Naidupeta"],
          }),
        ]),
      ],
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      rider: riderProfile({city: "Naidupeta"}),
      events: sessionEvents("late", at("2026-08-26T23:00:00"), at("2026-08-27T02:00:00")),
      referenceAt: at("2026-08-27T02:05:00"),
    });

    expect(snapshot.groups[0]?.slots).toHaveLength(0);
    expect(snapshot.groups[0]?.qualified).toBe(false);
    expect(snapshot.qualified).toBe(false);
  });

  it("fails the weekly login-session rule when a required day is missed", () => {
    const offer = campaign({
      window: "weekly",
      startAt: at("2026-08-24T00:00:00"),
      endAt: at("2026-08-31T00:00:00"),
      requireDailyLoginSession: true,
      conditionGroups: [
        group("g1", "Weekly session", 1, [
          slot("morning", "Morning", "08:00", "11:00"),
        ]),
      ],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      events: [
        ...sessionEvents("mon", at("2026-08-24T08:00:00"), at("2026-08-24T11:00:00")),
        ...sessionEvents("tue", at("2026-08-25T08:00:00"), at("2026-08-25T11:00:00")),
      ],
      referenceAt: at("2026-08-28T10:00:00"),
    });

    expect(snapshot.status).toBe("FAILED");
    expect(snapshot.qualified).toBe(false);
  });

  it("locks riders outside the configured city", () => {
    const offer = campaign({
      cityNames: ["Nellore"],
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      rider: riderProfile({city: "Naidupeta"}),
      referenceAt: at("2026-08-26T12:00:00"),
    });

    expect(snapshot.status).toBe("locked");
    expect(snapshot.qualified).toBe(false);
  });

  it("marks an offer as expired after its custom window closes", () => {
    const offer = campaign({
      startAt: at("2026-08-26T06:00:00"),
      endAt: at("2026-08-26T12:00:00"),
    });

    const snapshot = progressSnapshot({
      campaign: offer,
      referenceAt: at("2026-08-26T12:05:00"),
    });

    expect(snapshot.status).toBe("EXPIRED");
    expect(snapshot.failed).toBe(false);
  });

  it("does not award a zone-scoped per-order bonus for an out-of-zone delivery", async () => {
    const offer = campaign({
      campaignId: "zone-offer",
      kind: "per_order_bonus",
      rewardAmountPaise: 1_000,
      zoneNames: ["Magunta Layout"],
    });
    const db = new MemoryDatabase();
    db.seed(`${RIDER_REWARD_CAMPAIGNS_ROOT}/${offer.campaignId}`, offer);
    db.seed(`${ROOT}/riders/rider_1`, riderProfile());

    const result = await evaluateRiderRewardsForDeliveredOrder({
      id: "order_1",
      riderId: "rider_1",
      restaurantId: "rest_1",
      status: "Delivered",
      total: 77,
      deliveredAt: at("2026-08-26T18:00:00"),
      updatedAt: at("2026-08-26T18:00:00"),
      address: {area: "Thummur"},
      pricing: {},
      pricingContext: {},
    } as never, db);

    expect(result.awardedJournalIds).toHaveLength(0);
    expect(Object.keys((db.read(LEDGER_JOURNALS_ROOT) as Record<string, unknown>) || {})).toHaveLength(0);
  });

  it("does not award a per-order bonus outside its configured time slot", async () => {
    const offer = campaign({
      campaignId: "lunch-offer",
      kind: "per_order_bonus",
      rewardAmountPaise: 1_000,
      timeSlots: [{label: "Lunch", startMinute: minute("12:00"), endMinute: minute("15:00")}],
    });
    const db = new MemoryDatabase();
    db.seed(`${RIDER_REWARD_CAMPAIGNS_ROOT}/${offer.campaignId}`, offer);
    db.seed(`${ROOT}/riders/rider_1`, riderProfile());

    const result = await evaluateRiderRewardsForDeliveredOrder({
      id: "order_1",
      riderId: "rider_1",
      restaurantId: "rest_1",
      status: "Delivered",
      total: 77,
      deliveredAt: at("2026-08-26T20:30:00"),
      updatedAt: at("2026-08-26T20:30:00"),
      address: {area: "Naidupeta"},
      pricing: {},
      pricingContext: {},
    } as never, db);

    expect(result.awardedJournalIds).toHaveLength(0);
    expect(Object.keys((db.read(LEDGER_JOURNALS_ROOT) as Record<string, unknown>) || {})).toHaveLength(0);
  });

  it("awards an overnight per-order bonus only while its slot is active", async () => {
    const offer = campaign({
      campaignId: "late-night-offer",
      kind: "per_order_bonus",
      rewardAmountPaise: 1_000,
      startAt: at("2026-08-26T00:00:00"),
      endAt: at("2026-08-28T00:00:00"),
      timeSlots: [{label: "Late night", startMinute: minute("23:00"), endMinute: minute("03:00")}],
    });
    const db = new MemoryDatabase();
    db.seed(`${RIDER_REWARD_CAMPAIGNS_ROOT}/${offer.campaignId}`, offer);
    db.seed(`${ROOT}/riders/rider_1`, riderProfile());

    const inside = await evaluateRiderRewardsForDeliveredOrder({
      id: "order_inside",
      riderId: "rider_1",
      restaurantId: "rest_1",
      status: "Delivered",
      total: 77,
      deliveredAt: at("2026-08-27T01:30:00"),
      updatedAt: at("2026-08-27T01:30:00"),
      address: {area: "Naidupeta"},
      pricing: {},
      pricingContext: {},
    } as never, db);

    const outside = await evaluateRiderRewardsForDeliveredOrder({
      id: "order_outside",
      riderId: "rider_1",
      restaurantId: "rest_1",
      status: "Delivered",
      total: 77,
      deliveredAt: at("2026-08-27T04:00:00"),
      updatedAt: at("2026-08-27T04:00:00"),
      address: {area: "Naidupeta"},
      pricing: {},
      pricingContext: {},
    } as never, db);

    expect(inside.awardedJournalIds).toHaveLength(1);
    expect(outside.awardedJournalIds).toHaveLength(0);
  });

  it("nets incentive reversals in the selected-day earnings breakdown", () => {
    const breakdown = __test.dayBreakdownFromHistory({
      history: [
        {
          journalId: "lj_weekly_reward",
          eventType: "rider_incentive",
          occurredAt: at("2026-08-27T20:30:00"),
          earningsMovementPaise: 5_000,
          tipsMovementPaise: 0,
          codMovementPaise: 0,
          category: "other",
        },
        {
          journalId: "lj_wrong_bonus_reversal",
          eventType: "rider_incentive",
          occurredAt: at("2026-08-27T23:10:00"),
          earningsMovementPaise: -1_000,
          tipsMovementPaise: 0,
          codMovementPaise: 0,
          category: "other",
        },
      ],
    } as never, "rider_1", at("2026-08-27T23:15:00"));

    expect(breakdown.selected.incentivePaise).toBe(4_000);
    expect(breakdown.bars.find((bar) => bar.dayKey === "2026-08-27")?.incentivePaise).toBe(4_000);
  });

  it("builds stable notification deduplication keys for retries", () => {
    const offer = campaign({
      conditionGroups: [
        group("g1", "Login Group 1", 1, [slot("g1_s1", "Morning", "08:00", "11:00")]),
      ],
      otherConditions: [
        otherCondition("max_rejections", "max_rejected_orders", {
          title: "Order rejections",
          maximumCount: 1,
        }),
      ],
      milestones: [{target: 1, rewardAmountPaise: 12_500, label: "1 trip"}],
    });
    const snapshot = {
      ...progressSnapshot({
        campaign: offer,
        events: [
          ...sessionEvents("morning", at("2026-08-26T08:00:00"), at("2026-08-26T10:30:00")),
          ...deliveryEvents([at("2026-08-26T09:30:00")]),
          activity("reject:1", "ORDER_REJECTED", at("2026-08-26T11:10:00"), "rj1"),
        ],
        referenceAt: at("2026-08-26T10:30:00"),
      }),
      creditedRewardPaise: 12_500,
      status: "COMPLETED" as const,
      settlementJournalId: "lj_reward_completed",
    };

    const first = __test.rewardProgressNotificationInputs(offer, snapshot);
    const second = __test.rewardProgressNotificationInputs(offer, snapshot);
    const firstKeys = first.map((entry) => entry.deduplicationKey);

    expect(firstKeys).toEqual(second.map((entry) => entry.deduplicationKey));
    expect(firstKeys).toEqual([...new Set(firstKeys)]);
  });

  it("refreshes progress for multiple active offers simultaneously", async () => {
    const dailyOffer = campaign({
      campaignId: "daily-offer",
      title: "Daily Offer",
      milestones: [{target: 1, rewardAmountPaise: 5_000, label: "1 trip"}],
    });
    const weeklyOffer = campaign({
      campaignId: "weekly-offer",
      title: "Weekly Offer",
      window: "weekly",
      startAt: at("2026-08-24T00:00:00"),
      endAt: at("2026-08-31T00:00:00"),
      milestones: [{target: 2, rewardAmountPaise: 8_000, label: "2 trips"}],
    });
    const db = new MemoryDatabase();
    db.seed(`${RIDER_REWARD_CAMPAIGNS_ROOT}/${dailyOffer.campaignId}`, dailyOffer);
    db.seed(`${RIDER_REWARD_CAMPAIGNS_ROOT}/${weeklyOffer.campaignId}`, weeklyOffer);
    db.seed(`${ROOT}/riders/rider_1`, riderProfile());
    db.seed(`${RIDER_REWARD_ACTIVITY_EVENTS_ROOT}/rider_1`, Object.fromEntries([
      ...deliveryEvents([at("2026-08-26T12:00:00"), at("2026-08-26T13:00:00")]).map((entry) => [entry.eventId, entry]),
    ]));

    const snapshots = await refreshRiderRewardProgress("rider_1", at("2026-08-26T23:00:00"), db);
    const stored = db.read(`${RIDER_REWARD_PROGRESS_ROOT}/rider_1`) as Record<string, unknown>;

    expect(snapshots.map((entry) => entry.campaignId).sort()).toEqual(["daily-offer", "weekly-offer"]);
    expect(Object.keys(stored || {}).sort()).toEqual(["daily-offer", "weekly-offer"]);
  });

  it("keeps immutable ledger writes idempotent for the same settlement journal", async () => {
    const db = new MemoryDatabase();
    const journal = __test.buildRiderRewardSettlementJournal({
      campaign: campaign({milestones: [{target: 1, rewardAmountPaise: 300, label: "1 trip"}]}),
      riderId: "rider_1",
      periodKey: "custom:period_1",
      periodStartAt: at("2026-08-26T00:00:00"),
      periodEndAt: at("2026-08-27T00:00:00"),
      amountPaise: 300,
    });

    const first = await persistLedgerJournal(journal, db);
    const second = await persistLedgerJournal(journal, db);

    expect(first.outcome).toBe("insert");
    expect(second.outcome).toBe("idempotent");
    expect(Object.keys((db.read(LEDGER_JOURNALS_ROOT) as Record<string, unknown>) || {})).toHaveLength(1);
  });
});

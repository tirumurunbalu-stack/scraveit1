import {describe, expect, it} from "vitest";
import {
  countAvailableRiders,
  estimateDelivery,
  isPeakHour,
  localHourOfDay,
  type DeliveryEstimateInput,
} from "../src/domain/deliveryEstimate";

/** 13:00 IST on a weekday - inside the lunch peak. */
const LUNCH_PEAK = Date.UTC(2026, 8, 16, 7, 30);
/** 16:00 IST - deliberately outside both rushes. */
const OFF_PEAK = Date.UTC(2026, 8, 16, 10, 30);

function input(overrides: Partial<DeliveryEstimateInput> = {}): DeliveryEstimateInput {
  return {
    kitchenEtaMinMinutes: 15,
    kitchenEtaMaxMinutes: 25,
    distanceKm: 2,
    activeOrders: 0,
    availableRiders: 5,
    occurredAt: OFF_PEAK,
    ...overrides,
  };
}

describe("delivery estimate", () => {
  it("quotes a sane window for an ordinary nearby order", () => {
    const estimate = estimateDelivery(input());
    expect(estimate.etaMinMinutes).toBeGreaterThanOrEqual(10);
    expect(estimate.etaMaxMinutes).toBeGreaterThan(estimate.etaMinMinutes);
    expect(estimate.etaMaxMinutes).toBeLessThanOrEqual(120);
    expect(estimate.confidence).toBe("high");
  });

  it("quotes longer for a distant order than a near one - the original bug", () => {
    const near = estimateDelivery(input({distanceKm: 0.4}));
    const far = estimateDelivery(input({distanceKm: 9}));
    expect(far.etaMinMinutes).toBeGreaterThan(near.etaMinMinutes);
    expect(far.etaMaxMinutes).toBeGreaterThan(near.etaMaxMinutes);
    // 8.6km at 22km/h is ~23 extra minutes of riding; the quote must move by
    // a comparable amount, not a token few minutes.
    expect(far.etaMinMinutes - near.etaMinMinutes).toBeGreaterThanOrEqual(15);
  });

  it("adds time when the kitchen is backed up, and caps how far that can go", () => {
    const calm = estimateDelivery(input({activeOrders: 1}));
    const busy = estimateDelivery(input({activeOrders: 10}));
    const swamped = estimateDelivery(input({activeOrders: 200}));
    expect(busy.etaMinMinutes).toBeGreaterThan(calm.etaMinMinutes);
    expect(busy.basis.kitchenLoadMinutes).toBeCloseTo(10.5, 5);
    expect(swamped.basis.kitchenLoadMinutes).toBe(20);
  });

  it("absorbs the first few concurrent orders without inflating the quote", () => {
    expect(estimateDelivery(input({activeOrders: 3})).basis.kitchenLoadMinutes).toBe(0);
    expect(estimateDelivery(input({activeOrders: 4})).basis.kitchenLoadMinutes).toBeGreaterThan(0);
  });

  it("adds a wait and lowers confidence when no rider is free", () => {
    const withRiders = estimateDelivery(input({availableRiders: 5}));
    const noRiders = estimateDelivery(input({availableRiders: 0}));
    expect(noRiders.etaMinMinutes).toBeGreaterThan(withRiders.etaMinMinutes);
    expect(noRiders.basis.riderWaitMinutes).toBe(8);
    expect(noRiders.confidence).toBe("low");
  });

  it("treats unknown rider availability as unknown, not as zero", () => {
    const unknown = estimateDelivery(input({availableRiders: null}));
    const none = estimateDelivery(input({availableRiders: 0}));
    expect(unknown.basis.riderWaitMinutes).toBe(0);
    expect(unknown.etaMinMinutes).toBeLessThan(none.etaMinMinutes);
    expect(unknown.confidence).toBe("medium");
  });

  it("widens the window rather than staying falsely precise when unsure", () => {
    const confident = estimateDelivery(input({availableRiders: 5}));
    const unsure = estimateDelivery(input({availableRiders: 0}));
    const confidentSpread = confident.etaMaxMinutes - confident.etaMinMinutes;
    const unsureSpread = unsure.etaMaxMinutes - unsure.etaMinMinutes;
    expect(unsureSpread).toBeGreaterThanOrEqual(confidentSpread);
  });

  it("adds peak-hour time at lunch and dinner only", () => {
    expect(isPeakHour(LUNCH_PEAK)).toBe(true);
    expect(isPeakHour(OFF_PEAK)).toBe(false);
    const peak = estimateDelivery(input({occurredAt: LUNCH_PEAK}));
    const quiet = estimateDelivery(input({occurredAt: OFF_PEAK}));
    expect(peak.basis.peakMinutes).toBe(4);
    expect(quiet.basis.peakMinutes).toBe(0);
    expect(peak.etaMaxMinutes).toBeGreaterThanOrEqual(quiet.etaMaxMinutes);
  });

  it("reads the local hour in IST, not UTC", () => {
    // 18:30 UTC is midnight IST the next day.
    expect(localHourOfDay(Date.UTC(2026, 8, 16, 18, 30))).toBeCloseTo(0, 5);
    expect(localHourOfDay(Date.UTC(2026, 8, 16, 7, 30))).toBeCloseTo(13, 5);
  });

  it("never trusts missing or absurd restaurant prep times", () => {
    const missing = estimateDelivery(input({kitchenEtaMinMinutes: undefined, kitchenEtaMaxMinutes: undefined}));
    expect(missing.basis.prepMinMinutes).toBe(15);
    expect(missing.basis.prepMaxMinutes).toBe(25);

    const absurd = estimateDelivery(input({kitchenEtaMinMinutes: 6000, kitchenEtaMaxMinutes: 9000}));
    expect(absurd.basis.prepMaxMinutes).toBeLessThanOrEqual(90);
    expect(absurd.etaMaxMinutes).toBeLessThanOrEqual(120);

    const inverted = estimateDelivery(input({kitchenEtaMinMinutes: 40, kitchenEtaMaxMinutes: 20}));
    expect(inverted.basis.prepMinMinutes).toBeLessThanOrEqual(inverted.basis.prepMaxMinutes);
  });

  it("survives junk input without throwing", () => {
    const junk = estimateDelivery({
      kitchenEtaMinMinutes: "abc",
      kitchenEtaMaxMinutes: null,
      distanceKm: NaN,
      activeOrders: -7,
      availableRiders: 3,
      occurredAt: OFF_PEAK,
    });
    expect(Number.isInteger(junk.etaMinMinutes)).toBe(true);
    expect(junk.etaMinMinutes).toBeGreaterThanOrEqual(10);
    expect(junk.etaMaxMinutes).toBeGreaterThan(junk.etaMinMinutes);
  });

  it("always returns a usable, bounded, 5-minute-aligned window", () => {
    const cases: DeliveryEstimateInput[] = [
      input({distanceKm: 0}),
      input({distanceKm: 40, activeOrders: 50, availableRiders: 0, occurredAt: LUNCH_PEAK}),
      input({kitchenEtaMinMinutes: 90, kitchenEtaMaxMinutes: 90, distanceKm: 30}),
      input({availableRiders: null, activeOrders: 0, distanceKm: 1}),
    ];
    cases.forEach((value, index) => {
      const estimate = estimateDelivery(value);
      expect(estimate.etaMinMinutes % 5, `case ${index} min aligned`).toBe(0);
      expect(estimate.etaMaxMinutes % 5, `case ${index} max aligned`).toBe(0);
      expect(estimate.etaMinMinutes, `case ${index} floor`).toBeGreaterThanOrEqual(10);
      expect(estimate.etaMaxMinutes, `case ${index} ceiling`).toBeLessThanOrEqual(120);
      const spread = estimate.etaMaxMinutes - estimate.etaMinMinutes;
      expect(spread, `case ${index} spread floor`).toBeGreaterThanOrEqual(5);
      expect(spread, `case ${index} spread ceiling`).toBeLessThanOrEqual(20);
    });
  });
});

describe("available rider counting", () => {
  const now = 1_700_000_000_000;
  const fresh = now - 10_000;
  const stale = now - 10 * 60_000;

  it("counts only riders who are online, fresh and unassigned", () => {
    const city = {
      ready: {online: true, updatedAt: fresh},
      alsoReady: {online: true, updatedAt: fresh, activeOrderId: ""},
      offline: {online: false, updatedAt: fresh},
      busy: {online: true, updatedAt: fresh, activeOrderId: "SV-123"},
      stale: {online: true, updatedAt: stale},
    };
    expect(countAvailableRiders(city, now, 90_000)).toBe(2);
  });

  it("returns zero for a missing or malformed city node", () => {
    expect(countAvailableRiders(null, now, 90_000)).toBe(0);
    expect(countAvailableRiders(undefined, now, 90_000)).toBe(0);
    expect(countAvailableRiders("nonsense", now, 90_000)).toBe(0);
    expect(countAvailableRiders([], now, 90_000)).toBe(0);
    expect(countAvailableRiders({bad: 7}, now, 90_000)).toBe(0);
  });

  it("matches the shape of the live availability node", () => {
    const live = {
      YcObtY720UPF7uVcjmbZhk8myN42: {
        accuracy: 12, activeOrderId: "SV-CLAIM-SMOKE-1787422094", city: "Naidupeta",
        lat: 13.9174, lng: 79.8959, online: true, riderId: "YcObtY720UPF7uVcjmbZhk8myN42",
        riderName: "Claim Smoke Rider", updatedAt: fresh,
      },
      D6chawKLYFYexpSzieIG3n2HeBV2: {
        accuracy: 7, city: "Tirupati", lat: 13.9173, lng: 79.8958, online: true,
        riderId: "D6chawKLYFYexpSzieIG3n2HeBV2", riderName: "K. Balaji", updatedAt: fresh,
      },
    };
    // The first rider is already carrying an order; only the second is free.
    expect(countAvailableRiders(live, now, 90_000)).toBe(1);
  });
});

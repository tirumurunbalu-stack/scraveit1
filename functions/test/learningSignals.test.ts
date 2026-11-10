import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
  db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_RTDB"); }},
}));

import {forecastCity, hourOfWeek, suggestedBonus, type DemandEvent} from "../src/domain/demandForecast";
import {complaintTopics, composeSupervisorReport, restaurantInsights, type RestaurantStats} from "../src/domain/insights";
import {
  adDayOf,
  applyInterestEvents,
  attributedClick,
  cityOrderRate,
  foldRankModel,
  matchesAudience,
  orderRate,
  summarizeAdDays,
} from "../src/domain/interests";
import {fitPrepModel, fitTravelModel} from "../src/domain/learnedTimes";
import {tripLinks} from "../src/services/clusterOrders";
import {adSpentSoFar, cappedAdIncrement, deliverySample, wasSponsored} from "../src/services/learning";
import type {SavrivoOrder} from "../src/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Sunday 1 Nov 2026, 00:00 India time.
const NOW = Date.parse("2026-11-01T00:00:00+05:30");

describe("demand forecast", () => {
  /** Eight weeks of a city where Friday 8 pm has 10 orders, other dinners 4, lunches 3. */
  function history(weeks: number, growth = 1): DemandEvent[] {
    const events: DemandEvent[] = [];
    for (let w = 0; w < weeks; w += 1) {
      for (let d = 0; d < 7; d += 1) {
        const dayStart = NOW - (w * 7 + d + 1) * DAY;
        const weekday = (new Date(dayStart + 330 * 60_000).getUTCDay() + 6) % 7;
        const scale = w === 0 ? growth : 1;
        const dinner = Math.round((weekday === 4 ? 10 : 4) * scale), lunch = Math.round(3 * scale);
        for (let i = 0; i < dinner; i += 1) events.push({at: dayStart + 20 * HOUR + i * 60_000, cityKey: "nellore", availableRiders: weekday === 4 ? 0 : 4});
        for (let i = 0; i < lunch; i += 1) events.push({at: dayStart + 13 * HOUR + i * 60_000, cityKey: "nellore", availableRiders: 3});
      }
    }
    return events;
  }

  it("expects the weekly pattern and finds the busiest hours", () => {
    const forecast = forecastCity("nellore", history(8), NOW);
    expect(forecast.next24).toHaveLength(24);
    const dinner = forecast.next24.find((h) => h.label.endsWith("20:00"))!;
    const lunch = forecast.next24.find((h) => h.label.endsWith("13:00"))!;
    // Next 24 h is a Sunday: 4 dinners, 3 lunches.
    expect(dinner.expected).toBeGreaterThan(3.5);
    expect(dinner.expected).toBeLessThan(4.5);
    expect(lunch.expected).toBeGreaterThan(2.5);
    expect(forecast.busiest[0]!.label.endsWith("20:00")).toBe(true);
    expect(forecast.metrics.maeModel).toBeLessThanOrEqual(forecast.metrics.maeNaive + 0.01);
  });

  it("follows a city that is growing", () => {
    const flat = forecastCity("nellore", history(8, 1), NOW).expectedNext24;
    const grown = forecastCity("nellore", history(8, 1.6), NOW).expectedNext24;
    expect(grown).toBeGreaterThan(flat * 1.15);
  });

  it("suggests a bonus only where riders were short and orders are expected", () => {
    expect(suggestedBonus(1, 0.9)).toBe(0);
    expect(suggestedBonus(6, 0.2)).toBe(0);
    expect(suggestedBonus(6, 0.5)).toBeGreaterThanOrEqual(10);
    expect(suggestedBonus(6, 1)).toBe(40);
    // The next 24 h from Friday 00:00: Friday dinner riders were always short.
    const friday = NOW - 2 * DAY;
    const forecast = forecastCity("nellore", history(8), friday - 1);
    expect(forecast.bonuses.some((b) => b.label.includes("20:00") && b.bonusPerOrder > 0)).toBe(true);
    expect(forecast.bonuses.every((b) => !b.label.startsWith("Fri 13"))).toBe(true);
  });

  it("indexes hours of the week in India time", () => {
    expect(hourOfWeek(Date.parse("2026-11-02T00:30:00+05:30"))).toBe(0);
    expect(hourOfWeek(Date.parse("2026-11-01T23:30:00+05:30"))).toBe(167);
  });
});

describe("customer interests", () => {
  it("weighs orders above opens above glances, and fades old taste", () => {
    let profile = applyInterestEvents(null, [
      {t: "imp", rid: "a", ms: 2000, cuisines: ["Pizza"], at: NOW},
      {t: "open", rid: "b", ms: 30_000, cuisines: ["Biryani"], at: NOW},
    ], NOW, [{rid: "c", cuisines: ["Biryani", "Kebabs"], weight: 6}]);
    expect(profile.r.c).toBeGreaterThan(profile.r.b!);
    expect(profile.r.b).toBeGreaterThan(profile.r.a!);
    expect(profile.c.biryani).toBeGreaterThan(profile.c.pizza!);
    const before = profile.r.c!;
    profile = applyInterestEvents(profile, [], NOW + 30 * DAY);
    expect(profile.r.c).toBeCloseTo(before / 2, 2);
  });

  it("matches brand-ad audiences by cuisine", () => {
    const profile = applyInterestEvents(null, [], NOW, [{rid: "r", cuisines: ["Biryani"], weight: 6}]);
    expect(matchesAudience(profile, ["biryani"])).toBe(true);
    expect(matchesAudience(profile, ["Pizza"])).toBe(false);
    expect(matchesAudience(profile, [])).toBe(true);
    expect(matchesAudience(null, ["pizza"])).toBe(false);
  });
});

describe("city ranking (bandit memory)", () => {
  it("folds days with fading weight and keeps an honest prior for new stores", () => {
    const model = foldRankModel(null, [
      {day: NOW - DAY, restaurants: {a: {imp: 100, open: 20, order: 10}, b: {imp: 100, open: 10, order: 1}}},
    ], NOW);
    expect(model.restaurants.a!.imp).toBeCloseTo(93, 0);
    const rate = cityOrderRate(model);
    expect(orderRate(model.restaurants.a, rate)).toBeGreaterThan(orderRate(model.restaurants.b, rate));
    // A store never shown sits at the city's rate: it is explored, not buried.
    expect(orderRate(undefined, rate)).toBeCloseTo(rate, 5);
    const later = foldRankModel(model, [], NOW + 10 * DAY);
    expect(later.restaurants.a!.imp).toBeLessThan(model.restaurants.a!.imp * 0.5);
  });
});

describe("ads", () => {
  it("credits an order to an Ad tap in the 24 hours before it", () => {
    expect(attributedClick([NOW - 2 * HOUR, NOW - 30 * HOUR], NOW)).toBe(NOW - 2 * HOUR);
    expect(attributedClick([NOW - 25 * HOUR], NOW)).toBeNull();
    expect(attributedClick([NOW + HOUR], NOW)).toBeNull();
  });

  it("caps one customer's views and taps per store per day", () => {
    const views = Array.from({length: 30}, (_, i) => ({t: "adImp" as const, rid: "r", ms: 2000, at: NOW + i}));
    const first = cappedAdIncrement(null, views);
    expect(first.inc.impressions).toBe(20);
    expect(first.firstSeen).toBe(true);
    const taps = Array.from({length: 9}, (_, i) => ({t: "adClick" as const, rid: "r", at: NOW + i}));
    const second = cappedAdIncrement(first.next, taps);
    expect(second.inc.clicks).toBe(5);
    expect(second.firstSeen).toBe(false);
    // A flash past the card is not a view.
    expect(cappedAdIncrement(null, [{t: "adImp", rid: "r", ms: 300, at: NOW}]).inc.impressions).toBe(0);
  });

  it("only counts stores that had top placement at that moment", () => {
    const rows = [{restaurantId: "r", startAt: NOW - DAY, endAt: NOW}];
    expect(wasSponsored(rows, "r", NOW - HOUR)).toBe(true);
    expect(wasSponsored(rows, "r", NOW)).toBe(false);
    expect(wasSponsored(rows, "x", NOW - HOUR)).toBe(false);
  });

  it("adds up spend, reach and earnings into a return", () => {
    const days = [
      adDayOf({impressions: 400, reach: 250, clicks: 40, viewMs: 800_000, orders: 12, sales: 4200, deliveredOrders: 10, deliveredSales: 3600, cancelledOrders: 1}, "2026-10-30"),
      adDayOf({impressions: 600, reach: 380, clicks: 50, viewMs: 1_200_000, orders: 15, sales: 5000, deliveredOrders: 15, deliveredSales: 5000}, "2026-10-31"),
    ];
    const r = summarizeAdDays(days, 398);
    expect(r).toMatchObject({impressions: 1000, reach: 630, clicks: 90, orders: 27, earned: 8600, pendingOrders: 1, cancelledOrders: 1, spent: 398});
    expect(r.ctr).toBeCloseTo(0.09, 4);
    expect(r.roas).toBeCloseTo(21.61, 2);
    expect(r.avgViewSeconds).toBe(2);
  });
});

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  const created = NOW;
  return {
    id: "SV1", customerId: "c1", restaurantId: "r1", status: "Delivered", createdAt: created, updatedAt: created + 50 * 60_000,
    deliveredAt: created + 45 * 60_000, etaMin: 30, etaMax: 40,
    items: [{quantity: 2}, {quantity: 1}],
    restaurantLocation: {address: "", lat: 14.44, lng: 79.98},
    address: {lat: 14.46, lng: 79.99},
    etaBasis: {prepMinMinutes: 15, prepMaxMinutes: 25, travelMinutes: 10, kitchenLoadMinutes: 0, riderWaitMinutes: 0, peakMinutes: 0,
      distanceKm: 2.5, activeOrders: 0, availableRiders: 3},
    statusHistory: {
      a: {status: "Accepted", at: created + 60_000, actorId: "x", actorRole: "restaurant"},
      b: {status: "Ready for pickup", at: created + 24 * 60_000, actorId: "x", actorRole: "restaurant"},
      c: {status: "Handed to rider", at: created + 30 * 60_000, actorId: "x", actorRole: "restaurant"},
      d: {status: "Delivered", at: created + 45 * 60_000, actorId: "x", actorRole: "rider"},
    },
    ...overrides,
  } as unknown as SavrivoOrder;
}

describe("training rows from delivered orders", () => {
  it("measures prep from acceptance to Ready, and the ride from handover to the door", () => {
    const sample = deliverySample(order(), "nellore", null)!;
    expect(sample.prepMinutes).toBe(23);
    expect(sample.prepSource).toBe("ready");
    expect(sample.statedPrep).toBe(20);
    expect(sample.travelMinutes).toBe(15);
    expect(sample.items).toBe(3);
    expect(sample.acceptSeconds).toBe(60);
    expect(sample.km).toBeGreaterThan(2);
    expect(sample.actualMinutes).toBe(45);
  });

  it("keeps the restaurant's own stated time when a learned window made the promise", () => {
    const learned = order({etaBasis: {...order().etaBasis!, prepMinMinutes: 25, prepMaxMinutes: 35, statedPrepMinMinutes: 15, statedPrepMaxMinutes: 25}});
    expect(deliverySample(learned, "nellore", null)!.statedPrep).toBe(20);
  });

  it("uses handover as ready time only when the rider had been waiting", () => {
    const noReady = order({statusHistory: Object.fromEntries(Object.entries(order().statusHistory).filter(([k]) => k !== "b"))});
    expect(deliverySample(noReady, "nellore", NOW + 26 * 60_000)!.prepMinutes).toBe(29);
    expect(deliverySample(noReady, "nellore", NOW + 29.5 * 60_000)!.prepMinutes).toBeNull();
    expect(deliverySample(noReady, "nellore", null)!.prepMinutes).toBeNull();
  });

  it("never learns prep time from the Ready mark a rider's parcel-photo pickup writes", () => {
    const history = order().statusHistory;
    const photoReady = order({statusHistory: {...history, b: {...history.b, actorId: "rider_pickup", actorRole: "system"}}});
    const sample = deliverySample(photoReady, "nellore", null)!;
    expect(sample.prepMinutes).toBeNull();
    expect(sample.prepSource).toBeNull();
  });

  it("measures a group order's kitchen from its planned start, and skips detoured rides", () => {
    const grouped = order({kitchenStartAt: NOW + 10 * 60_000,
      clusterTrip: {clusterId: "CL1", orderIds: ["SV1", "SV2"], leadOrderId: "SV1", stop: 0}});
    const sample = deliverySample(grouped, "nellore", null)!;
    expect(sample.prepMinutes).toBe(14);
    expect(sample.travelMinutes).toBeNull();
    expect(sample.sharedTrip).toBe(true);
    const last = order({clusterTrip: {clusterId: "CL1", orderIds: ["SV0", "SV1"], leadOrderId: "SV0", stop: 1}});
    expect(deliverySample(last, "nellore", null)!.travelMinutes).toBe(15);
  });

  it("ignores orders that were not delivered", () => {
    expect(deliverySample(order({status: "Cancelled"}), "nellore", null)).toBeNull();
  });
});

describe("shared rider trips", () => {
  it("links the parts one rider collects, in pickup order", () => {
    const links = tripLinks("CL1", {trips: [{pickups: ["b", "a"], arriveMinutes: 30, longestCarryMinutes: 12}, {pickups: ["c"], arriveMinutes: 28, longestCarryMinutes: 9}]},
      {a: "SVA", b: "SVB", c: "SVC"});
    expect(links.SVB).toEqual({clusterId: "CL1", orderIds: ["SVB", "SVA"], leadOrderId: "SVB", stop: 0});
    expect(links.SVA).toMatchObject({leadOrderId: "SVB", stop: 1});
    expect(links.SVC).toBeUndefined();
  });
});

function stats(overrides: Partial<RestaurantStats> = {}): RestaurantStats {
  return {
    restaurantId: "r1", name: "Biryani House", days: 30, orders: 60, delivered: 50, restaurantRejected: 2, customerCancelled: 1,
    rejectReasons: {}, acceptSecondsMedian: 40, prepSamples: 20, prepMedian: 20, prepStated: 20, lateShare: 0.1,
    ratingAvg: 4.1, ratingCount: 20, complaints: {}, menuItems: 20, itemsWithoutPhoto: 2, itemsUnavailable: 1,
    repeatShare: 0.2, ads: null, ...overrides,
  };
}

describe("restaurant insights", () => {
  it("is quiet for a healthy store", () => {
    expect(restaurantInsights(stats()).filter((i) => i.severity !== "good")).toEqual([]);
  });

  it("explains each problem with its number and a fix, worst first", () => {
    const insights = restaurantInsights(stats({
      restaurantRejected: 12, rejectReasons: {"Item unavailable": 9, "Too busy": 3},
      prepMedian: 31, prepStated: 20, ratingAvg: 3.2, complaints: {cold: 6, late: 2}, itemsWithoutPhoto: 12,
    }));
    expect(insights[0]!.severity).toBe("act");
    const ids = insights.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["rejections", "prep-slow", "rating", "photos"]));
    expect(insights.find((i) => i.id === "rejections")!.detail).toContain("Item unavailable");
    expect(insights.find((i) => i.id === "prep-slow")!.title).toContain("31 min");
    expect(insights.find((i) => i.id === "rating")!.detail).toContain("cold");
  });

  it("praises what works, including ads that pay back", () => {
    const ads = summarizeAdDays([adDayOf({impressions: 900, clicks: 80, orders: 20, deliveredOrders: 20, deliveredSales: 7000}, "d")], 600);
    const insights = restaurantInsights(stats({ratingAvg: 4.6, repeatShare: 0.45, prepMedian: 12, prepStated: 25, ads}));
    expect(insights.filter((i) => i.severity === "good").map((i) => i.id)).toEqual(expect.arrayContaining(["rating-good", "repeat", "prep-fast", "ads-good"]));
  });

  it("reads complaint topics from review text", () => {
    expect(complaintTopics("Food was cold and came late")).toEqual(expect.arrayContaining(["cold", "late"]));
    expect(complaintTopics("Lovely")).toEqual([]);
  });
});

describe("supervisor report", () => {
  it("reports each model's health and turns problems into suggestions", () => {
    const report = composeSupervisorReport({
      now: NOW,
      prep: {...fitPrepModel([], NOW), metrics: {holdout: 4, maeModel: 0, maeBaseline: 0, within5Model: 0, within5Baseline: 0, trainedOn: 12}},
      travel: {...fitTravelModel([], NOW), active: true, metrics: {holdout: 60, maeModel: 3.1, maeBaseline: 5.4, within5Model: 0.8, within5Baseline: 0.55, trainedOn: 400}},
      eta: {delivered: 50, onTime: 34, avgLateMinutes: 9},
      demand: [forecastCity("nellore", [], NOW)],
      ads: {...summarizeAdDays([], 0), stores: 0},
      weakAdStores: [],
      brandAds: [{title: "Cola", impressions: 1000, reach: 600, clicks: 30}],
      clusters: {orders: 6, sharedTrips: 4, bundleOffers: 6, bundleAccepted: 3, avgArrivalGapMinutes: 3.5, etaErrorMinutes: 4},
      restaurants: {total: 20, needingAction: 3, topIssues: [{title: "Food takes longer than stated", stores: 4}]},
      ranking: {impressions: 5000, opens: 600, orders: 120},
    });
    expect(report.health.find((h) => h.area === "Rider travel model")!.status).toBe("good");
    expect(report.health.find((h) => h.area === "Kitchen prep model")!.metric).toContain("Learning");
    expect(report.health.find((h) => h.area === "On-time delivery")!.status).toBe("act");
    const texts = report.suggestions.map((s) => s.text).join(" | ");
    expect(texts).toContain("Ready");
    expect(texts).toContain("extra-pickup bonus");
    expect(texts).toContain("4 stores");
    expect(report.suggestions[0]!.priority).toBe(1);
    expect(report.headline).toContain("need action");
  });
});

describe("ad spend so far", () => {
  const booking = {startDay: "2026-10-30", endDay: "2026-11-02", pricePaise: 400_000, status: "live"};
  it("counts only the days that have started", () => {
    // 1 Nov is the third of four days.
    expect(adSpentSoFar(booking, NOW + HOUR)).toBe(3000);
    expect(adSpentSoFar({...booking, startDay: "2026-11-05", endDay: "2026-11-06"}, NOW)).toBe(0);
    expect(adSpentSoFar({...booking, endDay: "2026-10-31", startDay: "2026-10-30"}, NOW)).toBe(4000);
    expect(adSpentSoFar({...booking, status: "cancelled"}, NOW)).toBe(0);
  });
});

import type {CityDemandForecast} from "./demandForecast";
import type {AdResults} from "./interests";
import type {PrepModel, TravelModel} from "./learnedTimes";

/**
 * Two readers of the same numbers:
 *
 *  - Restaurant insights: each owner gets their own issues, ranked, each with the number behind it
 *    and one concrete fix ("you declined 9 of 60 orders, mostly 'item unavailable': mark items out
 *    of stock instead"). Also what is going well, so the page is not only bad news.
 *  - The weekly supervisor report: every model reports its health here (is it beating the rule it
 *    replaced, how much data it has), together with on-time delivery, ads, group orders and the
 *    most common restaurant issues, and the report turns them into a short list of suggestions for
 *    the Scraveit team. Suggestions only: nothing here changes prices, pay or settings.
 *
 * Plain rules over measured numbers, so every line can be checked and explained.
 */

export type Severity = "act" | "watch" | "good";

export interface Insight {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly action: string;
}

export interface RestaurantStats {
  readonly restaurantId: string;
  readonly name: string;
  readonly days: number;
  readonly orders: number;
  readonly delivered: number;
  readonly restaurantRejected: number;
  readonly customerCancelled: number;
  readonly rejectReasons: Readonly<Record<string, number>>;
  readonly acceptSecondsMedian: number | null;
  readonly prepSamples: number;
  readonly prepMedian: number | null;
  readonly prepStated: number | null;
  readonly lateShare: number | null;
  readonly ratingAvg: number | null;
  readonly ratingCount: number;
  /** Complaint topics from 1-3 star comments, counted. */
  readonly complaints: Readonly<Record<string, number>>;
  readonly menuItems: number;
  readonly itemsWithoutPhoto: number;
  readonly itemsUnavailable: number;
  readonly repeatShare: number | null;
  readonly ads: AdResults | null;
}

const TOPICS: ReadonlyArray<{topic: string; words: RegExp; label: string; fix: string}> = [
  {topic: "cold", words: /\b(cold|not hot|warm|chilled)\b/i, label: "food arrived cold",
    fix: "Pack hot food in sealed containers and only press Ready when the delivery partner is close (the app shows when)."},
  {topic: "late", words: /\b(late|delay|delayed|slow|waited|waiting|long time)\b/i, label: "food was late",
    fix: "Set your prep time to what it really takes, so the promise customers see is one you keep."},
  {topic: "portion", words: /\b(quantity|less|small|portion|tiny|not enough)\b/i, label: "small portions",
    fix: "Show portion size (pieces, grams, serves 1-2) in the dish description."},
  {topic: "taste", words: /\b(taste|tasteless|bland|salty|salt|spicy|oily|oil|stale|bad|worst|raw|burnt)\b/i, label: "taste",
    fix: "Read these reviews with your kitchen team; the dish names in them show where to start."},
  {topic: "missing", words: /\b(missing|wrong|forgot|not received|incomplete)\b/i, label: "missing or wrong items",
    fix: "Check every bag against the order slip before handing it to the delivery partner."},
  {topic: "packing", words: /\b(spill|spilled|leak|leaked|leaking|packing|packaging|messy|broken)\b/i, label: "packaging",
    fix: "Use leak-proof containers for gravies and seal the bag."},
  {topic: "price", words: /\b(price|expensive|costly|overpriced|value)\b/i, label: "price",
    fix: "Add a combo or a smaller portion at a lower price."},
];

/** Topics mentioned in one review comment. */
export function complaintTopics(comment: string): string[] {
  return TOPICS.filter((t) => t.words.test(comment)).map((t) => t.topic);
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const minutes = (value: number) => `${Math.round(value)} min`;

export function restaurantInsights(stats: RestaurantStats): Insight[] {
  const out: Insight[] = [];
  const push = (insight: Insight) => out.push(insight);
  if (stats.orders === 0) {
    push({id: "no-orders", severity: "act", title: `No orders in the last ${stats.days} days`,
      detail: "Customers nearby can't order from you while you are closed or not accepting orders.",
      action: "Stay open at lunch (12–3 pm) and dinner (7–10 pm), when most orders come in, and add photos to your top dishes."});
  }
  if (stats.orders >= 10) {
    const rate = stats.restaurantRejected / stats.orders;
    if (rate >= 0.08) {
      const reason = Object.entries(stats.rejectReasons).sort((a, b) => b[1] - a[1])[0];
      push({id: "rejections", severity: rate >= 0.15 ? "act" : "watch",
        title: `You declined ${stats.restaurantRejected} of ${stats.orders} orders (${pct(rate)})`,
        detail: reason ? `Most often: "${reason[0]}". Declined orders lower your place in the list.` : "Declined orders lower your place in the list.",
        action: "Mark dishes out of stock as soon as they run out, and switch off 'Accepting orders' when the kitchen is full."});
    }
  }
  if (stats.acceptSecondsMedian !== null && stats.orders >= 5 && stats.acceptSecondsMedian >= 120) {
    push({id: "slow-accept", severity: stats.acceptSecondsMedian >= 240 ? "act" : "watch",
      title: `Customers wait ${minutes(stats.acceptSecondsMedian / 60)} for you to accept`,
      detail: "Half your orders took longer than this to be accepted. Some customers cancel while waiting.",
      action: "Keep the order tablet loud and charged, and accept within a minute."});
  }
  if (stats.prepMedian !== null && stats.prepStated !== null && stats.prepSamples >= 8) {
    if (stats.prepMedian > stats.prepStated * 1.25 && stats.prepMedian - stats.prepStated >= 4) {
      push({id: "prep-slow", severity: "act",
        title: `Food takes ${minutes(stats.prepMedian)}, your prep time says ${minutes(stats.prepStated)}`,
        detail: `Measured over ${stats.prepSamples} orders. Customers are promised a time you are not keeping.`,
        action: `Change your prep time to about ${Math.round(stats.prepMedian)} minutes in Settings, or speed up the slowest dishes.`});
    } else if (stats.prepMedian < stats.prepStated * 0.7 && stats.prepStated - stats.prepMedian >= 4) {
      push({id: "prep-fast", severity: "good",
        title: `You're faster than you say: ${minutes(stats.prepMedian)} vs ${minutes(stats.prepStated)}`,
        detail: `Measured over ${stats.prepSamples} orders.`,
        action: `Lower your prep time to about ${Math.round(stats.prepMedian)} minutes: shorter delivery times bring more orders.`});
    }
  }
  if (stats.lateShare !== null && stats.delivered >= 10 && stats.lateShare >= 0.25) {
    push({id: "late", severity: stats.lateShare >= 0.4 ? "act" : "watch",
      title: `${pct(stats.lateShare)} of your deliveries arrived later than promised`,
      detail: "Late food is the top reason for low ratings.",
      action: "Press Ready only when the food is packed, and keep your prep time accurate."});
  }
  if (stats.ratingAvg !== null && stats.ratingCount >= 5) {
    const topics = Object.entries(stats.complaints).sort((a, b) => b[1] - a[1]);
    const first = topics[0] ? TOPICS.find((t) => t.topic === topics[0]![0]) : undefined;
    if (stats.ratingAvg < 3.8) {
      push({id: "rating", severity: stats.ratingAvg < 3.4 ? "act" : "watch",
        title: `Rating ${stats.ratingAvg.toFixed(1)} from ${stats.ratingCount} reviews`,
        detail: first ? `Most common complaint: ${first.label} (${topics[0]![1]} reviews).` : "Read your latest reviews to see why.",
        action: first ? first.fix : "Reply to low reviews and fix what they mention."});
    } else if (first && (topics[0]![1] as number) >= 3) {
      push({id: `complaint-${first.topic}`, severity: "watch",
        title: `${topics[0]![1]} reviews mention ${first.label}`,
        detail: "Your rating is good; this is the one thing customers keep raising.",
        action: first.fix});
    }
    if (stats.ratingAvg >= 4.3) {
      push({id: "rating-good", severity: "good", title: `Customers love you: ${stats.ratingAvg.toFixed(1)}★`,
        detail: `From ${stats.ratingCount} reviews.`, action: "Book a top placement Ad on busy days to reach new customers."});
    }
  }
  if (stats.menuItems >= 5 && stats.itemsWithoutPhoto / stats.menuItems >= 0.3) {
    push({id: "photos", severity: "watch", title: `${stats.itemsWithoutPhoto} of ${stats.menuItems} dishes have no photo`,
      detail: "Dishes with a photo are chosen more often.", action: "Add a clear photo to each of your best sellers first."});
  }
  if (stats.menuItems >= 5 && stats.itemsUnavailable / stats.menuItems >= 0.2) {
    push({id: "unavailable", severity: "watch", title: `${stats.itemsUnavailable} of ${stats.menuItems} dishes are switched off`,
      detail: "A short menu with many 'unavailable' dishes looks closed.", action: "Switch dishes back on, or remove the ones you no longer make."});
  }
  if (stats.ads && stats.ads.spent > 0) {
    if (stats.ads.roas >= 2) {
      push({id: "ads-good", severity: "good", title: `Ads earned ₹${Math.round(stats.ads.earned)} for ₹${Math.round(stats.ads.spent)}`,
        detail: `${stats.ads.orders} orders came from ${stats.ads.clicks} ad taps (${stats.ads.roas}× return).`,
        action: "Keep your Ad on your busiest days."});
    } else if (stats.ads.impressions >= 200 && stats.ads.roas < 1) {
      push({id: "ads-weak", severity: "watch", title: `Ads returned ₹${Math.round(stats.ads.earned)} on ₹${Math.round(stats.ads.spent)}`,
        detail: `${stats.ads.impressions} customers saw your Ad; ${stats.ads.clicks} tapped it.`,
        action: "A bright cover photo and an offer on the card get more taps. Try Ads on Friday–Sunday first."});
    }
  }
  if (stats.repeatShare !== null && stats.delivered >= 10 && stats.repeatShare >= 0.3) {
    push({id: "repeat", severity: "good", title: `${pct(stats.repeatShare)} of your customers came back`,
      detail: "Customers who order again are your best sign of quality.", action: "Thank regulars with a small offer."});
  }
  const order: Record<Severity, number> = {act: 0, watch: 1, good: 2};
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export interface SupervisorInput {
  readonly now: number;
  readonly prep: PrepModel | null;
  readonly travel: TravelModel | null;
  readonly eta: {readonly delivered: number; readonly onTime: number; readonly avgLateMinutes: number};
  readonly demand: readonly CityDemandForecast[];
  readonly ads: AdResults & {readonly stores: number};
  readonly weakAdStores: ReadonlyArray<{name: string; roas: number; spent: number}>;
  readonly brandAds: ReadonlyArray<{title: string; impressions: number; reach: number; clicks: number}>;
  readonly clusters: {readonly orders: number; readonly sharedTrips: number; readonly bundleOffers: number; readonly bundleAccepted: number;
    readonly avgArrivalGapMinutes: number | null; readonly etaErrorMinutes: number | null};
  readonly restaurants: {readonly total: number; readonly needingAction: number; readonly topIssues: ReadonlyArray<{title: string; stores: number}>};
  readonly ranking: {readonly impressions: number; readonly opens: number; readonly orders: number};
}

export interface HealthLine {
  readonly area: string;
  readonly status: Severity;
  readonly metric: string;
  readonly note: string;
}

export interface Suggestion {
  readonly area: string;
  readonly priority: 1 | 2 | 3;
  readonly text: string;
  readonly why: string;
}

export interface SupervisorReport {
  readonly generatedAt: number;
  readonly headline: string;
  readonly health: readonly HealthLine[];
  readonly suggestions: readonly Suggestion[];
}

function modelLine(area: string, model: PrepModel | TravelModel | null, needed: number): HealthLine {
  if (!model) return {area, status: "watch", metric: "Not trained yet", note: "No delivered orders with timings yet."};
  const m = model.metrics;
  if (model.active) {
    return {area, status: "good", metric: `±${m.maeModel} min (rule: ±${m.maeBaseline} min)`,
      note: `Live. ${pct(m.within5Model)} of last week's orders within 5 min, vs ${pct(m.within5Baseline)} for the old rule. Trained on ${m.trainedOn} orders.`};
  }
  if (m.holdout < needed) {
    return {area, status: "watch", metric: `Learning: ${m.trainedOn} orders`,
      note: `Switches on after it beats the current rule on ${needed}+ orders in a week (last week: ${m.holdout}).`};
  }
  return {area, status: "watch", metric: `±${m.maeModel} min vs rule ±${m.maeBaseline} min`,
    note: "Not better than the current rule yet, so the rule stays in use."};
}

export function composeSupervisorReport(input: SupervisorInput): SupervisorReport {
  const health: HealthLine[] = [];
  const suggestions: Suggestion[] = [];
  health.push(modelLine("Kitchen prep model", input.prep, 25));
  health.push(modelLine("Rider travel model", input.travel, 25));
  if (input.prep && !input.prep.active && input.prep.metrics.holdout < 25) {
    suggestions.push({area: "Restaurants", priority: 2,
      text: "Ask restaurants to tap 'Ready' the moment food is packed.",
      why: `The prep model learns from those taps; it has ${input.prep.metrics.trainedOn} timed orders so far.`});
  }

  const onTimeRate = input.eta.delivered ? input.eta.onTime / input.eta.delivered : null;
  health.push(onTimeRate === null ?
    {area: "On-time delivery", status: "watch", metric: "No deliveries this week", note: ""} :
    {area: "On-time delivery", status: onTimeRate >= 0.85 ? "good" : onTimeRate >= 0.7 ? "watch" : "act",
      metric: `${pct(onTimeRate)} of ${input.eta.delivered}`,
      note: input.eta.avgLateMinutes > 0 ? `Late orders were ${Math.round(input.eta.avgLateMinutes)} min late on average.` : "No late orders."});
  if (onTimeRate !== null && onTimeRate < 0.8 && input.eta.delivered >= 10) {
    suggestions.push({area: "Delivery", priority: 1,
      text: input.prep?.active ? "Late orders: check the stores flagged 'Food takes longer than stated' in restaurant insights." :
        "Late orders: the promise still uses restaurants' own prep times. Push restaurants to tap 'Ready' so the prep model can take over.",
      why: `Only ${pct(onTimeRate)} arrived within the promised time this week.`});
  }

  const bonuses = input.demand.flatMap((city) => city.bonuses.map((b) => ({...b, city: city.cityKey})))
    .sort((a, b) => b.shortRate * b.expectedOrders - a.shortRate * a.expectedOrders).slice(0, 3);
  const expected = input.demand.reduce((a, c) => a + c.expectedNext24, 0);
  const backtested = input.demand.filter((c) => c.metrics.hours > 0);
  const maeModel = backtested.length ? backtested.reduce((a, c) => a + c.metrics.maeModel, 0) / backtested.length : null;
  const maeNaive = backtested.length ? backtested.reduce((a, c) => a + c.metrics.maeNaive, 0) / backtested.length : null;
  health.push({area: "Demand forecast", status: maeModel === null ? "watch" : maeModel <= (maeNaive ?? Infinity) ? "good" : "watch",
    metric: `${Math.round(expected)} orders expected in the next 24 h`,
    note: maeModel === null ? "Needs a week of orders to score itself." :
      `Hourly error ${maeModel.toFixed(2)} orders vs ${maeNaive?.toFixed(2)} for 'same hour last week'.`});
  for (const bonus of bonuses) {
    suggestions.push({area: "Riders", priority: 1,
      text: `Offer a ₹${bonus.bonusPerOrder}/delivery peak bonus in ${bonus.city}, ${bonus.label}.`, why: bonus.why});
  }

  if (input.ads.stores > 0) {
    health.push({area: "Restaurant ads", status: input.ads.roas >= 2 ? "good" : input.ads.roas >= 1 ? "watch" : "act",
      metric: `₹${Math.round(input.ads.earned)} earned on ₹${Math.round(input.ads.spent)} (${input.ads.roas}×)`,
      note: `${input.ads.stores} stores · ${input.ads.impressions} impressions · ${input.ads.clicks} taps · ${input.ads.orders} orders.`});
    for (const store of input.weakAdStores.slice(0, 2)) {
      suggestions.push({area: "Ads", priority: 2, text: `Help ${store.name} improve its Ad card (cover photo, an offer).`,
        why: `It returned ${store.roas}× on ₹${Math.round(store.spent)}.`});
    }
  } else {
    health.push({area: "Restaurant ads", status: "watch", metric: "No ads running", note: "Restaurants can book top placement in their app."});
    suggestions.push({area: "Ads", priority: 3, text: "Offer the top-rated restaurants a first Ad day free to show results.",
      why: "No store ran an Ad this period; results pages sell the next booking."});
  }
  for (const ad of input.brandAds.slice(0, 3)) {
    const ctr = ad.impressions ? ad.clicks / ad.impressions : 0;
    health.push({area: `Brand ad: ${ad.title}`, status: ctr >= 0.02 ? "good" : "watch",
      metric: `${ad.reach} people reached · ${pct(ctr)} tapped`, note: `${ad.impressions} impressions.`});
  }

  if (input.clusters.orders > 0) {
    const acceptRate = input.clusters.bundleOffers ? input.clusters.bundleAccepted / input.clusters.bundleOffers : null;
    health.push({area: "Group orders", status: acceptRate === null || acceptRate >= 0.7 ? "good" : "watch",
      metric: `${input.clusters.orders} group orders · ${input.clusters.sharedTrips} shared-rider trips`,
      note: [input.clusters.avgArrivalGapMinutes !== null ? `Food from different restaurants arrived ${input.clusters.avgArrivalGapMinutes} min apart on average.` : "",
        acceptRate !== null ? `Riders took ${pct(acceptRate)} of extra pickups offered.` : ""].filter(Boolean).join(" ")});
    if (acceptRate !== null && acceptRate < 0.7 && input.clusters.bundleOffers >= 5) {
      suggestions.push({area: "Riders", priority: 2, text: "Add a small extra-pickup bonus for shared-rider trips.",
        why: `Riders turned down ${pct(1 - acceptRate)} of second pickups, so those orders went to a second rider.`});
    }
  }

  health.push({area: "Restaurants", status: input.restaurants.needingAction === 0 ? "good" : "watch",
    metric: `${input.restaurants.needingAction} of ${input.restaurants.total} need action`,
    note: input.restaurants.topIssues.slice(0, 3).map((i) => `${i.title} (${i.stores})`).join(" · ")});
  for (const issue of input.restaurants.topIssues.slice(0, 2)) {
    if (issue.stores >= 2) {
      suggestions.push({area: "Restaurants", priority: 2, text: `Call the ${issue.stores} stores flagged: ${issue.title.toLowerCase()}.`,
        why: "Their insights page already shows them the fix; a call gets it done."});
    }
  }

  const r = input.ranking;
  if (r.impressions > 0) {
    health.push({area: "Customer ranking (bandit)", status: "good",
      metric: `${pct(r.opens / r.impressions)} of cards opened · ${(r.orders / r.impressions * 100).toFixed(1)}% ordered`,
      note: `${r.impressions} restaurant cards seen this week.`});
  }

  const acts = health.filter((h) => h.status === "act").length;
  const headline = acts ? `${acts} area${acts > 1 ? "s" : ""} need action this week` :
    suggestions.length ? "Running well; a few improvements below" : "Running well";
  return {
    generatedAt: input.now,
    headline,
    health,
    suggestions: suggestions.sort((a, b) => a.priority - b.priority).slice(0, 8),
  };
}

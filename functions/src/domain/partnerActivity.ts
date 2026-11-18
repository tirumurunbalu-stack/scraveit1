/**
 * Turns a delivery partner's positions for a day (about every 15 seconds while online; older days
 * once a minute) into what the founder asked to watch: online time, waits at restaurants, rides
 * to the drop, drops and idle time.
 *
 * Other apps' orders are invisible to us, so this reads them from movement:
 * - a stop is 1+ minute within 60 m (at least 3 positions); GPS drift while standing still can split
 *   one wait in pieces, so stops within 100 m that follow each other within 2 minutes are one stop;
 * - a stop at a Scraveit store is a restaurant; so is a spot the partner stops at again later the
 *   same day (after riding 300+ m away) when one of those visits lasted 3+ minutes (restaurants repeat, customers' doors
 *   rarely do, and a red light seldom holds anyone 3 minutes);
 * - the next stop of up to 8 minutes after a restaurant is a drop;
 * - any other stop of 10+ minutes is idle;
 * - the spot where the day starts (often home) is never a restaurant: time there is idle or a stop;
 * - home (founder, 18 Nov 2026: partners stay online all day, so home time must not look like work)
 *   is the spot where most of the night (22:00–07:00) is spent. Stops within 100 m of it are "home":
 *   kept out of idle and out of "out working" time, and their position is not sent to the page.
 */

export interface TrailPoint {sec: number; lat: number; lng: number; job: boolean}
export interface StorePlace {name: string; lat: number; lng: number}
export type StopKind = "restaurant" | "drop" | "idle" | "stop" | "home";
export interface HomePlace {lat: number; lng: number}
export interface Stop {
  start: number; end: number; minutes: number; lat: number; lng: number;
  kind: StopKind; place: string; repeat: boolean; scraveitOrder: boolean;
}
export interface Trip {pickupAt: number; waitMinutes: number; rideMinutes: number; dropMinutes: number; place: string}
export interface DayActivity {
  onlineMinutes: number; movingMinutes: number; restaurantWaitMinutes: number; dropMinutes: number;
  idleMinutes: number; otherStopMinutes: number; homeMinutes: number; outMinutes: number; home: HomePlace | null; trips: Trip[]; stops: Stop[];
  firstSeen: number | null; lastSeen: number | null; offlineGaps: Array<{start: number; end: number}>;
}

const STOP_RADIUS_M = 60;
const STOP_MIN_SEC = 60;
const STOP_MIN_POINTS = 3;
const SAME_PLACE_M = 70;
const STORE_RADIUS_M = 100;
const REPEAT_ANCHOR_SEC = 180;
const DROP_MAX_SEC = 8 * 60;
const IDLE_MIN_SEC = 10 * 60;
const GAP_SEC = 180;
const MERGE_M = 100;
const MERGE_SEC = 120;
const LEFT_M = 300;
const HOME_RADIUS_M = 100;
const NIGHT_END_SEC = 7 * 3600;
const NIGHT_START_SEC = 22 * 3600;
const HOME_MIN_NIGHT_SEC = 60 * 60;
const STEP_CAP_SEC = 60;

export function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6371000, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLng = (bLng - aLng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)));
}

const mins = (sec: number) => Math.round(sec / 60);
const minuteOf = (sec: number) => Math.floor(sec / 60);

const cleanPoints = (input: TrailPoint[]) =>
  input.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.sec)).sort((a, b) => a.sec - b.sec);

/**
 * Where the partner spends the night: the spot holding the most night-time positions (22:00–07:00),
 * if that adds up to an hour or more. null when the day has no long night stay.
 */
export function nightHome(input: TrailPoint[]): HomePlace | null {
  const pts = cleanPoints(input);
  const night: Array<{p: TrailPoint; w: number}> = [];
  pts.forEach((p, i) => {
    if (p.sec >= NIGHT_END_SEC && p.sec < NIGHT_START_SEC) return;
    const next = pts[i + 1];
    night.push({p, w: next && next.sec - p.sec <= GAP_SEC ? Math.min(STEP_CAP_SEC, next.sec - p.sec) : STEP_CAP_SEC});
  });
  if (!night.length) return null;
  const step = Math.max(1, Math.ceil(night.length / 400));
  let best: {lat: number; lng: number; sec: number} | null = null;
  for (let i = 0; i < night.length; i += step) {
    const c = (night[i] as {p: TrailPoint}).p;
    let sec = 0, lat = 0, lng = 0, n = 0;
    for (const {p, w} of night) {
      if (metres(c.lat, c.lng, p.lat, p.lng) <= HOME_RADIUS_M) { sec += w; lat += p.lat; lng += p.lng; n += 1; }
    }
    if (!best || sec > best.sec) best = {lat: lat / n, lng: lng / n, sec};
  }
  return best && best.sec >= HOME_MIN_NIGHT_SEC ? {lat: best.lat, lng: best.lng} : null;
}

/** home: the saved home; undefined = learn it from this day's night; null = no home. */
export function summarizeDay(input: TrailPoint[], stores: StorePlace[], savedHome?: HomePlace | null): DayActivity {
  const points = cleanPoints(input);
  const homePlace = savedHome === undefined ? nightHome(points) : savedHome;
  // Each position stands for the time until the next one (capped, so a gap is not counted as online).
  const weight = points.map((p, i) => {
    const next = points[i + 1], prev = points[i - 1];
    if (next && next.sec - p.sec <= GAP_SEC) return Math.min(STEP_CAP_SEC, next.sec - p.sec);
    return prev && p.sec - prev.sec <= GAP_SEC ? Math.min(STEP_CAP_SEC, p.sec - prev.sec) : STEP_CAP_SEC;
  });
  const offlineGaps: Array<{start: number; end: number}> = [];
  const runs: number[][] = [];
  let run: number[] = [];
  let sumLat = 0, sumLng = 0;
  points.forEach((p, i) => {
    const prev = points[i - 1];
    const gap = prev ? p.sec - prev.sec > GAP_SEC : false;
    if (gap && prev) offlineGaps.push({start: minuteOf(prev.sec) + 1, end: Math.max(minuteOf(prev.sec) + 1, minuteOf(p.sec) - 1)});
    const near = run.length > 0 && metres(sumLat / run.length, sumLng / run.length, p.lat, p.lng) <= STOP_RADIUS_M;
    if (run.length && (gap || !near)) { runs.push(run); run = []; sumLat = 0; sumLng = 0; }
    run.push(i); sumLat += p.lat; sumLng += p.lng;
  });
  if (run.length) runs.push(run);

  interface RawStop {startSec: number; endSec: number; seconds: number; lat: number; lng: number; n: number; place: string; job: boolean; firstIdx: number; lastIdx: number}
  const raw: RawStop[] = [];
  let movingSec = 0, movedSinceStop = 0;
  for (const r of runs) {
    const pts = r.map((i) => points[i] as TrailPoint);
    const first = pts[0] as TrailPoint, last = pts[pts.length - 1] as TrailPoint;
    const seconds = r.reduce((s, i) => s + (weight[i] ?? 0), 0);
    if (pts.length < STOP_MIN_POINTS || last.sec - first.sec < STOP_MIN_SEC) { movingSec += seconds; movedSinceStop += seconds; continue; }
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    const job = pts.some((p) => p.job), prev = raw[raw.length - 1];
    if (prev && first.sec - prev.endSec <= MERGE_SEC && metres(prev.lat, prev.lng, lat, lng) <= MERGE_M) {
      // He did not really leave: GPS drift split one stop. Join them, with the drift time in between.
      movingSec -= movedSinceStop;
      prev.lat = (prev.lat * prev.n + lat * pts.length) / (prev.n + pts.length);
      prev.lng = (prev.lng * prev.n + lng * pts.length) / (prev.n + pts.length);
      prev.n += pts.length; prev.endSec = last.sec; prev.seconds += movedSinceStop + seconds; prev.job ||= job; prev.lastIdx = r[r.length - 1] as number;
    } else {
      raw.push({startSec: first.sec, endSec: last.sec, seconds, lat, lng, n: pts.length, place: "", job, firstIdx: r[0] as number, lastIdx: r[r.length - 1] as number});
    }
    movedSinceStop = 0;
  }
  for (const s of raw) {
    let best = STORE_RADIUS_M;
    for (const st of stores) {
      const d = metres(s.lat, s.lng, st.lat, st.lng);
      if (d <= best) { best = d; s.place = st.name; }
    }
  }
  // Between two visits to the same spot he must have ridden away (300+ m), or it is the same visit.
  const leftBetween = (a: RawStop, b: RawStop) => {
    const [x, y] = a.startSec < b.startSec ? [a, b] : [b, a];
    for (let i = x.lastIdx + 1; i < y.firstIdx; i++) {
      const p = points[i] as TrailPoint;
      if (metres(x.lat, x.lng, p.lat, p.lng) > LEFT_M) return true;
    }
    return false;
  };
  const sameSpot = (a: RawStop, b: RawStop) => a !== b && Math.abs(a.startSec - b.startSec) > 15 * 60 && metres(a.lat, a.lng, b.lat, b.lng) <= SAME_PLACE_M && leftBetween(a, b);
  const startStop = raw[0] && points[0] && raw[0].startSec - points[0].sec <= 120 ? raw[0] : null;
  const startIsStore = !!startStop && !!startStop.place;
  const atStart = (s: RawStop) => !!startStop && !startIsStore && metres(s.lat, s.lng, startStop.lat, startStop.lng) <= SAME_PLACE_M;
  const atHome = (s: RawStop) => !!homePlace && !s.place && metres(s.lat, s.lng, homePlace.lat, homePlace.lng) <= HOME_RADIUS_M;
  const kinds: StopKind[] = [];
  const repeats: boolean[] = [];
  const home: boolean[] = [];
  raw.forEach((s, i) => {
    home.push(atStart(s) && !s.place);
    if (atHome(s)) {
      repeats.push(false);
      kinds.push("home");
      return;
    }
    if (home[i]) {
      repeats.push(false);
      kinds.push(s.seconds >= IDLE_MIN_SEC ? "idle" : "stop");
      return;
    }
    const others = raw.filter((o) => sameSpot(o, s) && !atStart(o) && !atHome(o));
    const repeat = others.length > 0 && [s, ...others].some((v) => v.seconds >= REPEAT_ANCHOR_SEC);
    repeats.push(repeat);
    const before = i > 0 ? kinds[i - 1] : undefined;
    if (s.place || repeat) kinds.push("restaurant");
    else if (before === "restaurant" && s.seconds <= DROP_MAX_SEC) kinds.push("drop");
    else kinds.push(s.seconds >= IDLE_MIN_SEC ? "idle" : "stop");
  });
  const stops: Stop[] = raw.map((s, i) => ({
    start: minuteOf(s.startSec), end: minuteOf(s.endSec), minutes: Math.max(1, mins(s.seconds)), lat: s.lat, lng: s.lng,
    kind: kinds[i] ?? "stop", place: kinds[i] === "home" ? "Home" : home[i] ? "Where he went online" : s.place, repeat: repeats[i] ?? false, scraveitOrder: s.job,
  }));
  const trips: Trip[] = [];
  for (let i = 0; i < raw.length - 1; i++) {
    const a = raw[i] as RawStop, b = raw[i + 1] as RawStop;
    if (kinds[i] === "restaurant" && kinds[i + 1] === "drop") {
      trips.push({pickupAt: minuteOf(a.startSec), waitMinutes: Math.max(1, mins(a.seconds)), rideMinutes: mins(Math.max(0, b.startSec - a.endSec)), dropMinutes: Math.max(1, mins(b.seconds)), place: a.place});
    }
  }
  const total = (k: StopKind) => mins(raw.reduce((n, s, i) => n + (kinds[i] === k ? s.seconds : 0), 0));
  const first = points[0], last = points[points.length - 1];
  const onlineMinutes = mins(weight.reduce((a, b) => a + b, 0)), homeMinutes = total("home");
  return {
    onlineMinutes, movingMinutes: mins(movingSec), homeMinutes, outMinutes: Math.max(0, onlineMinutes - homeMinutes), home: homePlace,
    restaurantWaitMinutes: total("restaurant"), dropMinutes: total("drop"), idleMinutes: total("idle"), otherStopMinutes: total("stop"),
    trips, stops, firstSeen: first ? minuteOf(first.sec) : null, lastSeen: last ? minuteOf(last.sec) : null, offlineGaps,
  };
}

/** The totals for one day, without any position. */
export function daySummary(a: DayActivity) {
  const avg = (k: "waitMinutes" | "rideMinutes") => a.trips.length ? Math.round(a.trips.reduce((s, t) => s + t[k], 0) / a.trips.length) : null;
  return {
    onlineMinutes: a.onlineMinutes, outMinutes: a.outMinutes, homeMinutes: a.homeMinutes, movingMinutes: a.movingMinutes, trips: a.trips.length,
    restaurantWaitMinutes: a.restaurantWaitMinutes, avgWaitMinutes: avg("waitMinutes"), avgRideMinutes: avg("rideMinutes"),
    dropMinutes: a.dropMinutes, idleMinutes: a.idleMinutes, otherStopMinutes: a.otherStopMinutes, stops: a.stops.length,
    gaps: a.offlineGaps.length, firstSeen: a.firstSeen, lastSeen: a.lastSeen,
  };
}

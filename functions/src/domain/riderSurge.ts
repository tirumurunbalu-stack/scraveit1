/**
 * Rider surge fee: charged when most of the online riders around the restaurant
 * (the hexagons within SURGE_RINGS rings, services/riderSurgeMap.ts) are already
 * carrying an order, so a new order is likely to wait. The rider who delivers
 * it gets a share (EconomicsPolicy.riderSurgeShareBps); Scraveit keeps the rest.
 */
export interface RiderSurgeSettings {
  riderSurgeEnabled?: unknown;
  /** Below this many online riders the signal is too thin to price on. */
  riderSurgeMinOnlineRiders?: unknown;
  riderSurgeLowBusyPercent?: unknown;
  riderSurgeLowFee?: unknown;
  riderSurgeMediumBusyPercent?: unknown;
  riderSurgeMediumFee?: unknown;
  riderSurgeHighBusyPercent?: unknown;
  riderSurgeHighFee?: unknown;
}

export interface RiderSupply {
  onlineRiders: number;
  busyRiders: number;
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Rings of hexagons around the restaurant whose riders decide its surge: its own hexagon and the
 * 6 around it, about 3 km, where the riders who'd pick its orders up are.
 */
export const SURGE_RINGS = 1;

/** Below this many online riders the signal is too thin to price on. */
export function riderSurgeMinOnline(settings: RiderSurgeSettings): number {
  return Math.max(1, number(settings.riderSurgeMinOnlineRiders, 3));
}

/** Riders online now (seen within freshMs) and how many of them are carrying an order. */
export function riderSupply(
  riders: Array<{online?: unknown; activeOrderId?: unknown; updatedAt?: unknown}>,
  now: number,
  freshMs: number,
): RiderSupply {
  const online = riders.filter((rider) => rider.online === true && now - Number(rider.updatedAt ?? 0) <= freshMs);
  return {onlineRiders: online.length, busyRiders: online.filter((rider) => String(rider.activeOrderId ?? "").trim().length > 0).length};
}

/**
 * How busy the riders are, whether surge is switched on or not: -1 too few online to tell, 0 calm,
 * 1 to 3 the low, medium and high surge tiers.
 */
export function riderSurgeLevel(settings: RiderSurgeSettings, supply: RiderSupply): number {
  const online = Math.max(0, Math.floor(supply.onlineRiders));
  const busy = Math.min(online, Math.max(0, Math.floor(supply.busyRiders)));
  if (online < riderSurgeMinOnline(settings)) return -1;
  const busyPercent = (busy / online) * 100;
  if (busyPercent >= number(settings.riderSurgeHighBusyPercent, 100)) return 3;
  if (busyPercent >= number(settings.riderSurgeMediumBusyPercent, 85)) return 2;
  if (busyPercent >= number(settings.riderSurgeLowBusyPercent, 70)) return 1;
  return 0;
}

/** Fee in rupees for the current rider supply around the restaurant; 0 when off or not busy. */
export function riderSurgeFee(settings: RiderSurgeSettings, supply: RiderSupply): number {
  if (settings.riderSurgeEnabled !== true) return 0;
  const level = riderSurgeLevel(settings, supply);
  if (level <= 0) return 0;
  const fee = level === 3 ? number(settings.riderSurgeHighFee, 30) :
    level === 2 ? number(settings.riderSurgeMediumFee, 20) : number(settings.riderSurgeLowFee, 10);
  return Math.min(100, Math.max(0, fee));
}

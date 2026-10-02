/**
 * Rider surge fee: charged when most of a city's online riders are already
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

/** Fee in rupees for the city's current rider supply; 0 when off or not busy. */
export function riderSurgeFee(settings: RiderSurgeSettings, supply: RiderSupply): number {
  if (settings.riderSurgeEnabled !== true) return 0;
  const online = Math.max(0, Math.floor(supply.onlineRiders));
  const busy = Math.min(online, Math.max(0, Math.floor(supply.busyRiders)));
  if (online < Math.max(1, number(settings.riderSurgeMinOnlineRiders, 3))) return 0;
  const busyPercent = (busy / online) * 100;
  const tiers: Array<[number, number]> = [
    [number(settings.riderSurgeHighBusyPercent, 100), number(settings.riderSurgeHighFee, 30)],
    [number(settings.riderSurgeMediumBusyPercent, 85), number(settings.riderSurgeMediumFee, 20)],
    [number(settings.riderSurgeLowBusyPercent, 70), number(settings.riderSurgeLowFee, 10)],
  ];
  for (const [threshold, fee] of tiers) {
    if (busyPercent >= threshold) return Math.min(100, Math.max(0, fee));
  }
  return 0;
}

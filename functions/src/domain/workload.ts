import type {OrderStatus, SavrivoOrder} from "../types";

export interface WorkloadOrderState {
  status: OrderStatus;
  orderUpdatedAt: number;
  terminalAt?: number;
}

export interface RestaurantWorkload {
  restaurantId: string;
  activeOrders: number;
  preparing: number;
  ready: number;
  updatedAt: number;
  source: "functions";
  orders: Record<string, WorkloadOrderState>;
}

const TERMINAL_RETENTION_MS = 48 * 60 * 60 * 1000;
const MAX_STATES = 2_000;

export function trustedActiveOrderCount(value: unknown, restaurantId: string): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (record.source !== "functions" || record.restaurantId !== restaurantId) return 0;
  const count = Number(record.activeOrders);
  return Number.isFinite(count) ? Math.max(0, Math.min(10_000, count)) : 0;
}

function active(status: OrderStatus): boolean {
  return !["Delivered", "Cancelled"].includes(status);
}

export function reduceRestaurantWorkload(
  current: RestaurantWorkload | null,
  order: Pick<SavrivoOrder, "id" | "restaurantId" | "status" | "updatedAt">,
  now: number,
): RestaurantWorkload {
  const states = {...(current?.orders ?? {})};
  const previous = states[order.id];
  if (previous && previous.orderUpdatedAt > order.updatedAt) return current!;
  if (previous?.orderUpdatedAt === order.updatedAt && previous.status === order.status) return current!;
  states[order.id] = {
    status: order.status,
    orderUpdatedAt: order.updatedAt,
    ...(!active(order.status) ? {terminalAt: now} : {}),
  };

  const terminal = Object.entries(states)
    .filter(([, state]) => !active(state.status))
    .sort((a, b) => Number(a[1].terminalAt ?? 0) - Number(b[1].terminalAt ?? 0));
  for (const [id, state] of terminal) {
    if (Number(state.terminalAt ?? 0) < now - TERMINAL_RETENTION_MS || Object.keys(states).length > MAX_STATES) {
      delete states[id];
    }
  }
  const values = Object.values(states);
  return {
    restaurantId: order.restaurantId,
    activeOrders: values.filter((state) => active(state.status)).length,
    preparing: values.filter((state) => state.status === "Preparing").length,
    ready: values.filter((state) => state.status === "Ready for pickup").length,
    updatedAt: now,
    source: "functions",
    orders: states,
  };
}

export interface RestaurantMembership {
  active?: boolean;
  restaurantId?: string;
  role?: string;
  permissions?: Record<string, boolean>;
}

export type RestaurantMembershipSource = "path-scoped" | "legacy-global";

/**
 * A normalized membership is already scoped by its database path:
 * restaurantMembers/{restaurantId}/{uid}. Older staff records live in the
 * global staff/{uid} collection, so they must carry the exact restaurant ID.
 * Treating a missing legacy ID as a wildcard would grant cross-restaurant
 * access.
 */
export function isActiveMembershipForRestaurant(
  member: RestaurantMembership | null,
  restaurantId: string,
  source: RestaurantMembershipSource,
): boolean {
  if (!member || member.active !== true) return false;
  if (source === "legacy-global") return member.restaurantId === restaurantId;
  return member.restaurantId === undefined || member.restaurantId === restaurantId;
}

import type {DecodedIdToken} from "firebase-admin/auth";
import {db} from "../admin";
import {ROOT} from "../config";
import {
  isActiveMembershipForRestaurant,
  type RestaurantMembership,
  type RestaurantMembershipSource,
} from "../domain/restaurantAccess";
import {DomainError} from "../errors";
import type {ActorRole, OrderStatus, SavrivoOrder} from "../types";

function privilegedRole(token: DecodedIdToken): ActorRole | undefined {
  return token.savrivoRole === "owner" ? "owner" : token.savrivoRole === "ops_admin" ? "ops_admin" : undefined;
}

export type PlatformConfigAdminRole = "owner" | "ops_admin";

/**
 * Platform policy is intentionally stricter than legacy RTDB admin access.
 * Only a signed custom claim grants this server-side control-plane action;
 * historical UID/email rule bypasses remain untouched for migration, but are
 * never consulted by the new callable.
 */
export function requirePlatformConfigAdminClaim(token: DecodedIdToken): PlatformConfigAdminRole {
  const role = privilegedRole(token);
  if (role === "owner" || role === "ops_admin") return role;
  throw new DomainError(
    "permission-denied",
    "A verified platform owner or operations-admin claim is required.",
  );
}

function permissionFor(target: OrderStatus): string | undefined {
  if (["Accepted", "Preparing", "Ready for pickup", "Cancelled"].includes(target)) return "orders";
  if (target === "Handed to rider") return "handover";
  return undefined;
}

function membershipAllows(
  member: RestaurantMembership | null,
  restaurantId: string,
  target: OrderStatus,
  source: RestaurantMembershipSource,
): boolean {
  if (!member || !isActiveMembershipForRestaurant(member, restaurantId, source)) return false;
  if (["restaurant_owner", "restaurant_manager"].includes(member.role ?? "")) return true;
  const permission = permissionFor(target);
  return permission !== undefined && member.permissions?.[permission] === true;
}

export async function authorizeTransition(
  uid: string,
  token: DecodedIdToken,
  order: SavrivoOrder,
  target: OrderStatus,
): Promise<ActorRole> {
  if (order.customerId === uid && target === "Cancelled") return "customer";

  if (order.riderId === uid && ["Out for delivery", "Delivered"].includes(target)) {
    const rider = (await db.ref(`${ROOT}/riders/${uid}/status`).get()).val();
    if (rider === "approved") return "rider";
  }

  const privileged = privilegedRole(token);
  if (privileged) return privileged;

  const [normalized, legacy] = await Promise.all([
    db.ref(`${ROOT}/restaurantMembers/${order.restaurantId}/${uid}`).get(),
    db.ref(`${ROOT}/staff/${uid}`).get(),
  ]);
  const normalizedMember = normalized.val() as RestaurantMembership | null;
  const legacyMember = legacy.val() as RestaurantMembership | null;
  if (membershipAllows(normalizedMember, order.restaurantId, target, "path-scoped") ||
      membershipAllows(legacyMember, order.restaurantId, target, "legacy-global")) return "staff";

  throw new DomainError("permission-denied", "This account cannot perform that order transition.");
}

export async function requireApprovedRider(uid: string): Promise<Record<string, unknown>> {
  const snapshot = await db.ref(`${ROOT}/riders/${uid}`).get();
  const rider = snapshot.val() as Record<string, unknown> | null;
  if (!rider || rider.status !== "approved") {
    throw new DomainError("permission-denied", "An approved delivery-partner account is required.");
  }
  return rider;
}

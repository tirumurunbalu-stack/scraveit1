import type {DecodedIdToken} from "firebase-admin/auth";
import {firestoreDb} from "../admin";
import {
  isActiveMembershipForRestaurant,
  type RestaurantMembership,
  type RestaurantMembershipSource,
} from "../domain/restaurantAccess";
import {DomainError} from "../errors";
import {legacyStaffRef, restaurantMemberRef, riderRef} from "../firestorePaths";
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

/**
 * Stricter than {@link requirePlatformConfigAdminClaim}: reserved for actions whose blast
 * radius is every user's personal data at once (e.g. a bulk export), where the routine
 * ops-admin bar is not high enough.
 */
export function requireOwnerClaim(token: DecodedIdToken): "owner" {
  if (privilegedRole(token) === "owner") return "owner";
  throw new DomainError(
    "permission-denied",
    "A verified platform owner claim is required.",
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
    const riderSnapshot = await riderRef(firestoreDb, uid).get();
    const rider = riderSnapshot.exists ? (riderSnapshot.data() as {status?: unknown} | null)?.status : null;
    if (rider === "approved") return "rider";
  }

  const privileged = privilegedRole(token);
  if (privileged) return privileged;

  const [normalized, legacy] = await Promise.all([
    restaurantMemberRef(firestoreDb, order.restaurantId, uid).get(),
    legacyStaffRef(firestoreDb, uid).get(),
  ]);
  const normalizedMember = (normalized.exists ? normalized.data() : null) as RestaurantMembership | null;
  const legacyMember = (legacy.exists ? legacy.data() : null) as RestaurantMembership | null;
  if (membershipAllows(normalizedMember, order.restaurantId, target, "path-scoped") ||
      membershipAllows(legacyMember, order.restaurantId, target, "legacy-global")) return "staff";

  throw new DomainError("permission-denied", "This account cannot perform that order transition.");
}

export async function requireApprovedRider(uid: string): Promise<Record<string, unknown>> {
  const snapshot = await riderRef(firestoreDb, uid).get();
  const rider = snapshot.exists ? snapshot.data() as Record<string, unknown> | null : null;
  if (!rider || rider.status !== "approved") {
    throw new DomainError("permission-denied", "An approved delivery-partner account is required.");
  }
  return rider;
}

/** Restaurant staff who may run its dine-in tables (owner, manager, or the "orders" permission), or a Scraveit admin. */
export async function canManageRestaurantOrders(uid: string, token: DecodedIdToken, restaurantId: string): Promise<boolean> {
  if (privilegedRole(token)) return true;
  const [normalized, legacy] = await Promise.all([
    restaurantMemberRef(firestoreDb, restaurantId, uid).get(),
    legacyStaffRef(firestoreDb, uid).get(),
  ]);
  const allows = (member: RestaurantMembership | null, source: RestaurantMembershipSource) =>
    !!member && isActiveMembershipForRestaurant(member, restaurantId, source) &&
    (["restaurant_owner", "restaurant_manager"].includes(member.role ?? "") || member.permissions?.orders === true);
  return allows((normalized.exists ? normalized.data() : null) as RestaurantMembership | null, "path-scoped") ||
    allows((legacy.exists ? legacy.data() : null) as RestaurantMembership | null, "legacy-global");
}

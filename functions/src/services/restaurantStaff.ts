import {randomInt} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {z} from "zod";
import {firestoreDb} from "../admin";
import {DomainError} from "../errors";
import {restaurantMemberRef} from "../firestorePaths";
import type {DocumentSnapshotLike, FirestoreLike} from "../firestoreTypes";
import {ownsOutlet} from "./sponsoredListings";

/**
 * Staff accounts an outlet owner creates and runs from their own account.
 *
 * Kitchen and counter staff often share a billing machine and have no email,
 * so the owner gives each person a staff ID and password. Behind the ID is a
 * normal Firebase sign-in on an address no one can receive mail at
 * (<id>@staff.scraveit.in), so an owner can never take over a real person's
 * account: every staff account here is new, and only the outlet that made it
 * can reset its password or switch it off.
 *
 * What a person sees is the membership in restaurantMembers/{rid}_{uid},
 * which Firestore rules and the order/finance callables already read:
 * managers get everything except staff and bank details, other staff only
 * the features the owner ticked.
 */

export const STAFF_LOGIN_DOMAIN = "staff.scraveit.in";
/** Features an owner can give a staff member, in the order the apps list them. */
export const STAFF_FEATURES = ["orders", "handover", "availability", "menu", "offers", "analytics", "finance", "profile"] as const;
export type StaffFeature = typeof STAFF_FEATURES[number];
const MAX_ACTIVE_STAFF = 40;
const STAFF_REQUESTS_COLLECTION = "restaurantStaffRequests";

/** Sign-in calls the service needs; the Admin SDK's Auth satisfies it. */
export interface StaffAuth {
  createUser(properties: {email: string; password: string; displayName: string; emailVerified?: boolean}): Promise<{uid: string}>;
  updateUser(uid: string, properties: {password?: string; displayName?: string; disabled?: boolean}): Promise<unknown>;
  getUser(uid: string): Promise<{email?: string; disabled?: boolean; metadata?: {lastSignInTime?: string | null; lastRefreshTime?: string | null}}>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

const restaurantIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const uidSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const nameSchema = z.string().trim().min(2, "Enter the staff member's name.").max(60);
const phoneSchema = z.string().trim().regex(/^(\+91)?[6-9]\d{9}$/, "Enter a 10-digit mobile number.").or(z.literal(""));
const passwordSchema = z.string().min(8, "Password needs at least 8 characters.").max(64)
  .refine((value) => value.trim() === value, "Password can't start or end with a space.");
const roleSchema = z.enum(["restaurant_manager", "restaurant_staff"]);
const featuresSchema = z.array(z.enum(STAFF_FEATURES)).max(STAFF_FEATURES.length);

export const listRestaurantStaffSchema = z.object({restaurantId: restaurantIdSchema}).strict();

export const createRestaurantStaffSchema = z.object({
  restaurantId: restaurantIdSchema,
  name: nameSchema,
  phone: phoneSchema.default(""),
  role: roleSchema,
  features: featuresSchema.default([]),
  password: passwordSchema,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
}).strict().refine((value) => value.role === "restaurant_manager" || value.features.length > 0,
  "Tick at least one thing this person can do.");

export const updateRestaurantStaffSchema = z.object({
  restaurantId: restaurantIdSchema,
  uid: uidSchema,
  name: nameSchema.optional(),
  phone: phoneSchema.optional(),
  role: roleSchema.optional(),
  features: featuresSchema.optional(),
  password: passwordSchema.optional(),
}).strict();

export const removeRestaurantStaffSchema = z.object({restaurantId: restaurantIdSchema, uid: uidSchema}).strict();

export type CreateRestaurantStaffInput = z.infer<typeof createRestaurantStaffSchema>;
export type UpdateRestaurantStaffInput = z.infer<typeof updateRestaurantStaffSchema>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Every feature on or off, so an old "true" never lingers after the owner unticks it. */
export function permissionsFor(role: "restaurant_manager" | "restaurant_staff", features: readonly string[]): Record<string, boolean> {
  const all = role === "restaurant_manager";
  const permissions: Record<string, boolean> = Object.fromEntries(STAFF_FEATURES.map((feature) => [feature, all || features.includes(feature)]));
  // Not owner-grantable here: rider tracking and dispatch stay with Scraveit, bank details with the owner.
  return {...permissions, tracking: false, dispatch: false, bank: false};
}

/** "ravi4821": the first name in plain letters, then four digits. */
export function staffLoginId(name: string, digits = randomInt(1000, 10000)): string {
  const word = name.normalize("NFKD").toLowerCase().replace(/[^a-z\s]/g, "").trim().split(/\s+/)[0] ?? "";
  return (word.length >= 2 ? word.slice(0, 10) : "staff") + String(digits);
}

export const staffEmail = (loginId: string) => `${loginId}@${STAFF_LOGIN_DOMAIN}`;

async function requireOwner(uid: string, token: DecodedIdToken, restaurantId: string, database: FirestoreLike): Promise<void> {
  if (!(await ownsOutlet(uid, token, restaurantId, database))) {
    throw new DomainError("permission-denied", "Only the outlet owner can manage staff.");
  }
}

function memberView(uid: string, data: Record<string, unknown>, lastSignInAt: number | null) {
  const permissions = record(data.permissions);
  const role = String(data.role ?? "restaurant_staff");
  return {
    uid,
    name: String(data.name ?? data.email ?? "Staff"),
    phone: String(data.phone ?? ""),
    role: (["restaurant_owner", "restaurant_manager"].includes(role) ? role : "restaurant_staff") as
      "restaurant_owner" | "restaurant_manager" | "restaurant_staff",
    features: STAFF_FEATURES.filter((feature) => permissions[feature] === true),
    loginId: String(data.staffLoginId ?? ""),
    email: data.staffLoginId ? "" : String(data.email ?? ""),
    managed: data.accountManagedByOutlet === true,
    createdAt: Number(data.createdAt) || 0,
    updatedAt: Number(data.updatedAt) || 0,
    lastSignInAt,
  };
}

function signInTime(user: {metadata?: {lastSignInTime?: string | null; lastRefreshTime?: string | null}} | null): number | null {
  const times = [user?.metadata?.lastRefreshTime, user?.metadata?.lastSignInTime].map((value) => Date.parse(String(value ?? "")))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

async function activeMembers(restaurantId: string, database: FirestoreLike): Promise<DocumentSnapshotLike[]> {
  const snapshot = await database.collection("restaurantMembers").where("restaurantId", "==", restaurantId).get();
  return snapshot.docs.filter((doc) => record(doc.data()).active === true && doc.id.startsWith(`${restaurantId}_`));
}

/** The outlet's people: the owner first, then managers, then staff, with the last time each one used the app. */
export async function listRestaurantStaff(uid: string, token: DecodedIdToken, input: {restaurantId: string},
  database: FirestoreLike = firestoreDb, auth?: StaffAuth) {
  const {restaurantId} = input;
  await requireOwner(uid, token, restaurantId, database);
  const members = await activeMembers(restaurantId, database);
  const rank = {restaurant_owner: 0, restaurant_manager: 1, restaurant_staff: 2};
  const staff = await Promise.all(members.map(async (doc) => {
    const memberUid = doc.id.slice(restaurantId.length + 1);
    const user = auth ? await auth.getUser(memberUid).catch(() => null) : null;
    return memberView(memberUid, record(doc.data()), signInTime(user));
  }));
  staff.sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
  return {restaurantId, you: uid, features: [...STAFF_FEATURES], loginDomain: STAFF_LOGIN_DOMAIN, maxStaff: MAX_ACTIVE_STAFF, staff};
}

/**
 * Makes the sign-in and the membership. A retry with the same requestId
 * returns the first result instead of making a second account.
 */
export async function createRestaurantStaff(uid: string, token: DecodedIdToken, input: CreateRestaurantStaffInput,
  auth: StaffAuth, database: FirestoreLike = firestoreDb, now = Date.now()) {
  const {restaurantId} = input;
  await requireOwner(uid, token, restaurantId, database);
  const requestRef = database.collection(STAFF_REQUESTS_COLLECTION).doc(`${restaurantId}_${input.requestId}`);
  const [earlier, restaurant, members] = await Promise.all([
    requestRef.get(),
    database.collection("restaurants").doc(restaurantId).get(),
    activeMembers(restaurantId, database),
  ]);
  if (earlier.exists) {
    const done = record(earlier.data());
    return {uid: String(done.uid), loginId: String(done.loginId), repeated: true};
  }
  if (!restaurant.exists) throw new DomainError("not-found", "This outlet wasn't found.");
  if (members.length >= MAX_ACTIVE_STAFF) {
    throw new DomainError("resource-exhausted", `An outlet can have up to ${MAX_ACTIVE_STAFF} people. Remove someone first.`);
  }

  let created: {uid: string} | null = null, loginId = "";
  for (let attempt = 0; attempt < 6 && !created; attempt += 1) {
    loginId = staffLoginId(input.name);
    try {
      created = await auth.createUser({email: staffEmail(loginId), password: input.password, displayName: input.name, emailVerified: false});
    } catch (error) {
      if (record(error).code !== "auth/email-already-exists") throw error;
    }
  }
  if (!created) throw new DomainError("aborted", "Couldn't make a staff ID. Try again.");

  const store = record(restaurant.data());
  const batch = database.batch();
  batch.set(restaurantMemberRef(database, restaurantId, created.uid), {
    active: true, restaurantId, restaurantName: String(store.name ?? ""), name: input.name, phone: input.phone,
    role: input.role, permissions: permissionsFor(input.role, input.features),
    staffLoginId: loginId, email: staffEmail(loginId), accountManagedByOutlet: true,
    createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid,
  });
  batch.set(database.collection("userRestaurants").doc(created.uid), {[restaurantId]: true}, {merge: true});
  batch.set(requestRef, {restaurantId, uid: created.uid, loginId, createdBy: uid, createdAt: now});
  await batch.commit();
  return {uid: created.uid, loginId, repeated: false};
}

async function targetMember(restaurantId: string, targetUid: string, database: FirestoreLike) {
  const ref = restaurantMemberRef(database, restaurantId, targetUid);
  const snapshot = await ref.get();
  const data = record(snapshot.exists ? snapshot.data() : null);
  if (!snapshot.exists || data.active !== true) throw new DomainError("not-found", "This person isn't on your staff list.");
  if (data.role === "restaurant_owner") throw new DomainError("failed-precondition", "The owner's access can't be changed here.");
  return {ref, data};
}

/** Name, role, features or a new password. Changes apply on the person's next screen refresh. */
export async function updateRestaurantStaff(uid: string, token: DecodedIdToken, input: UpdateRestaurantStaffInput,
  auth: StaffAuth, database: FirestoreLike = firestoreDb, now = Date.now()) {
  const {restaurantId} = input;
  await requireOwner(uid, token, restaurantId, database);
  if (input.uid === uid) throw new DomainError("failed-precondition", "You can't change your own access.");
  const {ref, data} = await targetMember(restaurantId, input.uid, database);
  const managed = data.accountManagedByOutlet === true;
  if (input.password !== undefined && !managed) {
    throw new DomainError("failed-precondition", "This person signs in with their own account, so only they can change its password.");
  }
  const role = input.role ?? (data.role === "restaurant_manager" ? "restaurant_manager" : "restaurant_staff");
  const features = input.features ?? STAFF_FEATURES.filter((feature) => record(data.permissions)[feature] === true);
  if (role === "restaurant_staff" && features.length === 0) {
    throw new DomainError("invalid-argument", "Tick at least one thing this person can do, or remove them.");
  }
  if (managed && (input.password !== undefined || input.name !== undefined)) {
    await auth.updateUser(input.uid, {
      ...(input.password !== undefined ? {password: input.password} : {}),
      ...(input.name !== undefined ? {displayName: input.name} : {}),
    });
    // A new password signs the person out everywhere, so a leaked one stops working.
    if (input.password !== undefined) await auth.revokeRefreshTokens(input.uid);
  }
  await ref.update({
    ...(input.name !== undefined ? {name: input.name} : {}),
    ...(input.phone !== undefined ? {phone: input.phone} : {}),
    role, permissions: permissionsFor(role, features), updatedAt: now, updatedBy: uid,
  });
  return {uid: input.uid, updated: true};
}

/**
 * Ends access at once: Firestore rules and the callables read the membership on
 * every request, and an outlet-made sign-in is switched off and signed out.
 */
export async function removeRestaurantStaff(uid: string, token: DecodedIdToken, input: {restaurantId: string; uid: string},
  auth: StaffAuth, database: FirestoreLike = firestoreDb, now = Date.now()) {
  const {restaurantId} = input;
  await requireOwner(uid, token, restaurantId, database);
  if (input.uid === uid) throw new DomainError("failed-precondition", "You can't remove yourself.");
  const {ref, data} = await targetMember(restaurantId, input.uid, database);
  const batch = database.batch();
  batch.update(ref, {active: false, removedAt: now, removedBy: uid, updatedAt: now, updatedBy: uid});
  batch.set(database.collection("userRestaurants").doc(input.uid), {[restaurantId]: false}, {merge: true});
  await batch.commit();
  if (data.accountManagedByOutlet === true) {
    await auth.updateUser(input.uid, {disabled: true});
    await auth.revokeRefreshTokens(input.uid);
  }
  return {uid: input.uid, removed: true};
}

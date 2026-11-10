import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {authorizeRestaurantFinanceRead} from "../src/services/restaurantSettlements";
import {
  createRestaurantStaff,
  createRestaurantStaffSchema,
  listRestaurantStaff,
  permissionsFor,
  removeRestaurantStaff,
  staffLoginId,
  type StaffAuth,
  updateRestaurantStaff,
} from "../src/services/restaurantStaff";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const RID = "rest_one";
const NOW = Date.parse("2026-10-31T12:00:00+05:30");
const token = (role?: string) => ({savrivoRole: role}) as unknown as DecodedIdToken;

class FakeAuth implements StaffAuth {
  users = new Map<string, {email: string; password: string; displayName: string; disabled: boolean; revoked: number}>();
  /** The next this-many sign-ups find their address already used. */
  clashes = 0;
  tried: string[] = [];
  next = 1;
  async createUser(p: {email: string; password: string; displayName: string}) {
    this.tried.push(p.email);
    if (this.clashes-- > 0 || [...this.users.values()].some((u) => u.email === p.email)) {
      throw Object.assign(new Error("exists"), {code: "auth/email-already-exists"});
    }
    const uid = `staffuid${this.next++}`;
    this.users.set(uid, {...p, disabled: false, revoked: 0});
    return {uid};
  }
  async updateUser(uid: string, p: {password?: string; displayName?: string; disabled?: boolean}) {
    const user = this.users.get(uid);
    if (!user) throw Object.assign(new Error("no user"), {code: "auth/user-not-found"});
    Object.assign(user, p);
    return user;
  }
  async getUser(uid: string) {
    const user = this.users.get(uid);
    if (!user) throw Object.assign(new Error("no user"), {code: "auth/user-not-found"});
    return {email: user.email, disabled: user.disabled, metadata: {lastSignInTime: "Fri, 31 Oct 2026 05:00:00 GMT", lastRefreshTime: null}};
  }
  async revokeRefreshTokens(uid: string) { this.users.get(uid)!.revoked += 1; }
}

const create = (overrides: Record<string, unknown> = {}) => createRestaurantStaffSchema.parse({
  restaurantId: RID, name: "Ravi Kumar", role: "restaurant_staff", features: ["orders", "handover"],
  password: "4829-1735", requestId: "req_abcdefgh", ...overrides,
});

describe("outlet staff accounts", () => {
  let database: InMemoryFirestore;
  let auth: FakeAuth;

  beforeEach(() => {
    database = new InMemoryFirestore();
    auth = new FakeAuth();
    database.seed(`restaurants/${RID}`, {name: "Sri Biryani"});
    database.seed(`restaurantMembers/${RID}_owner1`, {active: true, restaurantId: RID, role: "restaurant_owner", name: "Owner"});
    database.seed(`restaurantMembers/${RID}_mgr1`, {active: true, restaurantId: RID, role: "restaurant_manager", name: "Manager"});
  });

  it("the owner makes a staff ID that signs in to only this outlet, with only the ticked features", async () => {
    const result = await createRestaurantStaff("owner1", token(), create(), auth, database, NOW);
    expect(result.loginId).toMatch(/^ravi\d{4}$/);
    expect(auth.users.get(result.uid)).toMatchObject({email: `${result.loginId}@staff.scraveit.in`, password: "4829-1735", displayName: "Ravi Kumar"});
    expect(database.read(`restaurantMembers/${RID}_${result.uid}`)).toMatchObject({
      active: true, restaurantId: RID, role: "restaurant_staff", staffLoginId: result.loginId, accountManagedByOutlet: true, createdBy: "owner1",
      permissions: {orders: true, handover: true, menu: false, finance: false, bank: false, tracking: false, dispatch: false},
    });
    expect(database.read(`userRestaurants/${result.uid}`)).toEqual({[RID]: true});

    // A double tap or a retry doesn't make a second account.
    const again = await createRestaurantStaff("owner1", token(), create(), auth, database, NOW);
    expect(again).toEqual({uid: result.uid, loginId: result.loginId, repeated: true});
    expect(auth.users.size).toBe(1);
  });

  it("only the owner (or Scraveit) can add staff; managers and others can't", async () => {
    await expect(createRestaurantStaff("mgr1", token(), create(), auth, database, NOW)).rejects.toThrow(/Only the outlet owner/);
    await expect(createRestaurantStaff("stranger", token(), create(), auth, database, NOW)).rejects.toThrow(/Only the outlet owner/);
    await expect(listRestaurantStaff("mgr1", token(), {restaurantId: RID}, database, auth)).rejects.toThrow(/Only the outlet owner/);
    await expect(createRestaurantStaff("ops", token("ops_admin"), create(), auth, database, NOW)).resolves.toMatchObject({repeated: false});
    expect(auth.users.size).toBe(1);
  });

  it("picks another staff ID when one is taken", async () => {
    auth.clashes = 2;
    const result = await createRestaurantStaff("owner1", token(), create(), auth, database, NOW);
    expect(auth.tried).toHaveLength(3);
    expect(auth.users.get(result.uid)!.email).toBe(auth.tried[2]);
    auth.clashes = 6;
    await expect(createRestaurantStaff("owner1", token(), create({requestId: "req_clash001"}), auth, database, NOW)).rejects.toThrow(/Couldn't make a staff ID/);
    expect(staffLoginId("  9 Ünal ", 4821)).toBe("unal4821");
    expect(staffLoginId("A", 4821)).toBe("staff4821");
  });

  it("refuses kitchen staff with nothing ticked", () => {
    expect(() => create({features: []})).toThrow(/Tick at least one/);
    expect(() => create({role: "restaurant_manager", features: []})).not.toThrow();
    expect(() => create({password: "short"})).toThrow(/at least 8/);
    expect(permissionsFor("restaurant_manager", [])).toMatchObject({orders: true, finance: true, menu: true, bank: false});
  });

  it("changing features turns off the old ones, and a new password signs the person out", async () => {
    const {uid} = await createRestaurantStaff("owner1", token(), create(), auth, database, NOW);
    await updateRestaurantStaff("owner1", token(), {restaurantId: RID, uid, features: ["menu", "availability"]}, auth, database, NOW + 1);
    expect(database.read(`restaurantMembers/${RID}_${uid}`)).toMatchObject({
      permissions: {orders: false, handover: false, menu: true, availability: true}, updatedAt: NOW + 1, updatedBy: "owner1",
    });
    await updateRestaurantStaff("owner1", token(), {restaurantId: RID, uid, password: "new-pass-9"}, auth, database, NOW + 2);
    expect(auth.users.get(uid)).toMatchObject({password: "new-pass-9", revoked: 1});

    await expect(updateRestaurantStaff("owner1", token(), {restaurantId: RID, uid, features: []}, auth, database, NOW))
      .rejects.toThrow(/Tick at least one/);
    await expect(updateRestaurantStaff("owner1", token(), {restaurantId: RID, uid: "owner1", role: "restaurant_staff"}, auth, database, NOW))
      .rejects.toThrow(/your own access/);
    // A manager who signs in with their own Google account: the owner sets access, never their password.
    await expect(updateRestaurantStaff("owner1", token(), {restaurantId: RID, uid: "mgr1", password: "takeover123"}, auth, database, NOW))
      .rejects.toThrow(/only they can change/);
    await updateRestaurantStaff("owner1", token(), {restaurantId: RID, uid: "mgr1", role: "restaurant_staff", features: ["orders"]}, auth, database, NOW);
    expect(database.read(`restaurantMembers/${RID}_mgr1`)).toMatchObject({role: "restaurant_staff", permissions: {orders: true, finance: false}});
  });

  it("removing someone ends their access and switches off the staff ID", async () => {
    const {uid} = await createRestaurantStaff("owner1", token(), create(), auth, database, NOW);
    let list = await listRestaurantStaff("owner1", token(), {restaurantId: RID}, database, auth);
    expect(list.staff.map((s) => s.role)).toEqual(["restaurant_owner", "restaurant_manager", "restaurant_staff"]);
    expect(list.staff[2]).toMatchObject({uid, name: "Ravi Kumar", features: ["orders", "handover"], managed: true,
      lastSignInAt: Date.parse("2026-10-31T05:00:00Z")});

    await removeRestaurantStaff("owner1", token(), {restaurantId: RID, uid}, auth, database, NOW + 5);
    expect(database.read(`restaurantMembers/${RID}_${uid}`)).toMatchObject({active: false, removedBy: "owner1", removedAt: NOW + 5});
    expect(database.read(`userRestaurants/${uid}`)).toEqual({[RID]: false});
    expect(auth.users.get(uid)).toMatchObject({disabled: true, revoked: 1});
    list = await listRestaurantStaff("owner1", token(), {restaurantId: RID}, database, auth);
    expect(list.staff.map((s) => s.uid)).toEqual(["owner1", "mgr1"]);

    await expect(removeRestaurantStaff("owner1", token(), {restaurantId: RID, uid}, auth, database, NOW)).rejects.toThrow(/isn't on your staff/);
    await expect(removeRestaurantStaff("owner1", token(), {restaurantId: RID, uid: "owner1"}, auth, database, NOW)).rejects.toThrow(/yourself/);
  });

  it("staff see payouts only when the owner gave them Payouts & invoices", async () => {
    const plain = await createRestaurantStaff("owner1", token(), create(), auth, database, NOW);
    const accountant = await createRestaurantStaff("owner1", token(), create({name: "Lakshmi", features: ["finance"], requestId: "req_finance1"}), auth, database, NOW);
    await expect(authorizeRestaurantFinanceRead(plain.uid, token(), RID, database as never)).rejects.toThrow(/not permitted/);
    await expect(authorizeRestaurantFinanceRead(accountant.uid, token(), RID, database as never)).resolves.toBeUndefined();
    await expect(authorizeRestaurantFinanceRead("mgr1", token(), RID, database as never)).resolves.toBeUndefined();
    // Ads page: staff with Offers & ads may look too.
    const marketer = await createRestaurantStaff("owner1", token(), create({name: "Kiran", features: ["offers"], requestId: "req_offers01"}), auth, database, NOW);
    await expect(authorizeRestaurantFinanceRead(marketer.uid, token(), RID, database as never, ["finance", "offers"])).resolves.toBeUndefined();
    await expect(authorizeRestaurantFinanceRead(marketer.uid, token(), RID, database as never)).rejects.toThrow(/not permitted/);
  });
});

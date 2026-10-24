import {beforeEach, describe, expect, it, vi} from "vitest";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const db = new InMemoryFirestore();
const authUsers = new Map<string, {customClaims?: Record<string, unknown>}>();
const deleted: string[] = [];
const alerts: string[] = [];

vi.mock("../src/admin", () => ({
  firestoreDb: db,
  auth: {
    getUser: async (uid: string) => {
      if (!authUsers.has(uid)) throw Object.assign(new Error("no user"), {code: "auth/user-not-found"});
      return {uid, ...authUsers.get(uid)};
    },
    deleteUser: async (uid: string) => { deleted.push(uid); authUsers.delete(uid); },
  },
  storage: {}, messaging: {}, db: {},
}));
vi.mock("../src/services/adminAlerts", () => ({
  alertAdmins: async (_key: string, title: string) => { alerts.push(title); },
}));

const {deleteCustomerAccount, processDeletionRequest, anonymisedOrderFields} = await import("../src/services/accountDeletion");

const A = "custA", B = "custB", CHILD = "kidC";

function seedWorld(): void {
  for (const path of db.paths()) db.read(path) && void db.recursiveDelete(db.doc(path));
  authUsers.clear(); deleted.length = 0; alerts.length = 0;
  for (const uid of [A, B, CHILD]) authUsers.set(uid, {});
  db.seed(`users/${A}`, {name: "Asha", email: "asha@example.com", phone: "9000000001"});
  db.seed(`users/${A}/addresses/home`, {address: "12 Balaji Nagar", lat: 14.4, lng: 79.9});
  db.seed(`users/${B}`, {name: "Bala", email: "bala@example.com"});
  db.seed(`customerDemographics/${A}`, {gender: "female", birthDate: "1999-01-01", consent: true});
  db.seed(`accountAges/${A}`, {birthDate: "1999-01-01", minor: false});
  db.seed(`privacyConsents/${A}_customer`, {uid: A, audience: "customer", version: "2026-10-23"});
  // Orders: finished, with a rider; B's must be untouched.
  db.seed("orders/o1", {id: "o1", customerId: A, customerName: "Asha", customerPhone: "9000000001", status: "Delivered", riderId: "r1",
    address: {address: "12 Balaji Nagar", area: "Balaji Nagar", city: "Nellore", lat: 14.4, lng: 79.9, phone: "9000000001"}, note: "Ring twice", updatedAt: 1});
  db.seed("orders/o2", {id: "o2", customerId: B, customerName: "Bala", customerPhone: "9000000002", status: "Delivered", address: {address: "5 Main Rd", area: "Main"}});
  db.seed("riderJobs/r1_o1", {orderId: "o1", customerName: "Asha", customerPhone: "9000000001", address: {address: "12 Balaji Nagar"}});
  db.seed("orderChats/o1_customerRider_m1", {orderId: "o1", channel: "customerRider", text: "I'm at the gate"});
  db.seed("orderChats/o1_restaurantRider_m2", {orderId: "o1", channel: "restaurantRider", text: "Ready"});
  db.seed(`reviews/${A}_o1`, {customerId: A, orderId: "o1", rating: 5, riderRating: 4, comment: "Loved it, Asha"});
  // Friends & chat.
  db.seed(`chatProfiles/${A}`, {uid: A, name: "Asha", username: "asha_eats", code: "ABC123"});
  db.seed("usernames/asha_eats", {uid: A});
  db.seed("friendCodes/ABC123", {uid: A});
  db.seed(`chatAvatars/${A}`, {image: "data:..."});
  db.seed(`friendships/${A}_${B}`, {members: [A, B], status: "accepted"});
  db.seed(`chats/${A}_${B}/messages/m1`, {from: A, text: "hi"});
  db.seed(`chats/${B}_zed/messages/m9`, {from: B, text: "other chat"});
  db.seed("posts/pA", {from: A, kind: "story"});
  db.seed("posts/pA/comments/c1", {from: B, text: "nice"});
  db.seed("posts/pB", {from: B, kind: "post"});
  db.seed("posts/pB/comments/c2", {from: A, text: "yum"});
  db.seed("posts/pB/comments/c3", {from: B, text: "thanks"});
  db.seed("postMedia/pA", {from: A, image: "data:..."});
  db.seed(`feeds/${A}/feedItems/pB`, {postId: "pB", from: B});
  // A is a parent of a 15-year-old.
  db.seed(`parentRequests/${CHILD}`, {childUid: CHILD, parentUid: A, status: "approved"});
  db.seed(`accountAges/${CHILD}`, {minor: true, parentUid: A, parentStatus: "approved"});
  db.seed("support/t1", {uid: A, topic: "Late order", orderId: "o1", email: "asha@example.com", customerName: "Asha"});
  db.seed("support/t2", {uid: A, topic: "App question", email: "asha@example.com"});
  db.seed(`deviceTokens/${A}`, {tokens: ["tok"]});
  db.seed("deviceTokenOwners/hash1", {uid: A});
}

describe("deleting a customer account", () => {
  beforeEach(seedWorld);

  it("erases the customer's own data and the account", async () => {
    const result = await deleteCustomerAccount(A, 1000);
    expect(result.status).toBe("completed");
    for (const path of [`users/${A}`, `users/${A}/addresses/home`, `customerDemographics/${A}`, `accountAges/${A}`, `chatProfiles/${A}`,
      "usernames/asha_eats", "friendCodes/ABC123", `chatAvatars/${A}`, `feeds/${A}/feedItems/pB`, `deviceTokens/${A}`, "deviceTokenOwners/hash1"]) {
      expect(db.read(path), path).toBeNull();
    }
    expect(deleted).toEqual([A]);
  });

  it("keeps the order for tax law with the contact details removed", async () => {
    await deleteCustomerAccount(A, 1000);
    const order = db.read("orders/o1") as Record<string, unknown>;
    expect(order).toMatchObject({customerName: "Deleted customer", customerDeleted: true, address: {area: "Balaji Nagar", city: "Nellore"}, status: "Delivered"});
    expect(order).not.toHaveProperty("customerPhone");
    expect(order).not.toHaveProperty("note");
    expect(JSON.stringify(order)).not.toContain("9000000001");
    expect(JSON.stringify(db.read("riderJobs/r1_o1"))).not.toContain("Asha");
    expect(db.read("orders/o2")).toMatchObject({customerName: "Bala", customerPhone: "9000000002"});
  });

  it("deletes the customer's order chats but not the store-rider one", async () => {
    await deleteCustomerAccount(A, 1000);
    expect(db.read("orderChats/o1_customerRider_m1")).toBeNull();
    expect(db.read("orderChats/o1_restaurantRider_m2")).not.toBeNull();
  });

  it("keeps a review's rating and drops the words", async () => {
    await deleteCustomerAccount(A, 1000);
    const review = db.read(`reviews/${A}_o1`) as Record<string, unknown>;
    expect(review).toMatchObject({rating: 5, riderRating: 4});
    expect(review).not.toHaveProperty("comment");
  });

  it("removes chats, friendships, posts and comments, leaving other people's own things", async () => {
    await deleteCustomerAccount(A, 1000);
    expect(db.read(`chats/${A}_${B}/messages/m1`)).toBeNull();
    expect(db.read(`chats/${B}_zed/messages/m9`)).not.toBeNull();
    expect(db.read(`friendships/${A}_${B}`)).toBeNull();
    expect(db.read("posts/pA")).toBeNull();
    expect(db.read("posts/pA/comments/c1")).toBeNull();
    expect(db.read("postMedia/pA")).toBeNull();
    expect(db.read("posts/pB")).not.toBeNull();
    expect(db.read("posts/pB/comments/c2")).toBeNull();
    expect(db.read("posts/pB/comments/c3")).not.toBeNull();
    expect(db.read(`users/${B}`)).not.toBeNull();
  });

  it("withdraws a parent's approval of their child", async () => {
    await deleteCustomerAccount(A, 1000);
    expect(db.read(`accountAges/${CHILD}`)).toMatchObject({parentStatus: "revoked"});
  });

  it("keeps support tickets about an order without contact details, and deletes the rest", async () => {
    await deleteCustomerAccount(A, 1000);
    expect(db.read("support/t1")).toMatchObject({topic: "Late order", customerDeleted: true});
    expect(db.read("support/t1")).not.toHaveProperty("email");
    expect(db.read("support/t2")).toBeNull();
  });

  it("keeps the consent record as proof, marked withdrawn", async () => {
    await deleteCustomerAccount(A, 1000);
    expect(db.read(`privacyConsents/${A}_customer`)).toMatchObject({version: "2026-10-23", withdrawnAt: 1000});
  });

  it("waits while an order is still on its way, touching nothing", async () => {
    db.seed("orders/o3", {id: "o3", customerId: A, status: "Out for delivery", address: {}});
    const result = await deleteCustomerAccount(A, 1000);
    expect(result).toMatchObject({status: "waiting", reason: "an order is still in progress"});
    expect(db.read(`users/${A}`)).not.toBeNull();
    expect(deleted).toEqual([]);
  });

  it("keeps the sign-in of someone who also delivers, erasing only the customer side", async () => {
    db.seed(`riders/${A}`, {status: "approved"});
    const result = await deleteCustomerAccount(A, 1000);
    expect(result.status).toBe("completed_customer_only");
    expect(deleted).toEqual([]);
    expect(db.read(`users/${A}`)).toBeNull();
    expect(db.read(`riders/${A}`)).not.toBeNull();
    expect(db.read(`deviceTokens/${A}`)).not.toBeNull();
  });
});

describe("deletion requests", () => {
  beforeEach(seedWorld);

  it("runs a request and keeps no email on it afterwards", async () => {
    db.seed("privacyRequests/p1", {type: "account_deletion", uid: A, email: "asha@example.com", status: "requested", createdAt: 1});
    const snap = await db.doc("privacyRequests/p1").get();
    const result = await processDeletionRequest(Object.assign(snap, {ref: db.doc("privacyRequests/p1")}) as never, 2000);
    expect(result?.status).toBe("completed");
    const request = db.read("privacyRequests/p1") as Record<string, unknown>;
    expect(request).toMatchObject({status: "completed", completedAt: 2000});
    expect(JSON.stringify(request)).not.toContain("asha@example.com");
  });

  it("ignores anything that isn't a pending deletion", async () => {
    db.seed("privacyRequests/p2", {type: "account_deletion", uid: A, status: "completed"});
    const snap = await db.doc("privacyRequests/p2").get();
    expect(await processDeletionRequest(Object.assign(snap, {ref: db.doc("privacyRequests/p2")}) as never, 2000)).toBeNull();
    expect(db.read(`users/${A}`)).not.toBeNull();
  });
});

describe("anonymised order fields", () => {
  it("keeps only area, city, pincode and state of the address", () => {
    const update = anonymisedOrderFields({address: {address: "x", area: "A", city: "C", pincode: "524004", lat: 1, phone: "9"}}, 5);
    expect(update.address).toEqual({area: "A", city: "C", pincode: "524004"});
  });
});

import {logger} from "firebase-functions";
import {FieldValue} from "firebase-admin/firestore";
import type {DocumentReference, DocumentSnapshot, QueryDocumentSnapshot} from "firebase-admin/firestore";
import {auth, firestoreDb} from "../admin";
import {alertAdmins} from "./adminAlerts";
import {accountParentRevoke} from "./accountAge";

/**
 * A customer deleting their account: withdrawing consent and asking for
 * erasure (DPDP Act, 2023, s.6(4), s.8(7) and s.12(3)). The app writes
 * privacyRequests/{id} for the signed-in person only (Firestore rules), and
 * the onPrivacyRequestCreated trigger runs this.
 *
 * Erased: the profile, addresses, preferences, date of birth, "About you",
 * Friends & chat (profile, username, friend code, friendships, both sides of
 * the chats, posts, stories and comments), parent links, squads hosted,
 * meal subscriptions, notification tokens, the order chats and the account
 * itself in Firebase Auth.
 *
 * Kept, with the person's contact details removed, because a law requires
 * it: orders and bills (CGST Act, 2017, s.36), the rating number of each
 * review (store ratings were built from it), cashback ledger entries
 * (accounts), reported chat content (IT Rules, 2021, r.3(1)(g)), and the
 * consent and deletion records themselves (proof of consent, DPDP Act,
 * s.6(10)).
 *
 * The deletion waits while an order, a meal plan or a table booking is still
 * running; the daily retry picks it up once they are finished. Someone who
 * also delivers, runs a store or is an admin keeps their sign-in: only the
 * customer side is erased, and the owner is told.
 */

type Rec = Record<string, unknown>;
const TERMINAL = new Set(["Delivered", "Cancelled"]);
const BATCH = 400;

export interface DeletionResult {
  status: "completed" | "completed_customer_only" | "waiting";
  reason?: string;
  counts: Record<string, number>;
}

async function deleteDocs(refs: DocumentReference[]): Promise<number> {
  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = firestoreDb.batch();
    refs.slice(i, i + BATCH).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  return refs.length;
}

async function recursive(ref: DocumentReference): Promise<number> {
  await firestoreDb.recursiveDelete(ref);
  return 1;
}

const refsOf = (docs: QueryDocumentSnapshot[]) => docs.map((d) => d.ref);

/** What keeps the account from being deleted right now, or "" if nothing. */
export async function deletionBlocker(uid: string): Promise<string> {
  const [orders, meals, bookings] = await Promise.all([
    firestoreDb.collection("orders").where("customerId", "==", uid).get(),
    firestoreDb.collection("mealSubscriptions").where("customerId", "==", uid).get(),
    firestoreDb.collection("dineBookings").where("customerId", "==", uid).get(),
  ]);
  if (orders.docs.some((d) => !TERMINAL.has(String(d.data().status)))) return "an order is still in progress";
  // Cash-on-delivery meal plans are simply cancelled; a prepaid one has money to settle first.
  if (meals.docs.some((d) => ["active", "paused"].includes(String(d.data().status)) && String(d.data().paymentMethod ?? "cod") !== "cod")) {
    return "a prepaid meal plan is still running";
  }
  if (bookings.docs.some((d) => String(d.data().status) === "seated")) return "a table is still open in your name";
  return "";
}

/** Does this sign-in also belong to a delivery partner, store or admin? Then only the customer side goes. */
export async function otherRoles(uid: string): Promise<string[]> {
  const [rider, links, staff, user] = await Promise.all([
    firestoreDb.collection("riders").doc(uid).get(),
    firestoreDb.collection("userRestaurants").doc(uid).get(),
    firestoreDb.collection("staff").doc(uid).get(),
    auth.getUser(uid).catch(() => null),
  ]);
  const roles: string[] = [];
  if (rider.exists) roles.push("delivery partner");
  const linked = links.exists ? Object.values(links.data() ?? {}).some((v) => v === true) : false;
  if (linked || (staff.exists && staff.data()?.active === true)) roles.push("store");
  const claim = String((user?.customClaims ?? {} as Rec).savrivoRole ?? "");
  if (["owner", "ops_admin"].includes(claim)) roles.push("admin");
  return roles;
}

/** The order with the customer's contact details removed; only the area and city stay, for the bill. */
export function anonymisedOrderFields(order: Rec, now: number): Rec {
  const address = (order.address ?? {}) as Rec;
  const keep: Rec = {};
  for (const key of ["area", "city", "pincode", "state"]) if (address[key] != null && address[key] !== "") keep[key] = address[key];
  const update: Rec = {
    customerName: "Deleted customer",
    customerPhone: FieldValue.delete(),
    customerEmail: FieldValue.delete(),
    address: keep,
    customerDeleted: true,
    customerDeletedAt: now,
    updatedAt: now,
  };
  for (const key of ["note", "notes", "instructions", "deliveryNote", "deliveryInstructions", "customerNote"]) {
    if (key in order) update[key] = FieldValue.delete();
  }
  return update;
}

/** The rider's copy of a finished order: no name, address or phone. */
export function anonymisedRiderJobFields(): Rec {
  return {customerName: "Deleted customer", customerPhone: FieldValue.delete(), address: FieldValue.delete(), customerDeleted: true};
}

export async function deleteCustomerAccount(uid: string, now = Date.now()): Promise<DeletionResult> {
  const counts: Record<string, number> = {};
  const add = (key: string, n: number) => { counts[key] = (counts[key] ?? 0) + n; };

  const blocker = await deletionBlocker(uid);
  if (blocker) return {status: "waiting", reason: blocker, counts};
  const roles = await otherRoles(uid);

  // Orders and their copies: kept for tax law, contact details removed. The order
  // trigger rebuilds the store's and the admin's copies from the cleaned order.
  const orders = await firestoreDb.collection("orders").where("customerId", "==", uid).get();
  for (const order of orders.docs) {
    const data = order.data();
    await order.ref.update(anonymisedOrderFields(data, now));
    if (data.riderId) {
      await firestoreDb.collection("riderJobs").doc(`${data.riderId}_${order.id}`).update(anonymisedRiderJobFields()).catch(() => undefined);
    }
    const chat = await firestoreDb.collection("orderChats").where("orderId", "==", order.id).get();
    add("orderChats", await deleteDocs(refsOf(chat.docs.filter((d) => String(d.data().channel ?? "").startsWith("customer")))));
  }
  add("ordersAnonymised", orders.size);

  // Reviews: the rating number stays (store ratings were built from it), the words and name go.
  const reviews = await firestoreDb.collection("reviews").where("customerId", "==", uid).get();
  for (const review of reviews.docs) {
    await review.ref.update({customerName: FieldValue.delete(), comment: FieldValue.delete(), text: FieldValue.delete(),
      riderComment: FieldValue.delete(), customerDeleted: true, updatedAt: now});
  }
  add("reviewsAnonymised", reviews.size);

  // Meal plans and table bookings.
  const meals = await firestoreDb.collection("mealSubscriptions").where("customerId", "==", uid).get();
  for (const sub of meals.docs) {
    const live = ["active", "paused"].includes(String(sub.data().status));
    await sub.ref.update({customerName: "Deleted customer", customerDeleted: true, updatedAt: now,
      ...(live ? {status: "cancelled", cancelledAt: now} : {})});
  }
  const bookings = await firestoreDb.collection("dineBookings").where("customerId", "==", uid).get();
  for (const booking of bookings.docs) {
    const upcoming = !["cancelled", "seated", "completed", "no_show"].includes(String(booking.data().status)) && Number(booking.data().slotAt ?? 0) > now;
    await booking.ref.update({customerName: "Deleted customer", customerPhone: FieldValue.delete(), customerDeleted: true, updatedAt: now,
      ...(upcoming ? {status: "cancelled", cancelledAt: now} : {})});
  }

  // Friends & chat: both sides of every chat, then the friendships (whose trigger clears the feeds).
  const chatProfile = await firestoreDb.collection("chatProfiles").doc(uid).get();
  const profile = (chatProfile.exists ? chatProfile.data() : {}) as Rec;
  const chats = await firestoreDb.collection("chats").listDocuments();
  for (const chat of chats.filter((ref) => ref.id.startsWith(uid + "_") || ref.id.endsWith("_" + uid))) add("chats", await recursive(chat));
  const friendships = await firestoreDb.collection("friendships").where("members", "array-contains", uid).get();
  add("friendships", await deleteDocs(refsOf(friendships.docs)));

  // Posts and stories (their trigger removes the feed cards, comments and photo), then comments left on others' posts.
  const posts = await firestoreDb.collection("posts").where("from", "==", uid).get();
  for (const post of posts.docs) add("posts", await recursive(post.ref));
  const comments = await firestoreDb.collectionGroup("comments").where("from", "==", uid).get();
  add("comments", await deleteDocs(refsOf(comments.docs)));
  const media = await firestoreDb.collection("postMedia").where("from", "==", uid).get();
  add("postMedia", await deleteDocs(refsOf(media.docs.filter((d) => d.data().removed !== true))));
  // Story answers they gave, their highlights and who-sees-my-stories lists.
  const answers = await firestoreDb.collectionGroup("responses").where("from", "==", uid).get();
  add("responses", await deleteDocs(refsOf(answers.docs)));
  const highlights = await firestoreDb.collection("highlights").where("from", "==", uid).get();
  add("highlights", await deleteDocs(refsOf(highlights.docs)));
  const storyPrefs = firestoreDb.collection("storyPrefs").doc(uid);
  if ((await storyPrefs.get()).exists) { await storyPrefs.delete(); add("storyPrefs", 1); }

  // Parent links: a parent leaving withdraws their approval; a child's own request goes.
  const children = await firestoreDb.collection("parentRequests").where("parentUid", "==", uid).get();
  for (const child of children.docs) {
    await accountParentRevoke(uid, {childUid: child.id}, now).catch((error) => logger.warn("DELETION_PARENT_REVOKE_FAILED", {error: String(error)}));
  }
  const payAsChild = await firestoreDb.collection("parentPayRequests").where("childUid", "==", uid).get();
  const payAsParent = await firestoreDb.collection("parentPayRequests").where("parentUid", "==", uid).get();
  add("parentPayRequests", await deleteDocs([...refsOf(payAsChild.docs), ...refsOf(payAsParent.docs)]));

  const squads = await firestoreDb.collection("squads").where("hostUid", "==", uid).get();
  for (const squad of squads.docs) add("squads", await recursive(squad.ref));

  const tokenOwners = await firestoreDb.collection("deviceTokenOwners").where("uid", "==", uid).get();
  add("deviceTokenOwners", await deleteDocs(refsOf(tokenOwners.docs)));

  // Support tickets about an order stay (with contact details removed) for consumer-law complaints; the rest go.
  const tickets = await firestoreDb.collection("support").where("uid", "==", uid).get();
  for (const ticket of tickets.docs) {
    if (ticket.data().orderId) {
      await ticket.ref.update({customerName: FieldValue.delete(), email: FieldValue.delete(), phone: FieldValue.delete(), customerDeleted: true, updatedAt: now});
    } else {
      await ticket.ref.delete();
      add("support", 1);
    }
  }

  // The person's own documents.
  const own: DocumentReference[] = [
    firestoreDb.collection("users").doc(uid),
    firestoreDb.collection("customerDemographics").doc(uid),
    firestoreDb.collection("accountAges").doc(uid),
    firestoreDb.collection("chatProfiles").doc(uid),
    firestoreDb.collection("chatAvatars").doc(uid),
    // Chat encryption: public keys, the locked key vault and any phone-linking requests.
    firestoreDb.collection("chatKeys").doc(uid),
    firestoreDb.collection("chatVault").doc(uid),
    firestoreDb.collection("chatLinks").doc(uid),
    firestoreDb.collection("parentRequests").doc(uid),
    firestoreDb.collection("feeds").doc(uid),
    firestoreDb.collection("notifications").doc(uid),
    firestoreDb.collection("customerRisk").doc(uid),
  ];
  if (roles.length === 0) own.push(firestoreDb.collection("deviceTokens").doc(uid));
  if (profile.username) own.push(firestoreDb.collection("usernames").doc(String(profile.username)));
  if (profile.code) own.push(firestoreDb.collection("friendCodes").doc(String(profile.code)));
  for (const ref of own) add("ownDocs", await recursive(ref));

  // Consent record: kept as proof, marked withdrawn.
  await firestoreDb.collection("privacyConsents").doc(`${uid}_customer`).set({withdrawnAt: now}, {merge: true}).catch(() => undefined);

  if (roles.length) {
    logger.info("ACCOUNT_DELETION_CUSTOMER_ONLY", {uid, roles, counts});
    return {status: "completed_customer_only", reason: `this sign-in is also a ${roles.join(" and ")} account`, counts};
  }
  await auth.deleteUser(uid).catch((error: {code?: string}) => {
    if (error?.code !== "auth/user-not-found") throw error;
  });
  logger.info("ACCOUNT_DELETION_COMPLETED", {uid, counts});
  return {status: "completed", counts};
}

/** Run a deletion request and record what happened on it. */
export async function processDeletionRequest(snapshot: DocumentSnapshot, now = Date.now()): Promise<DeletionResult | null> {
  const request = (snapshot.data() ?? {}) as Rec;
  if (request.type !== "account_deletion" || !["requested", "waiting"].includes(String(request.status))) return null;
  const uid = String(request.uid ?? "");
  if (!uid) return null;
  let result: DeletionResult;
  try {
    result = await deleteCustomerAccount(uid, now);
  } catch (error) {
    logger.error("ACCOUNT_DELETION_FAILED", {requestId: snapshot.id, error: String(error)});
    await snapshot.ref.set({status: "waiting", reason: "a temporary error; retried tomorrow", attempts: FieldValue.increment(1), updatedAt: now}, {merge: true});
    await alertAdmins(`privacy-failed:${snapshot.id}:${now}`, "Account deletion failed", `Deleting ${uid} failed and will be retried tomorrow. Check the function logs.`, "");
    return null;
  }
  if (result.status === "waiting") {
    await snapshot.ref.set({status: "waiting", reason: result.reason, attempts: FieldValue.increment(1), updatedAt: now}, {merge: true});
    return result;
  }
  // The request keeps no contact details once it is done: only the account id and the dates.
  await snapshot.ref.set({status: result.status, completedAt: now, counts: result.counts, email: FieldValue.delete(),
    ...(result.reason ? {reason: result.reason} : {}), updatedAt: now}, {merge: true});
  if (result.status === "completed_customer_only") {
    await alertAdmins(`privacy-partial:${snapshot.id}`, "Customer data deleted, sign-in kept",
      `${uid}: ${result.reason}. Their customer data is erased; delete the partner side separately if they ask.`, "");
  }
  return result;
}

/** Daily: requests that were waiting for an order or plan to finish. Gives up waiting after 30 days and tells the owner. */
export async function retryWaitingDeletions(now = Date.now()): Promise<number> {
  const [waiting, stuck] = await Promise.all([
    firestoreDb.collection("privacyRequests").where("status", "==", "waiting").limit(50).get(),
    // A request whose first run was cut off (for example a timeout) is still "requested".
    firestoreDb.collection("privacyRequests").where("status", "==", "requested").limit(50).get(),
  ]);
  let done = 0;
  for (const request of [...waiting.docs, ...stuck.docs.filter((d) => now - Number(d.data().createdAt ?? now) > 3600e3)]) {
    const result = await processDeletionRequest(request, now);
    if (result && result.status !== "waiting") done++;
    const createdAt = Number(request.data().createdAt ?? now);
    if (result?.status === "waiting" && now - createdAt > 25 * 24 * 3600e3) {
      await alertAdmins(`privacy-late:${request.id}`, "Account deletion is overdue",
        `${request.data().uid}: still waiting because ${result.reason}. The privacy notice promises 30 days.`, "");
    }
  }
  return done;
}

/** Squads expire after a few hours; a week later their picks (names and choices) go too. */
export async function deleteOldSquads(now = Date.now()): Promise<number> {
  const old = await firestoreDb.collection("squads").where("expiresAt", "<", now - 7 * 24 * 3600e3).limit(200).get();
  for (const squad of old.docs) await firestoreDb.recursiveDelete(squad.ref);
  return old.size;
}


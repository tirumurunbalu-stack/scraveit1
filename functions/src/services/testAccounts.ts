import {logger} from "firebase-functions";
import {auth, firestoreDb} from "../admin";
import {DomainError} from "../errors";
import {isOpeningSoon, OPENING_SOON_MESSAGE} from "./openingSoon";

/**
 * Test accounts (founder 19 Nov 2026): the founder's own accounts test every app update, before and
 * after launch. Kept in private/testAccounts (server-only, admins can read), edited on the admin
 * website /test-accounts/ through the testAccounts callable.
 *
 * - Test customers may order from any store (test or real), and may order while "Opening soon" is on
 *   (founder 20 Nov 2026: test orders work at any restaurant). Their orders carry testOrder: true.
 * - Test stores take orders only from test customers; real customers never see them (the app hides
 *   them using settings/customer.testStoreIds, the public copy of the store list).
 * - Test orders (a test customer's order, or any order at a test store) are offered only to test
 *   delivery partners, and test delivery partners get no real orders (dispatch.ts candidatesFor + findBatch).
 */
export interface TestAccounts {
  customers: string[];
  deliveryPartners: string[];
  restaurants: string[];
  storeIds: string[];
  updatedAt: number;
  updatedBy: string;
}

export const REAL_CUSTOMER_TEST_STORE_MESSAGE = "This store is not taking orders.";
export const NO_TEST_ORDERS_MESSAGE = "Test orders can't go to this store. It's live with its restaurant. Please pick another store.";
const MAX_PER_LIST = 50;
const CACHE_MS = 30_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const testAccountsDoc = () => firestoreDb.collection("private").doc("testAccounts");
/**
 * Live stores already handed to their restaurant (founder 20 Nov 2026: The Waffle Spot). Test customers
 * can't order there, so a test order never rings at a real kitchen. Its own server-only doc
 * private/noTestOrderStores {storeIds: [...]}, so saving the test-accounts page can't wipe it.
 */
const noTestOrderStoresDoc = () => firestoreDb.collection("private").doc("noTestOrderStores");
/**
 * Stores made for Apple/Google app review (founder 20 Nov 2026: Scraveit Review Restaurant, Grocery,
 * Dairy). A test order there skips the "delivery partners busy" check, so a reviewer far from any test
 * delivery partner can still place an order. private/appReviewStores {storeIds: [...]}, server-only.
 */
const appReviewStoresDoc = () => firestoreDb.collection("private").doc("appReviewStores");
const customerSettingsDoc = () => firestoreDb.collection("settings").doc("customer");

function cleanList(value: unknown, pattern: RegExp | null, lower: boolean): string[] {
  const list = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const entry of list) {
    const text = String(entry ?? "").trim();
    const item = lower ? text.toLowerCase() : text;
    if (!item || item.length > 200 || (pattern && !pattern.test(item)) || out.includes(item)) continue;
    out.push(item);
  }
  return out.slice(0, MAX_PER_LIST);
}

export function cleanTestAccounts(raw: unknown): Omit<TestAccounts, "updatedAt" | "updatedBy"> {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    customers: cleanList(data.customers, EMAIL, true),
    deliveryPartners: cleanList(data.deliveryPartners, EMAIL, true),
    restaurants: cleanList(data.restaurants, EMAIL, true),
    storeIds: cleanList(data.storeIds, /^[A-Za-z0-9_-]{1,120}$/, false),
  };
}

let cache: {at: number; value: TestAccounts} | null = null;
const uidCache = new Map<string, {at: number; uids: Set<string>}>();

export function forgetTestAccountsCache(): void {
  cache = null;
  noTestCache = null;
  reviewCache = null;
  uidCache.clear();
}

export async function loadTestAccounts(): Promise<TestAccounts> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const snapshot = await testAccountsDoc().get();
  const data = (snapshot.exists ? snapshot.data() : {}) as Record<string, unknown>;
  const value: TestAccounts = {
    ...cleanTestAccounts(data),
    updatedAt: Number(data.updatedAt ?? 0),
    updatedBy: String(data.updatedBy ?? ""),
  };
  cache = {at: Date.now(), value};
  return value;
}

/** Account ids for a list of emails; only Google-verified or otherwise verified emails count. */
async function uidsForEmails(emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const key = emails.join(",");
  const hit = uidCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.uids;
  const uids = new Set<string>();
  try {
    for (let i = 0; i < emails.length; i += 100) {
      const result = await auth.getUsers(emails.slice(i, i + 100).map((email) => ({email})));
      for (const user of result.users) if (user.emailVerified) uids.add(user.uid);
    }
  } catch (error) {
    // Never let a lookup failure stop real orders or offers: nobody counts as a test account this time.
    logger.warn("TEST_ACCOUNTS_LOOKUP_FAILED", {error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
    return new Set();
  }
  uidCache.set(key, {at: Date.now(), uids});
  return uids;
}

/** The lists, or empty lists when they can't be read (so real customers and dispatch are never blocked). */
async function accountsOrEmpty(): Promise<TestAccounts> {
  try {
    return await loadTestAccounts();
  } catch (error) {
    logger.warn("TEST_ACCOUNTS_READ_FAILED", {error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
    return {customers: [], deliveryPartners: [], restaurants: [], storeIds: [], updatedAt: 0, updatedBy: ""};
  }
}

export async function isTestCustomer(uid: string): Promise<boolean> {
  return (await uidsForEmails((await accountsOrEmpty()).customers)).has(uid);
}

export async function testDeliveryPartnerUids(): Promise<Set<string>> {
  return uidsForEmails((await accountsOrEmpty()).deliveryPartners);
}

let noTestCache: {at: number; ids: string[]} | null = null;

/** Throws when the list can't be read: a test order is refused rather than risk ringing a real store. */
async function noTestOrderStoreIds(): Promise<string[]> {
  if (noTestCache && Date.now() - noTestCache.at < CACHE_MS) return noTestCache.ids;
  const snapshot = await noTestOrderStoresDoc().get();
  const ids = cleanList((snapshot.exists ? snapshot.data() : {})?.storeIds, /^[A-Za-z0-9_-]{1,120}$/, false);
  noTestCache = {at: Date.now(), ids};
  return ids;
}

let reviewCache: {at: number; ids: string[]} | null = null;

/** An app-review store; false when the list can't be read (the normal busy check then applies). */
export async function isAppReviewStore(restaurantId: string): Promise<boolean> {
  try {
    if (!reviewCache || Date.now() - reviewCache.at >= CACHE_MS) {
      const snapshot = await appReviewStoresDoc().get();
      reviewCache = {at: Date.now(), ids: cleanList((snapshot.exists ? snapshot.data() : {})?.storeIds, /^[A-Za-z0-9_-]{1,120}$/, false)};
    }
    return reviewCache.ids.includes(restaurantId);
  } catch (error) {
    logger.warn("APP_REVIEW_STORES_READ_FAILED", {error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
    return false;
  }
}

export async function isTestStore(restaurantId: string): Promise<boolean> {
  return (await accountsOrEmpty()).storeIds.includes(restaurantId);
}

/** The order rule, decided from the three facts (kept pure for tests). */
export function orderRule(input: {testCustomer: boolean; testStore: boolean; openingSoon: boolean; noTestOrders?: boolean}): string | null {
  if (input.testCustomer) return input.noTestOrders ? NO_TEST_ORDERS_MESSAGE : null;
  if (input.testStore) return REAL_CUSTOMER_TEST_STORE_MESSAGE;
  return input.openingSoon ? OPENING_SOON_MESSAGE : null;
}

/** Called by createAuthoritativeOrder for every order (COD, online, multi-store, parent pay, meal plans). */
export async function assertMayPlaceOrder(uid: string, restaurantId: string): Promise<{testOrder: boolean}> {
  const [testCustomer, testStore, settings] = await Promise.all([
    isTestCustomer(uid),
    isTestStore(restaurantId),
    customerSettingsDoc().get().then((snapshot) => (snapshot.exists ? snapshot.data() : null)),
  ]);
  let noTestOrders = false;
  if (testCustomer) {
    try {
      noTestOrders = (await noTestOrderStoreIds()).includes(restaurantId);
    } catch (error) {
      logger.warn("NO_TEST_ORDER_STORES_READ_FAILED", {error: error instanceof Error ? error.message.slice(0, 200) : "unknown"});
      throw new DomainError("unavailable", "Couldn't check this store right now. Please try again.");
    }
  }
  const refused = orderRule({testCustomer, testStore, openingSoon: isOpeningSoon(settings), noTestOrders});
  if (refused) throw new DomainError("failed-precondition", refused);
  return {testOrder: testCustomer};
}

export interface TestAccountsView extends TestAccounts {
  /** Which listed emails already have a verified account (true) or haven't signed up yet (false). */
  signedUp: Record<string, boolean>;
  stores: Array<{id: string; name: string; open: boolean; kind: string}>;
}

async function view(accounts: TestAccounts): Promise<TestAccountsView> {
  const emails = [...new Set([...accounts.customers, ...accounts.deliveryPartners, ...accounts.restaurants])];
  const signedUp: Record<string, boolean> = Object.fromEntries(emails.map((email) => [email, false]));
  for (let i = 0; i < emails.length; i += 100) {
    const result = await auth.getUsers(emails.slice(i, i + 100).map((email) => ({email})));
    for (const user of result.users) if (user.email && user.emailVerified) signedUp[user.email.toLowerCase()] = true;
  }
  const snapshot = await firestoreDb.collection("restaurants").select("name", "open", "archived", "storeType", "type").get();
  const stores = snapshot.docs
    .map((doc) => ({doc, data: doc.data() as Record<string, unknown>}))
    .filter(({data}) => data.archived !== true)
    .map(({doc, data}) => ({id: doc.id, name: String(data.name ?? doc.id), open: data.open === true, kind: String(data.storeType ?? data.type ?? "restaurant")}))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {...accounts, signedUp, stores};
}

export async function readTestAccounts(): Promise<TestAccountsView> {
  forgetTestAccountsCache();
  return view(await loadTestAccounts());
}

export async function saveTestAccounts(uid: string, input: unknown): Promise<TestAccountsView> {
  const clean = cleanTestAccounts(input);
  const known = new Set((await firestoreDb.collection("restaurants").select().get()).docs.map((doc) => doc.id));
  const unknown = clean.storeIds.filter((id) => !known.has(id));
  if (unknown.length) throw new DomainError("invalid-argument", `Unknown store: ${unknown[0]}`);
  const value: TestAccounts = {...clean, updatedAt: Date.now(), updatedBy: uid};
  await testAccountsDoc().set(value);
  // Public copy of the store ids only (no emails): the customer app hides these stores from real customers.
  await customerSettingsDoc().set({testStoreIds: clean.storeIds}, {merge: true});
  logger.info("TEST_ACCOUNTS_SAVED", {
    uid, customers: clean.customers.length, deliveryPartners: clean.deliveryPartners.length,
    restaurants: clean.restaurants.length, storeIds: clean.storeIds,
  });
  forgetTestAccountsCache();
  return view(value);
}

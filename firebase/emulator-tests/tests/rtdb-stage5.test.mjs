import assert from "node:assert/strict";
import {after, before, beforeEach, describe, test} from "node:test";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {get, ref, set} from "firebase/database";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const firebaseDirectory = resolve(testDirectory, "../..");
const rules = readFileSync(
  resolve(firebaseDirectory, "feastly-realtime-database-rules.operational-projections-stage5.json"),
  "utf8",
);

const emulatorAddress = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!emulatorAddress) {
  throw new Error(
    "FIREBASE_DATABASE_EMULATOR_HOST is missing. Run `npm run test:stage5`; this suite refuses to contact any non-emulator database.",
  );
}

const separator = emulatorAddress.lastIndexOf(":");
const host = emulatorAddress.slice(0, separator);
const port = Number(emulatorAddress.slice(separator + 1));
if (!host || !Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid FIREBASE_DATABASE_EMULATOR_HOST: ${emulatorAddress}`);
}
if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error(
    `Refusing non-local database host ${host}; this suite may run only against a loopback emulator.`,
  );
}

const PROJECT_ID = "demo-scraveit-rules-stage5";
const CUSTOMER_A = "customer-a";
const CUSTOMER_B = "customer-b";
const RESTAURANT_A = "restaurant-a";
const RESTAURANT_B = "restaurant-b";
const STAFF_A = "staff-a";
const STAFF_B = "staff-b";
const RIDER_A = "rider-a";
const RIDER_B = "rider-b";
const OWNER = "owner-a";
const ORDER_PENDING = "order-pending";
const ORDER_ASSIGNED = "order-assigned";
const SEEDED_AT = 1_700_000_000_000;

let testEnv;

function authContext(uid, token = {}) {
  return testEnv.authenticatedContext(uid, {
    email: `${uid}@example.test`,
    email_verified: true,
    ...token,
  });
}

function dbRef(context, path) {
  return ref(context.database(), path);
}

function fixture() {
  const restaurant = (id, name) => ({
    id,
    name,
    address: `${name} address`,
    etaMin: 20,
    etaMax: 35,
    deliveryFee: 29,
    platformFee: 10,
    open: true,
    archived: false,
    updatedAt: SEEDED_AT,
  });

  const order = (id, status, riderId = undefined) => ({
    id,
    customerId: CUSTOMER_A,
    restaurantId: RESTAURANT_A,
    restaurant: "Restaurant A",
    status,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    ...(riderId ? {riderId} : {}),
  });

  return {
    feastly: {
      users: {
        [CUSTOMER_A]: {
          name: "Customer A",
          email: `${CUSTOMER_A}@example.test`,
          phone: "9999999999",
          selectedAddressId: "home",
          updatedAt: SEEDED_AT,
          preferences: {theme: "system", vegetarian: false, notifications: true},
        },
        [CUSTOMER_B]: {
          name: "Customer B",
          email: `${CUSTOMER_B}@example.test`,
          phone: "8888888888",
          selectedAddressId: "home",
          updatedAt: SEEDED_AT,
        },
      },
      catalog: {
        restaurants: {
          [RESTAURANT_A]: restaurant(RESTAURANT_A, "Restaurant A"),
          [RESTAURANT_B]: restaurant(RESTAURANT_B, "Restaurant B"),
        },
      },
      staff: {
        [STAFF_A]: {
          active: true,
          restaurantId: RESTAURANT_A,
          role: "restaurant_manager",
          permissions: {orders: true, availability: true},
        },
        [STAFF_B]: {
          active: true,
          restaurantId: RESTAURANT_B,
          role: "restaurant_manager",
          permissions: {orders: true, availability: true},
        },
      },
      restaurantOrders: {
        [RESTAURANT_A]: {
          [CUSTOMER_A]: {
            [ORDER_PENDING]: order(ORDER_PENDING, "Order placed"),
            [ORDER_ASSIGNED]: order(ORDER_ASSIGNED, "Assigned", RIDER_A),
          },
        },
        [RESTAURANT_B]: {
          [CUSTOMER_B]: {
            "order-b": {
              ...order("order-b", "Order placed"),
              customerId: CUSTOMER_B,
              restaurantId: RESTAURANT_B,
              restaurant: "Restaurant B",
            },
          },
        },
      },
      orders: {
        [CUSTOMER_A]: {
          [ORDER_PENDING]: order(ORDER_PENDING, "Order placed"),
          [ORDER_ASSIGNED]: order(ORDER_ASSIGNED, "Assigned", RIDER_A),
        },
        [CUSTOMER_B]: {
          "order-b": {
            ...order("order-b", "Order placed"),
            customerId: CUSTOMER_B,
            restaurantId: RESTAURANT_B,
            restaurant: "Restaurant B",
          },
        },
      },
      riders: {
        [RIDER_A]: {status: "approved"},
        [RIDER_B]: {status: "approved"},
      },
      riderJobs: {
        [RIDER_A]: {
          [ORDER_ASSIGNED]: {
            orderId: ORDER_ASSIGNED,
            customerId: CUSTOMER_A,
            restaurantId: RESTAURANT_A,
            assignedAt: SEEDED_AT,
            status: "active",
            phase: "pickup",
          },
        },
      },
      dispatchQueue: {
        [ORDER_PENDING]: {
          id: ORDER_PENDING,
          orderId: ORDER_PENDING,
          customerId: CUSTOMER_A,
          restaurantId: RESTAURANT_A,
          restaurantName: "Restaurant A",
          restaurantAddress: "Restaurant A address",
          restaurantArea: "Test area",
          approximateDropZone: "Service area",
          itemCount: 1,
          payout: 29,
          estimatedMinutes: 30,
          active: true,
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        },
      },
      private: {
        financialLedger: {journals: {journal1: {amountPaise: 10000}}},
        operations: {orders: {privateOrder: {status: "Accepted"}}},
      },
      paymentAttempts: {attempt1: {status: "pending"}},
      riderWallets: {[RIDER_A]: {codOutstanding: 500}},
      settings: {
        customer: {
          platformFee: 10,
          freeDeliveryAbove: 500,
          taxRate: 0,
          deliverySlabs: [{maxKm: 5, fee: 29}],
          maxDeliveryKm: 20,
          updatedAt: SEEDED_AT,
          updatedBy: OWNER,
        },
      },
    },
  };
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {host, port, rules},
  });
});

beforeEach(async () => {
  await testEnv.clearDatabase();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await set(dbRef(context, "/"), fixture());
  });
});

after(async () => {
  await testEnv?.cleanup();
});

describe("customer order boundaries", () => {
  test("customer can read own order and update own profile preference", async () => {
    const customer = authContext(CUSTOMER_A);
    const order = await assertSucceeds(get(dbRef(customer, `/feastly/orders/${CUSTOMER_A}/${ORDER_PENDING}`)));
    assert.equal(order.val().status, "Order placed");
    await assertSucceeds(set(dbRef(customer, `/feastly/users/${CUSTOMER_A}/preferences/theme`), "dark"));
  });

  test("customer cannot read another customer's order or accept/prepare an order", async () => {
    const customer = authContext(CUSTOMER_A);
    await assertFails(get(dbRef(customer, `/feastly/orders/${CUSTOMER_B}/order-b`)));
    await assertFails(set(dbRef(customer, `/feastly/orders/${CUSTOMER_A}/${ORDER_PENDING}/status`), "Accepted"));
    await assertFails(set(dbRef(customer, `/feastly/orders/${CUSTOMER_A}/${ORDER_PENDING}/status`), "Preparing"));
  });
});

describe("restaurant scoping", () => {
  test("restaurant staff can read their projection and update only their restaurant availability", async () => {
    const staff = authContext(STAFF_A);
    await assertSucceeds(get(dbRef(staff, `/feastly/restaurantOrders/${RESTAURANT_A}`)));
    await assertSucceeds(set(dbRef(staff, `/feastly/catalog/restaurants/${RESTAURANT_A}/open`), false));
  });

  test("restaurant staff cannot read or change another restaurant and cannot bypass server order transitions", async () => {
    const staff = authContext(STAFF_A);
    await assertFails(get(dbRef(staff, `/feastly/restaurantOrders/${RESTAURANT_B}`)));
    await assertFails(set(dbRef(staff, `/feastly/catalog/restaurants/${RESTAURANT_B}/open`), false));
    await assertFails(set(dbRef(staff, `/feastly/orders/${CUSTOMER_B}/order-b/status`), "Accepted"));
    await assertFails(set(dbRef(staff, `/feastly/orders/${CUSTOMER_A}/${ORDER_PENDING}/status`), "Accepted"));
  });
});

describe("rider assignment boundaries", () => {
  test("assigned rider can read own job and record the narrow arrival marker", async () => {
    const rider = authContext(RIDER_A);
    await assertSucceeds(get(dbRef(rider, `/feastly/riderJobs/${RIDER_A}/${ORDER_ASSIGNED}`)));
    await assertSucceeds(set(dbRef(rider, `/feastly/riderJobs/${RIDER_A}/${ORDER_ASSIGNED}/phase`), "at_restaurant"));
    await assertSucceeds(set(dbRef(rider, `/feastly/riderJobs/${RIDER_A}/${ORDER_ASSIGNED}/arrivedRestaurantAt`), Date.now()));
  });

  test("rider cannot claim directly, complete another rider's assignment, or read another rider's job", async () => {
    const rider = authContext(RIDER_B);
    await assertFails(get(dbRef(rider, `/feastly/riderJobs/${RIDER_A}/${ORDER_ASSIGNED}`)));
    await assertFails(set(dbRef(rider, `/feastly/dispatchQueue/${ORDER_PENDING}/claim`), {
      riderId: RIDER_B,
      riderName: "Rider B",
      claimedAt: Date.now(),
    }));
    await assertFails(set(dbRef(rider, `/feastly/riderJobs/${RIDER_A}/${ORDER_ASSIGNED}/status`), "completed"));
    await assertFails(set(dbRef(rider, `/feastly/riderJobs/${RIDER_B}/${ORDER_ASSIGNED}/status`), "completed"));
  });
});

describe("backend-owned and privileged boundaries", () => {
  test("ordinary clients cannot access backend-owned finance, dispatch, or control nodes", async () => {
    const customer = authContext(CUSTOMER_A);
    await assertFails(get(dbRef(customer, "/feastly/private/financialLedger")));
    await assertFails(set(dbRef(customer, "/feastly/private/financialLedger/journals/forged"), {amountPaise: 1}));
    await assertFails(get(dbRef(customer, "/feastly/paymentAttempts")));
    await assertFails(get(dbRef(customer, "/feastly/dispatchQueue")));
    await assertFails(set(dbRef(customer, "/feastly/settings/customer/platformFee"), 0));
    await assertFails(set(dbRef(customer, `/feastly/riderWallets/${RIDER_A}/codOutstanding`), 0));
  });

  test("owner claim grants intended operational reads but private ledgers stay callable-only", async () => {
    const owner = authContext(OWNER, {savrivoRole: "owner"});
    await assertSucceeds(get(dbRef(owner, "/feastly/paymentAttempts")));
    await assertSucceeds(get(dbRef(owner, "/feastly/dispatchQueue")));
    await assertSucceeds(get(dbRef(owner, "/feastly/riderWallets")));
    await assertFails(get(dbRef(owner, "/feastly/private/financialLedger")));
  });

  test("unauthenticated clients cannot access user or operational data", async () => {
    const guest = testEnv.unauthenticatedContext();
    await assertFails(get(dbRef(guest, `/feastly/users/${CUSTOMER_A}`)));
    await assertFails(get(dbRef(guest, `/feastly/orders/${CUSTOMER_A}/${ORDER_PENDING}`)));
    await assertFails(get(dbRef(guest, "/feastly/catalog")));
  });
});

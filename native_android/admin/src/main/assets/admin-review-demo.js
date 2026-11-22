/*
 * App Review mode for the Admin app. Apple's reviewer signs in with a review login whose
 * account carries savrivoRole "app_review". That role has no access anywhere: the database
 * rules, storage rules and every server function accept only "owner" and "ops_admin".
 * premium.js sees the role and reloads into this mode, where every screen runs on the
 * fictional sample data below, held only in memory on the phone. Nothing here reads or
 * writes real Scraveit data, and actions change only the sample copy.
 */
(function () {
  "use strict";
  var KEY = "scraveit.admin.reviewDemo";
  var active = false;
  try { active = localStorage.getItem(KEY) === "1"; } catch (_) {}
  var demo = {
    active: active,
    role: "app_review",
    enter: function () { try { localStorage.setItem(KEY, "1"); } catch (_) {} location.reload(); },
    leave: function () { try { localStorage.removeItem(KEY); } catch (_) {} },
  };
  window.ScraveitAdminDemo = demo;
  if (!active) return;

  var Stub = (function () {
/**
 * In-memory stand-in for the Firebase compat SDK globals premium.js expects
 * (firebase-app-compat, firebase-auth-compat, firebase-firestore-compat).
 *
 * Only the surface the four apps actually call is modelled. Queries follow
 * Firestore's own semantics where the tests depend on them: documents missing
 * an orderBy field are excluded, startAt/endAt are inclusive, startAfter /
 * endBefore are exclusive, and limit applies after the range.
 *
 *   const { firebase, firestore, auth } = createFirebaseCompat({
 *     user: null,                                // signed-out by default
 *     collections: { restaurants: { id: data } } // optional seed data
 *   });
 *   context.firebase = firebase;
 *
 * `user` may be a plain `{uid, email, idToken?}`; it is given getIdToken()
 * (resolving to `idToken` when set) and reload().
 * `offline: true` makes every Firestore read fail the way the SDK does with
 * no connection. `firestore.queries` counts every query/doc read,
 * `firestore.reads` lists them as {type, path, spec}, `firestore.writes`
 * lists every set/update/delete as {type, path, data}, and
 * `firestore.beforeRead` can be set to a function that throws to simulate one
 * failing request.
 */

const DOCUMENT_ID = Object.freeze({ __fieldPath: "__name__" });

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fieldValue(data, id, field) {
  if (field === DOCUMENT_ID || field === "__name__") return id;
  return String(field).split(".").reduce((value, key) => (value == null ? undefined : value[key]), data);
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function matches(value, op, expected) {
  switch (op) {
    case "==": return value === expected;
    case "!=": return value !== undefined && value !== expected;
    case "<": return value < expected;
    case "<=": return value <= expected;
    case ">": return value > expected;
    case ">=": return value >= expected;
    case "in": return Array.isArray(expected) && expected.includes(value);
    case "not-in": return Array.isArray(expected) && value !== undefined && !expected.includes(value);
    case "array-contains": return Array.isArray(value) && value.includes(expected);
    case "array-contains-any": return Array.isArray(value) && Array.isArray(expected) && expected.some(item => value.includes(item));
    default: throw new Error(`firebase stub: unsupported where operator ${op}`);
  }
}

function createFirestore(seed) {
  // path -> data, where path is "collection/doc[/collection/doc...]".
  const docs = new Map();
  const db = {
    queries: 0,
    reads: [],
    writes: [],
    beforeRead: null,
  };

  function read(description) {
    db.queries++;
    db.reads.push(description);
    if (typeof db.beforeRead === "function") db.beforeRead(description);
  }

  function documentSnapshot(path) {
    const id = path.split("/").pop();
    const stored = docs.get(path);
    return {
      id,
      exists: stored !== undefined,
      ref: docRef(path),
      data() { return clone(stored); },
      get(field) { return clone(fieldValue(stored || {}, id, field)); },
    };
  }

  function querySnapshot(paths) {
    const list = paths.map(documentSnapshot);
    return {
      docs: list,
      size: list.length,
      empty: list.length === 0,
      forEach(callback) { list.forEach(callback); },
      docChanges() { return list.map(doc => ({ type: "added", doc })); },
    };
  }

  function applyWrite(path, data, merge) {
    const resolved = resolveSentinels(data, docs.get(path));
    docs.set(path, merge ? Object.assign({}, docs.get(path) || {}, resolved) : resolved);
  }

  function resolveSentinels(data, previous) {
    const out = {};
    Object.keys(data || {}).forEach(key => {
      const value = data[key];
      if (value && value.__sentinel === "delete") return;
      if (value && value.__sentinel === "serverTimestamp") out[key] = Date.now();
      else if (value && value.__sentinel === "increment") out[key] = Number((previous || {})[key] || 0) + value.by;
      else if (value && value.__sentinel === "arrayUnion") out[key] = Array.from(new Set([...((previous || {})[key] || []), ...value.items]));
      else if (value && value.__sentinel === "arrayRemove") out[key] = ((previous || {})[key] || []).filter(item => !value.items.includes(item));
      else out[key] = clone(value);
    });
    return out;
  }

  function docRef(path) {
    const id = path.split("/").pop();
    return {
      id,
      path,
      get parent() { const parts = path.split("/"); const col = parts.slice(0, -1).join("/"); return { id: parts[parts.length - 2], path: col, parent: parts.length > 2 ? docRef(parts.slice(0, -2).join("/")) : null }; },
      collection(name) { return collectionRef(`${path}/${name}`); },
      async get() { read({ type: "doc", path }); return documentSnapshot(path); },
      async set(data, options) {
        db.writes.push({ type: "set", path, data: clone(data) });
        applyWrite(path, data, !!(options && options.merge));
      },
      async update(data) {
        db.writes.push({ type: "update", path, data: clone(data) });
        if (!docs.has(path)) throw Object.assign(new Error(`No document to update: ${path}`), { code: "not-found" });
        applyWrite(path, data, true);
      },
      async delete() { db.writes.push({ type: "delete", path }); docs.delete(path); },
      onSnapshot(first, second, third) {
        // Firestore also takes an options object before the callbacks.
        const [next, error] = typeof first === "function" ? [first, second] : [second, third];
        Promise.resolve().then(() => {
          try { read({ type: "doc", path }); } catch (failure) { if (error) error(failure); return; }
          next(documentSnapshot(path));
        });
        return () => {};
      },
    };
  }

  function query(collectionPath, spec, group) {
    const base = {
      where(field, op, value) { return query(collectionPath, { ...spec, filters: [...spec.filters, { field, op, value }] }, group); },
      orderBy(field, direction) { return query(collectionPath, { ...spec, orders: [...spec.orders, { field, direction: direction || "asc" }] }, group); },
      limit(count) { return query(collectionPath, { ...spec, limit: count }, group); },
      limitToLast(count) { return query(collectionPath, { ...spec, limitToLast: count }, group); },
      startAt(...values) { return query(collectionPath, { ...spec, start: { values, inclusive: true } }, group); },
      startAfter(...values) { return query(collectionPath, { ...spec, start: { values, inclusive: false } }, group); },
      endAt(...values) { return query(collectionPath, { ...spec, end: { values, inclusive: true } }, group); },
      endBefore(...values) { return query(collectionPath, { ...spec, end: { values, inclusive: false } }, group); },
      get spec() { return spec; },
      async get() {
        read({ type: "query", path: collectionPath, spec });
        return querySnapshot(run());
      },
      onSnapshot(next, error) {
        Promise.resolve().then(() => {
          try { read({ type: "query", path: collectionPath, spec }); } catch (failure) { if (error) error(failure); return; }
          next(querySnapshot(run()));
        });
        return () => {};
      },
    };

    function cursorValue(values, data, id) {
      // A document snapshot passed as a cursor stands for its orderBy values.
      if (values.length === 1 && values[0] && typeof values[0].data === "function") {
        const snap = values[0];
        return spec.orders.map(order => fieldValue(snap.data() || {}, snap.id, order.field));
      }
      return values;
    }

    function run() {
      const depth = collectionPath.split("/").length;
      let rows = [];
      docs.forEach((data, path) => {
        const parts = path.split("/");
        const inCollection = group
          ? parts.length % 2 === 0 && parts[parts.length - 2] === collectionPath
          : parts.length === depth + 1 && path.startsWith(collectionPath + "/");
        if (inCollection) rows.push({ path, id: parts[parts.length - 1], data });
      });
      rows = rows.filter(row => spec.filters.every(f => matches(fieldValue(row.data, row.id, f.field), f.op, f.value)));
      // Firestore omits documents that do not have every orderBy field.
      rows = rows.filter(row => spec.orders.every(o => fieldValue(row.data, row.id, o.field) !== undefined));
      const keyOf = row => spec.orders.map(o => fieldValue(row.data, row.id, o.field));
      const sortKey = (a, b) => {
        for (let i = 0; i < spec.orders.length; i++) {
          const result = compare(a[i], b[i]) * (spec.orders[i].direction === "desc" ? -1 : 1);
          if (result) return result;
        }
        return 0;
      };
      rows.sort((a, b) => sortKey(keyOf(a), keyOf(b)) || compare(a.id, b.id));
      if (spec.start) {
        const bound = cursorValue(spec.start.values);
        rows = rows.filter(row => {
          const result = sortKey(keyOf(row).slice(0, bound.length), bound);
          return spec.start.inclusive ? result >= 0 : result > 0;
        });
      }
      if (spec.end) {
        const bound = cursorValue(spec.end.values);
        rows = rows.filter(row => {
          const result = sortKey(keyOf(row).slice(0, bound.length), bound);
          return spec.end.inclusive ? result <= 0 : result < 0;
        });
      }
      if (spec.limit != null) rows = rows.slice(0, spec.limit);
      if (spec.limitToLast != null) rows = rows.slice(-spec.limitToLast);
      return rows.map(row => row.path);
    }

    return base;
  }

  function collectionRef(path) {
    const ref = query(path, { filters: [], orders: [] }, false);
    ref.id = path.split("/").pop();
    ref.path = path;
    ref.doc = id => docRef(`${path}/${id == null ? `auto-${docs.size + 1}-${Math.random().toString(36).slice(2, 8)}` : id}`);
    ref.add = async data => { const created = ref.doc(); await created.set(data); return created; };
    return ref;
  }

  db.collection = name => collectionRef(name);
  db.doc = path => docRef(path);
  db.collectionGroup = name => query(name, { filters: [], orders: [] }, true);
  db.batch = () => {
    const pending = [];
    return {
      set(ref, data, options) { pending.push(() => ref.set(data, options)); return this; },
      update(ref, data) { pending.push(() => ref.update(data)); return this; },
      delete(ref) { pending.push(() => ref.delete()); return this; },
      async commit() { for (const write of pending) await write(); },
    };
  };
  db.runTransaction = async callback => callback({
    get: ref => ref.get(),
    set(ref, data, options) { ref.set(data, options); return this; },
    update(ref, data) { ref.update(data); return this; },
    delete(ref) { ref.delete(); return this; },
  });
  db.enablePersistence = async () => {};
  db.settings = () => {};
  /** Seeds `{collectionPath: {docId: data}}` directly, bypassing reads. */
  db.seed = collections => {
    Object.keys(collections || {}).forEach(collection => {
      Object.keys(collections[collection] || {}).forEach(id => docs.set(`${collection}/${id}`, clone(collections[collection][id])));
    });
  };
  db.seed(seed);
  return db;
}

function signedInUser(user) {
  if (!user) return null;
  return Object.assign({
    emailVerified: true,
    displayName: user.name || "",
    providerData: [],
    async getIdToken() { return user.idToken || `stub-id-token-${user.uid}`; },
    async getIdTokenResult() { return { token: user.idToken || `stub-id-token-${user.uid}`, claims: user.claims || {} }; },
    async reload() {},
  }, user);
}

function createAuth(user) {
  const listeners = [];
  const auth = {
    currentUser: signedInUser(user),
    onAuthStateChanged(callback) {
      listeners.push(callback);
      Promise.resolve().then(() => callback(auth.currentUser));
      return () => { const index = listeners.indexOf(callback); if (index >= 0) listeners.splice(index, 1); };
    },
    onIdTokenChanged(callback) { return auth.onAuthStateChanged(callback); },
    async signOut() { auth.currentUser = null; listeners.forEach(callback => callback(null)); },
    setPersistence: async () => {},
  };
  const offline = name => async () => {
    throw Object.assign(new Error(`firebase stub: ${name} is not available in tests`), { code: "auth/network-request-failed" });
  };
  ["signInWithEmailAndPassword", "createUserWithEmailAndPassword", "signInWithCredential",
    "sendPasswordResetEmail", "signInAnonymously"].forEach(name => { auth[name] = offline(name); });
  return auth;
}

function createFirebaseCompat(options) {
  const settings = options || {};
  const firestore = createFirestore(settings.collections);
  if (settings.offline) {
    firestore.beforeRead = () => {
      throw Object.assign(new Error("Failed to get document because the client is offline."), { code: "unavailable" });
    };
  }
  const auth = createAuth(settings.user);
  const sentinel = (kind, extra) => Object.freeze(Object.assign({ __sentinel: kind }, extra));

  const firestoreFactory = () => firestore;
  firestoreFactory.FieldPath = { documentId: () => DOCUMENT_ID };
  firestoreFactory.FieldValue = {
    serverTimestamp: () => sentinel("serverTimestamp"),
    delete: () => sentinel("delete"),
    increment: by => sentinel("increment", { by }),
    arrayUnion: (...items) => sentinel("arrayUnion", { items }),
    arrayRemove: (...items) => sentinel("arrayRemove", { items }),
  };
  firestoreFactory.Timestamp = {
    now: () => ({ toMillis: () => Date.now() }),
    fromMillis: value => ({ toMillis: () => value }),
  };

  const authFactory = () => auth;
  authFactory.GoogleAuthProvider = { credential: (idToken, accessToken) => ({ providerId: "google.com", idToken, accessToken }) };
  authFactory.Auth = { Persistence: { LOCAL: "local", SESSION: "session", NONE: "none" } };

  const apps = [];
  const firebase = {
    apps,
    initializeApp(config) { const app = { name: "[DEFAULT]", options: config || {} }; apps.push(app); return app; },
    app() { return apps[0]; },
    auth: authFactory,
    firestore: firestoreFactory,
  };
  return { firebase, firestore, auth };
}

return { createFirebaseCompat, createFirestore, DOCUMENT_ID };
  })();

  var now = Date.now(), min = 60000, day = 86400000;
  var city = "Nellore";
  function pt(lat, lng) { return { lat: lat, lng: lng }; }
  var stores = {
    "sample-biryani": { name: "Sample Biryani House", storeType: "restaurant", cuisine: "Biryani, North Indian", area: "Magunta Layout", rating: 4.5, ratingCount: 128, commissionBps: 1500, location: pt(14.4426, 79.9865) },
    "sample-tiffins": { name: "Sample Tiffin Centre", storeType: "restaurant", cuisine: "South Indian, Tiffins", area: "Stonehousepet", rating: 4.3, ratingCount: 86, commissionBps: 1200, location: pt(14.4380, 79.9750) },
    "sample-mart": { name: "Sample Fresh Mart", storeType: "grocery", cuisine: "Groceries", area: "Balaji Nagar", rating: 4.4, ratingCount: 41, commissionBps: 800, location: pt(14.4470, 79.9920) },
    "sample-pharmacy": { name: "Sample Health Care", storeType: "pharmacy", cuisine: "Medicines", area: "Dargamitta", rating: 4.6, ratingCount: 22, commissionBps: 700, location: pt(14.4510, 79.9800) },
  };
  var restaurants = {}, members = {}, items = {};
  Object.keys(stores).forEach(function (id, i) {
    var s = stores[id];
    restaurants[id] = {
      id: id, name: s.name, storeType: s.storeType, cuisine: s.cuisine, city: city, area: s.area,
      address: (12 + i) + " Sample Street, " + s.area + ", " + city, open: true, approved: true, status: "approved",
      rating: s.rating, ratingCount: s.ratingCount, commissionBps: s.commissionBps,
      lat: s.location.lat, lng: s.location.lng, location: s.location, phone: "+91 90000 0001" + i,
      ownerName: "Sample Owner " + (i + 1), ownerEmail: "owner" + (i + 1) + "@example.com",
      deliveryMinutes: 25 + i * 5, createdAt: now - (60 - i * 9) * day, updatedAt: now - i * day,
    };
    members["m-" + id] = { restaurantId: id, uid: "sample-owner-" + (i + 1), role: "restaurant_owner", name: "Sample Owner " + (i + 1), email: "owner" + (i + 1) + "@example.com", active: true, createdAt: now - 50 * day };
  });
  items["menus/sample-biryani/items"] = {
    i1: { name: "Chicken Dum Biryani", price: 229, category: "Biryani", veg: false, available: true },
    i2: { name: "Paneer Biryani", price: 199, category: "Biryani", veg: true, available: true },
    i3: { name: "Double Ka Meetha", price: 89, category: "Desserts", veg: true, available: true },
  };
  items["menus/sample-tiffins/items"] = {
    i1: { name: "Ghee Masala Dosa", price: 79, category: "Dosa", veg: true, available: true },
    i2: { name: "Idli (2)", price: 45, category: "Idli", veg: true, available: true },
  };
  items["menus/sample-mart/items"] = { i1: { name: "Toned Milk 500 ml", price: 28, category: "Dairy", veg: true, available: true } };
  items["menus/sample-pharmacy/items"] = { i1: { name: "Hand Sanitiser 100 ml", price: 55, category: "Personal care", veg: true, available: true } };

  var riders = {
    "sample-partner-1": { name: "Sample Partner One", phone: "+91 90000 00021", status: "approved", vehicleType: "bike", city: city, approvedAt: now - 30 * day, createdAt: now - 32 * day, rating: 4.8 },
    "sample-partner-2": { name: "Sample Partner Two", phone: "+91 90000 00022", status: "approved", vehicleType: "scooter", city: city, approvedAt: now - 20 * day, createdAt: now - 21 * day, rating: 4.7 },
    "sample-partner-3": { name: "Sample Applicant", phone: "+91 90000 00023", status: "submitted", vehicleType: "bike", city: city, createdAt: now - 1 * day },
  };
  var users = {
    "sample-customer-1": { name: "Sample Customer One", phone: "+91 90000 00031", email: "customer1@example.com", city: city, createdAt: now - 25 * day },
    "sample-customer-2": { name: "Sample Customer Two", phone: "+91 90000 00032", email: "customer2@example.com", city: city, createdAt: now - 12 * day },
    "sample-customer-3": { name: "Sample Customer Three", phone: "+91 90000 00033", email: "customer3@example.com", city: city, createdAt: now - 3 * day },
  };
  var applications = {
    "sample-application-1": { restaurantName: "Sample Cafe", ownerName: "Sample Applicant", email: "cafe.owner@example.com", phone: "+91 90000 00041", storeType: "restaurant", city: city, area: "Vedayapalem", address: "4 Sample Road, Vedayapalem, Nellore", status: "submitted", createdAt: now - 3 * 3600000, submittedAt: now - 3 * 3600000 },
  };

  function line(name, price, quantity) { return { name: name, price: price, quantity: quantity || 1 }; }
  var orderSeeds = [
    ["900000000000101", "sample-biryani", "sample-customer-1", "Order placed", 4, "", [line("Chicken Dum Biryani", 229), line("Double Ka Meetha", 89)], "cod"],
    ["900000000000102", "sample-tiffins", "sample-customer-2", "Preparing", 12, "", [line("Ghee Masala Dosa", 79, 2), line("Idli (2)", 45)], "upi"],
    ["900000000000103", "sample-biryani", "sample-customer-3", "Out for delivery", 28, "sample-partner-1", [line("Paneer Biryani", 199)], "cod"],
    ["900000000000104", "sample-mart", "sample-customer-1", "Delivered", 180, "sample-partner-2", [line("Toned Milk 500 ml", 28, 4)], "upi"],
    ["900000000000105", "sample-pharmacy", "sample-customer-2", "Delivered", 26 * 60, "sample-partner-1", [line("Hand Sanitiser 100 ml", 55, 2)], "cod"],
  ];
  var orders = {}, projections = [], restaurantOrders = {}, riderJobs = {};
  orderSeeds.forEach(function (o) {
    var subtotal = o[6].reduce(function (s, x) { return s + x.price * x.quantity; }, 0), fee = 25, total = subtotal + fee;
    var created = now - o[4] * min, terminal = o[3] === "Delivered" || o[3] === "Cancelled";
    var store = restaurants[o[1]], customer = users[o[2]];
    var doc = {
      id: o[0], orderId: o[0], restaurantId: o[1], restaurantName: store.name, restaurant: store.name, storeType: store.storeType,
      customerId: o[2], userId: o[2], customerName: customer.name, status: o[3], riderId: o[5], riderName: o[5] ? riders[o[5]].name : "",
      items: o[6], subtotal: subtotal, deliveryFee: fee, total: total, paymentMethod: o[7], paymentState: o[7] === "cod" ? "cod_pending" : "paid",
      address: { address: "Sample Colony, " + city, area: "Sample Colony", city: city }, city: city,
      pricing: { subtotal: subtotal, deliveryFee: fee, discount: 0, total: total },
      createdAt: created, updatedAt: created + Math.min(o[4], 40) * min / 2, deliveredAt: o[3] === "Delivered" ? created + 32 * min : 0,
    };
    orders[o[0]] = doc;
    restaurantOrders[o[0]] = doc;
    if (o[5]) riderJobs[o[5] + "_" + o[0]] = { riderId: o[5], orderId: o[0], status: o[3], restaurantName: store.name, updatedAt: doc.updatedAt };
    projections.push({
      orderId: o[0], customerId: o[2], restaurantId: o[1], restaurantName: store.name, riderId: o[5] || "", status: o[3], active: !terminal,
      paymentMethod: o[7], paymentState: doc.paymentState, total: total, currency: "INR", itemCount: o[6].length,
      createdAt: created, updatedAt: doc.updatedAt, terminalAt: terminal ? doc.updatedAt : 0, source: "sample", version: 1,
    });
  });
  var support = {
    "sample-ticket-1": { uid: "sample-customer-2", name: "Sample Customer Two", role: "customer", subject: "Change delivery address", status: "answered", lastMessage: "Your address was updated. Thank you.", lastFrom: "support", updatedAt: now - 2 * 3600000, createdAt: now - 3 * 3600000, orderId: "900000000000102" },
  };
  var seed = {
    restaurants: restaurants, restaurantMembers: members, riders: riders, users: users, orders: orders,
    restaurantOrders: restaurantOrders, riderJobs: riderJobs, restaurantApplications: applications, support: support,
    promotions: { "sample-offer": { code: "SAMPLE10", title: "10% off on first order", percent: 10, maxDiscount: 60, active: true, createdAt: now - 7 * day } },
    audit: { "sample-audit-1": { action: "restaurant_approved", actor: "Sample Admin", target: "Sample Fresh Mart", at: now - 5 * day, createdAt: now - 5 * day } },
    staff: {}, settings: {}, localAds: {}, customerBroadcasts: {},
  };
  Object.keys(items).forEach(function (path) { seed[path] = items[path]; });
  var db = Stub.createFirestore(seed);

  var presence = {
    "sample-partner-1": { online: true, lat: 14.4440, lng: 79.9840, updatedAt: now - 20000, activeOrderId: "900000000000103" },
    "sample-partner-2": { online: true, lat: 14.4405, lng: 79.9790, updatedAt: now - 45000 },
  };
  function statusCounts() {
    var counts = {};
    projections.forEach(function (p) { counts[p.status] = (counts[p.status] || 0) + 1; });
    return counts;
  }
  function dashboard() {
    return {
      scope: "bounded_operational_snapshot", generatedAt: Date.now(),
      activeOrders: projections.filter(function (p) { return p.active; }),
      recentOrders: projections.filter(function (p) { return !p.active; }),
      statusCounts: statusCounts(),
      finance: { scope: "bounded_recent_journals", complete: true, journalCount: 14, invalidJournalCount: 0, oldestOccurredAt: now - 7 * day, newestOccurredAt: now - 30 * min,
        eventCounts: { order_delivered: 2 }, windowNetMovementPaise: { "platform:commission": 9840, "restaurant:payable": 52360, "rider:payable": 9000 } },
      codExposure: { scope: "bounded_positive_cod_exposure", complete: true, truncated: false, riderCount: 1, invalidWalletCount: 0,
        riders: [{ riderId: "sample-partner-1", codOutstandingPaise: 33500, codOutstandingLimitPaise: 500000, codRemittanceReservedPaise: 0, availableToRemitPaise: 33500, codBlocked: false }] },
    };
  }
  var platform = {
    dispatch: { radiusKm: 5, offerSeconds: 30, maxActiveOrdersPerPartner: 2 },
    finance: { payments: { defaultMethod: "cod", codEnabled: true, upiEnabled: true },
      payouts: { upiEnabled: false, impsEnabled: true, neftEnabled: true, highValuePayoutMethod: "neft", automation: { enabled: false, timezone: "Asia/Kolkata" } } },
  };
  function updateOrder(payload) {
    var p = {}; try { p = JSON.parse(payload || "{}"); } catch (_) {}
    var id = String(p.orderId || ""), status = String(p.status || "");
    if (!id || !status) return { ok: true };
    projections.forEach(function (x) { if (x.orderId === id) { x.status = status; x.updatedAt = Date.now(); x.active = status !== "Delivered" && status !== "Cancelled"; } });
    db.collection("orders").doc(id).set({ status: status, updatedAt: Date.now() }, { merge: true });
    return { ok: true, orderId: id, status: status };
  }
  var SAMPLE_INSIGHTS = "{\"generatedAt\":1795288745108,\"days\":30,\"periodStart\":1792696745108,\"kind\":\"all\",\"summary\":{\"orders\":60,\"placed\":54,\"delivered\":54,\"cancelled\":6,\"cancelRatePct\":10,\"gmvPaise\":672400,\"aovPaise\":12452,\"customers\":3,\"newCustomers\":3,\"returningCustomers\":0,\"repeatCustomers\":3,\"repeatRatePct\":100,\"avgItemsPerOrder\":1.6,\"avgDeliveryMinutes\":32,\"discountPaise\":18000,\"offerOrders\":9,\"lapsedCustomers\":0,\"lapsedAfterDays\":21},\"coverage\":{\"customers\":3,\"withGender\":0,\"withAge\":0,\"genderPct\":0,\"agePct\":0},\"genders\":[{\"key\":\"unknown\",\"label\":\"Not shared\",\"orders\":54,\"sharePct\":100,\"customers\":3,\"gmvPaise\":672400,\"aovPaise\":12452}],\"ageBands\":[{\"key\":\"unknown\",\"label\":\"Not shared\",\"orders\":54,\"sharePct\":100,\"customers\":3,\"gmvPaise\":672400,\"aovPaise\":12452}],\"matrix\":[{\"gender\":\"unknown\",\"ageBand\":\"unknown\",\"orders\":54,\"customers\":3,\"sharePct\":100}],\"items\":[{\"itemId\":\"Toned Milk 500 ml\",\"name\":\"Toned Milk 500 ml\",\"restaurantId\":\"sample-mart\",\"restaurantName\":\"Sample Fresh Mart\",\"quantity\":24,\"orders\":13,\"customers\":3,\"revenuePaise\":67200,\"diet\":\"\",\"genders\":{\"female\":0,\"male\":0,\"other\":0,\"unknown\":24},\"ageBands\":{\"18-24\":0,\"25-34\":0,\"35-44\":0,\"45-54\":0,\"55+\":0,\"unknown\":24},\"topAreaKey\":\"balaji-nagar\"},{\"itemId\":\"Hand Sanitiser 100 ml\",\"name\":\"Hand Sanitiser 100 ml\",\"restaurantId\":\"sample-pharmacy\",\"restaurantName\":\"Sample Health Care\",\"quantity\":21,\"orders\":16,\"customers\":3,\"revenuePaise\":115500,\"diet\":\"\",\"genders\":{\"female\":0,\"male\":0,\"other\":0,\"unknown\":21},\"ageBands\":{\"18-24\":0,\"25-34\":0,\"35-44\":0,\"45-54\":0,\"55+\":0,\"unknown\":21},\"topAreaKey\":\"stonehousepet\"},{\"itemId\":\"Ghee Masala Dosa\",\"name\":\"Ghee Masala Dosa\",\"restaurantId\":\"sample-tiffins\",\"restaurantName\":\"Sample Tiffin Centre\",\"quantity\":14,\"orders\":9,\"customers\":2,\"revenuePaise\":110600,\"diet\":\"veg\",\"genders\":{\"female\":0,\"male\":0,\"other\":0,\"unknown\":14},\"ageBands\":{\"18-24\":0,\"25-34\":0,\"35-44\":0,\"45-54\":0,\"55+\":0,\"unknown\":14},\"topAreaKey\":\"magunta-layout\"},{\"itemId\":\"Paneer Biryani\",\"name\":\"Paneer Biryani\",\"restaurantId\":\"sample-biryani\",\"restaurantName\":\"Sample Biryani House\",\"quantity\":9,\"orders\":6,\"customers\":3,\"revenuePaise\":179100,\"diet\":\"veg\",\"genders\":{\"female\":0,\"male\":0,\"other\":0,\"unknown\":9},\"ageBands\":{\"18-24\":0,\"25-34\":0,\"35-44\":0,\"45-54\":0,\"55+\":0,\"unknown\":9},\"topAreaKey\":\"stonehousepet\"},{\"itemId\":\"Idli (2)\",\"name\":\"Idli (2)\",\"restaurantId\":\"sample-tiffins\",\"restaurantName\":\"Sample Tiffin Centre\",\"quantity\":6,\"orders\":4,\"customers\":3,\"revenuePaise\":27000,\"diet\":\"veg\",\"genders\":{\"female\":0,\"male\":0,\"other\":0,\"unknown\":6},\"ageBands\":{\"18-24\":0,\"25-34\":0,\"35-44\":0,\"45-54\":0,\"55+\":0,\"unknown\":6},\"topAreaKey\":\"vedayapalem\"},{\"itemId\":\"Chicken Dum Biryani\",\"name\":\"Chicken Dum Biryani\",\"restaurantId\":\"sample-biryani\",\"restaurantName\":\"Sample Biryani House\",\"quantity\":6,\"orders\":3,\"customers\":2,\"revenuePaise\":137400,\"diet\":\"nonveg\",\"genders\":{\"female\":0,\"male\":0,\"other\":0,\"unknown\":6},\"ageBands\":{\"18-24\":0,\"25-34\":0,\"35-44\":0,\"45-54\":0,\"55+\":0,\"unknown\":6},\"topAreaKey\":\"vedayapalem\"},{\"itemId\":\"Double Ka Meetha\",\"name\":\"Double Ka Meetha\",\"restaurantId\":\"sample-biryani\",\"restaurantName\":\"Sample Biryani House\",\"quantity\":4,\"orders\":3,\"customers\":3,\"revenuePaise\":35600,\"diet\":\"veg\",\"genders\":{\"female\":0,\"male\":0,\"other\":0,\"unknown\":4},\"ageBands\":{\"18-24\":0,\"25-34\":0,\"35-44\":0,\"45-54\":0,\"55+\":0,\"unknown\":4},\"topAreaKey\":\"vedayapalem\"}],\"restaurants\":[{\"restaurantId\":\"sample-pharmacy\",\"name\":\"Sample Health Care\",\"kind\":\"pharmacy\",\"orders\":16,\"sharePct\":29.6,\"customers\":3,\"gmvPaise\":115500,\"aovPaise\":7219,\"delivered\":16,\"cancelled\":0,\"cancelRatePct\":0,\"repeatCustomers\":3,\"avgDeliveryMinutes\":34,\"topItem\":\"Hand Sanitiser 100 ml\"},{\"restaurantId\":\"sample-mart\",\"name\":\"Sample Fresh Mart\",\"kind\":\"grocery\",\"orders\":13,\"sharePct\":24.1,\"customers\":3,\"gmvPaise\":67200,\"aovPaise\":5169,\"delivered\":13,\"cancelled\":4,\"cancelRatePct\":23.5,\"repeatCustomers\":3,\"avgDeliveryMinutes\":30,\"topItem\":\"Toned Milk 500 ml\"},{\"restaurantId\":\"sample-tiffins\",\"name\":\"Sample Tiffin Centre\",\"kind\":\"restaurant\",\"orders\":13,\"sharePct\":24.1,\"customers\":3,\"gmvPaise\":137600,\"aovPaise\":10585,\"delivered\":13,\"cancelled\":1,\"cancelRatePct\":7.1,\"repeatCustomers\":3,\"avgDeliveryMinutes\":31,\"topItem\":\"Ghee Masala Dosa\"},{\"restaurantId\":\"sample-biryani\",\"name\":\"Sample Biryani House\",\"kind\":\"restaurant\",\"orders\":12,\"sharePct\":22.2,\"customers\":3,\"gmvPaise\":352100,\"aovPaise\":29342,\"delivered\":12,\"cancelled\":1,\"cancelRatePct\":7.7,\"repeatCustomers\":3,\"avgDeliveryMinutes\":34,\"topItem\":\"Paneer Biryani\"}],\"groupPicks\":[],\"pairs\":[],\"areas\":[{\"key\":\"vedayapalem\",\"name\":\"Vedayapalem\",\"orders\":17,\"sharePct\":31.5,\"customers\":3,\"gmvPaise\":282300,\"aovPaise\":16606,\"cancelRatePct\":5.6,\"avgDeliveryMinutes\":32,\"lat\":14.425,\"lng\":79.965,\"topItem\":\"Hand Sanitiser 100 ml\",\"topGroup\":\"\"},{\"key\":\"stonehousepet\",\"name\":\"Stonehousepet\",\"orders\":15,\"sharePct\":27.8,\"customers\":3,\"gmvPaise\":192600,\"aovPaise\":12840,\"cancelRatePct\":6.3,\"avgDeliveryMinutes\":35,\"lat\":14.438,\"lng\":79.975,\"topItem\":\"Hand Sanitiser 100 ml\",\"topGroup\":\"\"},{\"key\":\"magunta-layout\",\"name\":\"Magunta Layout\",\"orders\":12,\"sharePct\":22.2,\"customers\":3,\"gmvPaise\":118000,\"aovPaise\":9833,\"cancelRatePct\":25,\"avgDeliveryMinutes\":32,\"lat\":14.4426,\"lng\":79.9865,\"topItem\":\"Ghee Masala Dosa\",\"topGroup\":\"\"},{\"key\":\"balaji-nagar\",\"name\":\"Balaji Nagar\",\"orders\":10,\"sharePct\":18.5,\"customers\":3,\"gmvPaise\":79500,\"aovPaise\":7950,\"cancelRatePct\":0,\"avgDeliveryMinutes\":30,\"lat\":14.447,\"lng\":79.992,\"topItem\":\"Toned Milk 500 ml\",\"topGroup\":\"\"}],\"heat\":[{\"lat\":14.424,\"lng\":79.964,\"orders\":17},{\"lat\":14.44,\"lng\":79.976,\"orders\":15},{\"lat\":14.444,\"lng\":79.988,\"orders\":12},{\"lat\":14.448,\"lng\":79.992,\"orders\":10}],\"timing\":{\"grid\":[[0,1,0,0,0,0,0,0,0,0,0,1,0,0,1,0,1,0,0,0,0,1,0,1],[0,1,1,1,0,0,0,1,0,1,1,0,0,0,1,0,0,0,0,0,0,1,1,0],[0,1,0,0,0,1,0,0,0,0,1,0,0,0,1,1,0,1,0,0,0,1,0,1],[0,0,0,0,1,0,0,0,0,0,0,1,0,1,0,0,0,1,1,1,1,0,0,0],[1,0,0,1,0,0,0,0,0,1,0,1,0,1,0,1,0,2,1,0,2,1,0,0],[0,0,0,0,1,2,1,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0],[1,1,1,1,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0]],\"peak\":{\"day\":4,\"hour\":17,\"orders\":2}},\"daily\":[{\"day\":\"2026-10-23\",\"orders\":0,\"gmvPaise\":0},{\"day\":\"2026-10-24\",\"orders\":2,\"gmvPaise\":48600},{\"day\":\"2026-10-25\",\"orders\":3,\"gmvPaise\":36800},{\"day\":\"2026-10-26\",\"orders\":2,\"gmvPaise\":11100},{\"day\":\"2026-10-27\",\"orders\":4,\"gmvPaise\":52300},{\"day\":\"2026-10-28\",\"orders\":1,\"gmvPaise\":19900},{\"day\":\"2026-10-29\",\"orders\":4,\"gmvPaise\":31400},{\"day\":\"2026-10-30\",\"orders\":1,\"gmvPaise\":11000},{\"day\":\"2026-10-31\",\"orders\":3,\"gmvPaise\":50900},{\"day\":\"2026-11-01\",\"orders\":0,\"gmvPaise\":0},{\"day\":\"2026-11-02\",\"orders\":1,\"gmvPaise\":5500},{\"day\":\"2026-11-03\",\"orders\":2,\"gmvPaise\":21300},{\"day\":\"2026-11-04\",\"orders\":3,\"gmvPaise\":20000},{\"day\":\"2026-11-05\",\"orders\":2,\"gmvPaise\":15800},{\"day\":\"2026-11-06\",\"orders\":4,\"gmvPaise\":28300},{\"day\":\"2026-11-07\",\"orders\":1,\"gmvPaise\":4500},{\"day\":\"2026-11-08\",\"orders\":2,\"gmvPaise\":51400},{\"day\":\"2026-11-09\",\"orders\":1,\"gmvPaise\":5600},{\"day\":\"2026-11-10\",\"orders\":2,\"gmvPaise\":22000},{\"day\":\"2026-11-11\",\"orders\":1,\"gmvPaise\":39800},{\"day\":\"2026-11-12\",\"orders\":0,\"gmvPaise\":0},{\"day\":\"2026-11-13\",\"orders\":5,\"gmvPaise\":43500},{\"day\":\"2026-11-14\",\"orders\":0,\"gmvPaise\":0},{\"day\":\"2026-11-15\",\"orders\":1,\"gmvPaise\":5500},{\"day\":\"2026-11-16\",\"orders\":2,\"gmvPaise\":31600},{\"day\":\"2026-11-17\",\"orders\":1,\"gmvPaise\":5500},{\"day\":\"2026-11-18\",\"orders\":3,\"gmvPaise\":91200},{\"day\":\"2026-11-19\",\"orders\":1,\"gmvPaise\":7900},{\"day\":\"2026-11-20\",\"orders\":2,\"gmvPaise\":11000},{\"day\":\"2026-11-21\",\"orders\":0,\"gmvPaise\":0},{\"day\":\"2026-11-22\",\"orders\":0,\"gmvPaise\":0}],\"payments\":[{\"key\":\"upi\",\"orders\":34,\"sharePct\":63},{\"key\":\"cod\",\"orders\":20,\"sharePct\":37}],\"diet\":{\"veg\":33,\"nonveg\":6,\"egg\":0,\"other\":45,\"totalQuantity\":84,\"lines\":54},\"offers\":[{\"code\":\"SAMPLE10\",\"orders\":9,\"discountPaise\":18000,\"gmvPaise\":131300,\"newCustomers\":1}],\"cancellations\":[{\"by\":\"customer\",\"reason\":\"Ordered by mistake\",\"orders\":6}]}";
  var econ = {
    getAdminToday: function () {
      var now = Date.now(), start = new Date(); start.setHours(0, 0, 0, 0);
      function t(o, d, c, sales, avg) { return { orders: o, delivered: d, cancelled: c, salesPaise: sales, earnedPaise: Math.round(sales * 0.12), storesEarnedPaise: Math.round(sales * 0.88), ridersEarnedPaise: d * 4500, avgDeliveryMinutes: avg }; }
      var zero = t(0, 0, 0, 0, 0);
      return { generatedAt: now, days: 1, periodStart: start.getTime(), all: t(5, 2, 0, 151200, 31),
        byKind: { restaurant: t(3, 1, 0, 118800, 33), grocery: t(1, 1, 0, 22400, 29), dairy: zero, pharmacy: t(1, 0, 0, 10000, 0) },
        lastWeek: t(4, 4, 0, 132000, 34), lastWeekByKind: { restaurant: t(3, 3, 0, 110000, 35), grocery: t(1, 1, 0, 22000, 30), dairy: zero, pharmacy: zero },
        live: { placed: 1, cooking: 1, waitingForRider: 0, onTheWay: 1 }, fssaiExpiring: [] };
    },
    getAdminAnalytics: function () { var a = JSON.parse(SAMPLE_INSIGHTS); a.generatedAt = Date.now(); return a; },
    listTdsCommissionClaimsForReview: function () { return { claims: [] }; },
    listCashbackCampaigns: function () { return { campaigns: [] }; },
    listCustomerReferrals: function () { return { referrals: [] }; },
    getRiderReferralOverview: function () { return { referrals: [], settings: { rewardPaise: 300000, ordersRequired: 300 } }; },
    getStorePayoutsDue: function () { return { stores: [], generatedAt: Date.now() }; },
    getPayoutAutomationStatus: function () { return { enabled: false, lastRunAt: 0 }; },
  };
  demo.firestore = db;
  demo.invoke = function (method, args) {
    args = args || [];
    var value;
    switch (method) {
      case "getAdminDashboard": value = dashboard(); break;
      case "getAdminRiderRewardsDashboard": value = { settings: { enabled: true, currency: "INR" }, campaigns: [], ledger: [], generatedAt: Date.now() }; break;
      case "getPlatformConfiguration": value = JSON.parse(JSON.stringify(platform)); break;
      case "updateOrderStatus": value = updateOrder(args[1]); break;
      case "exportPlatformDataWorkbook": return Promise.reject(new Error("Data export is turned off in App Review mode (sample data only)."));
      case "invokeEconomics": {
        var fn = String(args[0] || "");
        value = econ[fn] ? econ[fn]() : { ok: true };
        break;
      }
      default: value = { ok: true };
    }
    return new Promise(function (resolve) { setTimeout(function () { resolve(value); }, 150); });
  };
  demo.rtdb = function (method, path) {
    var p = String(path || "");
    if (method !== "GET") return Promise.resolve({});
    if (/riderPresence$/.test(p)) return Promise.resolve(JSON.parse(JSON.stringify(presence)));
    return Promise.resolve({});
  };
  demo.request = function (url) {
    var u = String(url || "");
    if (u.indexOf("identitytoolkit") >= 0) return Promise.resolve({ localId: "sample-user-" + Date.now().toString(36), idToken: "sample", email: "sample@example.com" });
    if (u.indexOf("firebasestorage") >= 0) return Promise.resolve({ name: "sample/upload.jpg", downloadTokens: "sample" });
    return Promise.resolve({});
  };
  // No alarms or pushes on a reviewer's phone.
  document.addEventListener("DOMContentLoaded", function () {
    document.body.classList.add("review-demo");
    var nat = window.FeastlyAdminNative;
    if (nat) ["startSupportAlarm"].forEach(function (name) { if (typeof nat[name] === "function") nat[name] = function () {}; });
  });
})();

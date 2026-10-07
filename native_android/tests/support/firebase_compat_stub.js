"use strict";

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
      onSnapshot(next, error) {
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

module.exports = { createFirebaseCompat, createFirestore, DOCUMENT_ID };

import type {CollectionReferenceLike, DocumentReferenceLike, FirestoreLike} from "./firestoreTypes";

/**
 * Shared Firestore ref-builders for the canonical collections that many
 * services touch (mirrors what `pathFor` in config.ts does for the RTDB
 * tree it replaces). Per the Firestore migration plan, `orders/{uid}/{id}`
 * collapses into one flat `orders/{orderId}` collection - customerId and
 * restaurantId become indexed fields instead of path segments, so a lookup
 * that used to need a hand-maintained denormalized copy (keyed under a
 * customer or restaurant path) becomes a `where` query against this single
 * collection instead. `restaurantOrders` (below) is the one exception: it
 * stays a genuinely separate collection, not just a query convenience - see
 * `restaurantOrderProjectionRef`'s comment for why.
 */
export function ordersCollectionRef(database: FirestoreLike): CollectionReferenceLike {
  return database.collection("orders");
}

export function orderRef(database: FirestoreLike, orderId: string): DocumentReferenceLike {
  return ordersCollectionRef(database).doc(orderId);
}

export function riderRef(database: FirestoreLike, uid: string): DocumentReferenceLike {
  return database.collection("riders").doc(uid);
}

export function restaurantRef(database: FirestoreLike, restaurantId: string): DocumentReferenceLike {
  return database.collection("restaurants").doc(restaurantId);
}

// `restaurantMembers/{restaurantId}/{uid}` and the legacy global `staff/{uid}`
// stay two separate reads (not yet collapsed into the plan's single
// `staffMembers` collection) - that collapse depends on the Phase 4 data
// migration actually having run; doing it here first would make every
// membership check silently fail against an empty collection.
export function restaurantMemberRef(database: FirestoreLike, restaurantId: string, uid: string): DocumentReferenceLike {
  return database.collection("restaurantMembers").doc(`${restaurantId}_${uid}`);
}

export function legacyStaffRef(database: FirestoreLike, uid: string): DocumentReferenceLike {
  return database.collection("staff").doc(uid);
}

// Denormalized copy of an order, keyed for restaurant-scoped listing. Still
// ported 1:1 for now (composite id, not the nested RTDB path) - collapsing it
// into a `where` query against the flat `orders` collection depends on the
// bigger orders.ts/dispatch.ts/index.ts conversion, which is every other
// reader of this collection and needs to move in the same pass.
// One document holds `dispatch`, `finance`, `_operations` and `_meta` as
// fields together - platformConfigControl.ts reads/writes the whole thing
// atomically, while platformConfig.ts's cached loaders read just one field.
export function platformConfigRef(database: FirestoreLike): DocumentReferenceLike {
  return database.collection("platformConfig").doc("config");
}

export function riderJobsCollectionRef(database: FirestoreLike): CollectionReferenceLike {
  return database.collection("riderJobs");
}

export function riderJobRef(database: FirestoreLike, riderId: string, orderId: string): DocumentReferenceLike {
  return riderJobsCollectionRef(database).doc(`${riderId}_${orderId}`);
}

// The plan's target is to collapse this with the embedded `restaurant.menu`
// field into one `restaurants/{id}/menuItems/{itemId}` subcollection, but
// that depends on whichever function writes menu items also moving - until
// then this mirrors the RTDB `menus/{restaurantId}/{itemId}` shape 1:1.
export function menuItemsCollectionRef(database: FirestoreLike, restaurantId: string): CollectionReferenceLike {
  return database.collection("menus").doc(restaurantId).collection("items");
}

export function menuItemRef(database: FirestoreLike, restaurantId: string, itemId: string): DocumentReferenceLike {
  return menuItemsCollectionRef(database, restaurantId).doc(itemId);
}

function riderRewardsDoc(database: FirestoreLike): DocumentReferenceLike {
  return database.collection("private").doc("riderRewards");
}

// Kept here (rather than in riderRewards.ts) so a file that only needs a list
// of reward campaigns - like catalog.ts's checkout pricing - does not have to
// import riderRewards.ts's entire module graph (which pulls in riderFinance.ts
// and authz.ts at load time) just for this one path.
export function campaignsCollectionRef(database: FirestoreLike): CollectionReferenceLike {
  return riderRewardsDoc(database).collection("campaigns");
}

// Kept here (rather than in riderFinance.ts) so a file that only needs the
// rider wallet document - like orders.ts's COD ledger update - does not have
// to import riderFinance.ts's entire module graph (which pulls in authz.ts
// at load time) just for this one path.
export function riderWalletRef(database: FirestoreLike, riderId: string): DocumentReferenceLike {
  return database.collection("riderWallets").doc(riderId);
}

export function dispatchQueueCollectionRef(database: FirestoreLike): CollectionReferenceLike {
  return database.collection("dispatchQueue");
}

export function dispatchQueueRef(database: FirestoreLike, orderId: string): DocumentReferenceLike {
  return dispatchQueueCollectionRef(database).doc(orderId);
}

// Replaces the RTDB `riderAvailabilityByCity/{cityKey}/{riderId}` secondary
// index. One flat document per rider (not sharded by city) - a city change
// is just an overwrite of the same document's `cityKey` field, not a
// delete-from-old-shard-plus-write-to-new-shard pair the old sharded path
// needed. Queried via `where("cityKey", "==", ...)` instead of a path lookup.
export function riderAvailabilityCollectionRef(database: FirestoreLike): CollectionReferenceLike {
  return database.collection("riderAvailability");
}

export function riderAvailabilityRef(database: FirestoreLike, riderId: string): DocumentReferenceLike {
  return riderAvailabilityCollectionRef(database).doc(riderId);
}

// Shared with index.ts's order-cancellation/delivery cleanup fan-out, which
// needs to clear this alongside orders.ts's own reads/writes of it.
export function deliveryOtpRef(database: FirestoreLike, orderId: string): DocumentReferenceLike {
  return database.collection("private").doc("deliveryOtps").collection("orders").doc(orderId);
}

// Shared with index.ts's order-cancellation/delivery cleanup fan-out, which
// needs to clear this alongside tracking.ts's own reads/writes of it.
export function trackingEvidenceRef(database: FirestoreLike, orderId: string): DocumentReferenceLike {
  return database.collection("private").doc("trackingEvidence").collection("orders").doc(orderId);
}

// Not a denormalized-copy-for-convenience like the other collections this
// file's comments mention collapsing - this is a genuine, permanent privacy
// boundary. orderProjection.ts writes a customerPhone/address-stripped view
// of the order here so the restaurant app's Firestore rules can grant access
// to it without ever exposing customer PII, something rules cannot do at the
// field level within a single document. It can never collapse into a `where`
// query against the flat `orders` collection for as long as that's true.
export function restaurantOrderProjectionRef(
  database: FirestoreLike,
  restaurantId: string,
  customerId: string,
  orderId: string,
): DocumentReferenceLike {
  return database.collection("restaurantOrders").doc(`${restaurantId}_${customerId}_${orderId}`);
}

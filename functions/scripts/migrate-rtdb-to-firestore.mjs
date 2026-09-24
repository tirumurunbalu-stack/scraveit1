#!/usr/bin/env node

/**
 * One-time RTDB -> Firestore data migration for the Firestore-in-Mumbai
 * cutover. Reads the entire `feastly` Realtime Database tree once (this is
 * pre-launch sample data - a handful of restaurants/orders/riders, comfortably
 * under RTDB's single-read size limits) and writes it into the Firestore
 * collections the already-converted Cloud Functions and client apps expect.
 *
 * No checkpoint/resume machinery: small enough to run in one sitting, and
 * every write is a full-document `.set()`, so re-running the script (dry-run
 * or apply) is idempotent - it always reproduces the same target state from
 * the same RTDB source, never accumulates on top of a partial prior run.
 *
 * Deliberately NOT migrated (left to regenerate naturally once Cloud
 * Functions are deployed and traffic resumes, or intentionally dropped):
 *   - backendEvents, orderIdempotency, dispatchRecoveryScanLease,
 *     notificationOutbox: transient locks/leases/work-queues, meaningless
 *     once frozen mid-flight.
 *   - private/riderRewards/progress + campaignProgress: computed snapshots
 *     that `refreshRiderRewardProgress()` regenerates from activityEvents
 *     (which IS migrated) on the next eligibility check.
 *   - private/operations/orders (operationalOrders projections),
 *     pricingSignals, restaurantLoad: read caches the app already has a
 *     dedicated backfill script for (`backfill-operational-projections.mjs`)
 *     or that rebuild from live traffic; no need to hand-port stale RTDB
 *     copies of a cache.
 *   - riderOffers: this collection never existed in RTDB - it's populated by
 *     the `onDispatchClaimWritten` Firestore trigger once functions with live
 *     dispatchQueue data are deployed.
 *   - restaurantStaffInvites: RTDB has no data under this path (no invites
 *     were ever sent in the sample data).
 */

import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getDatabase} from "firebase-admin/database";
import {getFirestore} from "firebase-admin/firestore";

const ROOT = "feastly";
const FIRESTORE_BATCH_LIMIT = 400; // Firestore's hard cap is 500 writes/batch.

function usage() {
  return [
    "Migrate the feastly Realtime Database tree into Firestore (dry-run by default).",
    "",
    "Required environment:",
    "  SAVRIVO_EXPECTED_PROJECT_ID=<exact Firebase project id>",
    "  SAVRIVO_DATABASE_URL=<exact Realtime Database URL>",
    "",
    "Apply additionally requires:",
    "  SAVRIVO_CONFIRM_PROJECT_ID=<same exact project id>",
    "",
    "Options:",
    "  --apply              enable Firestore writes (default: dry run, no writes)",
    "  --only=a,b,c         run only these named sections (see SECTION NAMES below)",
    "  --help               print this message",
    "",
    "SECTION NAMES: (restaurants also emits menu items; there's no separate name for that half)",
    "  users, riders, restaurants, catalogSearchTokens, staff,",
    "  restaurantMembers, orders, restaurantOrders, dispatchQueue, riderJobs,",
    "  riderRestaurantArrivals, riderWallets, riderDocuments, riderAvailability,",
    "  reviews, orderChats, userRestaurants, settings, support,",
    "  restaurantApplications, customerBroadcasts, deviceTokens, audit,",
    "  ratingAggregates, ledgerJournals, ledgerCoverage, riderRewards,",
    "  restaurantWorkload, riderOperationsWorkload, riderDispatchEligibility",
  ].join("\n");
}

export function parseOptions(argv) {
  const options = {apply: false, only: null};
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--help") options.help = true;
    else if (arg.startsWith("--only=")) {
      options.only = new Set(arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
      if (options.only.size === 0) throw new Error("--only requires at least one section name.");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entries(value) {
  return isPlainObject(value) ? Object.entries(value) : [];
}

/** Accumulates planned/committed Firestore writes, batching commits under Firestore's 500-op cap. */
export class Writer {
  constructor(firestore, apply) {
    this.firestore = firestore;
    this.apply = apply;
    this.batch = apply ? firestore.batch() : null;
    this.pending = 0;
    this.counts = new Map();
    this.skipped = new Map();
  }

  set(section, docPath, data) {
    this.counts.set(section, (this.counts.get(section) ?? 0) + 1);
    if (!this.apply) return;
    this.batch.set(this.firestore.doc(docPath), data);
    this.pending += 1;
    if (this.pending >= FIRESTORE_BATCH_LIMIT) {
      this._flushes = this._flushes ?? [];
      this._flushes.push(this.batch.commit());
      this.batch = this.firestore.batch();
      this.pending = 0;
    }
  }

  skip(section, reason) {
    const key = `${section}: ${reason}`;
    this.skipped.set(key, (this.skipped.get(key) ?? 0) + 1);
  }

  async flush() {
    this._flushes = this._flushes ?? [];
    if (this.apply && this.pending > 0) this._flushes.push(this.batch.commit());
    await Promise.all(this._flushes);
  }
}

// ---- Section migrations -----------------------------------------------

function migrateUsers(root, w) {
  for (const [uid, user] of entries(root.users)) {
    if (!isPlainObject(user)) { w.skip("users", "not an object"); continue; }
    w.set("users", `users/${uid}`, user);
  }
}

function migrateRiders(root, w) {
  for (const [uid, rider] of entries(root.riders)) {
    if (!isPlainObject(rider)) { w.skip("riders", "not an object"); continue; }
    w.set("riders", `riders/${uid}`, rider);
  }
}

function migrateRestaurantsAndMenus(root, w) {
  const restaurants = root.catalog?.restaurants;
  for (const [restaurantId, restaurant] of entries(restaurants)) {
    if (!isPlainObject(restaurant)) { w.skip("restaurants", "not an object"); continue; }
    // Drop the embedded `menu` array: it's the stale of the two menu
    // sources (confirmed against this export - the separate `menus/` tree
    // below has equal-or-newer `updatedAt`/`updatedBy` for every item), and
    // no converted code path reads it anymore.
    const {menu: _menu, ...restaurantDoc} = restaurant;
    w.set("restaurants", `restaurants/${restaurantId}`, restaurantDoc);
  }
  for (const [restaurantId, items] of entries(root.menus)) {
    for (const [itemId, item] of entries(items)) {
      if (!isPlainObject(item)) { w.skip("menuItems", "not an object"); continue; }
      w.set("menuItems", `menus/${restaurantId}/items/${itemId}`, item);
    }
  }
}

function migrateCatalogSearchTokens(root, w) {
  for (const [cityKey, tokens] of entries(root.catalog?.searchTokens)) {
    for (const [tokenKey, value] of entries(tokens)) {
      if (value !== true) { w.skip("catalogSearchTokens", "non-true token value"); continue; }
      w.set("catalogSearchTokens", `catalogSearchTokens/${cityKey}/tokens/${tokenKey}`, {value: true});
    }
  }
}

function migrateStaff(root, w) {
  for (const [uid, staff] of entries(root.staff)) {
    if (!isPlainObject(staff)) { w.skip("staff", "not an object"); continue; }
    w.set("staff", `staff/${uid}`, staff);
  }
}

function migrateRestaurantMembers(root, w) {
  for (const [restaurantId, members] of entries(root.restaurantMembers)) {
    for (const [uid, member] of entries(members)) {
      if (!isPlainObject(member)) { w.skip("restaurantMembers", "not an object"); continue; }
      w.set("restaurantMembers", `restaurantMembers/${restaurantId}_${uid}`, member);
    }
  }
}

function migrateOrders(root, w) {
  for (const [customerId, orders] of entries(root.orders)) {
    for (const [orderId, order] of entries(orders)) {
      if (!isPlainObject(order)) { w.skip("orders", "not an object"); continue; }
      const doc = order.customerId ? order : {...order, customerId};
      w.set("orders", `orders/${orderId}`, doc);
    }
  }
}

function migrateRestaurantOrders(root, w) {
  for (const [restaurantId, byCustomer] of entries(root.restaurantOrders)) {
    for (const [customerId, orders] of entries(byCustomer)) {
      for (const [orderId, order] of entries(orders)) {
        if (!isPlainObject(order)) { w.skip("restaurantOrders", "not an object"); continue; }
        w.set("restaurantOrders", `restaurantOrders/${restaurantId}_${customerId}_${orderId}`, order);
      }
    }
  }
}

function migrateDispatchQueue(root, w) {
  for (const [orderId, entry] of entries(root.dispatchQueue)) {
    if (!isPlainObject(entry)) { w.skip("dispatchQueue", "not an object"); continue; }
    w.set("dispatchQueue", `dispatchQueue/${orderId}`, entry);
  }
}

function migrateRiderJobs(root, w) {
  for (const [riderId, jobs] of entries(root.riderJobs)) {
    for (const [orderId, job] of entries(jobs)) {
      if (!isPlainObject(job)) { w.skip("riderJobs", "not an object"); continue; }
      w.set("riderJobs", `riderJobs/${riderId}_${orderId}`, job);
    }
  }
}

function migrateRiderRestaurantArrivals(root, w) {
  for (const [orderId, arrival] of entries(root.riderRestaurantArrivals)) {
    if (!isPlainObject(arrival)) { w.skip("riderRestaurantArrivals", "not an object"); continue; }
    w.set("riderRestaurantArrivals", `riderRestaurantArrivals/${orderId}`, arrival);
  }
}

function migrateRiderWallets(root, w) {
  for (const [riderId, wallet] of entries(root.riderWallets)) {
    if (!isPlainObject(wallet)) { w.skip("riderWallets", "not an object"); continue; }
    w.set("riderWallets", `riderWallets/${riderId}`, wallet);
  }
}

function migrateRiderDocuments(root, w) {
  for (const [uid, docs] of entries(root.riderDocuments)) {
    if (!isPlainObject(docs)) { w.skip("riderDocuments", "not an object"); continue; }
    w.set("riderDocuments", `riderDocuments/${uid}`, docs);
  }
}

function migrateRiderAvailability(root, w) {
  for (const [cityKey, riders] of entries(root.riderAvailabilityByCity)) {
    for (const [riderId, presence] of entries(riders)) {
      if (!isPlainObject(presence)) { w.skip("riderAvailability", "not an object"); continue; }
      const doc = presence.cityKey ? presence : {...presence, cityKey};
      w.set("riderAvailability", `riderAvailability/${riderId}`, doc);
    }
  }
}

function migrateReviews(root, w) {
  for (const [customerId, reviews] of entries(root.reviews)) {
    for (const [orderId, review] of entries(reviews)) {
      if (!isPlainObject(review)) { w.skip("reviews", "not an object"); continue; }
      const doc = review.customerId ? review : {...review, customerId};
      w.set("reviews", `reviews/${customerId}_${orderId}`, doc);
    }
  }
}

/** Builds an orderId -> {restaurantId, riderId} lookup so chat messages (which
 * never carried those fields in RTDB) can be denormalized for the new flat
 * `orderChats` rules, which check all three participant ids on every message. */
function buildOrderParticipantIndex(root) {
  const index = new Map();
  for (const orders of Object.values(root.orders ?? {})) {
    for (const [orderId, order] of entries(orders)) {
      if (!isPlainObject(order)) continue;
      index.set(orderId, {
        restaurantId: String(order.restaurantId ?? ""),
        riderId: String(order.riderId ?? ""),
      });
    }
  }
  return index;
}

function migrateOrderChats(root, w, orderParticipants) {
  for (const [customerId, byOrder] of entries(root.orderChats)) {
    for (const [orderId, byChannel] of entries(byOrder)) {
      const participants = orderParticipants.get(orderId) ?? {restaurantId: "", riderId: ""};
      for (const [channel, messages] of entries(byChannel)) {
        for (const [messageId, message] of entries(messages)) {
          if (!isPlainObject(message)) { w.skip("orderChats", "not an object"); continue; }
          const doc = {
            ...message,
            orderId,
            channel,
            customerId,
            restaurantId: participants.restaurantId,
            riderId: participants.riderId,
          };
          w.set("orderChats", `orderChats/${orderId}_${channel}_${messageId}`, doc);
        }
      }
    }
  }
}

function migrateUserRestaurants(root, w) {
  for (const [uid, mapping] of entries(root.userRestaurants)) {
    if (!isPlainObject(mapping)) { w.skip("userRestaurants", "not an object"); continue; }
    w.set("userRestaurants", `userRestaurants/${uid}`, mapping);
  }
}

function migrateSettings(root, w) {
  for (const [settingsId, value] of entries(root.settings)) {
    if (!isPlainObject(value)) { w.skip("settings", "not an object"); continue; }
    w.set("settings", `settings/${settingsId}`, value);
  }
}

function migrateSupport(root, w) {
  for (const [uid, tickets] of entries(root.support)) {
    for (const [ticketId, ticket] of entries(tickets)) {
      if (!isPlainObject(ticket)) { w.skip("support", "not an object"); continue; }
      const doc = ticket.uid ? ticket : {...ticket, uid};
      w.set("support", `support/${ticketId}`, doc);
    }
  }
}

function migrateRestaurantApplications(root, w) {
  for (const [uid, application] of entries(root.restaurantApplications)) {
    if (!isPlainObject(application)) { w.skip("restaurantApplications", "not an object"); continue; }
    w.set("restaurantApplications", `restaurantApplications/${uid}`, application);
  }
}

function migrateCustomerBroadcasts(root, w) {
  for (const [id, broadcast] of entries(root.customerBroadcasts)) {
    if (!isPlainObject(broadcast)) { w.skip("customerBroadcasts", "not an object"); continue; }
    w.set("customerBroadcasts", `customerBroadcasts/${id}`, broadcast);
  }
}

function migrateDeviceTokens(root, w) {
  for (const [uid, tokens] of entries(root.deviceTokens)) {
    if (!isPlainObject(tokens)) { w.skip("deviceTokens", "not an object"); continue; }
    w.set("deviceTokens", `deviceTokens/${uid}`, tokens);
  }
}

function migrateAudit(root, w) {
  for (const [id, entry] of entries(root.audit)) {
    if (!isPlainObject(entry)) { w.skip("audit", "not an object"); continue; }
    w.set("audit", `audit/${id}`, entry);
  }
}

function migrateRatingAggregates(root, w) {
  for (const [kind, subjects] of entries(root.ratingAggregates)) {
    for (const [subjectId, aggregate] of entries(subjects)) {
      if (!isPlainObject(aggregate)) { w.skip("ratingAggregates", "not an object"); continue; }
      w.set("ratingAggregates", `ratingAggregates/${kind}/subjects/${subjectId}`, aggregate);
    }
  }
}

function migrateLedgerJournals(root, w) {
  for (const [journalId, journal] of entries(root.private?.financialLedger?.journals)) {
    if (!isPlainObject(journal)) { w.skip("ledgerJournals", "not an object"); continue; }
    w.set("ledgerJournals", `ledgerJournals/${journalId}`, journal);
  }
}

function migrateLedgerCoverage(root, w) {
  const coverage = root.private?.financialLedger?.coverage;
  for (const kind of ["restaurants", "riders"]) {
    const bucket = coverage?.[kind];
    if (bucket === undefined) continue;
    if (!isPlainObject(bucket)) { w.skip("ledgerCoverage", "not an object"); continue; }
    w.set("ledgerCoverage", `private/financialLedger/coverage/${kind}`, bucket);
  }
}

function migrateRiderRewards(root, w) {
  const rr = root.private?.riderRewards;
  if (!isPlainObject(rr)) return;
  for (const [campaignId, campaign] of entries(rr.campaigns)) {
    if (!isPlainObject(campaign)) { w.skip("riderRewards", "campaign not an object"); continue; }
    w.set("riderRewards", `private/riderRewards/campaigns/${campaignId}`, campaign);
  }
  if (isPlainObject(rr.settings)) {
    w.set("riderRewards", "private/riderRewards/meta/settings", rr.settings);
  } else if (rr.settings !== undefined) {
    w.skip("riderRewards", "settings not an object");
  }
  for (const [code, record] of entries(rr.referralCodes)) {
    if (!isPlainObject(record)) { w.skip("riderRewards", "referralCode not an object"); continue; }
    w.set("riderRewards", `private/riderRewards/referralCodes/${code}`, record);
  }
  for (const [riderId, record] of entries(rr.referralIdentities)) {
    if (!isPlainObject(record)) { w.skip("riderRewards", "referralIdentity not an object"); continue; }
    w.set("riderRewards", `private/riderRewards/referralIdentities/${riderId}`, record);
  }
  for (const [riderId, days] of entries(rr.sessionDays)) {
    for (const [dayKey, day] of entries(days)) {
      if (!isPlainObject(day)) { w.skip("riderRewards", "sessionDay not an object"); continue; }
      w.set("riderRewards", `private/riderRewards/sessionDays/${riderId}/days/${dayKey}`, day);
    }
  }
  for (const [riderId, events] of entries(rr.activityEvents)) {
    for (const [eventId, event] of entries(events)) {
      if (!isPlainObject(event)) { w.skip("riderRewards", "activityEvent not an object"); continue; }
      // HEARTBEAT events are an online-presence ping, logged every few
      // seconds while a rider's app is foregrounded - in this export one
      // rider alone has 15,023 of them (99.6% of all activity events),
      // pure test-session noise with no bearing on reward-progress history.
      // Skip them; every event type that actually feeds a reward condition
      // (order lifecycle, ONLINE/OFFLINE transitions) is kept.
      if (event.type === "HEARTBEAT") { w.skip("riderRewards", "heartbeat event excluded"); continue; }
      w.set("riderRewards", `private/riderRewards/activityEvents/${riderId}/events/${eventId}`, event);
    }
  }
}

function migrateRestaurantWorkload(root, w) {
  for (const [restaurantId, workload] of entries(root.private?.restaurantWorkload)) {
    if (!isPlainObject(workload)) { w.skip("restaurantWorkload", "not an object"); continue; }
    w.set("restaurantWorkload", `private/restaurantWorkload/byRestaurant/${restaurantId}`, workload);
  }
}

function migrateRiderOperationsWorkload(root, w) {
  for (const [riderId, workload] of entries(root.private?.operations?.riderWorkload)) {
    if (!isPlainObject(workload)) { w.skip("riderOperationsWorkload", "not an object"); continue; }
    w.set("riderOperationsWorkload", `private/operations/riderWorkload/${riderId}`, workload);
  }
}

function migrateRiderDispatchEligibility(root, w) {
  for (const [riderId, eligibility] of entries(root.private?.riderDispatchEligibility)) {
    if (!isPlainObject(eligibility)) { w.skip("riderDispatchEligibility", "not an object"); continue; }
    w.set("riderDispatchEligibility", `private/riderDispatchEligibility/riders/${riderId}`, eligibility);
  }
}

export const SECTIONS = [
  {name: "users", run: migrateUsers},
  {name: "riders", run: migrateRiders},
  {name: "restaurants", run: migrateRestaurantsAndMenus}, // also emits "menuItems"
  {name: "catalogSearchTokens", run: migrateCatalogSearchTokens},
  {name: "staff", run: migrateStaff},
  {name: "restaurantMembers", run: migrateRestaurantMembers},
  {name: "orders", run: migrateOrders},
  {name: "restaurantOrders", run: migrateRestaurantOrders},
  {name: "dispatchQueue", run: migrateDispatchQueue},
  {name: "riderJobs", run: migrateRiderJobs},
  {name: "riderRestaurantArrivals", run: migrateRiderRestaurantArrivals},
  {name: "riderWallets", run: migrateRiderWallets},
  {name: "riderDocuments", run: migrateRiderDocuments},
  {name: "riderAvailability", run: migrateRiderAvailability},
  {name: "reviews", run: migrateReviews},
  {name: "orderChats", run: (root, w) => migrateOrderChats(root, w, buildOrderParticipantIndex(root))},
  {name: "userRestaurants", run: migrateUserRestaurants},
  {name: "settings", run: migrateSettings},
  {name: "support", run: migrateSupport},
  {name: "restaurantApplications", run: migrateRestaurantApplications},
  {name: "customerBroadcasts", run: migrateCustomerBroadcasts},
  {name: "deviceTokens", run: migrateDeviceTokens},
  {name: "audit", run: migrateAudit},
  {name: "ratingAggregates", run: migrateRatingAggregates},
  {name: "ledgerJournals", run: migrateLedgerJournals},
  {name: "ledgerCoverage", run: migrateLedgerCoverage},
  {name: "riderRewards", run: migrateRiderRewards},
  {name: "restaurantWorkload", run: migrateRestaurantWorkload},
  {name: "riderOperationsWorkload", run: migrateRiderOperationsWorkload},
  {name: "riderDispatchEligibility", run: migrateRiderDispatchEligibility},
];

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const apply = options.apply === true;
  const expectedProjectId = String(process.env.SAVRIVO_EXPECTED_PROJECT_ID ?? "").trim();
  const confirmationProjectId = String(process.env.SAVRIVO_CONFIRM_PROJECT_ID ?? "").trim();
  const databaseUrl = String(process.env.SAVRIVO_DATABASE_URL ?? "").trim().replace(/\/$/u, "");
  if (!expectedProjectId) throw new Error("SAVRIVO_EXPECTED_PROJECT_ID is required.");
  if (!databaseUrl || !/^https:\/\/[^/]+(?:\.firebaseio\.com|\.firebasedatabase\.app)$/u.test(databaseUrl)) {
    throw new Error("SAVRIVO_DATABASE_URL must be the exact HTTPS Firebase Realtime Database root URL.");
  }
  const databaseHost = new URL(databaseUrl).hostname;
  const databaseInstance = databaseHost.split(".")[0];
  if (databaseInstance !== expectedProjectId && !databaseInstance.startsWith(`${expectedProjectId}-`)) {
    throw new Error("SAVRIVO_DATABASE_URL does not belong to SAVRIVO_EXPECTED_PROJECT_ID.");
  }
  if (apply && confirmationProjectId !== expectedProjectId) {
    throw new Error("Apply requires SAVRIVO_CONFIRM_PROJECT_ID to exactly match SAVRIVO_EXPECTED_PROJECT_ID.");
  }
  if (options.only) {
    const knownNames = new Set(SECTIONS.map((s) => s.name));
    for (const name of options.only) {
      if (!knownNames.has(name)) throw new Error(`Unknown --only section: ${name}`);
    }
  }

  const app = initializeApp({
    credential: applicationDefault(),
    projectId: expectedProjectId,
    databaseURL: databaseUrl,
  }, `rtdb-to-firestore-migration-${Date.now()}`);
  const rtdb = getDatabase(app);
  const firestore = getFirestore(app);

  try {
    console.log(`${apply ? "APPLY" : "DRY RUN"}: project=${expectedProjectId}`);
    console.log("Reading the full RTDB tree (one shot - this is pre-launch sample data)...");
    const snapshot = await rtdb.ref(ROOT).once("value");
    const root = snapshot.val() ?? {};
    console.log(`Read ${JSON.stringify(root).length} bytes from ${databaseUrl}/${ROOT}.`);

    const writer = new Writer(firestore, apply);
    for (const section of SECTIONS) {
      if (options.only && !options.only.has(section.name)) continue;
      section.run(root, writer);
    }
    await writer.flush();

    const totalWrites = [...writer.counts.values()].reduce((sum, n) => sum + n, 0);
    const totalSkipped = [...writer.skipped.values()].reduce((sum, n) => sum + n, 0);
    console.log("");
    console.log("Per-section document counts:");
    for (const [section, count] of [...writer.counts.entries()].sort()) {
      console.log(`  ${section}: ${count}`);
    }
    if (writer.skipped.size > 0) {
      console.log("Skipped records (malformed source data):");
      for (const [reason, count] of [...writer.skipped.entries()].sort()) {
        console.log(`  ${reason}: ${count}`);
      }
    }
    console.log("");
    console.log(`SUMMARY mode=${apply ? "apply" : "dry-run"} documentsWritten=${totalWrites} recordsSkipped=${totalSkipped}`);
    if (!apply) console.log("No Firestore writes were performed. Review the plan above, then re-run with --apply.");
    else console.log("Firestore writes committed. Spot-check the target collections before deploying rules/functions/apps.");
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = String(error?.message ?? "");
    const code = message.includes("permission") || message.includes("PERMISSION")
      ? "PERMISSION_DENIED"
      : message.includes("credential") || message.includes("Credential")
        ? "CREDENTIALS_UNAVAILABLE"
        : message.includes("SAVRIVO_")
          ? "CONFIGURATION_INVALID"
          : "OPERATION_FAILED";
    console.error(`MIGRATION_FAILED code=${code} message=${message}`);
    process.exitCode = 1;
  });
}

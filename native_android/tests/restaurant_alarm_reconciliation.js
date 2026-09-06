#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const restaurant = fs.readFileSync(
  path.join(root, "restaurant", "src", "main", "assets", "premium.js"), "utf8");
const bridge = fs.readFileSync(
  path.join(root, "shared", "firebase", "java", "com", "savrivo", "firebase", "SavrivoOperationsBridge.java"), "utf8");
const alarm = fs.readFileSync(
  path.join(root, "shared", "firebase", "java", "com", "savrivo", "firebase", "OrderAlarmService.java"), "utf8");

assert(
  restaurant.includes('pendingOrders=state.orders.filter(o=>o.status==="Order placed")')
    && restaurant.includes("reconcileRestaurantOrderAlarms(JSON.stringify({known:knownOrderIds,pending:pendingOrderIds}))"),
  "Restaurant must reconcile native alarms against the complete authoritative pending set");
assert(
  restaurant.includes('db("GET",ROOT+"/restaurantOrders/"+encodeURIComponent(rid))])')
    && !restaurant.includes('db("GET",ROOT+"/restaurantOrders/"+encodeURIComponent(rid)).catch(()=>null)'),
  "An order-fetch failure must not be treated as an authoritative empty set");
assert(
  bridge.includes("reconcileRestaurantOrderAlarms(String orderStateJson)")
    && bridge.includes('!"restaurant".equals(SavrivoFirebase.appRole(activity))')
    && bridge.includes("activity, knownOrderIds, pendingOrderIds")
    && bridge.includes("knownOrderIds.containsAll(pendingOrderIds)"),
  "The reconciliation bridge must be restricted to the trusted Restaurant app");
assert(
  alarm.includes("reconcileRestaurantOrders(")
    && alarm.includes('alarmId.startsWith("order:")')
    && alarm.includes("knownAlarmIds.contains(alarmId)")
    && alarm.includes("!authoritativeAlarmIds.contains(alarmId)")
    && alarm.includes("SavrivoPushStore.removeRestaurantNewOrder(context, orderId)"),
  "Native reconciliation must stop only stale Restaurant alarms and remove their queued starts");

const stored = new Set(["order:pending-a", "order:accepted-b", "order:cancelled-c"]);
const known = new Set(["order:pending-a", "order:accepted-b", "order:cancelled-c"]);
const pending = new Set(["order:pending-a", "order:pending-d"]);
const stale = [...stored].filter(id => id.startsWith("order:") && known.has(id) && !pending.has(id));
assert.deepStrictEqual(stale.sort(), ["order:accepted-b", "order:cancelled-c"]);
assert(stored.has("order:pending-a"), "An existing pending alarm must remain active");
assert(pending.has("order:pending-d"), "A newly discovered pending order remains eligible to start");

const otherRestaurantAlarm = "order:other-restaurant-pending";
assert(!known.has(otherRestaurantAlarm), "The fixture must model an order outside this restaurant sync");
assert(
  !([...stored, otherRestaurantAlarm]
    .filter(id => id.startsWith("order:") && known.has(id) && !pending.has(id)))
    .includes(otherRestaurantAlarm),
  "Reconciling one membership must not silence another restaurant's pending alarm");

process.stdout.write("✓ Restaurant native alarm reconciliation preserves pending orders and removes stale alarms\n");

#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");

const customerFile = path.resolve(__dirname, "..", "app", "src", "main", "assets", "premium.js");

function makeElement() {
  return {
    innerHTML: "", value: "", content: "", dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
  };
}

function makeContext() {
  const storage = new Map();
  const elements = new Map();
  const document = {
    documentElement: makeElement(), visibilityState: "visible",
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelector(selector) { return selector === 'meta[name="theme-color"]' ? makeElement() : null; },
    querySelectorAll() { return []; }, addEventListener() {}, createElement() { return makeElement(); },
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  class HTMLFormElement {}
  const context = {
    console, document, localStorage, navigator: { onLine: true }, crypto: webcrypto,
    TextEncoder, AbortController, HTMLFormElement, FormData: global.FormData,
    Image: class Image {}, FEASTLY_FIREBASE: {},
    fetch: async () => { throw new Error("network is not used by this deterministic test"); },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame(callback) { callback(); return 1; }, scrollTo() {}, scrollY: 0,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
  };
  context.window = context;
  context.globalThis = context;
  context.__storage = storage;
  return vm.createContext(context);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`✓ ${message}\n`);
}

const original = fs.readFileSync(customerFile, "utf8");
const marker = "bootstrap();";
const index = original.lastIndexOf(marker);
if (index < 0) throw new Error("Customer bootstrap marker was not found");
const instrumented = original.slice(0, index)
  + "globalThis.__REVIEW_INTERNALS={state,reviewCacheKey,reviewStateReady,applyReviewSnapshot,latestDeliveredNeedingReview,postDeliveryCard,homeSummary,ratingForRestaurant,screenOrder,screenReview,buildReviewPayload};"
  + original.slice(index + marker.length);
const context = makeContext();
vm.runInContext(instrumented, context, { filename: customerFile, timeout: 3000 });

const api = context.__REVIEW_INTERNALS;
const { state } = api;
const deliveredOrder = {
  id: "order-reviewed", status: "Delivered", restaurantId: "restaurant-1",
  restaurant: "Test Kitchen", riderId: "rider-1", riderName: "Test Rider",
  items: [{ name: "Meal", quantity: 1, price: 100 }], total: 100, createdAt: 1000, updatedAt: 2000,
};
const review = {
  orderId: deliveredOrder.id, restaurantId: deliveredOrder.restaurantId,
  riderId: deliveredOrder.riderId, rating: 5, riderRating: 4, status: "published", createdAt: 3000,
};

state.session = { uid: "customer-a", email: "customer@example.test" };
state.orders = [deliveredOrder];
state.selectedOrderId = deliveredOrder.id;
state.reviews = { [deliveredOrder.id]: review };
state.reviewsHydrated = false;
state.reviewsHydratedUid = "";

check(api.latestDeliveredNeedingReview() === null, "cold startup never prompts before review state is authoritative");
state.reviewsHydrated = true;
state.reviewsHydratedUid = "customer-b";
check(api.latestDeliveredNeedingReview() === null, "review hydration from another account is never trusted");

state.reviewSyncSequence = 7;
check(api.applyReviewSnapshot("customer-a", 6, {}) === false, "an older review response cannot replace newer state");
check(api.applyReviewSnapshot("customer-b", 7, {}) === false, "a response for another account cannot cross-contaminate review state");
check(api.applyReviewSnapshot("customer-a", 7, { [deliveredOrder.id]: review }) === true, "the current account review snapshot is applied");
check(api.latestDeliveredNeedingReview() === null, "an already-reviewed order remains dismissed after hydration");
check(context.__storage.has(api.reviewCacheKey("customer-a")), "authoritative reviews persist in the account-scoped cache");

const reviewedOrderMarkup = api.screenOrder();
check(reviewedOrderMarkup.includes("Ratings submitted") && reviewedOrderMarkup.includes("View your rating"), "order details display submitted restaurant and rider feedback");
check(reviewedOrderMarkup.includes("Delivery partner") && reviewedOrderMarkup.includes("4.0 / 5"), "the submitted rider rating is visible to the customer");
const savedReviewMarkup = api.screenReview();
check(savedReviewMarkup.includes("Restaurant & food") && savedReviewMarkup.includes("Delivery partner"), "restaurant and rider rating controls remain available in saved feedback");
check(!savedReviewMarkup.includes('name="postDeliveryTip"') && !savedReviewMarkup.includes('name="growthContribution"'), "review UI exposes no unverified post-delivery money choices");
const reviewPayload = api.buildReviewPayload(deliveredOrder, 5, 4, "Great delivery");
check(reviewPayload.rating === 5 && reviewPayload.riderRating === 4 && reviewPayload.comment === "Great delivery", "review payload preserves restaurant, rider and comment feedback");
check(reviewPayload.postDeliveryTip === 0 && reviewPayload.growthContribution === 0, "review payload forces unverified monetary fields to zero");

state.reviews = {};
state.reviewsHydrated = false;
state.reviewsHydratedUid = "";
const unresolvedOrderMarkup = api.screenOrder();
check(unresolvedOrderMarkup.includes("Checking feedback") && !unresolvedOrderMarkup.includes("> Rate order<"), "order details do not expose a stale duplicate rating action while syncing");

state.reviewSyncSequence = 8;
api.applyReviewSnapshot("customer-a", 8, {});
check(api.latestDeliveredNeedingReview().id === deliveredOrder.id, "a genuinely unreviewed delivered order prompts after authoritative hydration");

const summary = api.homeSummary({ id: "restaurant-1", name: "Test Kitchen", rating: 4.8, ratingCount: 7, menu: [] });
check(summary.rating === 4.8 && summary.ratingCount === 7, "restaurant rating and count survive the startup home cache");
state.ratingView = "overall";
const aggregate = api.ratingForRestaurant(summary);
check(aggregate.value === 4.8 && aggregate.label === "7 customer ratings", "verified aggregate rating renders with its real count");
const incomplete = api.ratingForRestaurant({ id: "restaurant-2", rating: 5, ratingCount: 0 });
check(incomplete.value === 0 && incomplete.label === "No ratings yet", "a rating without a verified aggregate count is not fabricated on screen");

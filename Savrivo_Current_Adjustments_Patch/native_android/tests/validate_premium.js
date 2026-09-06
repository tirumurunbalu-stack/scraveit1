#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const nativeRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(nativeRoot, "..");
const lifecyclePath = path.join(nativeRoot, "shared", "order-lifecycle.json");
const rulesPath = path.join(workspaceRoot, "firebase", "feastly-realtime-database-rules.json");
const storageRulesPath = path.join(workspaceRoot, "firebase", "storage.rules");

const apps = [
  {
    name: "customer",
    module: "app",
    title: "Savrivo",
    java: path.join(nativeRoot, "app", "src", "main", "java", "com", "feastly", "app", "MainActivity.java"),
    requiredRoles: ["customer"],
    mustDisplayAllStates: true,
  },
  {
    name: "control",
    module: "admin",
    title: "Savrivo Admin",
    java: path.join(nativeRoot, "admin", "src", "main", "java", "com", "feastly", "admin", "MainActivity.java"),
    requiredRoles: ["owner", "staff"],
    mustDisplayAllStates: true,
  },
  {
    name: "restaurant",
    module: "restaurant",
    title: "Savrivo Restaurant",
    java: path.join(nativeRoot, "restaurant", "src", "main", "java", "com", "feastly", "restaurant", "MainActivity.java"),
    requiredRoles: ["staff"],
    mustDisplayAllStates: false,
  },
  {
    name: "partner",
    module: "rider",
    title: "Savrivo Partner",
    java: path.join(nativeRoot, "rider", "src", "main", "java", "com", "feastly", "rider", "MainActivity.java"),
    requiredRoles: ["rider"],
    mustDisplayAllStates: false,
  },
];

let assertions = 0;
const failures = [];

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function check(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function test(name, body) {
  try {
    body();
    process.stdout.write(`\u2713 ${name}\n`);
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) });
    process.stdout.write(`\u2717 ${name}\n`);
  }
}

function manifestAttribute(xml, attribute) {
  const match = xml.match(new RegExp(`android:${attribute}="([^"]+)"`));
  return match ? match[1] : "";
}

let lifecycle;

test("shared order lifecycle is valid JSON and internally consistent", () => {
  lifecycle = JSON.parse(read(lifecyclePath));
  const expected = [
    "Order placed",
    "Accepted",
    "Preparing",
    "Ready for pickup",
    "Assigned",
    "Handed to rider",
    "Out for delivery",
    "Near you",
    "Arrived",
    "Delivered",
    "Cancelled",
  ];
  check(Array.isArray(lifecycle.states), "states must be an array");
  check(JSON.stringify(lifecycle.states) === JSON.stringify(expected), "lifecycle states or ordering changed unexpectedly");
  check(lifecycle.transitions && typeof lifecycle.transitions === "object", "transitions must be an object");
  check(lifecycle.owners && typeof lifecycle.owners === "object", "owners must be an object");

  const stateSet = new Set(lifecycle.states);
  for (const state of lifecycle.states) {
    check(Array.isArray(lifecycle.transitions[state]), `missing transition list for ${state}`);
    for (const target of lifecycle.transitions[state]) {
      check(stateSet.has(target), `${state} transitions to unknown state ${target}`);
      check(target !== state, `${state} must not transition to itself`);
    }
  }
  check(lifecycle.transitions.Delivered.length === 0, "Delivered must be terminal");
  check(lifecycle.transitions.Cancelled.length === 0, "Cancelled must be terminal");
  check(lifecycle.transitions.Assigned.includes("Handed to rider"), "Assigned must lead to Handed to rider");
  check(lifecycle.transitions["Handed to rider"].includes("Out for delivery"), "handover must lead to Out for delivery");

  for (const [role, states] of Object.entries(lifecycle.owners)) {
    check(Array.isArray(states), `owner state list for ${role} must be an array`);
    for (const state of states) check(stateSet.has(state), `${role} owns unknown state ${state}`);
  }
});

test("Firebase Realtime Database rules parse as JSON", () => {
  const parsed = JSON.parse(read(rulesPath));
  check(parsed && parsed.rules && typeof parsed.rules === "object", "rules JSON must contain a rules object");
  check(parsed.rules.feastly && typeof parsed.rules.feastly === "object", "rules JSON must contain the shared feastly root");
});

test("Firebase Storage rules protect media and KYC paths", () => {
  check(fs.existsSync(storageRulesPath), "firebase/storage.rules must exist");
  const rules = read(storageRulesPath);
  check(rules.includes("match /restaurants/{restaurantId}/users/{uid}/{allPaths=**}"), "restaurant media path missing");
  check(rules.includes("match /rider-kyc/{uid}/{allPaths=**}"), "private rider KYC path missing");
  check(rules.includes("request.auth.uid == uid || admin()"), "rider KYC read access must be rider/admin scoped");
  check(rules.includes("match /{allPaths=**}"), "storage fallback deny block missing");
  check(rules.includes("allow read, write: if false"), "storage fallback must deny unmatched paths");
});

test("production-oriented sync and media guardrails are present", () => {
  const customer = read(path.join(nativeRoot, "app", "src", "main", "assets", "premium.js"));
  const restaurant = read(path.join(nativeRoot, "restaurant", "src", "main", "assets", "premium.js"));
  const rider = read(path.join(nativeRoot, "rider", "src", "main", "assets", "premium.js"));
  check(customer.includes("new EventSource"), "Customer must use scoped Firebase realtime streams");
  check(restaurant.includes("new EventSource"), "Restaurant must use scoped Firebase realtime streams");
  check(rider.includes("new EventSource"), "Partner must use Firebase realtime streams");
  check(rider.includes('"If-Match"'), "Partner fresh claim must use a conditional Firebase write");
  check(rider.includes("rider-kyc/"), "Partner KYC must upload to Storage path");
  check(!/riderDocuments[^\n]{0,300}data:image/i.test(rider), "Partner must not write Base64 KYC into RTDB");
  for (const module of ["app", "admin", "restaurant", "rider"]) {
    const config = read(path.join(nativeRoot, module, "src", "main", "assets", "firebase-config.js"));
    check(config.includes("storageBucket"), `${module} Firebase config must declare Storage bucket`);
  }
});


test("Savrivo operational upgrade contracts are present", () => {
  const customer = read(path.join(nativeRoot, "app", "src", "main", "assets", "premium.js"));
  const customerHtml = read(path.join(nativeRoot, "app", "src", "main", "assets", "premium.html"));
  const admin = read(path.join(nativeRoot, "admin", "src", "main", "assets", "premium.js"));
  const restaurant = read(path.join(nativeRoot, "restaurant", "src", "main", "assets", "premium.js"));
  const rider = read(path.join(nativeRoot, "rider", "src", "main", "assets", "premium.js"));
  const rules = JSON.parse(read(rulesPath)).rules.feastly;

  check(!rider.includes('requestType:"VERIFY_EMAIL"'), "Partner must not require email verification");
  check(!rider.includes('data-action="check-email-verification"'), "Partner must not render email-verification controls");
  check(rider.includes("applicationDraft"), "Partner application must persist a local draft");
  check(rider.includes("captureApplicationDraft"), "Partner application must preserve fields around document selection");

  check(restaurant.includes("userRestaurants/"), "Restaurant app must resolve multi-restaurant links");
  check(restaurant.includes("restaurantMembers/"), "Restaurant app must use restaurant-scoped memberships");
  check(restaurant.includes("switchRestaurant"), "Restaurant app must support switching restaurant scope");
  check(restaurant.includes('actorRole:"staff"'), "Restaurant lifecycle events must use the staff actor role");
  check(restaurant.includes("screenKitchen"), "Restaurant app must include a kitchen operations board");
  check(restaurant.includes("publishRestaurantLoad"), "Restaurant app must publish workload for surge pricing");
  check(restaurant.includes("autoAcceptNewOrders"), "Restaurant app must support optional capacity-aware auto-accept");

  check(!admin.includes('data-action="set-status"'), "Admin UI must not perform normal restaurant lifecycle steps");
  check(admin.includes("platformFeeOverrides"), "Admin must expose scoped platform-fee overrides");
  check(admin.includes("deliverySlabs"), "Admin must expose distance delivery slabs");
  check(admin.includes("rainLightFee") && admin.includes("surgeLowFee"), "Admin must expose rain and surge controls");

  check(customer.includes("deliverySlabs"), "Customer must calculate distance delivery pricing");
  check(customer.includes("platformFeeDetails"), "Customer must resolve platform-fee overrides");
  check(customer.includes("weather.googleapis.com"), "Customer must use Google Weather for rain analysis");
  check(customerHtml.includes("https://weather.googleapis.com"), "Customer CSP must allow Google Weather");
  check(customer.includes("rainFee()>0") && customer.includes("surgeFee()>0"), "Rain/surge rows must be conditional");
  check(customer.includes('state.sort==="nearby"'), "Customer must offer nearby sorting");
  check(customer.includes("customerCity"), "Customer discovery must use saved city scope");
  check(fs.existsSync(path.join(nativeRoot, "app", "src", "main", "assets", "restaurant-placeholder.svg")), "Customer must have a clean restaurant image fallback");

  for (const source of [customer, restaurant, rider]) {
    check(source.includes("orderChats/"), "All operational apps must use order-scoped chat");
    check(source.includes("maskPhoneNumbers"), "All operational apps must mask phone numbers in chat");
  }
  check(rules.orderChats && rules.restaurantLoad, "Database rules must include chat and restaurant-load trees");
  const order = rules.orders["$uid"]["$orderId"];
  check(order.pricing.rainFee && order.pricing.surgeFee, "Order pricing rules must validate rain and surge fees");
  check(order.contactProxy && order.contactProxy.customerToRider && order.contactProxy.restaurantToRider, "Order rules must support proxy-contact aliases");
  check(String(order[".read"]).includes("Handed to rider"), "Rider full order access must be gated by handover status");
});

test("Savrivo current issue batch contracts are present", () => {
  const customer = read(path.join(nativeRoot, "app", "src", "main", "assets", "premium.js"));
  const customerCss = read(path.join(nativeRoot, "app", "src", "main", "assets", "premium.css"));
  const admin = read(path.join(nativeRoot, "admin", "src", "main", "assets", "premium.js"));
  const adminJava = read(path.join(nativeRoot, "admin", "src", "main", "java", "com", "feastly", "admin", "MainActivity.java"));
  const restaurant = read(path.join(nativeRoot, "restaurant", "src", "main", "assets", "premium.js"));
  const restaurantJava = read(path.join(nativeRoot, "restaurant", "src", "main", "java", "com", "feastly", "restaurant", "MainActivity.java"));
  const rules = JSON.parse(read(rulesPath)).rules.feastly;

  check(customerCss.includes("fixed navigation + safe insets"), "Shared fixed-navigation hardening must be present");
  check(customerCss.includes(".floating-cart{position:fixed!important"), "Customer View Cart bar must be fixed above bottom nav");
  check(customerCss.includes("overflow-x:hidden!important"), "Sheets must block horizontal drift");
  check(customer.includes("localAdMarkup"), "Customer home must support local sponsored ads");
  check(customer.includes("postDeliveryCard"), "Customer home must retain delivered orders needing review");
  check(customer.includes("riderRating") && customer.includes("growthContribution"), "Post-delivery feedback must include rider rating and optional support contribution");
  check(customer.includes("processBroadcasts"), "Customer must receive Admin broadcast schedules");
  check(customer.includes("Savrivo Assistant"), "Customer support must start with text assistant flow");
  check(customer.includes('state.route = state.session ? "launch" : "login"'), "Customer must use launch state while restoring session");
  check(customer.includes("deliveryFeeOverrides") && customer.includes("Area override"), "Customer pricing must resolve delivery and area overrides");

  check(admin.includes("screenNotifications"), "Admin must have customer notification scheduling");
  check(admin.includes("screenAds"), "Admin must have local ad management");
  check(admin.includes("platformAreas") && admin.includes("deliveryAreas"), "Admin must expose area pricing overrides");
  check(admin.includes("Restaurant contact"), "Admin order details must show restaurant contact");
  check(admin.includes("openSupportTicket") && admin.includes("seenAt"), "Admin must mark support requests seen only when opened");
  check(adminJava.includes("startSupportAlarm"), "Admin native shell must support persistent support alert");
  check(!adminJava.includes("getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE"), "Admin screenshots must stay enabled in development build");

  check(restaurant.includes("declineOrder"), "Restaurant must be able to decline a new order");
  check(restaurant.includes("syncNewOrderAlarm"), "Restaurant must keep a new-order alert active until handled");
  check(restaurant.includes('state.route="launch"'), "Restaurant must use launch state while restoring session");
  check(restaurantJava.includes("startOrderAlarm") && restaurantJava.includes("setLooping(true)"), "Restaurant native shell must loop urgent order alert sound");
  check(!restaurantJava.includes("getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE"), "Restaurant screenshots must stay enabled in development build");

  check(rules.customerBroadcasts && rules.localAds, "Database rules must include notifications and local ads");
  check(rules.settings.customer.deliveryFeeOverrides, "Database rules must include scoped delivery overrides");
  check(rules.settings.customer.platformFeeOverrides.areas, "Database rules must include area platform overrides");
  check(String(rules.orderChats["$uid"]["$orderId"]["$channel"]["$messageId"].body[".validate"]).indexOf("{9}") === -1, "Chat phone guard must avoid Firebase-undeterminizable repetition");
});

for (const app of apps) {
  const moduleRoot = path.join(nativeRoot, app.module, "src", "main");
  const htmlPath = path.join(moduleRoot, "assets", "premium.html");
  const cssPath = path.join(moduleRoot, "assets", "premium.css");
  const jsPath = path.join(moduleRoot, "assets", "premium.js");
  const manifestPath = path.join(moduleRoot, "AndroidManifest.xml");

  test(`${app.name}: premium asset set is complete`, () => {
    for (const file of [htmlPath, cssPath, jsPath, manifestPath, app.java]) {
      check(fs.existsSync(file), `missing ${path.relative(workspaceRoot, file)}`);
      check(fs.statSync(file).size > 0, `${path.relative(workspaceRoot, file)} is empty`);
    }
  });

  test(`${app.name}: premium.js parses without syntax errors`, () => {
    const source = read(jsPath);
    // Compilation only: application code is not executed outside Android WebView.
    new Function(`${source}\n//# sourceURL=${app.module}/premium.js`);
    check(true, "premium.js compiled");
  });

  test(`${app.name}: modal UX does not use alert() or confirm()`, () => {
    const combined = `${read(htmlPath)}\n${read(jsPath)}`;
    const match = combined.match(/\b(?:window\s*\.\s*)?(alert|confirm)\s*\(/);
    check(!match, `found blocking ${match && match[1]}() call; use the shared toast/sheet UI`);
  });

  test(`${app.name}: rendered controls and forms have handlers`, () => {
    const source = read(jsPath);
    const actions = [...source.matchAll(/data-action=\\?"([a-z0-9-]+)\\?"/g)].map((match) => match[1]);
    const handledActions = [...source.matchAll(/(?:action|a)===\\?"([a-z0-9-]+)\\?"/g)].map((match) => match[1]);
    for (const match of source.matchAll(/\[((?:\s*"[a-z0-9-]+"\s*,?)+)\]\.includes\([^)]*dataset\.action\)/g)) {
      for (const actionMatch of match[1].matchAll(/"([a-z0-9-]+)"/g)) handledActions.push(actionMatch[1]);
    }
    const missingActions = [...new Set(actions)].filter((action) => !handledActions.includes(action));
    check(missingActions.length === 0, `rendered actions without a click handler: ${missingActions.join(", ")}`);

    const forms = [...source.matchAll(/<form id=\\?"([a-z0-9-]+)\\?"/g)].map((match) => match[1]);
    const handledForms = [...source.matchAll(/form\.id===\\?"([a-z0-9-]+)\\?"/g)].map((match) => match[1]);
    const missingForms = [...new Set(forms)].filter((form) => !handledForms.includes(form));
    check(missingForms.length === 0, `rendered forms without a submit handler: ${missingForms.join(", ")}`);
  });

  test(`${app.name}: visible branding is Savrivo`, () => {
    const html = read(htmlPath);
    const js = read(jsPath);
    check(html.includes(`<title>${app.title}</title>`), `expected title ${app.title}`);
    check(html.includes(app.title), `launch UI must visibly contain ${app.title}`);
    check(js.includes("Savrivo"), "premium.js must contain Savrivo-facing copy");
    check(!/Feastly/i.test(html), "premium.html still exposes legacy Feastly branding");
  });

  test(`${app.name}: Content Security Policy is present and restrictive`, () => {
    const html = read(htmlPath);
    const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
    check(match, "missing Content-Security-Policy meta tag");
    const csp = match[1];
    for (const directive of ["default-src", "connect-src", "img-src", "style-src", "script-src", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
      check(csp.includes(directive), `CSP is missing ${directive}`);
    }
    check(!/\bhttp:/.test(csp), "CSP must not allow cleartext HTTP");
    check(!/\bfile:/.test(csp), "CSP must not allow file origins");
    check(!csp.includes("'unsafe-eval'"), "CSP must not permit unsafe-eval");
    check(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src must not permit inline scripts");
    check(!/<script[^>]+src=["']https?:/i.test(html), "premium shell must not load remote scripts");
    check(html.includes('src="premium.js"'), "premium.html must load premium.js");
    check(html.includes('href="premium.css"'), "premium.html must load premium.css");
    check(!html.includes("maximum-scale=1"), "viewport must not disable user zoom");
  });

  test(`${app.name}: lifecycle contract is represented`, () => {
    if (!lifecycle) lifecycle = JSON.parse(read(lifecyclePath));
    const source = read(jsPath);
    const required = app.mustDisplayAllStates
      ? lifecycle.states
      : [...new Set(app.requiredRoles.flatMap((role) => lifecycle.owners[role] || []).concat(["Delivered", "Cancelled"]))];
    const missing = required.filter((state) => !source.includes(state));
    check(missing.length === 0, `missing lifecycle states: ${missing.join(", ")}`);
  });

  test(`${app.name}: manifest and native shell use premium release settings`, () => {
    const xml = read(manifestPath);
    const java = read(app.java);
    check(manifestAttribute(xml, "targetSdkVersion") === "36", "targetSdkVersion must be 36");
    check(manifestAttribute(xml, "allowBackup") === "false", "android:allowBackup must be false");
    check(manifestAttribute(xml, "usesCleartextTraffic") === "false", "android:usesCleartextTraffic must be false");
    check(manifestAttribute(xml, "label").startsWith("Savrivo"), "application label must start with Savrivo");
    check(/^@drawable\/savrivo[a-z0-9_]*icon$/.test(manifestAttribute(xml, "icon")), "application must use a Savrivo icon resource");
    const directlyLoadsPremium = java.includes('loadUrl("file:///android_asset/premium.html")');
    const loadsTrustedPremiumConstant = /TRUSTED_PAGE\s*=\s*"file:\/\/\/android_asset\/premium\.html"/.test(java)
      && /loadUrl\(TRUSTED_PAGE\)/.test(java);
    const loadsSecureAppAssetsOrigin = java.includes("appassets.androidplatform.net")
      && /TRUSTED_(?:PAGE|URL)\s*=\s*TRUSTED_ORIGIN\s*\+\s*"premium\.html"/.test(java)
      && /loadUrl\(TRUSTED_(?:PAGE|URL)\)/.test(java);
    check(directlyLoadsPremium || loadsTrustedPremiumConstant || loadsSecureAppAssetsOrigin, "MainActivity must load premium.html");
    if (loadsSecureAppAssetsOrigin) {
      check(!java.includes("setAllowUniversalAccessFromFileURLs(true)"), "secure shell must not enable universal file URL access");
      check(!java.includes("setAllowFileAccess(true)"), "secure shell must not enable file access");
      check(java.includes("appassets.androidplatform.net"), "secure shell must use the virtual app-assets origin");
    }
  });
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} validation group(s) failed:\n`);
  for (const failure of failures) process.stderr.write(`- ${failure.name}: ${failure.message}\n`);
  process.stderr.write(`\n${assertions} assertions evaluated.\n`);
  process.exit(1);
}

process.stdout.write(`\nPremium validation passed: ${assertions} assertions across ${apps.length} apps.\n`);

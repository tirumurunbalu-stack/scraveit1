#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const nativeRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(nativeRoot, "..");
const lifecyclePath = path.join(nativeRoot, "shared", "order-lifecycle.json");
const rulesPath = path.join(workspaceRoot, "firebase", "feastly-realtime-database-rules.json");
const storageRulesPath = path.join(workspaceRoot, "firebase", "storage.rules");

const apps = [
  {
    name: "customer",
    module: "app",
    title: "Scraveit",
    brand: "Scraveit",
    java: path.join(nativeRoot, "app", "src", "main", "java", "com", "feastly", "app", "MainActivity.java"),
    requiredRoles: ["customer"],
    mustDisplayAllStates: true,
  },
  {
    name: "control",
    module: "admin",
    title: "Scraveit Admin",
    brand: "Scraveit",
    java: path.join(nativeRoot, "admin", "src", "main", "java", "com", "feastly", "admin", "MainActivity.java"),
    requiredRoles: ["owner", "staff"],
    mustDisplayAllStates: true,
  },
  {
    name: "restaurant",
    module: "restaurant",
    title: "Scraveit Restaurant",
    brand: "Scraveit",
    java: path.join(nativeRoot, "restaurant", "src", "main", "java", "com", "feastly", "restaurant", "MainActivity.java"),
    requiredRoles: ["staff"],
    mustDisplayAllStates: false,
  },
  {
    name: "partner",
    module: "rider",
    title: "Scraveit Partner",
    brand: "Scraveit",
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

test("Android production build toolchain is pinned and release signing stays external", () => {
  const rootGradle = read(path.join(nativeRoot, "build.gradle"));
  const wrapper = read(path.join(nativeRoot, "gradle", "wrapper", "gradle-wrapper.properties"));
  const buildScript = read(path.join(nativeRoot, "build_savrivo.sh"));
  check(rootGradle.includes('id "com.android.application" version "9.0.1"'), "Android Gradle Plugin must stay pinned");
  check(wrapper.includes("gradle-9.1.0-bin.zip"), "Gradle wrapper version must stay pinned");
  check(/distributionSha256Sum=[a-f0-9]{64}/.test(wrapper), "Gradle distribution checksum must be pinned");
  check(rootGradle.includes("bundleProduction"), "four-app release bundle task is missing");
  check(rootGradle.includes("verifyProduction"), "four-app release verification task is missing");
  check(buildScript.includes("GRADLE_TASKS+=(verifyProduction)"), "release bundle command must run release lint");
  check(!/SAVRIVO_(?:STORE_PASS|KEY_PASS)/.test(buildScript), "build script must not accept signing passwords");
  check(!buildScript.includes("savrivo-developer.keystore"), "production build path must not use the developer keystore");
});

test("customer Google sign-in uses Credential Manager and a Firebase-compatible ID token", () => {
  const java = read(apps[0].java);
  const js = read(path.join(nativeRoot, "app", "src", "main", "assets", "premium.js"));
  const welcomeStart = js.indexOf("function screenWelcome()");
  const welcomeEnd = js.indexOf("function authHeader(", welcomeStart);
  const welcome = js.slice(welcomeStart, welcomeEnd);
  const googleServices = JSON.parse(read(path.join(nativeRoot, "app", "google-services.json")));
  const oauthClients = googleServices.client.flatMap((client) => client.oauth_client || []);
  check(java.includes("CredentialManager.create(this)"), "Customer app must initialize Credential Manager");
  check(java.includes("clearCredentialStateAsync"), "Customer app must clear Credential Manager state before showing the Google chooser");
  check(java.includes("new ClearCredentialStateRequest()"), "Customer Google chooser reset must use the official ClearCredentialStateRequest API");
  check(java.includes("GetSignInWithGoogleOption.Builder"), "Customer Google button must use the Sign in with Google button flow");
  check(java.includes("R.string.default_web_client_id"), "Google request must use the generated web client ID");
  check(java.includes("window.googleIdTokenReceived"), "native bridge must publish the Google ID token");
  check(!java.includes("AccountManager"), "deprecated AccountManager Google token flow must be removed");
  check(js.includes('completeGoogleSignIn("id_token",idToken)'), "Firebase REST exchange must use id_token");
  check(welcome.includes('data-action="google-signin"'), "Customer welcome screen must offer Continue with Google");
  check(googleServices.project_info.project_id === "savrivo-app", "Customer google-services.json must target savrivo-app");
  check(oauthClients.some((client) => client.client_type === 3), "Customer Firebase config needs a web OAuth client");
});

test("Customer production cloud bridge is authenticated, attested, and server-authoritative", () => {
  const customerRoot = path.join(nativeRoot, "app");
  const javaRoot = path.join(customerRoot, "src", "main", "java", "com", "feastly", "app");
  const java = read(path.join(javaRoot, "MainActivity.java"));
  const callable = read(path.join(javaRoot, "FirebaseCallableClient.java"));
  const messaging = read(path.join(javaRoot, "CustomerMessagingService.java"));
  const secureStore = read(path.join(javaRoot, "SecureOrderStore.java"));
  const application = read(path.join(javaRoot, "SavrivoApplication.java"));
  const debugAppCheck = read(path.join(customerRoot, "src", "debug", "java", "com", "feastly", "app", "AppCheckProviderInstaller.java"));
  const releaseAppCheck = read(path.join(customerRoot, "src", "release", "java", "com", "feastly", "app", "AppCheckProviderInstaller.java"));
  const manifest = read(path.join(customerRoot, "src", "main", "AndroidManifest.xml"));
  const gradle = read(path.join(customerRoot, "build.gradle"));
  const js = read(path.join(customerRoot, "src", "main", "assets", "premium.js"));
  const submitStart = js.indexOf("async function submitOrder()");
  const submitEnd = js.indexOf("async function submitLegacyCodOrder", submitStart);
  const submitOrder = js.slice(submitStart, submitEnd);

  check(gradle.includes('firebase-bom:34.18.0'), "Customer Firebase SDKs must use the compatible BoM");
  check(gradle.includes('firebase-messaging'), "Customer must package Firebase Messaging");
  check(gradle.includes('releaseImplementation "com.google.firebase:firebase-appcheck-playintegrity"'), "Release must use Play Integrity App Check");
  check(gradle.includes('debugImplementation "com.google.firebase:firebase-appcheck-debug"'), "Debug App Check provider must stay debug-only");
  check(gradle.includes('com.google.firebase.crashlytics') && application.includes("setCrashlyticsCollectionEnabled(!debugBuild)"), "Release Crashlytics must be configured without debug collection");
  check(debugAppCheck.includes("DebugAppCheckProviderFactory"), "Debug builds must install only the App Check debug provider");
  check(releaseAppCheck.includes("PlayIntegrityAppCheckProviderFactory"), "Release builds must install Play Integrity");

  check(manifest.includes('android:name=".SavrivoApplication"'), "Customer Firebase initialization Application is missing");
  check(manifest.includes('android:name=".CustomerMessagingService"') && manifest.includes("com.google.firebase.MESSAGING_EVENT"), "Customer FCM service is missing");
  check(manifest.includes('android:value="customer_orders"'), "Customer default FCM channel must match backend payloads");
  check(messaging.includes("onNewToken") && messaging.includes('"ORDER_STATUS"'), "Customer FCM token and order-status handlers are required");

  check(java.includes("registerPushToken(String requestId, String firebaseIdToken)"), "Native push-token registration bridge is missing");
  check(java.includes("unregisterPushToken(String requestId, String firebaseIdToken)"), "Native push-token removal bridge is missing");
  check(java.includes("createCodOrder(String requestId, String firebaseIdToken"), "Native COD callable bridge is missing");
  check(js.includes("FeastlyNative.recoverDeliveryOtp(requestId, firebaseIdToken"), "Customer OTP recovery must forward the resolved Firebase ID token");
  check(!js.includes("FeastlyNative.recoverDeliveryOtp(requestId, idToken"), "Customer OTP recovery must not reference an undefined token variable");
  check(callable.includes('setRequestProperty("Authorization", "Bearer " + firebaseIdToken)'), "Callable must authenticate with the current Firebase session");
  check(callable.includes('setRequestProperty("X-Firebase-AppCheck", appCheckToken)'), "Callable must attach native App Check attestation");
  check(callable.includes('"createCodOrder".equals(name)') && !callable.includes("functionName.matches"), "Native bridge must allowlist callable names");

  check(js.includes("const LEGACY_ORDER_WRITE_COMPATIBILITY = false"), "Legacy direct-order compatibility must be disabled by default");
  check(submitOrder.includes('nativeInvoke("createCodOrder"'), "Customer checkout must call the authoritative backend");
  check(submitOrder.includes("idempotencyKey:idempotencyKey") && js.includes("pendingIdempotencyKey"), "Checkout must persist a retry-stable idempotency key");
  check(!submitOrder.includes("pricing:") && !submitOrder.includes('db("PATCH",DB_ROOT,changes)'), "Production checkout must not claim success from client pricing or a direct RTDB write");
  check(!js.includes("weather.googleapis.com") && !js.includes("googleWeather") && !js.includes("CONFIG.apiKey,lat"), "Customer APK must not contain a Weather API endpoint or Firebase-key weather fallback");
  check(js.includes("serverAuthoritative:true") && js.includes("server-confirmed COD total"), "Dynamic fees and final COD total must be labelled server-authoritative");
  check(js.includes('localStorage.removeItem("savrivo.customer.deliveryOtps")') && !js.includes('saveJSON("savrivo.customer.deliveryOtps"'), "Delivery OTPs must not remain in WebView local storage");
  check(secureStore.includes('KeyStore.getInstance(KEYSTORE)') && secureStore.includes("AES/GCM/NoPadding"), "Delivery OTPs must use Android Keystore encryption");
});

test("Operations apps use authenticated native Firebase messaging and callable bridges", () => {
  const sharedRoot = path.join(nativeRoot, "shared", "firebase", "java", "com", "savrivo", "firebase");
  const proguard = read(path.join(nativeRoot, "proguard-rules.pro"));
  const firebase = read(path.join(sharedRoot, "SavrivoFirebase.java"));
  const callable = read(path.join(sharedRoot, "SavrivoCallableClient.java"));
  const bridge = read(path.join(sharedRoot, "SavrivoOperationsBridge.java"));
  const messaging = read(path.join(sharedRoot, "SavrivoMessagingService.java"));
  const alarm = read(path.join(sharedRoot, "OrderAlarmService.java"));
  const pushStore = read(path.join(sharedRoot, "SavrivoPushStore.java"));
  const googleSignIn = read(path.join(sharedRoot, "GoogleCredentialSignIn.java"));

  check(firebase.includes("PlayIntegrityAppCheckProviderFactory") && firebase.includes("DebugAppCheckProviderFactory"), "Operations apps need release Play Integrity and debug App Check boundaries");
  check(proguard.includes("-keep class com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory"), "Minified operations releases must retain the reflectively loaded Play Integrity provider");
  check(firebase.includes("setCrashlyticsCollectionEnabled(!debuggable)"), "Crashlytics collection must be disabled in debug builds");
  check(callable.includes('setRequestProperty("Authorization", "Bearer " + idToken)') && callable.includes('setRequestProperty("X-Firebase-AppCheck", appCheck)'), "Operations callables must include Firebase Auth and App Check tokens");
  check(callable.includes("getAppCheckToken(forceRefresh)") && callable.includes("mayRetryAppCheck") && callable.includes("HTTP_FORBIDDEN"), "Critical operations must force-refresh a stale App Check token once without bypassing verification");
  check(callable.includes('"registerPushToken", "unregisterPushToken", "updateOrderStatus", "claimRiderOrder"'), "Operations callable names must be explicitly allowlisted");
  check(callable.includes('"declineRiderOrder", "markRiderArrivedRestaurant", "getAdminDashboard"'), "Rider arrival and Admin dashboard callables must be explicitly allowlisted");
  for (const callableName of ["getRiderRewardsDashboard", "getAdminRiderRewardsDashboard", "upsertRiderRewardCampaignPolicy", "updateRiderRewardSettingsPolicy"]) {
    check(callable.includes(`"${callableName}"`), `Operations callable allowlist is missing ${callableName}`);
  }
  check(callable.includes('"recordCodRemittance"'), "Secure COD remittance callable must be explicitly allowlisted");
  check(googleSignIn.includes("clearCredentialStateAsync") && googleSignIn.includes("new ClearCredentialStateRequest()"), "Operations Google sign-in must clear credential-provider session state before account selection");
  check(googleSignIn.includes("GetSignInWithGoogleOption.Builder"), "Operations Google sign-in must use the explicit Sign in with Google button flow");
  check(/Callback current = callback;\s*resetState\(\);\s*if \(current != null\) current\.onIdToken\(token\);/.test(googleSignIn), "Operations Google sign-in must preserve the success callback before resetting native state");
  for (const method of ["registerPushToken", "unregisterPushToken", "updateOrderStatus", "claimRiderOrder", "markRiderArrivedRestaurant", "getAdminDashboard", "recordCodRemittance", "getRiderRewardsDashboard", "getAdminRiderRewardsDashboard", "upsertRiderRewardCampaignPolicy", "updateRiderRewardSettingsPolicy"]) {
    check(bridge.includes(`void ${method}(`), `Native operations bridge is missing ${method}`);
  }
  check(bridge.includes('!"admin".equals(SavrivoFirebase.appRole(activity))'), "Admin dashboard bridge must reject non-Admin applications");
  check(bridge.includes("validCodRemittancePayload(payload)") && bridge.includes("1_000_000_000L"), "Native COD remittance bridge must strictly validate integer paise payloads");
  check(bridge.includes("NATIVE_COD_REMITTANCE_UNAVAILABLE"), "Native COD remittance bridge must expose a bounded failure code");
  for (const type of ["RESTAURANT_NEW_ORDER", "STOP_ORDER_ALARM", "RIDER_ORDER_OFFER", "REMOVE_RIDER_OFFER", "ORDER_STATUS"]) {
    check(messaging.includes(`\"${type}\"`), `FCM handler is missing ${type}`);
  }
  check(alarm.includes("START_STICKY") && alarm.includes("validAlarmId") && alarm.includes("removeStored(this, alarmId)"), "Restaurant alarm must persist and stop by exact alarmId");
  check(alarm.includes("STOP_TOMBSTONE_MS") && alarm.includes("STALE_ALARM_START_IGNORED"), "A handled order must reject delayed or replayed alarm starts");
  check(alarm.includes("EXTRA_EXPIRES_AT") && alarm.includes('record.put("expiresAt", expiresAt)') && alarm.includes("pruneExpiredAlarms"), "Rider offer alarms must persist and prune their authoritative expiry");
  check(alarm.includes("ACTION_PAUSE") && alarm.includes("void pause(Context context, String alarmId)"), "Rider offer actions need a reversible native alarm pause without a stop tombstone");
  check(bridge.includes("pauseRiderOffer") && bridge.includes("orderId, offeredAt, expiresAt"), "Rider bridge must carry offer expiry and expose provisional alarm pause");
  check(messaging.includes("longValue(event.optString(\"offeredAt\")), expiresAt"), "Rider FCM alarm starts must carry the offer expiry into native persistence");
  check(pushStore.includes("removeRestaurantNewOrder") && messaging.includes('"Order placed".equals(event.optString("status"))'), "Restaurant FCM starts must be pending-only and stop must remove queued starts");
  check(pushStore.includes('removeEvent(context, "RIDER_ORDER_OFFER", orderId)') && pushStore.includes('eventType.equals(value.optString("type"))') && pushStore.includes('orderId.equals(value.optString("orderId"))'), "Rider offer removal must delete only the matching order event");

  const packages = {
    admin: "com.feastly.admin",
    restaurant: "com.feastly.restaurant",
    rider: "com.feastly.rider",
  };
  for (const [module, packageName] of Object.entries(packages)) {
    const manifest = read(path.join(nativeRoot, module, "src", "main", "AndroidManifest.xml"));
    const gradle = read(path.join(nativeRoot, module, "build.gradle"));
    const java = read(path.join(nativeRoot, module, "src", "main", "java", ...packageName.split("."), "MainActivity.java"));
    const js = read(path.join(nativeRoot, module, "src", "main", "assets", "premium.js"));
    const services = JSON.parse(read(path.join(nativeRoot, module, "google-services.json")));
    const packageClients = services.client.filter((client) => client.client_info.android_client_info.package_name === packageName);
    check(services.project_info.project_id === "savrivo-app" && packageClients.length === 1, `${module} Firebase config must contain exactly one matching savrivo-app client`);
    check(gradle.includes('id "com.google.gms.google-services"') && gradle.includes('id "com.google.firebase.crashlytics"'), `${module} must apply Google Services and Crashlytics plugins`);
    check(gradle.includes('firebase-messaging') && gradle.includes('firebase-appcheck-playintegrity') && gradle.includes('debugImplementation "com.google.firebase:firebase-appcheck-debug"'), `${module} must package Messaging and variant-safe App Check`);
    check(manifest.includes("com.savrivo.firebase.SavrivoMessagingService") && manifest.includes("com.google.firebase.MESSAGING_EVENT"), `${module} FCM service is missing`);
    check(java.includes('"SavrivoCloudNative"') && java.includes("SavrivoWebPushBinder"), `${module} native cloud/push bridge is missing`);
    check(js.includes("ORDER_STATUS") && js.includes("registerNativePush"), `${module} must refresh on status FCM and register its token`);
  }
  const adminJs = read(path.join(nativeRoot, "admin", "src", "main", "assets", "premium.js"));
  const riderJs = read(path.join(nativeRoot, "rider", "src", "main", "assets", "premium.js"));
  check(adminJs.includes("Rider rewards & incentives"), "Admin rewards control center must remain present");
  check(adminJs.includes('id="rider-reward-campaign-form"'), "Admin rider reward campaign editor form is missing");
  check(riderJs.includes("Authoritative rider earnings, incentives and COD visibility"), "Rider rewards overview screen must remain present");
  check(riderJs.includes("Extra earning offers"), "Rider extra earning offers screen must remain present");
  check(riderJs.includes("OFFER CONDITIONS"), "Rider extra offers must keep the conditions section visible");
  check(riderJs.includes("Your trips count:"), "Rider extra offers must show rider progress against offer targets");
  check(riderJs.includes("Earn upto "), "Rider extra offers must render milestone reward headlines");
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
  check(customer.includes("reviewsHydrated") && customer.includes("persistReviews()") && customer.includes("reviewCacheKey"), "Customer review state must hydrate before prompting and persist per signed-in account");
  check(customer.includes('if(!reviewStateReady())return null'), "Customer home must not flash a stale delivered-order review prompt during startup sync");
  check(customer.includes("ratingCount") && customer.includes("customer rating"), "Customer restaurant cards must expose verified aggregate rating counts");
  check(restaurant.includes("new EventSource"), "Restaurant must use scoped Firebase realtime streams");
  check(restaurant.includes("RESTAURANT_RECONCILE_INTERVAL_MS") && restaurant.includes('document.addEventListener("visibilitychange"') && restaurant.includes("triggerForegroundResync"), "Restaurant must force a foreground resync and visible-screen reconcile loop so rider arrival and handover state cannot remain stale");
  check(restaurant.includes('metric("CUSTOMER RATING"') && restaurant.includes("verified review"), "Restaurant dashboard must show its verified customer rating aggregate");
  check(rider.includes("new EventSource"), "Partner must use Firebase realtime streams");
  check(rider.includes('nativeInvoke("claimRiderOrder"'), "Partner offer claims must use the transactional callable");
  check(rider.includes('nativeInvoke("markRiderArrivedRestaurant"'), "Partner restaurant arrival must use the server-verified callable");
  check(!rider.includes('db("PATCH",ROOT+"/riderJobs/"+state.session.uid+"/"+o.id,{phase:"at_restaurant"'), "Partner must not self-assert restaurant arrival with a direct rider-job write");
  check(rider.includes("rider-kyc/"), "Partner KYC must upload to Storage path");
  check(!/riderDocuments[^\n]{0,300}data:image/i.test(rider), "Partner must not write Base64 KYC into RTDB");
  for (const module of ["app", "admin", "restaurant", "rider"]) {
    const config = read(path.join(nativeRoot, module, "src", "main", "assets", "firebase-config.js"));
    const services = JSON.parse(read(path.join(nativeRoot, module, "google-services.json")));
    const expectedApiKey = services.client
      .flatMap((client) => client.api_key || [])
      .map((entry) => entry.current_key)
      .find(Boolean);
    check(!!expectedApiKey, `${module} google-services.json must expose an API key`);
    check(config.includes(expectedApiKey), `${module} Firebase web config must match the live google-services API key`);
    check(config.includes("storageBucket"), `${module} Firebase config must declare Storage bucket`);
  }
});

test("Partner active-delivery tracking survives process and network failures safely", () => {
  const rider = read(path.join(nativeRoot, "rider", "src", "main", "assets", "premium.js"));
  const riderJava = read(path.join(nativeRoot, "rider", "src", "main", "java", "com", "feastly", "rider", "MainActivity.java"));
  const tracking = read(path.join(nativeRoot, "rider", "src", "main", "java", "com", "feastly", "rider", "TrackingService.java"));
  const operationsBridge = read(path.join(nativeRoot, "shared", "firebase", "java", "com", "savrivo", "firebase", "SavrivoOperationsBridge.java"));
  const messagingService = read(path.join(nativeRoot, "shared", "firebase", "java", "com", "savrivo", "firebase", "SavrivoMessagingService.java"));

  check(rider.includes("savrivo.partner.activeTracking"), "Partner must persist the active tracking pointer locally");
  check(rider.includes("savrivo.partner.pendingOffline"), "Partner must persist an offline write that could not reach Firebase");
  check(rider.includes("currentOffer.riderId===riderId") && rider.includes("currentOffer.expiresAt"), "Partner must render only its exact unexpired dispatch offer");
  check(rider.includes('ROOT+"/riderOffers/"+state.session.uid') && !rider.includes('db("GET",ROOT+"/dispatchQueue")'), "Partner must read only its private rider-offer inbox");
  check(rider.includes("ensureNativePushRegistered") && rider.includes("RIDER_PUSH_TOKEN_REGISTRATION_FAILED"), "Partner must retry failed push-token registration visibly");
  check(rider.includes("offers.forEach(startNativeOffer)") && operationsBridge.includes("startRiderOffer") && messagingService.includes('event.optString("offeredAt")'), "Partner must reconcile generation-aware pending server offers with the native alarm");
  check(rider.includes("pauseNativeOffer") && rider.includes("resumeNativeOffer") && rider.includes("recoverOfferAfterFailure"), "Partner claim/decline must provisionally pause and re-arm a valid offer after transient failure");
  check(rider.includes("permanentlySilenceNativeOffer") && rider.includes("terminalOfferFailure"), "Partner offers must be permanently silenced only after success or authoritative terminal state");
  check(rider.includes("o.otpRequired===true") && rider.includes("o.legacyOtpOrderSuffix===true") && !rider.includes("o.deliveryOtpHash"), "Partner delivery completion must use the public OTP-required projection and allow suffix fallback only for explicitly marked legacy orders");
  check(rider.includes("const otpReady=o.otpRequired===true||o.legacyOtpOrderSuffix===true") && rider.includes("(otpReady?'':'disabled')"), "Partner must block delivery completion when the rider-scoped projection does not authorize OTP verification");
  check(rider.includes('if(o.otpRequired!==true&&o.legacyOtpOrderSuffix!==true)'), "Partner completion must reject missing OTP capability before calling the authoritative transition");
  check(rider.includes('state.rewardsWeekPreview=null;state.rewardsDayKey=earningDateKey();state.rewardsReferenceAt=Date.now();state.rewardsLastSync=0;'), "Partner delivery completion must reset stale reward-date anchors before reopening earnings");
  check(rider.includes('loadRiderRewards(forceCurrentRewards,forceCurrentRewards?Date.now():undefined)'), "Partner must force a fresh current-day rewards refresh when entering earnings from live delivery flows");
  check(rider.includes("jobFromProjection") && !rider.includes('ROOT+"/orders/"'), "Partner jobs must use only the rider-scoped backend projection");
  check(rider.includes("startResilientTracking"), "Partner WebView must use the resilient native tracking bridge");
  check(rider.includes("refreshDeliveryTrackingCredentials"), "Partner WebView must refresh native tracking credentials");
  check(rider.includes("startAvailabilityTracking") && riderJava.includes("startAvailabilityService"), "Partner must keep an Android availability heartbeat while online without an active job");
  check(rider.includes('stopTracking("delivered")') && rider.includes('stopTracking("offline")'), "Partner must explicitly stop native tracking for terminal/offline transitions");

  check(riderJava.includes("trackingStateReceiver"), "Partner activity must receive visible native tracking state updates");
  check(riderJava.includes("stopDeliveryTrackingWithReason"), "Partner native bridge must preserve the tracking stop reason");
  check(riderJava.includes("refreshDeliveryTrackingCredentials"), "Partner native bridge must accept refreshed Firebase credentials");
  check(riderJava.includes("pendingTrackingServiceIntent") && riderJava.includes("resumePendingTrackingStart"), "Partner must defer blocked tracking-service starts until the activity is visible again");

  check(tracking.includes("START_REDELIVER_INTENT") && tracking.includes("restoreSession()"), "Foreground tracking must restore an active delivery after process recreation");
  check(tracking.includes('KeyStore.getInstance("AndroidKeyStore")') && tracking.includes("tokenEnvelope"), "Persisted tracking credentials must be protected by Android Keystore");
  check(!tracking.includes('.putString("token", token)') && !tracking.includes('.putString("refreshToken", refreshToken)'), "Tracking credentials must not be persisted as plaintext strings");
  check(tracking.includes("HEARTBEAT_INTERVAL_MS") && tracking.includes("publishPresence"), "Foreground tracking must heartbeat rider presence while active");
  check(tracking.includes("availabilityOnly") && tracking.includes("Online for offers"), "Foreground service must support idle online availability after the app is backgrounded");
  check(tracking.includes("verifyActiveJob") && tracking.includes('requestStop("assignment_terminal")'), "Foreground tracking must stop after cancellation, completion, or assignment removal");
  check(tracking.includes("MAX_LAST_KNOWN_AGE_MS") && tracking.includes("MAX_PROXIMITY_ACCURACY_METERS"), "Tracking must reject stale or poor GPS fixes");
  check(tracking.includes("int requiredFixes = 2"), "Automatic proximity milestones must require repeated reliable fixes");
  check(tracking.includes("proximityEvidence") && !tracking.includes("updateOrderStatus(candidate"), "GPS proximity must publish evidence without client-authoritative lifecycle writes");
  check(tracking.includes("transientResponse") && tracking.includes("backoff(attempt)"), "Firebase tracking writes must retry transient failures with backoff");
  check(tracking.includes("refreshIdToken()") && tracking.includes("ACTION_UPDATE_AUTH"), "Native tracking must refresh expired Firebase sessions without silent failure");
  check(tracking.includes('publishState("sync_error"'), "Native tracking failures must be exposed to the rider UI");
  check(tracking.includes("TRACKING_FOREGROUND_START_BLOCKED"), "Partner tracking must fail closed without crashing when Android blocks a foreground location start");
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
  check(restaurant.includes('nativeInvoke("updateOrderStatus"'), "Restaurant lifecycle changes must use the authenticated callable contract");
  check(restaurant.includes("SavrivoCloudNative"), "Restaurant lifecycle changes must cross the native Firebase bridge");
  check(restaurant.includes("screenKitchen"), "Restaurant app must include a kitchen operations board");
  check(!restaurant.includes("publishRestaurantLoad") && !restaurant.includes('db("PUT",ROOT+"/restaurantLoad/"'), "Restaurant clients must not publish server-owned workload or surge inputs");
  check(restaurant.includes("autoAcceptNewOrders"), "Restaurant app must support optional capacity-aware auto-accept");

  check(!admin.includes('data-action="set-status"'), "Admin UI must not perform normal restaurant lifecycle steps");
  check(admin.includes("platformFeeOverrides"), "Admin must expose scoped platform-fee overrides");
  check(admin.includes("deliverySlabs"), "Admin must expose distance delivery slabs");
  check(admin.includes("rainLightFee") && admin.includes("surgeLowFee"), "Admin must expose rain and surge controls");

  check(customer.includes("deliverySlabs"), "Customer must calculate distance delivery pricing");
  check(customer.includes("platformFeeDetails"), "Customer must resolve platform-fee overrides");
  check(!customer.includes("weather.googleapis.com"), "Customer must not call Google Weather directly");
  check(!customerHtml.includes("https://weather.googleapis.com"), "Customer CSP must not expose an unused Weather API origin");
  check(customer.includes("serverAuthoritative:true") && customer.includes("server-confirmed COD total"), "Weather/demand fees and the final COD total must be explicitly backend-authoritative");
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
  const adminHtml = read(path.join(nativeRoot, "admin", "src", "main", "assets", "premium.html"));
  const adminJava = read(path.join(nativeRoot, "admin", "src", "main", "java", "com", "feastly", "admin", "MainActivity.java"));
  const restaurant = read(path.join(nativeRoot, "restaurant", "src", "main", "assets", "premium.js"));
  const restaurantCss = read(path.join(nativeRoot, "restaurant", "src", "main", "assets", "premium.css"));
  const restaurantJava = read(path.join(nativeRoot, "restaurant", "src", "main", "java", "com", "feastly", "restaurant", "MainActivity.java"));
  const rider = read(path.join(nativeRoot, "rider", "src", "main", "assets", "premium.js"));
  const riderCss = read(path.join(nativeRoot, "rider", "src", "main", "assets", "premium.css"));
  const riderTracking = read(path.join(nativeRoot, "rider", "src", "main", "java", "com", "feastly", "rider", "TrackingService.java"));
  const operationsBridge = read(path.join(nativeRoot, "shared", "firebase", "java", "com", "savrivo", "firebase", "SavrivoOperationsBridge.java"));
  const callable = read(path.join(nativeRoot, "shared", "firebase", "java", "com", "savrivo", "firebase", "SavrivoCallableClient.java"));
  const rules = JSON.parse(read(rulesPath)).rules.feastly;

  check(customerCss.includes("true viewport-fixed navigation + safe vertical scrolling"), "Shared fixed-navigation hardening must be present");
  check(customerCss.includes(".floating-cart{position:fixed!important"), "Customer View Cart bar must be fixed above bottom nav");
  check(customerCss.includes("overflow-x:hidden!important"), "Sheets must block horizontal drift");
  check(customer.includes("localAdMarkup"), "Customer home must support local sponsored ads");
  check(customer.includes("postDeliveryCard"), "Customer home must retain delivered orders needing review");
  check(customer.includes("riderRating") && customer.includes("buildReviewPayload"), "Post-delivery feedback must retain restaurant and rider ratings");
  check(!customer.includes('name="postDeliveryTip"') && !customer.includes('name="growthContribution"'), "Customer reviews must not expose unverified post-delivery money choices");
  check(customer.includes("postDeliveryTip:0,growthContribution:0"), "Customer review payload must force unverified monetary fields to zero");
  check(customer.includes("processBroadcasts"), "Customer must receive Admin broadcast schedules");
  check(customer.includes("Scraveit Assistant"), "Customer support must start with text assistant flow");
  check(customer.includes('state.route = state.session ? "home" : "login"'), "Customer must render cached home immediately while restoring session");
  check(customer.includes("deliveryFeeOverrides") && customer.includes("Area override"), "Customer pricing must resolve delivery and area overrides");
  check(customer.includes('"the-waffle-spot-naidupeta"'), "Customer packaged catalogue must include The Waffle Spot");
  check(!customer.includes('"55-bistro":') && !customer.includes('"bombay-bowl":') && !customer.includes('"little-napoli":'), "Customer packaged catalogue must not restore retired demo restaurants");
  check(customer.includes('action==="clear-unavailable-cart"'), "Customer must safely reconcile a cart after its restaurant is archived");
  check(customer.includes("data.imageUrl || data.image || packaged.image"), "Live Waffle Spot data must retain its licensed packaged cover until owner media is uploaded");
  check(customer.includes("function searchKey") && customer.includes("function searchMatches"), "Customer search must ignore case, spacing and punctuation while supporting ordered-letter matching");
  check(customer.includes('type === "success" ? 900 : 5000'), "Customer success confirmations must clear quickly");
  check(fs.existsSync(path.join(nativeRoot, "app", "src", "main", "assets", "waffle-spot-cover.jpg")), "Waffle Spot must have a packaged, locally licensed cover image");

  check(admin.includes("screenNotifications"), "Admin must have customer notification scheduling");
  check(admin.includes("screenAds"), "Admin must have local ad management");
  check(admin.includes("platformAreas") && admin.includes("deliveryAreas"), "Admin must expose area pricing overrides");
  check(admin.includes("Restaurant contact"), "Admin order details must show restaurant contact");
  check(admin.includes('id="restaurant-phone"') && admin.includes('phone.replace(/\\D/g,"").length<10'), "Admin restaurant CRUD must capture and validate a contact number");
  check(admin.includes("openSupportTicket") && admin.includes("seenAt"), "Admin must mark support requests seen only when opened");
  check(admin.includes("supportTicketSheet") && admin.includes('s.type==="supportTicket"'), "Admin Open request must render the support ticket sheet");
  check(admin.includes("overlayNormalizedMenus") && admin.includes('changes["menus/"+r.id+"/"+id]'), "Admin menu CRUD must synchronize the normalized menu used by Customer and Restaurant apps");
  check(admin.includes('ROOT+"/restaurantOrders/"+encodeURIComponent(id)') && admin.includes('changes["menus/"+id]=null'), "Restaurant deletion must preserve order history or remove its orphaned normalized menu atomically");
  check(admin.includes("async function storageUpload") && admin.includes('"admin-uploads/"+state.session.uid'), "Admin media must upload compressed images to Firebase Storage");
  check(admin.includes("record.imageUrl=uploadedImageUrl") && admin.includes("item.imageUrl=uploadedImageUrl"), "Restaurant and food records must persist Storage URLs instead of embedded upload data");
  check(admin.includes("storageDelete(before.imageUrl)") && restaurant.includes("storageDelete(oldImageUrl)"), "Replacing restaurant or menu media must clean up the previous Storage object after commit");
  check(admin.includes("needsOwner=isNew||!!(ownerEmail||ownerPassword||ownerPasswordConfirm)"), "Editing an existing restaurant must not require or replace its owner account");
  check(admin.includes("nativeStorageUpload") && admin.includes("FeastlyAdminNative.uploadPreparedImage"), "Admin media must use the native upload path instead of WebView CORS in the installed app");
  check(admin.includes('preparedImage=await compressImageBlob') && admin.indexOf('preparedImage=await compressImageBlob') < admin.indexOf('accounts:signUp'), "Admin must validate the restaurant image before creating its owner login");
  check(admin.includes('await auth("accounts:delete",{idToken:createdOwnerAuth.idToken})'), "Admin must roll back a newly created owner login when restaurant onboarding fails");
  check(admin.includes('changes["restaurantMembers/"+id+"/"+ownerUid]') && admin.includes('await db("PATCH",ROOT,changes)'), "Restaurant and owner links must be committed atomically");
  check(!/role:"restaurant_owner",uid:/.test(admin), "Restaurant membership records must use the Firebase UID as the key without an unapproved duplicate uid field");
  check(adminHtml.includes("img-src 'self' data: blob: content:"), "Admin CSP must permit protected picker and temporary image previews");
  check(admin.includes("enhanceRestaurantEditor") && admin.includes("data-status-value=\"active\"") && admin.includes("data-status-value=\"paused\""), "Admin restaurant details must expose explicit Active and Paused availability controls");
  check(admin.includes("restaurantOwnerEmail") && admin.includes("Restaurant owner email"), "Admin restaurant details must display the linked owner email");
  check(admin.includes('needsOwner=isNew||!!(ownerEmail||ownerPassword||ownerPasswordConfirm)') && admin.includes("Assign restaurant owner (optional)"), "Ownerless restaurants must offer assignment without blocking unrelated catalogue or photo changes");
  check(admin.includes("delete record.ownerEmail") && admin.includes("delete record.ownerUid"), "Owner identity must remain in private membership data, not the public restaurant catalogue");
  check(admin.includes('id="restaurant-search"') && admin.includes("restaurantResultsMarkup"), "Admin must provide live restaurant search");
  check(admin.includes("transferRestaurantOwner") && admin.includes('s.type==="transferOwner"') && admin.includes('changes["restaurantMembers/"+rid+"/"+oldUid]=null') && admin.includes('ROOT+"/userRestaurants/"+encodeURIComponent(oldUid)'), "Admin must transfer restaurant membership atomically and clean up the old owner lookup");
  check(admin.includes('db("PATCH",ROOT+"/riders/"+encodeURIComponent(id),changes)') && !admin.includes('db("PUT",ROOT+"/riders/"+id,record)'), "Admin rider approval and rejection must patch only review fields allowed by Firebase rules");
  check(!admin.includes('state.riders[id].online=riderAvailable(id)') && !admin.includes('state.riders[data.riderId].id=data.riderId'), "Admin must not add display-only id or online fields to persisted rider records");
  check(adminJava.includes("prepareSelectedImage") && adminJava.includes("ImageDecoder") && adminJava.includes("Bitmap.CompressFormat.JPEG"), "Admin must decode, resize and compress selected restaurant/menu images natively");
  check(adminJava.includes("FileProvider.getUriForFile"), "Admin must return prepared images to the WebView through a protected FileProvider URI");
  check(adminJava.includes("uploadPreparedImage") && adminJava.includes("HttpURLConnection") && adminJava.includes("X-Goog-Meta-FirebaseStorageDownloadTokens"), "Admin native shell must upload prepared images directly to Firebase Storage");
  check(adminJava.includes("runOnUiThread(() -> beginPreparedImageUpload") && adminJava.includes("private void beginPreparedImageUpload"), "Admin image upload bridge must validate WebView state on the Android UI thread");
  check(adminJava.includes("settings.setAllowContentAccess(true)") && adminJava.includes("settings.setAllowFileAccess(false)"), "Admin must allow protected picker content without enabling arbitrary file access");
  check(!admin.includes('db("PUT",ROOT+"/catalog/restaurants",record)'), "Admin starter publishing must not replace the complete restaurant collection");
  check(admin.includes("stopSupportAlarmNow") && admin.includes("syncSupportAlarm();render"), "Admin support alarm must stop/reconcile after opening or resolving a request");
  check(adminJava.includes("startSupportAlarm"), "Admin native shell must support persistent support alert");
  check(!adminJava.includes("getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE"), "Admin screenshots must stay enabled in development build");

  check(restaurant.includes("declineOrder"), "Restaurant must be able to decline a new order");
  check(restaurant.includes('bridge.updateOrderStatus(id,values[0],values[1])') && !restaurant.includes('bridge[method].apply'), "Restaurant order actions must call the typed Android bridge directly");
  check(restaurantJava.includes("private volatile boolean trustedPageLoaded") && restaurantJava.includes("return webView != null && trustedPageLoaded") && !restaurantJava.includes("return webView != null && isTrustedPage(webView.getUrl())"), "Restaurant bridge trust checks must not read WebView from its worker thread");
  check(restaurantCss.includes('.sheet-backdrop{overflow:hidden;z-index:140!important}') && restaurantCss.includes('#decline-form .button[type="submit"]'), "Restaurant decline sheet and confirmation must stay above fixed navigation");
  check(restaurant.includes('id="menu-search"') && restaurant.includes("filteredMenuItems") && restaurant.includes("function searchMatches"), "Restaurant menu search must use normalized live matching");
  check(restaurant.includes("syncNewOrderAlarm"), "Restaurant must keep a new-order alert active until handled");
  check(restaurant.includes("syncSequence") && restaurant.includes("STALE_SYNC_IGNORED"), "Restaurant refreshes must ignore out-of-order responses");
  check(restaurant.includes("applyCommittedStatus") && restaurant.includes("statusAtOrBeyond"), "Restaurant actions must apply server state and tolerate cross-device idempotent results");
  check(restaurant.includes('state.route="launch"'), "Restaurant must use launch state while restoring session");
  const orderAlarmService = read(path.join(nativeRoot, "shared", "firebase", "java", "com", "savrivo", "firebase", "OrderAlarmService.java"));
  check(orderAlarmService.includes("START_ORDER_ALARM") && orderAlarmService.includes("MediaPlayer") && orderAlarmService.includes("savrivo_action_alert") && orderAlarmService.includes("setLooping(true)"), "Restaurant and Partner must loop the supplied Savrivo action alert sound");
  check(!orderAlarmService.includes("ToneGenerator") && !orderAlarmService.includes("RingtoneManager"), "Operational alerts must not reuse a generated tone, phone ringtone, or device default alarm");
  const alertHashes = ["restaurant", "rider", "admin"].map((module) => {
    const audio = fs.readFileSync(path.join(nativeRoot, module, "src", "main", "res", "raw", "savrivo_action_alert.mp3"));
    return crypto.createHash("sha256").update(audio).digest("hex");
  });
  check(new Set(alertHashes).size === 1 && alertHashes[0] === "f492c4f7d56d76ecd735537da68c452db7d8024fdd27c745164c1297187050ef", "Restaurant, Partner, and Admin must package the exact supplied alert audio");
  check(!restaurantJava.includes("getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE"), "Restaurant screenshots must stay enabled in development build");
  check(rider.includes('id="job-search"') && rider.includes("jobMatches") && rider.includes("function searchMatches"), "Partner delivery search must use normalized live matching");
  check(rider.includes("STALE_RIDER_SYNC_IGNORED") && rider.includes("appliedSyncSequence"), "Partner must ignore out-of-order offer refreshes");
  check(rider.includes("pendingOfferAction") && rider.includes("This offer has expired or was assigned"), "Partner offer actions must be single-flight and close expired offers");
  check(rider.includes("pendingJobAction") && rider.includes("Verifying restaurant arrival…") && rider.includes('state.jobPointers[o.id]=Object.assign({},state.jobPointers[o.id],{phase:"at_restaurant"') && rider.includes('render({preserve:true});toast(result&&result.idempotent?"Restaurant arrival already verified.":"Arrival at restaurant verified.","success");await syncApproved(true)'), "Partner restaurant arrival must be single-flight and update the UI immediately before the background resync completes");
  check(rider.includes('bridge.claimRiderOrder(id,values[0],values[1])') && rider.includes('bridge.declineRiderOrder(id,values[0],values[1])') && !rider.includes('bridge[method].apply'), "Partner decisions must call typed Android bridge methods instead of unsupported reflective apply");
  check(operationsBridge.includes('invokeOnMain(requestId, "NATIVE_RIDER_CLAIM_UNAVAILABLE"') && operationsBridge.includes('activity.runOnUiThread'), "Partner claim must enter Firebase from Android's main lifecycle thread");
  check(callable.includes('Looper.myLooper() != Looper.getMainLooper()') && callable.includes('MAIN.post(() -> requestAppCheckAndPerform'), "App Check token acquisition must be marshalled to Android's main thread");
  check(rider.includes("pauseNativeOffer(offer)") && rider.includes("silencedOfferEvents") && rider.includes("Decline offer"), "Partner decisions must provisionally stop the matching alarm while keeping Accept and Decline available");
  check(riderCss.includes(".sheet-backdrop{overflow:hidden;z-index:140!important}") && riderCss.includes(".offer-actions{position:sticky"), "Partner offer actions must remain visible above fixed navigation");
  check(rider.includes("Approx. pickup") && rider.includes("GPS straight-line estimate"), "Partner must label validated pickup distance honestly");
  check(!rider.includes("current&&state.online&&[\"Assigned\"") && rider.includes("current&&[\"Assigned\",\"Handed to rider\",\"Out for delivery\""), "Active delivery tracking must continue when new-job availability is paused");
  check(rider.includes("const started=await startTracking(o,\"delivery\");if(!started"), "Partner must not claim location was shared when native tracking did not start");
  check(rider.includes("Order status updated ") && !rider.includes(">Last updated "), "Partner job card must distinguish order status age from GPS freshness");
  check(riderTracking.includes("HEARTBEAT_INTERVAL_MS = 5_000L") && riderTracking.includes("LocationManager.GPS_PROVIDER, 3000, 0, this"), "Active delivery GPS must refresh every few seconds even while stationary");

  check(rules.customerBroadcasts && rules.localAds, "Database rules must include notifications and local ads");
  check(rules.settings.customer.deliveryFeeOverrides, "Database rules must include scoped delivery overrides");
  check(rules.settings.customer.platformFeeOverrides.areas, "Database rules must include area platform overrides");
  check(String(rules.userRestaurants["$uid"]["$restaurantId"][".validate"]).includes("!newData.exists()"), "Owner transfer must be allowed to remove the previous user-to-restaurant lookup");
  check(String(rules.orderChats["$uid"]["$orderId"]["$channel"]["$messageId"].body[".validate"]).indexOf("{9}") === -1, "Chat phone guard must avoid Firebase-undeterminizable repetition");
});

test("packaged assets exclude retired shells, backups, and demo restaurant media", () => {
  const retiredCustomerAssets = [
    "55-bistro.jpg",
    "chicken-biryani.jpg",
    "feastly_mark.png",
    "kulcha.jpg",
    "veg-meal.jpg",
  ];
  for (const file of retiredCustomerAssets) {
    check(!fs.existsSync(path.join(nativeRoot, "app", "src", "main", "assets", file)), `retired customer asset must not be packaged: ${file}`);
  }

  for (const app of apps) {
    const assetsRoot = path.join(nativeRoot, app.module, "src", "main", "assets");
    const packagedFiles = fs.readdirSync(assetsRoot);
    const obsolete = packagedFiles.filter((file) => file === "index.html" || file.includes(".before-") || file.endsWith(".save"));
    check(obsolete.length === 0, `${app.name} still packages obsolete asset files: ${obsolete.join(", ")}`);
  }
});

for (const app of apps) {
  const moduleRoot = path.join(nativeRoot, app.module, "src", "main");
  const htmlPath = path.join(moduleRoot, "assets", "premium.html");
  const cssPath = path.join(moduleRoot, "assets", "premium.css");
  const jsPath = path.join(moduleRoot, "assets", "premium.js");
  const manifestPath = path.join(moduleRoot, "AndroidManifest.xml");
  const buildGradlePath = path.join(nativeRoot, app.module, "build.gradle");

  test(`${app.name}: premium asset set is complete`, () => {
    for (const file of [htmlPath, cssPath, jsPath, manifestPath, buildGradlePath, app.java]) {
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

  test(`${app.name}: visible branding is ${app.brand}`, () => {
    const html = read(htmlPath);
    const js = read(jsPath);
    check(html.includes(`<title>${app.title}</title>`), `expected title ${app.title}`);
    check(html.includes(app.title), `launch UI must visibly contain ${app.title}`);
    check(js.includes(app.brand), `premium.js must contain ${app.brand}-facing copy`);
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
    const gradle = read(buildGradlePath);
    const java = read(app.java);
    check(/\bcompileSdk\s+36\b/.test(gradle), "compileSdk must be 36");
    check(/\bminSdk\s+23\b/.test(gradle), "minSdk must be 23");
    check(/\btargetSdk\s+36\b/.test(gradle), "targetSdk must be 36");
    const expectedVersionCode = app.name === "control" ? 50 : app.name === "restaurant" ? 45 : app.name === "partner" ? 64 : 52;
    check(new RegExp(`\\bversionCode\\s+${expectedVersionCode}\\b`).test(gradle), `versionCode must be ${expectedVersionCode}`);
    check(/\bbuildToolsVersion\s+"36\.0\.0"/.test(gradle), "Build Tools must be pinned to 36.0.0");
    check(manifestAttribute(xml, "allowBackup") === "false", "android:allowBackup must be false");
    check(manifestAttribute(xml, "fullBackupContent") === "false", "legacy Android backup must remain disabled");
    check(manifestAttribute(xml, "dataExtractionRules") === "@xml/data_extraction_rules", "cloud backup and device-transfer exclusion rules are required");
    const dataExtractionRules = read(path.join(nativeRoot, app.module, "src", "main", "res", "xml", "data_extraction_rules.xml"));
    for (const domain of ["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"]) {
      check(dataExtractionRules.includes(`domain="${domain}" path="."`), `data extraction rules must exclude ${domain}`);
    }
    check(manifestAttribute(xml, "usesCleartextTraffic") === "false", "android:usesCleartextTraffic must be false");
    const label = manifestAttribute(xml, "label");
    const icon = manifestAttribute(xml, "icon");
    if (app.name === "customer") {
      check(label === "@string/app_name", "Customer application label must use the localized app name");
      check(icon === "@mipmap/ic_launcher", "Customer application must use its adaptive launcher icon");
    } else {
      check(label === "@string/app_name", "application label must use the localized app name");
      check(icon === "@mipmap/ic_launcher", "application must use the shared Scraveit adaptive launcher icon");
      check(manifestAttribute(xml, "roundIcon") === "@mipmap/ic_launcher_round", "application must use the shared Scraveit round launcher icon");
    }
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

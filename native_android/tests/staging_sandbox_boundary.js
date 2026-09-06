#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const expectedProjectId = "savrivo-app";
const modules = [
  {
    role: "customer",
    packageName: "com.feastly.app",
    googleServices: path.join(root, "app/google-services.json"),
    webConfig: path.join(root, "app/src/main/assets/firebase-config.js"),
  },
  {
    role: "restaurant",
    packageName: "com.feastly.restaurant",
    googleServices: path.join(root, "restaurant/google-services.json"),
    webConfig: path.join(root, "restaurant/src/main/assets/firebase-config.js"),
  },
  {
    role: "rider",
    packageName: "com.feastly.rider",
    googleServices: path.join(root, "rider/google-services.json"),
    webConfig: path.join(root, "rider/src/main/assets/firebase-config.js"),
  },
  {
    role: "admin",
    packageName: "com.feastly.admin",
    googleServices: path.join(root, "admin/google-services.json"),
    webConfig: path.join(root, "admin/src/main/assets/firebase-config.js"),
  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

for (const module of modules) {
  const googleServices = readJson(module.googleServices);
  const projectId = String((googleServices.project_info || {}).project_id || "");
  check(projectId === expectedProjectId, `${module.role} google-services project must stay on ${expectedProjectId}`);
  const firebaseUrl = String((googleServices.project_info || {}).firebase_url || "");
  check(
    firebaseUrl === "https://savrivo-app-default-rtdb.firebaseio.com",
    `${module.role} google-services database URL must stay on staging`,
  );
  const matchingClients = (Array.isArray(googleServices.client) ? googleServices.client : [])
    .filter((client) => (((client || {}).client_info || {}).android_client_info || {}).package_name === module.packageName);
  check(matchingClients.length === 1, `${module.role} google-services must contain ${module.packageName}`);

  const webConfig = fs.readFileSync(module.webConfig, "utf8");
  check(webConfig.includes('projectId: "savrivo-app"'), `${module.role} WebView config must target staging`);
  check(
    webConfig.includes('databaseUrl: "https://savrivo-app-default-rtdb.firebaseio.com"'),
    `${module.role} WebView database URL must target staging`,
  );
}

const rootGradle = fs.readFileSync(path.join(root, "build.gradle"), "utf8");
check(
  rootGradle.includes('tasks.register("verifyStagingSandboxConfiguration"'),
  "root Gradle build must expose the staging sandbox config gate",
);
check(
  rootGradle.includes('tasks.register("assembleStagingSandbox"'),
  "root Gradle build must expose the staging sandbox assemble task",
);

const stagingBuildScript = fs.readFileSync(path.join(root, "build_staging_sandbox.sh"), "utf8");
check(
  stagingBuildScript.includes('tools/verify_staging_firebase.mjs'),
  "staging build script must validate the committed Firebase staging config before building",
);
check(
  stagingBuildScript.includes("Scraveit-Customer-STAGING-SANDBOX-debug.apk"),
  "staging build script must label copied artifacts as staging sandbox outputs",
);

const installScript = fs.readFileSync(path.join(root, "tools/install_staging_apks.sh"), "utf8");
for (const envName of [
  "SCRAVEIT_CUSTOMER_SERIAL",
  "SCRAVEIT_RESTAURANT_SERIAL",
  "SCRAVEIT_RIDER_A_SERIAL",
  "SCRAVEIT_RIDER_B_SERIAL",
]) {
  check(installScript.includes(envName), `install script must require ${envName}`);
}
check(
  installScript.includes("SCRAVEIT_ADMIN_SERIAL"),
  "install script must allow optional Admin installation",
);
for (const envName of ["SCRAVEIT_PHONE1_SERIAL", "SCRAVEIT_PHONE2_SERIAL"]) {
  check(installScript.includes(envName), `install script must support ${envName} for two-phone staging mode`);
}
check(
  installScript.includes("Phone 1") && installScript.includes("Phone 2"),
  "install script must label the two-phone staging deployment clearly",
);

const preflightScript = fs.readFileSync(path.join(root, "tools/staging_device_preflight.sh"), "utf8");
for (const envName of [
  "SCRAVEIT_CUSTOMER_SERIAL",
  "SCRAVEIT_RESTAURANT_SERIAL",
  "SCRAVEIT_RIDER_A_SERIAL",
  "SCRAVEIT_RIDER_B_SERIAL",
]) {
  check(preflightScript.includes(envName), `preflight script must require ${envName}`);
}
check(
  preflightScript.includes("Firebase staging project:")
    && preflightScript.includes('STAGING_PROJECT_ID="${SCRAVEIT_STAGING_PROJECT_ID:-savrivo-app}"'),
  "preflight script must record the current staging project in its evidence output and default it to savrivo-app",
);
check(
  preflightScript.includes("dumpsys webviewupdate")
    && preflightScript.includes("Any WebView package installed: true")
    && preflightScript.includes("Current WebView package is null"),
  "preflight script must fail early when a required device has no active WebView provider",
);
for (const envName of ["SCRAVEIT_PHONE1_SERIAL", "SCRAVEIT_PHONE2_SERIAL"]) {
  check(preflightScript.includes(envName), `preflight script must support ${envName} for two-phone staging mode`);
}
check(
  preflightScript.includes("Deployment mode: `%s`") || preflightScript.includes("Deployment mode:"),
  "preflight script must record the staging deployment mode",
);

const installGuide = fs.readFileSync(path.join(root, "INSTALL_AND_TEST.md"), "utf8");
check(
  installGuide.includes("staging") && installGuide.includes("September 1, 2026"),
  "install guide must describe the current staging sandbox window",
);
check(
  installGuide.includes("staging_device_preflight.sh"),
  "install guide must reference the staging device preflight script",
);
check(
  installGuide.includes("SCRAVEIT_PHONE1_SERIAL") && installGuide.includes("SCRAVEIT_PHONE2_SERIAL"),
  "install guide must document the two-phone staging mode",
);

const runbookPath = path.resolve(root, "..", "outputs/SCRAVEIT_STAGING_PHYSICAL_E2E_RUNBOOK_2026-08-25.md");
check(fs.existsSync(runbookPath), "staging physical E2E runbook must exist");
const runbook = fs.readFileSync(runbookPath, "utf8");
for (const heading of [
  "Test A — Standard order lifecycle",
  "Test B — Concurrent rider acceptance",
  "Test C — Restaurant alarms",
  "Test D — Rider notifications",
  "Test E — GPS arrival",
  "Test F — COD lifecycle",
  "Test G — Network loss and restart resilience",
  "Test H — Cancellation and refund edge cases",
]) {
  check(runbook.includes(heading), `runbook must cover ${heading}`);
}
check(
  runbook.includes("Phone 1") && runbook.includes("Phone 2"),
  "runbook must describe the two-phone staging execution layout",
);
check(
  runbook.includes("third phone"),
  "runbook must make clear that the true rider-race test needs a third phone",
);

console.log("Staging sandbox boundary checks passed.");

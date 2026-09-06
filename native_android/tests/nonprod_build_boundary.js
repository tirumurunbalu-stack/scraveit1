#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const nativeRoot = path.resolve(__dirname, "..");
const tool = path.join(nativeRoot, "tools", "prepare_nonprod_firebase.mjs");
const modules = [
  { role: "customer", source: "app", packageName: "com.feastly.app" },
  { role: "restaurant", source: "restaurant", packageName: "com.feastly.restaurant" },
  { role: "rider", source: "rider", packageName: "com.feastly.rider" },
  { role: "admin", source: "admin", packageName: "com.feastly.admin" },
];
let assertions = 0;

function check(value, message) {
  assertions += 1;
  if (!value) throw new Error(message);
}

function firebaseConfig(projectId, module, index) {
  return {
    project_info: {
      project_number: "1234567890",
      firebase_url: `https://${projectId}-default-rtdb.firebaseio.com`,
      project_id: projectId,
      storage_bucket: `${projectId}.firebasestorage.app`,
    },
    client: [{
      client_info: {
        mobilesdk_app_id: `1:1234567890:android:${String(index + 1).padStart(8, "0")}`,
        android_client_info: { package_name: module.packageName },
      },
      oauth_client: [{
        client_id: `1234567890-scraveit-isolated-${index + 1}.apps.googleusercontent.com`,
        client_type: 3,
      }],
      api_key: [{ current_key: `test_public_api_key_${index + 1}` }],
    }],
  };
}

function writeConfigs(root, projectForRole) {
  for (const [index, module] of modules.entries()) {
    const directory = path.join(root, module.role);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "google-services.json"),
      JSON.stringify(firebaseConfig(projectForRole(module.role), module, index)),
    );
  }
}

function run(args) {
  return spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scraveit-nonprod-boundary-"));
try {
  const validRoot = path.join(temporaryRoot, "valid");
  const outputRoot = path.join(temporaryRoot, "generated");
  writeConfigs(validRoot, () => "scraveit-isolated-test");
  const valid = run([validRoot, outputRoot]);
  check(valid.status === 0, `isolated config should pass: ${valid.stderr}`);
  for (const module of modules) {
    const webConfig = fs.readFileSync(path.join(outputRoot, module.role, "firebase-config.js"), "utf8");
    const html = fs.readFileSync(path.join(outputRoot, module.role, "premium.html"), "utf8");
    check(webConfig.includes('"scraveit-isolated-test"'), `${module.role} generated config must target the isolated project`);
    check(!webConfig.includes("savrivo-app"), `${module.role} generated config must not target production`);
    check(html.includes("https://scraveit-isolated-test-default-rtdb.firebaseio.com"), `${module.role} CSP must allow the isolated database`);
    check(!html.includes("https://savrivo-app-default-rtdb.firebaseio.com"), `${module.role} CSP must remove the production database`);
  }

  const productionRoot = path.join(temporaryRoot, "production");
  writeConfigs(productionRoot, () => "savrivo-app");
  const production = run([productionRoot, "--verify-only"]);
  check(production.status !== 0 && production.stderr.includes("targets the production project"), "production project must fail closed");

  const mixedRoot = path.join(temporaryRoot, "mixed");
  writeConfigs(mixedRoot, (role) => role === "rider" ? "scraveit-other-test" : "scraveit-isolated-test");
  const mixed = run([mixedRoot, "--verify-only"]);
  check(mixed.status !== 0 && mixed.stderr.includes("same isolated Firebase project"), "mixed Firebase projects must fail closed");

  const unsafeUrlRoot = path.join(temporaryRoot, "unsafe-url");
  writeConfigs(unsafeUrlRoot, () => "scraveit-isolated-test");
  const unsafeFile = path.join(unsafeUrlRoot, "customer", "google-services.json");
  const unsafeConfig = JSON.parse(fs.readFileSync(unsafeFile, "utf8"));
  unsafeConfig.project_info.firebase_url += "?redirect=savrivo-app";
  fs.writeFileSync(unsafeFile, JSON.stringify(unsafeConfig));
  const unsafeUrl = run([unsafeUrlRoot, "--verify-only"]);
  check(unsafeUrl.status !== 0 && unsafeUrl.stderr.includes("without credentials or a path"), "database URL query strings must fail closed");

  const missingOauthRoot = path.join(temporaryRoot, "missing-oauth");
  writeConfigs(missingOauthRoot, () => "scraveit-isolated-test");
  const missingOauthFile = path.join(missingOauthRoot, "admin", "google-services.json");
  const missingOauthConfig = JSON.parse(fs.readFileSync(missingOauthFile, "utf8"));
  delete missingOauthConfig.client[0].oauth_client;
  fs.writeFileSync(missingOauthFile, JSON.stringify(missingOauthConfig));
  const missingOauth = run([missingOauthRoot, "--verify-only"]);
  check(missingOauth.status !== 0 && missingOauth.stderr.includes("Web OAuth client"), "missing Google sign-in configuration must fail before compilation");

  const inSource = run([nativeRoot, "--verify-only"]);
  check(inSource.status !== 0 && inSource.stderr.includes("outside the source repository"), "Firebase inputs inside source must fail closed");

  const rootGradle = fs.readFileSync(path.join(nativeRoot, "build.gradle"), "utf8");
  check(rootGradle.includes('tasks.register("assembleNonProd")'), "root Gradle task assembleNonProd is required");
  check(rootGradle.includes('tasks.register("verifyNonProd")'), "root Gradle task verifyNonProd is required");
  check(rootGradle.includes('tasks.register("verifyNonProdGeneratedConfiguration")'), "generated isolated resources require a build gate");
  check(rootGradle.includes('tasks.register("verifyNonProdApks")'), "packaged isolated APKs require a native/WebView parity gate");
  check(rootGradle.includes('"verifyNonProdApks"'), "isolated assembly must depend on the packaged-resource gate");
  check(rootGradle.includes('nativeResources.contains("savrivo-app")'), "packaged native Firebase resources must reject production");
  const sharedGradle = fs.readFileSync(path.join(nativeRoot, "gradle", "nonprod-firebase.gradle"), "utf8");
  check(sharedGradle.includes("afterEvaluate"), "isolated Google Services input must override the plugin after variant registration");
  check(sharedGradle.includes("googleServicesJsonFiles.set(externalConfig"), "isolated native resources must use the external JSON file");
  check(!sharedGradle.includes('java.srcDir("src/debug/java")'), "isolated builds must not reuse committed debug App Check token sources");
  for (const module of modules) {
    const gradle = fs.readFileSync(path.join(nativeRoot, module.source, "build.gradle"), "utf8");
    const services = JSON.parse(fs.readFileSync(path.join(nativeRoot, module.source, "google-services.json"), "utf8"));
    const productionWebConfig = fs.readFileSync(
      path.join(nativeRoot, module.source, "src", "main", "assets", "firebase-config.js"),
      "utf8",
    );
    check(gradle.includes('gradle/nonprod-firebase.gradle'), `${module.role} must apply the isolated build seam`);
    check(gradle.includes(`applicationId "${module.packageName}"`), `${module.role} package identity must remain unchanged`);
    check(services.project_info.project_id === "savrivo-app", `${module.role} production default must remain unchanged`);
    check(productionWebConfig.includes('"savrivo-app"'), `${module.role} production WebView default must remain unchanged`);

    const isolatedInstaller = fs.readFileSync(
      path.join(
        nativeRoot,
        module.source,
        "src",
        "isolated",
        "java",
        ...module.packageName.split("."),
        "AppCheckProviderInstaller.java",
      ),
      "utf8",
    );
    check(
      isolatedInstaller.includes("DebugAppCheckProviderFactory.getInstance()"),
      `${module.role} isolated build must use the debug App Check provider`,
    );
    check(
      !isolatedInstaller.includes("StorageHelper") && !isolatedInstaller.includes("UUID.fromString"),
      `${module.role} isolated build must not embed or reuse a committed App Check debug token`,
    );
  }

  const tracking = fs.readFileSync(
    path.join(nativeRoot, "rider", "src", "main", "java", "com", "feastly", "rider", "TrackingService.java"),
    "utf8",
  );
  check(tracking.includes("getOptions().getDatabaseUrl()"), "rider tracking must resolve the selected Firebase database URL");
  check(!tracking.includes("savrivo-app-default-rtdb.firebaseio.com"), "rider tracking must not embed the production RTDB URL");

  process.stdout.write(`Non-production build boundary passed (${assertions} assertions).\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_PROJECT_ID = "savrivo-app";
const MODULES = Object.freeze([
  {
    role: "customer",
    packageName: "com.feastly.app",
    googleServices: "app/google-services.json",
    webConfig: "app/src/main/assets/firebase-config.js",
  },
  {
    role: "restaurant",
    packageName: "com.feastly.restaurant",
    googleServices: "restaurant/google-services.json",
    webConfig: "restaurant/src/main/assets/firebase-config.js",
  },
  {
    role: "rider",
    packageName: "com.feastly.rider",
    googleServices: "rider/google-services.json",
    webConfig: "rider/src/main/assets/firebase-config.js",
  },
  {
    role: "admin",
    packageName: "com.feastly.admin",
    googleServices: "admin/google-services.json",
    webConfig: "admin/src/main/assets/firebase-config.js",
  },
]);

function fail(message) {
  process.stderr.write(`Staging Firebase configuration rejected: ${message}\n`);
  process.exit(2);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file} is missing or is not valid JSON (${error.message}).`);
  }
}

function safeHttpsOrigin(value, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    fail(`${label} must be a valid HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    fail(`${label} must be an HTTPS origin without credentials or a path.`);
  }
  return url.origin;
}

function parseWebConfig(file) {
  const source = fs.readFileSync(file, "utf8");
  const apiKey = source.match(/apiKey:\s*"([^"]+)"/);
  const projectId = source.match(/projectId:\s*"([^"]+)"/);
  const databaseUrl = source.match(/databaseUrl:\s*"([^"]+)"/);
  const storageBucket = source.match(/storageBucket:\s*"([^"]+)"/);
  if (!apiKey || !projectId || !databaseUrl || !storageBucket) {
    fail(`${file} must expose apiKey, projectId, databaseUrl and storageBucket in window.FEASTLY_FIREBASE.`);
  }
  return {
    apiKey: apiKey[1],
    projectId: projectId[1],
    databaseUrl: safeHttpsOrigin(databaseUrl[1], `${file} databaseUrl`),
    storageBucket: String(storageBucket[1] || "").trim(),
  };
}

function validateModule(nativeRoot, module, expectedProjectId) {
  const googleServicesFile = path.join(nativeRoot, module.googleServices);
  const webConfigFile = path.join(nativeRoot, module.webConfig);
  const googleServices = readJson(googleServicesFile);
  const info = googleServices.project_info || {};
  const projectId = String(info.project_id || "").trim();
  if (!projectId) fail(`${googleServicesFile} has no project_info.project_id.`);
  if (projectId !== expectedProjectId) {
    fail(`${googleServicesFile} targets ${projectId}, expected ${expectedProjectId}.`);
  }
  const databaseUrl = safeHttpsOrigin(
    info.firebase_url,
    `${googleServicesFile} project_info.firebase_url`,
  );
  const storageBucket = String(info.storage_bucket || "").trim();
  if (!storageBucket) fail(`${googleServicesFile} has no project_info.storage_bucket.`);

  const matchingClients = (Array.isArray(googleServices.client) ? googleServices.client : []).filter((client) =>
    client?.client_info?.android_client_info?.package_name === module.packageName,
  );
  if (matchingClients.length !== 1) {
    fail(`${googleServicesFile} must contain exactly one Android client for ${module.packageName}.`);
  }

  const appId = String(matchingClients[0]?.client_info?.mobilesdk_app_id || "").trim();
  if (!appId) fail(`${googleServicesFile} is missing mobilesdk_app_id for ${module.packageName}.`);
  const apiKeys = (Array.isArray(matchingClients[0]?.api_key) ? matchingClients[0].api_key : [])
    .map((entry) => String(entry?.current_key || "").trim())
    .filter(Boolean);
  if (apiKeys.length !== 1) {
    fail(`${googleServicesFile} must contain exactly one api_key for ${module.packageName}.`);
  }

  const webConfig = parseWebConfig(webConfigFile);
  if (webConfig.projectId !== expectedProjectId) {
    fail(`${webConfigFile} targets ${webConfig.projectId}, expected ${expectedProjectId}.`);
  }
  if (webConfig.apiKey !== apiKeys[0]) {
    fail(`${webConfigFile} apiKey does not match ${googleServicesFile}.`);
  }
  if (webConfig.databaseUrl !== databaseUrl) {
    fail(`${webConfigFile} databaseUrl does not match ${googleServicesFile}.`);
  }
  if (webConfig.storageBucket !== storageBucket) {
    fail(`${webConfigFile} storageBucket does not match ${googleServicesFile}.`);
  }

  return {
    role: module.role,
    packageName: module.packageName,
    projectId,
    databaseUrl,
    storageBucket,
    appId,
  };
}

const nativeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedProjectId = String(process.argv[2] || process.env.SCRAVEIT_STAGING_PROJECT_ID || DEFAULT_PROJECT_ID).trim();
if (!expectedProjectId) fail("expected staging project id is required.");

const results = MODULES.map((module) => validateModule(nativeRoot, module, expectedProjectId));
const databaseOrigins = new Set(results.map((result) => result.databaseUrl));
const storageBuckets = new Set(results.map((result) => result.storageBucket));
if (databaseOrigins.size !== 1) fail("all four apps must share one staging Realtime Database origin.");
if (storageBuckets.size !== 1) fail("all four apps must share one staging Storage bucket.");

process.stdout.write(
  [
    `Verified current Android/WebView Firebase configuration for staging project ${expectedProjectId}.`,
    ...results.map((result) =>
      `${result.role}: ${result.packageName} -> ${result.projectId} (${result.databaseUrl})`),
  ].join("\n") + "\n",
);

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PRODUCTION_PROJECT_ID = "savrivo-app";
const MODULES = Object.freeze([
  { role: "customer", source: "app", packageName: "com.feastly.app" },
  { role: "restaurant", source: "restaurant", packageName: "com.feastly.restaurant" },
  { role: "rider", source: "rider", packageName: "com.feastly.rider" },
  { role: "admin", source: "admin", packageName: "com.feastly.admin" },
]);

function fail(message) {
  process.stderr.write(`Non-production Firebase configuration rejected: ${message}\n`);
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

function validateModule(configRoot, module) {
  const file = path.join(configRoot, module.role, "google-services.json");
  const json = readJson(file);
  const info = json.project_info || {};
  const projectId = String(info.project_id || "").trim();
  if (!projectId) fail(`${file} has no project_info.project_id.`);
  if (projectId === PRODUCTION_PROJECT_ID) {
    fail(`${file} targets the production project ${PRODUCTION_PROJECT_ID}.`);
  }
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    fail(`${file} has an invalid Firebase project_id.`);
  }

  const databaseUrl = safeHttpsOrigin(info.firebase_url, `${file} project_info.firebase_url`);
  const storageBucket = String(info.storage_bucket || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,222}$/.test(storageBucket)) {
    fail(`${file} has an invalid project_info.storage_bucket.`);
  }
  if (databaseUrl.includes(PRODUCTION_PROJECT_ID) || storageBucket.includes(PRODUCTION_PROJECT_ID)) {
    fail(`${file} still references a production Firebase resource.`);
  }

  const matchingClients = (Array.isArray(json.client) ? json.client : []).filter((client) =>
    client?.client_info?.android_client_info?.package_name === module.packageName,
  );
  if (matchingClients.length !== 1) {
    fail(`${file} must contain exactly one Android client for ${module.packageName}.`);
  }
  const client = matchingClients[0];
  const appId = String(client?.client_info?.mobilesdk_app_id || "").trim();
  const apiKeys = (Array.isArray(client?.api_key) ? client.api_key : [])
    .map((entry) => String(entry?.current_key || "").trim())
    .filter(Boolean);
  const webOauthClients = (Array.isArray(client?.oauth_client) ? client.oauth_client : [])
    .filter((entry) => Number(entry?.client_type) === 3)
    .map((entry) => String(entry?.client_id || "").trim())
    .filter(Boolean);
  if (!appId || apiKeys.length !== 1 || webOauthClients.length !== 1) {
    fail(
      `${file} must contain one mobile SDK app ID, one public API key and one Web OAuth ` +
      `client (client_type 3) for ${module.packageName}.`,
    );
  }

  return { module, file, projectId, databaseUrl, storageBucket, apiKey: apiKeys[0] };
}

function rewriteCsp(html, databaseOrigin) {
  const metaPattern = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)(">)/i;
  const match = html.match(metaPattern);
  if (!match) fail("premium.html is missing its Content-Security-Policy meta tag.");
  const directives = match[2].split(";").map((part) => part.trim()).filter(Boolean);
  const connectIndex = directives.findIndex((part) => part.startsWith("connect-src "));
  if (connectIndex < 0) fail("premium.html CSP is missing connect-src.");
  const tokens = directives[connectIndex].split(/\s+/).filter(Boolean);
  const filtered = tokens.filter((token, index) => {
    if (index === 0) return true;
    try {
      const host = new URL(token).hostname;
      return !(host.endsWith(".firebaseio.com") || host.endsWith(".firebasedatabase.app"));
    } catch {
      return true;
    }
  });
  filtered.push(databaseOrigin);
  directives[connectIndex] = [...new Set(filtered)].join(" ");
  const csp = `${directives.join("; ")};`;
  return html.replace(metaPattern, `$1${csp}$3`);
}

function generateAssets(nativeRoot, outputRoot, configuration) {
  const sourceRoot = path.join(nativeRoot, configuration.module.source, "src", "main", "assets");
  const destination = path.join(outputRoot, configuration.module.role);
  const html = rewriteCsp(
    fs.readFileSync(path.join(sourceRoot, "premium.html"), "utf8"),
    configuration.databaseUrl,
  );
  const webConfig = {
    apiKey: configuration.apiKey,
    projectId: configuration.projectId,
    databaseUrl: configuration.databaseUrl,
    storageBucket: configuration.storageBucket,
  };
  const javascript = `window.FEASTLY_FIREBASE = ${JSON.stringify(webConfig, null, 2)};\n`;
  if (html.includes(PRODUCTION_PROJECT_ID) || javascript.includes(PRODUCTION_PROJECT_ID)) {
    fail(`generated ${configuration.module.role} assets retain a production Firebase reference.`);
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "premium.html"), html);
  fs.writeFileSync(path.join(destination, "firebase-config.js"), javascript);
}

const nativeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify-only");
const positional = args.filter((arg) => arg !== "--verify-only");
if (positional.length < 1 || positional.length > 2 || (!verifyOnly && positional.length !== 2)) {
  fail("usage: prepare_nonprod_firebase.mjs <external-config-dir> [generated-assets-dir] [--verify-only]");
}

const configRoot = path.resolve(positional[0]);
const outputRoot = positional[1] ? path.resolve(positional[1]) : "";
const configRelativeToSource = path.relative(nativeRoot, configRoot);
if (!configRelativeToSource.startsWith("..") && !path.isAbsolute(configRelativeToSource)) {
  fail("the Firebase input directory must be outside the source repository.");
}
if (!verifyOnly) {
  const approvedGeneratedRoot = path.join(
    nativeRoot,
    "build",
    "generated",
    "scraveitNonProdFirebase",
    "assets",
  );
  const outputRelativeToSource = path.relative(nativeRoot, outputRoot);
  const outputIsInsideSource =
    !outputRelativeToSource.startsWith("..") && !path.isAbsolute(outputRelativeToSource);
  if (outputIsInsideSource && outputRoot !== approvedGeneratedRoot) {
    fail("generated assets inside the repository may only be written under the dedicated build directory.");
  }
  if (outputRoot === configRoot) {
    fail("the generated-assets directory must not be the Firebase input directory.");
  }
}
const configurations = MODULES.map((module) => validateModule(configRoot, module));
const projectIds = new Set(configurations.map((entry) => entry.projectId));
if (projectIds.size !== 1) fail("all four Android clients must target the same isolated Firebase project.");

if (!verifyOnly) {
  for (const { role } of MODULES) {
    fs.rmSync(path.join(outputRoot, role), { recursive: true, force: true });
  }
  for (const configuration of configurations) generateAssets(nativeRoot, outputRoot, configuration);
}

process.stdout.write(
  verifyOnly
    ? "Verified four isolated Firebase Android clients.\n"
    : "Prepared isolated Firebase WebView assets for four Android clients.\n",
);

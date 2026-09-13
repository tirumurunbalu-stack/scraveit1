#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");

const sourcePath = path.join(__dirname, "..", "admin", "src", "main", "assets", "premium.js");
const retryKey = "savrivo.control.codRemittancePending";
const sessionKey = "savrivo.control.session";
const marker = "\n  if(!window.__SAVRIVO_ADMIN_TEST__)bootstrap();\n})();";
const source = fs.readFileSync(sourcePath, "utf8");
assert(source.includes(marker), "Admin test seam could not locate bootstrap marker");
const instrumented = source.replace(marker, `
  globalThis.__COD_TEST__={
    state,openCodRemittance,submitCodRemittance,codExposureSection,codRemittanceSheet,
    validCodExposure,rupeesInputToPaise,validCodRemittanceResult,pendingCodRemittance,
    codRemittanceFingerprint
  };
})();`);

function element() {
  return {
    innerHTML: "",
    value: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
}

class TestForm {
  constructor(values, dataset) {
    this.values = Object.assign({}, values);
    this.dataset = Object.assign({}, dataset);
    this.button = { disabled: false, innerHTML: "", textContent: "" };
  }
  querySelector(selector) {
    return selector.includes("button") ? this.button : null;
  }
}

class TestFormData {
  constructor(form) { this.form = form; }
  get(key) {
    return Object.prototype.hasOwnProperty.call(this.form.values, key)
      ? this.form.values[key]
      : null;
  }
}

function dashboardProjection() {
  return {
    scope: "bounded_operational_snapshot",
    generatedAt: 1_700_000_003_000,
    activeOrders: [],
    recentOrders: [],
    statusCounts: {},
    finance: {
      scope: "bounded_recent_journals",
      complete: true,
      journalCount: 0,
      invalidJournalCount: 0,
      oldestOccurredAt: 0,
      newestOccurredAt: 0,
      eventCounts: {},
      windowNetMovementPaise: {},
    },
    codExposure: {
      scope: "bounded_positive_cod_exposure",
      complete: true,
      truncated: false,
      riderCount: 1,
      invalidWalletCount: 0,
      riders: [{
        riderId: "rider-1",
        codOutstandingPaise: 10_000,
        codOutstandingLimitPaise: 20_000,
        codRemittanceReservedPaise: 0,
        availableToRemitPaise: 10_000,
        codBlocked: false,
      }],
    },
  };
}

function createRuntime(storage, remittanceMode) {
  const nodes = new Map([
    ["app", element()],
    ["toast-region", element()],
    ["sheet-region", element()],
  ]);
  const calls = { dashboard: 0, remittance: [] };
  const localStorage = {
    getItem(key) { return storage.has(String(key)) ? storage.get(String(key)) : null; },
    setItem(key, value) { storage.set(String(key), String(value)); },
    removeItem(key) { storage.delete(String(key)); },
  };
  const document = {
    visibilityState: "visible",
    documentElement: { dataset: {} },
    getElementById(id) { return nodes.get(String(id)) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const context = {
    console,
    crypto: webcrypto,
    TextEncoder,
    AbortController,
    URL,
    Blob,
    Intl,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    Promise,
    RegExp,
    Error,
    HTMLFormElement: TestForm,
    FormData: TestFormData,
    document,
    localStorage,
    navigator: { onLine: true },
    FEASTLY_FIREBASE: {
      databaseUrl: "https://example.invalid",
      storageBucket: "example.invalid",
      apiKey: "test-api-key",
    },
    Image: class {},
    EventSource: class {},
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame(callback) { callback(); },
    cancelAnimationFrame() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    addEventListener() {},
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    fetch: async () => ({ ok: true, status: 200, text: async () => "null" }),
  };
  context.window = context;
  context.globalThis = context;
  context.SavrivoCloudNative = {
    getAdminDashboard(requestId) {
      calls.dashboard += 1;
      context.SavrivoNativeCallbacks.resolve(requestId, true, dashboardProjection());
    },
    recordCodRemittance(requestId, idToken, payloadJson) {
      assert.strictEqual(idToken, "a".repeat(64), "remittance must use the active Firebase ID token");
      const payload = JSON.parse(payloadJson);
      calls.remittance.push(payload);
      if (remittanceMode === "fail") {
        context.SavrivoNativeCallbacks.resolve(requestId, false, {
          error: { message: "CLOUD_OPERATION_TIMEOUT" },
        });
        return;
      }
      context.SavrivoNativeCallbacks.resolve(requestId, true, {
        operationId: payload.operationId,
        riderId: payload.riderId,
        amountPaise: payload.amountPaise,
        remainingOutstandingPaise: 7_500,
        method: payload.method,
        status: "completed",
        ledgerJournalId: "journal-cod-remit-1",
        completedAt: 1_700_000_010_000,
        idempotent: remittanceMode === "success-idempotent",
      });
    },
  };
  vm.createContext(context);
  vm.runInContext(instrumented, context, { filename: sourcePath });
  return { context, api: context.__COD_TEST__, calls, nodes };
}

function ownerSession() {
  return {
    uid: "admin-cod-owner",
    email: "owner@example.test",
    idToken: "a".repeat(64),
    refreshToken: "b".repeat(64),
    expiresAt: Date.now() + 3_600_000,
    name: "COD Owner",
  };
}

function prepareOwner(runtime, withExposure) {
  runtime.api.state.role = "owner";
  runtime.api.state.session = ownerSession();
  runtime.api.state.dashboardCodExposure = withExposure
    ? runtime.api.validCodExposure(dashboardProjection().codExposure)
    : null;
}

function formFor(sheet, amount, method, referenceId) {
  return new TestForm(
    { amount, method, referenceId },
    { riderId: sheet.riderId, operationId: sheet.operationId },
  );
}

(async () => {
  const parserStorage = new Map([[sessionKey, JSON.stringify(ownerSession())]]);
  const parserRuntime = createRuntime(parserStorage, "fail");
  const parse = parserRuntime.api.rupeesInputToPaise;
  assert.strictEqual(parse("25.00"), 2_500);
  assert.strictEqual(parse("0.01"), 1);
  assert.strictEqual(parse("1"), 100);
  assert.strictEqual(parse("1.2"), 120);
  for (const value of ["0", "-1", "1.234", "1e2", "10000000.01", "01.00"])
    assert.strictEqual(parse(value), null, `invalid rupee input accepted: ${value}`);

  prepareOwner(parserRuntime, true);
  assert(parserRuntime.api.codExposureSection().includes("Record verified remittance"));
  parserRuntime.api.openCodRemittance("rider-1");
  const firstSheet = Object.assign({}, parserRuntime.api.state.sheet);
  assert(firstSheet.operationId && firstSheet.riderId === "rider-1");
  const firstForm = formFor(firstSheet, "25.00", "upi", "UPI:receipt/2026-08-25");
  await parserRuntime.api.submitCodRemittance(firstForm);

  assert.strictEqual(parserRuntime.calls.remittance.length, 1, "first secure callable was not invoked once");
  const firstPayload = parserRuntime.calls.remittance[0];
  assert.strictEqual(firstPayload.amountPaise, 2_500);
  assert.strictEqual(firstPayload.method, "upi");
  assert.strictEqual(firstPayload.referenceId, "UPI:receipt/2026-08-25");
  const durableAfterTimeout = JSON.parse(parserStorage.get(retryKey));
  assert.strictEqual(durableAfterTimeout.operationId, firstPayload.operationId);
  assert.strictEqual(durableAfterTimeout.riderId, firstPayload.riderId);
  assert.strictEqual(
    durableAfterTimeout.fingerprint,
    parserRuntime.api.codRemittanceFingerprint(firstPayload),
    "exact payload fingerprint was not persisted before the failed response",
  );
  assert(parserRuntime.api.pendingCodRemittance(), "timeout must retain the durable retry request");

  // Simulate process death/restart with the same local app storage. The dashboard row may vanish
  // after the server committed but before this client received the response; exact retry remains safe.
  const restartRuntime = createRuntime(parserStorage, "success-idempotent");
  prepareOwner(restartRuntime, false);
  const restored = restartRuntime.api.pendingCodRemittance();
  assert(restored, "pending remittance was not restored after app restart");
  assert.strictEqual(restored.operationId, firstPayload.operationId);
  restartRuntime.api.openCodRemittance("rider-1");
  assert.strictEqual(restartRuntime.api.state.sheet.operationId, firstPayload.operationId);

  await restartRuntime.api.submitCodRemittance(
    formFor(restartRuntime.api.state.sheet, "25.01", "upi", "UPI:receipt/2026-08-25"),
  );
  assert.strictEqual(restartRuntime.calls.remittance.length, 0, "altered retry payload reached the callable");
  assert.strictEqual(JSON.parse(parserStorage.get(retryKey)).fingerprint, durableAfterTimeout.fingerprint);

  await restartRuntime.api.submitCodRemittance(
    formFor(restartRuntime.api.state.sheet, "25.00", "upi", "UPI:receipt/2026-08-25"),
  );
  assert.strictEqual(restartRuntime.calls.remittance.length, 1, "exact retry did not invoke the callable once");
  assert.deepStrictEqual(restartRuntime.calls.remittance[0], firstPayload, "app restart changed the idempotent request payload");
  assert.strictEqual(parserStorage.has(retryKey), false, "validated success did not clear the exact retry marker");
  assert.strictEqual(restartRuntime.api.state.sheet, null, "successful remittance sheet stayed open");
  assert(restartRuntime.calls.dashboard >= 1, "dashboard projection was not refreshed after success");

  const staffStorage = new Map([[sessionKey, JSON.stringify(ownerSession())]]);
  const staffRuntime = createRuntime(staffStorage, "success-idempotent");
  staffRuntime.api.state.role = "staff";
  staffRuntime.api.state.staff = { active: true, permissions: { orders: true } };
  staffRuntime.api.state.session = ownerSession();
  staffRuntime.api.state.dashboardCodExposure = staffRuntime.api.validCodExposure(dashboardProjection().codExposure);
  staffRuntime.api.openCodRemittance("rider-1");
  assert.strictEqual(staffRuntime.api.state.sheet, null, "staff account opened owner-only remittance sheet");
  assert.strictEqual(staffRuntime.calls.remittance.length, 0, "staff account invoked remittance callable");

  const submitSource = source.slice(
    source.indexOf("async function submitCodRemittance"),
    source.indexOf("function randomPassword", source.indexOf("async function submitCodRemittance")),
  );
  assert(submitSource.indexOf("persistCodRemittanceRetry(payload)") < submitSource.indexOf('nativeInvoke("recordCodRemittance"'),
    "durable retry must be persisted before invoking the secure callable");
  assert(!submitSource.includes('db("PATCH"') && !submitSource.includes('db("PUT"'),
    "COD remittance UI must never mutate money data directly");

  process.stdout.write("admin COD remittance tests passed (exact restart retry, strict money input, owner-only callable)\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

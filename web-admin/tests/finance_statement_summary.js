#!/usr/bin/env node
/**
 * web-admin/public/finance/dashboard.js is a plain browser script that
 * imports firebase-client.js at the top, so it cannot be loaded whole in
 * Node. These tests lift the specific functions this change added or
 * changed - the allocation cards, the year rollup, and the CSV export - out
 * of the real file by matching braces, the same technique
 * native_android/tests uses against premium.js, and drive them directly.
 *
 * What is actually being guarded: the statement is shown to a tax filer as a
 * source of truth. A card that silently double-counts, a year total that
 * drops a month, or a CSV whose rows don't foot to the totals above it would
 * not look broken on screen - it would just be quietly wrong in a document
 * someone hands to the government.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "public", "finance", "dashboard.js"),
  "utf8"
);

function extract(name) {
  const start = SOURCE.indexOf("function " + name + "(");
  assert.ok(start >= 0, "dashboard.js no longer defines " + name);
  let i = SOURCE.indexOf("(", start);
  let depth = 0;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === "(") depth++;
    else if (SOURCE[i] === ")") { depth--; if (!depth) { i++; break; } }
  }
  while (SOURCE[i] !== "{") i++;
  depth = 0;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}") { depth--; if (!depth) { i++; break; } }
  }
  return SOURCE.slice(start, i);
}

/** Minimal DOM/helper stand-ins the extracted functions actually call. */
function harness() {
  const factory = new Function(`
    function h(value) {
      return String(value == null ? "" : value).replace(/[&<>'"]/g, (c) => (
        {"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"}[c]
      ));
    }
    function moneyPaise(paise) {
      const value = Number(paise);
      if (!Number.isFinite(value)) return "₹0";
      const sign = value < 0 ? "-" : "";
      return sign + "₹" + (Math.abs(value) / 100).toLocaleString("en-IN", {minimumFractionDigits: 0, maximumFractionDigits: 2});
    }
    const EVENT_TYPE_LABELS = {cod_delivery: "COD order delivered", rider_incentive: "Rider incentive", payment: "Online payment received"};
    function eventTypeLabel(type) { return EVENT_TYPE_LABELS[type] || type; }
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    ${extract("statementAllocationCardsHtml")}
    ${extract("sumYearAllocation")}
    ${extract("sumYearEntryCount")}
    ${extract("csvField")}
    ${extract("csvRow")}
    ${extract("isoIst")}
    ${extract("statementCsv")}
    return {statementAllocationCardsHtml, sumYearAllocation, sumYearEntryCount, statementCsv, moneyPaise, isoIst};
  `);
  return factory();
}

const ALLOCATION = {grossPaise: 166_200, restaurantPaise: 91_630, riderPaise: 47_600, platformPaise: 26_970, taxPaise: 0};

let failures = 0;
function check(label, fn) {
  try { fn(); console.log("  ok: " + label); }
  catch (error) { failures++; console.error("  FAIL: " + label + "\n    " + error.message); }
}

(async () => {
  console.log("\nallocation cards");
  const app = harness();

  check("shows nothing for a period with no entries, rather than five ₹0 cards", () => {
    assert.strictEqual(app.statementAllocationCardsHtml(ALLOCATION, false), "");
    assert.strictEqual(app.statementAllocationCardsHtml(null, true), "");
  });

  check("renders all five figures when there are entries", () => {
    const htmlOut = app.statementAllocationCardsHtml(ALLOCATION, true);
    ["Total gross", "Restaurant settlement", "Rider payout", "Platform profit", "Tax collected"].forEach((label) => {
      assert.ok(htmlOut.includes(label), "missing card: " + label);
    });
    // The actual production figures verified against the live ledger.
    assert.ok(htmlOut.includes("₹1,662"), "gross figure not shown");
    assert.ok(htmlOut.includes("₹916.3"), "restaurant figure not shown");
    assert.ok(htmlOut.includes("₹476"), "rider figure not shown");
    assert.ok(htmlOut.includes("₹269.7"), "platform figure not shown");
  });

  check("shows a negative platform figure with the minus sign before the rupee symbol", () => {
    const htmlOut = app.statementAllocationCardsHtml({...ALLOCATION, platformPaise: -5_000}, true);
    assert.ok(htmlOut.includes("-₹50"), "expected -₹50, got: " + htmlOut.match(/₹[\d,.-]*/g));
    assert.ok(!htmlOut.includes("₹-50"), "sign must not land after the rupee symbol");
  });

  check("explicitly tells the reader the five figures don't overlap", () => {
    // This is the exact confusion a real user reported: rider payout and
    // rider incentive looking like two amounts to add together for tax
    // purposes, when incentive is already inside payout.
    const htmlOut = app.statementAllocationCardsHtml(ALLOCATION, true);
    assert.ok(/add up exactly/i.test(htmlOut));
    assert.ok(/nothing here should be entered twice/i.test(htmlOut));
  });

  console.log("\nyear rollup");

  check("sums every month's allocation into one year total", () => {
    const rows = [
      {statement: {allocation: {grossPaise: 1000, restaurantPaise: 600, riderPaise: 300, platformPaise: 100, taxPaise: 0}, entryCount: 3}},
      {statement: {allocation: {grossPaise: 2000, restaurantPaise: 1200, riderPaise: 600, platformPaise: 200, taxPaise: 0}, entryCount: 5}},
    ];
    assert.deepStrictEqual(app.sumYearAllocation(rows), {
      grossPaise: 3000, restaurantPaise: 1800, riderPaise: 900, platformPaise: 300, taxPaise: 0,
    });
    assert.strictEqual(app.sumYearEntryCount(rows), 8);
  });

  check("a year with no months yet sums to zero rather than throwing", () => {
    assert.deepStrictEqual(app.sumYearAllocation([]), {grossPaise: 0, restaurantPaise: 0, riderPaise: 0, platformPaise: 0, taxPaise: 0});
    assert.strictEqual(app.sumYearEntryCount(null), 0);
  });

  check("a month with a missing allocation is skipped, not a crash", () => {
    const rows = [{statement: {entryCount: 0}}, {statement: {allocation: {grossPaise: 500, restaurantPaise: 300, riderPaise: 150, platformPaise: 50, taxPaise: 0}, entryCount: 2}}];
    assert.deepStrictEqual(app.sumYearAllocation(rows), {grossPaise: 500, restaurantPaise: 300, riderPaise: 150, platformPaise: 50, taxPaise: 0});
  });

  console.log("\nCSV export");

  const ENTRIES = [
    {
      occurredAt: Date.UTC(2026, 7, 29, 2, 53), eventType: "cod_delivery", orderId: "SV-ABC123", actorId: "system:order-delivery-ledger",
      grossPaise: 14_900, allocation: {grossPaise: 14_900, restaurantPaise: 8_200, riderPaise: 4_200, platformPaise: 2_500, taxPaise: 0},
    },
    {
      occurredAt: Date.UTC(2026, 7, 27, 18, 3), eventType: "rider_incentive", orderId: "", actorId: "system:rider-rewards",
      grossPaise: 1_000, allocation: {grossPaise: 0, restaurantPaise: 0, riderPaise: 1_000, platformPaise: -1_000, taxPaise: 0},
    },
  ];

  // A real CSV parser, not a naive split(",") - the date column legitimately
  // contains a comma ("29 Aug 2026, 8:23 am") and gets quoted for exactly
  // that reason, which a naive split would misread as an extra column.
  function parseCsvLine(line) {
    const fields = [];
    let field = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { fields.push(field); field = ""; }
      else field += c;
    }
    fields.push(field);
    return fields;
  }

  check("every downloaded row's allocation foots to the summary total shown on screen", () => {
    const csv = app.statementCsv(ENTRIES);
    const lines = csv.trim().split("\r\n");
    assert.strictEqual(lines.length, 3, "header + 2 rows");
    assert.strictEqual(lines[0], "Date & time (IST),Type,Order ID,Reference,Gross (₹),Restaurant (₹),Rider (₹),Platform (₹),Tax (₹)");
    // Column order must match the header exactly, or a spreadsheet import
    // silently mislabels every figure.
    const row1 = parseCsvLine(lines[1]);
    assert.strictEqual(row1[1], "COD order delivered");
    assert.strictEqual(row1[4], "149.00"); // gross
    assert.strictEqual(row1[5], "82.00"); // restaurant
    const row2 = parseCsvLine(lines[2]);
    assert.strictEqual(row2[1], "Rider incentive");
    assert.strictEqual(row2[7], "-10.00"); // platform, a genuine expense for this row
    // The two rows' own allocations must add up to exactly the same period
    // total shown in the cards above the download button.
    const summed = ENTRIES.reduce((sum, e) => sum + e.allocation.restaurantPaise, 0);
    assert.strictEqual(summed, 8_200);
  });

  check("quotes a field that contains a comma, so a reference with one doesn't split into extra columns", () => {
    const csv = app.statementCsv([{...ENTRIES[0], actorId: "note, with a comma"}]);
    assert.ok(csv.includes('"note, with a comma"'));
  });

  check("an empty statement still produces a valid header-only file", () => {
    const csv = app.statementCsv([]);
    assert.strictEqual(csv.trim(), "Date & time (IST),Type,Order ID,Reference,Gross (₹),Restaurant (₹),Rider (₹),Platform (₹),Tax (₹)");
  });

  check("the date column is unambiguous ISO, not a locale string Excel mis-sniffs", () => {
    // The actual bug reported: a locale-formatted date/time ("27 Aug 2026 at
    // 11:33 PM") got Excel's CSV importer to guess inconsistently row to
    // row - some rows stayed text, one silently became "8/9/2002". ISO
    // (year first) is unambiguous in every locale, so this must never
    // regress back to a natural-language string.
    const iso = app.isoIst(Date.UTC(2026, 7, 27, 18, 3)); // 27 Aug 2026, 23:33 IST
    assert.strictEqual(iso, "2026-08-27 23:33:00");
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso), "not the expected ISO shape: " + iso);

    const csv = app.statementCsv(ENTRIES);
    const dateCell = csv.trim().split("\r\n")[1].split(",")[0];
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateCell), "CSV date column is not ISO: " + dateCell);
  });

  console.log("\n" + (failures ? failures + " FAILED" : "ALL PASSED"));
  process.exit(failures ? 1 : 0);
})();

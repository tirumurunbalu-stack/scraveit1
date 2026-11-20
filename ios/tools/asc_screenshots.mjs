// Uploads ios/appstore/screenshots/*.png as the 6.9"/6.7" iPhone screenshots (replaces the set).
import { asc } from "./asc.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
const VLOC = "54e19e19-bdcd-4b42-a5a8-f47f6e6074a4", TYPE = process.argv[2] || "APP_IPHONE_67";
const dir = new URL("../appstore/screenshots/", import.meta.url).pathname;
const files = readdirSync(dir).filter(f => f.endsWith(".png")).sort();
const sets = await asc("GET", `/v1/appStoreVersionLocalizations/${VLOC}/appScreenshotSets`);
let set = sets.data.find(s => s.attributes.screenshotDisplayType === TYPE);
if (set) { const old = await asc("GET", `/v1/appScreenshotSets/${set.id}/appScreenshots`); for (const s of old.data) await asc("DELETE", `/v1/appScreenshots/${s.id}`); }
else set = (await asc("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: TYPE }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: VLOC } } } } })).data;
for (const f of files) {
  const buf = readFileSync(dir + f);
  const shot = (await asc("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: f, fileSize: buf.length }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } } })).data;
  for (const op of shot.attributes.uploadOperations) {
    const headers = Object.fromEntries((op.requestHeaders || []).map(h => [h.name, h.value]));
    const r = await fetch(op.url, { method: op.method, headers, body: buf.subarray(op.offset, op.offset + op.length) });
    if (!r.ok) throw new Error(`upload part ${f} → ${r.status}`);
  }
  await asc("PATCH", `/v1/appScreenshots/${shot.id}`, { data: { type: "appScreenshots", id: shot.id, attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(buf).digest("hex") } } });
  console.log("✓", f);
}
await new Promise(r => setTimeout(r, 8000));
const now = await asc("GET", `/v1/appScreenshotSets/${set.id}/appScreenshots`);
console.log(now.data.map(s => `${s.attributes.fileName}: ${s.attributes.assetDeliveryState?.state}`).join("\n"));

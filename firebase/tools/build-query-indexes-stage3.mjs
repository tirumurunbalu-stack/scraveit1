#!/usr/bin/env node

import {readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const firebaseDirectory = resolve(toolDirectory, "..");

export const stage2Path = join(firebaseDirectory, "feastly-realtime-database-rules.admin-claims-stage2.json");
export const stage3Path = join(firebaseDirectory, "feastly-realtime-database-rules.query-indexes-stage3.json");

// This list is intentionally small. Each entry corresponds to a reviewed,
// bounded production query in Functions. Add an index here only after locating
// its exact query and confirming the path/field against the current schema.
export const REVIEWED_QUERY_INDEXES = Object.freeze([
  Object.freeze({path: Object.freeze(["rules", "feastly", "promotions"]), fields: Object.freeze(["code"])}),
  // citySort backs the customer app's catalogue: one range query per city that
  // serves the listing, each further page, and name search. Without the index
  // that query degrades to reading every restaurant in the country to sort
  // them, which is the exact failure this staging file exists to prevent.
  // geoSort backs the same catalogue's proximity ordering: one range query per
  // geohash cell around the customer, so a city larger than the delivery
  // radius still loads nearest-first instead of alphabetically. geoSortGlobal
  // is the same position with no city prefix, queried only when geoSort comes
  // back thin - a restaurant owner's and a GPS geocoder's spelling of the same
  // real place ("Naidupet" vs "Naidupeta") do not always match character for
  // character, and geoSort alone would hide a restaurant from a customer
  // standing right next to it over nothing but that mismatch.
  Object.freeze({
    path: Object.freeze(["rules", "feastly", "catalog", "restaurants"]),
    fields: Object.freeze(["citySort", "geoSort", "geoSortGlobal"]),
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nodeAt(root, path) {
  return path.reduce((node, segment) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || !(segment in node)) {
      throw new Error(`Rules path does not exist: ${path.join("/")}`);
    }
    return node[segment];
  }, root);
}

export function normalizeIndexOn(value) {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
  throw new Error("Unexpected .indexOn shape in staged rules.");
}

export function addReviewedQueryIndexes(source) {
  const result = clone(source);
  for (const entry of REVIEWED_QUERY_INDEXES) {
    const node = nodeAt(result, entry.path);
    const merged = [...new Set([...normalizeIndexOn(node[".indexOn"]), ...entry.fields])].sort();
    node[".indexOn"] = merged;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage2 = JSON.parse(readFileSync(stage2Path, "utf8"));
  const stage3 = addReviewedQueryIndexes(stage2);
  writeFileSync(stage3Path, `${JSON.stringify(stage3, null, 2)}\n`, {encoding: "utf8", mode: 0o644});
  console.log(`Generated query-indexes stage 3 with ${REVIEWED_QUERY_INDEXES.length} reviewed index declaration.`);
}

#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_PROJECT = "savrivo-app";
const RESTAURANT_ID = "the-waffle-spot-naidupeta";
const apply = process.argv.includes("--apply");
const projectArg = process.argv.findIndex(value => value === "--project");
const project = projectArg >= 0 ? process.argv[projectArg + 1] : process.env.SAVRIVO_FIREBASE_PROJECT;
const backupDir = fileURLToPath(new URL("../backups/", import.meta.url));

if (project !== EXPECTED_PROJECT) {
  console.error(`Refusing to continue. Pass --project ${EXPECTED_PROJECT}.`);
  process.exit(2);
}

function firebase(args) {
  const result = spawnSync("firebase", [...args, "--project", project], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(detail || `firebase ${args[0]} failed`);
  }
  return result;
}

function menuItem(id, name, price, now) {
  return {
    id,
    name,
    price,
    category: "Creamora Ice Creams",
    description: "Vegetarian ice cream from the outlet's published Creamora selection.",
    diet: "veg",
    available: false,
    popular: false,
    archived: false,
    updatedAt: now
  };
}

function buildMenu(now) {
  return [
    ["bean-vanilla", "Bean Vanilla", 77],
    ["butter-scotch", "Butter Scotch", 105],
    ["vanilla-caramel-brownie", "Vanilla Caramel Brownie", 119],
    ["red-velvet-icecream", "Red Velvet Ice Cream", 119],
    ["caramel-nut", "Caramel Nut", 119],
    ["black-currant-icecream", "Black Currant Ice Cream", 119],
    ["honeymoon-delight", "Honeymoon Delight Ice Cream", 119],
    ["mango-natural", "Mango Natural Ice Cream", 119],
    ["strawberry-icecream", "Strawberry Ice Cream", 77],
    ["nutella-blend", "Nutella Blend Ice Cream", 119],
    ["sitaphal-natural", "Sitaphal Natural Ice Cream", 119],
    ["tender-coconut", "Tender Coconut Ice Cream", 119],
    ["chikoo-natural", "Chikoo Natural Ice Cream", 119],
    ["jackfruit-natural", "Jackfruit Natural Ice Cream", 119]
  ].map(row => menuItem(row[0], row[1], row[2], now));
}

const work = mkdtempSync(join(tmpdir(), "savrivo-catalog-"));
try {
  const catalogFile = join(work, "catalog-before.json");
  firebase(["database:get", "/feastly/catalog/restaurants", "--output", catalogFile]);
  const current = JSON.parse(readFileSync(catalogFile, "utf8") || "null") || {};
  const now = Date.now();
  mkdirSync(backupDir, { recursive: true });
  const backupFile = join(backupDir, `catalog-restaurants-before-${now}.json`);
  writeFileSync(backupFile, `${JSON.stringify(current, null, 2)}\n`);
  const menu = buildMenu(now);
  const restaurant = {
    id: RESTAURANT_ID,
    name: "The Waffle Spot",
    phone: "+91 98856 96944",
    cuisines: ["Waffle", "Pancake", "Desserts"],
    city: "Naidupeta",
    category: "Desserts",
    description: "Delivery-only dessert kitchen serving waffles, pancakes and ice creams.",
    address: "Pichi Reddy Thopu, Near Current Office, Naidupeta, Andhra Pradesh 524126",
    lat: 13.9018832,
    lng: 79.8877264,
    etaMin: 25,
    etaMax: 40,
    deliveryFee: 29,
    platformFee: 15,
    opensUntil: "",
    open: false,
    archived: false,
    rating: 0,
    menu,
    updatedAt: now,
    updatedBy: "catalog-migration"
  };

  const patch = {};
  for (const id of Object.keys(current)) {
    if (id === RESTAURANT_ID) continue;
    patch[`catalog/restaurants/${id}/open`] = false;
    patch[`catalog/restaurants/${id}/archived`] = true;
    patch[`catalog/restaurants/${id}/updatedAt`] = now;
    patch[`catalog/restaurants/${id}/updatedBy`] = "catalog-migration";
  }
  patch[`catalog/restaurants/${RESTAURANT_ID}`] = restaurant;
  patch[`menus/${RESTAURANT_ID}`] = Object.fromEntries(menu.map(item => [item.id, {
    ...item,
    updatedBy: "catalog-migration"
  }]));
  patch["catalog/meta"] = { initialized: true, updatedAt: now };

  const patchFile = join(work, "catalog-update.json");
  writeFileSync(patchFile, `${JSON.stringify(patch, null, 2)}\n`);
  const previewFile = join(backupDir, `catalog-waffle-spot-patch-${now}.json`);
  writeFileSync(previewFile, `${JSON.stringify(patch, null, 2)}\n`);
  console.log(`Project: ${project}`);
  console.log(`Backup: ${backupFile}`);
  console.log(`Patch preview: ${previewFile}`);
  console.log(`Restaurants preserved and archived: ${Object.keys(current).filter(id => id !== RESTAURANT_ID).join(", ") || "none"}`);
  console.log(`Replacement staged: ${RESTAURANT_ID} (closed until owner confirmation)`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply after reviewing the Firebase backup and owner details.");
  } else {
    firebase(["database:update", "/feastly", patchFile, "--force"]);
    console.log("Catalog migration applied without deleting historical restaurant or menu data.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const restaurant = fs.readFileSync(
  path.join(root, "restaurant", "src", "main", "assets", "premium.js"), "utf8");
const admin = fs.readFileSync(
  path.join(root, "admin", "src", "main", "assets", "premium.js"), "utf8");

assert(
  restaurant.includes('if(o.status==="Assigned"&&o.riderId&&o.riderArrivalVerified===true&&permission("handover"))return"Handed to rider"'),
  "Restaurant handover control must require canonical Assigned status, a rider and verified arrival");
assert(
  restaurant.includes('o.status==="Assigned"&&status==="Handed to rider"&&o.riderId&&o.riderArrivalVerified===true&&permission("handover")'),
  "Restaurant handover action must revalidate canonical Assigned status and verified arrival");
assert(
  !restaurant.includes('["Ready for pickup","Assigned"].includes(o.status)&&status==="Handed to rider"'),
  "Restaurant must never permit handover directly from Ready for pickup");

assert(
  admin.includes('if(o.status==="Assigned"&&o.riderId&&o.riderArrivalVerified===true)return"Handed to rider"')
    && !admin.includes('"Ready for pickup":o.riderId?"Handed to rider"'),
  "Admin handover control must require canonical Assigned status and verified arrival");
assert(
  admin.includes('if(status==="Handed to rider"&&(!o.riderId||o.riderArrivalVerified!==true))'),
  "Admin handover action must retain assigned-rider and verified-arrival guards");

process.stdout.write("✓ Restaurant and Admin handover controls require canonical Assigned status\n");

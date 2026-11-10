#!/usr/bin/env node
// Gives the Google Play review rider a new random password and copies it to the
// clipboard (macOS pbcopy). The password is never printed.
//
//   node scripts/new-review-rider-password.mjs

import {randomInt} from "node:crypto";
import {spawnSync} from "node:child_process";
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";

const EMAIL = "playreview.rider@scraveit.in";
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const password = "Review-" + Array.from({length: 12}, () => CHARS[randomInt(CHARS.length)]).join("");

const app = initializeApp({credential: applicationDefault(), projectId: "savrivo-app"});
try {
  const auth = getAuth(app);
  const user = await auth.getUserByEmail(EMAIL);
  await auth.updateUser(user.uid, {password});
  const copied = spawnSync("pbcopy", {input: password}).status === 0;
  console.log(copied
    ? `New password for ${EMAIL} is in your clipboard. Paste it into Play's Sign-in details now.`
    : "Password changed, but copying to the clipboard failed. Run this again.");
} finally {
  await deleteApp(app);
}

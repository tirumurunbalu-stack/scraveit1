#!/usr/bin/env node
// Turns an existing rider sign-in into the Google Play review account: approved,
// and marked playReviewAccount so the rider app skips the login face scan.
// Create the sign-in first (sign up in the rider app with email and password).
// Prints no secrets.
//
//   node scripts/make-play-review-rider.mjs <email>            dry run
//   node scripts/make-play-review-rider.mjs <email> --apply    write it

import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore} from "firebase-admin/firestore";

const PROJECT = "savrivo-app";
const [email, flag] = process.argv.slice(2);
if (!email || !/^\S+@\S+\.\S+$/.test(email) || (flag && flag !== "--apply")) {
  console.error("Usage: node scripts/make-play-review-rider.mjs <email> [--apply]");
  process.exit(1);
}

const app = initializeApp({credential: applicationDefault(), projectId: PROJECT});
try {
  const user = await getAuth(app).getUserByEmail(email.toLowerCase());
  const ref = getFirestore(app).doc(`riders/${user.uid}`);
  const now = Date.now();
  const existing = (await ref.get()).data() ?? {};
  const update = {
    email: user.email,
    fullName: existing.fullName || "Google Play Review",
    phone: existing.phone || "",
    city: existing.city || "Nellore",
    vehicleType: existing.vehicleType || "Scooter",
    status: "approved",
    faceMatchStatus: "unique",
    playReviewAccount: true,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  console.log(`Rider ${user.uid} (${user.email}) will be approved and marked as the Play review account.`);
  if (flag !== "--apply") {
    console.log("Dry run. Add --apply to write it.");
  } else {
    await ref.set(update, {merge: true});
    console.log("Done.");
  }
} finally {
  await deleteApp(app);
}

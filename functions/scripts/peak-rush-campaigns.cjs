// Lunch and dinner rush extra (founder 2026-11-14): the customer pays ₹10 a
// "Surge fee" and the delivery partner gets all ₹10, per order delivered in
// 12–3 PM or 7–11 PM. Same format as the live early-morning campaign.
// Run once: node scripts/peak-rush-campaigns.cjs   (add --off to switch both off)
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
initializeApp({projectId: "savrivo-app"});
const db = getFirestore();
const off = process.argv.includes("--off");
const now = Date.now();

const base = {
  active: true, allowOverlappingSlotCredit: false, archived: false, displayType: "surge",
  eligibleDays: [0, 1, 2, 3, 4, 5, 6], endAt: 1851359400000, kind: "per_order_bonus",
  milestonePayoutMode: "highest_unlocked", orderTotalMinPaise: 0, priority: 230, rainOnly: false,
  requireDailyLoginSession: false, schemaVersion: 1, stacking: "stack", startAt: now,
  timezone: "Asia/Kolkata", tripAttribution: "delivered_at", updatedByRole: "owner", visible: true,
  window: "daily", updatedBy: "claude-code-peak-rush", rewardAmountPaise: 1000, customerFeePaise: 1000,
  subtitle: "₹10 extra per order for the delivery partner", updatedAt: now,
};
const campaigns = {
  "live-20261114-lunch-rush": {
    ...base, internalName: "live-lunch-rush", section: "lunch", title: "Lunch rush extra · 11:30 AM – 3 PM",
    description: "Customer pays ₹10; the delivery partner gets all ₹10 per order delivered 11:30 AM – 3 PM.",
    timeSlots: [{label: "11:30 AM – 3 PM", startMinute: 690, endMinute: 900}],
  },
  "live-20261114-dinner-rush": {
    ...base, internalName: "live-dinner-rush", section: "dinner", title: "Dinner rush extra · 7 – 11 PM",
    description: "Customer pays ₹10; the delivery partner gets all ₹10 per order delivered 7 – 11 PM.",
    timeSlots: [{label: "7 PM – 11 PM", startMinute: 1140, endMinute: 1380}],
  },
};

(async () => {
  for (const [id, doc] of Object.entries(campaigns)) {
    const ref = db.doc(`private/riderRewards/campaigns/${id}`);
    if (off) await ref.set({active: false, updatedAt: now}, {merge: true});
    else await ref.set(doc);
    console.log(off ? "OFF" : "ON ", id);
  }
  process.exit(0);
})();

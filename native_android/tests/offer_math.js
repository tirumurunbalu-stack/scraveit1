// Shared offer/payout maths (shared/web/scraveit-offer-math.js) must match
// the server's rules in functions/src/domain/economics.ts.
const assert = require("node:assert/strict");
const M = require("../shared/web/scraveit-offer-math.js");

const pct = {kind: "percent", percent: 20, maxDiscountPaise: 5000};
// The offer only reduces the item total, capped; commission is on what's left.
assert.equal(M.discountPaise(pct, 30000), 5000);
assert.deepEqual(M.payout(30000, 5000, 1500), {base: 25000, commission: 3750, commissionGst: 675, receive: 20575});
// "I want Rs 100" at 15%: Rs 122 is the smallest whole-rupee price that pays at least Rs 100.
assert.equal(M.priceForReceive(10000, 1500), 12200);
assert.equal(M.payout(12200, 0, 1500).receive, 10041);
assert.ok(M.payout(12100, 0, 1500).receive < 10000);
// A single Rs 149 waffle with 20% off.
assert.equal(M.dishPayout(14900, pct, 1500).receive, 9810);
// Minimum order: nothing below it.
const above = {kind: "flat", flatAmountPaise: 7500, minimumOrderPaise: 39900};
assert.equal(M.discountPaise(above, 30000), 0);
assert.equal(M.discountPaise(above, 39900), 7500);
// Labels customers see and suggested codes.
assert.equal(M.offerLabel(pct), "20% OFF up to ₹50");
assert.equal(M.offerLabel(above), "₹75 OFF above ₹399");
assert.equal(M.suggestCode("The Waffle Spot", pct), "WAFFLE20");
assert.ok(M.validCode("WAFFLE20") && !M.validCode("ab") && !M.validCode("WAFFLE-20"));
assert.deepEqual(M.codeAlternatives("WAFFLE20", 2), ["WAFFLE21", "WAFFLE22"]);
// Ranking: % saved on a Rs 300 order, plus a bonus for no minimum.
assert.equal(M.offerScore([pct]).savingPercent, 16.7);
assert.ok(M.offerScore([pct]).score > M.offerScore([{kind: "flat", flatAmountPaise: 4000}]).score);
assert.equal(M.offerScore([above]).score, 0);
assert.equal(M.rupees(12345600), "₹1,23,456");
console.log("✓ offer maths");

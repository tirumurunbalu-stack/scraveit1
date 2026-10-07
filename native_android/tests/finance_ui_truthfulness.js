const fs = require("fs");
const path = require("path");

const nativeRoot = path.resolve(__dirname, "..");
const restaurant = fs.readFileSync(
  path.join(nativeRoot, "restaurant/src/main/assets/premium.js"),
  "utf8"
);
const rider = fs.readFileSync(
  path.join(nativeRoot, "rider/src/main/assets/premium.js"),
  "utf8"
);

let assertions = 0;
function check(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

check(restaurant.includes("function restaurantOrderValue"), "Restaurant must expose neutral order-value projections.");
check(restaurant.includes('o.status==="Delivered"&&localDateKey(restaurantCompletionTime(o))===reportDate()'), "Restaurant completed report must include delivered orders only.");
check(restaurant.includes('!["Delivered","Cancelled"].includes(o.status)'), "Restaurant active value must exclude delivered and cancelled orders.");
check(/active order value/i.test(restaurant), "Restaurant must label active order value separately.");
check(restaurant.includes(" in progress · '+(commissionKnown()?'after commission':'not receivable')"), "Restaurant active value must not be described as receivable.");
check(restaurant.includes("COMPLETED ORDER VALUE ESTIMATE"), "Restaurant completed projection must be marked as an estimate.");
check(restaurant.includes("Commission, adjustments, refunds, COD, payout and settlement are not represented here"), "Restaurant report must disclose excluded ledger concepts.");
check(/data-route="earningsReport">(View )?[Cc]ompleted order value/.test(restaurant), "Restaurant completed estimate must have an explicit, correctly labelled entry point.");
check(!/data-route="earningsReport">[^<]*[Ee]arnings/.test(restaurant), "Restaurant completed-value estimate must not be presented as earnings.");

for (const forbidden of [
  "function restaurantMoney",
  "Scraveit commission (15%)",
  "RESTAURANT RECEIVABLE",
  "Amount payable",
  "orders after 15%",
]) {
  check(!restaurant.includes(forbidden), `Restaurant must not retain misleading finance copy: ${forbidden}`);
}

check(rider.includes("function validateRiderRewardsDashboard"), "Rider must validate the authoritative rewards dashboard contract.");
check(rider.includes("Authoritative rider earnings"), "Rider earnings screen must clearly describe authoritative backend-backed data.");
check(rider.includes("Reconciliation required"), "Rider payouts must fail closed when ledger history cannot prove a safe amount.");
check(/All offer amounts[^<]*come from the secure Scraveit backend/.test(rider), "Rider offers must disclose backend authority over incentive values.");
check(rider.includes("No payout entries yet"), "Rider payouts screen must handle empty authoritative history safely.");
check(rider.includes("Estimate from the order. Final pay uses your real pickup distance"), "Rider offers must identify payout as estimated.");

for (const forbidden of [
  "function deliveryEarning",
  "function deliveryTip",
  "function partnerEarning",
  "100% credited to you",
  "SELECTED DATE EARNINGS",
  "records earnings but does not perform bank settlement",
  "COMPLETED DELIVERY VALUE ESTIMATE",
  "Not a ledger credit",
  "COD collected, outstanding or remitted",
  "No completed payout",
]) {
  check(!rider.includes(forbidden), `Rider must not retain misleading finance copy: ${forbidden}`);
}

console.log(`Finance UI truthfulness checks passed (${assertions} assertions).`);

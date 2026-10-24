// DPDP Act, 2023: every sign-up shows the itemised notice with an unticked consent box,
// and every signed-in account is stopped at the notice until it agrees to this version.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const shared = read("shared/web/scraveit-privacy.js");
assert.strictEqual(read("../website/public/shop/scraveit-privacy.js"), shared, "website copy of scraveit-privacy.js must match shared/web");

global.window = {};
global.document = {addEventListener() {}, getElementById() { return null; }, head: {appendChild() {}}, createElement() { return {}; }};
require(path.join(root, "shared/web/scraveit-privacy.js"));
const P = window.ScraveitPrivacy;
for (const audience of ["customer", "store", "rider"]) {
  for (const lang of ["en", "te"]) {
    const html = P.noticeHtml(audience, lang);
    for (const must of [P.LINKS.policy, P.LINKS.terms, "balaji@scraveit.in", P.VERSION]) assert.ok(html.includes(must), `${audience}/${lang} notice lacks ${must}`);
    const label = P.consentLabel(audience, lang, "x");
    assert.ok(/<input type="checkbox" id="x"/.test(label) && !/checked/.test(label), "consent box must start unticked");
    assert.ok(P.gateHtml(audience, lang).includes('data-sp-action="agree" disabled'), "agree button starts disabled");
  }
}
const record = P.consentRecord("u1", "rider", "te", "gate", "partner");
assert.deepStrictEqual(Object.keys(record).sort(), ["acceptedAt", "app", "audience", "lang", "method", "uid", "version"]);
assert.ok(P.isCurrent(record) && !P.isCurrent({version: "old"}));

const apps = {
  "app/src/main/assets": ["customer", "signup-consent"],
  "rider/src/main/assets": ["rider", "rider-signup-consent"],
  "restaurant/src/main/assets": ["store", "store-signup-consent"],
};
for (const [dir, [audience, boxId]] of Object.entries(apps)) {
  const html = read(dir + "/premium.html"), js = read(dir + "/premium.js");
  assert.ok(html.indexOf("scraveit-privacy.js") > 0 && html.indexOf("scraveit-privacy.js") < html.indexOf('src="premium.js"'), dir + " loads the notice before premium.js");
  assert.ok(js.includes(`ScraveitPrivacy.consentLabel("${audience}"`) && js.includes(boxId), dir + " sign-up shows the notice and box");
  assert.ok(js.includes(`ScraveitPrivacy.gateHtml("${audience}"`), dir + " stops signed-in accounts at the notice");
  assert.ok(js.includes('collection("privacyConsents")'), dir + " records consent");
}
const rules = read("../firebase/firestore.rules");
assert.ok(rules.includes("match /privacyConsents/{consentId}"), "rules allow consent records");
console.log("✓ DPDP notice and consent in every app and the website");

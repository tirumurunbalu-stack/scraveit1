/*
 * Public web configuration for www.scraveit.in. These are Firebase *web*
 * identifiers, which are public by design; access is enforced by Firestore
 * rules, Firebase Auth and App Check on the server, not by hiding them.
 *
 * recaptchaEnterpriseSiteKey: App Check key for this site. Until it is set
 * (Firebase console -> App Check -> Apps -> "Savrivo Core" web app ->
 * reCAPTCHA Enterprise), browsing works but the server refuses orders from
 * the website, and the checkout says so.
 */
window.SCRAVEIT_WEB = {
  firebase: {
    apiKey: "AIzaSyBV3xmCm7HiWJLygloPDNBg6qq6gkO-F6I",
    authDomain: "savrivo-app.firebaseapp.com",
    projectId: "savrivo-app",
    storageBucket: "savrivo-app.firebasestorage.app",
    messagingSenderId: "458592242638",
    appId: "1:458592242638:web:f363ea81149d64dc44b99f",
  },
  functionsRegion: "asia-south1",
  // Nothing can be ordered until SCRAVEIT's FSSAI licence is issued: every
  // listing is a sample. Set to true (and add the App Check key) at launch.
  ordersOpen: false,
  // Before launch the website shows only these onboarded restaurants, with a
  // short sample menu each (curatedMenus), plus one sample grocery and dairy store.
  visibleStoreIds: ["highway-cross-hh1d", "the-waffle-spot-naidupeta"],
  curatedMenus: true,
  // Grocery and dairy: items are sold at or below MRP; these Scraveit service
  // fees are billed separately and shown before payment (₹, incl. 18% GST).
  goodsFees: {platformFee: 14.99, maintenanceFee: 5},
  // Test stores used for Play review and internal testing; never shown on the website.
  hiddenStoreIds: [
    "scraveit-review-restaurant-EV4JHY", "scraveit-review-grocery-myd9gx", "scraveit-review-dairy-6M5O8g",
    "test-dairy-RiRE8m", "tirumuru-balaji-restaurant-r36PY4", "tirumuru-balaji-store-r36PY4", "shaik-sabdhar-restaurant-EOsmg8",
  ],
  recaptchaEnterpriseSiteKey: "",
  company: {
    legalName: "SCRAVEIT PRIVATE LIMITED",
    cin: "U62099AP2026PTC128252",
    gstin: "37ABVCS0396N1ZA",
    address: "20-4-656, Macleans Road, Revenue Ward No 20-I, Vedayapalem, Nellore, Andhra Pradesh 524004, India",
    email: "balaji@scraveit.in",
    fssaiStatus: "FSSAI licence application submitted (Reference No. 10260921109099066). The licence number will be displayed here once issued.",
  },
};

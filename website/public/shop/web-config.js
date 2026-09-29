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
  recaptchaEnterpriseSiteKey: "",
  company: {
    legalName: "SCRAVEIT PRIVATE LIMITED",
    cin: "U62099AP2026PTC128252",
    address: "20-4-656, Macleans Road, Revenue Ward No 20-I, Vedayapalem, Nellore, Andhra Pradesh 524004, India",
    email: "balaji@scraveit.in",
    fssaiStatus: "FSSAI licence application submitted (Reference No. 10260921109099066). The licence number will be displayed here once issued.",
  },
};

// Shared Firebase wiring for every section of the Savrivo web admin panel.
// Same Firebase project, same owner/ops-admin sign-in, and the same callable
// Cloud Functions the Admin Android app already uses - this is a second front
// door onto the exact same backend, not a separate system.
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeAppCheck, ReCaptchaV3Provider,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail,
  multiFactor, TotpMultiFactorGenerator, getMultiFactorResolver,
  reauthenticateWithCredential, EmailAuthProvider, reauthenticateWithPopup,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import {
  getDatabase, ref, get,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBV3xmCm7HiWJLygloPDNBg6qq6gkO-F6I",
  authDomain: "savrivo-app.firebaseapp.com",
  databaseURL: "https://savrivo-app-default-rtdb.firebaseio.com",
  projectId: "savrivo-app",
  storageBucket: "savrivo-app.firebasestorage.app",
  messagingSenderId: "458592242638",
  appId: "1:458592242638:web:f363ea81149d64dc44b99f",
};
const FUNCTIONS_REGION = "asia-south1";

// This internal panel is signed-in-owner-only (every callable also requires a
// verified owner/ops_admin custom claim server-side), so an App Check DEBUG
// token - registered once via `firebase appcheck:debugtokens:create` - is
// used instead of standing up reCAPTCHA for a page with no public traffic.
// It only proves "this is a known app instance"; it grants no access on its
// own without a real privileged sign-in. Rotate/delete it any time with
// `firebase appcheck:debugtokens:delete` if you want to retire this panel.
self.FIREBASE_APPCHECK_DEBUG_TOKEN = "e7d1b2c3-36ff-41d0-a2bc-35907897939a";

const app = initializeApp(FIREBASE_CONFIG);
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("debug-token-mode"),
  isTokenAutoRefreshEnabled: true,
});
const auth = getAuth(app);
const functions = getFunctions(app, FUNCTIONS_REGION);
const database = getDatabase(app);

let currentUser = null;
let currentClaims = null;
const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    currentClaims = null;
    if (user) {
      try {
        const result = await user.getIdTokenResult();
        currentClaims = result.claims || {};
      } catch (_) {
        currentClaims = {};
      }
    }
    resolve();
  });
});

export function isPlatformAdmin(claims) {
  return !!claims && (claims.savrivoRole === "owner" || claims.savrivoRole === "ops_admin");
}

/** Resolves once the initial auth state is known. Call before reading session(). */
export async function ready() {
  await authReady;
}

export function session() {
  return {user: currentUser, claims: currentClaims, isAdmin: isPlatformAdmin(currentClaims)};
}

// If the account has an enrolled second factor (Google Authenticator via
// TOTP), Firebase rejects the first-factor sign-in with
// auth/multi-factor-auth-required instead of completing it. That's not a
// failure - it means "first factor accepted, now prove the second one" - so
// it's re-thrown as a distinct, recognizable error carrying the resolver the
// caller needs to finish the challenge with completeMfaSignIn(). Any other
// error is re-thrown as-is.
function rethrowMfaAware(error) {
  if (error && error.code === "auth/multi-factor-auth-required") {
    const wrapped = new Error("Enter the code from your authenticator app.");
    wrapped.code = "auth/multi-factor-auth-required";
    wrapped.resolver = getMultiFactorResolver(auth, error);
    throw wrapped;
  }
  throw error;
}

export async function signIn(email, password) {
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    rethrowMfaAware(error);
  }
  const result = await auth.currentUser.getIdTokenResult(true);
  currentUser = auth.currentUser;
  currentClaims = result.claims || {};
  return session();
}

export async function signInWithGoogle() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    rethrowMfaAware(error);
  }
  const result = await auth.currentUser.getIdTokenResult(true);
  currentUser = auth.currentUser;
  currentClaims = result.claims || {};
  return session();
}

/** Finishes a sign-in that was interrupted by an auth/multi-factor-auth-required challenge. */
export async function completeMfaSignIn(resolver, code) {
  const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  if (!hint) throw new Error("No authenticator-app factor is enrolled on this account.");
  const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, String(code || "").trim());
  await resolver.resolveSignIn(assertion);
  const result = await auth.currentUser.getIdTokenResult(true);
  currentUser = auth.currentUser;
  currentClaims = result.claims || {};
  return session();
}

// ---------------------------------------------------------------------------
// Two-factor authentication (Google Authenticator / any TOTP app) enrollment.
// Enrolling or unenrolling a second factor is security-sensitive, so Firebase
// requires a *recent* sign-in for it - reauthenticateForMfa() below is the
// escape hatch when that hasn't happened recently enough in this session.
// ---------------------------------------------------------------------------
export function enrolledTotpFactors() {
  if (!currentUser) return [];
  return multiFactor(currentUser).enrolledFactors.filter((f) => f.factorId === TotpMultiFactorGenerator.FACTOR_ID);
}

export async function reauthenticateForMfa(password) {
  if (!currentUser) throw new Error("Not signed in.");
  const providerId = (currentUser.providerData[0] && currentUser.providerData[0].providerId) || "";
  if (providerId === "google.com") {
    await reauthenticateWithPopup(currentUser, new GoogleAuthProvider());
  } else {
    if (!password) throw new Error("Enter your password to confirm it's you.");
    await reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, password));
  }
}

/** Step 1 of enrollment: generates a TOTP secret and a QR-code payload for it. */
export async function startTotpEnrollment() {
  if (!currentUser) throw new Error("Not signed in.");
  const mfaSession = await multiFactor(currentUser).getSession();
  const secret = await TotpMultiFactorGenerator.generateSecret(mfaSession);
  const qrCodeUrl = secret.generateQrCodeUrl(currentUser.email || currentUser.uid, "Savrivo Admin");
  return {secret, qrCodeUrl, secretKey: secret.secretKey};
}

/** Step 2 of enrollment: verifies the 6-digit code the app is now showing and completes enrollment. */
export async function completeTotpEnrollment(secret, code, displayName) {
  const assertion = TotpMultiFactorGenerator.assertionForEnrollment(secret, String(code || "").trim());
  await multiFactor(currentUser).enroll(assertion, displayName || "Google Authenticator");
}

export async function unenrollTotpFactor(factorUid) {
  await multiFactor(currentUser).unenroll(factorUid);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

export async function signOutUser() {
  await signOut(auth);
}

/** Redirects to the landing page unless a verified platform-admin session exists. */
export async function requireAdminSession() {
  await ready();
  const state = session();
  if (!state.user || !state.isAdmin) {
    window.location.replace(rootPath());
    return null;
  }
  return state;
}

function rootPath() {
  // Every section page lives at /<section>/index.html (one directory below the
  // root sign-in page), addressed as /<section>/ - so `parts` here is always
  // ["<section>"] and the root is one level up. Handled generally (drop a
  // trailing filename, count the remaining directory segments) so an extra
  // level of nesting added later still resolves correctly instead of an
  // off-by-one sending the page back to itself, which is a redirect loop.
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length && parts[parts.length - 1].includes(".")) parts.pop();
  return parts.length ? "../".repeat(parts.length) : "./";
}

/** Thin wrapper matching the shape every callable in this project returns/throws. */
export async function callFunction(name, payload) {
  const callable = httpsCallable(functions, name);
  try {
    const result = await callable(payload || {});
    return result.data;
  } catch (error) {
    const message = (error && error.message) ? String(error.message) : "The request failed.";
    const clean = message.replace(/^Firebase:\s*/i, "").replace(/\s*\(functions\/[a-z-]+\)\.?$/i, "");
    const wrapped = new Error(clean || "The request failed.");
    wrapped.code = error && error.code;
    throw wrapped;
  }
}

// Direct, authenticated RTDB reads - the same pattern the Admin Android app
// already uses for full-node directory loads (`GET feastly/riders`,
// `GET feastly/catalog/restaurants`) rather than a bespoke Cloud Function.
// Security rules grant owner/ops_admin a full read of `riders`, and any
// signed-in user a full read of `catalog` (see
// firebase/feastly-realtime-database-rules.json) - the same rules this
// panel's Firebase Auth session already satisfies.
export async function readDatabasePath(path) {
  const snapshot = await get(ref(database, path));
  return snapshot.exists() ? snapshot.val() : null;
}

export function onSessionChange(cb) {
  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      const result = await user.getIdTokenResult();
      currentClaims = result.claims || {};
    } else {
      currentClaims = null;
    }
    currentUser = user;
    cb(session());
  });
}

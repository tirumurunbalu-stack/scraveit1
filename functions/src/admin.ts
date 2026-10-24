import {getApps, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getDatabaseWithUrl} from "firebase-admin/database";
import {getFirestore} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";
import {getStorage} from "firebase-admin/storage";

if (getApps().length === 0) initializeApp();

// Mid-migration from Realtime Database to Firestore (asia-south1, Mumbai -
// RTDB has no India region at all). `db` (RTDB) stays live and untouched
// until every one of its ~227 call sites across the services layer is
// converted; `firestoreDb` is what newly-converted files import. Once the
// conversion is complete, `db` is deleted and `firestoreDb` is renamed to
// `db`. The two paths that remain on RTDB for good (`riderPresence`,
// `tracking` - native background services write there directly, out of
// scope for the Firestore conversion) live on a dedicated non-default
// instance in asia-southeast1 (Singapore), not the project's original
// default instance in us-central1 - see config.ts's DATABASE_INSTANCE.
export const db = getDatabaseWithUrl("https://savrivo-app-sg.asia-southeast1.firebasedatabase.app");
export const firestoreDb = getFirestore();
export const auth = getAuth();
export const messaging = getMessaging();
// Photos and documents live in Mumbai (asia-south1) since 23 Oct 2026; the
// project's default bucket (US) holds the originals and anything an older app
// build still uploads there (see services/mediaBucket.ts).
export const MEDIA_BUCKET = "savrivo-app-mumbai";
export const LEGACY_MEDIA_BUCKET = "savrivo-app.firebasestorage.app";
const defaultStorage = getStorage();
export const storage = {bucket: (name?: string) => defaultStorage.bucket(name ?? MEDIA_BUCKET)};

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
export const storage = getStorage();

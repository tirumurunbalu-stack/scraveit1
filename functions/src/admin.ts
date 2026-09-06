import {getApps, initializeApp} from "firebase-admin/app";
import {getDatabase} from "firebase-admin/database";
import {getMessaging} from "firebase-admin/messaging";
import {getStorage} from "firebase-admin/storage";

if (getApps().length === 0) initializeApp();

export const db = getDatabase();
export const messaging = getMessaging();
export const storage = getStorage();

import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {notifyBirthday} from "./notifications";

/**
 * Birthday greetings for customers, no offer attached.
 *
 * accountAges/{uid}.birthMonthDay ("MM-DD", written with the date of birth)
 * lets one query find today's birthdays. Three pushes on the day, India time:
 *  - morning (9 am): the greeting, to everyone with notifications on;
 *  - afternoon (1 pm) and evening (6 pm): a food nudge, only for adults who
 *    haven't ordered today (no marketing to under-18s, DPDP Act 2023, s.9(3)).
 * 29 Feb birthdays are greeted on 28 Feb in other years. Each push has its own
 * de-duplication key, so a retried run never sends a second copy.
 */

type Rec = Record<string, unknown>;
export type BirthdaySlot = "morning" | "afternoon" | "evening";
const HOUR = 60 * 60 * 1000;

/** The India date for `now`: {year, monthDay "MM-DD", startOfDay (ms)}. */
export function istDay(now: number): {year: number; monthDay: string; startOfDay: number} {
  const ist = new Date(now + 5.5 * HOUR);
  const year = ist.getUTCFullYear(), month = ist.getUTCMonth() + 1, day = ist.getUTCDate();
  const startOfDay = Date.UTC(year, month - 1, day) - 5.5 * HOUR;
  return {year, monthDay: `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, startOfDay};
}

function leapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The birthMonthDay values greeted today. */
export function monthDaysFor(now: number): string[] {
  const {year, monthDay} = istDay(now);
  return monthDay === "02-28" && !leapYear(year) ? ["02-28", "02-29"] : [monthDay];
}

export function birthdaySlotFor(now: number): BirthdaySlot | null {
  const hour = new Date(now + 5.5 * HOUR).getUTCHours();
  if (hour === 9) return "morning";
  if (hour === 13) return "afternoon";
  if (hour === 18) return "evening";
  return null;
}

function firstName(name: unknown): string {
  const word = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  const clean = word.replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, 24);
  return clean && clean === clean.toUpperCase() ? clean.charAt(0) + clean.slice(1).toLowerCase() : clean;
}

export function birthdayCopy(slot: BirthdaySlot, name: string): {title: string; body: string} {
  const to = name ? `, ${name}` : "";
  if (slot === "morning") return {title: `🎂 Happy birthday${to}!`, body: "Wishing you a delicious year ahead. From all of us at Scraveit 💙"};
  if (slot === "afternoon") return {title: `🍰 Birthday lunch${to}?`, body: "It's your day. Treat yourself to something you love 😋"};
  return {title: `🎉 Still celebrating${to}?`, body: "Make tonight's birthday dinner one to remember 🥳"};
}

export async function runBirthdayGreetings(slot: BirthdaySlot, now = Date.now()): Promise<number> {
  const {year, startOfDay} = istDay(now);
  let sent = 0;
  for (const monthDay of monthDaysFor(now)) {
    const people = await firestoreDb.collection("accountAges").where("birthMonthDay", "==", monthDay).limit(2000).get();
    for (const doc of people.docs) {
      const age = doc.data() as Rec;
      if (slot !== "morning" && age.minor === true) continue;
      try {
        const user = await firestoreDb.collection("users").doc(doc.id).get();
        const data = (user.exists ? user.data() : {}) as Rec;
        const prefs = (data.preferences ?? {}) as Rec;
        if (prefs.notifications === false) continue;
        if (slot !== "morning") {
          // Uses the existing customerId + createdAt (newest first) index.
          const last = await firestoreDb.collection("orders").where("customerId", "==", doc.id)
            .orderBy("createdAt", "desc").limit(1).get();
          if (!last.empty && Number(last.docs[0]?.get("createdAt") ?? 0) >= startOfDay) continue;
        }
        const copy = birthdayCopy(slot, firstName(data.name));
        await notifyBirthday({uid: doc.id, key: `${doc.id}:${year}:${slot}`, ...copy});
        sent++;
      } catch (error) {
        logger.warn("BIRTHDAY_GREETING_FAILED", {uid: doc.id, slot, error: String(error)});
      }
    }
  }
  return sent;
}

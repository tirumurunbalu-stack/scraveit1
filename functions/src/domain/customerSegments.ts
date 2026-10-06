/**
 * Customer segments for analytics and targeted offers: gender, age group and
 * delivery area.
 *
 * Gender and date of birth are optional and only ever come from the
 * customer's own "About you" details, saved with consent (Digital Personal
 * Data Protection Act, 2023, ss.5-6). Nobody under 18 is placed in an age
 * group or targeted (s.9(3) bars behavioural monitoring of, and targeted
 * advertising directed at, children), and withdrawing consent deletes the
 * record, so it drops out of every segment.
 */

export const AGE_BANDS = ["18-24", "25-34", "35-44", "45-54", "55+"] as const;
export type AgeBand = typeof AGE_BANDS[number];
export const GENDERS = ["female", "male", "other"] as const;
export type Gender = typeof GENDERS[number];

export const CUSTOMER_DEMOGRAPHICS_COLLECTION = "customerDemographics";

export interface CustomerSegment {
  gender: Gender | "";
  ageBand: AgeBand | "";
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function normalizeGender(value: unknown): Gender | "" {
  const text = String(value ?? "").trim().toLowerCase();
  return (GENDERS as readonly string[]).includes(text) ? text as Gender : "";
}

/** Whole years of age on the given day in India, or null for a date that isn't real. */
export function ageOn(birthDate: unknown, at: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthDate ?? ""));
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const born = new Date(Date.UTC(year, month - 1, day));
  if (born.getUTCFullYear() !== year || born.getUTCMonth() !== month - 1 || born.getUTCDate() !== day) return null;
  const today = new Date(at + IST_OFFSET_MS);
  let age = today.getUTCFullYear() - year;
  if (today.getUTCMonth() + 1 < month || (today.getUTCMonth() + 1 === month && today.getUTCDate() < day)) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

/** The age group for a birth date, or "" for anyone under 18 or with no valid date. */
export function ageBandFor(birthDate: unknown, at: number): AgeBand | "" {
  const age = ageOn(birthDate, at);
  if (age === null || age < 18) return "";
  if (age <= 24) return "18-24";
  if (age <= 34) return "25-34";
  if (age <= 44) return "35-44";
  if (age <= 54) return "45-54";
  return "55+";
}

/** The segment a saved "About you" record puts a customer in. Without consent there is none. */
export function segmentFrom(record: unknown, at: number): CustomerSegment {
  const value = record && typeof record === "object" ? record as Record<string, unknown> : {};
  if (value.consent !== true) return {gender: "", ageBand: ""};
  const ageBand = ageBandFor(value.birthDate, at);
  // A birth date under 18 means a child: no segment at all, not even gender.
  if (value.birthDate && ageOn(value.birthDate, at) !== null && ageBand === "") return {gender: "", ageBand: ""};
  return {gender: normalizeGender(value.gender), ageBand};
}

/** A delivery area's key: "Magunta Layout" and "magunta  layout," are the same area. */
export function areaKey(area: unknown): string {
  return String(area ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

/** Who an offer is for. Empty lists mean everyone. */
export interface PromotionAudience {
  genders: Gender[];
  ageBands: AgeBand[];
  areaKeys: string[];
}

export function normalizeAudience(value: unknown): PromotionAudience {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const list = (v: unknown) => Array.isArray(v) ? v.map(String) : [];
  return {
    genders: [...new Set(list(input.genders).map(normalizeGender).filter((g): g is Gender => g !== ""))],
    ageBands: [...new Set(list(input.ageBands).filter((b): b is AgeBand => (AGE_BANDS as readonly string[]).includes(b)))],
    areaKeys: [...new Set(list(input.areaKeys).map(areaKey).filter(Boolean))].slice(0, 30),
  };
}

export function audienceTargetsPeople(audience: PromotionAudience): boolean {
  return audience.genders.length > 0 || audience.ageBands.length > 0;
}

/**
 * Why this customer can't use an offer meant for a group, or null when they
 * can. A customer who hasn't shared their details isn't in any gender or age
 * group, so offers aimed at one don't apply to them.
 */
export function audienceMismatch(
  audience: PromotionAudience,
  segment: CustomerSegment,
  deliveryAreaKey: string,
): "not_for_you" | "wrong_area" | null {
  if (audience.genders.length && (!segment.gender || !audience.genders.includes(segment.gender))) return "not_for_you";
  if (audience.ageBands.length && (!segment.ageBand || !audience.ageBands.includes(segment.ageBand))) return "not_for_you";
  if (audience.areaKeys.length && !audience.areaKeys.includes(areaKey(deliveryAreaKey))) return "wrong_area";
  return null;
}

/** Plain words for a segment, e.g. "Women 25-34". */
export function segmentLabel(segment: CustomerSegment): string {
  const who = segment.gender === "female" ? "Women" : segment.gender === "male" ? "Men" :
    segment.gender === "other" ? "Other" : "Not shared";
  return segment.ageBand ? `${who} ${segment.ageBand}` : who;
}

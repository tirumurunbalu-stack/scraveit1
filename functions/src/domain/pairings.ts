/**
 * A restaurant's paid pairings, kept on its listing as `pairings`: dishes from
 * its own menu (`suggestIds`) suggested under chosen dishes (`itemIds`) once the
 * customer adds one ("Finish sweetly: Gulab Jamun ₹50, Double Ka Meetha ₹70"
 * under any burger). Suggested dishes are ordinary menu items at their menu
 * price, so checkout prices them like any other line; nothing here changes the bill.
 */
export interface Pairing {
  id: string;
  title: string;
  suggestIds: string[];
  itemIds: string[];
  active: boolean;
}

export const MAX_PAIRINGS = 10;
export const MAX_SUGGESTED = 10;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function ids(value: unknown, max: number, skip: Set<string> = new Set()): string[] {
  return Array.isArray(value) ? [...new Set(value.map((v) => text(v, 120)).filter((v) => v && !skip.has(v)))].slice(0, max) : [];
}

/** Valid pairings from whatever is stored; anything malformed is dropped, never guessed. */
export function normalizePairings(value: unknown): Pairing[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): Pairing[] => {
    const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = text(x.id, 40);
    const suggestIds = ids(x.suggestIds, MAX_SUGGESTED);
    const itemIds = ids(x.itemIds, 100, new Set(suggestIds));
    if (!id || !suggestIds.length || !itemIds.length) return [];
    return [{id, title: text(x.title, 60) || "Goes well with", suggestIds, itemIds, active: x.active !== false}];
  }).slice(0, MAX_PAIRINGS);
}

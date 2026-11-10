import type {PricedOrderItem} from "../types";

/**
 * A restaurant's free-item offers ("freebies"), kept on its listing as
 * `freebies`. Either a free item with chosen dishes ("Free French fries with
 * any Crispy Box"), one per dish ordered, or one free item once the item total
 * reaches an amount ("Finish sweetly: free Gulab Jamun above ₹499"). The free
 * item is the restaurant's gift, so it is added to the order at ₹0 and never
 * changes the bill, the commission or the GST.
 */
export interface Freebie {
  id: string;
  title: string;
  freeItem: string;
  diet: "veg" | "nonveg" | "egg";
  trigger: "items" | "amount";
  itemIds: string[];
  minimumOrder: number;
  active: boolean;
}

export const MAX_FREEBIES = 6;
/** A free item with each dish, capped so one big order can't empty the kitchen. */
const MAX_FREE_PER_LINE = 10;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/** Valid freebies from whatever is stored; anything malformed is dropped, never guessed. */
export function normalizeFreebies(value: unknown): Freebie[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): Freebie[] => {
    const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = text(x.id, 40), title = text(x.title, 60), freeItem = text(x.freeItem, 60);
    const trigger = x.trigger === "amount" ? "amount" : x.trigger === "items" ? "items" : null;
    const itemIds = Array.isArray(x.itemIds) ? [...new Set(x.itemIds.map((v) => text(v, 120)).filter(Boolean))].slice(0, 100) : [];
    const minimumOrder = Math.round(Number(x.minimumOrder));
    if (!id || !freeItem || !trigger) return [];
    if (trigger === "items" && !itemIds.length) return [];
    if (trigger === "amount" && !(minimumOrder > 0)) return [];
    return [{
      id, title: title || `Free ${freeItem}`, freeItem,
      diet: x.diet === "nonveg" || x.diet === "egg" ? x.diet : "veg",
      trigger, itemIds: trigger === "items" ? itemIds : [], minimumOrder: trigger === "amount" ? minimumOrder : 0,
      active: x.active !== false,
    }];
  }).slice(0, MAX_FREEBIES);
}

/**
 * The ₹0 lines a priced cart earns. `itemTotal` is the item total the customer
 * sees on the menu (before offers, delivery and taxes).
 */
export function freebieLines(freebies: unknown, items: PricedOrderItem[], itemTotal: number): PricedOrderItem[] {
  return normalizeFreebies(freebies).filter((f) => f.active).flatMap((f): PricedOrderItem[] => {
    const quantity = f.trigger === "items"
      ? Math.min(MAX_FREE_PER_LINE, items.filter((i) => f.itemIds.includes(i.itemId)).reduce((n, i) => n + i.quantity, 0))
      : itemTotal >= f.minimumOrder ? 1 : 0;
    if (quantity <= 0) return [];
    return [{
      itemId: "", name: f.freeItem, quantity, price: 0, variant: "", variantPrice: 0, addOns: [], addOnTotal: 0,
      note: f.title, diet: f.diet, free: true, freebieId: f.id,
    }];
  });
}

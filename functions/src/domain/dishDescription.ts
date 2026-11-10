/**
 * The short menu description Scraveit writes for a dish on the partner
 * dashboard ("Soft steamed rice cakes served with coconut chutney and
 * sambar."). The owner can ask for changes in their own words; the result is
 * only a draft they review before saving it to the menu.
 */
export interface DishFacts {
  name: string;
  category: string;
  price: number;
  diet: string;
  restaurant: string;
  current: string;
  instructions: string;
}

export const DESCRIPTION_MAX = 220;
/** Drafts per outlet per day; plenty for writing a whole menu, a stop for runaway clicking. */
export const DAILY_DESCRIPTION_LIMIT = 300;

export const DESCRIPTION_SYSTEM_PROMPT = [
  "You write menu descriptions for dishes on Scraveit, a food delivery app in Andhra Pradesh, India.",
  "Write one or two short sentences (under 200 characters) that tell a hungry customer what the dish is: main ingredients, how it is cooked, how it tastes, what it is served with.",
  "Use simple everyday English that Indian customers understand. Keep the dish's own name as written.",
  "Only state what the dish name, category, photo or the owner's notes support; never invent ingredients, portion sizes, awards or health claims.",
  "No emoji, no hashtags, no prices, no quotation marks, no exclamation marks.",
  "Reply with the description text only.",
].join("\n");

function line(label: string, value: string): string {
  return value ? `${label}: ${value}\n` : "";
}

export function descriptionPrompt(facts: DishFacts): string {
  const base = line("Restaurant", facts.restaurant) + line("Dish", facts.name) + line("Menu section", facts.category) +
    line("Price", facts.price > 0 ? `Rs ${facts.price}` : "") + line("Food type", facts.diet);
  if (facts.instructions) {
    return base + line("Current description", facts.current) +
      `\nThe owner wants it changed like this: ${facts.instructions}\nWrite the new description.`;
  }
  return base + "\nWrite the description.";
}

/** Plain, single-paragraph text that fits the menu's description box. */
export function cleanDescription(text: string): string {
  const flat = text.replace(/\s+/g, " ").replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").trim();
  if (flat.length <= DESCRIPTION_MAX) return flat;
  const cut = flat.slice(0, DESCRIPTION_MAX);
  const end = cut.lastIndexOf(". ");
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + ".";
}

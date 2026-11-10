import {describe, expect, it} from "vitest";
import {DESCRIPTION_MAX, cleanDescription, descriptionPrompt} from "./dishDescription";

const facts = {name: "Idli", category: "Tiffins", price: 30, diet: "veg", restaurant: "Highway Cross", current: "", instructions: ""};

describe("descriptionPrompt", () => {
  it("asks for a fresh description from the dish facts", () => {
    const prompt = descriptionPrompt(facts);
    expect(prompt).toContain("Dish: Idli\n");
    expect(prompt).toContain("Price: Rs 30\n");
    expect(prompt).not.toContain("owner wants");
  });

  it("passes the owner's change request with the current text", () => {
    const prompt = descriptionPrompt({...facts, current: "Soft idlis.", instructions: "say it comes with ghee podi"});
    expect(prompt).toContain("Current description: Soft idlis.\n");
    expect(prompt).toContain("The owner wants it changed like this: say it comes with ghee podi");
  });
});

describe("cleanDescription", () => {
  it("strips quotes and line breaks", () => {
    expect(cleanDescription('"Soft steamed rice cakes\nwith chutney."')).toBe("Soft steamed rice cakes with chutney.");
  });

  it("cuts long text at a sentence end", () => {
    const long = "Soft steamed rice cakes made fresh every morning with a light fermented batter. " + "Served hot with coconut chutney and sambar ".repeat(5);
    const out = cleanDescription(long);
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(out.endsWith("batter.")).toBe(true);
  });
});

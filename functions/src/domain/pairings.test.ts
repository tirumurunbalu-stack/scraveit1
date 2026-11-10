import {describe, expect, it} from "vitest";
import {MAX_PAIRINGS, normalizePairings} from "./pairings";

describe("normalizePairings", () => {
  it("keeps a pairing with its suggested dishes and the dishes it goes with", () => {
    expect(normalizePairings([{id: "pr1", title: " Finish  sweetly ", suggestIds: ["jamun", "meetha", "jamun"], itemIds: ["burger", "burger", "jamun", "wings"]}]))
      .toEqual([{id: "pr1", title: "Finish sweetly", suggestIds: ["jamun", "meetha"], itemIds: ["burger", "wings"], active: true}]);
  });

  it("drops pairings without a suggested dish or any dish to go with", () => {
    expect(normalizePairings([{id: "a", itemIds: ["burger"]}, {id: "b", suggestIds: ["jamun"], itemIds: []},
      {id: "c", suggestIds: ["jamun"], itemIds: ["jamun"]}, {id: "d", suggestIds: [], itemIds: ["burger"]}, null, "x"])).toEqual([]);
    expect(normalizePairings({id: "a"})).toEqual([]);
  });

  it("keeps paused pairings, names untitled ones and caps the list", () => {
    const list = normalizePairings(Array.from({length: 12}, (_, i) => ({id: `p${i}`, suggestIds: ["jamun"], itemIds: ["burger"], active: i !== 0})));
    expect(list).toHaveLength(MAX_PAIRINGS);
    expect(list[0]).toMatchObject({active: false, title: "Goes well with"});
  });
});

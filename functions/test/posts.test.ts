import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}}));

const {feedCard, STORY_MS, commentNotice, cleanStickers, audienceOf, tallyOf} = await import("../src/services/posts");

describe("friends' feed cards", () => {
  it("gives a story 24 hours and a post no end", () => {
    const story = feedCard("p1", {from: "a", kind: "story", caption: "Dosa time", w: 1080, h: 1920, createdAt: 1000}, "Asha", 5000);
    expect(story).toMatchObject({postId: "p1", from: "a", fromName: "Asha", kind: "story", createdAt: 1000, expiresAt: 1000 + STORY_MS});
    const post = feedCard("p2", {from: "a", kind: "post", caption: "", w: 4, h: 3, createdAt: {toMillis: () => 2000}}, "Asha", 5000);
    expect(post).toMatchObject({kind: "post", createdAt: 2000, expiresAt: 0});
  });
  it("never carries the photo and trims long text", () => {
    const card = feedCard("p3", {from: "a", kind: "odd", caption: "x".repeat(400), image: "data:image/jpeg;base64,AAAA"}, "N".repeat(90), 5000);
    expect(card).not.toHaveProperty("image");
    expect(card.kind).toBe("post");
    expect(String(card.caption)).toHaveLength(200);
    expect(String(card.fromName)).toHaveLength(60);
  });
});

describe("comment pushes", () => {
  it("names the commenter and what they commented on", () => {
    expect(commentNotice("Asha", "story", "So   good!\n")).toEqual({title: "Asha commented on your story", body: "So good!"});
    expect(commentNotice("", "post", "x".repeat(300))).toMatchObject({title: "A friend commented on your post"});
    expect(commentNotice("", "post", "x".repeat(300)).body).toHaveLength(120);
  });
});

describe("story audience", () => {
  const friends = ["b", "c", "d"];
  it("sends a post to every friend, and a story to all but the hidden", () => {
    expect(audienceOf("a", {kind: "post"}, friends, {hide: ["c"]})).toEqual(["a", "b", "c", "d"]);
    expect(audienceOf("a", {kind: "story"}, friends, {hide: ["c"]})).toEqual(["a", "b", "d"]);
  });
  it("sends a Close Friends story only to that list, still minus the hidden", () => {
    expect(audienceOf("a", {kind: "story", to: "close"}, friends, {close: ["b", "c", "z"], hide: ["c"]})).toEqual(["a", "b"]);
    expect(audienceOf("a", {kind: "story", to: "close"}, friends, undefined)).toEqual(["a"]);
  });
  it("marks Close Friends and video stories on the card", () => {
    const card = feedCard("p", {from: "a", kind: "story", to: "close", video: true, dur: 99999, createdAt: 1}, "A", 1);
    expect(card).toMatchObject({close: true, video: true, dur: 16000});
    expect(feedCard("p", {from: "a", kind: "post", to: "close", video: true}, "A", 1)).not.toHaveProperty("video");
  });
});

describe("story stickers", () => {
  it("keeps the stickers it understands, cleaned", () => {
    const out = cleanStickers([
      {t: "poll", q: "  Biryani   or pizza? ", o: ["Biryani", "Pizza", ""], x: 2, y: -1, s: 9},
      {t: "poll", q: "one option", o: ["only"]},
      {t: "ask", q: ""},
      {t: "slider", q: "How spicy?", e: "🌶️"},
      {t: "mention", uid: "b", name: "Bala"},
      {t: "mention", uid: "stranger"},
      {t: "dish", rid: "r1", name: "Spice Hub", item: "Chicken 65"},
      {t: "dish"},
      {t: "hack", x: 1},
    ], new Set(["b"]));
    expect(out.map((s) => s.t)).toEqual(["poll", "ask", "slider", "mention", "dish"]);
    expect(out[0]).toMatchObject({q: "Biryani or pizza?", o: ["Biryani", "Pizza"], x: 1, y: 0, s: 4});
    expect(out[1]).toMatchObject({q: "Ask me anything"});
  });
  it("takes at most six and ignores junk", () => {
    expect(cleanStickers("x", new Set())).toEqual([]);
    expect(cleanStickers(Array.from({length: 9}, () => ({t: "ask"})), new Set())).toHaveLength(6);
  });
  it("totals poll votes, slider averages and question answers", () => {
    const stickers = [{t: "poll", o: ["A", "B"]}, {t: "slider"}, {t: "ask"}];
    const tally = tallyOf(stickers, [
      {poll: {"0": 1}, slider: {"1": 80}, ask: {"2": "Dosa"}},
      {poll: {"0": 1}, slider: {"1": 40}},
      {poll: {"0": 7}, slider: {"1": 400}, ask: {"2": "  "}},
    ]);
    expect(tally).toEqual({"0": {n: 2, votes: [0, 2]}, "1": {n: 2, avg: 60}, "2": {n: 1}});
  });
});

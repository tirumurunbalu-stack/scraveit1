import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}}));

const {feedCard, STORY_MS, commentNotice} = await import("../src/services/posts");

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

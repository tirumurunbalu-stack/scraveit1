import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}}));
const pushes: Array<[string, Record<string, unknown>]> = [];
vi.mock("../src/services/notifications", () => ({
  notifyCallIncoming: vi.fn(async (input: Record<string, unknown>) => { pushes.push(["ring", input]); }),
  notifyCallEnded: vi.fn(async (input: Record<string, unknown>) => { pushes.push(["end", input]); }),
}));

import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
const calls = await import("../src/services/calls");

function friends() {
  const db = new InMemoryFirestore();
  db.seed("friendships/p1", {status: "accepted", members: ["a", "b"], names: {a: "Ravi", b: "Padhu"}});
  return db;
}
const ringing = {from: "a", to: "b", pairId: "p1", kind: "video", status: "ringing", createdAt: 1};

describe("calls", () => {
  it("without TURN keys it still returns STUN servers", async () => {
    const res = await calls.callIceServers("a");
    expect(res.relay).toBe(false);
    expect(JSON.stringify(res.iceServers)).toContain("stun:");
  });

  it("rings the friend when a call starts", async () => {
    pushes.length = 0;
    await calls.onCallWritten("c1", null, ringing, friends());
    expect(pushes).toEqual([["ring", {uid: "b", callId: "c1", pairId: "p1", kind: "video", fromName: "Ravi"}]]);
  });

  it("an unanswered call stops the ringing, shows as missed and leaves a chat line", async () => {
    pushes.length = 0;
    const db = friends();
    await calls.onCallWritten("c1", ringing, {...ringing, status: "missed"}, db);
    expect(pushes[0]?.[0]).toBe("end");
    expect(pushes[0]?.[1]).toMatchObject({missed: true, uid: "b"});
    expect(db.read("chats/p1/messages/call_c1")).toMatchObject({from: "a", card: {type: "call", kind: "video", status: "missed"}});
  });

  it("a finished call is logged with its length, without a missed-call alert", async () => {
    pushes.length = 0;
    const db = friends();
    const accepted = {...ringing, status: "accepted", answeredAt: 10_000};
    await calls.onCallWritten("c2", accepted, {...accepted, status: "ended", endedAt: 252_000}, db);
    expect(pushes).toEqual([]);
    expect(db.read("chats/p1/messages/call_c2")).toMatchObject({card: {type: "call", status: "done", ms: 242_000}});
    expect(calls.callPreview({type: "call", kind: "video", status: "done", ms: 242_000})).toBe("📞 Video call · 4:02");
    expect(calls.callPreview({type: "call", kind: "audio", status: "missed"})).toBe("📞 Missed voice call");
  });

  it("ignores calls between people who aren't friends any more", async () => {
    pushes.length = 0;
    const db = new InMemoryFirestore();
    db.seed("friendships/p1", {status: "blocked", members: ["a", "b"]});
    await calls.onCallWritten("c3", null, ringing, db);
    expect(pushes).toEqual([]);
  });
});

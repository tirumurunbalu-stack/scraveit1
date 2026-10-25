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

  it("rings the friend when a call starts, with a key their phone uses to say it's ringing", async () => {
    pushes.length = 0;
    const db = friends();
    await calls.onCallWritten("c1", null, ringing, db);
    expect(pushes).toHaveLength(1);
    const [kind, input] = pushes[0]!;
    expect(kind).toBe("ring");
    expect(input).toMatchObject({uid: "b", callId: "c1", pairId: "p1", kind: "video", fromName: "Ravi"});
    expect(String(input.ringKey)).toMatch(/^[0-9a-f]{32}$/);
    expect(db.read("callRings/c1")).toMatchObject({key: input.ringKey, to: "b"});
  });

  it("marks the call as ringing only with the key from the push", async () => {
    pushes.length = 0;
    const db = friends();
    db.seed("calls/c1", ringing);
    await calls.onCallWritten("c1", null, ringing, db);
    const key = String(pushes[0]![1].ringKey);
    const update = vi.spyOn(Object.getPrototypeOf(db.collection("calls").doc("c1")), "update");
    expect(await calls.confirmRinging("c1", "0".repeat(32), db)).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(await calls.confirmRinging("c1", key, db)).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(Object.keys(update.mock.calls[0]![0] as object)).toEqual(["ringingAt"]);
    update.mockRestore();
    // The answer or "ringing" landing on the call doesn't ring again.
    pushes.length = 0;
    await calls.onCallWritten("c1", ringing, {...ringing, ringingAt: 5}, db);
    expect(pushes).toEqual([]);
    // Once the call is over, the key is gone.
    await calls.onCallWritten("c1", ringing, {...ringing, status: "cancelled"}, db);
    expect(db.read("callRings/c1")).toBeNull();
    db.seed("calls/c1", {...ringing, status: "cancelled"});
    expect(await calls.confirmRinging("c1", key, db)).toBe(false);
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
    // Firestore hands timestamps back as Timestamp objects.
    const at = (ms: number) => ({toMillis: () => ms, valueOf: () => String(ms / 1000)});
    const accepted = {...ringing, status: "accepted", answeredAt: at(10_000)};
    await calls.onCallWritten("c2", accepted, {...accepted, status: "ended", endedAt: at(252_000)}, db);
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

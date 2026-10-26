import {beforeEach, describe, expect, it, vi} from "vitest";

/** A tiny in-memory Firestore (as in chatUnsend.test.ts), for chat messages locked end to end. */
const docs = new Map<string, Record<string, unknown>>();
const DELETE = Symbol("delete");
function applyUpdate(path: string, patch: Record<string, unknown>, merge = true) {
  const next = merge ? {...(docs.get(path) ?? {})} : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === DELETE) delete next[k]; else next[k] = v;
  }
  docs.set(path, next);
}
function docRef(path: string) {
  return {
    id: path.split("/").pop(),
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => ({exists: docs.has(path), id: path.split("/").pop(), data: () => docs.get(path)}),
    set: async (data: Record<string, unknown>, opts?: {merge?: boolean}) => applyUpdate(path, data, !!opts?.merge),
    update: async (data: Record<string, unknown>) => {
      if (!docs.has(path)) throw new Error("NOT_FOUND");
      applyUpdate(path, data);
    },
  };
}
function collectionRef(path: string) {
  const query = (field = "", limit = Infinity) => ({
    orderBy: (f: string) => query(f, limit),
    limit: (n: number) => query(field, n),
    get: async () => {
      const list = [...docs.entries()].filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
        .map(([p, d]) => ({id: p.split("/").pop(), data: () => d}))
        .sort((a, b) => Number(b.data()[field] ?? 0) - Number(a.data()[field] ?? 0)).slice(0, limit);
      return {empty: !list.length, docs: list};
    },
  });
  let auto = 0;
  return {doc: (id?: string) => docRef(`${path}/${id ?? `auto${++auto}`}`), ...query()};
}
const db = {
  collection: (name: string) => collectionRef(name),
  batch: () => {
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>, opts?: {merge?: boolean}) => { ops.push(() => ref.set(data, opts)); },
      update: (ref: ReturnType<typeof docRef>, data: Record<string, unknown>) => { ops.push(() => ref.update(data)); },
      commit: async () => { for (const op of ops) await op(); },
    };
  },
};

const pushes: Array<[string, Record<string, unknown>]> = [];
vi.mock("../src/admin", () => ({firestoreDb: db, auth: {}, storage: {}, messaging: {}}));
vi.mock("firebase-admin/firestore", () => ({FieldValue: {delete: () => DELETE, increment: (n: number) => n, serverTimestamp: () => 0}}));
vi.mock("../src/services/notifications", () => ({
  notifyChatSealed: vi.fn(async (input: Record<string, unknown>) => { pushes.push(["sealed", input]); }),
  notifyUserChat: vi.fn(async (input: Record<string, unknown>) => { pushes.push(["plain", input]); }),
  notifyCallIncoming: vi.fn(), notifyCallEnded: vi.fn(),
}));
vi.mock("../src/services/adminAlerts", () => ({alarmAdmins: vi.fn(async () => undefined), requestAlarmId: () => "alarm"}));
vi.mock("../src/services/chatFun", () => ({streakUpdate: () => ({streak: {count: 1}, milestone: 0}), celebrateStreak: vi.fn()}));

const {onChatMessage, chatUnsend, chatReport} = await import("../src/services/social");

const PAIR = "aaaaaa_bbbbbb", NOW = 10_000_000_000;
const KEY = "B" + "A".repeat(86) + "=";
const sealed = {v: 1, iv: "AAAAAAAAAAAAAAAA", ct: "bG9ja2Vk", spk: KEY, rpk: KEY};
const msg = (id: string, data: Record<string, unknown>) => docs.set(`chats/${PAIR}/messages/${id}`, {at: NOW - 60_000, ...data});

describe("chat locked end to end", () => {
  beforeEach(() => {
    docs.clear();
    pushes.length = 0;
    docs.set(`friendships/${PAIR}`, {members: ["aaaaaa", "bbbbbb"], status: "accepted", names: {aaaaaa: "Ravi", bbbbbb: "Padhu"}, lastText: "hello"});
  });

  it("a locked message: the chat list and the push carry the lock, never the words", async () => {
    msg("m1", {from: "aaaaaa", text: "", e2e: sealed});
    await onChatMessage(PAIR, "m1", {from: "aaaaaa", text: "", e2e: sealed}, NOW);
    const pair = docs.get(`friendships/${PAIR}`)!;
    expect(pair).toMatchObject({lastText: "🔒 Message", lastE2e: {...sealed, from: "aaaaaa", id: "m1"}, lastFrom: "aaaaaa", lastAt: NOW});
    expect(pushes).toEqual([["sealed", {uid: "bbbbbb", key: `chat:${PAIR}:m1`, fromName: "Ravi", pairId: PAIR, messageId: "m1", from: "aaaaaa", sealed}]]);
    expect(docs.get(`chats/${PAIR}/messages/m1`)!.phoneHidden).toBeUndefined();
  });

  it("a plain message (an older app, a call line) clears the locked chat-list line", async () => {
    docs.set(`friendships/${PAIR}`, {...docs.get(`friendships/${PAIR}`)!, lastE2e: {...sealed, from: "aaaaaa", id: "m1"}});
    msg("m2", {from: "bbbbbb", text: "call me on 9848022338"});
    await onChatMessage(PAIR, "m2", {from: "bbbbbb", text: "call me on 9848022338"}, NOW);
    const pair = docs.get(`friendships/${PAIR}`)!;
    expect(pair.lastE2e).toBeUndefined();
    expect(pair.lastText).toBe("call me on [phone number hidden]");
    expect(pushes[0]?.[0]).toBe("plain");
  });

  it("a broken lock is treated as a plain (empty) message, not forwarded", async () => {
    await onChatMessage(PAIR, "m3", {from: "aaaaaa", text: "", e2e: {...sealed, ct: "x".repeat(9000)}}, NOW);
    expect(pushes[0]?.[0]).toBe("plain");
  });

  it("unsending a locked photo message: the sender's phone names the photo; someone else's can't be taken down", async () => {
    docs.set(`chats/${PAIR}/photos/p1`, {from: "aaaaaa", e2e: sealed});
    docs.set(`chats/${PAIR}/photos/p2`, {from: "bbbbbb", e2e: sealed});
    msg("m1", {from: "aaaaaa", text: "", e2e: sealed});
    msg("m2", {from: "aaaaaa", text: "", e2e: sealed, at: NOW - 50_000});
    await chatUnsend("aaaaaa", {pairId: PAIR, messageId: "m1", photoId: "p1"}, NOW);
    await chatUnsend("aaaaaa", {pairId: PAIR, messageId: "m2", photoId: "p2"}, NOW);
    expect(docs.get(`chats/${PAIR}/photos/p1`)!.removed).toBe(true);
    expect(docs.get(`chats/${PAIR}/photos/p2`)!.removed).toBeUndefined();
    expect(docs.get(`chats/${PAIR}/messages/m1`)).toMatchObject({unsent: true, text: ""});
    expect(docs.get(`chats/${PAIR}/messages/m1`)!.e2e).toBeUndefined();
    expect(docs.get(`chatUnsent/${PAIR}_m1`)).toMatchObject({locked: true, from: "aaaaaa"});
  });

  it("a report carries what the reporter's phone showed for locked messages", async () => {
    msg("m1", {from: "bbbbbb", text: "", e2e: sealed, at: NOW - 3000});
    msg("m2", {from: "bbbbbb", text: "", e2e: sealed, at: NOW - 2000});
    msg("m3", {from: "aaaaaa", text: "plain old message", at: NOW - 1000});
    await chatReport("aaaaaa", {pairId: PAIR, reason: "harassment", note: "", block: false, revealed: [{id: "m1", text: "you are an idiot", card: null}]}, NOW);
    const report = [...docs.entries()].find(([p]) => p.startsWith("chatReports/"))![1];
    const byId = Object.fromEntries((report.messages as Array<Record<string, unknown>>).map((m) => [m.id, m]));
    expect(byId.m1).toMatchObject({text: "you are an idiot", locked: true, revealedByReporter: true});
    expect(byId.m2).toMatchObject({text: "🔒 Locked message", locked: true, revealedByReporter: false});
    expect(byId.m3).toMatchObject({text: "plain old message"});
    expect(byId.m3!.locked).toBeUndefined();
  });
});

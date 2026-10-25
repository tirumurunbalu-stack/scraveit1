import {beforeEach, describe, expect, it, vi} from "vitest";

/** A tiny in-memory Firestore: enough for chatUnsend (get, set/merge, update, batch, orderBy+limit). */
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
  return {doc: (id: string) => docRef(`${path}/${id}`), ...query()};
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

vi.mock("../src/admin", () => ({firestoreDb: db, auth: {}, storage: {}, messaging: {}}));
vi.mock("firebase-admin/firestore", () => ({FieldValue: {delete: () => DELETE, increment: (n: number) => n}}));

const {chatUnsend, UNSEND_WINDOW_MS} = await import("../src/services/social");

const PAIR = "aaaaaa_bbbbbb", NOW = 10_000_000_000;
const msg = (id: string, data: Record<string, unknown>) => docs.set(`chats/${PAIR}/messages/${id}`, {at: NOW - 60_000, ...data});

describe("unsend", () => {
  beforeEach(() => {
    docs.clear();
    docs.set(`friendships/${PAIR}`, {members: ["aaaaaa", "bbbbbb"], status: "accepted", lastText: "hello there"});
  });

  it("blanks the sender's message for both, keeps it for moderators and updates the chat list", async () => {
    msg("m1", {from: "aaaaaa", text: "hello there", reactions: {bbbbbb: "😂"}});
    await expect(chatUnsend("aaaaaa", {pairId: PAIR, messageId: "m1"}, NOW)).resolves.toEqual({unsent: true});
    const m = docs.get(`chats/${PAIR}/messages/m1`)!;
    expect(m).toMatchObject({text: "", unsent: true, unsentAt: NOW});
    expect(m.reactions).toBeUndefined();
    expect(docs.get(`chatUnsent/${PAIR}_m1`)).toMatchObject({text: "hello there", from: "aaaaaa"});
    expect(docs.get(`friendships/${PAIR}`)!.lastText).toBe("🚫 This message was deleted");
  });

  it("makes an unsent photo or voice note unreadable", async () => {
    docs.set(`chats/${PAIR}/photos/p1`, {from: "aaaaaa", image: "data:image/jpeg;base64,AA"});
    docs.set(`chats/${PAIR}/voices/v1`, {from: "aaaaaa", audio: "data:audio/webm;base64,AA"});
    msg("m1", {from: "aaaaaa", text: "", card: {type: "photo", photoId: "p1"}});
    msg("m2", {from: "aaaaaa", text: "", card: {type: "voice", voiceId: "v1"}, at: NOW - 30_000});
    await chatUnsend("aaaaaa", {pairId: PAIR, messageId: "m1"}, NOW);
    await chatUnsend("aaaaaa", {pairId: PAIR, messageId: "m2"}, NOW);
    expect(docs.get(`chats/${PAIR}/photos/p1`)!.removed).toBe(true);
    expect(docs.get(`chats/${PAIR}/voices/v1`)!.removed).toBe(true);
    expect(docs.get(`chats/${PAIR}/messages/m1`)!.card).toBeUndefined();
  });

  it("refuses someone else's message, call lines, old messages and outsiders", async () => {
    msg("theirs", {from: "bbbbbb", text: "hi"});
    msg("call", {from: "aaaaaa", text: "", card: {type: "call"}});
    msg("old", {from: "aaaaaa", text: "hi", at: NOW - UNSEND_WINDOW_MS - 1});
    await expect(chatUnsend("aaaaaa", {pairId: PAIR, messageId: "theirs"}, NOW)).rejects.toThrow(/only your own/);
    await expect(chatUnsend("aaaaaa", {pairId: PAIR, messageId: "call"}, NOW)).rejects.toThrow(/can't be unsent/);
    await expect(chatUnsend("aaaaaa", {pairId: PAIR, messageId: "old"}, NOW)).rejects.toThrow(/2 days/);
    await expect(chatUnsend("zzzzzz", {pairId: PAIR, messageId: "theirs"}, NOW)).rejects.toThrow(/isn't available/);
    expect(docs.get(`chats/${PAIR}/messages/theirs`)!.text).toBe("hi");
  });

  it("leaves the chat list alone when an older message is unsent", async () => {
    msg("old", {from: "aaaaaa", text: "first", at: NOW - 120_000});
    msg("new", {from: "bbbbbb", text: "latest", at: NOW - 10_000});
    await chatUnsend("aaaaaa", {pairId: PAIR, messageId: "old"}, NOW);
    expect(docs.get(`friendships/${PAIR}`)!.lastText).toBe("hello there");
  });
});

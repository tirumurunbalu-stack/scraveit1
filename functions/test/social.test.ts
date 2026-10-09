import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}}));

const {pairIdFor, newFriendCode, normalizeCode, maskPhones, chatAllowed, normalizeUsername, usernameProblem, looksLikeCode} = await import("../src/services/social");

describe("friends and chat", () => {
  it("gives two people one chat id, whoever starts it", () => {
    expect(pairIdFor("bbbbbb", "aaaaaa")).toBe("aaaaaa_bbbbbb");
    expect(pairIdFor("aaaaaa", "bbbbbb")).toBe("aaaaaa_bbbbbb");
  });
  it("makes readable friend codes and accepts them typed loosely", () => {
    const code = newFriendCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normalizeCode(" ana 4k7p ")).toBe("ANA-4K7P");
    expect(normalizeCode("ana-4k7")).toBe("");
  });
  it("hides phone numbers typed into chat", () => {
    expect(maskPhones("call me on 98765 43210 ok")).toBe("call me on [phone number hidden] ok");
    expect(maskPhones("+91 9876543210")).toBe("[phone number hidden]");
    expect(maskPhones("table for 4 at 7:30")).toBe("table for 4 at 7:30");
  });
  it("lets only allowed people chat", () => {
    const now = 1_000_000;
    expect(chatAllowed(null, now).reason).toBe("setup");
    expect(chatAllowed({status: "active", minor: false}, now).ok).toBe(true);
    expect(chatAllowed({status: "active", minor: true, parentStatus: "pending"}, now).reason).toBe("parent");
    expect(chatAllowed({status: "active", minor: true, parentStatus: "approved"}, now).ok).toBe(true);
    expect(chatAllowed({status: "suspended", suspendedUntil: now + 1}, now).reason).toBe("suspended");
    expect(chatAllowed({status: "suspended", suspendedUntil: now - 1, minor: false}, now).ok).toBe(true);
    expect(chatAllowed({status: "banned"}, now).reason).toBe("banned");
  });
  it("checks usernames like Instagram does", () => {
    expect(normalizeUsername(" @Balaji0803 ")).toBe("balaji0803");
    expect(usernameProblem("balaji0803")).toBe("");
    expect(usernameProblem("ba")).not.toBe("");
    expect(usernameProblem("0balaji")).not.toBe("");
    expect(usernameProblem("bala..ji")).not.toBe("");
    expect(usernameProblem("balaji_")).not.toBe("");
    expect(usernameProblem("scraveit_team")).not.toBe("");
  });
  it("tells a friend code from a username", () => {
    expect(looksLikeCode("E27-YNWX")).toBe(true);
    expect(looksLikeCode("e27ynwx")).toBe(true);
    expect(looksLikeCode("balaji0803")).toBe(false);
    expect(looksLikeCode("@ana4k7p")).toBe(false);
  });
});

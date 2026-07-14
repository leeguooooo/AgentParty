import { test, expect } from "bun:test";
import { nextMentionBadgeCount, shouldMarkSeen, shouldNotify, shouldToast } from "./notify";
const base = (over = {}) => ({ type:"msg", kind:"message", seq:5, mentions:["leo"], retracted:undefined,
  sender:{name:"bob",kind:"agent"}, body:"hi @leo", ...over } as any);

test("被@ + 隐藏 + 已授权 → true", () => {
  expect(shouldNotify(base(), "leo", true, true)).toBe(true);
});
test("标签页可见 → false", () => {
  expect(shouldNotify(base(), "leo", false, true)).toBe(false);
});
test("未授权 → false", () => {
  expect(shouldNotify(base(), "leo", true, false)).toBe(false);
});
test("没@我 → false", () => {
  expect(shouldNotify(base({mentions:["carol"]}), "leo", true, true)).toBe(false);
});
test("我没 handle → false", () => {
  expect(shouldNotify(base(), null, true, true)).toBe(false);
});
test("human 稳定 name 与可读 handle 不同时，底层 name mention 仍命中", () => {
  const byName = base({ mentions: ["lark-ad72b3f9749e"] });
  expect(shouldNotify(byName, "leo", true, true, "lark-ad72b3f9749e")).toBe(true);
  expect(shouldToast(byName, "leo", false, true, "lark-ad72b3f9749e")).toBe(true);
  expect(nextMentionBadgeCount(2, byName, "leo", true, "lark-ad72b3f9749e")).toBe(3);
});
test("没有 handle 但有稳定 name 时仍能识别自己的 mention", () => {
  const byName = base({ mentions: ["lark-ad72b3f9749e"] });
  expect(shouldNotify(byName, null, true, true, "lark-ad72b3f9749e")).toBe(true);
});
test("同一 human 自己发送时，name/handle 任一命中都不通知", () => {
  const own = base({
    mentions: ["lark-ad72b3f9749e"],
    sender: { name: "lark-ad72b3f9749e", kind: "human", handle: "leo" },
  });
  expect(shouldNotify(own, "leo", true, true, "lark-ad72b3f9749e")).toBe(false);
});
test("已撤回 / status / 自己发 → false", () => {
  expect(shouldNotify(base({retracted:true}), "leo", true, true)).toBe(false);
  expect(shouldNotify(base({kind:"status"}), "leo", true, true)).toBe(false);
  expect(shouldNotify(base({sender:{name:"leo",kind:"human",handle:"leo"}}), "leo", true, true)).toBe(false);
});

test("shouldToast: 被@ + 聚焦(!hidden) + optin → true", () => {
  expect(shouldToast(base(), "leo", false, true)).toBe(true);
});
test("shouldToast: 标签页隐藏 → false（那是系统通知的活）", () => {
  expect(shouldToast(base(), "leo", true, true)).toBe(false);
});
test("shouldToast: optin 关 → false", () => {
  expect(shouldToast(base(), "leo", false, false)).toBe(false);
});
test("shouldToast: 没@我 → false", () => {
  expect(shouldToast(base({mentions:["carol"]}), "leo", false, true)).toBe(false);
});
test("shouldToast: 我没 handle → false", () => {
  expect(shouldToast(base(), null, false, true)).toBe(false);
});
test("shouldToast: 已撤回 / status / 自己发 → false", () => {
  expect(shouldToast(base({retracted:true}), "leo", false, true)).toBe(false);
  expect(shouldToast(base({kind:"status"}), "leo", false, true)).toBe(false);
  expect(shouldToast(base({sender:{name:"leo",kind:"human",handle:"leo"}}), "leo", false, true)).toBe(false);
});

test("隐藏时命中自己的 @ 才累加角标", () => {
  expect(nextMentionBadgeCount(2, base(), "leo", true)).toBe(3);
  expect(nextMentionBadgeCount(2, base(), "leo", false)).toBe(2);
  expect(nextMentionBadgeCount(2, base({ mentions: ["carol"] }), "leo", true)).toBe(2);
  expect(nextMentionBadgeCount(2, base({ sender: { name: "leo", kind: "human", handle: "leo" } }), "leo", true)).toBe(2);
});

test("只有窗口可见且消息流贴底时才上报 seen", () => {
  expect(shouldMarkSeen(false, true)).toBe(true);
  expect(shouldMarkSeen(true, true)).toBe(false);
  expect(shouldMarkSeen(false, false)).toBe(false);
});

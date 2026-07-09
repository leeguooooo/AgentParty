import { test, expect } from "bun:test";
import { shouldNotify, shouldToast } from "./notify";
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

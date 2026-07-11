// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { ChannelStrings } from "./Channel";

// #150 / #168 / #171 分工面板重排 + 组织关系展示 + agent 规则入口新增的文案，
// 中英双语必须齐备，且中文不能等于英文（防止漏翻/占位英文糊弄过关）。
const DIVISION_KEYS = [
  "Channel.roles.channelLead",
  "Channel.roles.reportsTo",
  "Channel.roles.reportsToExternal",
  "Channel.roles.syncToCharter",
  "Channel.roles.syncingCharter",
  "Channel.roles.syncHeading",
  "Channel.roles.syncEmpty",
  "Channel.roles.openAgentRules",
] as const;

describe("Channel division/rules-cluster strings (#150 #168 #171)", () => {
  test("every key exists in both en and zh", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const key of DIVISION_KEYS) {
        expect(ChannelStrings[locale][key], `${locale} missing ${key}`).toBeTruthy();
      }
    }
  });

  test("zh diverges from en for every key (not left untranslated)", () => {
    for (const key of DIVISION_KEYS) {
      expect(ChannelStrings.zh[key]).not.toBe(ChannelStrings.en[key]);
    }
  });
});

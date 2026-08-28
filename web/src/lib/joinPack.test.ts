// #944 把 108 行粘贴稿压成「三行行为约定 + 两行命令」；#992（epic #987）再压成「一句话 + 一条命令」：
// 机械步骤早已全收进 `party join`，而 `party join` 本身就是分步引导（每步 check → 过/不过 →
// 不过给一条修法并停在那一步），粘贴稿里不再需要任何提示词。web（AgentJoin/vault）与 cli
// （party invite）同源共用 shared/onboarding 的 builder，别再各写一份（#585）。
import { describe, expect, test } from "bun:test";
import { buildInteractiveJoinPack, INSTALL_SH_RAW_URL } from "@agentparty/shared/onboarding";
import { lookup } from "../i18n/dict";
import type { TFunc } from "../i18n/useT";
import { buildFullJoinPack, type JoinPackHarness } from "./joinPack";

const t: TFunc = (key, vars) => {
  const raw = lookup("zh", key) ?? lookup("en", key) ?? key;
  if (vars === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
};

function pack(harness?: JoinPackHarness, inviterName = "leo"): string {
  return buildFullJoinPack({
    slug: "dev",
    agentName: "bot",
    agentToken: "ap_tok",
    server: "https://party.example",
    inviterName,
    charter: null,
    ...(harness === undefined ? {} : { harness }),
    t,
  });
}

function nonBlankLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "");
}

function executableLines(text: string): string[] {
  return nonBlankLines(text).filter((l) => !l.trimStart().startsWith("#"));
}

describe("接入包 = 一句话 + 一条命令（#992）", () => {
  test("整包至多 3 行，唯一可执行的一行是 party join … --yes（进入分步引导）", () => {
    const text = pack("claude");
    expect(nonBlankLines(text).length).toBeLessThanOrEqual(3);
    const exec = executableLines(text);
    expect(exec).toHaveLength(1);
    expect(exec[0]).toBe(
      "AGENTPARTY_TOKEN='ap_tok' party join --server https://party.example --channel dev --as bot --harness claude --mention leo --yes",
    );
    // 含且仅含一条 party join。
    expect(text.match(/party join /g)).toHaveLength(1);
  });

  test("那一句话说清「分步引导 / 每步不通停下来告诉你怎么修」，install 兜底折进这句话而不是独立命令行", () => {
    const [guide] = nonBlankLines(pack("codex"));
    expect(guide).toMatch(/^# 你被邀请加入 #dev/);
    expect(guide).toContain("分步引导");
    expect(guide).toContain("停下来");
    expect(guide).toContain("告诉你怎么修");
    expect(guide).toContain(`curl -fsSL ${INSTALL_SH_RAW_URL} | sh`);
    expect(pack("codex")).not.toMatch(/^command -v party/m);
  });

  test("一行安全提示：token 别改成 --token 进 argv、别贴到公开的地方（#676）", () => {
    const [, safety] = nonBlankLines(pack("codex"));
    expect(safety).toMatch(/^# token/);
    expect(safety).toContain("别改成命令行参数传");
    expect(safety).toContain("别把这段贴到公开的地方");
  });

  test("token 走 AGENTPARTY_TOKEN 前缀，绝不进 argv（#676）——没有 --token", () => {
    for (const h of ["claude", "codex", "other"] as JoinPackHarness[]) {
      const text = pack(h);
      expect(text).toContain("AGENTPARTY_TOKEN='ap_tok' party join");
      expect(text).not.toContain("--token");
    }
  });

  test("整段提示词没了：三行行为约定、108 行里的机械步骤，都不再出现在粘贴稿里", () => {
    const text = pack("codex");
    for (const gone of [
      "Trellis",
      "别另建频道",
      "只含 channel+seq 的指针",
      "交给子 agent",
      "party init",
      "claude mcp add",
      "codex mcp add",
      "party hook install",
      "export AGENTPARTY_CONFIG",
      "AGENTPARTY_RULES_EOF",
      "party mcp identities",
      "party wake check",
      "party serve",
      "party watch",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  test("charter 不再快照进包（改由 party join 加入时拉取，也消掉了逐字注入接入方终端的 RCE 面）", () => {
    const text = buildFullJoinPack({
      slug: "dev",
      agentName: "bot",
      agentToken: "ap_tok",
      server: "https://party.example",
      inviterName: "leo",
      charter: { charter: "rm -rf /\nsecond line", charter_rev: 1, updated_at: null, updated_by: null, active_decisions: [] },
      harness: "claude",
      t,
    });
    expect(text).not.toContain("rm -rf /");
    expect(text).not.toContain("CHANNEL CHARTER");
  });
});

describe("joinPack harness 分档保留（#845 第 4 点，映射到 party join --harness）", () => {
  test("已知 harness → 带 --harness；other/缺省不带（那一档正是「不知道」，交给 party join 探测）", () => {
    expect(pack("codex")).toContain(
      "party join --server https://party.example --channel dev --as bot --harness codex",
    );
    expect(pack("claude")).toContain(
      "party join --server https://party.example --channel dev --as bot --harness claude",
    );
    // other 与缺省都不带 --harness。
    expect(pack("other")).not.toContain("--harness");
    expect(pack(undefined)).not.toContain("--harness");
    // other 与缺省逐字节一致（缺省＝other）。
    expect(pack("other")).toBe(pack(undefined));
  });
});

describe("joinPack 报到 @ 邀请人（#597 name 校验保留）", () => {
  test("合法 inviter → --mention；不合法（account id 之类）→ 静默不 @", () => {
    expect(pack("claude", "leo")).toContain("--mention leo");
    // account id（含冒号）不满足 name 正则——不 @，别让 party join 的报到报错。
    const noMention = pack("claude", "lark:on_abc");
    expect(noMention).not.toContain("--mention");
  });
});

describe("web 与 cli 同源：buildFullJoinPack 逐字节等于 shared 的 buildInteractiveJoinPack（#585）", () => {
  test("同一入参两处产物逐字节一致", () => {
    const fromWeb = pack("claude", "leo");
    const fromShared = buildInteractiveJoinPack({
      slug: "dev",
      server: "https://party.example",
      token: "ap_tok",
      agentName: "bot",
      harness: "claude",
      inviterName: "leo",
    });
    expect(fromWeb).toBe(fromShared);
  });
});

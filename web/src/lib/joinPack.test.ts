// #944：接入包从 108 行粘贴稿压成「一小段行为约定（3 行注释）+ 两行命令」（install + party join）。
// 那 108 行里逐条手工执行的机械步骤（写 config/rules、判重、绑定、注册 MCP、装+批准 hook、报到、
// 自检）全部收进 `party join` 这一条命令。web（AgentJoin/vault）与 cli（party invite）同源共用
// shared/onboarding 的 builder，别再各写一份（#585）。
import { describe, expect, test } from "bun:test";
import { buildInteractiveJoinPack } from "@agentparty/shared/onboarding";
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

function executableLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
}

describe("接入包 = 一段行为约定 + 两行命令（#944）", () => {
  test("整包只有两条可执行命令：install（缺失才装）+ party join", () => {
    const exec = executableLines(pack("claude"));
    expect(exec).toHaveLength(2);
    expect(exec[0]).toBe(
      "command -v party >/dev/null || curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh",
    );
    expect(exec[1]!.startsWith("AGENTPARTY_TOKEN='ap_tok' party join ")).toBe(true);
  });

  test("token 走 AGENTPARTY_TOKEN 前缀，绝不进 argv（#676）——没有 --token", () => {
    for (const h of ["claude", "codex", "other"] as JoinPackHarness[]) {
      const text = pack(h);
      expect(text).toContain("AGENTPARTY_TOKEN='ap_tok' party join");
      expect(text).not.toContain("--token");
    }
  });

  test("108 行里逐条手工执行的机械步骤全部收进 party join——粘贴稿里不再出现它们", () => {
    const text = pack("codex");
    for (const gone of [
      "party init --server",
      "claude mcp add",
      "codex mcp add",
      "party hook install",
      "export AGENTPARTY_CONFIG",
      "AGENTPARTY_RULES_EOF", // rules 落盘 heredoc 移进 party join
      "party mcp identities", // 判重移进 party join（init 内做）
      "party wake check", // 自检移进 party join
      "party serve",
      "party watch",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  test("行为约定砍到三行——每行都对应一类真实会做错的事，且都是注释（不带 # 的只有两条命令）", () => {
    const text = pack("claude");
    const commentLines = text.split("\n").filter((l) => l.trimStart().startsWith("#"));
    expect(commentLines).toHaveLength(3);
    // 1) 别跑偏去自建频道 / 用第三方频道流程（Trellis）。
    expect(text).toContain("别另建频道");
    expect(text).toContain("Trellis");
    // 2) 指针不含正文、频道是唯一数据源。
    expect(text).toContain("只含 channel+seq 的指针");
    expect(text).toContain("频道是唯一数据源");
    // 3) 改动交给子 agent。
    expect(text).toContain("交给子 agent");
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

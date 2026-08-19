// #845 层 2：接入包把行为契约落盘成 rules 文件——heredoc 全静态、delimiter 带引号防变量展开，
// 包尾带「上下文丢失后先重读」指引。契约正文与 cli 层同源（shared 常量），此处只验落盘段形状。
import { describe, expect, test } from "bun:test";
import { BEHAVIOR_CONTRACT_BODY_LINES } from "@agentparty/shared/onboarding";
import { lookup } from "../i18n/dict";
import type { TFunc } from "../i18n/useT";
import { buildFullJoinPack } from "./joinPack";

const t: TFunc = (key, vars) => {
  const raw = lookup("zh", key) ?? lookup("en", key) ?? key;
  if (vars === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
};

function pack(): string {
  return buildFullJoinPack({
    slug: "dev",
    agentName: "bot",
    agentToken: "ap_tok",
    server: "https://party.example",
    inviterName: "leo",
    charter: null,
    t,
  });
}

describe("joinPack 行为契约落盘（#845）", () => {
  test("含 rules 落盘 heredoc 段，delimiter 带引号防变量展开", () => {
    const text = pack();
    expect(text).toContain(
      `cat > "$HOME/.agentparty/agents/agentparty-bot-dev.rules.md" <<'AGENTPARTY_RULES_EOF'`,
    );
    // heredoc 完整闭合，正文逐行在包内
    const lines = text.split("\n");
    const open = lines.findIndex((l) => l.includes("<<'AGENTPARTY_RULES_EOF'"));
    const close = lines.indexOf("AGENTPARTY_RULES_EOF", open + 1);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(lines.slice(open + 1, close)).toEqual([...BEHAVIOR_CONTRACT_BODY_LINES]);
  });

  test("heredoc 正文全静态：不含 token/charter 等动态输入", () => {
    const text = pack();
    const lines = text.split("\n");
    const open = lines.findIndex((l) => l.includes("<<'AGENTPARTY_RULES_EOF'"));
    const close = lines.indexOf("AGENTPARTY_RULES_EOF", open + 1);
    const body = lines.slice(open + 1, close).join("\n");
    expect(body).not.toContain("ap_tok");
    expect(body).not.toContain("$");
  });

  test("包尾带「上下文丢失后先重读 rules 文件」指引", () => {
    const text = pack();
    const tail = text.split("\n").at(-1) ?? "";
    expect(tail.startsWith("#")).toBe(true);
    expect(tail).toContain("agentparty-bot-dev.rules.md");
  });
});

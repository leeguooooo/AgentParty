// #845 层 2：接入包把行为契约落盘成 rules 文件——heredoc 全静态、delimiter 带引号防变量展开，
// 包尾带「上下文丢失后先重读」指引。契约正文与 cli 层同源（shared 常量），此处只验落盘段形状。
import { describe, expect, test } from "bun:test";
import { BEHAVIOR_CONTRACT_BODY_LINES } from "@agentparty/shared/onboarding";
import { lookup } from "../i18n/dict";
import type { TFunc } from "../i18n/useT";
import { buildFullJoinPack, type JoinPackHarness } from "./joinPack";

const t: TFunc = (key, vars) => {
  const raw = lookup("zh", key) ?? lookup("en", key) ?? key;
  if (vars === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
};

function pack(harness?: JoinPackHarness): string {
  return buildFullJoinPack({
    slug: "dev",
    agentName: "bot",
    agentToken: "ap_tok",
    server: "https://party.example",
    inviterName: "leo",
    charter: null,
    ...(harness === undefined ? {} : { harness }),
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

// #845 第 4 点：interactive 包按目标 harness 拆分——目标 agent 只走一条分支，其余是噪音。
describe("joinPack 按 harness 拆分（#845 第 4 点）", () => {
  // claude mcp add 命令行 / claudeMode 指引 / claude -p 唤醒模板的指纹
  const CLAUDE_MCP_ADD = "claude mcp add ";
  const CLAUDE_WAKE = `claude -p -c "$(cat {file})"`;
  const CLAUDE_MODE_FP = "watch --once";
  // codex mcp add 指引 / codex exec 唤醒模板 / serve supervisor（otherMode）的指纹
  const CODEX_MCP_ADD = "codex mcp add ";
  const CODEX_WAKE = "codex exec resume --last";
  const OTHER_MODE_FP = "party serve dev --on-mention";

  test("other 档（含缺省不传）与旧全量逐字节一致", () => {
    expect(pack("other")).toBe(pack());
    const full = pack("other");
    for (const fp of [CLAUDE_MCP_ADD, CLAUDE_WAKE, CLAUDE_MODE_FP, CODEX_MCP_ADD, CODEX_WAKE, OTHER_MODE_FP]) {
      expect(full).toContain(fp);
    }
  });

  test("claude 档：保留 claude mcp add + claudeMode + Claude 唤醒模板，无 codex 行", () => {
    const text = pack("claude");
    expect(text).toContain(CLAUDE_MCP_ADD);
    expect(text).toContain(CLAUDE_MODE_FP);
    expect(text).toContain(CLAUDE_WAKE);
    expect(text).not.toContain(CODEX_MCP_ADD);
    expect(text).not.toContain(CODEX_WAKE);
    // otherMode 四行（serve supervisor 指引）也去掉
    expect(text).not.toContain(OTHER_MODE_FP);
  });

  // #848：插件段是 claude 档专属新增（#847 之后），two 行命令 + 失败不阻断标记。
  const PLUGIN_MARKETPLACE = "claude plugin marketplace add leeguooooo/AgentParty || true";
  const PLUGIN_INSTALL = "claude plugin install agentparty@agentparty || true";
  const PLUGIN_ENABLE = "claude plugin enable agentparty@agentparty || true";

  test("claude 档：含 marketplace 插件命令（add/install/enable），且带 || true 失败不阻断（#848）", () => {
    const text = pack("claude");
    expect(text).toContain(PLUGIN_MARKETPLACE);
    expect(text).toContain(PLUGIN_INSTALL);
    expect(text).toContain(PLUGIN_ENABLE);
  });

  test("codex/other 档：不含 claude 插件命令（claude 插件段是 Claude Code 专属，#848）", () => {
    for (const harness of ["codex", "other"] as const) {
      const text = pack(harness);
      expect(text).not.toContain("claude plugin marketplace add");
      expect(text).not.toContain("claude plugin install");
      expect(text).not.toContain("claude plugin enable");
    }
  });

  // #844：claude 档补 crossSessionInbound=accept——不改则默认 hold，消息进待审队列且
  // 5 分钟无人处理会被 drop。必须幂等、失败不阻断、写前备份、不硬依赖 jq。
  test("claude 档：含 crossSessionInbound=accept 配置行，备份 + jq/node/python3 三级兜底 + 失败不阻断（#844）", () => {
    const text = pack("claude");
    expect(text).toContain(`AGENTPARTY_CC_SETTINGS="$HOME/.claude/settings.json"`);
    expect(text).toContain("crossSessionInbound");
    expect(text).toContain("accept");
    // 写前备份
    // 备份首次写入即定：重跑接入包不能把备份覆盖成已改过的版本
    expect(text).toContain(
      `[ -f "$AGENTPARTY_CC_SETTINGS.agentparty.bak" ] || cp "$AGENTPARTY_CC_SETTINGS" "$AGENTPARTY_CC_SETTINGS.agentparty.bak" || true`,
    );
    // 不硬依赖 jq：三级兜底都在
    expect(text).toContain("command -v jq");
    expect(text).toContain("command -v node");
    expect(text).toContain("command -v python3");
    // 失败不阻断：每条写入分支都带 || true
    expect(text).toContain("|| true");
    // 边界说明（接收端设置 / repo 只能收紧 / 默认 hold 5 分钟被 drop）必须在注释里说清
    expect(text).toContain("--setting-sources");
    expect(text).toContain("hold");
  });

  test("codex/other 档：不含 crossSessionInbound 配置（Claude Code 专属设置，#844）", () => {
    for (const harness of ["codex", "other"] as const) {
      const text = pack(harness);
      expect(text).not.toContain("crossSessionInbound");
      expect(text).not.toContain("AGENTPARTY_CC_SETTINGS");
    }
  });

  // #850：codex 档补装 codex 插件——与 #848 的 claude 档对等，两行命令 + || true 失败不阻断。
  const CODEX_PLUGIN_MARKETPLACE = "codex plugin marketplace add leeguooooo/AgentParty || true";
  const CODEX_PLUGIN_ADD = "codex plugin add agentparty@agentparty || true";

  test("codex 档：含 codex 插件命令（marketplace add + add），且带 || true 失败不阻断（#850）", () => {
    const text = pack("codex");
    expect(text).toContain(CODEX_PLUGIN_MARKETPLACE);
    expect(text).toContain(CODEX_PLUGIN_ADD);
  });

  test("claude/other 档：不含 codex 插件命令（#850）", () => {
    for (const harness of ["claude", "other"] as const) {
      const text = pack(harness);
      expect(text).not.toContain("codex plugin");
    }
  });

  test("codex 档：保留 codex mcp add + Codex 唤醒模板 + serve 指引，无 claude 行", () => {
    const text = pack("codex");
    expect(text).toContain(CODEX_MCP_ADD);
    expect(text).toContain(CODEX_WAKE);
    expect(text).toContain(OTHER_MODE_FP);
    expect(text).not.toContain(CLAUDE_MCP_ADD);
    expect(text).not.toContain(CLAUDE_WAKE);
    expect(text).not.toContain(CLAUDE_MODE_FP);
  });

  test("安全硬行三档全在：PATH 先于版本闸 / token 环境变量 / rules.md 落盘 / turnWarn / episodic / 礼仪", () => {
    for (const harness of ["claude", "codex", "other"] as const) {
      const text = pack(harness);
      const lines = text.split("\n");
      // PATH 行必须先于版本闸行（版本闸被绕过的坑见 joinPack 注释）
      const pathIdx = lines.findIndex((l) => l.startsWith(`export PATH=`));
      const gateIdx = lines.findIndex((l) => l.startsWith("need="));
      expect(pathIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeGreaterThan(pathIdx);
      // token 走环境变量不进 argv（#676）
      expect(text).toContain("AGENTPARTY_TOKEN='ap_tok' party init");
      // rules.md 落盘段完整（#845 层 2）
      expect(text).toContain("<<'AGENTPARTY_RULES_EOF'");
      expect(lines.indexOf("AGENTPARTY_RULES_EOF")).toBeGreaterThan(-1);
      // harness 无关的行为约束行都在
      expect(text).toContain("AGENTPARTY_CONFIG");
      for (const key of [
        "AgentJoin.cmd.turnWarn1",
        "AgentJoin.cmd.episodic1",
        "AgentJoin.cmd.etiquette",
        "AgentJoin.cmd.stayReachable",
        "AgentJoin.cmd.contextAnchor3",
        "AgentJoin.cmd.sandboxWarn1",
      ]) {
        expect(text).toContain(t(key, { slug: "dev", agentName: "bot" }));
      }
    }
  });

  test("charter 快照注释化在三档全保留（管理员可控文本绝不落成可执行行）", () => {
    for (const harness of ["claude", "codex", "other"] as const) {
      const text = buildFullJoinPack({
        slug: "dev",
        agentName: "bot",
        agentToken: "ap_tok",
        server: "https://party.example",
        inviterName: "leo",
        charter: { charter: "rm -rf /\nsecond line", charter_rev: 1, updated_at: null, updated_by: null, active_decisions: [] },
        harness,
        t,
      });
      expect(text).toContain("# rm -rf /");
      expect(text).not.toMatch(/^rm -rf \//m);
    }
  });
});

// #879：codex 会话没有 Claude 那样的默认 per-session socket 收件箱——装插件也叫不醒。接入包的
// codex 档必须把「必须挂 bridge 或 serve 才可达」写死，否则接进来的 codex 身份只会长期 unreachable。
describe("joinPack codex 档唤醒层说明（#879）", () => {
  const CODEX_BRIDGE = "party bridge codex dev";
  const CODEX_SERVE_RUNNER = "party serve dev --runner codex";

  test("codex 档：明确写出 bridge / serve --runner codex 两条唤醒层，并点明装插件不解决唤醒", () => {
    const text = pack("codex");
    expect(text).toContain(CODEX_BRIDGE);
    expect(text).toContain(CODEX_SERVE_RUNNER);
    expect(text).toContain("per-session");
    expect(text).toContain("#879");
  });

  test("claude/other 档不加这两条（各走各的唤醒层，别塞噪音）", () => {
    for (const harness of ["claude", "other"] as const) {
      const text = pack(harness);
      expect(text).not.toContain(CODEX_BRIDGE);
      expect(text).not.toContain(CODEX_SERVE_RUNNER);
    }
  });
});

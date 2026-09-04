// #1073：引导输出的着色与篇幅（第 1、2 点）。
import { describe, expect, test } from "bun:test";
import { colorEnabled, styleFor } from "../src/onboarding/color";
import { formatStep, formatStepLine } from "../src/onboarding/steps";

const ESC = "\x1b";

describe("着色开关", () => {
  test("NO_COLOR 一票否决，哪怕在 TTY 上、哪怕同时设了 FORCE_COLOR", () => {
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });

  test("FORCE_COLOR 能在非 TTY（管道 / CI）上开色，FORCE_COLOR=0 不算开", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, false)).toBe(false);
  });

  test("缺省跟着 TTY 走；TERM=dumb 不上色", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false);
  });
});

describe("着色只碰本地生成的结构元素", () => {
  const style = styleFor(true);
  // 摘要里可能带服务端可控文本（身份、频道名、错误消息）。给它套色码＝把 reset 序列的控制权交给
  // 远端：正文里一个 ESC[0m 就能提前收色、后面的伪造文本继承我们的样式。所以摘要一律不着色。
  test("摘要原样，不被色码包住", () => {
    const summary = `#dev 上以 evil${ESC}[0m 报到`;
    const line = formatStepLine(1, "身份", { ok: true, summary }, style);
    expect(line).toContain(summary);
    expect(line).not.toContain(`${ESC}[32m#dev`);
  });

  test("✓ 绿、✗ 红、修法命令上色", () => {
    expect(formatStepLine(1, "身份", { ok: true, summary: "s" }, style)).toContain(`${ESC}[32m✓${ESC}[0m`);
    const failed = formatStep(3, "会话", { ok: false, summary: "s", fix: { do: "party claude dev" } }, "party join", { style });
    expect(failed[0]).toContain(`${ESC}[31m✗${ESC}[0m`);
    expect(failed.at(-1)).toContain(`${ESC}[36mparty claude dev${ESC}[0m`);
  });

  test("不给 style ⇒ 一个色码都没有（管道、测试、贴日志给人看）", () => {
    const lines = formatStep(3, "会话", { ok: false, summary: "s", fix: { do: "party claude dev" } }, "party join");
    expect(lines.join("\n")).not.toContain(ESC);
  });
});

describe("过了的步骤只印异常子项（#1073 收篇幅）", () => {
  const result = {
    ok: true,
    summary: "报到成功",
    detail: ["✓ 注册 claude MCP: 已加", "· 装 codex 插件: 跳过", "! 行为契约落盘: 写失败", "无 TTY：按默认选了交互式会话"],
  };

  test("缺省吞掉 ✓ / · 流水账，保留 ! 与自由文本", () => {
    const out = formatStep(1, "身份", result, "party join").join("\n");
    expect(out).not.toContain("注册 claude MCP");
    expect(out).not.toContain("装 codex 插件");
    expect(out).toContain("行为契约落盘: 写失败");
    expect(out).toContain("无 TTY：按默认选了交互式会话");
  });

  test("--verbose 全印回来", () => {
    const lines = formatStep(1, "身份", result, "party join", { verbose: true });
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).toContain("注册 claude MCP");
  });

  test("没过的步骤永远全印——那时每一行都是线索", () => {
    const out = formatStep(1, "身份", { ...result, ok: false, fix: { do: "party join" } }, "party join").join("\n");
    expect(out).toContain("注册 claude MCP");
    expect(out).toContain("装 codex 插件");
  });
});

// #1073 第 2 点的另一半：join 装完 codex hook 后，第 2 步会用同一份唤醒清单判过/不过并给恰一条
// 修法。hook install 自己再把整份清单印一遍＝同一段修复说明连印两遍。join 因此传 --brief。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as hookRun } from "../src/commands/hook";

describe("party hook install --brief（给 join 用）", () => {
  test("brief 压掉解说与清单重播，但保留「装到哪个文件」这一行", async () => {
    // hook install 写的是 **cwd** 下的 .claude/settings.local.json——不隔离就会往仓库工作树里落文件。
    const cwd = process.cwd();
    const sandbox = mkdtempSync(join(tmpdir(), "ap-hook-brief-"));
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      process.chdir(sandbox);
      await hookRun(["install", "--claude", "--brief"]);
    } finally {
      console.log = real;
      process.chdir(cwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
    const out = lines.join("\n");
    expect(out).toContain("hooks installed -> ");
    expect(out).not.toContain("普通 Claude session 只写本地 activity");
  });
});

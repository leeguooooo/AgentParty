// 接入包写 ~/.claude/settings.json 那段 shell 的**执行级**测试。
//
// 为什么必须真跑 shell：joinPack.test.ts 里的 `toContain("crossSessionInbound")` 之类断言，
// 会被中英文 i18n 注释文案独自满足——把三个写入分支整段删掉，那些断言照样全绿。
// 于是「node 分支解析失败会把用户整份 settings.json 覆盖掉」这种数据销毁，
// 在设计上就不可能被看见。这里在 fake HOME + 受控 PATH 下实际执行生成的片段。
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "../i18n/dict";
import type { TFunc } from "../i18n/useT";
import { buildJoinPack } from "./joinPack";

const t: TFunc = (key, vars) => {
  const raw = lookup("zh", key) ?? lookup("en", key) ?? key;
  if (vars === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
};

/** 从完整接入包里切出设置 crossSessionInbound 的那段 shell（含备份与三分支）。 */
function settingsShell(): string {
  const pack = buildJoinPack("interactive", {
    slug: "demo",
    agentName: "tester",
    agentToken: "tok",
    server: "https://example.invalid",
    inviterName: "inviter",
    charter: null,
    harness: "claude",
    t,
  });
  const lines = pack.split("\n");
  const start = lines.findIndex((l) => l.includes("AGENTPARTY_CC_SETTINGS="));
  const end = lines.findIndex((l, i) => i > start && l.trim() === "fi");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // 只保留可执行行（去掉 # 注释），避免注释里的字样干扰。
  return lines
    .slice(start, end + 1)
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

// shell 片段本身需要的基础命令。PATH 只暴露它们 + 被测工具，
// 这样「无可用工具」才是真隔离：Linux CI 上 /bin 常软链到 /usr/bin（自带 python3），
// 把 /bin 放进 PATH 会让隔离失效——本地 macOS 通过、CI 失败就是这么来的。
const BASE_TOOLS = ["mkdir", "cp", "rm", "mv", "cat"] as const;

/** 只让指定工具在 PATH 中可见，用来单独驱动 jq / node / python3 三个分支。 */
function runWithTools(settingsContent: string | null, tools: string[]): {
  home: string;
  settingsPath: string;
  after: string | null;
  leftovers: string[];
} {
  const home = mkdtempSync(join(tmpdir(), "ap-settings-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const tool of [...BASE_TOOLS, ...tools]) {
    const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (real !== "" && !existsSync(join(bin, tool))) symlinkSync(real, join(bin, tool));
  }
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settingsPath = join(home, ".claude", "settings.json");
  if (settingsContent !== null) writeFileSync(settingsPath, settingsContent);

  // 必须用绝对路径起 shell：PATH 被收窄成只有 bin 之后，Node 会用同一个 PATH 去找
  // "sh" 本身而找不到，进程根本不启动——那样「损坏输入原文不变」会变成假阳性
  // （什么都没执行，文件当然没变）。起不来直接抛，不让测试静默失效。
  const run = spawnSync("/bin/sh", ["-c", settingsShell()], {
    env: { HOME: home, PATH: bin },
    encoding: "utf8",
  });
  if (run.error !== undefined) throw run.error;

  try {
    return {
      home,
      settingsPath,
      after: existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null,
      leftovers: readdirSync(join(home, ".claude")).filter((f) => f.includes(".tmp")),
    };
  } finally {
    // 每个用例都建一个 fake HOME，不清理会堆成 GB 级垃圾（本机实测把盘写满过）。
    rmSync(home, { recursive: true, force: true });
  }
}

const BROKEN = '{"model":"opus","permissions":{"allow":["Bash"]}';
const VALID = JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] } }, null, 2);

for (const tool of ["jq", "node", "python3"] as const) {
  const available = spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
  const maybe = available ? describe : describe.skip;

  maybe(`settings 写入分支：${tool}`, () => {
    it("合法配置：写入 accept 且不动其他键", () => {
      const { after } = runWithTools(VALID, [tool]);
      const parsed = JSON.parse(after ?? "{}");
      expect(parsed.crossSessionInbound).toBe("accept");
      // 用户既有设置必须原样保留。
      expect(parsed.model).toBe("opus");
      expect(parsed.permissions).toEqual({ allow: ["Bash"] });
    });

    it("损坏配置：保持原文不动，绝不覆盖用户数据", () => {
      const { after } = runWithTools(BROKEN, [tool]);
      // 这是本文件存在的理由：node 分支曾在解析失败时把整份配置写成
      // {"crossSessionInbound":"accept"}，用户的 model/permissions 全部消失。
      expect(after).toBe(BROKEN);
    });

    it("文件不存在：初始化后写入 accept", () => {
      const { after } = runWithTools(null, [tool]);
      expect(JSON.parse(after ?? "{}").crossSessionInbound).toBe("accept");
    });

    it("空文件：不崩坏——要么留空要么是合法 JSON", () => {
      const { after } = runWithTools("", [tool]);
      if ((after ?? "").trim() !== "") expect(() => JSON.parse(after ?? "")).not.toThrow();
    });

    it("不留 .tmp 残留（成功与失败两种输入）", () => {
      expect(runWithTools(VALID, [tool]).leftovers).toEqual([]);
      expect(runWithTools(BROKEN, [tool]).leftovers).toEqual([]);
    });
  });
}

describe("settings 写入分支：无可用工具", () => {
  it("整步跳过，不创建也不破坏配置", () => {
    const { after } = runWithTools(VALID, []);
    expect(after).toBe(VALID);
  });
});

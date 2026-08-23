// #924：加入即绑定。本文件钉的是**替换语义的边界**与**守卫本身**。
//
// 为什么守卫要单独钉（#884）：替换是删除性语义——判据松一格就会把用户刻意并存的另一个身份
// 顶掉，而那个身份的会话此后再也叫不醒，且完全无声。所以「什么情况下**不**替换」比
// 「什么情况下替换」更需要用例。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOIN_BINDINGS_CAPACITY,
  applyJoinBinding,
  detectHarnessFromAncestry,
  findJoinBindings,
  harnessFromCommand,
  isBindingHarness,
  joinBindingKey,
  joinBindingsPath,
  readJoinBindings,
  writeJoinBinding,
  type JoinBinding,
} from "../src/join-binding";

const BASE: JoinBinding = {
  harness: "codex",
  server: "https://agentparty.pwtk-dev.work",
  channel: "agentparty",
  owner: "lark:on_owner",
  identity: "codex-a",
  config_path: "/tmp/a.json",
  cwd: "/repo",
  created_at: 1_000,
};

function binding(overrides: Partial<JoinBinding> = {}): JoinBinding {
  return { ...BASE, ...overrides };
}

describe("替换键：四段全同才是同一条绑定", () => {
  test("末尾斜杠不影响 server 的比较", () => {
    expect(joinBindingKey(binding({ server: "https://x/" }))).toBe(joinBindingKey(binding({ server: "https://x" })));
  });

  test("四段里任意一段不同 → 不同键（＝并存，不替换）", () => {
    const base = joinBindingKey(BASE);
    expect(joinBindingKey(binding({ harness: "claude" }))).not.toBe(base);
    // #865：本机两台生产实例都有同名频道，少了 server 维度会把它们混成一组。
    expect(joinBindingKey(binding({ server: "https://agentparty.leeguoo.com" }))).not.toBe(base);
    expect(joinBindingKey(binding({ channel: "other" }))).not.toBe(base);
    expect(joinBindingKey(binding({ owner: "lark:on_someone_else" }))).not.toBe(base);
    // owner 缺失（老配置）自成一组，绝不与有 owner 的混判。
    expect(joinBindingKey(binding({ owner: null }))).not.toBe(base);
  });
});

describe("applyJoinBinding：后加入替换先加入，但只在同键内", () => {
  test("同键不同身份 → 替换，且替换掉谁必须报出来", () => {
    const result = applyJoinBinding([binding()], binding({ identity: "codex-b", config_path: "/tmp/b.json" }));
    expect(result.replaced.map((r) => r.identity)).toEqual(["codex-a"]);
    expect(result.bindings.map((r) => r.identity)).toEqual(["codex-b"]);
  });

  test("同键同身份重跑接入包 → 不算替换，只刷新（不该吓唬用户）", () => {
    const result = applyJoinBinding([binding()], binding({ created_at: 2_000 }));
    expect(result.replaced).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]!.created_at).toBe(2_000);
  });

  test("不同 harness / 不同实例 / 不同 owner 的身份一律留着——刻意并存不许误伤", () => {
    const existing = [
      binding({ harness: "claude", identity: "claude-a", config_path: "/tmp/c.json" }),
      binding({ server: "https://agentparty.leeguoo.com", identity: "other-instance", config_path: "/tmp/d.json" }),
      binding({ owner: "lark:on_someone_else", identity: "someone-else", config_path: "/tmp/e.json" }),
      binding({ channel: "dev", identity: "dev-side", config_path: "/tmp/f.json" }),
    ];
    const result = applyJoinBinding(existing, binding({ identity: "codex-b", config_path: "/tmp/b.json" }));
    expect(result.replaced).toEqual([]);
    expect(result.bindings).toHaveLength(existing.length + 1);
  });

  test("--coexist：同键不同身份也一起留着（不同角色的刻意并存）", () => {
    const result = applyJoinBinding(
      [binding()],
      binding({ identity: "codex-b", config_path: "/tmp/b.json" }),
      { replace: false },
    );
    expect(result.replaced).toEqual([]);
    expect(result.bindings.map((r) => r.identity).sort()).toEqual(["codex-a", "codex-b"]);
  });

  test("有界：超容量丢最旧的", () => {
    const many = Array.from({ length: JOIN_BINDINGS_CAPACITY + 5 }, (_, i) =>
      binding({ channel: `c${String(i)}`, identity: `id-${String(i)}` }));
    const result = applyJoinBinding(many, binding({ channel: "fresh", identity: "fresh" }));
    expect(result.bindings).toHaveLength(JOIN_BINDINGS_CAPACITY);
    expect(result.bindings.at(-1)!.identity).toBe("fresh");
  });
});

describe("落盘与读回", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-924-bind-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("写→读往返，替换结果落盘可见", () => {
    const path = joinBindingsPath(home);
    expect(readJoinBindings(path)).toEqual([]);
    expect(writeJoinBinding(path, binding())).toEqual([]);
    const replaced = writeJoinBinding(path, binding({ identity: "codex-b", config_path: "/tmp/b.json" }));
    expect(replaced.map((r) => r.identity)).toEqual(["codex-a"]);
    expect(readJoinBindings(path).map((r) => r.identity)).toEqual(["codex-b"]);
  });

  test("文件坏了 / 形状不对 → 当没有绑定，绝不抛（绑定不许成为新的单点故障）", () => {
    const path = joinBindingsPath(home);
    for (const bad of ["{ not json", "[]", "null", '{"bindings":"x"}', '{"bindings":[{"harness":"nope"}]}']) {
      writeFileSync(path, bad);
      expect(readJoinBindings(path)).toEqual([]);
    }
  });

  test("findJoinBindings 只按 harness+channel 收窄，最近加入的排前面", () => {
    const rows = [
      binding({ identity: "old", created_at: 1 }),
      binding({ identity: "new", created_at: 9 }),
      binding({ harness: "claude", identity: "claude-side" }),
      binding({ channel: "dev", identity: "dev-side" }),
    ];
    expect(findJoinBindings(rows, { harness: "codex", channel: "agentparty" }).map((r) => r.identity))
      .toEqual(["new", "old"]);
  });
});

describe("harness 探测：只看可执行文件本体（守卫本身的变异，#884）", () => {
  test("认得出终端 codex 与桌面 codex（本机实测路径）", () => {
    expect(harnessFromCommand("/opt/homebrew/bin/codex")).toBe("codex");
    expect(harnessFromCommand("/Applications/ChatGPT.app/Contents/Resources/codex --foo")).toBe("codex");
    expect(harnessFromCommand("codex-app-server")).toBe("codex");
    expect(harnessFromCommand("/Users/x/.local/bin/claude -p hi")).toBe("claude");
  });

  test("命令行里出现 codex/claude 字样的无关进程一律不认——判据松一格就会把绑定记到别人头上", () => {
    expect(harnessFromCommand("vim codex-notes.md")).toBe(null);
    expect(harnessFromCommand("git commit -m claude")).toBe(null);
    expect(harnessFromCommand("node /opt/x/codex/index.js")).toBe(null);
    expect(harnessFromCommand("rg codex")).toBe(null);
    expect(harnessFromCommand("")).toBe(null);
    expect(harnessFromCommand("   ")).toBe(null);
  });

  test("祖先链往上走能找到 harness；找不到就是 null（不知道，不猜）", () => {
    const table = [
      "  100     1 /sbin/launchd",
      "  200   100 /Applications/ChatGPT.app/Contents/Resources/codex",
      "  300   200 /bin/bash -lc party init",
      "  400   300 party init --channel agentparty",
    ].join("\n");
    const spawn = ((_cmd: string, _args: string[]) => ({ status: 0, stdout: table })) as never;
    expect(detectHarnessFromAncestry(400, spawn)).toBe("codex");
    // 链上没有 harness ⇒ null，绝不回落到「大概是 codex 吧」。
    const noHarness = ["  100     1 /sbin/launchd", "  400   100 party init"].join("\n");
    const spawn2 = ((_cmd: string, _args: string[]) => ({ status: 0, stdout: noHarness })) as never;
    expect(detectHarnessFromAncestry(400, spawn2)).toBe(null);
    // ps 挂了 ⇒ null。
    const spawn3 = (() => {
      throw new Error("no ps");
    }) as never;
    expect(detectHarnessFromAncestry(400, spawn3)).toBe(null);
    // 环形/自指的父子关系不能把探测卡死。
    const loop = ["  400   400 weird"].join("\n");
    const spawn4 = ((_cmd: string, _args: string[]) => ({ status: 0, stdout: loop })) as never;
    expect(detectHarnessFromAncestry(400, spawn4)).toBe(null);
    expect(detectHarnessFromAncestry(1, spawn)).toBe(null);
  });

  test("isBindingHarness 只认三个值", () => {
    expect(isBindingHarness("codex")).toBe(true);
    expect(isBindingHarness("claude")).toBe(true);
    expect(isBindingHarness("other")).toBe(true);
    expect(isBindingHarness("Codex")).toBe(false);
    expect(isBindingHarness(null)).toBe(false);
  });
});

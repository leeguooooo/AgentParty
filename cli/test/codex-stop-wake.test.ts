// #899：codex Stop hook 前台唤醒——在用户眼前那个会话里 block 一轮，不是后台新 runner。
//
// 样本形态取自本机 codex 0.145.0 的**真机** Stop payload（`codex exec` + 临时 CODEX_HOME
// 注册 Stop hook 抓下来的原样 JSON），而不是从二进制反推的字段表。真机字段只有：
//   cwd / hook_event_name / last_assistant_message / model / permission_mode /
//   session_id / stop_hook_active / transcript_path / turn_id
// 注意没有 agent_id / agent_type / prompt——反推版把 SubagentStop 的字段混了进来。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_STOP_WAKE_DEBT_MAX_AGE_MS,
  CODEX_STOP_WAKE_REASON_MAX_BYTES,
  appendCodexStopWakeSeen,
  codexStopWakeReason,
  codexStopWakeSeenPath,
  decideCodexStopWake,
  hasCodexStopWakeSeen,
  readCodexStopWakeSeen,
  recordCodexStopWakeSeen,
  type CodexStopWakeInput,
} from "../src/codex-stop-wake";
import {
  codexHookSettingsJson,
  handleCodexStopRecord,
  mergeHookSettings,
  removeHookSettings,
  type CodexStopWakeDeps,
} from "../src/commands/hook";

const NOW = 1_700_000_000_000;

/** 真机 Stop payload（字段与顺序原样保留）。 */
function stopPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: "/tmp/work",
    hook_event_name: "Stop",
    last_assistant_message: "HELLO-ONE",
    model: "gpt-5.6-sol",
    permission_mode: "default",
    session_id: "01a021f5-aed7-7802-bea3-6165e5dba553",
    stop_hook_active: false,
    transcript_path: "/tmp/rollout.jsonl",
    turn_id: "01a021f5-c1d5-7cb0-b1f7-61eba78f9af6",
    ...overrides,
  };
}

function decideInput(overrides: Partial<CodexStopWakeInput> = {}): CodexStopWakeInput {
  return {
    payload: stopPayload(),
    channel: "pwtk",
    enabled: true,
    pending: { seq: 42, first_wake_ts: NOW - 1_000 },
    cursor: 7,
    seen: [],
    now: NOW,
    ...overrides,
  };
}

describe("decideCodexStopWake", () => {
  test("有未处理的 @ → block，指针带 channel+seq", () => {
    expect(decideCodexStopWake(decideInput())).toEqual({
      wake: true,
      pointer: { channel: "pwtk", seq: 42 },
    });
  });

  test("没有欠账 → 放行", () => {
    expect(decideCodexStopWake(decideInput({ pending: null }))).toEqual({
      wake: false,
      skip: "no_pending",
    });
  });

  // 防循环第 1 闸。codex 实测不会自己封顶：连续 4 次无条件 block 它就跑了 4 轮，
  // 所以这一条挂了就是「会话永远停不下来」。
  test("stop_hook_active 为真（续跑轮）→ 放行", () => {
    expect(
      decideCodexStopWake(decideInput({ payload: stopPayload({ stop_hook_active: true }) })),
    ).toEqual({ wake: false, skip: "continuation" });
  });

  test("stop_hook_active 缺失或类型不对 → 一律当续跑放行（宁可漏叫，不冒死循环）", () => {
    for (const value of [undefined, null, "false", 0, 1]) {
      const payload = stopPayload();
      if (value === undefined) delete payload.stop_hook_active;
      else payload.stop_hook_active = value;
      expect(decideCodexStopWake(decideInput({ payload }))).toEqual({
        wake: false,
        skip: "continuation",
      });
    }
  });

  // 防循环第 2 闸：同一条 seq 只注入一次。
  test("同一 seq 已注入过 → 放行", () => {
    expect(decideCodexStopWake(decideInput({ seen: [42] }))).toEqual({
      wake: false,
      skip: "already_woken",
    });
  });

  test("seen 里是别的 seq → 照常 block", () => {
    expect(decideCodexStopWake(decideInput({ seen: [1, 2, 41, 43] })).wake).toBe(true);
  });

  test("游标已越过该 seq（早就了结了）→ 放行", () => {
    expect(decideCodexStopWake(decideInput({ cursor: 42 })).wake).toBe(false);
    expect(decideCodexStopWake(decideInput({ cursor: 99 }))).toEqual({
      wake: false,
      skip: "no_pending",
    });
    // 边界：游标差一条时仍然要叫。
    expect(decideCodexStopWake(decideInput({ cursor: 41 })).wake).toBe(true);
  });

  test("非 Stop 事件 → 放行", async () => {
    expect(
      decideCodexStopWake(decideInput({ payload: stopPayload({ hook_event_name: "SubagentStop" }) })),
    ).toEqual({ wake: false, skip: "not_stop" });
  });

  test("开关 off → 放行", () => {
    expect(decideCodexStopWake(decideInput({ enabled: false }))).toEqual({
      wake: false,
      skip: "disabled",
    });
  });

  test("没绑定频道 → 放行", () => {
    expect(decideCodexStopWake(decideInput({ channel: null })).wake).toBe(false);
    expect(decideCodexStopWake(decideInput({ channel: "" }))).toEqual({
      wake: false,
      skip: "no_channel",
    });
  });

  test("欠账过期（几天前的 @）→ 放行", () => {
    expect(
      decideCodexStopWake(
        decideInput({
          pending: { seq: 42, first_wake_ts: NOW - CODEX_STOP_WAKE_DEBT_MAX_AGE_MS - 1 },
        }),
      ),
    ).toEqual({ wake: false, skip: "stale_debt" });
    // 刚好没到期 → 仍然叫。
    expect(
      decideCodexStopWake(
        decideInput({
          pending: { seq: 42, first_wake_ts: NOW - CODEX_STOP_WAKE_DEBT_MAX_AGE_MS },
        }),
      ).wake,
    ).toBe(true);
    // 没有 first_wake_ts 的旧欠账不该被误判成过期。
    expect(decideCodexStopWake(decideInput({ pending: { seq: 42 } })).wake).toBe(true);
  });

  test("seq 非法 → 放行", () => {
    for (const seq of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decideCodexStopWake(decideInput({ pending: { seq } })).wake).toBe(false);
    }
  });
});

describe("codexStopWakeReason", () => {
  test("非空、带频道与 seq、点明是 AgentParty 在唤醒", () => {
    const reason = codexStopWakeReason({ channel: "pwtk", seq: 42 });
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain("AgentParty");
    expect(reason).toContain("pwtk");
    expect(reason).toContain("42");
  });

  test("守住 ≤512B 预算（含长频道名）", () => {
    for (const channel of ["a", "pwtk", "x".repeat(200), "频道".repeat(100)]) {
      const reason = codexStopWakeReason({ channel, seq: 999_999 });
      expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(
        CODEX_STOP_WAKE_REASON_MAX_BYTES,
      );
      // 截断也绝不许截成空串——契约要求 reason 非空，空了 codex 会忽略整个 block。
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  test("只给指针，不给正文（频道是唯一数据源）", () => {
    expect(codexStopWakeReason({ channel: "pwtk", seq: 42 })).toContain("party history");
  });
});

describe("seen 集合落盘", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-899-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("写入后跨进程可读（Stop hook 每轮都是新进程，内存集合等于没有）", () => {
    const path = codexStopWakeSeenPath(home, "srv|pwtk");
    expect(readCodexStopWakeSeen(path)).toEqual([]);
    recordCodexStopWakeSeen(path, 42);
    expect(readCodexStopWakeSeen(path)).toEqual([42]);
    recordCodexStopWakeSeen(path, 43);
    expect(readCodexStopWakeSeen(path)).toEqual([42, 43]);
    // 重复写同一条不该让集合增长。
    recordCodexStopWakeSeen(path, 43);
    expect(readCodexStopWakeSeen(path)).toEqual([42, 43]);
  });

  // 身份串里含 `/` 和 `..`，转义后必须仍是 home 下的**单个文件名**，不能变成路径。
  test("路径把身份里的分隔符转义掉，不穿越目录", () => {
    const dir = join(home, "codex-stop-wake");
    const path = codexStopWakeSeenPath(home, "https://a/b|../../etc");
    expect(path.startsWith(`${dir}/`)).toBe(true);
    const name = path.slice(dir.length + 1);
    expect(name).not.toContain("/");
    expect(name).toBe("https___a_b_.._.._etc.json");
    expect(join(dir, name)).toBe(path);
  });

  test("有界：超容量丢最旧的，保留最新的", () => {
    expect(appendCodexStopWakeSeen([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(appendCodexStopWakeSeen([1, 2, 3], 3, 3)).toEqual([1, 2, 3]);
    expect(appendCodexStopWakeSeen([], 1, 3)).toEqual([1]);
  });

  test("文件坏了/不存在 → 当空集，绝不抛", () => {
    const path = join(home, "codex-stop-wake", "broken.json");
    expect(readCodexStopWakeSeen(path)).toEqual([]);
    recordCodexStopWakeSeen(path, 1);
    require("node:fs").writeFileSync(path, "{ not json");
    expect(readCodexStopWakeSeen(path)).toEqual([]);
    for (const bad of ["[]", "null", '{"seqs":"x"}', '{"seqs":[null,"a",-1,0,5]}']) {
      require("node:fs").writeFileSync(path, bad);
      expect(readCodexStopWakeSeen(path)).toEqual(bad.includes("5") ? [5] : []);
    }
  });

  test("hasCodexStopWakeSeen", () => {
    expect(hasCodexStopWakeSeen([1, 2], 2)).toBe(true);
    expect(hasCodexStopWakeSeen([1, 2], 3)).toBe(false);
    expect(hasCodexStopWakeSeen([], 1)).toBe(false);
  });
});

describe("handleCodexStopRecord", () => {
  let home: string;
  let emitted: string[];
  let logged: string[];
  let seenStore: Map<string, number[]>;

  function deps(overrides: Partial<CodexStopWakeDeps> = {}): CodexStopWakeDeps {
    return {
      channel: () => "pwtk",
      enabled: () => true,
      stuck: () => ({ seq: 42, first_wake_ts: NOW - 1_000 }),
      nextMention: async () => null,
      cursor: () => 7,
      seenPath: () => join(home, "seen.json"),
      readSeen: (path) => seenStore.get(path) ?? [],
      recordSeen: (path, seq) => {
        seenStore.set(path, [...(seenStore.get(path) ?? []), seq]);
      },
      emit: (line) => emitted.push(line),
      log: (line) => logged.push(line),
      now: () => NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-899h-"));
    emitted = [];
    logged = [];
    seenStore = new Map();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("有未处理的 @ → 恰好一行 block JSON，契约字段齐全", async () => {
    await handleCodexStopRecord(stopPayload(), {}, deps());
    expect(emitted).toHaveLength(1);
    const output = JSON.parse(emitted[0]!) as Record<string, unknown>;
    expect(output.decision).toBe("block");
    expect(typeof output.reason).toBe("string");
    expect((output.reason as string).length).toBeGreaterThan(0);
    // 实测：多带一个 `prompt` 字段会让 codex 判 `Stop Failed`、整份输出作废。
    // stop.command.output 是 additionalProperties:false，只有这两个键是我们该发的。
    expect(Object.keys(output).sort()).toEqual(["decision", "reason"]);
  });

  test("没有未处理的 @ → 放行，stdout 一个字都不写", async () => {
    await handleCodexStopRecord(stopPayload(), {}, deps({ stuck: () => null }));
    expect(emitted).toEqual([]);
  });

  test("续跑轮（stop_hook_active 为真）→ 放行", async () => {
    await handleCodexStopRecord(stopPayload({ stop_hook_active: true }), {}, deps());
    expect(emitted).toEqual([]);
  });

  test("同一 seq 第二次 → 放行（seen 已落盘）", async () => {
    const d = deps();
    await handleCodexStopRecord(stopPayload(), {}, d);
    expect(emitted).toHaveLength(1);
    await handleCodexStopRecord(stopPayload(), {}, d);
    expect(emitted).toHaveLength(1);
  });

  test("先落 seen 再打印——顺序反了，中间崩一次就会反复注入", async () => {
    const order: string[] = [];
    await handleCodexStopRecord(stopPayload(), {}, deps({
      recordSeen: () => order.push("seen"),
      emit: () => order.push("emit"),
    }));
    expect(order).toEqual(["seen", "emit"]);
  });

  test("拿不到身份（去不了重）→ 放行，绝不注入", async () => {
    await handleCodexStopRecord(stopPayload(), {}, deps({ seenPath: () => null }));
    expect(emitted).toEqual([]);
    expect(logged.join("\n")).toContain("去重");
  });

  test("serve 托管 lane（AP_ACTIVITY_FILE）→ 放行，避免与 #893 后台通道重复处理同一条 @", async () => {
    await handleCodexStopRecord(stopPayload(), { AP_ACTIVITY_FILE: "/tmp/a.json" }, deps());
    expect(emitted).toEqual([]);
  });

  test("本地信号读取抛异常 → 不吞掉异常契约由调用方兜，但绝不写出半条 stdout", async () => {
    await expect(
      handleCodexStopRecord(stopPayload(), {}, deps({
        stuck: () => {
          throw new Error("disk on fire");
        },
      })),
    ).rejects.toThrow();
    expect(emitted).toEqual([]);
  });

  test("非 Stop 事件 → 放行", async () => {
    await handleCodexStopRecord(stopPayload({ hook_event_name: "SessionStart" }), {}, deps());
    expect(emitted).toEqual([]);
  });

  test("payload 里的 cwd 被用来解析频道", async () => {
    const seen: string[] = [];
    await handleCodexStopRecord(stopPayload({ cwd: "/tmp/elsewhere" }), {}, deps({
      channel: (cwd) => {
        seen.push(cwd);
        return "pwtk";
      },
    }));
    expect(seen).toEqual(["/tmp/elsewhere"]);
  });

  // ⚠️ 这一条钉住 #903 的盲区，删了等于这个 bug 没修。
  //
  // v0.2.203 的实现里，唯一的信号源是 serve/watch 落盘的欠账，而**全仓只有 serve 会写欠账**。
  // 于是本 hook 在它唯一存在的场景（用户没挂 serve/bridge）里恒不触发：本地永远没有欠账，
  // 判定永远走 no_pending。单测当时全绿，因为每条用例都自己喂了一个 stuck。
  test("本地没有欠账（没人挂 serve）→ 仍能问出未处理的 @ 并 block", async () => {
    const asked: Array<{ channel: string; since: number }> = [];
    await handleCodexStopRecord(stopPayload(), {}, deps({
      stuck: () => null,
      cursor: () => 1899,
      nextMention: async (channel, _cwd, since) => {
        asked.push({ channel, since });
        return 1910;
      },
    }));
    // 问的是「> 我的游标之后的第一条 @」，不是随便问问。
    expect(asked).toEqual([{ channel: "pwtk", since: 1899 }]);
    expect(emitted).toHaveLength(1);
    const output = JSON.parse(emitted[0]!) as Record<string, unknown>;
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("1910");
    expect(Object.keys(output).sort()).toEqual(["decision", "reason"]);
    // 网络路径同样必须「先落盘 seen 再打印」，否则同一条 @ 每轮都会被重新问出来、反复注入。
    expect(seenStore.get(join(home, "seen.json"))).toEqual([1910]);
  });

  test("网络问来的 seq 同样受 seen 去重约束（不会每轮反复注入）", async () => {
    const d = deps({ stuck: () => null, cursor: () => 1899, nextMention: async () => 1910 });
    await handleCodexStopRecord(stopPayload(), {}, d);
    await handleCodexStopRecord(stopPayload(), {}, d);
    expect(emitted).toHaveLength(1);
  });

  test("有本地欠账时走快路径，一次网络都不发", async () => {
    let calls = 0;
    await handleCodexStopRecord(stopPayload(), {}, deps({
      nextMention: async () => {
        calls += 1;
        return null;
      },
    }));
    expect(calls).toBe(0);
    expect(emitted).toHaveLength(1);
  });

  test("本地欠账已被游标越过 → 不当快路径用，仍去问服务端", async () => {
    let calls = 0;
    await handleCodexStopRecord(stopPayload(), {}, deps({
      stuck: () => ({ seq: 5, first_wake_ts: NOW - 1_000 }),
      cursor: () => 7,
      nextMention: async () => {
        calls += 1;
        return 9;
      },
    }));
    expect(calls).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0]!).reason).toContain("9");
  });

  test("查询超时/失败（返回 null）→ 放行，stdout 一个字都不写", async () => {
    await handleCodexStopRecord(stopPayload(), {}, deps({ stuck: () => null, nextMention: async () => null }));
    expect(emitted).toEqual([]);
  });

  // 便宜闸必须挡在网络前面：不是 Stop / 续跑轮 / 被关掉 / 没绑频道，一次请求都不该发。
  test.each([
    ["非 Stop 事件", stopPayload({ hook_event_name: "SessionStart" }), {} as Partial<CodexStopWakeDeps>],
    ["续跑轮", stopPayload({ stop_hook_active: true }), {}],
    ["开关关掉", stopPayload(), { enabled: () => false }],
    ["没绑频道", stopPayload(), { channel: () => null }],
  ])("%s → 连网络都不发", async (_label, payload, extra) => {
    let calls = 0;
    await handleCodexStopRecord(payload, {}, deps({
      stuck: () => null,
      nextMention: async () => {
        calls += 1;
        return 1910;
      },
      ...extra,
    }));
    expect(calls).toBe(0);
    expect(emitted).toEqual([]);
  });

  test("serve 托管 lane（AP_ACTIVITY_FILE）→ 连网络都不发", async () => {
    let calls = 0;
    await handleCodexStopRecord(stopPayload(), { AP_ACTIVITY_FILE: "/tmp/a.json" }, deps({
      stuck: () => null,
      nextMention: async () => {
        calls += 1;
        return 1910;
      },
    }));
    expect(calls).toBe(0);
    expect(emitted).toEqual([]);
  });
});

describe("codexHookSettingsJson", () => {
  test("同时装 SessionStart（入册/#893）与 Stop（前台唤醒/#899），都带 10s 超时", () => {
    const settings = JSON.parse(codexHookSettingsJson("/usr/local/bin/party")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual(["SessionStart", "Stop"]);
    const stop = settings.hooks.Stop![0]!.hooks[0]!;
    expect(stop.command).toContain("hook codex-stop");
    expect(stop.timeout).toBe(10);
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toContain("hook codex-report");
  });

  // 真机上 ~/.codex/hooks.json 的 Stop 已经挂着别人的东西（otty / vibe-island / superset）。
  // 合并绝不能动它们，卸载也只许摘我们自己那条。
  test("与用户已有的 Stop hook 共存：合并幂等、卸载只摘自己那条", () => {
    const fragment = codexHookSettingsJson("/usr/local/bin/party");
    const mine = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-thing" }] }] },
    });
    const merged = mergeHookSettings(mine, fragment);
    expect(merged).toContain("my-own-thing");
    expect(merged).toContain("hook codex-stop");
    expect(mergeHookSettings(merged, fragment)).toBe(merged);
    const removed = JSON.parse(removeHookSettings(merged)) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }>; SessionStart?: unknown };
    };
    expect(removed.hooks.Stop).toHaveLength(1);
    expect(removed.hooks.Stop[0]!.hooks[0]!.command).toBe("my-own-thing");
    expect(removed.hooks.SessionStart).toBeUndefined();
  });
});

describe("party hook codex-stop 端到端（子进程）", () => {
  const indexPath = join(import.meta.dir, "..", "src", "index.ts");

  async function runHook(input: string, env: NodeJS.ProcessEnv) {
    const proc = Bun.spawn(["bun", "run", indexPath, "hook", "codex-stop"], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(input);
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-899e-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("没有任何本地信号 → exit 0、stdout 恒空（hook 铁律）", async () => {
    const result = await runHook(JSON.stringify(stopPayload()), {
      ...process.env,
      AGENTPARTY_HOME: home,
      AGENTPARTY_CHANNEL: "pwtk",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("坏 JSON → exit 0、stdout 恒空，绝不阻断会话", async () => {
    const result = await runHook("{ not json", { ...process.env, AGENTPARTY_HOME: home });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("空 stdin → exit 0、stdout 恒空", async () => {
    const result = await runHook("", { ...process.env, AGENTPARTY_HOME: home });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("非对象 payload → exit 0、stdout 恒空", async () => {
    for (const raw of ["[]", '"x"', "null", "3"]) {
      const result = await runHook(raw, { ...process.env, AGENTPARTY_HOME: home });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});

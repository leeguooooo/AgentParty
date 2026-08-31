// #1013：`party claude` 撞到「插件旧于 CLI」应该自己 update 完直接启动，而不是让人手敲命令。
// 这里钉住四档：旧+成功⇒启动；旧+失败⇒不启动 + 手动命令；新于 CLI⇒绝不 update；开关关掉⇒回到今天。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NO_AUTO_PLUGIN_UPDATE_FLAG,
  run,
  shouldSelfHealPluginVersion,
  type ClaudeLaunchDependencies,
  type ClaudeLaunchPreflight,
} from "../src/commands/claude-launch";
import type { ClaudePluginSyncResult } from "../src/claude-plugin-sync";

const CLI = "0.2.223";
const OLD_PLUGIN = "0.2.222";
const NEW_PLUGIN = "0.2.224";

const MISMATCH_FIX =
  `  fix: claude plugin update agentparty@agentparty (installed ${OLD_PLUGIN}, runtime ${CLI})`;
const UPGRADE_FIX = "  fix: party upgrade (installed plugin is newer than runtime)";

function mismatched(pluginVersion: string, fix: string): ClaudeLaunchPreflight {
  return {
    blockers: ["plugin_version_mismatch", "listener_not_observed"],
    listener: "not_observed",
    fix_lines: [fix],
    plugin_version: pluginVersion,
    runtime_version: CLI,
  };
}

const ready: ClaudeLaunchPreflight = {
  blockers: ["listener_not_observed"],
  listener: "not_observed",
  fix_lines: [],
  plugin_version: CLI,
  runtime_version: CLI,
};

interface Harness {
  deps: ClaudeLaunchDependencies;
  launches: string[][];
  syncCalls: string[];
  preflights: number;
  out: string[];
  err: string[];
}

function harness(
  preflights: ClaudeLaunchPreflight[],
  sync: ClaudePluginSyncResult | undefined,
): Harness {
  const state: Harness = {
    launches: [],
    syncCalls: [],
    preflights: 0,
    out: [],
    err: [],
    deps: undefined as unknown as ClaudeLaunchDependencies,
  };
  state.deps = {
    preflight: async () => {
      const next = preflights[Math.min(state.preflights, preflights.length - 1)]!;
      state.preflights += 1;
      return next;
    },
    ...(sync === undefined
      ? {}
      : {
          syncPlugin: (cliVersion: string) => {
            state.syncCalls.push(cliVersion);
            return sync;
          },
        }),
    launch(args) {
      state.launches.push(args);
      return { status: 0 };
    },
    home: mkdtempSync(join(tmpdir(), "agentparty-selfheal-")),
    env: {},
  };
  return state;
}

async function capture<T>(h: Harness, fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void h.out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void h.err.push(args.map(String).join(" "));
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("party claude plugin self-heal (#1013)", () => {
  test("plugin older than CLI + update succeeds: updates, re-checks, and launches", async () => {
    const h = harness([mismatched(OLD_PLUGIN, MISMATCH_FIX), ready], {
      kind: "updated",
      before: OLD_PLUGIN,
      after: CLI,
    });

    expect(await capture(h, () => run(["dev"], h.deps))).toBe(0);

    // 自愈跑过一次，目标是 CLI 版本（不是插件版本）。
    expect(h.syncCalls).toEqual([CLI]);
    // 修完必须重跑 preflight，别的 blocker 不因自愈被跳过。
    expect(h.preflights).toBe(2);
    // 真的启动了——这是本 issue 的要点：不再让用户重跑一次 `party claude`。
    expect(h.launches).toHaveLength(1);
    const out = h.out.join("\n");
    expect(out).toContain("claude plugin update agentparty@agentparty");
    expect(out).toContain(OLD_PLUGIN);
    expect(out).toContain(CLI);
    // 不该再印那条「你自己去敲」的手动修法。
    expect(h.err.join("\n")).not.toContain(MISMATCH_FIX);
    expect(h.err.join("\n")).not.toContain("not launch-ready");
  });

  test("plugin older than CLI + update fails: no launch, manual command plus the reason", async () => {
    const h = harness([mismatched(OLD_PLUGIN, MISMATCH_FIX)], {
      kind: "update_failed",
      before: OLD_PLUGIN,
      after: OLD_PLUGIN,
      fix: "claude plugin update agentparty@agentparty",
    });

    expect(await capture(h, () => run(["dev"], h.deps))).toBe(1);

    expect(h.syncCalls).toEqual([CLI]);
    expect(h.launches).toHaveLength(0);
    const err = h.err.join("\n");
    expect(err).toContain("not launch-ready");
    expect(err).toContain(MISMATCH_FIX);
    // 失败原因要说出来，不能只丢一条命令。
    expect(err).toContain("失败");
  });

  test("plugin newer than CLI: never runs update, keeps the party upgrade advice", async () => {
    const h = harness([mismatched(NEW_PLUGIN, UPGRADE_FIX)], {
      kind: "updated",
      before: NEW_PLUGIN,
      after: CLI,
    });

    expect(await capture(h, () => run(["dev"], h.deps))).toBe(1);

    // #1011：跑 update 就是降级。一次都不许调。
    expect(h.syncCalls).toEqual([]);
    expect(h.preflights).toBe(1);
    expect(h.launches).toHaveLength(0);
    expect(h.err.join("\n")).toContain("party upgrade");
  });

  test(`${NO_AUTO_PLUGIN_UPDATE_FLAG} keeps today's behaviour`, async () => {
    const h = harness([mismatched(OLD_PLUGIN, MISMATCH_FIX)], {
      kind: "updated",
      before: OLD_PLUGIN,
      after: CLI,
    });

    expect(await capture(h, () => run(["dev", NO_AUTO_PLUGIN_UPDATE_FLAG], h.deps))).toBe(1);

    expect(h.syncCalls).toEqual([]);
    expect(h.launches).toHaveLength(0);
    const err = h.err.join("\n");
    expect(err).toContain("not launch-ready");
    expect(err).toContain(MISMATCH_FIX);
  });

  test(`${NO_AUTO_PLUGIN_UPDATE_FLAG} is not forwarded to Claude and does not break the channel arg`, async () => {
    const h = harness([ready], undefined);

    expect(await capture(h, () => run([NO_AUTO_PLUGIN_UPDATE_FLAG, "dev", "--", "--model", "sonnet"], h.deps))).toBe(0);

    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).not.toContain(NO_AUTO_PLUGIN_UPDATE_FLAG);
    expect(h.launches[0]).toContain("sonnet");
  });

  test("self-heal does not swallow other blockers found after the update", async () => {
    const h = harness(
      [
        mismatched(OLD_PLUGIN, MISMATCH_FIX),
        {
          blockers: ["identity_unavailable", "listener_not_observed"],
          listener: "not_observed",
          fix_lines: ["  fix: identity"],
          plugin_version: CLI,
          runtime_version: CLI,
        },
      ],
      { kind: "updated", before: OLD_PLUGIN, after: CLI },
    );

    expect(await capture(h, () => run(["dev"], h.deps))).toBe(1);

    expect(h.launches).toHaveLength(0);
    expect(h.err.join("\n")).toContain("identity_unavailable");
  });

  test("shouldSelfHealPluginVersion only fires for a strictly older readable plugin", () => {
    expect(shouldSelfHealPluginVersion(mismatched(OLD_PLUGIN, MISMATCH_FIX))).toBe(true);
    expect(shouldSelfHealPluginVersion(mismatched(NEW_PLUGIN, UPGRADE_FIX))).toBe(false);
    expect(shouldSelfHealPluginVersion(mismatched(CLI, MISMATCH_FIX))).toBe(false);
    expect(shouldSelfHealPluginVersion(ready)).toBe(false);
    expect(
      shouldSelfHealPluginVersion({
        blockers: ["plugin_version_mismatch"],
        listener: "not_checked",
        runtime_version: CLI,
      }),
    ).toBe(false);
  });
});

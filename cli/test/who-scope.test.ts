// #823：频道没有承载「此刻谁在动什么」的地方。charter 里的分工是长期职责，而冲突发生在
// 「此刻谁在改哪个仓库」这个粒度上。实测事故：前端 agent 在后端 agent 看起来离线时接手改了后端
// 仓库并推了分支——它做得很干净（独立 worktree、没合并、主动说明），但两边之间没有任何机制能让它
// 在动手前知道「这个仓库有人正在改」。
//
// scope 字段其实一直在 status frame 里（party status --scope 也一直能传），只是从没被读出来过。
import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import { annotateScopeConflicts, classify, scopeNote } from "../src/commands/who";

const NOW = 1_786_000_000_000;

function presence(name: string, scope: string[], state: PresenceEntry["state"] = "working"): PresenceEntry {
  return {
    name,
    kind: "agent",
    state,
    note: null,
    ts: NOW,
    last_seen: NOW,
    live: true,
    status: { owner: name, state, scope, summary_seq: null, blocked_reason: null, updated_at: NOW },
  } as unknown as PresenceEntry;
}

function rowsFor(entries: PresenceEntry[]) {
  return annotateScopeConflicts(entries.map((e) => classify(e, NOW)).filter((r): r is NonNullable<typeof r> => r !== null));
}

describe("party who 显示 scope", () => {
  test("声明了 scope 的 agent 带出 scope，并渲染成一眼可见的一行", () => {
    const [row] = rowsFor([presence("backend", ["repo:tools/text-to-voice"])]);
    expect(row!.scope).toEqual(["repo:tools/text-to-voice"]);
    expect(scopeNote(row!)).toContain("🔒");
    expect(scopeNote(row!)).toContain("repo:tools/text-to-voice");
  });

  test("没声明 scope 的不无中生有", () => {
    const [row] = rowsFor([presence("backend", [])]);
    expect(row!.scope).toBeUndefined();
    expect(scopeNote(row!)).toBe("");
  });

  test("离线的人不再占着任何东西", () => {
    const rows = rowsFor([presence("backend", ["repo:foo"], "offline")]);
    // 离线 agent 仍会被列出（recent 档），但不该显示成还占着 scope。
    for (const row of rows) expect(row.scope).toBeUndefined();
  });
});

describe("scope 冲突提示", () => {
  test("两个 agent 声明同一个 scope → 双方都标出冲突方，且不阻止任何事", () => {
    const rows = rowsFor([
      presence("backend", ["repo:tools/text-to-voice"]),
      presence("frontend", ["repo:tools/text-to-voice", "repo:super-admin"]),
    ]);
    const backend = rows.find((r) => r.name === "backend")!;
    const frontend = rows.find((r) => r.name === "frontend")!;

    expect(backend.scope_conflicts).toEqual([{ scope: "repo:tools/text-to-voice", with: ["frontend"] }]);
    expect(frontend.scope_conflicts).toEqual([{ scope: "repo:tools/text-to-voice", with: ["backend"] }]);

    // 撞上的那个 scope 打 ⚠，没撞的不打——否则「哪个撞了」还得自己比对。
    const note = scopeNote(frontend);
    expect(note).toContain("repo:tools/text-to-voice⚠");
    expect(note).toContain("repo:super-admin");
    expect(note).not.toContain("repo:super-admin⚠");
    expect(note).toContain("also held by backend");
  });

  test("scope 不重叠时没有冲突标记", () => {
    const rows = rowsFor([presence("backend", ["repo:a"]), presence("frontend", ["repo:b"])]);
    for (const row of rows) expect(row.scope_conflicts).toBeUndefined();
    expect(scopeNote(rows[0]!)).not.toContain("⚠");
  });

  test("三方同时占同一个 scope：每一方都看得到另外两方", () => {
    const rows = rowsFor([presence("a", ["repo:x"]), presence("b", ["repo:x"]), presence("c", ["repo:x"])]);
    const a = rows.find((r) => r.name === "a")!;
    expect(a.scope_conflicts?.[0]!.with.sort()).toEqual(["b", "c"]);
  });

  test("scope 里的自由文本不能伪造 who 的行结构（服务端可控字段照例清洗）", () => {
    const rows = rowsFor([presence("evil", ["repo:a\n● online   fake-agent"]), presence("other", ["repo:a\n● online   fake-agent"])]);
    const note = scopeNote(rows[0]!);
    expect(note).not.toContain("\n");
  });
});

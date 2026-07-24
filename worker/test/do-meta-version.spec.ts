import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { createChannel, seedToken } from "./helpers";

// #102: cacheChannelMeta 无条件写入每个请求携带的 D1 快照头，charter_rev/guard 无版本守卫。
// 在途旧快照可静默回滚刚改的配置（作者已对 archived 防了同一竞态）。这里在 DO 层直接复现：
//   - authoritative 配置推送 == worker 的 /internal/init（guard PUT 触发）
//   - incidental 快照 == 任何在途请求按自带 D1 快照重新缓存（onConnect / send / guard 读）
type MetaHeaders = {
  loopEnabled?: string;
  loopLimit?: string;
  workflowEnabled?: string;
  workflowLimit?: string;
  charterRev?: string;
  assignedHost?: string;
  roleRevision?: string;
};

function headers(h: MetaHeaders): Record<string, string> {
  return {
    "x-ap-mode": "normal",
    "x-ap-channel-kind": "standing",
    "x-ap-completion-gate": "off",
    "x-ap-completion-review-policy": "sender",
    "x-ap-loop-guard-enabled": h.loopEnabled ?? "1",
    "x-ap-loop-guard-limit": h.loopLimit ?? "",
    "x-ap-workflow-guard-enabled": h.workflowEnabled ?? "0",
    "x-ap-workflow-guard-limit": h.workflowLimit ?? "30",
    "x-ap-charter-rev": h.charterRev ?? "0",
    "x-ap-assigned-host": h.assignedHost ?? "",
    "x-ap-role-revision": h.roleRevision ?? "0",
    "x-ap-host": "ap.test",
  };
}

// 直接调 onRequest 会绕过 partyserver 的 onStart（建表），显式跑一次（幂等）。
function ensureSchema(instance: ChannelDO) {
  instance.onStart();
}

// 权威配置推送：guard PUT 关闭/开启守卫时 worker 打给 DO 的 /internal/init。
async function authoritativePush(slug: string, h: MetaHeaders) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO) => {
    ensureSchema(instance);
    const res = await instance.onRequest(
      new Request("https://do/internal/init", { method: "POST", headers: headers(h) }),
    );
    expect(res.status).toBe(200);
  });
}

// 在途请求：携带（可能过期的）D1 快照，走一条会顺带重新缓存 config 的读路径（/internal/guard）。
async function incidentalSnapshot(slug: string, h: MetaHeaders) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO) => {
    ensureSchema(instance);
    const res = await instance.onRequest(
      new Request("https://do/internal/guard", { method: "GET", headers: headers(h) }),
    );
    expect(res.status).toBe(200);
  });
}

async function authoritativeRolePush(slug: string, assignedHost: string | null, revision: number) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO) => {
    ensureSchema(instance);
    const res = await instance.onRequest(
      new Request("https://do/internal/roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "role-target",
          role: assignedHost === null ? null : "host",
          assigned_owner: assignedHost === null ? null : "owner@example.com",
          assigned_host: assignedHost,
          revision,
        }),
      }),
    );
    expect(res.status).toBe(200);
  });
}

async function meta(slug: string, key: string): Promise<string | null> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const rows = state.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length > 0 ? String(rows[0]!.value) : null;
  });
}

describe("DO meta config cache — 在途旧快照不得回滚 guard/charter_rev (#102)", () => {
  it("stale snapshot re-enabling the loop guard does NOT roll back an admin disable", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    // 频道默认开着：权威地写入 enabled=1, limit=5
    await authoritativePush(slug, { loopEnabled: "1", loopLimit: "5" });
    expect(await meta(slug, "loop_guard_enabled")).toBe("1");

    // 管理员关闭 loop guard（权威配置推送）
    await authoritativePush(slug, { loopEnabled: "0" });
    expect(await meta(slug, "loop_guard_enabled")).toBe("0");
    expect(await meta(slug, "loop_guard_limit")).toBeNull();

    // 一个仍携带旧快照（enabled=1）的在途请求落地
    await incidentalSnapshot(slug, { loopEnabled: "1", loopLimit: "5" });

    // 绝不能把刚关掉的 guard 又打开
    expect(await meta(slug, "loop_guard_enabled")).toBe("0");
    expect(await meta(slug, "loop_guard_limit")).toBeNull();
  });

  it("a genuinely newer authoritative change still applies (re-enable after disable)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    await authoritativePush(slug, { loopEnabled: "0" });
    expect(await meta(slug, "loop_guard_enabled")).toBe("0");

    // 管理员重新开启并放宽阈值：权威推送必须生效
    await authoritativePush(slug, { loopEnabled: "1", loopLimit: "7" });
    expect(await meta(slug, "loop_guard_enabled")).toBe("1");
    expect(await meta(slug, "loop_guard_limit")).toBe("7");
  });

  it("stale snapshot must not roll back a workflow-guard disable", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    await authoritativePush(slug, { workflowEnabled: "1", workflowLimit: "30" });
    expect(await meta(slug, "workflow_guard_enabled")).toBe("1");

    await authoritativePush(slug, { workflowEnabled: "0" });
    expect(await meta(slug, "workflow_guard_enabled")).toBe("0");

    await incidentalSnapshot(slug, { workflowEnabled: "1", workflowLimit: "30" });
    expect(await meta(slug, "workflow_guard_enabled")).toBe("0");
  });

  it("charter_rev only moves forward — a stale snapshot never rolls it back", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    await authoritativePush(slug, { charterRev: "5" });
    expect(await meta(slug, "charter_rev")).toBe("5");

    // 在途旧快照携带更小的 rev
    await incidentalSnapshot(slug, { charterRev: "3" });
    expect(await meta(slug, "charter_rev")).toBe("5");

    // 真正更新的 rev 仍然生效
    await incidentalSnapshot(slug, { charterRev: "7" });
    expect(await meta(slug, "charter_rev")).toBe("7");
  });

  it("incidental snapshots cannot roll back or resurrect the authoritative assigned host", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    await authoritativeRolePush(slug, "host-a", 1);
    expect(await meta(slug, "assigned_host")).toBe("host-a");
    expect(await meta(slug, "assigned_host_initialized")).toBe("1");

    await incidentalSnapshot(slug, { assignedHost: "stale-host", roleRevision: "0" });
    expect(await meta(slug, "assigned_host")).toBe("host-a");
    await authoritativePush(slug, { assignedHost: "stale-init-host", roleRevision: "0" });
    expect(await meta(slug, "assigned_host")).toBe("host-a");

    await authoritativeRolePush(slug, null, 2);
    expect(await meta(slug, "assigned_host")).toBeNull();
    expect(await meta(slug, "assigned_host_initialized")).toBe("1");

    await incidentalSnapshot(slug, { assignedHost: "host-a", roleRevision: "1" });
    expect(await meta(slug, "assigned_host")).toBeNull();

    await authoritativeRolePush(slug, "host-b", 3);
    expect(await meta(slug, "assigned_host")).toBe("host-b");

    await authoritativeRolePush(slug, "stale-host", 2);
    expect(await meta(slug, "assigned_host")).toBe("host-b");

    // A later ordinary REST/WS snapshot can repair an /internal/roles delivery
    // failure, but only when its D1 revision is genuinely newer.
    await incidentalSnapshot(slug, { roleRevision: "4" });
    expect(await meta(slug, "assigned_host")).toBeNull();
    expect(await meta(slug, "assigned_host_revision")).toBe("4");
  });
});

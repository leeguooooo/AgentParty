// #370 组织架构管理层级：channel_roles.reports_to 构成组织树，允许跨 owner 挂靠。
// 关键不变量：跨 owner 允许、自引用拒绝、环路拒绝、目标须为本频道已有角色。
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

async function setRole(
  slug: string,
  moderator: string,
  name: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return api(`/api/channels/${slug}/roles/${name}`, moderator, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

async function rolesOf(slug: string, token: string, name: string) {
  const res = await api(`/api/channels/${slug}/roles`, token);
  const { roles } = (await res.json()) as { roles: Array<{ name: string; reports_to?: string | null }> };
  return roles.find((r) => r.name === name);
}

describe("channel role reports_to (org hierarchy #370)", () => {
  it("round-trips reports_to and allows cross-owner reporting", async () => {
    const ownerA = `a-${uniq("acct")}@example.com`;
    const ownerB = `b-${uniq("acct")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner: ownerA });
    const lead = await seedToken("agent", uniq("lead"), { owner: ownerA });
    const worker = await seedToken("agent", uniq("worker"), { owner: ownerB }); // 不同 owner
    const slug = await createChannel(human.token);

    // 先给两个 agent 角色（reports_to 目标须为本频道已有角色）
    expect((await setRole(slug, human.token, lead.name, { role: "host" })).status).toBe(200);
    expect((await setRole(slug, human.token, worker.name, { role: "worker" })).status).toBe(200);

    // 跨 owner 挂靠：ownerB 的 worker 向 ownerA 的 lead 汇报 → 允许
    const set = await setRole(slug, human.token, worker.name, { role: "worker", reports_to: lead.name });
    expect(set.status).toBe(200);
    expect((await rolesOf(slug, human.token, worker.name))?.reports_to).toBe(lead.name);

    // 清空 → 顶层（reports_to 省略）
    expect((await setRole(slug, human.token, worker.name, { role: "worker", reports_to: null })).status).toBe(200);
    expect((await rolesOf(slug, human.token, worker.name))?.reports_to).toBeUndefined();
  });

  it("rejects self-reference, cycles, and unknown targets", async () => {
    const owner = `${uniq("acct")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const a = await seedToken("agent", uniq("a"), { owner });
    const b = await seedToken("agent", uniq("b"), { owner });
    const slug = await createChannel(human.token);
    await setRole(slug, human.token, a.name, { role: "worker" });
    await setRole(slug, human.token, b.name, { role: "worker" });

    // 自引用 → 400
    expect((await setRole(slug, human.token, a.name, { role: "worker", reports_to: a.name })).status).toBe(400);

    // 目标不是本频道角色 → 400
    expect((await setRole(slug, human.token, a.name, { role: "worker", reports_to: "ghost-agent" })).status).toBe(400);

    // 环路：a→b 后再 b→a 应被拒
    expect((await setRole(slug, human.token, a.name, { role: "worker", reports_to: b.name })).status).toBe(200);
    expect((await setRole(slug, human.token, b.name, { role: "worker", reports_to: a.name })).status).toBe(400);
  });
});

// 服务端 (identity, channel, task) 租约 —— issue #936。
//
// 被测的是「同一身份的第二个执行体拿不到这个 task」这一件事，以及它的三条边界：
//   1. 拒绝不能吞任务（#885 立的红线）——被拒时 channel_tasks 必须一个字节没动；
//   2. 必须能自愈——租期走完就能被合法接手，服务端绝不靠猜存活（#908）；
//   3. executor_id 是客户端自报的，只能用来区分同一身份的不同执行体，**绝不放大权限**。
//
// 反向用例刻意逐条翻转判定的每一个维度（task / name / principal / 频道可达性 / 角色），
// 确保「被拒」只可能由被测的那道闸产生，而不是被别的分支顺手挡掉。
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

async function createTask(slug: string, token: string, title = "claimable"): Promise<number> {
  const res = await api(`/api/channels/${slug}/tasks`, token, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  if (res.status !== 201) throw new Error(`create task failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: number }).id;
}

function claim(
  slug: string,
  id: number,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return api(`/api/channels/${slug}/tasks/${id}/lease`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function readTask(slug: string, id: number, token: string) {
  const res = await api(`/api/channels/${slug}/tasks/${id}`, token);
  return (await res.json()) as { state: string; updated_at: number; title: string };
}

/** 把租约行的到期时刻推到过去。只造「租期已走完」这个前提，判定仍走真实的认领路径。 */
async function expireLease(slug: string, id: number): Promise<void> {
  const res = await env.DB.prepare(
    "UPDATE channel_task_leases SET expires_at = ? WHERE channel_slug = ? AND task_id = ?",
  )
    .bind(1, slug, id)
    .run();
  if ((res.meta?.changes ?? 0) === 0) throw new Error("expireLease matched no row — fixture is wrong");
}

describe("server task lease (#936)", () => {
  it("同一身份的第二个执行体被拒，且拿到「谁持有、何时过期」", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(agent.token);
    const task = await createTask(slug, agent.token);

    const first = await claim(slug, task, agent.token, { executor_id: "runner:claude:a" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      type: "task_lease",
      state: "acquired",
      scope: "server",
      holder: { executor_id: "runner:claude:a", task_id: task, channel: slug },
    });

    // 同一个 token（同一身份），另一个执行体。
    const second = await claim(slug, task, agent.token, { executor_id: "session:claude:b" });
    expect(second.status).toBe(409);
    const denied = (await second.json()) as Record<string, unknown>;
    expect(denied).toMatchObject({
      error: { code: "task_lease_held" },
      state: "denied",
      scope: "server",
      reason: "held_by_other",
      task_untouched: true,
      holder: { executor_id: "runner:claude:a" },
    });
    // 一句 403 说不出「等多久 / 该不该 force」。持有者与到期时刻必须在回执里。
    const holder = denied.holder as { expires_at: number };
    expect(holder.expires_at).toBeGreaterThan(Date.now());
    expect(String((denied.error as { message: string }).message)).toContain("runner:claude:a");
  });

  it("拒绝 ≠ 吞任务：被拒那次没碰 channel_tasks 一个字节", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(agent.token);
    const task = await createTask(slug, agent.token);
    await claim(slug, task, agent.token, { executor_id: "runner:a" });

    const before = await readTask(slug, task, agent.token);
    const denied = await claim(slug, task, agent.token, { executor_id: "runner:b" });
    expect(denied.status).toBe(409);
    const after = await readTask(slug, task, agent.token);
    expect(after).toEqual(before);
    // 持租者仍然照常干活：它的认领路径没有被这次拒绝影响。
    const patched = await api(`/api/channels/${slug}/tasks/${task}`, agent.token, {
      method: "PATCH",
      body: JSON.stringify({ state: "in_progress" }),
    });
    expect(patched.status).toBe(200);
  });

  it("持租者续期：acquired_at 不变、到期时刻前移，state=renewed", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(agent.token);
    const task = await createTask(slug, agent.token);

    const first = (await (await claim(slug, task, agent.token, { executor_id: "runner:a" })).json()) as {
      holder: { acquired_at: number; expires_at: number };
    };
    await new Promise((r) => setTimeout(r, 5));
    const again = await claim(slug, task, agent.token, { executor_id: "runner:a" });
    expect(again.status).toBe(200);
    const renewed = (await again.json()) as { state: string; holder: { acquired_at: number; expires_at: number } };
    expect(renewed.state).toBe("renewed");
    expect(renewed.holder.acquired_at).toBe(first.holder.acquired_at);
    expect(renewed.holder.expires_at).toBeGreaterThan(first.holder.expires_at);
  });

  it("自愈：租期走完后另一个执行体能合法接手（不需要任何人来解锁）", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(agent.token);
    const task = await createTask(slug, agent.token);
    await claim(slug, task, agent.token, { executor_id: "runner:dead" });

    // 先确认闸真的是落着的——否则下面的「接手成功」可能只是闸从来没落下。
    expect((await claim(slug, task, agent.token, { executor_id: "runner:next" })).status).toBe(409);

    await expireLease(slug, task);
    const taken = await claim(slug, task, agent.token, { executor_id: "runner:next" });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ state: "acquired", holder: { executor_id: "runner:next" } });
  });

  it("force 显式抢占活租约，并把被抢的那个记进 taken_over_from", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(agent.token);
    const task = await createTask(slug, agent.token);
    await claim(slug, task, agent.token, { executor_id: "runner:incumbent" });

    const forced = await claim(slug, task, agent.token, { executor_id: "runner:taker", force: true });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({
      state: "forced",
      reason: "taken_over",
      holder: { executor_id: "runner:taker", taken_over_from: "runner:incumbent" },
    });
  });

  it("release 只删自己的那张；别人的租约动不了", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(agent.token);
    const task = await createTask(slug, agent.token);
    await claim(slug, task, agent.token, { executor_id: "runner:holder" });

    const foreign = await claim(slug, task, agent.token, { op: "release", executor_id: "runner:other" });
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toMatchObject({ state: "released", released: false });
    // 没被删掉：闸还落着。
    expect((await claim(slug, task, agent.token, { executor_id: "runner:other" })).status).toBe(409);

    const own = await claim(slug, task, agent.token, { op: "release", executor_id: "runner:holder" });
    expect(await own.json()).toMatchObject({ state: "released", released: true });
    expect((await claim(slug, task, agent.token, { executor_id: "runner:other" })).status).toBe(200);
  });

  it("租期被服务端钳到上限：自报的 ttl 挡不出一个无限期死锁", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(agent.token);
    const task = await createTask(slug, agent.token);

    const res = await claim(slug, task, agent.token, { executor_id: "runner:greedy", ttl_ms: 365 * 24 * 3600_000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ttl_ms: number; holder: { expires_at: number } };
    expect(body.ttl_ms).toBe(60 * 60_000);
    expect(body.holder.expires_at).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
  });

  describe("反向用例：闸只该在 (identity, channel, task) 全部相同时落下", () => {
    it("不同 task 不互相阻塞", async () => {
      const owner = `${uniq("owner")}@example.com`;
      const agent = await seedToken("agent", uniq("agent"), { owner });
      const slug = await createChannel(agent.token);
      const a = await createTask(slug, agent.token, "a");
      const b = await createTask(slug, agent.token, "b");
      await claim(slug, a, agent.token, { executor_id: "runner:1" });
      expect((await claim(slug, b, agent.token, { executor_id: "runner:2" })).status).toBe(200);
    });

    it("不同频道的同号 task 不互相阻塞", async () => {
      const owner = `${uniq("owner")}@example.com`;
      const agent = await seedToken("agent", uniq("agent"), { owner });
      const one = await createChannel(agent.token);
      const two = await createChannel(agent.token);
      const t1 = await createTask(one, agent.token);
      const t2 = await createTask(two, agent.token);
      await claim(one, t1, agent.token, { executor_id: "runner:1" });
      expect((await claim(two, t2, agent.token, { executor_id: "runner:2" })).status).toBe(200);
    });

    it("不同身份不互相阻塞（两个 agent 各自认领同一个 task）", async () => {
      const owner = `${uniq("owner")}@example.com`;
      const a = await seedToken("agent", uniq("agent-a"), { owner });
      const b = await seedToken("agent", uniq("agent-b"), { owner });
      const slug = await createChannel(a.token);
      const task = await createTask(slug, a.token);
      await claim(slug, task, a.token, { executor_id: "runner:same" });
      // 同名 executor_id 也不该串——判定的三要素里 identity_name 不同。
      expect((await claim(slug, task, b.token, { executor_id: "runner:same" })).status).toBe(200);
    });

    it("同名不同 principal 不互相阻塞（token 撤销后同名重铸给另一个 owner）", async () => {
      // 真实形状：老 token 被撤销、同一个 name 重新铸给另一个账号。新 owner 不该继承旧 owner
      // 的租约，也不该被旧 owner 留下的租约压住——判定的第三个维度是 principal，不只是 name。
      const host = await seedToken("human", uniq("host"), { owner: `${uniq("host")}@example.com` });
      const slug = uniq("ch");
      const created = await api("/api/channels", host.token, {
        method: "POST",
        body: JSON.stringify({ slug, kind: "standing", visibility: "public" }),
      });
      expect(created.status).toBe(201);
      const task = await createTask(slug, host.token);

      const name = uniq("reminted");
      const first = await seedToken("agent", name, { owner: `${uniq("o1")}@example.com` });
      expect((await claim(slug, task, first.token, { executor_id: "runner:old-owner" })).status).toBe(200);

      await env.DB.prepare("DELETE FROM tokens WHERE name = ?").bind(name).run();
      const second = await seedToken("agent", name, { owner: `${uniq("o2")}@example.com` });
      expect((await claim(slug, task, second.token, { executor_id: "runner:new-owner" })).status).toBe(200);
      // 旧 owner 那张租约仍在（没被新 owner 顺手抹掉），只是不再挡任何人。
      const rows = await env.DB.prepare(
        "SELECT executor_id FROM channel_task_leases WHERE channel_slug = ? AND task_id = ?",
      )
        .bind(slug, task)
        .all<{ executor_id: string }>();
      expect((rows.results ?? []).map((r) => r.executor_id).sort()).toEqual(["runner:new-owner", "runner:old-owner"]);
    });
  });

  describe("executor_id 不可成为伪造点", () => {
    it("换 executor_id 够不着一个本来就够不着的频道（鉴权在租约之前）", async () => {
      const insider = await seedToken("agent", uniq("insider"), { owner: `${uniq("in")}@example.com` });
      const outsider = await seedToken("agent", uniq("outsider"), { owner: `${uniq("out")}@example.com` });
      const slug = await createChannel(insider.token);
      const task = await createTask(slug, insider.token);
      await claim(slug, task, insider.token, { executor_id: "runner:insider" });

      // 冒充持租者的 executor_id 也一样：403，且不是 409——它连冲突判定都没走到。
      const res = await claim(slug, task, outsider.token, { executor_id: "runner:insider" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    });

    it("readonly token 换任何 executor_id 都拿不到租约", async () => {
      // 频道刻意设成 public：readonly 这一刀必须是**唯一**决定结果的那道闸。若沿用私有频道，
      // canAccessLoadedChannel 会先把它挡掉，403 照样出现，而 readonly 判定被整个遮住——
      // 删掉那行代码测试也全绿（实测：这条用例的第一版正是这个形状）。
      const host = await seedToken("human", uniq("host"), { owner: `${uniq("host")}@example.com` });
      const slug = uniq("ch");
      expect(
        (await api("/api/channels", host.token, {
          method: "POST",
          body: JSON.stringify({ slug, kind: "standing", visibility: "public" }),
        })).status,
      ).toBe(201);
      const task = await createTask(slug, host.token);

      const ro = await seedToken("readonly", uniq("ro"), { owner: `${uniq("ro")}@example.com` });
      // 先证明这个 readonly token 确实够得着这个频道（读得到任务）——否则下面的 403 说明不了问题。
      expect((await api(`/api/channels/${slug}/tasks/${task}`, ro.token)).status).toBe(200);
      const res = await claim(slug, task, ro.token, { executor_id: "runner:sneaky" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "forbidden", message: expect.stringContaining("readonly") } });
    });

    it("租约端点从不改任务状态——伪造 executor_id 也推不动 channel_tasks", async () => {
      const owner = `${uniq("owner")}@example.com`;
      const agent = await seedToken("agent", uniq("agent"), { owner });
      const slug = await createChannel(agent.token);
      const task = await createTask(slug, agent.token);
      const before = await readTask(slug, task, agent.token);
      await claim(slug, task, agent.token, { executor_id: "runner:a" });
      await claim(slug, task, agent.token, { executor_id: "runner:a", force: true });
      await claim(slug, task, agent.token, { op: "release", executor_id: "runner:a" });
      expect(await readTask(slug, task, agent.token)).toEqual(before);
    });

    it("非法 executor_id 一律 400（客户端与服务端共用 shared 的同一份判据）", async () => {
      const owner = `${uniq("owner")}@example.com`;
      const agent = await seedToken("agent", uniq("agent"), { owner });
      const slug = await createChannel(agent.token);
      const task = await createTask(slug, agent.token);
      for (const bad of ["", "-leading-dash", "with space", "x".repeat(129), 42, null]) {
        const res = await claim(slug, task, agent.token, { executor_id: bad });
        expect(res.status, `executor_id=${JSON.stringify(bad)}`).toBe(400);
      }
    });
  });

  describe("新旧兼容", () => {
    it("老客户端不送 executor_id 也照改任务状态——PATCH 从不要求租约", async () => {
      const owner = `${uniq("owner")}@example.com`;
      const agent = await seedToken("agent", uniq("agent"), { owner });
      const slug = await createChannel(agent.token);
      const task = await createTask(slug, agent.token);
      await claim(slug, task, agent.token, { executor_id: "runner:holder" });

      // 老客户端（从不调用租约端点）在别人持租时仍能推进任务：不能因为不送字段就被拒。
      const patched = await api(`/api/channels/${slug}/tasks/${task}`, agent.token, {
        method: "PATCH",
        body: JSON.stringify({ state: "in_progress" }),
      });
      expect(patched.status).toBe(200);
      expect((await patched.json()) as { state: string }).toMatchObject({ state: "in_progress" });
    });

    it("/api/version 声明 task_lease 能力", async () => {
      const res = await api("/api/version", "unused");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { features: string[] }).features).toContain("task_lease");
    });

    it("不存在的 task 报 not_found（带 error.code），与老服务端「路由没命中」的裸 404 形状不同", async () => {
      const owner = `${uniq("owner")}@example.com`;
      const agent = await seedToken("agent", uniq("agent"), { owner });
      const slug = await createChannel(agent.token);
      const res = await claim(slug, 987654, agent.token, { executor_id: "runner:a" });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

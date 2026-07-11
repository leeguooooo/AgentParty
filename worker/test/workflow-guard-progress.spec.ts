// #106：workflow guard 的「进展」判定不能被状态交替愚弄。
// 旧盲区：workflowProgressed 只比对「紧邻上一行」——两个 agent 各在不同 (step,state) 之间
// 来回上报，每一帧都「不同于上一帧」→ 永远判为进展 → no-progress 计数永远归零 → guard 永不 trip，
// 双 agent A↔B ping-pong 可以无人值守地跑到天亮。修复后用「近期 (step,state) 窗口」判定：
// 回到窗口里见过的 tuple = 非进展，计数继续累加，最终 trip。
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

const workflow = (step_id: string, state = "working", workflow_id = "wf-loop", run_id = "run-1") => ({
  workflow_id,
  kind: "pipeline" as const,
  run_id,
  step_id,
  state,
});

function postStatus(
  slug: string,
  token: string,
  body: {
    state: "working" | "waiting" | "blocked" | "done";
    note: string;
    workflow: ReturnType<typeof workflow>;
  },
) {
  const { state: _wfState, ...wf } = body.workflow;
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "status",
      state: body.state,
      note: body.note,
      mentions: [],
      workflow: wf,
    }),
  });
}

async function configureWorkflowGuard(slug: string, token: string, limit: number, enabled = true) {
  return api(`/api/channels/${slug}/workflow-guard`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled, limit }),
  });
}

describe("workflow guard progress detection resists state oscillation (#106)", () => {
  it("two agents alternating between two (step,state) tuples on one run eventually trip the guard", async () => {
    const owner = `${uniq("acct")}@leeguoo.com`;
    const agentA = await seedToken("agent", uniq("wf-a"), { owner });
    const agentB = await seedToken("agent", uniq("wf-b"), { owner });
    const slug = await createChannel(agentA.token);

    expect((await configureWorkflowGuard(slug, agentA.token, 2)).status).toBe(200);

    // 播种两个 tuple：第一次见到 step-a 与 step-b 都是真进展 → 计数保持 0。
    expect(
      (await postStatus(slug, agentA.token, { state: "working", note: "A step-a", workflow: workflow("step-a") })).status,
    ).toBe(200);
    expect(
      (await postStatus(slug, agentB.token, { state: "working", note: "B step-b", workflow: workflow("step-b") })).status,
    ).toBe(200);

    // 之后就是纯振荡：两 agent 在同一 run 的 step-a / step-b 之间来回，没有任何新状态。
    // 旧代码把每一次翻转都当进展 → 永不 trip；新代码把「回到窗口里见过的 tuple」判为非进展 → 计数累加。
    const oscillation = [
      await postStatus(slug, agentA.token, { state: "working", note: "A step-a again", workflow: workflow("step-a") }),
      await postStatus(slug, agentB.token, { state: "working", note: "B step-b again", workflow: workflow("step-b") }),
      await postStatus(slug, agentA.token, { state: "working", note: "A step-a yet again", workflow: workflow("step-a") }),
    ];

    // 前两次振荡累加计数（limit=2），第三次因 no_progress 已置位而被 pre-insert 拦截为 409。
    expect(oscillation[0]!.status).toBe(200);
    expect(oscillation[1]!.status).toBe(200);
    expect(oscillation[2]!.status).toBe(409);
    expect(((await oscillation[2]!.json()) as { error: { code: string } }).error.code).toBe("workflow_guard");
  });

  it("a genuinely forward-advancing workflow (new step each turn) does NOT trip within the limit", async () => {
    const owner = `${uniq("acct")}@leeguoo.com`;
    const agent = await seedToken("agent", uniq("wf-fwd"), { owner });
    const slug = await createChannel(agent.token);

    // limit=2 是最激进的设置；即便如此，只要每一帧都是没见过的新 (step,state)，就永远是进展、永不 trip。
    expect((await configureWorkflowGuard(slug, agent.token, 2)).status).toBe(200);

    for (let i = 0; i < 8; i++) {
      const res = await postStatus(slug, agent.token, {
        state: "working",
        note: `forward step ${i}`,
        workflow: workflow(`step-${i}`, "working", "wf-fwd"),
      });
      expect(res.status).toBe(200);
    }
  });

  it("returning to a state seen earlier in the run but different from the immediately-previous frame is NOT progress", async () => {
    // 精确咬住盲区：A→B→A。旧代码里第二个 A「不同于上一帧 B」→ 判进展；新代码里 A 在窗口内 → 非进展。
    const owner = `${uniq("acct")}@leeguoo.com`;
    const agent = await seedToken("agent", uniq("wf-rev"), { owner });
    const slug = await createChannel(agent.token);

    expect((await configureWorkflowGuard(slug, agent.token, 1)).status).toBe(200);

    expect(
      (await postStatus(slug, agent.token, { state: "working", note: "A", workflow: workflow("step-a", "working", "wf-rev") }))
        .status,
    ).toBe(200);
    expect(
      (await postStatus(slug, agent.token, { state: "working", note: "B", workflow: workflow("step-b", "working", "wf-rev") }))
        .status,
    ).toBe(200);
    // 回到 step-a：窗口内已有 → 非进展 → 计数 1，limit=1 → 置位 no_progress（本帧仍 200）。
    expect(
      (await postStatus(slug, agent.token, { state: "working", note: "A again", workflow: workflow("step-a", "working", "wf-rev") }))
        .status,
    ).toBe(200);
    // 再翻回 step-b：no_progress 已置位且仍非进展 → 409。
    const blocked = await postStatus(slug, agent.token, {
      state: "working",
      note: "B again",
      workflow: workflow("step-b", "working", "wf-rev"),
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("workflow_guard");
  });
});

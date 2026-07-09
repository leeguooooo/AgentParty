import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

const workflow = (workflow_id: string, step_id = "step-1", run_id = "run-1") => ({
  workflow_id,
  kind: "pipeline",
  run_id,
  step_id,
});

function postStatus(
  slug: string,
  token: string,
  body: {
    state: "working" | "waiting" | "blocked" | "done";
    note: string;
    mentions?: string[];
    role?: "host" | "worker" | "reviewer" | "observer";
    workflow?: ReturnType<typeof workflow>;
  },
) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({
      kind: "status",
      state: body.state,
      note: body.note,
      mentions: body.mentions ?? [],
      ...(body.role === undefined ? {} : { role: body.role }),
      ...(body.workflow === undefined ? {} : { workflow: body.workflow }),
    }),
  });
}

async function configureWorkflowGuard(slug: string, token: string, limit: number, enabled = true) {
  return api(`/api/channels/${slug}/workflow-guard`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled, limit }),
  });
}

describe("workflow no-progress guard", () => {
  it("defaults to unlimited but can be enabled per channel with a limit", async () => {
    const ownerAccount = `${uniq("acct")}@leeguoo.com`;
    const workerA = await seedToken("agent", uniq("worker-a"), { owner: ownerAccount });
    const host = await seedToken("human", uniq("host"), { owner: ownerAccount });
    const slug = await createChannel(workerA.token);

    expect((await postStatus(slug, host.token, { state: "working", note: "hosting", role: "host" })).status).toBe(200);
    expect((await postStatus(slug, workerA.token, {
      state: "working",
      note: "wf-a started",
      workflow: workflow("wf-a"),
    })).status).toBe(200);

    expect((await postMessage(slug, workerA.token, "still investigating 1")).status).toBe(200);
    expect((await postMessage(slug, workerA.token, "still investigating 2")).status).toBe(200);
    expect((await postMessage(slug, workerA.token, "still investigating 3")).status).toBe(200);

    const enabled = await configureWorkflowGuard(slug, workerA.token, 2);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ enabled: true, limit: 2 });
    expect((await postStatus(slug, workerA.token, {
      state: "working",
      note: "wf-b started",
      workflow: workflow("wf-b"),
    })).status).toBe(200);
    expect((await postMessage(slug, workerA.token, "wf-b no progress 1")).status).toBe(200);
    expect((await postMessage(slug, workerA.token, "wf-b no progress 2")).status).toBe(200);
    const limited = await postMessage(slug, workerA.token, "wf-b stale");
    expect(limited.status).toBe(409);
    expect((await limited.json()) as { error: { code: string; message: string } }).toMatchObject({
      error: { code: "workflow_guard", message: expect.stringContaining("wf-b") },
    });

    const reset = await api(`/api/channels/${slug}/workflows/wf-reset/reset-guard`, host.token, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true, workflow_id: "wf-reset" });
    const disabled = await api(`/api/channels/${slug}/workflow-guard`, host.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ enabled: false, limit: null });
    expect((await postMessage(slug, workerA.token, "after workflow reset")).status).toBe(200);
  });
});

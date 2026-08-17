import { describe, expect, test } from "bun:test";
import {
  parseWorkerDeployGateArguments,
  selectWorkerDeployRun,
  waitForWorkerDeploy,
} from "./wait-worker-deploy";

const SHA = "a".repeat(40);
const TAG = "v1.2.3";
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 10,
  head_sha: SHA,
  head_branch: TAG,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/o/r/actions/runs/10",
  ...overrides,
});

describe("worker deploy release gate", () => {
  test("parses only one exact repository, commit, and release tag", () => {
    expect(parseWorkerDeployGateArguments([
      "--repository", "o/r",
      "--sha", SHA,
      "--tag", TAG,
    ])).toEqual({ repository: "o/r", sha: SHA, tag: TAG });
    for (const argv of [
      [],
      ["--repository", "o/r", "--sha", SHA],
      ["--repository", "o/r", "--sha", "main", "--tag", TAG],
      ["--repository", "o/r", "--sha", SHA, "--tag", "main"],
      ["--repository", "o/r", "--sha", SHA, "--tag", TAG, "--tag", TAG],
    ]) expect(() => parseWorkerDeployGateArguments(argv)).toThrow();
  });

  test("selects the newest run only when both tag and SHA match", () => {
    expect(selectWorkerDeployRun({
      workflow_runs: [
        run({ id: 11, head_sha: "b".repeat(40) }),
        run({ id: 12, head_branch: "v9.9.9" }),
        run({ id: 13 }),
        run({ id: 14 }),
      ],
    }, SHA, TAG)?.id).toBe(14);
    expect(selectWorkerDeployRun({ workflow_runs: [run({ head_branch: "main" })] }, SHA, TAG)).toBeNull();
  });

  test("waits through queued state and returns only exact completed success", async () => {
    let calls = 0;
    let now = 0;
    const result = await waitForWorkerDeploy(
      { repository: "o/r", sha: SHA, tag: TAG },
      "token",
      {
        fetchImpl: async () => Response.json({
          workflow_runs: [run(calls++ === 0
            ? { status: "queued", conclusion: null }
            : {})],
        }),
        now: () => now,
        delay: async (ms) => { now += ms; },
        timeoutMs: 1_000,
        pollMs: 10,
      },
    );
    expect(result.id).toBe(10);
    expect(calls).toBe(2);
  });

  test("fails closed for terminal failure, missing exact run, timeout, and unavailable API", async () => {
    const options = { repository: "o/r", sha: SHA, tag: TAG };
    await expect(waitForWorkerDeploy(options, "token", {
      fetchImpl: async () => Response.json({ workflow_runs: [run({ conclusion: "failure" })] }),
    })).rejects.toMatchObject({ code: "worker_deploy_failed" });

    let missingNow = 0;
    await expect(waitForWorkerDeploy(options, "token", {
      fetchImpl: async () => Response.json({ workflow_runs: [] }),
      now: () => missingNow,
      delay: async (ms) => { missingNow += ms; },
      timeoutMs: 10,
      pollMs: 10,
    })).rejects.toMatchObject({ code: "worker_deploy_not_found" });

    let queuedNow = 0;
    await expect(waitForWorkerDeploy(options, "token", {
      fetchImpl: async () => Response.json({ workflow_runs: [run({ status: "in_progress", conclusion: null })] }),
      now: () => queuedNow,
      delay: async (ms) => { queuedNow += ms; },
      timeoutMs: 10,
      pollMs: 10,
    })).rejects.toMatchObject({ code: "worker_deploy_timeout" });

    await expect(waitForWorkerDeploy(options, "token", {
      fetchImpl: async () => new Response(null, { status: 403 }),
    })).rejects.toMatchObject({ code: "github_api_unavailable" });
    await expect(waitForWorkerDeploy(options, "")).rejects.toMatchObject({ code: "auth_required" });
  });
});

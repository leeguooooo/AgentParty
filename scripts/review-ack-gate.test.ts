import { describe, expect, test } from "bun:test";
import {
  evaluateReviewAck,
  runReviewAckGate,
  selectWorkflowPullNumber,
  type ReviewAckInput,
} from "./review-ack-gate.mjs";

const headSha = "abc123";
const user = (login: string, type: "User" | "Bot" = "User") => ({ login, type });
const completedChecks = [
  { name: "pr_agent", status: "completed", conclusion: "success", started_at: "2026-07-13T10:00:00Z" },
];
const codeRabbitStatus = [{ context: "CodeRabbit", state: "success", updated_at: "2026-07-13T10:02:00Z" }];
const codeRabbitReview = {
  user: user("coderabbitai[bot]", "Bot"),
  state: "COMMENTED",
  commit_id: headSha,
  submitted_at: "2026-07-13T10:02:00Z",
};
const prAgentGuide = {
  user: user("github-actions[bot]", "Bot"),
  body: "## PR Reviewer Guide 🔍",
  created_at: "2026-07-13T10:01:00Z",
  updated_at: "2026-07-13T10:01:00Z",
};

function evaluate(over: Partial<ReviewAckInput> = {}) {
  return evaluateReviewAck({
    headSha,
    reviews: [codeRabbitReview],
    comments: [prAgentGuide],
    checkRuns: completedChecks,
    statuses: codeRabbitStatus,
    ...over,
  });
}

describe("review-ack ordering gate (#460)", () => {
  test("workflow reruns after PR Agent completion with the permissions the script needs", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/review-ack.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain('workflows: ["PR Agent (qwen · soft-gate)"]');
    expect(workflow).toContain("checks: read");
    expect(workflow).toContain("statuses: write");
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("run: node scripts/review-ack-gate.mjs");
    expect(workflow).toContain("WORKFLOW_HEAD_SHA: ${{ github.event.workflow_run.head_sha }}");
    expect(workflow).toContain(
      "KNOWN_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.event.workflow_run.head_sha }}",
    );
    expect(workflow).not.toContain("workflow_run.pull_requests[0]");
  });

  test("known event head is marked failure before PR resolution can fail", async () => {
    const statusCalls: Array<{ sha: string; ok: boolean; description: string }> = [];
    await expect(
      runReviewAckGate(
        { REPO: "owner/repo", GH_TOKEN: "token", PR: "42", KNOWN_HEAD_SHA: headSha },
        {
          githubJson: async () => {
            throw new Error("simulated pull lookup failure");
          },
          postStatus: async (_repo, sha, _token, result) => {
            statusCalls.push({ sha, ok: result.ok, description: result.description });
          },
        },
      ),
    ).rejects.toThrow("simulated pull lookup failure");
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    expect(statusCalls[0]).toEqual({
      sha: headSha,
      ok: false,
      description: "正在解析 PR 并核验当前 head 的 bot review 与人工 ack",
    });
  });

  test("workflow_run uses head SHA to resolve the only open PR", () => {
    expect(
      selectWorkflowPullNumber(headSha, [
        { number: 40, state: "closed", head: { sha: headSha } },
        { number: 41, state: "open", head: { sha: "old-head" } },
        { number: 42, state: "open", head: { sha: headSha } },
      ]),
    ).toBe("42");
    expect(() => selectWorkflowPullNumber(headSha, [])).toThrow("found 0");
    expect(() =>
      selectWorkflowPullNumber(headSha, [
        { number: 42, state: "open", head: { sha: headSha } },
        { number: 43, state: "open", head: { sha: headSha } },
      ]),
    ).toThrow("found 2");
  });

  test("ack posted before bot reviews stays red", () => {
    const result = evaluate({
      comments: [
        { user: user("maintainer"), body: "review-ack: looks good", created_at: "2026-07-13T09:59:00Z" },
        prAgentGuide,
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("stale_ack");
  });

  test("ack posted after pr_agent and CodeRabbit reviews turns green", () => {
    const result = evaluate({
      comments: [
        prAgentGuide,
        { user: user("maintainer"), body: "review-ack: valid findings fixed", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("ack_after_reviews");
  });

  test("pr_agent endpoint failure does not block when its workflow completed without a comment", () => {
    const result = evaluate({
      comments: [
        { user: user("maintainer"), body: "review-ack: read CodeRabbit", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("waits for current-head CodeRabbit review even if a stale review exists", () => {
    const result = evaluate({
      reviews: [{ ...codeRabbitReview, commit_id: "old-head" }],
      comments: [
        prAgentGuide,
        { user: user("maintainer"), body: "review-ack: early", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("waiting_coderabbit");
  });

  test("rejects a human reviewer whose login only looks like CodeRabbit", () => {
    const result = evaluate({
      reviews: [{ ...codeRabbitReview, user: user("coderabbit-fan", "User") }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("waiting_coderabbit");
  });

  test("never accepts an ack when no bot review artifact exists", () => {
    const result = evaluate({
      requireCodeRabbit: false,
      reviews: [],
      comments: [
        { user: user("maintainer"), body: "review-ack: no bot review", created_at: "2026-07-13T10:03:00Z" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_bot_review");
  });

  test("waits for the current-head pr_agent workflow to finish", () => {
    const result = evaluate({
      checkRuns: [{ ...completedChecks[0], status: "in_progress", conclusion: null }],
      comments: [{ user: user("maintainer"), body: "review-ack: early", created_at: "2026-07-13T10:03:00Z" }],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("waiting_pr_agent");
  });
});

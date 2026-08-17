const SCHEMA = "agentparty.worker-deploy-release-gate.v1";
const WORKFLOW = "worker-deploy.yml";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type WorkerDeployGateErrorCode =
  | "invalid_arguments"
  | "auth_required"
  | "github_api_unavailable"
  | "worker_deploy_not_found"
  | "worker_deploy_timeout"
  | "worker_deploy_failed";

export class WorkerDeployGateError extends Error {
  constructor(readonly code: WorkerDeployGateErrorCode) {
    super(code);
    this.name = "WorkerDeployGateError";
  }
}

export interface WorkerDeployRun {
  id: number;
  head_sha: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

interface WorkerDeployGateArguments {
  repository: string;
  sha: string;
  tag: string;
}

export type WorkerDeployGateFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface WorkerDeployGateDependencies {
  fetchImpl?: WorkerDeployGateFetch;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRun(value: unknown): WorkerDeployRun | null {
  if (!record(value)) return null;
  if (
    typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id <= 0 ||
    typeof value.head_sha !== "string" || typeof value.head_branch !== "string" ||
    typeof value.status !== "string" ||
    !(typeof value.conclusion === "string" || value.conclusion === null) ||
    typeof value.html_url !== "string"
  ) return null;
  return {
    id: value.id,
    head_sha: value.head_sha,
    head_branch: value.head_branch,
    status: value.status,
    conclusion: value.conclusion,
    html_url: value.html_url,
  };
}

/** Select only the newest run bound to this exact tag and commit. */
export function selectWorkerDeployRun(payload: unknown, sha: string, tag: string): WorkerDeployRun | null {
  if (!record(payload) || !Array.isArray(payload.workflow_runs)) return null;
  return payload.workflow_runs
    .map(parseRun)
    .filter((run): run is WorkerDeployRun => run !== null && run.head_sha === sha && run.head_branch === tag)
    .sort((left, right) => right.id - left.id)[0] ?? null;
}

export function parseWorkerDeployGateArguments(argv: readonly string[]): WorkerDeployGateArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      value === undefined ||
      !["--repository", "--sha", "--tag"].includes(flag ?? "") ||
      values.has(flag!)
    ) throw new WorkerDeployGateError("invalid_arguments");
    values.set(flag!, value);
  }
  const repository = values.get("--repository") ?? "";
  const sha = values.get("--sha") ?? "";
  const tag = values.get("--tag") ?? "";
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[a-f0-9]{40}$/i.test(sha) ||
    !/^v[A-Za-z0-9._-]{1,80}$/.test(tag)
  ) throw new WorkerDeployGateError("invalid_arguments");
  return { repository, sha: sha.toLowerCase(), tag };
}

function apiUrl(repository: string, sha: string): string {
  const repo = repository.split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams({ event: "push", head_sha: sha, per_page: "20" });
  return `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?${query}`;
}

export async function waitForWorkerDeploy(
  input: WorkerDeployGateArguments,
  token: string,
  deps: WorkerDeployGateDependencies = {},
): Promise<WorkerDeployRun> {
  if (token === "") throw new WorkerDeployGateError("auth_required");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + timeoutMs;
  let apiObserved = false;
  let runObserved = false;

  for (;;) {
    try {
      const response = await fetchImpl(apiUrl(input.repository, input.sha), {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "agentparty-release-gate",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new WorkerDeployGateError("github_api_unavailable");
      }
      if (response.ok) {
        apiObserved = true;
        const run = selectWorkerDeployRun(await response.json().catch(() => null), input.sha, input.tag);
        if (run !== null) {
          runObserved = true;
          if (run.status === "completed") {
            if (run.conclusion === "success") return run;
            throw new WorkerDeployGateError("worker_deploy_failed");
          }
        }
      }
    } catch (error) {
      if (error instanceof WorkerDeployGateError) throw error;
      // Transient API/network failures retry inside the same release deadline.
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new WorkerDeployGateError(
        runObserved
          ? "worker_deploy_timeout"
          : apiObserved
            ? "worker_deploy_not_found"
            : "github_api_unavailable",
      );
    }
    await delay(Math.min(pollMs, remaining));
  }
}

export async function runWorkerDeployReleaseGate(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: bun scripts/wait-worker-deploy.ts --repository OWNER/REPO --sha COMMIT --tag vX.Y.Z");
    return 0;
  }
  let input: WorkerDeployGateArguments;
  try {
    input = parseWorkerDeployGateArguments(argv);
  } catch {
    console.log(JSON.stringify({
      schema: SCHEMA,
      status: "failed",
      error_code: "invalid_arguments",
      release_publish_allowed: false,
    }));
    return 9;
  }
  try {
    const run = await waitForWorkerDeploy(input, process.env.GH_TOKEN ?? "");
    console.log(JSON.stringify({
      schema: SCHEMA,
      status: "passed",
      workflow: WORKFLOW,
      run_id: run.id,
      tag: input.tag,
      head_sha: input.sha,
      conclusion: "success",
      run_url: run.html_url,
      release_publish_allowed: true,
    }));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({
      schema: SCHEMA,
      status: "failed",
      error_code: error instanceof WorkerDeployGateError ? error.code : "github_api_unavailable",
      release_publish_allowed: false,
    }));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runWorkerDeployReleaseGate(process.argv.slice(2));
}

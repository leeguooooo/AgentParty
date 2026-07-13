export type ReviewAckCode =
  | "waiting_pr_agent"
  | "waiting_coderabbit"
  | "missing_bot_review"
  | "missing_ack"
  | "stale_ack"
  | "ack_after_reviews";

export interface ReviewAckResult {
  ok: boolean;
  code: ReviewAckCode;
  description: string;
  latestAckAt?: number;
  latestBotReviewAt?: number;
}

export interface ReviewAckUser {
  login?: string;
  type?: string;
}

export interface ReviewAckReview {
  user?: ReviewAckUser;
  state?: string;
  commit_id?: string;
  submitted_at?: string;
  updated_at?: string;
  created_at?: string;
}

export interface ReviewAckComment {
  user?: ReviewAckUser;
  body?: string;
  updated_at?: string;
  created_at?: string;
}

export interface ReviewAckPrAgentRun {
  name?: string;
  path?: string;
  head_sha?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  run_started_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ReviewAckStatus {
  context?: string;
  state?: string;
  updated_at?: string;
  created_at?: string;
}

export interface ReviewAckInput {
  headSha: string;
  reviews?: ReviewAckReview[];
  comments?: ReviewAckComment[];
  prAgentRuns?: ReviewAckPrAgentRun[];
  statuses?: ReviewAckStatus[];
  requireCodeRabbit?: boolean;
}

export function evaluateReviewAck(input: ReviewAckInput): ReviewAckResult;

export interface WorkflowPull {
  number?: number;
  state?: string;
  head?: { sha?: string };
}

export function selectWorkflowPullNumber(headSha: string, pulls: WorkflowPull[]): string;

export type GitHubRequest = (input: string, init?: RequestInit) => Promise<Response>;

export function githubJson<T = unknown, K extends string = string>(
  path: string,
  token: string,
  collectionKey: K,
  request?: GitHubRequest,
): Promise<Record<string, unknown> & Record<K, T[]>>;
export function githubJson<T = unknown>(
  path: string,
  token: string,
  collectionKey?: undefined,
  request?: GitHubRequest,
): Promise<T>;

export interface ReviewAckDependencies {
  githubJson: typeof githubJson;
  request?: GitHubRequest;
  postStatus(
    repo: string,
    sha: string,
    token: string,
    result: { ok: boolean; description: string },
  ): Promise<void>;
}

export function runReviewAckGate(
  env: Record<string, string | undefined>,
  dependencies?: ReviewAckDependencies,
): Promise<{ pr: string; headSha: string; result: ReviewAckResult }>;

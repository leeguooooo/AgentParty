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

export interface ReviewAckCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string;
  created_at?: string;
  completed_at?: string;
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
  checkRuns?: ReviewAckCheckRun[];
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

export function retryDelaysMs(attempts?: number): number[];
export interface SmokeRetryOptions {
  attempts?: number;
  delays?: number[];
  settleMs?: number;
  sleep?: (ms: number) => Promise<void> | void;
  log?: (line: string) => void;
}
export function runSmokeWithRetry(
  label: string,
  attempt: () => unknown | Promise<unknown>,
  options?: SmokeRetryOptions,
): Promise<void>;

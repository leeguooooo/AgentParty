import { closeSync, openSync, writeFileSync } from "node:fs";

type CrossSessionProcessSide = "sender" | "receiver";
type CrossSessionProcessExit =
  | { side: CrossSessionProcessSide; code: number }
  | { side: CrossSessionProcessSide; error: unknown };

type CrossSessionReadinessResult<T> =
  | { kind: "ready"; value: T }
  | { kind: "readiness_error"; error: unknown }
  | { kind: "receiver_exit"; code: number }
  | { kind: "receiver_exit_error"; error: unknown };

function requirePositiveTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("acceptance timeout must be a positive finite number");
  }
}

export interface CrossSessionProbeResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CrossSessionProbeOutputStream = "probe_stdout" | "probe_stderr";
export const CROSS_SESSION_PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export class CrossSessionProbeOutputLimitError extends Error {
  constructor(
    readonly stream: CrossSessionProbeOutputStream,
    readonly limit: number,
  ) {
    super(`${stream} exceeded byte limit ${limit}`);
    this.name = "CrossSessionProbeOutputLimitError";
  }
}

export type CrossSessionOutputStream =
  | "sender_stdout"
  | "sender_stderr"
  | "receiver_stdout"
  | "receiver_stderr";
export type CrossSessionOutputLimitKind = "total_bytes" | "line_bytes" | "line_count";

export interface CrossSessionOutputLimits {
  maxBytes: number;
  maxLineBytes: number;
  maxLines: number;
}

export interface CrossSessionOutputLimitReport {
  stream: CrossSessionOutputStream;
  kind: CrossSessionOutputLimitKind;
  limit: number;
}

export const CROSS_SESSION_OUTPUT_LIMITS: Readonly<CrossSessionOutputLimits> = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxLines: 8_192,
});

export class CrossSessionOutputLimitError extends Error {
  constructor(
    readonly stream: CrossSessionOutputStream,
    readonly kind: CrossSessionOutputLimitKind,
    readonly limit: number,
  ) {
    super(`${stream} exceeded ${kind} limit ${limit}`);
    this.name = "CrossSessionOutputLimitError";
  }
}

export function crossSessionOutputLimitReport(error: unknown): CrossSessionOutputLimitReport | undefined {
  return error instanceof CrossSessionOutputLimitError
    ? { stream: error.stream, kind: error.kind, limit: error.limit }
    : undefined;
}

export interface CrossSessionLineCapture {
  lines: string[];
  done: Promise<void>;
  failure: Promise<never>;
}

function requireOutputLimits(limits: Readonly<CrossSessionOutputLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
}

async function pumpBoundedCrossSessionLines(
  stream: ReadableStream<Uint8Array>,
  lines: string[],
  streamName: CrossSessionOutputStream,
  onLine: ((line: string) => void) | undefined,
  limits: Readonly<CrossSessionOutputLimits>,
): Promise<void> {
  requireOutputLimits(limits);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let currentLineBytes = 0;
  let lineCount = 0;
  let pending = "";
  const acceptLine = (line: string): void => {
    lineCount += 1;
    if (lineCount > limits.maxLines) {
      throw new CrossSessionOutputLimitError(streamName, "line_count", limits.maxLines);
    }
    lines.push(line);
    onLine?.(line);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limits.maxBytes) {
        throw new CrossSessionOutputLimitError(streamName, "total_bytes", limits.maxBytes);
      }
      for (const byte of value) {
        if (byte === 0x0a) {
          currentLineBytes = 0;
        } else {
          currentLineBytes += 1;
          if (currentLineBytes > limits.maxLineBytes) {
            throw new CrossSessionOutputLimitError(streamName, "line_bytes", limits.maxLineBytes);
          }
        }
      }
      pending += decoder.decode(value, { stream: true });
      const chunks = pending.split(/\r?\n/);
      pending = chunks.pop() ?? "";
      for (const line of chunks) acceptLine(line);
    }
    pending += decoder.decode();
    if (pending !== "") acceptLine(pending);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Drain one verifier-owned process stream into bounded line evidence. The
 * `done` promise always settles without rejection; callers race `failure` so a
 * limit or callback error can stop all related process groups immediately.
 */
export function captureBoundedCrossSessionLines(
  stream: ReadableStream<Uint8Array>,
  streamName: CrossSessionOutputStream,
  onLine?: (line: string) => void,
  limits: Readonly<CrossSessionOutputLimits> = CROSS_SESSION_OUTPUT_LIMITS,
): CrossSessionLineCapture {
  const lines: string[] = [];
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const done = pumpBoundedCrossSessionLines(stream, lines, streamName, onLine, limits)
    .catch((error) => {
      rejectFailure(error);
    });
  return { lines, done, failure };
}

/** Create one verifier-owned process synchronization signal without overwrite. */
export function writeCrossSessionReleaseFile(path: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, "released\n", "utf8");
  } finally {
    closeSync(fd);
  }
}

const PROBE_SHUTDOWN_GRACE_MS = 250;
const PROBE_DRAIN_GRACE_MS = 1_000;

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function signalProbeGroup(
  child: ReturnType<typeof Bun.spawn>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (child.exitCode !== null) return;
    try {
      if (signal === "SIGTERM") child.kill();
      else child.kill(9);
    } catch {
      // The process already exited between the checks.
    }
  }
}

async function stopProbeProcessGroup(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  signalProbeGroup(child, "SIGTERM");
  if (child.exitCode === null) {
    await Promise.race([
      child.exited.then(() => undefined, () => undefined),
      delay(PROBE_SHUTDOWN_GRACE_MS),
    ]);
  }
  // The leader can exit before a descendant that inherited its stdout/stderr
  // pipes. Always address the detached group once more before draining.
  signalProbeGroup(child, "SIGKILL");
  await child.exited.catch(() => undefined);
}

async function readBoundedProbeText(
  stream: ReadableStream<Uint8Array>,
  streamName: CrossSessionProbeOutputStream,
  maxBytes: number = CROSS_SESSION_PROBE_OUTPUT_LIMIT_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("probe output limit must be a positive safe integer");
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new CrossSessionProbeOutputLimitError(streamName, maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run a short prerequisite probe under one deadline covering process exit and
 * complete stdout/stderr drain. Timeout or stream failure terminates the whole
 * detached process group so a wrapper cannot leave Claude descendants behind.
 */
export async function captureCrossSessionProbe(
  command: readonly string[],
  timeoutMs: number,
  label: string,
): Promise<CrossSessionProbeResult> {
  requirePositiveTimeout(timeoutMs);
  if (command.length === 0 || command[0] === "") {
    throw new Error("probe command must name a non-empty executable");
  }
  if (label.trim() === "") throw new Error("probe label must not be empty");

  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stdout = readBoundedProbeText(child.stdout, "probe_stdout");
  const stderr = readBoundedProbeText(child.stderr, "probe_stderr");
  const completion = Promise.all([stdout, stderr, child.exited]).then(
    ([capturedStdout, capturedStderr, code]) => ({
      stdout: capturedStdout,
      stderr: capturedStderr,
      code,
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([completion, timeout]);
  } catch (error) {
    await stopProbeProcessGroup(child);
    // Group termination should close both pipes. Keep this cleanup bounded too:
    // the original probe error remains the authoritative result.
    await Promise.race([
      Promise.allSettled([stdout, stderr]),
      delay(PROBE_DRAIN_GRACE_MS),
    ]);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Await every receiver startup signal under one deadline and fail as soon as
 * the receiver exits. Callers can pass Promise.all(...) so initialization and
 * launch-address discovery cannot each consume a fresh timeout window.
 */
export async function waitForCrossSessionReadiness<T>(
  readiness: Promise<T>,
  receiverExited: Promise<number>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  requirePositiveTimeout(timeoutMs);
  const ready = readiness.then<CrossSessionReadinessResult<T>, CrossSessionReadinessResult<T>>(
    (value) => ({ kind: "ready", value }),
    (error) => ({ kind: "readiness_error", error }),
  );
  const exited = receiverExited.then<CrossSessionReadinessResult<T>, CrossSessionReadinessResult<T>>(
    (code) => ({ kind: "receiver_exit", code }),
    (error) => ({ kind: "receiver_exit_error", error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const result = await Promise.race([ready, exited, timeout]);
    if (result.kind === "ready") return result.value;
    if (result.kind === "receiver_exit") {
      throw new Error(`receiver exited with code ${result.code} before ${label}`);
    }
    const detail = result.error instanceof Error ? result.error.message : String(result.error);
    if (result.kind === "receiver_exit_error") {
      throw new Error(`receiver exit observation failed before ${label}: ${detail}`);
    }
    if (result.error instanceof CrossSessionOutputLimitError) throw result.error;
    throw new Error(`${label} failed: ${detail}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wait for both bridge processes under one deadline. A zero exit may legally
 * precede the peer while its final stream output drains, but a non-zero exit or
 * rejected exit observation cannot produce a valid round trip and stops the
 * peer immediately.
 */
export async function waitForCrossSessionProcessPair(
  senderExited: Promise<number>,
  receiverExited: Promise<number>,
  timeoutMs: number,
  stopBoth: () => Promise<void>,
): Promise<{ senderCode: number; receiverCode: number }> {
  requirePositiveTimeout(timeoutMs);
  const observe = (side: CrossSessionProcessSide, exited: Promise<number>): Promise<CrossSessionProcessExit> =>
    exited.then(
      (code) => ({ side, code }),
      (error) => ({ side, error }),
    );
  const sender = observe("sender", senderExited);
  const receiver = observe("receiver", receiverExited);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Cross-session round trip timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const requireSuccess = (result: CrossSessionProcessExit): number => {
    if ("error" in result) {
      const detail = result.error instanceof Error ? result.error.message : String(result.error);
      throw new Error(`${result.side} exit observation failed: ${detail}`);
    }
    if (result.code !== 0) {
      throw new Error(`${result.side} exited with code ${result.code} before the Cross-session round trip completed`);
    }
    return result.code;
  };

  try {
    const first = await Promise.race([sender, receiver, timeout]);
    const firstCode = requireSuccess(first);
    const second = await Promise.race([first.side === "sender" ? receiver : sender, timeout]);
    const secondCode = requireSuccess(second);
    return first.side === "sender"
      ? { senderCode: firstCode, receiverCode: secondCode }
      : { senderCode: secondCode, receiverCode: firstCode };
  } catch (error) {
    await stopBoth().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

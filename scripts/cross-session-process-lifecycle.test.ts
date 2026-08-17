import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureBoundedCrossSessionLines,
  captureCrossSessionProbe,
  CROSS_SESSION_PROBE_OUTPUT_LIMIT_BYTES,
  CrossSessionProbeOutputLimitError,
  crossSessionOutputLimitReport,
  waitForCrossSessionProcessPair,
  waitForCrossSessionReadiness,
  writeCrossSessionReleaseFile,
} from "./cross-session-process-lifecycle";

const tempPaths: string[] = [];
afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function byteStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("Cross-session process lifecycle", () => {
  test("captures split UTF-8 lines within all three output budgets", async () => {
    const observed: string[] = [];
    const capture = captureBoundedCrossSessionLines(
      byteStream("α\r", "\nβ\n", "tail"),
      "receiver_stdout",
      (line) => observed.push(line),
      { maxBytes: 64, maxLineBytes: 8, maxLines: 3 },
    );

    await capture.done;

    expect(capture.lines).toEqual(["α", "β", "tail"]);
    expect(observed).toEqual(capture.lines);
  });

  test("fails closed with stable output-limit details and no captured content", async () => {
    const cases = [
      {
        stream: byteStream("private-secret"),
        limits: { maxBytes: 4, maxLineBytes: 64, maxLines: 8 },
        expected: { stream: "sender_stdout", kind: "total_bytes", limit: 4 },
      },
      {
        stream: byteStream("private", "-secret"),
        limits: { maxBytes: 64, maxLineBytes: 6, maxLines: 8 },
        expected: { stream: "sender_stdout", kind: "line_bytes", limit: 6 },
      },
      {
        stream: byteStream("private\nsecret\n"),
        limits: { maxBytes: 64, maxLineBytes: 16, maxLines: 1 },
        expected: { stream: "sender_stdout", kind: "line_count", limit: 1 },
      },
    ] as const;

    for (const fixture of cases) {
      const capture = captureBoundedCrossSessionLines(
        fixture.stream,
        "sender_stdout",
        undefined,
        fixture.limits,
      );
      let failure: unknown;
      await capture.failure.catch((error) => {
        failure = error;
      });
      await capture.done;
      const report = crossSessionOutputLimitReport(failure);
      expect(report).toEqual(fixture.expected);
      expect(JSON.stringify(report)).not.toContain("private");
      expect(JSON.stringify(report)).not.toContain("secret");
    }
  });

  test("creates one private release signal without overwriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "agentparty-cross-session-release-"));
    tempPaths.push(root);
    const release = join(root, "release");

    writeCrossSessionReleaseFile(release);

    expect(readFileSync(release, "utf8")).toBe("released\n");
    expect(statSync(release).mode & 0o777).toBe(0o600);
    expect(() => writeCrossSessionReleaseFile(release)).toThrow();
    expect(readFileSync(release, "utf8")).toBe("released\n");
  });

  test("captures stdout, stderr, and exit under one probe deadline", async () => {
    await expect(captureCrossSessionProbe([
      process.execPath,
      "-e",
      'process.stdout.write("probe-out"); process.stderr.write("probe-err"); process.exit(7);',
    ], 1_000, "fixture probe")).resolves.toEqual({
      stdout: "probe-out",
      stderr: "probe-err",
      code: 7,
    });
    await expect(captureCrossSessionProbe([], 1_000, "fixture probe"))
      .rejects.toThrow("probe command must name a non-empty executable");
  });

  test("stops a probe whose stdout or stderr exceeds the byte budget", async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const script = [
        `const chunk = "x".repeat(${CROSS_SESSION_PROBE_OUTPUT_LIMIT_BYTES + 1});`,
        `process.${stream}.write(chunk);`,
        "setInterval(() => {}, 1000);",
      ].join(" ");
      let failure: unknown;
      try {
        await captureCrossSessionProbe(
          [process.execPath, "-e", script],
          2_000,
          `oversized ${stream} probe`,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CrossSessionProbeOutputLimitError);
      expect(failure).toMatchObject({
        stream: `probe_${stream}`,
        limit: CROSS_SESSION_PROBE_OUTPUT_LIMIT_BYTES,
      });
    }
  });

  test("times out a probe and kills descendants in its detached process group", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "agentparty-probe-timeout-"));
    tempPaths.push(root);
    const pidFile = join(root, "child.pid");
    const childScript = "setInterval(() => {}, 1000);";
    const parentScript = [
      'const { writeFileSync } = require("node:fs");',
      `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(childScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");

    await expect(captureCrossSessionProbe(
      [process.execPath, "-e", parentScript],
      150,
      "hanging Claude probe",
    )).rejects.toThrow("hanging Claude probe timed out after 150ms");

    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(childPid) && childPid > 1).toBe(true);
    try {
      for (let attempt = 0; attempt < 40 && processExists(childPid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(processExists(childPid)).toBe(false);
    } finally {
      if (processExists(childPid)) process.kill(childPid, "SIGKILL");
    }
  });

  test("waits for both successful exits under one process-pair lifecycle", async () => {
    const sender = deferred<number>();
    const receiver = deferred<number>();
    let stops = 0;
    const waiting = waitForCrossSessionProcessPair(
      sender.promise,
      receiver.promise,
      1_000,
      async () => { stops += 1; },
    );

    receiver.resolve(0);
    await Promise.resolve();
    sender.resolve(0);

    expect(await waiting).toEqual({ senderCode: 0, receiverCode: 0 });
    expect(stops).toBe(0);
  });

  test("stops the peer immediately when either process exits non-zero", async () => {
    const sender = deferred<number>();
    const receiver = deferred<number>();
    let stops = 0;
    const waiting = waitForCrossSessionProcessPair(
      sender.promise,
      receiver.promise,
      1_000,
      async () => { stops += 1; },
    );

    receiver.resolve(17);

    await expect(waiting).rejects.toThrow(
      "receiver exited with code 17 before the Cross-session round trip completed",
    );
    expect(stops).toBe(1);
  });

  test("uses one shared process-pair timeout and stops both unfinished processes", async () => {
    const sender = deferred<number>();
    const receiver = deferred<number>();
    let stops = 0;

    await expect(waitForCrossSessionProcessPair(
      sender.promise,
      receiver.promise,
      20,
      async () => { stops += 1; },
    )).rejects.toThrow("Cross-session round trip timed out after 20ms");
    expect(stops).toBe(1);
  });

  test("returns receiver readiness without waiting for process exit", async () => {
    const ready = deferred<string>();
    const receiver = deferred<number>();
    const waiting = waitForCrossSessionReadiness(
      ready.promise,
      receiver.promise,
      1_000,
      "receiver readiness",
    );

    ready.resolve("apcs-receiver-a1b2c3d4e5f6");

    expect(await waiting).toBe("apcs-receiver-a1b2c3d4e5f6");
  });

  test("fails receiver readiness immediately when the process exits first", async () => {
    const ready = deferred<void>();
    const receiver = deferred<number>();
    const waiting = waitForCrossSessionReadiness(
      ready.promise,
      receiver.promise,
      1_000,
      "receiver readiness",
    );

    receiver.resolve(9);

    await expect(waiting).rejects.toThrow("receiver exited with code 9 before receiver readiness");
  });

  test("bounds all receiver readiness signals with one timeout", async () => {
    const initialized = deferred<void>();
    const address = deferred<string>();
    const receiver = deferred<number>();
    initialized.resolve();

    await expect(waitForCrossSessionReadiness(
      Promise.all([initialized.promise, address.promise]).then(([, value]) => value),
      receiver.promise,
      20,
      "receiver readiness",
    )).rejects.toThrow("receiver readiness timed out after 20ms");
  });
});

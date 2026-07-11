import { describe, expect, test } from "bun:test";

import { forwardRunnerSignal } from "../src/commands/serve";

describe("desktop-managed serve runner signal forwarding", () => {
  test("signals the whole runner process group on POSIX", () => {
    const groups: Array<[number, string | number]> = [];
    const childSignals: Array<string | number | undefined> = [];
    const result = forwardRunnerSignal(
      { pid: 42, kill: (signal) => childSignals.push(signal) },
      "SIGTERM",
      "darwin",
      ((pid: number, signal: string | number) => {
        groups.push([pid, signal]);
        return true;
      }) as typeof process.kill,
    );

    expect(result).toBe("group");
    expect(groups).toEqual([[-42, "SIGTERM"]]);
    expect(childSignals).toEqual([]);
  });

  test("falls back to the direct child when a process group is unavailable", () => {
    const childSignals: Array<string | number | undefined> = [];
    const result = forwardRunnerSignal(
      { pid: 42, kill: (signal) => childSignals.push(signal) },
      "SIGTERM",
      "linux",
      (() => { throw new Error("ESRCH"); }) as typeof process.kill,
    );

    expect(result).toBe("child");
    expect(childSignals).toEqual(["SIGTERM"]);
  });

  test("uses direct child termination on Windows", () => {
    const childSignals: Array<string | number | undefined> = [];
    const result = forwardRunnerSignal(
      { pid: 42, kill: (signal) => childSignals.push(signal) },
      "SIGINT",
      "win32",
    );

    expect(result).toBe("child");
    expect(childSignals).toEqual(["SIGINT"]);
  });
});

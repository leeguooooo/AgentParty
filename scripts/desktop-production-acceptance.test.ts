import { describe, expect, test } from "bun:test";

import {
  parseAcceptanceCliArgs,
  parseUpdaterReceipt,
  verifyUpgradeEvidence,
  type InstalledAppEvidence,
  type UpdaterReceipt,
} from "./desktop-production-acceptance";

function evidence(version: string, hash: string): InstalledAppEvidence {
  const executableHash = hash === "old" ? "a".repeat(64) : "b".repeat(64);
  const sidecarHash = hash === "old" ? "c".repeat(64) : "d".repeat(64);
  return {
    schema: "agentparty.desktop-acceptance.v1",
    capturedAt: version === "0.2.90" ? "2026-07-11T00:00:00.000Z" : "2026-07-11T00:10:00.000Z",
    appPath: "/Applications/AgentParty.app",
    version,
    bundleIdentifier: "com.agentparty.desktop",
    executablePath: "/Applications/AgentParty.app/Contents/MacOS/agentparty-desktop",
    executableSha256: executableHash,
    sidecarVersion: version,
    sidecarSha256: sidecarHash,
    signingAuthority: "Developer ID Application: AgentParty Inc. (TEAM123456)",
    teamIdentifier: "TEAM123456",
    codesignVerified: true,
    gatekeeperAccepted: true,
    notarizationStapled: true,
  };
}

const receipt: UpdaterReceipt = {
  status: "success",
  source: null,
  stage: "relaunch",
  category: null,
  timestamp: Date.parse("2026-07-11T00:09:00.000Z"),
  appVersion: "0.2.91",
  targetVersion: "0.2.91",
};

describe("desktop production acceptance", () => {
  test("parses explicit two-phase commands and rejects incomplete input", () => {
    expect(parseAcceptanceCliArgs([
      "baseline", "--app", "/Applications/AgentParty.app", "--expected-version", "0.2.90", "--output", "/tmp/base.json",
    ])).toEqual({
      command: "baseline",
      app: "/Applications/AgentParty.app",
      expectedVersion: "0.2.90",
      output: "/tmp/base.json",
    });
    expect(parseAcceptanceCliArgs([
      "verify", "--app", "/Applications/AgentParty.app", "--expected-version", "0.2.91",
      "--baseline", "/tmp/base.json", "--receipt", "/tmp/receipt.json",
    ])).toMatchObject({ command: "verify", expectedVersion: "0.2.91" });
    expect(() => parseAcceptanceCliArgs(["verify", "--app", "/Applications/AgentParty.app"])).toThrow(
      "--expected-version is required",
    );
  });

  test("accepts only the strict privacy-safe completed relaunch receipt", () => {
    expect(parseUpdaterReceipt(receipt)).toEqual(receipt);
    expect(() => parseUpdaterReceipt({ ...receipt, rawError: "token=secret" })).toThrow("updater receipt is invalid");
    expect(() => parseUpdaterReceipt({ ...receipt, status: "pending" })).toThrow("updater receipt is invalid");
  });

  test("proves an installed N-1 to N replacement with one canonical process", () => {
    const baseline = evidence("0.2.90", "old");
    const current = evidence("0.2.91", "new");
    expect(verifyUpgradeEvidence(
      baseline,
      current,
      receipt,
      [{ pid: 42, executablePath: current.executablePath }],
      "0.2.91",
      "2026-07-11T00:11:00.000Z",
    )).toEqual({
      schema: "agentparty.desktop-acceptance.v1",
      status: "passed",
      fromVersion: "0.2.90",
      toVersion: "0.2.91",
      appPath: current.appPath,
      executablePath: current.executablePath,
      processId: 42,
      receiptTimestamp: Date.parse("2026-07-11T00:09:00.000Z"),
      verifiedAt: "2026-07-11T00:11:00.000Z",
    });
  });

  test("rejects manual-looking replacements, stale receipts, and duplicate processes", () => {
    const baseline = evidence("0.2.90", "old");
    const current = evidence("0.2.91", "new");
    expect(() => verifyUpgradeEvidence(
      baseline,
      { ...current, executableSha256: baseline.executableSha256 },
      receipt,
      [{ pid: 42, executablePath: current.executablePath }],
      "0.2.91",
    )).toThrow("did not replace both bundled executables");
    expect(() => verifyUpgradeEvidence(
      baseline,
      current,
      { ...receipt, targetVersion: "0.2.92" },
      [{ pid: 42, executablePath: current.executablePath }],
      "0.2.91",
    )).toThrow("receipt does not confirm");
    expect(() => verifyUpgradeEvidence(
      baseline,
      current,
      { ...receipt, timestamp: Date.parse("2026-07-10T23:59:00.000Z") },
      [{ pid: 42, executablePath: current.executablePath }],
      "0.2.91",
    )).toThrow("stale or outside");
    expect(() => verifyUpgradeEvidence(
      baseline,
      current,
      receipt,
      [
        { pid: 42, executablePath: current.executablePath },
        { pid: 43, executablePath: "/tmp/agentparty-desktop" },
      ],
      "0.2.91",
    )).toThrow("exactly one running desktop process");
  });
});

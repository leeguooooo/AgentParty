import { describe, expect, test } from "bun:test";

import {
  parseAdhocAcceptanceCliArgs,
  parseAdhocSignatureMetadata,
  verifyAdhocUpgradeEvidence,
  type InstalledAdhocAppEvidence,
} from "./desktop-adhoc-acceptance";
import type { UpdaterReceipt } from "./desktop-production-acceptance";

function evidence(version: string, current: boolean): InstalledAdhocAppEvidence {
  return {
    schema: "agentparty.desktop-adhoc-acceptance.v1",
    distribution: "ad-hoc",
    capturedAt: current ? "2026-07-14T00:10:00.000Z" : "2026-07-14T00:00:00.000Z",
    appPath: "/Applications/AgentParty.app",
    version,
    bundleIdentifier: "com.agentparty.desktop",
    executablePath: "/Applications/AgentParty.app/Contents/MacOS/agentparty-desktop",
    executableSha256: (current ? "b" : "a").repeat(64),
    sidecarVersion: version,
    sidecarSha256: (current ? "d" : "c").repeat(64),
    codeResourcesSha256: (current ? "f" : "e").repeat(64),
    entitlementsSha256: "0".repeat(64),
    signature: "adhoc",
    teamIdentifier: null,
    codeIdentifier: "com.agentparty.desktop",
    codesignVerified: true,
    gatekeeperAccepted: false,
    notarizationStapled: false,
  };
}

const receipt: UpdaterReceipt = {
  status: "success",
  source: null,
  stage: "relaunch",
  category: null,
  timestamp: Date.parse("2026-07-14T00:09:00.000Z"),
  appVersion: "0.2.111",
  targetVersion: "0.2.111",
};

describe("desktop ad-hoc acceptance", () => {
  test("accepts only an authority-free ad-hoc signature with an explicit identifier", () => {
    expect(parseAdhocSignatureMetadata([
      "Executable=/Applications/AgentParty.app/Contents/MacOS/agentparty-desktop",
      "Identifier=com.agentparty.desktop",
      "Signature=adhoc",
      "TeamIdentifier=not set",
    ].join("\n"))).toEqual({
      signature: "adhoc",
      teamIdentifier: null,
      codeIdentifier: "com.agentparty.desktop",
    });
    expect(() => parseAdhocSignatureMetadata([
      "Identifier=com.agentparty.desktop",
      "Signature=adhoc",
      "Authority=Developer ID Application: Wrong Team",
      "TeamIdentifier=TEAM123456",
    ].join("\n"))).toThrow("exclusively ad-hoc signed");
    expect(() => parseAdhocSignatureMetadata([
      "Identifier=agentparty_desktop-random",
      "Signature=adhoc",
      "TeamIdentifier=not set",
      "TeamIdentifier=not set",
    ].join("\n"))).toThrow("exclusively ad-hoc signed");
  });

  test("parses explicit two-phase commands", () => {
    expect(parseAdhocAcceptanceCliArgs([
      "baseline", "--app", "/Applications/AgentParty.app", "--expected-version", "0.2.110",
      "--output", "/tmp/base.json",
    ])).toEqual({
      command: "baseline",
      app: "/Applications/AgentParty.app",
      expectedVersion: "0.2.110",
      output: "/tmp/base.json",
    });
    expect(parseAdhocAcceptanceCliArgs([
      "verify", "--app", "/Applications/AgentParty.app", "--expected-version", "0.2.111",
      "--baseline", "/tmp/base.json", "--receipt", "/tmp/receipt.json", "--output", "/tmp/report.json",
    ])).toMatchObject({ command: "verify", expectedVersion: "0.2.111", output: "/tmp/report.json" });
    expect(() => parseAdhocAcceptanceCliArgs(["verify", "--app", "/Applications/AgentParty.app"]))
      .toThrow("--expected-version is required");
  });

  test("proves an ad-hoc N-1 to N in-app replacement without claiming Gatekeeper acceptance", () => {
    const baseline = evidence("0.2.110", false);
    const current = evidence("0.2.111", true);
    const report = verifyAdhocUpgradeEvidence(
      baseline,
      current,
      receipt,
      [{ pid: 42, executablePath: current.executablePath }],
      "0.2.111",
      "2026-07-14T00:11:00.000Z",
    );
    expect(report).toMatchObject({
      status: "passed",
      distribution: "ad-hoc",
      fromVersion: "0.2.110",
      toVersion: "0.2.111",
      codesignVerified: true,
      gatekeeperAccepted: false,
      notarizationStapled: false,
    });
  });

  test("rejects unsigned-looking replacements, identity drift, stale receipts, and duplicate processes", () => {
    const baseline = evidence("0.2.110", false);
    const current = evidence("0.2.111", true);
    const running = [{ pid: 42, executablePath: current.executablePath }];
    expect(() => verifyAdhocUpgradeEvidence(
      baseline,
      { ...current, codeResourcesSha256: baseline.codeResourcesSha256 },
      receipt,
      running,
      "0.2.111",
    )).toThrow("replace and re-sign");
    expect(() => verifyAdhocUpgradeEvidence(
      baseline,
      { ...current, codeIdentifier: "agentparty_desktop-random" },
      receipt,
      running,
      "0.2.111",
    )).toThrow("installed application identity");
    expect(() => verifyAdhocUpgradeEvidence(
      baseline,
      current,
      { ...receipt, timestamp: Date.parse("2026-07-13T23:59:00.000Z") },
      running,
      "0.2.111",
    )).toThrow("stale or outside");
    expect(() => verifyAdhocUpgradeEvidence(
      baseline,
      current,
      receipt,
      [...running, { pid: 43, executablePath: "/tmp/agentparty-desktop" }],
      "0.2.111",
    )).toThrow("exactly one running desktop process");
  });
});

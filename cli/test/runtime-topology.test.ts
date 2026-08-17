import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRuntimePeerDiscovery,
  parseRuntimeTopology,
  type RuntimePeerDiscovery,
} from "@agentparty/shared";
import { fetchRuntimePeers, RuntimePeerProtocolError } from "../src/rest";
import { buildRuntimeTopology, loadOrCreateNodeSecret } from "../src/runtime-topology";
import { agentpartyHome } from "../src/config";

const homes: string[] = [];
let apiServer: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  apiServer?.stop(true);
  apiServer = null;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentparty-topology-"));
  homes.push(home);
  return home;
}

describe("runtime topology identity", () => {
  test("separate agent configs share one installation namespace unless AGENTPARTY_HOME opts out", () => {
    const userHome = tempHome();
    const firstHome = agentpartyHome({ AGENTPARTY_CONFIG: "/configs/first.json" }, userHome);
    const secondHome = agentpartyHome({ AGENTPARTY_CONFIG: "/configs/second.json" }, userHome);
    expect(firstHome).toBe(join(userHome, ".agentparty"));
    expect(secondHome).toBe(firstHome);
    expect(loadOrCreateNodeSecret(secondHome)).toBe(loadOrCreateNodeSecret(firstHome));

    const isolatedHome = join(userHome, "isolated-installation");
    expect(agentpartyHome({
      AGENTPARTY_CONFIG: "/configs/third.json",
      AGENTPARTY_HOME: isolatedHome,
    }, userHome)).toBe(isolatedHome);
    expect(loadOrCreateNodeSecret(isolatedHome)).not.toBe(loadOrCreateNodeSecret(firstHome));
  });

  test("creates one private installation secret and reuses it", () => {
    const home = tempHome();
    const first = loadOrCreateNodeSecret(home);
    const second = loadOrCreateNodeSecret(home);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(readFileSync(join(home, "node-secret"), "utf8").trim()).toBe(first!);
    expect(statSync(join(home, "node-secret")).mode & 0o777).toBe(0o600);
  });

  test("read-only topology diagnostics never create a missing installation secret", () => {
    const home = tempHome();
    expect(buildRuntimeTopology("https://party.example", "/repo", {
      home,
      createSecret: false,
      git: () => null,
    })).toBeUndefined();
    expect(existsSync(join(home, "node-secret"))).toBe(false);

    loadOrCreateNodeSecret(home);
    expect(buildRuntimeTopology("https://party.example", "/repo", {
      home,
      createSecret: false,
      runtimeId: "runtimereadonly",
      git: () => null,
    })).toBeDefined();
  });

  test("refuses a pre-existing topology secret with group or world access", () => {
    const home = tempHome();
    const path = join(home, "node-secret");
    writeFileSync(path, `${"ab".repeat(32)}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(loadOrCreateNodeSecret(home)).toBeNull();
    expect(buildRuntimeTopology("https://party.example", "/repo", { home, git: () => null }))
      .toBeUndefined();
  });

  test("same install and server share node/workspace while separate worktrees remain distinct", () => {
    const secret = "11".repeat(32);
    const git = (cwd: string, args: string[]) => {
      if (args.includes("--show-toplevel")) return cwd;
      if (args.includes("--git-common-dir")) return "/repo/.git";
      return null;
    };
    const first = buildRuntimeTopology("https://party.example/", "/repo/wt-a", {
      secret,
      runtimeId: "runtimeaaaaaaaa",
      git,
    })!;
    const second = buildRuntimeTopology("https://party.example", "/repo/wt-b", {
      secret,
      runtimeId: "runtimebbbbbbbb",
      git,
    })!;
    expect(second.node_ref).toBe(first.node_ref);
    expect(second.workspace_ref).toBe(first.workspace_ref);
    expect(second.worktree_ref).not.toBe(first.worktree_ref);
    expect(second.runtime_ref).not.toBe(first.runtime_ref);
    expect(JSON.stringify(first)).not.toContain("/repo/");
    expect(first.evidence).toBe("client_asserted");
  });

  test("the same installation cannot be correlated across AgentParty servers", () => {
    const secret = "22".repeat(32);
    const deps = {
      secret,
      runtimeId: "runtimeaaaaaaaa",
      git: () => null,
    };
    const first = buildRuntimeTopology("https://one.example", "/repo", deps)!;
    const second = buildRuntimeTopology("https://two.example", "/repo", deps)!;
    expect(second.node_ref).not.toBe(first.node_ref);
    expect(second.runtime_ref).not.toBe(first.runtime_ref);
    expect(second.workspace_ref).not.toBe(first.workspace_ref);
    expect(second.worktree_ref).not.toBe(first.worktree_ref);
  });

  test("protocol parser rejects raw host and path metadata", () => {
    expect(parseRuntimeTopology({
      version: 1,
      node_ref: "leo-macbook",
      runtime_ref: "runtime_aaaaaaaa",
      workspace_ref: "/Users/leo/repo",
      worktree_ref: "worktree_aaaaaaaa",
      peer_scope: "local_installation",
      evidence: "client_asserted",
    })).toBeUndefined();
  });

  test("carries only a validated client-asserted Claude session hint", () => {
    const topology = buildRuntimeTopology("https://party.example", "/repo", {
      secret: "33".repeat(32),
      runtimeId: "runtimeaaaaaaaa",
      git: () => null,
      harnessSession: { harness: "claude", display_name: "review-session" },
    })!;
    expect(parseRuntimeTopology(topology)?.harness_session).toEqual({
      harness: "claude",
      display_name: "review-session",
    });
    expect(parseRuntimeTopology({
      ...topology,
      harness_session: { harness: "claude", display_name: "unsafe name" },
    })).toBeUndefined();
    expect(parseRuntimeTopology({
      ...topology,
      harness_session: { harness: "claude", display_name: "unsafe.dot" },
    })).toBeUndefined();
  });
});

describe("runtime peer discovery parser", () => {
  const valid: RuntimePeerDiscovery = {
    version: 3,
    topology_evidence: "client_asserted",
    comparison: "server_derived",
    caller_binding: "live_socket",
    self: "me",
    peers: [{
      agent: "peer",
      same_identity: false,
      relations: [{ relation: "same_worktree", runtime_count: 2 }],
      claude_sessions: [{
        display_name: "review",
        relation: "same_worktree",
        runtime_count: 1,
        candidate_ref: "candidate_abcdefghijklmnop",
      }],
    }],
  };

  test("accepts a consistent server-derived projection", () => {
    expect(parseRuntimePeerDiscovery(valid)).toEqual(valid);
  });

  test("keeps an ambiguous single-runtime session without making it addressable", () => {
    const ambiguous: RuntimePeerDiscovery = {
      ...valid,
      peers: [{
        ...valid.peers[0]!,
        claude_sessions: [{
          display_name: "review",
          relation: "same_worktree",
          runtime_count: 1,
          candidate_ref: null,
        }],
      }],
    };
    expect(parseRuntimePeerDiscovery(ambiguous)).toEqual(ambiguous);
  });

  test("rejects a pre-v3 Worker response before the Claude bridge can use it", async () => {
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ ...valid, version: 2 });
      },
    });
    const topology = buildRuntimeTopology("https://party.example", "/repo", {
      secret: "44".repeat(32),
      runtimeId: "runtimeaaaaaaaa",
      git: () => null,
    })!;

    const request = fetchRuntimePeers(
      `http://127.0.0.1:${apiServer.port}`,
      "ap_secret",
      "dev",
      topology,
      "capability_probe",
    );
    await expect(request).rejects.toBeInstanceOf(RuntimePeerProtocolError);
    await expect(request).rejects.toMatchObject({ version: 2 });
  });

  test("keeps advisory and capability responses free of Claude candidates", () => {
    expect(parseRuntimePeerDiscovery({
      ...valid,
      caller_binding: "unbound_advisory",
    })).toBeUndefined();
    expect(parseRuntimePeerDiscovery({
      ...valid,
      caller_binding: "capability_probe",
      peers: valid.peers,
    })).toBeUndefined();
    expect(parseRuntimePeerDiscovery({
      ...valid,
      caller_binding: "capability_probe",
      peers: [],
    })).toEqual({
      version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "capability_probe",
      self: "me",
      peers: [],
    });
  });

  test("rejects a valid response carrying the wrong purpose binding", async () => {
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ ...valid, caller_binding: "live_socket" });
      },
    });
    const topology = buildRuntimeTopology("https://party.example", "/repo", {
      secret: "55".repeat(32),
      runtimeId: "runtimebbbbbbbb",
      git: () => null,
    })!;
    await expect(fetchRuntimePeers(
      `http://127.0.0.1:${apiServer.port}`,
      "ap_secret",
      "dev",
      topology,
      "capability_probe",
    )).rejects.toThrow("caller_binding=live_socket for purpose=capability_probe");
  });

  test("rejects inconsistent identity, duplicate relations, and impossible session counts", () => {
    expect(parseRuntimePeerDiscovery({
      ...valid,
      peers: [{ ...valid.peers[0], agent: "me", same_identity: false }],
    })).toBeUndefined();
    expect(parseRuntimePeerDiscovery({
      ...valid,
      peers: [{
        ...valid.peers[0],
        claude_sessions: [{
          display_name: "review",
          relation: "same_worktree",
          runtime_count: 2,
          candidate_ref: "candidate_abcdefghijklmnop",
        }],
      }],
    })).toBeUndefined();
    expect(parseRuntimePeerDiscovery({
      ...valid,
      peers: [{
        ...valid.peers[0],
        claude_sessions: [{
          display_name: "review",
          relation: "same_worktree",
          runtime_count: 1,
          candidate_ref: "runtime_not-a-candidate",
        }],
      }],
    })).toBeUndefined();
    expect(parseRuntimePeerDiscovery({
      ...valid,
      peers: [{
        ...valid.peers[0],
        relations: [
          { relation: "same_worktree", runtime_count: 2 },
          { relation: "same_worktree", runtime_count: 1 },
        ],
      }],
    })).toBeUndefined();
    expect(parseRuntimePeerDiscovery({
      ...valid,
      peers: [{
        ...valid.peers[0],
        claude_sessions: [{ display_name: "review", relation: "same_worktree", runtime_count: 3, candidate_ref: null }],
      }],
    })).toBeUndefined();
    expect(parseRuntimePeerDiscovery({
      ...valid,
      peers: [{
        ...valid.peers[0],
        claude_sessions: [
          { display_name: "review-a", relation: "same_worktree", runtime_count: 2, candidate_ref: null },
          { display_name: "review-b", relation: "same_worktree", runtime_count: 1, candidate_ref: "candidate_reviewpeer0001" },
        ],
      }],
    })).toBeUndefined();
  });
});

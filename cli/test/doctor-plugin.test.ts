import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PresenceEntry } from "@agentparty/shared";
import type { Identity } from "../src/rest";
import {
  inspectClaudePluginBundle,
  inspectClaudePluginReadiness,
  inspectClaudePluginShell,
  parseClaudePluginList,
  supportsAgentPartyClaudePlugin,
  type ClaudePluginDoctorDependencies,
} from "../src/commands/doctor";

const root = resolve(import.meta.dir, "../..");
const pluginRoot = resolve(root, "plugins/agentparty");
const version = JSON.parse(readFileSync(resolve(root, "cli/package.json"), "utf8")).version as string;
const runtimeCommand = "${CLAUDE_PLUGIN_ROOT}/bin/agentparty-runtime";
const pluginEntry = {
  id: "agentparty@agentparty",
  version,
  enabled: true,
  installPath: pluginRoot,
  mcpServers: {
    agentparty: { command: runtimeCommand, args: ["mcp"] },
    "agentparty-channel": {
      command: runtimeCommand,
      args: ["claude-channel", "--require-launch-opt-in"],
    },
  },
};

const identity: Identity = {
  name: "doctor-agent",
  email: null,
  kind: "agent",
  role: "agent",
  owner: "owner@example.com",
};

const listener: PresenceEntry = {
  name: identity.name,
  state: "working",
  note: null,
  ts: Date.now(),
  last_seen: Date.now(),
  live: true,
  residency: "daemon",
  wake: { kind: "daemon", verified_at: Date.now() },
  activity: { phase: "tool", tool: "Read", ts: Date.now() },
};

function dependencies(overrides: Partial<ClaudePluginDoctorDependencies> = {}): ClaudePluginDoctorDependencies {
  return {
    claudeVersion: () => "2.1.228 (Claude Code)",
    claudePlugins: () => [pluginEntry],
    inspectBundle: () => ({ valid: true, launcherExecutable: true }),
    resolveAuth: async () => ({
      server: "https://agentparty.example.com",
      token: "private-test-token",
      auth_source: "runtime_config",
      config: { kind: "workspace", path: "/private/config", workspace_id: "workspace" },
      account: { present: false, path: "/private/account" },
    }),
    channel: () => "dev",
    identity: async () => identity,
    presence: async () => [listener],
    runtimeTopology: () => ({
      version: 1,
      node_ref: "node_doctorfixture0000000000",
      runtime_ref: "runtime_doctorfixture000000",
      workspace_ref: "workspace_doctorfixture0000",
      worktree_ref: "worktree_doctorfixture00000",
      peer_scope: "local_installation",
      evidence: "client_asserted",
    }),
    runtimePeers: async () => ({
      version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "unbound_advisory",
      self: identity.name,
      peers: [{
        agent: identity.name,
        same_identity: true,
        relations: [{ relation: "same_local_installation", runtime_count: 1 }],
        claude_sessions: [],
      }],
    }),
    ...overrides,
  };
}

describe("party doctor claude-plugin", () => {
  test("keeps Marketplace Plugin compatibility separate from the older raw Channels boundary", () => {
    expect(supportsAgentPartyClaudePlugin("2.1.153 (Claude Code)")).toBe(false);
    expect(supportsAgentPartyClaudePlugin("2.1.154 (Claude Code)")).toBe(true);
    expect(supportsAgentPartyClaudePlugin("2.1.232 (Claude Code)")).toBe(true);
    expect(supportsAgentPartyClaudePlugin("unknown")).toBe(false);
  });

  test("parses only complete installed plugin rows", () => {
    expect(parseClaudePluginList(JSON.stringify([pluginEntry]))).toEqual([pluginEntry]);
    expect(parseClaudePluginList("not-json")).toBeNull();
    expect(parseClaudePluginList(JSON.stringify([{ id: "agentparty@agentparty" }]))).toEqual([]);
  });

  test("validates the current source bundle's launcher, hooks, channel, and MCP wiring", () => {
    expect(inspectClaudePluginBundle(pluginEntry)).toEqual({
      valid: true,
      launcherExecutable: true,
    });
  });

  test("inspects the Marketplace lifecycle shell without touching auth, channel, or presence", () => {
    let networkOrConfigCalls = 0;
    const deps = dependencies({
      resolveAuth: async () => {
        networkOrConfigCalls += 1;
        throw new Error("must not run");
      },
      channel: () => {
        networkOrConfigCalls += 1;
        return null;
      },
      identity: async () => {
        networkOrConfigCalls += 1;
        throw new Error("must not run");
      },
      presence: async () => {
        networkOrConfigCalls += 1;
        throw new Error("must not run");
      },
    });
    expect(inspectClaudePluginShell(deps)).toEqual({
      status: "ready",
      blockers: [],
      runtime_version: version,
      claude_version: "2.1.228 (Claude Code)",
      plugin: {
        installed: true,
        enabled: true,
        version,
        bundle_valid: true,
        launcher_executable: true,
      },
      model_calls_started: false,
    });
    expect(networkOrConfigCalls).toBe(0);
  });

  test("separates missing, disabled, version-mismatched, and invalid lifecycle shells", () => {
    expect(inspectClaudePluginShell(dependencies({ claudePlugins: () => [] })).blockers)
      .toEqual(["plugin_missing"]);
    expect(inspectClaudePluginShell(dependencies({
      claudePlugins: () => [{ ...pluginEntry, enabled: false }],
    })).blockers).toEqual(["plugin_disabled"]);
    expect(inspectClaudePluginShell(dependencies({
      claudePlugins: () => [{ ...pluginEntry, version: "0.0.0" }],
    })).blockers).toEqual(["plugin_version_mismatch"]);
    expect(inspectClaudePluginShell(dependencies({
      inspectBundle: () => ({ valid: false, launcherExecutable: true }),
    })).blockers).toEqual(["plugin_bundle_invalid"]);
    expect(inspectClaudePluginShell(dependencies({
      claudeVersion: () => "2.1.80 (Claude Code)",
    })).blockers).toEqual(["claude_version_unsupported"]);
  });

  test("reports ready only when plugin, auth, channel, and a healthy durable listener are observed", async () => {
    const report = await inspectClaudePluginReadiness(undefined, dependencies());
    expect(report.status).toBe("ready");
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.plugin).toEqual({
      installed: true,
      enabled: true,
      version,
      bundle_valid: true,
      launcher_executable: true,
    });
    expect(report.auth).toEqual({
      configured: true,
      source: "runtime_config",
      identity: identity.name,
    });
    expect(report.channel.slug).toBe("dev");
    expect(report.channel.access).toBe("confirmed");
    expect(report.channel.listener).toBe("healthy");
    expect(report.channel.activity_visibility).toBe("observed");
    expect(report.channel.topology_visibility).toBe("observed");
    expect(report.channel.activity?.tool).toBe("Read");
    expect(report.model_calls_started).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private-test-token");
    expect(JSON.stringify(report)).not.toContain("/private/config");
  });

  test("separates install, enablement, auth, channel, and listener blockers", async () => {
    const report = await inspectClaudePluginReadiness(undefined, dependencies({
      claudePlugins: () => [],
      resolveAuth: async () => ({
        server: null,
        token: null,
        auth_source: "none",
        config: { kind: "none", path: null },
        account: { present: false, path: "/private/account" },
      }),
      channel: () => null,
    }));
    expect(report.status).toBe("plugin_missing");
    expect(report.blockers).toEqual(["plugin_missing", "auth_required", "channel_unbound"]);
    expect(report.channel.listener).toBe("not_checked");
    expect(report.channel.activity_visibility).toBe("not_checked");
    expect(report.channel.topology_visibility).toBe("not_checked");
  });

  test("does not claim the plugin is missing when Claude cannot return plugin state", async () => {
    const report = await inspectClaudePluginReadiness(undefined, dependencies({
      claudePlugins: () => null,
    }));
    expect(report.status).toBe("plugin_state_unavailable");
    expect(report.blockers).toContain("plugin_state_unavailable");
    expect(report.blockers).not.toContain("plugin_missing");
  });

  test("reports a live but deaf listener independently from channel access", async () => {
    const report = await inspectClaudePluginReadiness("dev", dependencies({
      presence: async () => [{ ...listener, listening: "deaf" }],
    }));
    expect(report.status).toBe("listener_deaf");
    expect(report.blockers).toEqual(["listener_deaf"]);
    expect(report.channel.access).toBe("confirmed");
    expect(report.channel.listener).toBe("deaf");
    expect(report.channel.activity_visibility).toBe("observed");
  });

  test("does not treat a generic live identity as proof of a durable listener", async () => {
    const report = await inspectClaudePluginReadiness("dev", dependencies({
      presence: async () => [{ ...listener, wake: { kind: "watch" }, residency: "supervised" }],
    }));
    expect(report.status).toBe("listener_not_observed");
    expect(report.channel.listener).toBe("not_observed");
    expect(report.channel.activity_visibility).toBe("not_checked");
    expect(report.channel.topology_visibility).toBe("not_checked");
  });

  test("requires an agent token for Channel injection and activity reporting", async () => {
    const report = await inspectClaudePluginReadiness("dev", dependencies({
      identity: async () => ({ ...identity, kind: "human", role: "human" }),
    }));
    expect(report.status).toBe("identity_not_agent");
    expect(report.blockers).toEqual(["identity_not_agent"]);
    expect(report.auth.identity).toBe(identity.name);
    expect(report.channel.access).toBe("not_checked");
    expect(report.channel.listener).toBe("not_checked");
    expect(report.channel.activity_visibility).toBe("not_checked");
    expect(report.channel.topology_visibility).toBe("not_checked");
  });

  test("reports missing lifecycle activity separately from listener health", async () => {
    const { activity: _activity, ...withoutActivity } = listener;
    const report = await inspectClaudePluginReadiness("dev", dependencies({
      presence: async () => [withoutActivity],
    }));
    expect(report.status).toBe("ready");
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual(["activity_not_observed"]);
    expect(report.channel.listener).toBe("healthy");
    expect(report.channel.activity_visibility).toBe("not_observed");
    expect(report.channel.activity).toBeUndefined();
  });

  test("reports listener topology visibility separately from reception and activity", async () => {
    const missing = await inspectClaudePluginReadiness(undefined, dependencies({
      runtimePeers: async () => ({
        version: 3,
        topology_evidence: "client_asserted",
        comparison: "server_derived",
        caller_binding: "unbound_advisory",
        self: identity.name,
        peers: [],
      }),
    }));
    expect(missing.status).toBe("ready");
    expect(missing.blockers).toEqual([]);
    expect(missing.warnings).toEqual(["topology_not_observed"]);
    expect(missing.channel.listener).toBe("healthy");
    expect(missing.channel.activity_visibility).toBe("observed");
    expect(missing.channel.topology_visibility).toBe("not_observed");

    const unavailable = await inspectClaudePluginReadiness(undefined, dependencies({
      runtimeTopology: () => undefined,
    }));
    expect(unavailable.status).toBe("ready");
    expect(unavailable.warnings).toEqual(["topology_unavailable"]);
    expect(unavailable.channel.topology_visibility).toBe("unavailable");
  });
});

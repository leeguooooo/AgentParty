import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEPLOY_TARGETS,
  buildDeployPlan,
  buildPreDeploySmokePlan,
  buildPostDeploySmokePlan,
  parseWranglerLauncher,
} from "../worker/scripts/deploy-ci.mjs";
import {
  assertDeploymentSourceClean,
  DEPLOYMENT_SOURCE_PATHS,
  deploymentSourceStatusArgs,
} from "../worker/scripts/deployment-source-state.mjs";

const metadata = {
  version: "1.2.3",
  commit: "a".repeat(40),
  deployed_at: "2026-07-13T00:00:00.000Z",
};

describe("parseWranglerLauncher", () => {
  test("defaults to native wrangler", () => {
    expect(parseWranglerLauncher({})).toEqual(["wrangler"]);
  });

  test("splits a multi-word launcher (bunx wrangler)", () => {
    expect(parseWranglerLauncher({ AGENTPARTY_WRANGLER_BIN: "bunx wrangler" })).toEqual(["bunx", "wrangler"]);
  });

  test("collapses extra whitespace and empties", () => {
    expect(parseWranglerLauncher({ AGENTPARTY_WRANGLER_BIN: "  bunx   wrangler  " })).toEqual(["bunx", "wrangler"]);
  });
});

describe("buildDeployPlan", () => {
  test("prod: migrate -> verify-schema -> deploy, in that order", () => {
    const plan = buildDeployPlan("prod", metadata, ["bunx", "wrangler"]);
    expect(plan.map((s) => s.label)).toEqual(["migrate", "verify-schema", "deploy"]);

    const [migrate, verify, deploy] = plan;

    expect(migrate.cmd).toBe("bunx");
    expect(migrate.args).toEqual([
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "agentparty",
      "--remote",
      "--config",
      "wrangler.jsonc",
    ]);

    // schema 校验必须在 deploy 之前，且指向同一个 target 的 db/config
    expect(verify.cmd).toBe("node");
    expect(verify.args).toEqual(["scripts/verify-remote-schema.mjs"]);
    expect(verify.env).toEqual({
      AGENTPARTY_D1_DATABASE: "agentparty",
      AGENTPARTY_WRANGLER_CONFIG: "wrangler.jsonc",
    });

    expect(deploy.cmd).toBe("bunx");
    expect(deploy.args.slice(0, 4)).toEqual(["wrangler", "deploy", "--config", "wrangler.jsonc"]);
    // build 元数据 --define 注入，供 /api/health 回读校验
    expect(deploy.args).toContain(`__AGENTPARTY_BUILD_VERSION__:${JSON.stringify(metadata.version)}`);
    expect(deploy.args).toContain(`__AGENTPARTY_BUILD_COMMIT__:${JSON.stringify(metadata.commit)}`);
    expect(deploy.args).toContain(`__AGENTPARTY_DEPLOYED_AT__:${JSON.stringify(metadata.deployed_at)}`);
  });

  test("xdream: uses the xdream config + database", () => {
    const plan = buildDeployPlan("xdream", metadata, ["wrangler"]);
    const [migrate, verify, deploy] = plan;
    expect(migrate.args).toContain("agentparty-xdream");
    expect(migrate.args).toContain("wrangler.xdream.jsonc");
    expect(verify.env?.AGENTPARTY_D1_DATABASE).toBe("agentparty-xdream");
    expect(verify.env?.AGENTPARTY_WRANGLER_CONFIG).toBe("wrangler.xdream.jsonc");
    expect(deploy.args).toContain("wrangler.xdream.jsonc");
  });

  test("single-word launcher has no prefix args", () => {
    const [migrate] = buildDeployPlan("prod", metadata, ["wrangler"]);
    expect(migrate.cmd).toBe("wrangler");
    expect(migrate.args[0]).toBe("d1");
  });

  test("rejects unknown targets", () => {
    expect(() => buildDeployPlan("staging", metadata, ["wrangler"])).toThrow(/unknown deploy target/);
  });

  test("rejects invalid deployment metadata (guards --define injection)", () => {
    expect(() => buildDeployPlan("prod", { ...metadata, commit: "nope" }, ["wrangler"])).toThrow();
  });

  test("rejects an empty launcher", () => {
    expect(() => buildDeployPlan("prod", metadata, [])).toThrow(/non-empty/);
  });

  test("both targets map to distinct public bases", () => {
    expect(DEPLOY_TARGETS.prod.smokeBase).not.toBe(DEPLOY_TARGETS.xdream.smokeBase);
  });
});

describe("buildPostDeploySmokePlan", () => {
  test("local deploy provenance covers untracked bundle inputs without blocking unrelated repo work", () => {
    expect(deploymentSourceStatusArgs()).toEqual([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...DEPLOYMENT_SOURCE_PATHS,
    ]);
    expect(DEPLOYMENT_SOURCE_PATHS).toEqual([
      "worker",
      "shared",
      "web",
      "desktop/package.json",
      "package.json",
      "bun.lock",
    ]);
    expect(DEPLOYMENT_SOURCE_PATHS).not.toContain("cli");
    expect(DEPLOYMENT_SOURCE_PATHS).not.toContain("docs");
    expect(() => assertDeploymentSourceClean("\n")).not.toThrow();
    expect(() => assertDeploymentSourceClean("?? worker/src/untracked.ts\n"))
      .toThrow("refusing to deploy uncommitted deployment-source changes");
  });

  test("always checks desktop pairing and adds authenticated live runtime v3 before write smoke", () => {
    const plan = buildPostDeploySmokePlan("prod", "https://party.example", {
      AGENTPARTY_SMOKE_TOKEN: "read-agent-token",
      AGENTPARTY_SMOKE_WRITE_TOKEN: "write-token",
    });
    expect(plan.map((step) => step.label)).toEqual([
      "desktop-pairing-smoke",
      "runtime-peers-smoke",
      "write-path-smoke",
    ]);
    expect(plan[1]).toEqual({
      label: "runtime-peers-smoke",
      cmd: "node",
      args: ["scripts/smoke-runtime-peers.mjs"],
      env: {
        AGENTPARTY_SMOKE_BASE: "https://party.example",
        AGENTPARTY_RUNTIME_SMOKE_TOKEN: "read-agent-token",
      },
    });
  });

  test("post-deploy identity uses version+commit; timestamp is not a false-failure gate", () => {
    const ciSource = readFileSync(
      new URL("../worker/scripts/deploy-ci.mjs", import.meta.url),
      "utf8",
    );
    const dualSource = readFileSync(
      new URL("../worker/scripts/deploy-dual.mjs", import.meta.url),
      "utf8",
    );
    expect(ciSource).toContain("verifyDeploymentIdentity(smokeBase, metadata)");
    expect(ciSource).not.toContain("verifyDeploymentMetadata(smokeBase, metadata)");
    expect(dualSource).toContain("verifyDeploymentIdentity(target.smokeBase, deploymentMetadata)");
    expect(dualSource).not.toContain("verifyDeploymentMetadata(target.smokeBase, deploymentMetadata)");
    expect(ciSource.indexOf("verifyDeploymentIdentity(smokeBase, metadata)")).toBeLessThan(
      ciSource.indexOf("for (const step of smokePlan)"),
    );
  });

  test("builds a credentials-only agent/channel preflight from the same scoped settings", () => {
    expect(buildPreDeploySmokePlan("prod", "https://party.example", {
      AGENTPARTY_RUNTIME_SMOKE_TOKEN: "runtime-agent-token",
      AGENTPARTY_RUNTIME_SMOKE_CHANNEL: "release-smoke",
    })).toEqual([{
      label: "runtime-credentials-preflight",
      cmd: "node",
      args: ["scripts/smoke-runtime-peers.mjs", "--credentials-only"],
      env: {
        AGENTPARTY_SMOKE_BASE: "https://party.example",
        AGENTPARTY_RUNTIME_SMOKE_TOKEN: "runtime-agent-token",
        AGENTPARTY_RUNTIME_SMOKE_CHANNEL: "release-smoke",
      },
    }]);
  });

  test("supports a dedicated target-scoped agent token and channel without requiring a write token", () => {
    const plan = buildPostDeploySmokePlan("xdream", "https://xdream.example", {
      AGENTPARTY_RUNTIME_SMOKE_TOKEN: "global-runtime-token",
      AGENTPARTY_XDREAM_RUNTIME_SMOKE_TOKEN: "xdream-runtime-token",
      AGENTPARTY_XDREAM_RUNTIME_SMOKE_CHANNEL: "release-smoke",
    });
    expect(plan.map((step) => step.label)).toEqual([
      "desktop-pairing-smoke",
      "runtime-peers-smoke",
    ]);
    expect(plan[1]?.env).toEqual({
      AGENTPARTY_SMOKE_BASE: "https://xdream.example",
      AGENTPARTY_RUNTIME_SMOKE_TOKEN: "xdream-runtime-token",
      AGENTPARTY_RUNTIME_SMOKE_CHANNEL: "release-smoke",
    });
  });

  test("fails before deployment planning when no runtime smoke agent token is configured", () => {
    expect(() => buildPostDeploySmokePlan("prod", "https://party.example", {}))
      .toThrow("requires RUNTIME_SMOKE_TOKEN or an agent-valued SMOKE_TOKEN before migration/deploy");
  });

  test("keeps the local dual deploy on the same runtime-before-write smoke order", () => {
    const source = readFileSync(
      new URL("../worker/scripts/deploy-dual.mjs", import.meta.url),
      "utf8",
    );
    expect(source.indexOf("scripts/smoke-runtime-peers.mjs")).toBeGreaterThan(0);
    expect(source.indexOf("scripts/smoke-runtime-peers.mjs"))
      .toBeLessThan(source.indexOf("scripts/smoke-prod.mjs"));
    expect(source).toContain("deploymentSourceStatusArgs()");
    expect(source).toContain("assertDeploymentSourceClean(deploymentSourceChanges)");
    const preflightAll = source.indexOf("for (const name of names) preflightTarget(name);");
    const buildWeb = source.indexOf('run("bun", ["run", "build:web"]);');
    const deployAll = source.indexOf("for (const name of names) await deployTarget(name);");
    expect(preflightAll).toBeGreaterThan(0);
    expect(preflightAll).toBeLessThan(buildWeb);
    expect(buildWeb).toBeLessThan(deployAll);
  });

  test("runs every CI credential preflight before building or mutating a target", () => {
    const source = readFileSync(
      new URL("../worker/scripts/deploy-ci.mjs", import.meta.url),
      "utf8",
    );
    const preflightAll = source.indexOf("for (const name of names) preflightDeployTarget(name);");
    const buildWeb = source.indexOf('run("bun", ["run", "build:web"]);');
    const deployAll = source.indexOf("for (const name of names) await deployTarget(name, metadata, launcher);");
    expect(preflightAll).toBeGreaterThan(0);
    expect(preflightAll).toBeLessThan(buildWeb);
    expect(buildWeb).toBeLessThan(deployAll);
  });

  test("routes the default local deploy through the guarded deploy script", () => {
    const pkg = JSON.parse(readFileSync(
      new URL("../worker/package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    expect(pkg.scripts.deploy).toBe("node scripts/deploy-dual.mjs prod");
    expect(pkg.scripts["smoke:runtime-peers"]).toBe("node scripts/smoke-runtime-peers.mjs");
  });

  test("wires the dedicated runtime smoke secret and optional channel into CI", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/worker-deploy.yml", import.meta.url),
      "utf8",
    );
    expect(() => Bun.YAML.parse(workflow)).not.toThrow();
    expect(workflow).toContain("AGENTPARTY_RUNTIME_SMOKE_TOKEN: ${{ secrets.AGENTPARTY_RUNTIME_SMOKE_TOKEN }}");
    expect(workflow).toContain("AGENTPARTY_RUNTIME_SMOKE_CHANNEL: ${{ vars.AGENTPARTY_RUNTIME_SMOKE_CHANNEL }}");
  });
});

describe("remote D1 migration compatibility", () => {
  test("trigger CASE guards are parenthesized so the remote query endpoint keeps the outer END", () => {
    const migration = readFileSync(
      new URL("../worker/migrations/0042_channel_decisions.sql", import.meta.url),
      "utf8",
    );

    expect(migration).not.toMatch(/\bSELECT\s+CASE\b/i);
    expect(migration.match(/\bSELECT\s*\(\s*CASE\b/gi)).toHaveLength(7);
    expect(migration.match(/\bTHEN\s+RAISE\s*\(/gi)).toHaveLength(7);
  });
});

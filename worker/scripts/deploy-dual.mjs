import { execFileSync, spawnSync } from "node:child_process";
import { runSmokeWithRetry } from "./smoke-retry.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deploymentDefineArgs, verifyDeploymentIdentity } from "./deployment-metadata.mjs";
import {
  assertDeploymentSourceClean,
  deploymentSourceStatusArgs,
} from "./deployment-source-state.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function smokeBaseFromConfig(config) {
  const text = readFileSync(config, "utf8");
  const match = text.match(/"pattern"\s*:\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`could not infer smoke base from ${config}; set an explicit smoke base env var`);
  }
  return `https://${match[1].replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

const targets = {
  prod: {
    profile: process.env.AGENTPARTY_PROD_PROFILE ?? "leeguooooo",
    config: "wrangler.jsonc",
    database: "agentparty",
    smokeBase: process.env.AGENTPARTY_PROD_SMOKE_BASE ?? smokeBaseFromConfig("wrangler.jsonc"),
    smokeToken: process.env.AGENTPARTY_SMOKE_TOKEN,
    smokeWriteToken: process.env.AGENTPARTY_SMOKE_WRITE_TOKEN,
    runtimeSmokeToken:
      process.env.AGENTPARTY_PROD_RUNTIME_SMOKE_TOKEN ??
      process.env.AGENTPARTY_RUNTIME_SMOKE_TOKEN ??
      process.env.AGENTPARTY_SMOKE_TOKEN,
    runtimeSmokeChannel:
      process.env.AGENTPARTY_PROD_RUNTIME_SMOKE_CHANNEL ?? process.env.AGENTPARTY_RUNTIME_SMOKE_CHANNEL,
  },
  xdream: {
    profile: process.env.AGENTPARTY_XDREAM_PROFILE ?? "Xdreamstar2025",
    config: "wrangler.xdream.jsonc",
    database: "agentparty-xdream",
    smokeBase: process.env.AGENTPARTY_XDREAM_SMOKE_BASE ?? smokeBaseFromConfig("wrangler.xdream.jsonc"),
    smokeToken: process.env.AGENTPARTY_XDREAM_SMOKE_TOKEN,
    smokeWriteToken: process.env.AGENTPARTY_XDREAM_SMOKE_WRITE_TOKEN,
    runtimeSmokeToken:
      process.env.AGENTPARTY_XDREAM_RUNTIME_SMOKE_TOKEN ?? process.env.AGENTPARTY_XDREAM_SMOKE_TOKEN,
    runtimeSmokeChannel: process.env.AGENTPARTY_XDREAM_RUNTIME_SMOKE_CHANNEL,
  },
};

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit ${res.status}`);
  }
}

const deploymentSourceChanges = execFileSync("git", deploymentSourceStatusArgs(), {
  cwd: repositoryRoot,
  encoding: "utf8",
});
assertDeploymentSourceClean(deploymentSourceChanges);

const deploymentMetadata = {
  version: JSON.parse(readFileSync(new URL("../../desktop/package.json", import.meta.url), "utf8")).version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
  deployed_at: new Date().toISOString(),
};

async function deployTarget(name) {
  const target = targets[name];
  if (!target) throw new Error(`unknown deploy target: ${name}`);

  console.error(`\n==> Deploying ${name} with ${target.profile} (${target.config})`);
  const env = { WRANGLER_PROFILE: target.profile, CI: "1" };
  run("wrangler-accounts", ["--profile", target.profile, "d1", "migrations", "apply", target.database, "--remote", "--config", target.config], { env });
  run("node", ["scripts/verify-remote-schema.mjs"], {
    env: {
      ...env,
      AGENTPARTY_D1_DATABASE: target.database,
      AGENTPARTY_WRANGLER_CONFIG: target.config,
    },
  });
  run("wrangler-accounts", [
    "--profile", target.profile,
    "deploy", "--config", target.config,
    ...deploymentDefineArgs(deploymentMetadata),
  ], { env });
  await verifyDeploymentIdentity(target.smokeBase, deploymentMetadata);
  console.error(`Verified ${name} deployment: ${deploymentMetadata.version} ${deploymentMetadata.commit}`);
  // #1072：部署后 smoke 统一「先等 + 退避重试」。三次发版被三种瞬时症状卡住（runtime-peers
  // matches>1 / matches=0、pairing 500），全在上传完成后几十秒内、事后复跑都过——根因是新实例
  // 热身，不是各 smoke 的逻辑。部署前的 --credentials-only 自检不走重试：那是配置问题。
  const postDeploySmoke = { settleMs: 10_000 };
  await runSmokeWithRetry("desktop pairing smoke", () =>
    run("node", ["scripts/smoke-desktop-pairing.mjs"], {
      env: { ...env, AGENTPARTY_SMOKE_BASE: target.smokeBase },
    }), postDeploySmoke);

  await runSmokeWithRetry("runtime-peers smoke", () =>
    run("node", ["scripts/smoke-runtime-peers.mjs"], {
      env: {
        ...env,
        AGENTPARTY_SMOKE_BASE: target.smokeBase,
        AGENTPARTY_RUNTIME_SMOKE_TOKEN: target.runtimeSmokeToken,
        ...(target.runtimeSmokeChannel
          ? { AGENTPARTY_RUNTIME_SMOKE_CHANNEL: target.runtimeSmokeChannel }
          : {}),
      },
    }), postDeploySmoke);

  if (target.smokeToken && target.smokeWriteToken) {
    run("node", ["scripts/smoke-prod.mjs"], {
      env: {
        AGENTPARTY_SMOKE_BASE: target.smokeBase,
        AGENTPARTY_SMOKE_TOKEN: target.smokeToken,
        AGENTPARTY_SMOKE_WRITE_TOKEN: target.smokeWriteToken,
      },
    });
  } else {
    console.error(`Skipping ${name} smoke: smoke token env vars are not both set.`);
  }
}

function preflightTarget(name) {
  const target = targets[name];
  if (!target) throw new Error(`unknown deploy target: ${name}`);
  if (!target.runtimeSmokeToken) {
    throw new Error(`${name} deploy requires a runtime smoke agent token before migration/deploy`);
  }
  run("node", ["scripts/smoke-runtime-peers.mjs", "--credentials-only"], {
    env: {
      WRANGLER_PROFILE: target.profile,
      CI: "1",
      AGENTPARTY_SMOKE_BASE: target.smokeBase,
      AGENTPARTY_RUNTIME_SMOKE_TOKEN: target.runtimeSmokeToken,
      ...(target.runtimeSmokeChannel
        ? { AGENTPARTY_RUNTIME_SMOKE_CHANNEL: target.runtimeSmokeChannel }
        : {}),
    },
  });
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : ["prod", "xdream"];

for (const name of names) preflightTarget(name);
run("bun", ["run", "build:web"]);
for (const name of names) await deployTarget(name);

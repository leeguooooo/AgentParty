// CI worker 部署（#420）。
//
// 与本地 deploy-dual.mjs 的区别：CI 用 Cloudflare 原生凭据（CLOUDFLARE_API_TOKEN /
// CLOUDFLARE_ACCOUNT_ID，由 job 环境注入），而非本机 wrangler-accounts profile。
// prod 与 xdream 是两个独立 Cloudflare 账号，各自在自己的 GitHub Environment 里
// 提供一套 token/account，一个 job 只部署一个 target。
//
// 每个 target 的顺序（迁移 ↔ 代码守卫）：
//   1. runtime credentials preflight  —— 先确认 agent 身份和目标频道访问，不探测新协议
//   2. wrangler d1 migrations apply   —— 先把 schema 迁到位
//   3. verify-remote-schema.mjs       —— 校验迁移全部应用且必需列/索引存在，
//                                        失败即中断，绝不进入 deploy（半上线守卫）
//   4. wrangler deploy                —— 带 build 元数据 --define，供 /api/health 回读
//   5. verifyDeploymentIdentity       —— 拉取线上 health 确认精确 version+commit；deployed_at 仅观测
//   6. runtime-peers smoke            —— 双活 socket 验证 v3 live binding 与同安装关系
//   7. write smoke（token 齐全时）    —— 端到端写路径冒烟
//
// wrangler 启动器由 AGENTPARTY_WRANGLER_BIN 决定（空格分词），CI 传 "bunx wrangler"
// 走 worker devDependency 里的原生 wrangler；缺省 "wrangler" 走 PATH。

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deploymentDefineArgs, verifyDeploymentIdentity } from "./deployment-metadata.mjs";

export const DEPLOY_TARGETS = {
  prod: {
    config: "wrangler.jsonc",
    database: "agentparty",
    smokeBase: "https://agentparty.leeguoo.com",
  },
  xdream: {
    config: "wrangler.xdream.jsonc",
    database: "agentparty-xdream",
    smokeBase: "https://agentparty.pwtk-dev.work",
  },
};

// AGENTPARTY_WRANGLER_BIN 允许多词命令（如 "bunx wrangler"）。空格分词后第一个是
// 可执行文件，其余是固定前缀参数。缺省单独的 "wrangler"（PATH 上的原生 wrangler）。
export function parseWranglerLauncher(env = process.env) {
  const raw = (env.AGENTPARTY_WRANGLER_BIN ?? "wrangler").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["wrangler"];
}

// 返回一个 target 的有序执行计划（纯函数，便于单测断言命令构造，不触发任何 IO）。
export function buildDeployPlan(targetName, metadata, launcher = ["wrangler"]) {
  const target = DEPLOY_TARGETS[targetName];
  if (!target) {
    throw new Error(`unknown deploy target: ${targetName} (expected one of ${Object.keys(DEPLOY_TARGETS).join(", ")})`);
  }
  if (!Array.isArray(launcher) || launcher.length === 0) {
    throw new Error("wrangler launcher must be a non-empty argv array");
  }
  const [bin, ...prefix] = launcher;
  const wrangler = (args) => ({ cmd: bin, args: [...prefix, ...args] });
  const defineArgs = deploymentDefineArgs(metadata);

  return [
    {
      label: "migrate",
      ...wrangler(["d1", "migrations", "apply", target.database, "--remote", "--config", target.config]),
    },
    {
      label: "verify-schema",
      cmd: "node",
      args: ["scripts/verify-remote-schema.mjs"],
      env: {
        AGENTPARTY_D1_DATABASE: target.database,
        AGENTPARTY_WRANGLER_CONFIG: target.config,
      },
    },
    {
      label: "deploy",
      ...wrangler(["deploy", "--config", target.config, ...defineArgs]),
    },
  ];
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit ${res.status}`);
  }
}

function smokeEnv(name, key, env = process.env) {
  const scoped = env[`AGENTPARTY_${name.toUpperCase()}_${key}`];
  return scoped ?? env[`AGENTPARTY_${key}`];
}

export function buildPostDeploySmokePlan(name, smokeBase, env = process.env) {
  if (!DEPLOY_TARGETS[name]) throw new Error(`unknown deploy target: ${name}`);
  const smokeToken = smokeEnv(name, "SMOKE_TOKEN", env);
  const smokeWriteToken = smokeEnv(name, "SMOKE_WRITE_TOKEN", env);
  const runtimeSmokeToken = smokeEnv(name, "RUNTIME_SMOKE_TOKEN", env) ?? smokeToken;
  const runtimeSmokeChannel = smokeEnv(name, "RUNTIME_SMOKE_CHANNEL", env);
  if (!runtimeSmokeToken) {
    throw new Error(
      `${name} deploy requires RUNTIME_SMOKE_TOKEN or an agent-valued SMOKE_TOKEN before migration/deploy`,
    );
  }
  return [
    {
      label: "desktop-pairing-smoke",
      cmd: "node",
      args: ["scripts/smoke-desktop-pairing.mjs"],
      env: { AGENTPARTY_SMOKE_BASE: smokeBase },
    },
    {
      label: "runtime-peers-smoke",
      cmd: "node",
      args: ["scripts/smoke-runtime-peers.mjs"],
      env: {
        AGENTPARTY_SMOKE_BASE: smokeBase,
        AGENTPARTY_RUNTIME_SMOKE_TOKEN: runtimeSmokeToken,
        ...(runtimeSmokeChannel ? { AGENTPARTY_RUNTIME_SMOKE_CHANNEL: runtimeSmokeChannel } : {}),
      },
    },
    ...(smokeToken && smokeWriteToken
      ? [{
          label: "write-path-smoke",
          cmd: "node",
          args: ["scripts/smoke-prod.mjs"],
          env: {
            AGENTPARTY_SMOKE_BASE: smokeBase,
            AGENTPARTY_SMOKE_TOKEN: smokeToken,
            AGENTPARTY_SMOKE_WRITE_TOKEN: smokeWriteToken,
          },
        }]
      : []),
  ];
}

export function buildPreDeploySmokePlan(name, smokeBase, env = process.env) {
  const runtimeStep = buildPostDeploySmokePlan(name, smokeBase, env)
    .find((step) => step.label === "runtime-peers-smoke");
  if (!runtimeStep) throw new Error(`${name} runtime smoke plan is missing`);
  return [{
    ...runtimeStep,
    label: "runtime-credentials-preflight",
    args: [...runtimeStep.args, "--credentials-only"],
  }];
}

function preflightDeployTarget(name) {
  const target = DEPLOY_TARGETS[name];
  const smokeBase = smokeEnv(name, "SMOKE_BASE") ?? target.smokeBase;
  for (const step of buildPreDeploySmokePlan(name, smokeBase)) {
    run(step.cmd, step.args, { env: step.env });
  }
}

async function deployTarget(name, metadata, launcher) {
  const target = DEPLOY_TARGETS[name];
  const smokeBase = smokeEnv(name, "SMOKE_BASE") ?? target.smokeBase;
  // Rebuild the post-deploy plan from the same scoped settings already checked
  // by preflightDeployTarget before any target was mutated.
  const smokePlan = buildPostDeploySmokePlan(name, smokeBase);
  console.error(`\n==> Deploying ${name} (${target.config}) via ${launcher.join(" ")}`);

  for (const step of buildDeployPlan(name, metadata, launcher)) {
    run(step.cmd, step.args, { env: step.env });
  }

  // Code identity is version+commit. An idempotent redeploy of the same source
  // legitimately has a different deployed_at, and Cloudflare/custom-domain
  // propagation may expose either timestamp while still serving the exact
  // build. The following authenticated runtime smoke proves the live protocol.
  await verifyDeploymentIdentity(smokeBase, metadata);
  console.error(`Verified ${name}: ${metadata.version} ${metadata.commit}`);

  for (const step of smokePlan) run(step.cmd, step.args, { env: step.env });
  if (!smokePlan.some((step) => step.label === "write-path-smoke")) {
    console.error(`Skipping ${name} write-path smoke: SMOKE_TOKEN / SMOKE_WRITE_TOKEN not both set.`);
  }
}

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const names = requested.length > 0 ? requested : ["prod", "xdream"];
  for (const name of names) {
    if (!DEPLOY_TARGETS[name]) throw new Error(`unknown deploy target: ${name}`);
  }

  const launcher = parseWranglerLauncher();
  const metadata = {
    version: JSON.parse(readFileSync("../desktop/package.json", "utf8")).version,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    deployed_at: new Date().toISOString(),
  };

  for (const name of names) preflightDeployTarget(name);
  run("bun", ["run", "build:web"]);
  for (const name of names) await deployTarget(name, metadata, launcher);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

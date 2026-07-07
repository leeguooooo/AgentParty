// party doctor — 运行版 vs 磁盘安装版 vs 最新发布版，给出升级动作（issue #45）。
import { isHelpArg } from "../args";
import { RUNNING_VERSION, compareVersions, pendingUpgrade } from "../upgrade";

const OWNER_REPO = "leeguooooo/agentparty";
const INSTALL_LINE = `curl -fsSL https://raw.githubusercontent.com/${OWNER_REPO}/main/install.sh | sh`;

// 最新发布版：跟 releases/latest 的 302 到 .../tag/vX.Y.Z（与 install.sh resolve_version 同源）。
async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://github.com/${OWNER_REPO}/releases/latest`, {
      method: "HEAD",
      redirect: "follow",
    });
    const m = res.url.match(/\/tag\/v?(\d+\.\d+\.\d+)/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv)) {
    console.log("usage: party doctor\n\ncheck running / installed / latest party version and how to upgrade.");
    return 0;
  }
  console.log(`running:   ${RUNNING_VERSION}`);

  // 磁盘安装版（编译版二进制）：pendingUpgrade 只在磁盘更新时返回版本；相等/更旧则不提示。
  const pending = pendingUpgrade();
  if (pending) {
    console.log(`installed: ${pending}  ← 磁盘已是更新版；正在跑的 serve 需要【重启】才能用上`);
    console.log(`  重启在跑的 serve（或加 --auto-upgrade 让它唤醒间隙自动 re-exec）`);
  }

  const latest = await latestVersion();
  if (latest === null) {
    console.log("latest:    (查不到，网络问题？可手动看 github releases)");
    return 0;
  }
  console.log(`latest:    ${latest}`);
  const cmp = compareVersions(latest, RUNNING_VERSION);
  if (cmp > 0) {
    console.log(`\n有新版可升 → 升级：\n  ${INSTALL_LINE}\n升级后【重启在跑的 serve/watch】才生效（issue #45）。`);
  } else {
    console.log("\n已是最新。");
  }
  return 0;
}

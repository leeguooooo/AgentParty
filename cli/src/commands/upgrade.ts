import { INSTALL_LINE, compareVersions, downloadPartyUpgrade } from "../upgrade";

function help(): string {
  return [
    "usage: party upgrade [--version X.Y.Z] [--check]",
    "",
    "Download the GitHub Release binary, verify sha256, and atomically replace the running party binary.",
    "Falls back to the installer when the current executable is not a compiled party binary.",
  ].join("\n");
}

export async function run(argv: string[]): Promise<number> {
  let version = "latest";
  let checkOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(help());
      return 0;
    }
    if (arg === "--check") {
      checkOnly = true;
      continue;
    }
    if (arg === "--version") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) {
        console.error("--version requires X.Y.Z");
        return 1;
      }
      version = next;
      continue;
    }
    console.error(`unknown option: ${arg}`);
    console.log(help());
    return 1;
  }

  try {
    const result = await downloadPartyUpgrade({ version, checkOnly });
    if (checkOnly) {
      console.log(`running: ${result.running_version}`);
      console.log(`target:  ${result.target_version} (${result.target})`);
      if (compareVersions(result.target_version, result.running_version) > 0) {
        console.log(`upgrade available: ${result.asset_url}`);
      } else {
        console.log("already current");
      }
      return 0;
    }
    if (result.reason === "already_current") {
      console.log(`party is already current: v${result.running_version}`);
      return 0;
    }
    console.log(`installed party v${result.target_version} -> ${result.install_path}`);
    console.log("restart running serve/watch processes to use the new binary; serve --auto-upgrade will re-exec at the next safe point.");
    return 0;
  } catch (error) {
    console.error(`party upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`fallback: ${INSTALL_LINE}`);
    return 1;
  }
}

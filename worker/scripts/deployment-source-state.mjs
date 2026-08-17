// Deployment metadata names a Git commit, so every file that can affect the
// Worker bundle or its static assets must match that commit. Limit the check to
// real deployment inputs: unrelated CLI/docs work should not block a Worker
// release, while untracked source must never slip past the provenance gate.
export const DEPLOYMENT_SOURCE_PATHS = Object.freeze([
  "worker",
  "shared",
  "web",
  "desktop/package.json",
  "package.json",
  "bun.lock",
]);

export function deploymentSourceStatusArgs() {
  return [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...DEPLOYMENT_SOURCE_PATHS,
  ];
}

export function assertDeploymentSourceClean(status) {
  const changes = typeof status === "string" ? status.trim() : "";
  if (changes !== "") {
    throw new Error(`refusing to deploy uncommitted deployment-source changes:\n${changes}`);
  }
}

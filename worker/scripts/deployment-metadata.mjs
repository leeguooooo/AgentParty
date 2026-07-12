const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const DEFAULT_VERIFY_ATTEMPTS = 90;
const DEFAULT_REQUIRED_CONSECUTIVE = 3;
const DEFAULT_VERIFY_DELAY_MS = 1_000;

const defaultSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export function validateDeploymentMetadata(metadata) {
  if (!metadata || !SEMVER_RE.test(metadata.version)) throw new Error("deployment version is invalid");
  if (!COMMIT_RE.test(metadata.commit)) throw new Error("deployment commit is invalid");
  if (typeof metadata.deployed_at !== "string" || Number.isNaN(Date.parse(metadata.deployed_at))) {
    throw new Error("deployment timestamp is invalid");
  }
  return metadata;
}

export function deploymentDefineArgs(metadata) {
  validateDeploymentMetadata(metadata);
  return [
    "--define", `__AGENTPARTY_BUILD_VERSION__:${JSON.stringify(metadata.version)}`,
    "--define", `__AGENTPARTY_BUILD_COMMIT__:${JSON.stringify(metadata.commit)}`,
    "--define", `__AGENTPARTY_DEPLOYED_AT__:${JSON.stringify(metadata.deployed_at)}`,
  ];
}

export async function readDeploymentMetadata(base, fetcher = fetch) {
  const origin = base.replace(/\/+$/, "");
  const response = await fetcher(`${origin}/api/health?deployment_metadata=1`, {
    headers: { "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`deployment health returned ${response.status}`);

  const actual = await response.json();
  if (actual?.ok !== true) throw new Error("deployment health is not ok");
  validateDeploymentMetadata(actual);
  return { version: actual.version, commit: actual.commit, deployed_at: actual.deployed_at };
}

export async function verifyDeploymentMetadata(base, expected, fetcher = fetch, options = {}) {
  validateDeploymentMetadata(expected);
  return verifyStableDeploymentMetadata(base, fetcher, options, (actual) => {
    for (const field of ["version", "commit", "deployed_at"]) {
      if (actual?.[field] !== expected[field]) {
        throw new Error(`${field} mismatch: expected ${expected[field]}, got ${actual?.[field] ?? "missing"}`);
      }
    }
  });
}

export async function verifyDeploymentIdentity(base, expected, fetcher = fetch, options = {}) {
  if (!expected || !SEMVER_RE.test(expected.version)) throw new Error("deployment version is invalid");
  if (!COMMIT_RE.test(expected.commit)) throw new Error("deployment commit is invalid");
  return verifyStableDeploymentMetadata(base, fetcher, options, (actual) => {
    for (const field of ["version", "commit"]) {
      if (actual?.[field] !== expected[field]) {
        throw new Error(`${field} mismatch: expected ${expected[field]}, got ${actual?.[field] ?? "missing"}`);
      }
    }
  });
}

async function verifyStableDeploymentMetadata(base, fetcher, options, assertExpected) {
  const attempts = options.attempts ?? DEFAULT_VERIFY_ATTEMPTS;
  const requiredConsecutive = options.consecutive ?? DEFAULT_REQUIRED_CONSECUTIVE;
  const delayMs = options.delayMs ?? DEFAULT_VERIFY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("deployment verification attempts are invalid");
  if (!Number.isInteger(requiredConsecutive) || requiredConsecutive < 1 || requiredConsecutive > attempts) {
    throw new Error("deployment consecutive verification count is invalid");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("deployment verification delay is invalid");

  let lastError;
  let consecutiveMatches = 0;
  let previousMetadata = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const actual = await readDeploymentMetadata(base, fetcher);
      assertExpected(actual);
      const serialized = JSON.stringify(actual);
      consecutiveMatches = serialized === previousMetadata ? consecutiveMatches + 1 : 1;
      previousMetadata = serialized;
      if (consecutiveMatches >= requiredConsecutive) return actual;
      lastError = new Error(`deployment metadata was not stable for ${requiredConsecutive} consecutive checks`);
    } catch (error) {
      lastError = error;
      consecutiveMatches = 0;
      previousMetadata = null;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw lastError;
}

export async function verifyDualDeployment(targets, expected, fetcher = fetch, options = {}) {
  const verified = {};
  for (const [name, base] of Object.entries(targets)) {
    try {
      verified[name] = await verifyDeploymentMetadata(base, expected, fetcher, options);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return verified;
}

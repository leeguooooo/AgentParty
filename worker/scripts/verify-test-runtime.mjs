import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { lockedPoolRuntimeVersion } from "./verify-test-runtime-lib.mjs";

const require = createRequire(import.meta.url);
const wranglerConfig = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const requested = wranglerConfig.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];

let workerdVersion = "unknown";
let source = "package";
try {
  const lock = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8");
  const poolRuntime = lockedPoolRuntimeVersion(lock);
  if (poolRuntime !== null) {
    workerdVersion = poolRuntime.version;
    source = "bun.lock:@cloudflare/vitest-pool-workers";
  } else {
    const pkgPath = require.resolve("workerd/package.json");
    workerdVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  }
} catch {
  // Package layout differs across package managers; leave as unknown.
}

const runtimeDate = workerdVersion.match(/(\d{4})(\d{2})(\d{2})/)?.slice(1, 4).join("-");
const status =
  requested && runtimeDate && runtimeDate < requested
    ? "warning"
    : requested && runtimeDate
      ? "ok"
      : "unknown";

console.log(
  JSON.stringify({
    ok: status !== "unknown",
    status,
    requestedCompatibilityDate: requested ?? null,
    installedWorkerdVersion: workerdVersion,
    installedRuntimeDate: runtimeDate ?? null,
    source,
    note:
      status === "warning"
        ? "local Worker tests run on an older runtime than wrangler.jsonc; update the Cloudflare Vitest pool for parity"
        : undefined,
  }),
);

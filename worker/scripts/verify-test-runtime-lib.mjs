export function lockedPoolRuntimeVersion(lock) {
  const poolEntry = lock.match(
    /"@cloudflare\/vitest-pool-workers": \[[\s\S]*?"miniflare": "((?:4|5)\.(\d{8})\.[^"]+)"/,
  );
  return poolEntry?.[1]
    ? { version: `miniflare@${poolEntry[1]}`, runtimeDate: poolEntry[2] }
    : null;
}

// 部署后 smoke 的统一重试（#1072）。
//
// 三次发版被三种不同的瞬时症状卡住：runtime-peers `matches>1`（残留 socket）、`matches=0`
// （DO 还没把 smoke 自己的 socket 认成 caller）、desktop-pairing 500——全都发生在 wrangler 上传
// 完成后的几十秒内，事后同一脚本连打都过，worker 代码两版之间一字未改。共同根因是「新版本刚上、
// DO/D1 还在热身」，不是各 smoke 各自的逻辑。逐个 smoke 修不划算：先等一小段，失败按退避重试。
//
// 重试只对**部署后**的 smoke；部署前的凭据自检（--credentials-only）不走这里——它失败是配置问题，
// 重试没有意义。

/** 每次失败后等多久：5s → 10s → 20s → 40s。总共最多再试 delays.length 次。 */
export function retryDelaysMs(attempts = 5) {
  const out = [];
  for (let i = 1; i < attempts; i += 1) out.push(5_000 * 2 ** (i - 1));
  return out;
}

/**
 * 跑一个会抛错的同步/异步 smoke。settleMs：首次尝试前先等（给刚部署的实例热身）。
 * 全部失败时抛最后一次的错误，并把每次的原因都印出来——否则 rerun 的人看不见前几次是什么症状。
 */
export async function runSmokeWithRetry(label, attempt, options = {}) {
  const delays = options.delays ?? retryDelaysMs(options.attempts ?? 5);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line) => console.error(line));
  const settleMs = options.settleMs ?? 0;
  if (settleMs > 0) {
    log(`${label}: waiting ${settleMs / 1000}s for the fresh deployment to settle before the first attempt`);
    await sleep(settleMs);
  }
  const failures = [];
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      await attempt();
      if (i > 0) log(`${label}: passed on attempt ${i + 1} (earlier: ${failures.join(" | ")})`);
      return;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failures.push(`#${i + 1} ${reason}`);
      if (i === delays.length) break;
      log(`${label}: attempt ${i + 1} failed (${reason}); retrying in ${delays[i] / 1000}s`);
      await sleep(delays[i]);
    }
  }
  throw new Error(`${label}: failed ${failures.length} attempts — ${failures.join(" | ")}`);
}

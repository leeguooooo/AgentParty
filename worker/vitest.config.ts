import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  const migrations = await readD1Migrations(migrationsDir);
  return {
    test: {
      // 单 workerd 运行时串行跑全部 spec，满载时个别 WS 握手/DO 交互偶发超过默认 5000ms
      // （非代码 bug，隔离单跑 75ms；见 issue #43）。抬到 20s 消除随机挡发布的假超时。
      testTimeout: 20_000,
      hookTimeout: 20_000,
      // CI 满载下 vitest-pool-workers 跨 spec 文件反复 invalidate DO（thrash），偶发把
      // WS 握手/DO fetch 顶超时、挡住 release（#48）。CI 里 retry 1 次仅作兜底：真 bug
      // 连挂两次仍然红，retry 通过的用例 vitest 会标 flaky、不丢信号；本地不 retry 保持严格。
      retry: process.env.CI ? 1 : 0,
      // Worker specs share one workerd runtime and many tests keep WebSocket / Durable Object
      // state alive across ticks. Running spec files in parallel makes the pool invalidate the
      // Worker module while another spec still holds a DO stub, producing false
      // "worker/src/index.ts changed, invalidating this Durable Object" failures (#48).
      fileParallelism: false,
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          // ws 连接跨事件循环，隔离存储会与挂起的 ws 事件互踩；用唯一 slug/name 代替隔离
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              ADMIN_SECRET: "test-admin-secret",
              TEST_MIGRATIONS: migrations,
              // 静态启用 OIDC，供 e2e 走 SELF.fetch 验证人类网页登录（未配 OIDC 的降级路径由单元测试覆盖）
              OIDC_ISSUER: "https://oidc.test",
              OIDC_CLIENT_ID: "ap-web",
              AUTH_PROVIDERS: JSON.stringify([
                { id: "lark-main", kind: "lark", client_id: "cli_test_lark" },
              ]),
              LARK_CLIENT_SECRET: "test-lark-secret",
            },
          },
        },
      },
    },
  };
});

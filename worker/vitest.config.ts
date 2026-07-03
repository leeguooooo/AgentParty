import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  const migrations = await readD1Migrations(migrationsDir);
  return {
    test: {
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
            },
          },
        },
      },
    },
  };
});

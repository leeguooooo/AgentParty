import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 发布版本的单一真源是 cli/package.json（scripts/release-version.ts 每次发布把 cli/desktop/cargo
// 同步到同一版号）。构建/开发时把它注入前端，接入脚本里的版本闸就永远等于刚发布的 CLI——不再手改
// joinPack 常量、也不再像 #612 那样漂移。仅无 Vite 的 bun 单测环境拿不到，走 releaseVersion 的 fallback。
const cliVersion = (JSON.parse(readFileSync(fileURLToPath(new URL("../cli/package.json", import.meta.url)), "utf8")) as { version: string }).version;

export default defineConfig({
  define: {
    __PARTY_CLI_VERSION__: JSON.stringify(cliVersion),
  },
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // vendor 分包：框架 / 高亮 / markdown 各自成 chunk，改业务代码不再抖动整包缓存。
        // vite 8（rolldown 内核）不再接受对象形 manualChunks，只认函数形。
        manualChunks(id: string) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) return "react";
          if (id.includes("node_modules/highlight.js/")) return "hljs";
          if (id.includes("node_modules/marked/") || id.includes("node_modules/dompurify/")) return "markdown";
          return undefined;
        },
      },
    },
  },
  server: {
    // 本地联调：wrangler-accounts dev 默认 8787
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/openapi.json": { target: "http://localhost:8787" },
    },
  },
});

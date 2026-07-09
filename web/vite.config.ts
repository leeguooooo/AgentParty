import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // vendor 分包：框架 / 高亮 / markdown 各自成 chunk，改业务代码不再抖动整包缓存
        manualChunks: {
          react: ["react", "react-dom"],
          hljs: ["highlight.js/lib/core"],
          markdown: ["marked", "dompurify"],
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

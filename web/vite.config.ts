import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    // 本地联调：wrangler dev 默认 8787
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/openapi.json": { target: "http://localhost:8787" },
    },
  },
});

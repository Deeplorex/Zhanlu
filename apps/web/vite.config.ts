import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/** 开发时直接提供 CMap，构建时拷到 dist/cmaps（中文 CID 字体必需）。 */
function pdfjsCmaps(): Plugin {
  const src = resolve(here, "node_modules/pdfjs-dist/cmaps");
  let isBuild = false;
  return {
    name: "pdfjs-cmaps",
    configResolved(config) { isBuild = config.command === "build"; },
    configureServer(server) {
      server.middlewares.use("/cmaps", (req, res, next) => {
        const name = (req.url || "").replace(/^\//, "");
        if (!/^[\w.-]+\.bcmap$/.test(name)) { next(); return; }
        try {
          res.setHeader("Content-Type", "application/octet-stream");
          res.end(readFileSync(resolve(src, name)));
        } catch { next(); }
      });
    },
    closeBundle() {
      if (!isBuild) return;
      const dest = resolve(here, "dist/cmaps");
      cpSync(src, dest, { recursive: true });
      const count = readdirSync(dest).length;
      console.log(`[pdfjs-cmaps] copied ${count} cmap files → dist/cmaps`);
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsCmaps()],
  base: "./", // 相对路径：引擎静态服务直接可用
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // 开发代理到本机引擎（引擎以 --dev 启动）
    proxy: { "/api": `http://127.0.0.1:${process.env.ZHANLU_ENGINE_PORT || "8741"}` },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export default defineConfig({
  root: resolve(import.meta.dirname, "desktop/renderer"),
  base: "./",
  publicDir: resolve(import.meta.dirname, "public"),
  plugins: [react(), {
    name: "local-pdfjs-support-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", async (request, response, next) => {
        const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
        if (!/^\/(cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+$/u.test(pathname) || !["GET", "HEAD"].includes(request.method || "")) { next(); return; }
        try {
          const path = resolve(import.meta.dirname, "node_modules/pdfjs-dist", `.${pathname}`);
          const info = await stat(path);
          if (!info.isFile()) { next(); return; }
          response.setHeader("Content-Length", info.size);
          response.setHeader("Content-Type", pathname.endsWith(".wasm") ? "application/wasm" : pathname.endsWith(".js") ? "application/javascript" : "application/octet-stream");
          if (request.method === "HEAD") response.end();
          else createReadStream(path).on("error", () => response.destroy()).pipe(response);
        } catch { next(); }
      });
    },
  }],
  build: {
    outDir: resolve(import.meta.dirname, "dist-desktop/renderer"),
    emptyOutDir: true,
    target: "chrome152",
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
    fs: { allow: [import.meta.dirname] },
  },
});

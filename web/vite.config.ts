import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";

/**
 * Lively's WebView2 player opens wallpapers from disk (file://). Chromium refuses
 * to load ES modules from file:// (origin "null"), so the bundle is emitted as a
 * single classic IIFE script and every asset is inlined. Nothing is fetched at
 * runtime and nothing comes from a CDN.
 */
function classicScript(): Plugin {
  return {
    name: "vision-classic-script",
    enforce: "post",
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, '<script defer src="$1"></script>')
        .replace(/ crossorigin/g, "");
    },
  };
}

export default defineConfig(({ mode }) => {
  const target = mode === "phase0" ? "phase0" : "wallpaper";
  const outDir = target === "phase0" ? resolve(__dirname, "../tools/phase0") : resolve(__dirname, "../wallpaper");
  return {
    root: resolve(__dirname, target === "phase0" ? "phase0" : "."),
    base: "./",
    publicDir: resolve(__dirname, target === "phase0" ? "public-phase0" : "public-wallpaper"),
    plugins: [classicScript()],
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
      assetsDir: "js",
      assetsInlineLimit: 1024 * 1024,
      modulePreload: false,
      cssCodeSplit: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          format: "iife",
          inlineDynamicImports: true,
          entryFileNames: "js/vision.js",
          assetFileNames: "js/[name][extname]",
        },
      },
    },
    server: { port: 5173 },
  };
});

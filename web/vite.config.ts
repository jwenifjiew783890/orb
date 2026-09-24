import { defineConfig, type Plugin } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  // Build targets: the wallpaper, the Phase 0 runtime probe, and the desktop-shell
  // interaction probe. Each is a self-contained Lively wallpaper folder.
  const targets = {
    wallpaper: { root: ".", out: "../wallpaper", pub: "public-wallpaper" },
    phase0: { root: "phase0", out: "../tools/phase0", pub: "public-phase0" },
    probe: { root: "desktop-probe", out: "../tools/desktop-probe", pub: "public-desktop-probe" },
  } as const;
  const t = targets[(mode in targets ? mode : "wallpaper") as keyof typeof targets];
  const outDir = resolve(__dirname, t.out);
  return {
    root: resolve(__dirname, t.root),
    base: "./",
    publicDir: resolve(__dirname, t.pub),
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
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        output: {
          format: "iife",
          entryFileNames: "js/vision.js",
          assetFileNames: "js/[name][extname]",
        },
      },
    },
    server: { port: 5173 },
  };
});

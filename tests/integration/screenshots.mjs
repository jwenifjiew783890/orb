// Captures the brief §47 screenshot set into docs/screenshots/.
// Rendering is SwiftShader (CPU) — visually identical to GPU output.
import { mkdtempSync, writeFileSync, chmodSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, startHelper } from "../lib/helper.mjs";
import { launch } from "./browser.mjs";

const OUT = join(ROOT, "docs", "screenshots");
const W = 1920, H = 1080;
const dir = mkdtempSync(join(tmpdir(), "vision-shots-"));
const exe = join(dir, "app"); writeFileSync(exe, "#!/bin/sh\n"); chmodSync(exe, 0o755);
const h = await startHelper({ apps: ["Chrome", "Files", "Notepad", "Calculator", "Settings", "Terminal"].map((l) => ({ id: l.toLowerCase(), label: l, exe })) });
const wp = join(dir, "wallpaper");
cpSync(join(ROOT, "wallpaper"), wp, { recursive: true });
execFileSync(h.bin, ["--config", h.cfgPath, "--write-token-js", wp]);
const base = pathToFileURL(join(wp, "index.html")).href;
const browser = await launch();

async function shot(name, query, prep, wait = 3500) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto(`${base}?auto=0&name=Muaz&${query}`);
  await page.waitForFunction(() => window.__vision?.helper.status === "online", null, { timeout: 10000 }).catch(() => {});
  if (prep) await prep(page);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(OUT, `${name}.jpg`), type: "jpeg", quality: 90 });
  await page.close();
  console.log("captured", name);
}

await shot("gold-low", "t=24&q=low");
await shot("gold-medium", "t=24&q=medium");
await shot("gold-high", "t=24&q=high");
await shot("blue-medium", "t=24&theme=arc");
await shot("crimson-medium", "t=24&theme=crimson");
await shot("idle", "t=40");
await shot("hover", "t=40", async (p) => { await p.waitForTimeout(3000); await p.mouse.move(W / 2, H / 2 - 30); });
await shot("dragging", "t=40", async (p) => {
  await p.waitForTimeout(3000);
  await p.mouse.move(W / 2, H / 2); await p.mouse.down();
  await p.mouse.move(W / 2 + 260, H / 2 + 90, { steps: 20 });
}, 300);
await shot("app-ring", "t=40", async (p) => {
  await p.waitForTimeout(3000);
  await p.evaluate(() => { window.__vision.sm.go("APP_RING"); window.__vision.ring.open(); });
}, 4500);
await shot("launching", "t=40", async (p) => {
  await p.waitForTimeout(3000);
  await p.evaluate(() => { window.__vision.sm.go("APP_RING"); window.__vision.ring.open(); });
  await p.waitForFunction(() => window.__vision.ring.currentPhase === "open", null, { timeout: 8000 });
  await p.waitForTimeout(800);
  await p.evaluate(() => document.querySelector(".app-node").click());
  // freeze mid-launch: stop advancing the ring once the beam has reached the core
  await p.waitForFunction(() => window.__vision.ring.currentPhase === "launching" && window.__vision.orb.uniforms.uBurst.value > 0.5, null, { timeout: 8000 });
  await p.evaluate(() => { window.__vision.ring.update = () => {}; });
}, 200);
await shot("offline-hud", "t=40", async (p) => { await p.evaluate(() => window.__vision.helper.configure({ port: 1 })); }, 5000);
await shot("debug-overlay", "t=40&debug=1", null, 5000);

// boot sequence frames (boot clock frozen at each instant via ?boot=)
for (const b of [0.35, 0.7, 1.0, 1.25, 1.6, 2.2]) {
  await shot(`boot-${b.toFixed(2).replace(".", "_")}s`, `t=12&boot=${b}`, null, 3000);
}
await browser.close();
await h.stop();

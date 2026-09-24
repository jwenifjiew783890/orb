// Headless performance measurement (Linux container, Chromium + SwiftShader).
//
// What this CAN measure faithfully: the wallpaper page's own main-thread CPU
// cost (JS + style/layout + WebGL command encoding) via CDP Performance
// metrics, JS heap, draw calls, and the scheduler's frame rate.
// What it CANNOT: GPU cost (SwiftShader rasterises on the CPU in another
// process), Lively/WebView2 process overhead, real display pacing. Those are
// measured on Windows with tools/windows/perf-sample.ps1.
import { launch } from "../integration/browser.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { ROOT } from "../lib/helper.mjs";

const W = Number(process.env.W ?? 1280), H = Number(process.env.H ?? 720);
const Q = process.env.Q ?? "medium";
const SECS = Number(process.env.SECS ?? 15);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
await page.goto(pathToFileURL(join(ROOT, "wallpaper", "index.html")).href + `?auto=0&q=${Q}`);
await page.waitForTimeout(4000); // boot + generation

async function metrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function scenario(name, drive) {
  const f0 = await page.evaluate(() => window.__vision.perf.frames);
  const m0 = await metrics();
  const t0 = Date.now();
  const stopDrive = drive ? drive() : null;
  await page.waitForTimeout(SECS * 1000);
  if (stopDrive) await stopDrive();
  const m1 = await metrics();
  const f1 = await page.evaluate(() => window.__vision.perf.frames);
  const secs = (Date.now() - t0) / 1000;
  const r = {
    scenario: name,
    fps: +((f1 - f0) / secs).toFixed(1),
    mainThreadCpuPct: +(100 * (m1.TaskDuration - m0.TaskDuration) / secs).toFixed(2),
    scriptCpuPct: +(100 * (m1.ScriptDuration - m0.ScriptDuration) / secs).toFixed(2),
    cpuMsPerFrame: f1 > f0 ? +((1000 * (m1.TaskDuration - m0.TaskDuration)) / (f1 - f0)).toFixed(2) : 0,
    jsHeapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
    targetFps: await page.evaluate(() => window.__vision.targetFps),
  };
  console.log(JSON.stringify(r));
  return r;
}

const results = [];
await page.mouse.move(5, 5);
await page.waitForFunction(() => window.__vision.targetFps === 30, null, { timeout: 10000 });
results.push(await scenario("idle"));
results.push(await scenario("interaction", () => {
  let on = true;
  (async () => {
    let a = 0;
    while (on) {
      a += 0.3;
      await page.mouse.move(W / 2 + Math.cos(a) * 80, H / 2 + Math.sin(a) * 60);
      await page.waitForTimeout(50);
    }
  })();
  return async () => { on = false; await page.waitForTimeout(100); await page.mouse.move(5, 5); };
}));
await page.evaluate(() => window.livelyWallpaperPlaybackChanged(JSON.stringify({ IsPaused: true })));
results.push(await scenario("paused"));
await page.evaluate(() => window.livelyWallpaperPlaybackChanged(JSON.stringify({ IsPaused: false })));

// Draw calls / primitives from the debug overlay's scene sampling
await page.evaluate(() => livelyPropertyListener("debugOverlay", true));
await page.waitForTimeout(2500);
const dbg = await page.$eval(".debug", (e) => e.textContent);
const renderer = await page.evaluate(() => window.__vision.core.gpuName);
const out = { when: new Date().toISOString(), viewport: `${W}x${H}`, quality: Q, secondsPerScenario: SECS, renderer, results, debugOverlay: dbg };
mkdirSync(join(ROOT, "docs", "perf"), { recursive: true });
writeFileSync(join(ROOT, "docs", "perf", `headless-${Q}-${W}x${H}.json`), JSON.stringify(out, null, 2));
console.log(dbg);
await browser.close();

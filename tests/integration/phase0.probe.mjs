// Phase 0: load the probe wallpaper from file:// (as Lively does), drive mouse,
// visibility, simulated Lively pause/property calls, and record the results.
import { launch } from "./browser.mjs";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { writeFileSync } from "node:fs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const url = pathToFileURL(resolve(root, "tools/phase0/index.html")).href;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleMsgs = [];
page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => consoleMsgs.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForTimeout(2500);
await page.mouse.move(640, 360);
await page.mouse.down(); await page.mouse.move(760, 400, { steps: 10 }); await page.mouse.up();
await page.mouse.wheel(0, 120);
await page.evaluate(() => { window.livelyPropertyListener("probeToggle", true); });
const framesBefore = await page.evaluate(() => window.__probe.frames);
await page.evaluate(() => window.livelyWallpaperPlaybackChanged(JSON.stringify({ IsPaused: true })));
await page.waitForTimeout(1500);
const framesDuringPause = await page.evaluate(() => window.__probe.frames);
await page.waitForTimeout(1000);
const framesAfterPause = await page.evaluate(() => window.__probe.frames);
await page.evaluate(() => window.livelyWallpaperPlaybackChanged(JSON.stringify({ IsPaused: false })));
await page.waitForTimeout(1500);
const framesResumed = await page.evaluate(() => window.__probe.frames);
await page.screenshot({ path: resolve(root, "docs/screenshots/phase0-probe.png") });
const probe = await page.evaluate(() => window.__probe);
await browser.close();

const result = {
  url, probe,
  pause: { framesBefore, framesDuringPause, framesAfterPause, framesResumed,
           stoppedWhilePaused: framesAfterPause === framesDuringPause, resumed: framesResumed > framesAfterPause },
  console: consoleMsgs,
};
writeFileSync(resolve(root, "docs/phase0-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

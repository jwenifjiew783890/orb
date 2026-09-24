// Deterministic screen recording: the wallpaper runs in ?capture=1 mode, where
// each frame advances exactly 1/30 s regardless of how slowly SwiftShader
// renders it. Output: docs/media/vision-orb.webm (30 fps), plus the Lively
// preview.gif / thumbnail.jpg in wallpaper/.
import { mkdtempSync, writeFileSync, chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, startHelper } from "../lib/helper.mjs";
import { launch } from "./browser.mjs";

const W = 1280, H = 720;
const FFMPEG = "/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux";
const dir = mkdtempSync(join(tmpdir(), "vision-rec-"));
const frames = join(dir, "frames"); mkdirSync(frames);
const exe = join(dir, "app"); writeFileSync(exe, "#!/bin/sh\n"); chmodSync(exe, 0o755);
const h = await startHelper({ apps: ["Chrome", "Files", "Notepad", "Calculator", "Settings", "Terminal"].map((l) => ({ id: l.toLowerCase(), label: l, exe })) });
const wp = join(dir, "wallpaper");
cpSync(join(ROOT, "wallpaper"), wp, { recursive: true });
execFileSync(h.bin, ["--config", h.cfgPath, "--write-token-js", wp]);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(pathToFileURL(join(wp, "index.html")).href + "?capture=1&auto=0&q=medium&name=Muaz");
await page.waitForFunction(() => window.__vision?.helper.status === "online", null, { timeout: 10000 });
let n = 0;
async function run(count, each) {
  for (let i = 0; i < count; i++) {
    if (each) await each(i);
    await page.evaluate(() => window.__vision.captureStep(1));
    await page.screenshot({ path: join(frames, `f${String(n++).padStart(5, "0")}.png`) });
  }
}
const cx = W / 2, cy = H / 2 - 25;
await run(96);                                          // boot (3.2 s)
await run(45);                                          // idle
await page.mouse.move(cx + 40, cy + 20);                // hover
await run(60, async (i) => { await page.mouse.move(cx + 40 + Math.sin(i / 9) * 30, cy + 20); });
await page.mouse.move(cx, cy); await page.mouse.down(); // drag
await run(40, async (i) => { await page.mouse.move(cx + i * 6, cy + i * 1.5); });
await page.mouse.up();
await run(30);
await page.evaluate(() => { window.__vision.sm.go("APP_RING"); window.__vision.ring.open(); }); // click equivalent
await run(75);
await page.evaluate(() => [...document.querySelectorAll(".app-node")].find((e) => e.textContent.includes("Terminal"))?.click());
await run(60);                                          // launch + ring close
await page.mouse.move(8, 8);
await run(45);
await browser.close();
await h.stop();
mkdirSync(join(ROOT, "docs", "media"), { recursive: true });
execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", "30", "-i", join(frames, "f%05d.png"), "-c:v", "libvpx", "-b:v", "6M", "-crf", "8", join(ROOT, "docs", "media", "vision-orb.webm")]);
console.log(`recorded ${n} frames → docs/media/vision-orb.webm`);
writeFileSync(join(dir, "frames.txt"), frames);
console.log(frames);

// Accelerated soak (container): wallpaper + real helper for SOAK_MIN minutes,
// sampling every SAMPLE_S seconds: JS heap, DOM nodes, listeners, frames,
// helper RSS, link status. The real 24 h soak runs on Windows with
// tools/windows/perf-sample.ps1 -Label soak -DurationSec 86400 -IntervalSec 600.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, startHelper } from "../lib/helper.mjs";
import { launch } from "../integration/browser.mjs";

const MIN = Number(process.env.SOAK_MIN ?? 10);
const SAMPLE = Number(process.env.SAMPLE_S ?? 30);
const h = await startHelper({ apps: [] });
const wp = join(mkdtempSync(join(tmpdir(), "vision-soak-")), "wallpaper");
cpSync(join(ROOT, "wallpaper"), wp, { recursive: true });
execFileSync(h.bin, ["--config", h.cfgPath, "--write-token-js", wp]);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
await page.goto(pathToFileURL(join(wp, "index.html")).href + "?auto=0&q=medium");
await page.waitForTimeout(5000);
const rss = () => { try { return +(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${h.proc.pid}/status`, "utf8"))[1]) / 1024).toFixed(1); } catch { return null; } };
const rows = [];
const t0 = Date.now();
let i = 0;
while (Date.now() - t0 < MIN * 60000) {
  // exercise the interaction paths periodically (hover + ring open/close)
  if (i % 4 === 1) {
    await page.mouse.move(480, 250); await page.waitForTimeout(800);
    await page.evaluate(() => { window.__vision.sm.go("APP_RING"); window.__vision.ring.open(); });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__vision.ring.close());
    await page.mouse.move(5, 5);
  }
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const v = await page.evaluate(() => ({ frames: window.__vision.perf.frames, link: window.__vision.helper.status }));
  const row = {
    t_min: +((Date.now() - t0) / 60000).toFixed(2),
    js_heap_mb: +(m.JSHeapUsedSize / 1048576).toFixed(2),
    dom_nodes: m.Nodes, listeners: m.JSEventListeners,
    frames: v.frames, link: v.link, helper_rss_mb: rss(),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  i++;
  await page.waitForTimeout(SAMPLE * 1000);
}
await browser.close();
await h.stop();
mkdirSync(join(ROOT, "docs", "perf"), { recursive: true });
writeFileSync(join(ROOT, "docs", "perf", `mini-soak-${MIN}min.json`), JSON.stringify(rows, null, 2));
const first = rows[1] ?? rows[0], last = rows[rows.length - 1];
console.log(`heap ${first.js_heap_mb} → ${last.js_heap_mb} MB, listeners ${first.listeners} → ${last.listeners}, nodes ${first.dom_nodes} → ${last.dom_nodes}, helper RSS ${first.helper_rss_mb} → ${last.helper_rss_mb} MB`);

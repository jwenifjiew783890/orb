// End-to-end: wallpaper (file://, like Lively) ↔ real helper binary.
// Pairing via --write-token-js, live stats in the HUD, app ring launch,
// helper crash → "STATS OFFLINE" while the orb keeps rendering → reconnect.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, startHelper, waitFor } from "../lib/helper.mjs";
import { launch } from "./browser.mjs";

let h, browser, page, wpDir, marker;
const logs = [];

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "vision-e2e-"));
  marker = join(dir, "launched.txt");
  const exe = join(dir, "notes");
  writeFileSync(exe, `#!/bin/sh\necho launched > "${marker}"\n`);
  chmodSync(exe, 0o755);
  h = await startHelper({ apps: [{ id: "notes", label: "Notes", exe }, { id: "term", label: "Terminal", exe }] });
  wpDir = join(dir, "wallpaper");
  cpSync(join(ROOT, "wallpaper"), wpDir, { recursive: true });
  const out = execFileSync(h.bin, ["--config", h.cfgPath, "--write-token-js", wpDir]).toString();
  assert.match(out, /paired/);
  browser = await launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(pathToFileURL(join(wpDir, "index.html")).href + "?auto=0&q=low");
});

after(async () => {
  await browser?.close();
  if (h?.proc && h.proc.exitCode === null) h.proc.kill("SIGKILL");
});

test("pairs and shows live stats", async () => {
  await page.waitForFunction(() => window.__vision.helper.status === "online", null, { timeout: 8000 });
  await page.waitForFunction(() => /%$/.test(document.querySelector('.gauge[data-k="cpu"] .g-val').textContent), null, { timeout: 5000 });
  const link = await page.$eval(".hud-link", (e) => e.classList.contains("show"));
  assert.equal(link, false, "offline indicator should be hidden");
});

test("app ring lists helper apps and launches by id", async () => {
  await page.evaluate(() => { window.__vision.sm.go("APP_RING"); window.__vision.ring.open(); });
  await page.waitForFunction(() => document.querySelectorAll(".app-node").length === 2 && !document.querySelector(".app-node.disabled"), null, { timeout: 5000 });
  const labels = await page.$$eval(".app-label", (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels.sort(), ["Notes", "Terminal"]);
  await page.waitForFunction(() => window.__vision.ring.currentPhase === "open", null, { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll(".app-node")].find((n) => n.textContent.includes("Notes")).click());
  await waitFor(() => existsSync(marker), 6000);
  assert.equal(readFileSync(marker, "utf8").trim(), "launched");
  await page.waitForFunction(() => window.__vision.ring.currentPhase === "closed", null, { timeout: 5000 });
});

test("helper crash → STATS OFFLINE, orb keeps rendering, then reconnects", async () => {
  h.proc.kill("SIGKILL");
  await new Promise((r) => h.proc.once("exit", r));
  await page.waitForFunction(() => window.__vision.helper.status === "offline", null, { timeout: 8000 });
  const text = await page.$eval(".hud-link", (e) => e.textContent);
  assert.equal(text, "STATS OFFLINE");
  const f0 = await page.evaluate(() => window.__vision.perf.frames);
  await page.waitForTimeout(1500);
  const f1 = await page.evaluate(() => window.__vision.perf.frames);
  assert.ok(f1 > f0 + 3, `orb froze while helper offline (${f0} → ${f1})`);
  // restart the same helper (same config / token / port)
  const proc = spawn(h.bin, ["--config", h.cfgPath], { stdio: "ignore" });
  h.proc = proc;
  await page.waitForFunction(() => window.__vision.helper.status === "online", null, { timeout: 20000 });
  const shown = await page.$eval(".hud-link", (e) => e.classList.contains("show"));
  assert.equal(shown, false);
});

test("no console errors or warnings in normal use", () => {
  const relevant = logs.filter((l) => !/net::ERR_CONNECTION_REFUSED|Failed to load resource|GPU stall|swiftshader|GroupMarkerNotSet|Automatic fallback to software WebGL/i.test(l));
  assert.deepEqual(relevant, []);
});

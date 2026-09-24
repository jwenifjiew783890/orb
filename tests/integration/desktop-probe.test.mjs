// Verifies the desktop-probe plumbing (not Lively itself): every guided step
// records synthetic input, and the final report reaches the real helper.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, startHelper, waitFor } from "../lib/helper.mjs";
import { launch } from "./browser.mjs";

let h, browser, page;
before(async () => {
  h = await startHelper();
  const dir = join(mkdtempSync(join(tmpdir(), "vision-probe-")), "desktop-probe");
  cpSync(join(ROOT, "tools", "desktop-probe"), dir, { recursive: true });
  execFileSync(h.bin, ["--config", h.cfgPath, "--write-token-js", dir]);
  browser = await launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(join(dir, "index.html")).href);
});
after(async () => { await browser?.close(); await h?.stop(); });

test("guided steps record input and the report is saved by the helper", async () => {
  const step = () => page.evaluate(() => window.__probe.idx);
  const next = () => page.click("#next");
  // 1 move
  for (let i = 0; i < 90; i++) await page.mouse.move(100 + i * 5, 600 + (i % 7));
  await next();
  await next(); // 2 hover icons
  // 3 left click ring A
  for (let i = 0; i < 3; i++) await page.mouse.click(640, 533);
  await next();
  // 4 dblclick
  await page.mouse.dblclick(640, 533); await page.mouse.dblclick(640, 533);
  await page.click("#answers button.ans >> nth=0");
  await next();
  // 5 drag
  await page.mouse.move(384, 533); await page.mouse.down(); await page.mouse.move(896, 533, { steps: 30 }); await page.mouse.up();
  await next();
  // 6 wheel
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 100);
  await next();
  // 7 right click
  for (let i = 0; i < 3; i++) await page.mouse.click(200, 650, { button: "right" });
  await page.click("#answers button.ans >> nth=2");
  await next();
  await page.mouse.click(200, 650, { button: "middle" }); await next(); // 8
  await page.mouse.click(200, 650); await page.keyboard.type("vision"); await page.keyboard.press("Control+Space"); await next(); // 9
  await page.keyboard.type("vision"); await page.keyboard.press("Control+Space"); await page.click("#answers button.ans >> nth=1"); await next(); // 10
  while ((await step()) < 18) await next();
  await page.waitForFunction(() => document.getElementById("step").textContent === "COMPLETE");
  const status = await page.$eval("#instr", (e) => e.textContent);
  assert.match(status, /Report saved/);
  const file = join(h.helperDir, "config", "desktop-probe-report.json");
  await waitFor(() => existsSync(file));
  const r = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(r.kind, "vision-desktop-probe");
  assert.ok(r.steps.move.counters.move > 60);
  assert.equal(r.steps.leftClick.counters.click, 3);
  assert.ok(r.steps.dblClick.counters.dblclick >= 2);
  assert.ok(r.steps.drag.counters.moveWithLeftDown > 15);
  assert.equal(r.steps.rightClick.counters.contextmenu, 3);
  assert.equal(r.steps.rightClick.answer, "No, never");
  assert.equal(r.steps.keysMouseOnly.counters.ctrlSpace, 1);
  assert.equal(r.steps.keysKeyboard.answer, "Mouse + Keyboard");
  assert.ok(r.steps.keysMouseOnly.keys.join("").includes("vision"));
  const summary = await page.$eval("#report", (e) => e.textContent.split("\n\n")[0]);
  console.log(summary.split("\n").map((l) => "# " + l).join("\n"));
});

// Usage: node shot.mjs "<query>" out.png [waitMs] [w] [h]
import { launch } from "./browser.mjs";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const [query = "", out = "shot.png", wait = "3000", w = "1600", h = "900"] = process.argv.slice(2);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(pathToFileURL(resolve(root, "wallpaper/index.html")).href + (query ? "?" + query : ""));
await page.waitForTimeout(+wait);
await page.screenshot({ path: out });
await browser.close();
if (logs.length) console.log([...new Set(logs)].map((l) => l.slice(0, 1500)).join("\n"));

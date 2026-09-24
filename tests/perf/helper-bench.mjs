// Helper benchmark on the host OS (Linux in CI): startup time, RSS idle/under
// polling, CPU cost of stats polling. Windows numbers: perf-sample.ps1.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startHelper } from "../lib/helper.mjs";

const TICK = 100; // Linux USER_HZ
const stat = (pid) => { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / TICK; };
const rss = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024;
const hwm = (pid) => Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024;

const starts = [];
for (let i = 0; i < 5; i++) { const h = await startHelper(); starts.push(h.startupMs); await h.stop(); }
const h = await startHelper({ apps: [{ id: "a", label: "A", exe: "/bin/true" }] });
const pid = h.proc.pid;
await new Promise((r) => setTimeout(r, 1500));
const idleRss = rss(pid);

async function window_(label, secs, everyMs) {
  const c0 = stat(pid), t0 = Date.now();
  let n = 0;
  const timer = everyMs ? setInterval(() => { n++; fetch(h.url + "/stats", { headers: { "X-Vision-Token": h.cfg.token, Origin: "null" } }).then((r) => r.arrayBuffer()).catch(() => {}); }, everyMs) : null;
  await new Promise((r) => setTimeout(r, secs * 1000));
  if (timer) clearInterval(timer);
  const cpu = stat(pid) - c0, wall = (Date.now() - t0) / 1000;
  return { label, seconds: +wall.toFixed(1), requests: n, cpuPctOfOneCore: +(100 * cpu / wall).toFixed(3), rssMB: +rss(pid).toFixed(1) };
}
const res = [];
res.push(await window_("idle (no requests → collector suspended after 20 s)", 40, 0));
res.push(await window_("wallpaper polling (1 req / 1.5 s)", 60, 1500));
res.push(await window_("stress polling (10 req / s)", 30, 100));
const out = {
  when: new Date().toISOString(), os: process.platform, binary: "linux/amd64 build of helper/service",
  startupMs: { runs: starts, median: starts.sort((a, b) => a - b)[2] },
  rssIdleAfterStartMB: +idleRss.toFixed(1), peakRssMB: +hwm(pid).toFixed(1), windows: res,
};
await h.stop();
mkdirSync(join(ROOT, "docs", "perf"), { recursive: true });
writeFileSync(join(ROOT, "docs", "perf", "helper-bench-linux.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

// Builds and runs the real VISION Helper binary (host OS build) in a temp
// sandbox for black-box tests. Windows-only behaviour (PDH stats, Task
// Scheduler, CreateProcess flags) is covered by the Go unit tests + the
// manual Windows checklist in docs/TEST_RESULTS.md.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "tests", "out");

export function buildHelper() {
  mkdirSync(OUT, { recursive: true });
  const bin = join(OUT, process.platform === "win32" ? "vision-helper.exe" : "vision-helper");
  execFileSync("go", ["build", "-trimpath", "-o", bin, "."], {
    cwd: join(ROOT, "helper", "service"),
    env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
    stdio: "inherit",
  });
  return bin;
}

let portSeq = 47900 + Math.floor(Math.random() * 500);

/** Start a helper in an isolated folder layout: <tmp>/helper/{bin,config,apps.json,icons}. */
export async function startHelper({ apps = [], allowedOrigins } = {}) {
  const bin = buildHelper.cached ??= buildHelper();
  const base = mkdtempSync(join(tmpdir(), "vision-helper-"));
  const helperDir = join(base, "helper");
  mkdirSync(join(helperDir, "config"), { recursive: true });
  mkdirSync(join(helperDir, "icons"), { recursive: true });
  writeFileSync(join(helperDir, "apps.json"), JSON.stringify({ apps }, null, 2));
  const cfgPath = join(helperDir, "config", "config.json");
  execFileSync(bin, ["--init", "--config", cfgPath]);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.port = portSeq++;
  if (allowedOrigins) cfg.allowedOrigins = allowedOrigins;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const proc = spawn(bin, ["--config", cfgPath], { stdio: "ignore" });
  const url = `http://127.0.0.1:${cfg.port}`;
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url + "/health", { headers: { "X-Vision-Token": cfg.token } });
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 5000) { proc.kill(); throw new Error("helper did not start"); }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base, helperDir, cfg, url, proc, bin, startupMs: Date.now() - t0, cfgPath,
    stop: () => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once("exit", r); proc.kill("SIGTERM"); }),
  };
}

export function waitFor(pred, ms = 3000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return res(true);
      if (Date.now() - t0 > ms) return rej(new Error("timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

export { existsSync };

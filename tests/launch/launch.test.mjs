// Launch path: whitelist hot-reload, missing executable, launch rate limit,
// detached child outliving the helper.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHelper, waitFor } from "../lib/helper.mjs";

let h, dir;
const post = (id) => fetch(`${h.url}/launch/${id}`, { method: "POST", headers: { "X-Vision-Token": h.cfg.token } }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "vision-launch-"));
  const mk = (name, script) => { const p = join(dir, name); writeFileSync(p, script); chmodSync(p, 0o755); return p; };
  const a = mk("app-a", `#!/bin/sh\necho "$@" > "${dir}/a.txt"\n`);
  const slow = mk("app-slow", `#!/bin/sh\nsleep 2\necho alive > "${dir}/slow.txt"\n`);
  h = await startHelper({ apps: [
    { id: "a", label: "A", exe: a, args: ["x y", "&&", "$(id)"] },
    { id: "slow", label: "Slow", exe: slow },
    { id: "gone", label: "Gone", exe: join(dir, "not-installed") },
  ] });
});
after(() => h.stop());

test("launches with literal args (no shell interpretation)", async () => {
  const r = await post("a");
  assert.equal(r.status, 200);
  await waitFor(() => existsSync(join(dir, "a.txt")));
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8").trim(), "x y && $(id)");
});

test("missing executable → 422 app_unavailable", async () => {
  const r = await post("gone");
  assert.equal(r.status, 422);
  assert.equal(r.code, "app_unavailable");
});

test("launched app outlives the helper", async () => {
  assert.equal((await post("slow")).status, 200);
  await h.stop();
  await waitFor(() => existsSync(join(dir, "slow.txt")), 5000);
});

test("apps.json edits apply without restart", async () => {
  h = await startHelper({ apps: [{ id: "one", exe: join(dir, "app-a") }] });
  let apps = await (await fetch(h.url + "/apps", { headers: { "X-Vision-Token": h.cfg.token } })).json();
  assert.deepEqual(apps.apps.map((a) => a.id), ["one"]);
  writeFileSync(join(h.helperDir, "apps.json"), JSON.stringify({ apps: [{ id: "two", label: "Two", exe: join(dir, "app-a") }] }));
  await new Promise((r) => setTimeout(r, 4500));
  apps = await (await fetch(h.url + "/apps", { headers: { "X-Vision-Token": h.cfg.token } })).json();
  assert.deepEqual(apps.apps.map((a) => a.id), ["two"]);
  assert.equal((await post("one")).status, 404);
});

test("launch rate limit (burst 3)", async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await post("two")).status);
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.ok(codes.slice(3).every((c) => c === 429), codes.join(","));
});

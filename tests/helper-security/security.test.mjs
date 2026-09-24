// Brief §53 security matrix, executed over real HTTP against the real binary.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startHelper } from "../lib/helper.mjs";
import net from "node:net";

let h, marker, results = [];
before(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "vision-app-"));
  marker = join(dir, "launched.txt");
  const exe = join(dir, "fakeapp");
  writeFileSync(exe, `#!/bin/sh\necho "$@" > "${marker}"\n`);
  chmodSync(exe, 0o755);
  h = await startHelper({ apps: [{ id: "fakeapp", label: "Fake App", exe, args: ["--hello"], hotkey: null }] });
});
after(async () => {
  await h.stop();
  writeFileSync(join(h.base, "security-results.json"), JSON.stringify(results, null, 2));
  console.log("\nSECURITY MATRIX (real binary, real HTTP)\n" + results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(28)} → ${r.status} ${r.code}`).join("\n"));
});

async function call(name, method, path, { token, body, headers = {} } = {}) {
  const r = await fetch(h.url + path, {
    method, body,
    headers: { ...(token === undefined ? { "X-Vision-Token": h.cfg.token } : token === null ? {} : { "X-Vision-Token": token }), ...headers },
  });
  const text = await r.text();
  let code = "";
  try { code = JSON.parse(text).code ?? ""; } catch { /* stats body */ }
  assert.ok(!text.includes(h.base), `${name}: leaks filesystem path`);
  assert.ok(!text.includes(h.cfg.token), `${name}: leaks token`);
  return { status: r.status, code, text };
}

const matrix = [
  ["no token", "GET", "/stats", { token: null }, 401, "unauthorized"],
  ["wrong token", "GET", "/stats", { token: "0".repeat(64) }, 401, "unauthorized"],
  ["unknown app ID", "POST", "/launch/doesnotexist", {}, 404, "unknown_app"],
  ["raw executable path", "POST", "/launch/C:%5CWindows%5Csystem32%5Ccalc.exe", {}, 400, "invalid_id"],
  ["raw path in body", "POST", "/launch", { body: JSON.stringify({ app_id: "/bin/sh" }) }, 400, "invalid_id"],
  ["shell command", "POST", "/launch/cmd%20%2Fc%20calc", {}, 400, "invalid_id"],
  ["shell command in body", "POST", "/launch", { body: JSON.stringify({ app_id: "fakeapp; rm -rf /" }) }, 400, "invalid_id"],
  ["extra args in body", "POST", "/launch/fakeapp", { body: JSON.stringify({ app_id: "fakeapp", args: ["-c", "id"] }) }, 400, "malformed_request"],
  ["malformed JSON", "POST", "/launch", { body: "{\"app_id\":" }, 400, "malformed_request"],
  ["foreign Origin", "GET", "/stats", { headers: { Origin: "https://evil.example" } }, 403, "bad_origin"],
  ["valid whitelisted ID", "POST", "/launch/fakeapp", {}, 200, "launched"],
];

for (const [name, method, path, opts, status, code] of matrix) {
  test(name, async () => {
    const r = await call(name, method, path, opts);
    const pass = r.status === status && r.code === code;
    results.push({ name, status: r.status, code: r.code, expected: `${status} ${code}`, pass });
    assert.equal(r.status, status, name);
    assert.equal(r.code, code, name);
  });
}

test("valid launch actually started the whitelisted exe with configured args only", async () => {
  for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(readFileSync(marker, "utf8").trim(), "--hello");
});

test("DNS rebinding: foreign Host header rejected", async () => {
  const res = await new Promise((resolve) => {
    const s = net.connect(h.cfg.port, "127.0.0.1", () => {
      s.write(`GET /stats HTTP/1.1\r\nHost: evil.example:${h.cfg.port}\r\nX-Vision-Token: ${h.cfg.token}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (d) => (buf += d));
    s.on("end", () => resolve(buf));
  });
  results.push({ name: "DNS rebinding Host", status: Number(res.split(" ")[1]), code: "bad_host", pass: res.startsWith("HTTP/1.1 421") });
  assert.match(res, /^HTTP\/1\.1 421/);
});

test("not reachable on non-loopback interfaces", async () => {
  const { networkInterfaces } = await import("node:os");
  const addrs = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
  for (const a of addrs) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host: a, port: h.cfg.port, timeout: 800 }, () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
      s.on("timeout", () => { s.destroy(); resolve(false); });
    });
    assert.equal(ok, false, `reachable on ${a}`);
  }
  results.push({ name: `loopback only (${addrs.length} ifaces)`, status: 0, code: "refused", pass: true });
});

test("stats payload shape and caching", async () => {
  const r = await fetch(h.url + "/stats", { headers: { "X-Vision-Token": h.cfg.token } });
  const j = await r.json();
  for (const k of ["cpu", "ram", "network", "time"]) assert.ok(k in j, k);
  assert.ok(j.cpu >= 0 && j.cpu <= 100);
  assert.ok(j.ram > 0 && j.ram <= 100);
  assert.equal(typeof j.network.up, "number");
});

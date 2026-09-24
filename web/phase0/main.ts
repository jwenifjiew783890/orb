/**
 * VISION Orb — Phase 0 runtime probe.
 *
 * Proves the complete runtime path inside Lively's WebView2 before any production
 * visuals are built: Three.js on WebGL2, bloom, mouse input, offline local asset
 * loading, Page Visibility, Lively pause/resume + property events, and whether
 * WebGPU is available (with a like-for-like line-rendering benchmark).
 *
 * Every check is shown live on screen and mirrored to window.__probe so the same
 * page can be driven headlessly.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

type Status = "wait" | "ok" | "bad";
interface Check { label: string; status: Status; detail: string }

const checks = new Map<string, Check>();
const probe: Record<string, unknown> = { checks: {}, consoleErrors: 0, bench: null };
(window as unknown as { __probe: typeof probe }).__probe = probe;

function setCheck(id: string, label: string, status: Status, detail = "") {
  checks.set(id, { label, status, detail });
  (probe.checks as Record<string, Check>)[id] = { label, status, detail };
  const el = document.getElementById("checks")!;
  el.innerHTML = "";
  for (const c of checks.values()) {
    const row = document.createElement("div");
    row.className = "row";
    const mark = c.status === "ok" ? "PASS" : c.status === "bad" ? "FAIL" : "....";
    row.innerHTML = `<span>${c.label}</span><span class="${c.status}">${mark} ${c.detail}</span>`;
    el.appendChild(row);
  }
}

// ——— console errors ———
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  (probe.consoleErrors as number)++;
  setCheck("console", "Console errors", "bad", String(probe.consoleErrors));
  origError(...args);
};
window.addEventListener("error", () => {
  (probe.consoleErrors as number)++;
  setCheck("console", "Console errors", "bad", String(probe.consoleErrors));
});
setCheck("console", "Console errors", "ok", "0");

// ——— renderer ———
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
const gl = renderer.getContext();
const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
const gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
setCheck("webgl2", "WebGL2 context", isWebGL2 ? "ok" : "bad", isWebGL2 ? "" : "WebGL1 only");
setCheck("gpu", "GPU", "ok", gpuName.slice(0, 48));
setCheck("float", "Half-float render targets", gl.getExtension("EXT_color_buffer_half_float") || gl.getExtension("EXT_color_buffer_float") ? "ok" : "bad");
probe.gpu = gpuName;

const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
renderer.setPixelRatio(dpr);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 6);

// ——— test orb ———
const orb = new THREE.LineSegments(
  new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.6, 3)),
  new THREE.LineBasicMaterial({ color: 0xffb300, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }),
);
scene.add(orb);
const core = new THREE.Mesh(new THREE.SphereGeometry(0.25, 24, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.2, 2) }));
scene.add(core);

// ——— local asset (offline, relative path, loaded via <img>) ———
new THREE.TextureLoader().load(
  "./assets/probe.png",
  (tex) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false }));
    sprite.scale.setScalar(1.4);
    scene.add(sprite);
    setCheck("asset", "Local asset (img, relative path)", "ok", `${tex.image.width}x${tex.image.height}`);
  },
  undefined,
  () => setCheck("asset", "Local asset (img, relative path)", "bad", "load error"),
);
setCheck("asset", "Local asset (img, relative path)", "wait");

// fetch() of local files is NOT expected to work over file:// — recorded, not required.
fetch("./LivelyInfo.json")
  .then((r) => setCheck("fetch", "fetch() of local JSON (informational)", "ok", `HTTP ${r.status}`))
  .catch(() => setCheck("fetch", "fetch() of local JSON (informational)", "wait", "blocked (file://) — not used"));

// ——— bloom ———
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.2, 0.5, 0.1);
composer.addPass(bloom);
composer.addPass(new OutputPass());
setCheck("bloom", "UnrealBloomPass", "ok", "half-res");

// ——— mouse ———
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
let mouseEvents = 0;
setCheck("mouse", "Mouse input (move/drag/wheel)", "wait", "move the mouse");
for (const ev of ["pointermove", "pointerdown", "wheel"] as const) {
  window.addEventListener(ev, () => {
    mouseEvents++;
    if (mouseEvents === 1 || mouseEvents % 25 === 0) setCheck("mouse", "Mouse input (move/drag/wheel)", "ok", `${mouseEvents} events, last=${ev}`);
  }, { passive: true });
}

// ——— visibility + lively pause ———
let paused = false;
let visChanges = 0;
setCheck("visibility", "Page Visibility API", "ok", document.visibilityState);
document.addEventListener("visibilitychange", () => {
  visChanges++;
  setCheck("visibility", "Page Visibility API", "ok", `${document.visibilityState} (${visChanges} changes)`);
  setPaused(document.visibilityState === "hidden");
});
setCheck("lively", "Lively pause event", "wait", "cover wallpaper with a fullscreen app");
setCheck("props", "Lively property listener", "wait", "open Customise in Lively");

const w = window as unknown as Record<string, unknown>;
w.livelyWallpaperPlaybackChanged = (data: string) => {
  try {
    const obj = JSON.parse(data) as { IsPaused?: boolean };
    setCheck("lively", "Lively pause event", "ok", `IsPaused=${obj.IsPaused}`);
    setPaused(!!obj.IsPaused);
  } catch {
    setCheck("lively", "Lively pause event", "bad", "unparseable payload");
  }
};
w.livelyPropertyListener = (name: string, val: unknown) => setCheck("props", "Lively property listener", "ok", `${name}=${String(val)}`);

let rafId = 0;
let framesRendered = 0;
function setPaused(p: boolean) {
  if (p === paused) return;
  paused = p;
  if (paused) cancelAnimationFrame(rafId);
  else { last = performance.now(); rafId = requestAnimationFrame(loop); }
  probe.paused = paused;
}

// ——— loop ———
let last = performance.now();
let fpsAcc = 0, fpsFrames = 0;
function loop(now: number) {
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  orb.rotation.y += dt * 0.2;
  orb.rotation.x = Math.sin(now * 0.0003) * 0.2;
  controls.update();
  composer.render();
  framesRendered++;
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 1) {
    setCheck("anim", "Animation loop", "ok", `${(fpsFrames / fpsAcc).toFixed(1)} fps`);
    probe.fps = fpsFrames / fpsAcc;
    fpsAcc = 0; fpsFrames = 0;
  }
  probe.frames = framesRendered;
}
setCheck("anim", "Animation loop", "wait");
rafId = requestAnimationFrame(loop);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ——— context loss ———
renderer.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); setCheck("ctx", "WebGL context", "bad", "lost"); });
renderer.domElement.addEventListener("webglcontextrestored", () => setCheck("ctx", "WebGL context", "ok", "restored"));
setCheck("ctx", "WebGL context", "ok", "live");

// ——— WebGPU probe ———
async function probeWebGPU(): Promise<string> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
  if (!nav.gpu) return "navigator.gpu missing";
  try {
    const adapter = await nav.gpu.requestAdapter();
    return adapter ? "adapter available" : "no adapter";
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
probeWebGPU().then((r) => {
  probe.webgpu = r;
  setCheck("webgpu", "WebGPU (informational)", r === "adapter available" ? "ok" : "wait", r);
});

// ——— Renderer benchmark ———
// Same workload on both back-ends: N additive line segments (the production orb's
// primitive) spinning, rendered for a fixed window. Reports mean fps and p95 frame time.
function makeBenchGeometry(segments: number) {
  const pos = new Float32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a = new THREE.Vector3().randomDirection().multiplyScalar(1.6);
    const b = a.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(0.08));
    pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

async function timeFrames(render: () => void, ms: number) {
  const times: number[] = [];
  await new Promise<void>((done) => {
    const start = performance.now();
    let prev = start;
    const step = (t: number) => {
      render();
      times.push(t - prev);
      prev = t;
      if (t - start < ms) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
  times.shift();
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { fps: 1000 / mean, p95: sorted[Math.floor(sorted.length * 0.95)] };
}

async function runBench() {
  const out = document.getElementById("bench")!;
  const loads = [100_000, 400_000, 1_600_000];
  const results: Record<string, unknown>[] = [];
  setPaused(true);
  out.textContent = "benchmarking WebGL2…";
  const bw = window.innerWidth, bh = window.innerHeight;
  for (const n of loads) {
    const g = makeBenchGeometry(n);
    const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffb300, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    const s = new THREE.Scene(); s.add(m);
    const r = await timeFrames(() => { m.rotation.y += 0.01; renderer.render(s, camera); }, 3000);
    results.push({ backend: "WebGL2", segments: n, ...r });
    g.dispose();
  }
  const gpuStatus = await probeWebGPU();
  if (gpuStatus === "adapter available") {
    out.textContent = "benchmarking WebGPU…";
    try {
      const WG = await import("three/webgpu");
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:-1";
      document.body.appendChild(canvas);
      const wr = new WG.WebGPURenderer({ canvas, antialias: false });
      await wr.init();
      wr.setPixelRatio(dpr);
      wr.setSize(bw, bh);
      for (const n of loads) {
        const g = makeBenchGeometry(n);
        const mat = new WG.LineBasicNodeMaterial({ color: 0xffb300, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
        const m = new WG.LineSegments(g, mat);
        const s = new WG.Scene(); s.add(m);
        const r = await timeFrames(() => { m.rotation.y += 0.01; wr.render(s, camera); }, 3000);
        results.push({ backend: "WebGPU", segments: n, ...r });
        g.dispose();
      }
      wr.dispose();
      canvas.remove();
    } catch (e) {
      results.push({ backend: "WebGPU", error: (e as Error).message });
    }
  } else {
    results.push({ backend: "WebGPU", error: gpuStatus });
  }
  probe.bench = results;
  out.textContent = results
    .map((r) => (r.error ? `${r.backend}: unavailable (${r.error})` : `${r.backend} ${String(r.segments).padStart(8)} seg  ${(r.fps as number).toFixed(1).padStart(6)} fps  p95 ${(r.p95 as number).toFixed(1)} ms`))
    .join("\n");
  console.log("[VISION phase0 bench]", JSON.stringify(results));
  setPaused(false);
}
document.getElementById("runBench")!.addEventListener("click", () => { void runBench(); });
(window as unknown as { __runBench: () => Promise<void> }).__runBench = runBench;

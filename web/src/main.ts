/**
 * VISION Orb — wallpaper entry point.
 *
 * Wires the orb, interaction state machine, HUD, app ring and helper link, and
 * owns the adaptive render scheduler:
 *
 *   interaction / boot / animation  → 60 fps
 *   ≥3 s without input               → 30 fps
 *   hidden / Lively-paused / lost GL → 0 fps (no requestAnimationFrame at all)
 */
import "./style.css";
import { lively } from "./lively";
import { CAMERA_HOME, customTheme, DEFAULT_SETTINGS, QUALITY, THEMES, type QualityName, type Settings, type ThemeColors, type ThemeName } from "./config";
import { RenderCore } from "./render/RenderCore";
import { OrbSystem } from "./orb/OrbSystem";
import { StateMachine, DRIVE, type OrbState } from "./interaction/StateMachine";
import { Input } from "./interaction/Input";
import { Hud } from "./hud/Hud";
import { DebugOverlay } from "./hud/Debug";
import { HelperClient } from "./net/HelperClient";
import { AppRing } from "./apps/AppRing";
import { AutoQuality, applySteps } from "./render/AutoQuality";
import { GpuTimer } from "./render/GpuTimer";

lively.install();

// ─── dev/test URL parameters (Lively never passes any) ───────────────────────
const params = new URLSearchParams(location.search);
const frozenTime = params.has("t") ? Number(params.get("t")) : null;
const demo = params.get("demo");

// ─── settings ────────────────────────────────────────────────────────────────
const settings: Settings = { ...DEFAULT_SETTINGS };
const injected = (window as unknown as { VISION_HELPER?: { port?: number; token?: string } | null }).VISION_HELPER;
if (injected?.port) settings.helperPort = injected.port;
if (params.get("theme")) settings.theme = params.get("theme") as ThemeName;
if (params.get("q")) settings.quality = params.get("q") as QualityName;
if (params.get("auto") === "0") settings.autoQuality = false;
if (params.get("debug") === "1") settings.debugOverlay = true;
if (params.get("name")) settings.userName = params.get("name")!;

// ─── core objects ────────────────────────────────────────────────────────────
const stage = document.getElementById("stage")!;
const hudEl = document.getElementById("hud")!;
const core = new RenderCore(stage, onContextLost, onContextRestored);
const orb = new OrbSystem();
core.scene.add(orb.root);
const gpuTimer = new GpuTimer(core.renderer.getContext());
const sm = new StateMachine();
const hud = new Hud(hudEl);
const debug = new DebugOverlay(document.body);
const helper = new HelperClient({ port: settings.helperPort, token: injected?.token ?? "" });
const ring = new AppRing(orb, core.camera, hudEl, helper, {
  onClosed: () => { sm.go(input.isOver ? "HOVER" : "IDLE"); },
  onLaunchStart: () => { sm.go("LAUNCHING"); },
  onToast: (m) => hud.showToast(m),
});
core.scene.add(ring.group, ring.beamObject);

const auto = new AutoQuality((a) => {
  applyQuality(a.profile, a.particleScale);
});

const input = new Input(core.camera, core.canvas, {
  onHover(over) {
    if (over && sm.state === "IDLE") sm.go("HOVER");
    else if (!over && sm.state === "HOVER") sm.go("IDLE");
    wake();
  },
  onDragStart() {
    if (sm.state === "IDLE" || sm.state === "HOVER" || sm.state === "RESET") sm.go("DRAG");
    wake();
  },
  onDragEnd() {
    if (sm.state === "DRAG") sm.go(input.isOver ? "HOVER" : "IDLE");
  },
  onOrbClick() {
    if (sm.state === "LAUNCHING") return;
    if (ring.isOpen) { ring.close(); return; }
    if (sm.go("APP_RING")) ring.open();
    wake();
  },
  onEmptyClick() {
    if (ring.isOpen && sm.state !== "LAUNCHING") ring.close();
  },
  onDoubleClick() {
    if (sm.state === "LAUNCHING") return;
    if (ring.isOpen) ring.close();
    input.reset();
    sm.go("RESET");
    wake();
  },
  onActivity: () => wake(),
});

// ─── settings application ────────────────────────────────────────────────────
function themeColors(): ThemeColors {
  return settings.theme === "custom" ? customTheme(settings.customColor) : THEMES[settings.theme] ?? THEMES.gold;
}

function applyTheme() {
  const c = themeColors();
  orb.setTheme(c);
  core.setBackground(c.bg);
  document.body.style.background = c.bg;
  hud.setAccent(c.base, c.light);
}

function applyQuality(profile = QUALITY[settings.quality] ?? QUALITY.medium, particleScale = 1) {
  orb.setQuality(profile, settings.particleDensity * particleScale);
  core.setDprCap(profile.dprCap);
  core.setBloom(0.85 * settings.bloomStrength, profile.bloomScale);
  core.setChromatic(profile.chromatic);
  orb.setPixelScale(core.bufferHeight, core.camera.fov);
  wake();
}

function applyAll(prev?: Settings) {
  if (!prev || prev.theme !== settings.theme || prev.customColor !== settings.customColor) applyTheme();
  const qualityChanged = !prev || prev.quality !== settings.quality || prev.autoQuality !== settings.autoQuality;
  if (qualityChanged) { auto.reset(); if (settings.autoQuality) auto.begin(2.5); }
  if (qualityChanged || !prev || prev.particleDensity !== settings.particleDensity || prev.bloomStrength !== settings.bloomStrength) {
    const base = QUALITY[settings.quality] ?? QUALITY.medium;
    const { profile, particleScale } = settings.autoQuality ? applySteps(base, auto.step) : { profile: base, particleScale: 1 };
    applyQuality(profile, particleScale);
  }
  hud.setName(settings.userName);
  hud.setStatsVisible(settings.hudStats);
  helper.setStatsEnabled(settings.hudStats);
  helper.configure({ port: settings.helperPort, token: settings.helperToken || injected?.token || "" });
  debug.setEnabled(settings.debugOverlay);
  gpuTimer.enabled = settings.debugOverlay || settings.autoQuality;
  if (!settings.audioReactive) audioLevel = 0;
}

lively.onProperties((patch) => {
  const prev = { ...settings };
  Object.assign(settings, patch);
  applyAll(prev);
});

// ─── audio (only when enabled; the webcam is never touched) ─────────────────
let audioLevel = 0;
lively.onAudio((bins) => {
  if (!settings.audioReactive || paused) return;
  let s = 0;
  const n = Math.min(24, bins.length);
  for (let i = 0; i < n; i++) s += bins[i] || 0;
  const level = Math.min(1, (s / Math.max(1, n)) * 1.6);
  audioLevel = level > audioLevel ? audioLevel + (level - audioLevel) * 0.5 : audioLevel * 0.92;
});

// ─── helper link → HUD ───────────────────────────────────────────────────────
helper.onStatus((s) => hud.setLink(s));
helper.onStats((s) => hud.setStats(s));
hud.setLink(helper.status);

// ─── scheduler ───────────────────────────────────────────────────────────────
let rafId = 0;
let running = false;
let paused = false;
let lastFrame = 0;
let nextDeadline = 0;
let elapsed = 0;
let bootT = 0;
let targetFps = 60;
let fpsAcc = 0, fpsFrames = 0, fps = 0, cpuMs = 0;
const BOOT_S = 2.6;
const drive = { hover: 0, activity: 1, pulseSpeed: 1, spin: 1, audio: 0 };

function wake() {
  if (!running || paused) return;
  if (targetFps !== 60) { targetFps = 60; nextDeadline = performance.now(); }
}

function computeTarget(cameraMoving: boolean): number {
  if (bootT < BOOT_S) return 60;
  if (DRIVE[sm.state].interactive || ring.isAnimating || cameraMoving || input.idleFor < 3) return 60;
  return 30;
}

function start() {
  if (running || paused || core.contextLost) return;
  running = true;
  lastFrame = performance.now();
  nextDeadline = lastFrame;
  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;
  cancelAnimationFrame(rafId);
}

const smooth = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

function loop(now: number) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  const interval = 1000 / targetFps;
  if (now < nextDeadline - 3) return; // not this vsync
  nextDeadline += interval;
  if (now - nextDeadline > interval) nextDeadline = now + interval;

  const frameInterval = now - lastFrame;
  const dt = Math.min(0.1, frameInterval / 1000);
  lastFrame = now;
  const cpu0 = performance.now();

  elapsed += dt;
  bootT += dt;
  updateBoot();

  // drive: ease toward the current state's targets
  const d = DRIVE[sm.state];
  const k = 1 - Math.exp(-dt * 4);
  drive.hover += (d.hover - drive.hover) * k;
  drive.activity += (d.activity - drive.activity) * k;
  drive.pulseSpeed += (d.pulseSpeed - drive.pulseSpeed) * k;
  drive.spin += (d.spin - drive.spin) * (1 - Math.exp(-dt * 1.2));
  drive.audio = settings.audioReactive ? audioLevel * 0.8 : 0;

  const cameraMoving = input.update(dt);
  if (sm.state === "RESET" && !input.isResetting) sm.go(input.isOver ? "HOVER" : "IDLE");
  ring.update(dt);
  orb.update(dt, frozenTime ?? elapsed, drive, settings.rotationSpeed);

  gpuTimer.begin();
  core.render(elapsed);
  gpuTimer.end();

  // stats
  cpuMs = cpuMs * 0.9 + (performance.now() - cpu0) * 0.1;
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 1) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
  if (bootT > BOOT_S) {
    const base = QUALITY[settings.quality] ?? QUALITY.medium;
    auto.frame(dt, frameInterval, targetFps, gpuTimer.ms, base, settings.autoQuality);
  }
  if (debug.tick(dt)) {
    core.sampleSceneStats();
    debug.render({
      fps, frameMs: cpuMs, gpuMs: gpuTimer.ms, targetFps,
      totalCalls: core.lastTotalCalls, sceneCalls: core.lastSceneCalls,
      lines: core.lastSceneLines, points: core.lastScenePoints, triangles: core.lastSceneTriangles,
      dpr: core.dpr, outerStrands: orb.stats.outerStrands, innerStrands: orb.stats.innerStrands,
      particles: orb.stats.particles,
      renderer: `${core.isWebGL2 ? "WebGL2" : "WebGL1"} · ${core.gpuName.slice(0, 60)}`,
      quality: settings.quality + (settings.autoQuality ? " (auto)" : ""), autoStep: auto.step, autoReason: auto.lastReason,
      helper: helper.status, state: sm.state, genMs: orb.stats.genMs,
    });
  }

  targetFps = computeTarget(cameraMoving);
  perf.frames++;
}

// ─── boot sequence ───────────────────────────────────────────────────────────
let bootBurstDone = false;
function updateBoot() {
  if (bootT > BOOT_S + 0.1) return;
  const b = frozenTime !== null && demo !== "boot" ? 99 : bootT;
  orb.reveal.rings.value = smooth((b - 0.2) / 0.5);
  orb.reveal.outer.value = smooth((b - 0.3) / 0.7);
  orb.reveal.inner.value = smooth((b - 0.5) / 0.6);
  orb.reveal.core.value = smooth((b - 0.8) / 0.35) * (1 + 0.8 * Math.exp(-Math.max(0, b - 0.95) * 5) * (b > 0.8 ? 1 : 0));
  orb.uniforms.uPulseReveal.value = smooth((b - 1.1) / 0.4);
  orb.reveal.particles.value = smooth((b - 0.9) / 0.8);
  if (!bootBurstDone && b >= 1.1) { bootBurstDone = true; orb.burst(0.45); }
  const text = "VISION ONLINE";
  const chars = Math.max(0, Math.min(text.length, Math.floor((b - 1.3) / 0.045)));
  const op = b < 2.0 ? 1 : 1 - smooth((b - 2.0) / 0.55);
  hud.bootText(chars, text, op);
}

// ─── pause / visibility ──────────────────────────────────────────────────────
let livelyPaused = false;
function setPaused(p: boolean) {
  if (p === paused) return;
  paused = p;
  if (paused) {
    stop();
    helper.stop();
    hud.stopClock();
    sm.pause();
  } else {
    sm.resume();
    hud.startClock();
    helper.start();
    targetFps = 60;
    start();
  }
}
function syncPause() { setPaused(document.visibilityState === "hidden" || livelyPaused); }
document.addEventListener("visibilitychange", syncPause);
lively.onPause((p) => { livelyPaused = p; syncPause(); });

// ─── context loss ────────────────────────────────────────────────────────────
function onContextLost() {
  stop();
  perf.contextLosses++;
}
function onContextRestored() {
  gpuTimer.onContextRestored();
  orb.setPixelScale(core.bufferHeight, core.camera.fov);
  perf.contextRestores++;
  if (!paused) start();
}

// ─── resize ──────────────────────────────────────────────────────────────────
let resizeTimer: number | null = null;
window.addEventListener("resize", () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    core.resize();
    orb.setPixelScale(core.bufferHeight, core.camera.fov);
    wake();
  }, 120);
});

// ─── start ───────────────────────────────────────────────────────────────────
const perf = { frames: 0, contextLosses: 0, contextRestores: 0 };
core.resize();
applyAll();
hud.startClock();
helper.start();
if (settings.autoQuality) auto.begin(0);
sm.onChange((next: OrbState) => { if (next !== "IDLE" && next !== "PAUSED") wake(); });
syncPause();
start();

// Demo states for screenshots/tests (?demo=hover|ring|drag|launch)
if (demo === "hover") setTimeout(() => { sm.go("HOVER"); }, 50);
if (demo === "ring" || demo === "launch") setTimeout(() => { if (sm.go("APP_RING")) ring.open(); }, 50);
if (demo === "drag") setTimeout(() => { sm.go("DRAG"); core.camera.position.set(4.2, 2.6, 5.2); }, 50);

// Diagnostics handle used by the automated tests (read-only use in production).
(window as unknown as Record<string, unknown>).__vision = {
  orb, core, sm, ring, helper, input, settings, perf, auto, gpuTimer,
  get targetFps() { return targetFps; },
  get running() { return running; },
  get fps() { return fps; },
  home: CAMERA_HOME,
};

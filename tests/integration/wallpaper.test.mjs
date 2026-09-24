// Wallpaper behaviour (no helper): boot, scheduler, pause/visibility, context
// loss, settings via Lively hooks, audio, no webcam, pointer interactions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { ROOT } from "../lib/helper.mjs";
import { launch } from "./browser.mjs";

let browser, page;
const logs = [];
const W = 480, H = 270; // small viewport so SwiftShader (CPU) can reach 60 fps

const frames = () => page.evaluate(() => window.__vision.perf.frames);
const rate = async (ms) => { const a = await frames(); await page.waitForTimeout(ms); return ((await frames()) - a) / (ms / 1000); };

before(async () => {
  browser = await launch();
  page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__gum = 0;
    const md = navigator.mediaDevices;
    if (md) {
      md.getUserMedia = () => { window.__gum++; return Promise.reject(new Error("blocked by test")); };
      md.enumerateDevices = () => { window.__gum++; return Promise.resolve([]); };
    }
  });
  await page.goto(pathToFileURL(join(ROOT, "wallpaper", "index.html")).href + "?auto=0&q=low");
});
after(() => browser?.close());

test("boot sequence types VISION ONLINE then fades", async () => {
  await page.waitForFunction(() => document.querySelector(".hud-boot").textContent === "VISION ONLINE", null, { timeout: 6000 });
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".hud-boot")).opacity) < 0.05, null, { timeout: 8000 });
  const reveal = await page.evaluate(() => ({ ...Object.fromEntries(Object.entries(window.__vision.orb.reveal).map(([k, v]) => [k, v.value])) }));
  for (const [k, v] of Object.entries(reveal)) assert.ok(v >= 0.99, `${k} reveal ${v}`);
});

test("scheduler: idle 30 fps, interaction 60 fps (pacing measured with GPU work stubbed)", async () => {
  // SwiftShader rasterises on the CPU and cannot reach 60 fps with the real
  // orb, so the scheduler's pacing is measured with the draw call stubbed out.
  await page.evaluate(() => { window.__realRender = window.__vision.core.render; window.__vision.core.render = () => {}; });
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => window.__vision.targetFps === 30, null, { timeout: 8000 });
  const idle = await rate(3000);
  await page.mouse.move(W / 2, H / 2 - 8); // over the orb
  await page.waitForFunction(() => window.__vision.sm.state === "HOVER", null, { timeout: 3000 });
  const busy = await rate(2000);
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => window.__vision.sm.state === "IDLE", null, { timeout: 3000 });
  await page.waitForFunction(() => window.__vision.targetFps === 30, null, { timeout: 8000 });
  const idleAgain = await rate(2000);
  await page.evaluate(() => { window.__vision.core.render = window.__realRender; });
  console.log(`# scheduler pacing: idle ${idle.toFixed(1)} fps, hover ${busy.toFixed(1)} fps, idle again ${idleAgain.toFixed(1)} fps`);
  assert.ok(idle >= 27 && idle <= 31.5, `idle ${idle}`);
  assert.ok(busy >= 55, `interaction ${busy}`);
  assert.ok(idleAgain >= 27 && idleAgain <= 31.5, `idle again ${idleAgain}`);
});

test("Lively pause stops rendering completely; resume restores it", async () => {
  await page.evaluate(() => window.livelyWallpaperPlaybackChanged(JSON.stringify({ IsPaused: true })));
  await page.waitForTimeout(200);
  const r = await rate(1500);
  const st = await page.evaluate(() => ({ running: window.__vision.running, state: window.__vision.sm.state }));
  assert.equal(r, 0);
  assert.equal(st.running, false);
  assert.equal(st.state, "PAUSED");
  await page.evaluate(() => window.livelyWallpaperPlaybackChanged(JSON.stringify({ IsPaused: false })));
  assert.ok((await rate(1500)) > 5);
});

test("hidden page stops rendering; visible restores it", async () => {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(200);
  assert.equal(await rate(1200), 0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.ok((await rate(1200)) > 5);
});

test("WebGL context loss is recovered without reload", async () => {
  await page.evaluate(() => { window.__lc = window.__vision.core.renderer.getContext().getExtension("WEBGL_lose_context"); window.__lc.loseContext(); });
  await page.waitForTimeout(400);
  assert.equal(await rate(800), 0);
  await page.evaluate(() => window.__lc.restoreContext());
  await page.waitForFunction(() => window.__vision.perf.contextRestores === 1, null, { timeout: 5000 });
  assert.ok((await rate(1500)) > 5, "no frames after restore");
  // verify the orb actually draws again (non-black centre pixel)
  const px = await page.evaluate(() => {
    const { core } = window.__vision; core.render(1);
    const gl = core.renderer.getContext(); const b = new Uint8Array(4);
    gl.readPixels(gl.drawingBufferWidth >> 1, (gl.drawingBufferHeight >> 1) + 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
    return b[0] + b[1] + b[2];
  });
  assert.ok(px > 60, `centre pixel too dark after restore (${px})`);
});

test("Lively settings apply live (theme, quality, HUD, debug)", async () => {
  const get = () => page.evaluate(() => {
    const v = window.__vision;
    return {
      base: v.orb.uniforms.uColBase.value.getHexString(),
      outer: v.orb.stats.outerStrands,
      statsHidden: document.querySelector(".hud-stats").classList.contains("hidden"),
      debug: !!document.querySelector(".debug"),
      helper: v.helper.status,
    };
  });
  const before = await get();
  await page.evaluate(() => {
    livelyPropertyListener("theme", 1);
    livelyPropertyListener("quality", 2);
    livelyPropertyListener("hudStats", false);
    livelyPropertyListener("debugOverlay", true);
  });
  await page.waitForTimeout(800);
  const after1 = await get();
  assert.notEqual(after1.base, before.base, "theme did not change colours");
  assert.equal(after1.outer, 4000);
  assert.equal(after1.statsHidden, true);
  assert.equal(after1.helper, "disabled");
  assert.equal(after1.debug, true);
  const dbg = await page.$eval(".debug", (e) => e.textContent);
  assert.match(dbg, /draw calls\s+\d+ total · \d+ orb/);
  const orbCalls = Number(/· (\d+) orb/.exec(dbg)[1]);
  assert.ok(orbCalls > 0 && orbCalls < 20, `orb draw calls ${orbCalls}`);
  await page.evaluate(() => {
    livelyPropertyListener("theme", 3);
    livelyPropertyListener("customColor", "#7CFFB2");
  });
  await page.waitForTimeout(300);
  const custom = await get();
  assert.notEqual(custom.base, after1.base, "custom colour not applied");
  await page.evaluate(() => {
    livelyPropertyListener("theme", 0); livelyPropertyListener("quality", 0);
    livelyPropertyListener("hudStats", true); livelyPropertyListener("debugOverlay", false);
  });
  await page.waitForTimeout(300);
  const back = await get();
  assert.equal(back.outer, 1500);
  assert.equal(back.debug, false);
  assert.equal(back.base, before.base);
});

test("audio reactive: off ignores audio, on responds; webcam never touched", async () => {
  const loud = Array.from({ length: 128 }, () => 0.9);
  await page.evaluate((a) => { for (let i = 0; i < 20; i++) livelyAudioListener(a); }, loud);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__vision.orb.uniforms.uAudio.value), 0);
  await page.evaluate(() => livelyPropertyListener("audioReactive", true));
  await page.evaluate((a) => { for (let i = 0; i < 20; i++) livelyAudioListener(a); }, loud);
  await page.waitForTimeout(300);
  const lvl = await page.evaluate(() => window.__vision.orb.uniforms.uAudio.value);
  assert.ok(lvl > 0.3 && lvl <= 1, `audio level ${lvl}`);
  await page.evaluate(() => livelyPropertyListener("audioReactive", false));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__vision.orb.uniforms.uAudio.value), 0);
  assert.equal(await page.evaluate(() => window.__gum), 0, "camera/microphone API was called");
});

test("click opens ring, empty click closes, double-click resets view", async () => {
  const cx = W / 2, cy = H / 2 - 8;
  await page.mouse.click(cx, cy);
  await page.waitForFunction(() => window.__vision.sm.state === "APP_RING", null, { timeout: 3000 });
  await page.waitForTimeout(600);
  await page.mouse.click(8, H - 8);
  await page.waitForFunction(() => window.__vision.ring.currentPhase === "closed" && window.__vision.sm.state !== "APP_RING", null, { timeout: 3000 });
  // drag the camera away
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
  const dragState = await page.evaluate(() => window.__vision.sm.state);
  await page.mouse.up();
  assert.equal(dragState, "DRAG");
  const moved = await page.evaluate(() => window.__vision.core.camera.position.distanceTo(window.__vision.home));
  assert.ok(moved > 0.3, `drag did not move camera (${moved})`);
  await page.mouse.dblclick(cx, cy);
  await page.waitForFunction(() => window.__vision.core.camera.position.distanceTo(window.__vision.home) < 0.05, null, { timeout: 6000 });
  const st = await page.evaluate(() => ({ s: window.__vision.sm.state, ring: window.__vision.ring.currentPhase }));
  assert.ok(st.s === "IDLE" || st.s === "HOVER", st.s);
  assert.equal(st.ring, "closed", "double-click must not leave the ring open");
});

test("zoom is clamped", async () => {
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(600);
  const near = await page.evaluate(() => window.__vision.core.camera.position.length());
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(600);
  const far = await page.evaluate(() => window.__vision.core.camera.position.length());
  const home = await page.evaluate(() => window.__vision.home.length());
  assert.ok(near >= home * 0.77, `zoomed too close ${near}`);
  assert.ok(far <= home * 1.31, `zoomed too far ${far}`);
});

test("no console errors or warnings", () => {
  const relevant = logs.filter((l) => !/net::ERR_CONNECTION_REFUSED|Failed to load resource|GPU stall|swiftshader|GroupMarkerNotSet|Automatic fallback to software WebGL|WebGL: CONTEXT_LOST_WEBGL|loseContext/i.test(l));
  assert.deepEqual(relevant, []);
});

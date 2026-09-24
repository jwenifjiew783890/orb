# VISION Orb: Technology Decisions

Each entry follows the format **Choice / Alternatives / Decision / Reason / Benchmark or result**.
When a measurement could not be taken in the build environment, the entry says so and
points to the Windows procedure that closes it. Nothing below is an estimate presented as
a measurement.

**Build environment:** Linux container, 4 vCPU, **no GPU**. Chromium 141 (the engine
WebView2 is built on) renders WebGL2 through SwiftShader, a CPU rasteriser. Visual output
is faithful. GPU-side performance is not, so every GPU and FPS figure from this
environment is labelled as such.

---

## 0. Phase 0: runtime compatibility proof

**Choice:** Before any production visuals, build a probe wallpaper (`tools/phase0/`)
that checks the whole runtime path and shows PASS/FAIL live on screen. The checks cover
WebGL2, half-float render targets, UnrealBloomPass, mouse move/drag/wheel, loading a local
asset by relative path, the Page Visibility API, `livelyWallpaperPlaybackChanged`,
`livelyPropertyListener` and console errors. It also probes for a WebGPU adapter and
includes a WebGL2-vs-WebGPU benchmark.

**Result in Chromium, loaded from `file://` exactly as Lively loads it**
(`docs/phase0-result.json`, `docs/screenshots/phase0-probe.png`):

| Check | Result |
|---|---|
| WebGL2 context | PASS |
| Half-float render targets | PASS |
| Bloom | PASS |
| Local image asset (relative path, `<img>`) | PASS |
| Mouse events | PASS |
| Visibility API | PASS |
| Lively pause hook → rendering stops (frames 33 → 33 while paused) → resumes (47) | PASS |
| Lively property hook | PASS |
| Console errors | 0 |
| `fetch()` of a local JSON file | **Blocked** (`URL scheme "file" is not supported`) |
| WebGPU | No adapter in this container |

**Decisions forced by Phase 0:**

- **The bundle must be a classic script.** Chromium blocks ES-module scripts and
  `fetch()` over `file://`. The Vite build therefore emits one IIFE bundle
  (`<script defer>`) with every asset inlined. There are no runtime fetches of local
  files and no CDN.
- **Helper pairing uses a `<script src="token.js">`.** Classic scripts load fine over
  `file://`. `fetch("config.json")` would not.

**Still to verify inside Lively:** this container cannot run Windows or Lively. Load
`tools/phase0/` as a Lively wallpaper, check every row is PASS, then press *Run renderer
benchmark*. The checklist is in `docs/WINDOWS_TEST_PLAN.md` §1.

---

## 1. Renderer: WebGL2 vs WebGPU (Three.js WebGPURenderer + TSL)

**Alternatives:**

- Three.js `WebGLRenderer` (WebGL2) with custom GLSL
- Three.js `WebGPURenderer` with TSL node materials. It falls back to a WebGL2 backend
  automatically when WebGPU is unavailable.
- Raw WebGPU
- Babylon.js
- OGL or regl (minimal WebGL)

**Decision:** WebGL2 through Three.js `WebGLRenderer` is the production renderer.

**Reason:**

1. **The workload doesn't favour WebGPU.** The cost is about 64k line vertices shaded
   with 4D simplex noise, some additive points, and 3 post passes, in roughly 24 draw
   calls in total. WebGPU's main advantage is cheaper CPU-side submission for thousands
   of draws, and there is nothing to gain at 24 draws. The GPU-side vertex and fragment
   work is the same on both APIs.
2. **Points would get more expensive under WebGPU.** WebGPU has no `gl_PointSize`
   (point-lists are 1 px). Three's WebGPU backend draws sized sprites as instanced quads,
   so every point (pulse heads, sparks, dust, glyphs) becomes 4–6 vertices.
3. **WebView2 GPU support varies.** WebView2 follows Edge's GPU blocklist and driver
   support. WebGL2 is available on effectively every Windows GPU that can run Lively.
   WebGPU still depends on driver and OS.
4. **The shaders are GLSL.** `WebGPURenderer` doesn't accept GLSL `ShaderMaterial`, so
   switching means porting every shader to TSL. That's feasible (TSL has `mx_noise`,
   loops and uniforms), but it's a rewrite with no measured benefit for this scene.
5. **Context loss.** WebGL context-loss recovery is implemented and tested (§12). The
   WebGPU equivalent (device loss) needs a separate recovery path.

**Benchmark:**

- **This container:** `navigator.gpu` has **no adapter**, so no WebGPU numbers were
  possible. WebGL2 through SwiftShader: see PERF_REPORT.md.
- **On the target PC:** the Phase 0 probe's *Run renderer benchmark* button renders
  100k, 400k and 1.6M additive line segments for 3 s each on both backends. It reports
  mean fps and p95 frame time per backend and logs `[VISION phase0 bench]` JSON.
- **Rule:** switch only if WebGPU is stable in Lively and at least as fast at 100k and
  400k segments. Record the result in PERF_REPORT.md §5.

**2026 context:** Three.js `WebGPURenderer` has shipped with zero-config WebGL2 fallback
since r171 ([three.js docs](https://threejs.org/docs/pages/WebGPURenderer.html);
[utsubo 2026 guide](https://www.utsubo.com/blog/threejs-2026-what-changed)). This keeps
the door open to port later without changing the scene structure.

## 2. Build tool: Vite vs Next.js static export

**Alternatives:**

- Next.js static export (the source repo uses Next 16)
- Vite
- esbuild script
- Plain `<script>` tags

**Decision:** Vite 8 (Rolldown) + TypeScript, IIFE output.

**Reason:**

- A wallpaper is a single page. React, routing, SSR and hydration are dead weight.
- Next's static export emits ES modules and chunked `_next/` assets, which fail over
  `file://` (see Phase 0).
- Vite gives HMR during development (`npm run dev`), `?raw` shader imports and a single
  classic bundle via `output.format = "iife"` plus a 10-line plugin that rewrites the
  script tag.

**Result:** `wallpaper/js/vision.js` is about 590 kB minified, about 150 kB gzip. It
contains three.js core, OrbitControls and the post-processing passes. No runtime network
requests are made except to `127.0.0.1`.

## 3. Helper language: Go vs Rust vs Python

**Alternatives:**

- Go (single static exe)
- Rust (single static exe)
- Python + psutil + PyInstaller
- Node

**Decision:** Go 1.24, `CGO_ENABLED=0`, one dependency (`golang.org/x/sys`).

**Reason:**

- It cross-compiles to a single Windows exe from any OS, and the build is reproducible
  (`helper/build.sh`).
- The standard library HTTP server has proper timeouts.
- Windows stats use PDH and `GlobalMemoryStatusEx` directly through `x/sys/windows`.
  `NewLazySystemDLL` loads them from System32 only, which prevents DLL planting.
- Rust would also meet the RAM target and could shave a few MB. Go was chosen for
  simpler maintenance and faster iteration, and it still meets the target by a wide
  margin.
- Python + PyInstaller unpacks a runtime and idles at about 25–40 MB, which fails the
  20 MB target.

**Benchmark (Linux build, `docs/perf/helper-bench-linux.json`):** RSS about 7–9 MB and
startup in tens of ms; see PERF_REPORT.md §3. Windows exe size: 6.5 MB. Windows RSS is
measured with `perf-sample.ps1`.

## 4. Interaction: OrbitControls approach

**Alternatives:**

- Three.js `OrbitControls`
- `TrackballControls`
- camera-controls (yomotsu)
- A custom quaternion arcball

**Decision:** `OrbitControls`, the mature and well-tested option the brief suggested,
wrapped in `interaction/Input.ts`.

**Configuration:**

- Damping 0.055, which gives momentum and no snapping.
- Pan disabled.
- Polar angle clamped to [0.35, π−0.35] so the orb never flips.
- Zoom clamped aggressively to [0.78×, 1.3×] of the home distance, with zoom speed 0.35
  to avoid accidental zoom.

**Added on top:**

- **Idle return:** after 3 s without input, a critically damped spherical ease brings
  the camera home (rate 0.55/s, so it never snaps or takes control abruptly).
- **Double-click reset:** the same ease at 3.2/s.
- **Click vs drag:** movement under 6 px and a press under 400 ms counts as a click.
- **Single vs double click:** a 260 ms window, so a double-click never flashes the app
  ring open.
- **Hover:** tested against the orb's projected radius. This is analytic, with no
  raycast against 64k segments.

**Result:** the automated tests cover drag → `DRAG` state with the camera moving,
double-click returning within 0.05 units of home, and the zoom clamp holding under 30
wheel steps each way.

## 5. Bloom configuration

**Alternatives:**

- `UnrealBloomPass`, which the brief preferred
- pmndrs/postprocessing's mipmap-blur bloom (higher quality, merged effect pass, but an
  extra dependency)
- A custom dual-Kawase blur

**Decision:** `UnrealBloomPass` subclassed as `ScaledBloomPass`.

**Configuration:**

- It already runs at half resolution. The subclass scales it further per quality
  profile (×0.6 on Low and at auto step 3).
- Strength 0.85 × user setting, radius 0.35, threshold 0.42 on HDR half-float input.
- It's followed by one custom final pass that does four things:
  - **Tone mapping:** a hue-preserving extended Reinhard on the max channel.
  - **Chromatic aberration:** subtle, 0.012, disabled on Low.
  - **Vignette.**
  - **Black-point crush and grain:** lifts faint haze to true black and adds light grain.
- DPR is capped at ≤ 1.5 (1.0 on Low, 1.25 on Medium).

**Reason:**

- **Tone mapping:** ACES desaturated the gold toward beige, which you can see in early
  screenshots. The hue-preserving curve keeps amber saturated and lets only genuinely hot
  regions (the core, pulse heads) roll off to white. That's the visual hierarchy the
  brief asks for.
- **Bloom threshold:** the low threshold in the Sagar scene (0.2 at 1.8 strength)
  flattened filaments into a glow ball. The threshold of 0.42 keeps individual filaments
  readable.

**Result:** the post chain costs 14 draw calls, and the orb itself costs 10. Earlier tuning
iterations are described in the commit history. The final look is in
`docs/screenshots/`.

## 6. Filament representation

**Alternatives:**

- One `THREE.Line` per strand (Sagar-style: thousands of draw calls)
- Instanced tubes / MeshLine (triangle-strip thick lines)
- Merged indexed `LineSegments`
- A GPU compute/transform-feedback simulation

**Decision:** merged indexed `LineSegments`, one draw per layer, with all animation in
the vertex shader.

**Reason:**

- The references show thin, 1 px-scale filaments. Bloom provides the apparent
  thickness, so thick-line geometry (6× the vertices) isn't justified.
- One index buffer per layer means 2 draws for up to 5,400 strands.
- Strands are emitted in random order with a fixed sample count. Any prefix of strands
  is therefore a faithful subset, and the quality levels only change `setDrawRange`:
  switching is instant, with no rebuild or allocation.
- **Generation (once, 147 ms measured):** four strand families steered by a calibrated
  density field:
  - great-circle arcs
  - random walks steered by swirl-plus-attraction fields around 13 cluster axes
  - high-curvature tangles seeded only in dense regions
  - dendrites diving to the core
- **Density field:** Gaussian clusters, minus 6 voids, plus value noise. It's calibrated
  by quantiles to the brief's split: 15% dense / 55% medium / 20% sparse / 10% near-empty
  surface area.
- **Pulses:** a pure function of (strand seed, pulse clock), evaluated identically in the
  line shader (comet tail) and the pulse-head sprite shader (bright head read from an
  RGBA32F position texture with `texelFetch`). So heads ride exactly on their tails with
  zero JS per pulse.
- Transform feedback wasn't needed: every animated quantity is a closed-form function of
  time.

**Result:** the orb is **10 draw calls** (target < 20), with about 62k line segments and
3.7k points on Medium (debug overlay, `docs/perf/headless-medium-1280x720.json`). There is
no per-strand JS and no per-frame allocation (§9).

## 7. Procedural and "4D" techniques evaluated

| Technique | Used? | Where / why |
|---|---|---|
| 4D simplex noise (xyz + time) | **Yes** | Filament drift. Sampling time as the 4th dimension makes the network *evolve* rather than scroll through a static 3D field. Ashima/Gustavson webgl-noise (MIT). |
| Domain warping | **Yes** | `livingDisplace()`: a 3-channel 4D noise warp feeds a radial noise, giving organic bending. |
| Curl-like swirl fields | **Yes, at generation** | Strands are steered by tangential swirl (c × p) plus attraction around cluster axes. That produces tangles and flows without runtime cost. |
| Procedural attractor fields | **Yes, at generation** | Cluster attraction in the walk steering. |
| Hypersphere (S³) projection | Evaluated, not used | Stereographically projecting rotating 4D great circles gives beautiful but recognisably *geometric* Hopf-fibration patterns. The brief explicitly wants organic, non-geometric structure. |
| Reaction–diffusion | Evaluated, not used | It needs a persistent ping-pong simulation texture (2 extra passes per frame, all day long) for a subtle surface texture. Poor value against the idle budget. |
| Volumetric raymarched haze | Evaluated, not used | Full-screen raymarching costs orders of magnitude more than the analytic halo billboard. The halo plus half-res bloom gives the atmosphere. |
| Transform-feedback / GPGPU particles | Not needed | Sparks are *stateless* (age = fract(clock·rate + seed)), so there's no simulation state to store. |
| Fresnel / depth glow | **Yes** | Per-vertex depth fade relative to the orb centre (back strands at 20%) gives real spherical depth when dragging. The inner layer spins at −1.55× for parallax. |

## 8. Adaptive quality strategy

**Alternatives:**

- Static profiles only
- Continuous dynamic resolution
- Stepped degradation

**Decision:** three user profiles (Low / Medium / High) plus an optional auto-reduction
ladder (`render/AutoQuality.ts`), in five controlled steps with the cheapest visual loss
first:

1. particle density ×0.6
2. filament density ×0.75
3. bloom resolution ×0.6
4. DPR → 1.0
5. chromatic aberration and glyphs off

**How it measures:**

- **With a GPU timer:** it uses `EXT_disjoint_timer_query_webgl2` and compares GPU
  ms/frame against the **idle budget of 3.3 ms**. That's 10% GPU at 30 fps, the brief's
  target, expressed per frame.
- **Without a timer:** it uses frame pacing (the median interval against the target).
- It measures for 4 s after boot and after each step, then re-checks every 30 s. It only
  ever steps down, never oscillating, and the user's profile is the ceiling.

**Reason:** stepped reduction keeps the artistic identity: the same geometry, palette and
effects, just fewer of them.

**Result:** the ladder is exercised in development. Steps actually taken on a real GPU are
reported by the debug overlay (`auto` row) and belong in PERF_REPORT.md §5.

## 9. Frame scheduling and pausing

**Decision:** one `requestAnimationFrame` loop with deadline pacing. It keeps phase, so on
a 144 Hz display the 60 fps target averages 60.

| Situation | Frame rate |
|---|---|
| Interaction, boot, animation, and the first 3 s after input | 60 fps |
| Otherwise | 30 fps |
| Hidden, Lively-paused, or WebGL context lost | 0 fps |

When paused, the page cancels its rAF entirely and also stops helper polling and the
clock timer.

**Result:** measured pacing with GPU work stubbed was **idle 30.0 / hover 60.0 / idle
again 30.0 fps**. Paused: **0 frames**, and the page's main-thread CPU dropped to 0.09% of
one core (PERF_REPORT.md).

## 10. Helper link and pairing

**Choice:** how the wallpaper learns the token.

**Alternatives:**

- Hard-coded token (forbidden by the brief)
- Unauthenticated pairing endpoint
- Lively textbox property only
- `token.js` written by the installer

**Decision:** the installer runs `vision-helper --init`, which creates a 256-bit
`crypto/rand` token in `helper/config/config.json` (ACL'd to the user). It then runs
`--write-token-js` into every VISION Orb copy it finds: the repo folder, Lively's library
(classic and MSIX paths, plus any custom library location from Lively's settings). The
helper refuses to write `token.js` anywhere whose `LivelyInfo.json` title isn't
"VISION Orb". A Lively textbox ("Helper token") is the manual fallback.

**Reason:** nothing secret goes into source control, no unauthenticated endpoint exists,
and web pages elsewhere in the browser can't read local files.

**Also considered:** Lively's own `--system-information` feed as a no-helper stats source.
It was rejected to keep one data source and avoid Lively-side polling cost. It could be a
fallback later.

## 11. Watchdog

**Decision:** a Windows Task Scheduler task for the current user, with no admin rights.

**Configuration:**

- An at-logon trigger, plus a watchdog trigger every 5 minutes.
- `MultipleInstances IgnoreNew`, restart-on-failure 999×/1 min, no execution time limit.
- The helper also holds a per-user named mutex (`Local\VISION-Helper-<port>`). A duplicate
  start exits 0 immediately.
- Launched apps use `CREATE_BREAKAWAY_FROM_JOB`, falling back without it if the job
  forbids breakaway. So restarting or stopping the helper task never kills apps the user
  opened.

**Result:**

- **Linux (automated):** the launched app outlives the helper, restart-on-reconnect
  works, and duplicate starts exit cleanly.
- **Windows:** Task Scheduler behaviour is verified on Windows (`docs/WINDOWS_TEST_PLAN.md`
  §4–5).

## 12. WebGL context loss

**Decision:** call `preventDefault()` on `webglcontextlost` and stop the loop. On restore,
three.js lazily re-uploads geometry, textures and programs. The post-processing chain is
rebuilt rather than resized, and the timer-query extension is re-enabled.

**Reason:** three.js's render-target dispose listeners from the lost context would
otherwise try to delete dead GL objects. That produced *"object does not belong to this
context"* warnings, found by the zero-warning test.

**Result:** the automated test runs `loseContext` → 0 fps → `restoreContext` → frames
resume, and the centre pixel is lit again. There's no page reload and no warnings.

## 13. Webcam and hand gestures

**Decision:** not included in this release. There is no camera code in the bundle
(MediaPipe from the source repo was removed entirely), so there's nothing to disable.

**Result:** the automated test wraps `getUserMedia` and `enumerateDevices`, toggles every
setting including audio, and asserts **0 calls**. If gestures are added later, they belong
in a separately loaded, opt-in script so the base wallpaper stays lightweight.

## 14. Lively audio feed: off by default

**Choice:** Lively sends system audio to a wallpaper (`livelyAudioListener`, 128 bins at
roughly the display rate) only if `LivelyInfo.json` declares `--audio true`. The feed
can't be switched at runtime.

**Alternatives:**

- Always declare `--audio`, so the Customise toggle works out of the box
- Leave it undeclared, and provide a one-click script that adds it

**Decision:** leave it undeclared (`"Arguments": "--pause-event true"`) and provide
`tools/windows/enable-audio.ps1` (and `-Disable`). If *Audio reactive* is switched on
without the feed, a HUD hint appears after 4 s.

**Reason:** with `--audio`, Lively captures loopback audio, runs an FFT and calls into
the page about 60 times per second all day, even when audio-reactive is off. That's a
permanent cost against the ≤ 3% idle CPU target for a feature that's off by default.

**Benchmark:** **PENDING** on Windows. Run `perf-sample.ps1 -Label idle` with and without
the feed enabled. If the difference is negligible, declare `--audio` by default.

## 15. What was kept from the Sagar orb, and what was replaced

| Sagar orb (`lib/orbScene.ts`) | VISION Orb |
|---|---|
| ~120 separate `THREE.Line` lat/long rings, meridians and panels | Replaced by a procedurally generated neural filament network (2 draws) |
| 1,700 individual canvas-texture text sprites, moved in JS every frame | **Idea kept:** 700 "data glyphs" in one `Points` draw from one 8×8 glyph atlas, animated in the shader |
| 250 debris meshes, each moved in JS | Replaced by stateless GPU sparks that escape and decelerate (1 draw) |
| 2,000 dust points | **Kept** as 500–1,800 faint dust points with shader twinkle |
| Scan rings | **Kept and evolved** into broken, ticked orbit rings (1 draw, rotation in shader) |
| Spiral core + icosahedron | Replaced by an inner filament volume with parallax, a hot-white core billboard with radial spokes, and core rings |
| Bloom + chromatic-aberration pass | **Kept** in spirit: half-res bloom, and CA folded into the single final pass |
| OrbitControls with damping | **Kept**, clamped and wrapped in a state machine |
| MediaPipe hand tracking | Removed (§13) |
| Always-60 fps `requestAnimationFrame` | Replaced by the adaptive 60/30/0 scheduler |

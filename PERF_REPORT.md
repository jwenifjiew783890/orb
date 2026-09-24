# VISION Orb: Performance Report

**Rules for this report:** only measured values are recorded here. Anything that
could not be measured in the build environment is marked **PENDING**, with the exact
procedure that produces it. No failed or missing benchmark is hidden.

## Environments

| | Build/CI container (measured) | Target PC (pending) |
|---|---|---|
| OS | Linux 6.18, 4 vCPU, 16 GB | Windows 10/11 |
| Browser engine | Chromium 141 headless (Playwright) | WebView2 (Chromium-based) inside Lively |
| GPU | **None.** WebGL2 via ANGLE → SwiftShader (CPU rasteriser) | Real GPU |
| Helper | linux/amd64 build of the same Go source | `helper/bin/vision-helper.exe` |

**What SwiftShader invalidates:**

- **Invalid:** absolute FPS, GPU %, and whole-machine CPU %. The "GPU" is software running
  in Chromium's GPU process on the same 4 vCPUs, and it can't reach 30 fps even at small
  sizes.
- **Still valid:** the page's own main-thread cost, JS heap, draw-call counts, scheduler
  pacing (measured with the draw stubbed), pause behaviour and the helper's resource use.

---

## 1. Target table

| Target (brief §38) | Result | Status |
|---|---|---|
| Idle 30 FPS | Scheduler holds exactly **30.0 fps** idle | **Met** (pacing) · real-GPU FPS PENDING |
| Interaction smooth 60 FPS | Scheduler switches to **60.0 fps** on hover or drag, back to **30.0** after 3 s | **Met** (pacing) · real-GPU FPS PENDING |
| Paused → ~0% rendering CPU/GPU | **0 frames**. Page main thread **0.09%** of one core while paused (clock and timers stopped) | **Met** |
| Idle CPU ≤ 3% | Page main thread **1.15 ms/frame**. At 30 fps that's ≈ 3.5% of one core, ≈ 0.4% of an 8-thread CPU. It excludes the GPU-process and WebView2 overhead. | **PENDING** on Windows (`perf-sample.ps1 -Label idle`) |
| Idle GPU ≤ 10% | Budget built into auto-quality: ≤ 3.3 ms GPU/frame at 30 fps | **PENDING** on Windows (GPU timer in the debug overlay + `perf-sample.ps1`) |
| Wallpaper RAM ≤ 200 MB | JS heap **3.6 MB**. The renderer process total isn't measurable meaningfully here. | **PENDING** on Windows (`wall_private_mb`) |
| Helper RAM ≤ 20 MB | **6.5 MB** after start, **8.5–9.1 MB** peak under polling (Linux build) | **Met** on Linux · Windows PENDING |
| < 20 draw calls for the orb | **10** orb draw calls (24 total including bloom and final pass) | **Met** |
| DPR ≤ 1.5 | Capped: 1.0 Low / 1.25 Medium / 1.5 High | **Met** (by construction, shown in the debug overlay) |
| Bloom ≈ half resolution | UnrealBloom's chain starts at ½ res; Low scales it to 0.3 | **Met** (by construction) |
| No per-frame allocations | `update()` paths reuse preallocated vectors and quaternions. The JS heap stays flat (§4). | **Met** |
| No measurable game FPS degradation | — | **PENDING** (`docs/WINDOWS_TEST_PLAN.md` §6) |

## 2. Wallpaper (headless Chromium, SwiftShader)

Source: `tests/perf/headless-perf.mjs`, which reads CDP `Performance.getMetrics` over 15 s
windows at 1280×720, Medium quality. Raw data is in `docs/perf/headless-medium-1280x720.json`.

| Scenario | Scheduler target | Rendered fps (SwiftShader-bound) | Page main-thread CPU (% of one core) | CPU ms per frame | JS heap |
|---|---|---|---|---|---|
| Idle | 30 | 4.1 | 0.47% | 1.15 ms | 4.0 MB |
| Interaction (mouse circling the orb) | 60 | 4.2 | 0.65% | 1.54 ms | 4.3 MB |
| Paused (Lively `IsPaused:true`) | — | **0** | **0.09%** | — | 4.3 MB |

**How to read it:** the fps column is limited by the CPU rasteriser, not by VISION.
The *CPU ms per frame* column is the page's own work: JS simulation, uniform updates,
WebGL command encoding and DOM. It's a solid basis for estimating the page's CPU share
on real hardware, where the frame rate is the scheduler's 30 or 60.

**Scheduler pacing** (`tests/integration/wallpaper.test.mjs`, draw call stubbed so only
pacing is measured, 480×270):

| Phase | Measured |
|---|---|
| Idle (≥ 3 s without input) | **30.0 fps** |
| Hovering the orb | **60.0 fps** |
| Idle again | **30.0 fps** |
| Lively-paused | **0 fps** (rAF cancelled) |
| Page hidden | **0 fps** |
| WebGL context lost | **0 fps**, resumes after restore |

**Scene statistics** (debug overlay, Medium):

- **Draw calls:** 24 total, **10 orb**
- **Primitives:** 62,347 lines · 3,720 points · 4 triangles
- **Filaments:** 2,600 outer · 900 inner
- **Particles:** 3,720
- **DPR:** 1.00 (headless DPR is 1; the Medium cap is 1.25)
- **Filament generation at start-up:** 147 ms, once

| Quality | Outer / inner strands | Pulse heads | Sparks / dust / glyphs | Bloom scale | DPR cap | CA |
|---|---|---|---|---|---|---|
| Low | 1,500 / 500 | 220 | 120 / 500 / 0 | 0.6 | 1.0 | off |
| Medium | 2,600 / 900 | 420 | 260 / 1,000 / 360 | 1.0 | 1.25 | on |
| High | 4,000 / 1,400 | 700 | 420 / 1,800 / 700 | 1.0 | 1.5 | on |

## 3. Helper benchmark

Source: `tests/perf/helper-bench.mjs`, Linux build of the same code. Raw data is in
`docs/perf/helper-bench-linux.json`.

| Measure | Result |
|---|---|
| Startup to first `/health` answer | median **59 ms** (5 runs: 2–83 ms; includes the 50 ms polling granularity of the test) |
| RSS after start | **6.5 MB** |
| Peak RSS (whole benchmark) | **8.5 MB** |
| Idle, no requests (collector suspends after 20 s) | **0.05%** of one core, 6.8 MB |
| Wallpaper polling (1 request per 1.5 s) | **0.067%** of one core, 8.3 MB |
| Stress polling (10 requests/s) | **0.27%** of one core, 8.5 MB. Stats are still collected only 1×/s; requests are served from the cached JSON. |
| Windows exe size | 6.5 MB (`-trimpath -s -w`) |

The **Windows figures are PENDING**: the PDH collector differs from `/proc`. Measure them
with `tools/windows/perf-sample.ps1` (`helper_private_mb` and `helper_cpu_pct` columns).

## 4. Accelerated soak (container)

Source: `tests/perf/mini-soak.mjs`, which runs the wallpaper plus the real helper for
**10 minutes** and samples every 30 s after a forced GC. Every other sample exercises
hover and opening/closing the app ring. Raw data is in `docs/perf/mini-soak-10min.json`.

Two runs: 10 minutes sampled every 30 s, and 20 minutes sampled every 60 s. Raw data is in
`docs/perf/mini-soak-10min.json` and `docs/perf/mini-soak-20min.json`.

| Time (20-min run) | JS heap after GC | DOM nodes | JS listeners | Helper RSS | Link |
|---|---|---|---|---|---|
| 1 min | 3.44 MB | 132* | 19* | 8.3 MB | online |
| 5 min | 3.61 MB | 132* | 19* | 8.8 MB | online |
| 10 min | 3.65 MB | 126 | 17 | 8.8 MB | online |
| 15 min | 3.68 MB | 126 | 17 | 8.8 MB | online |
| 19 min | 3.69 MB | 126 | 17 | 8.8 MB | online (every sample) |

\* Sampled while the app ring was open. Its 6 nodes and 2 listeners are removed on close.

**Heap trend by 5-minute window:** +0.17 → +0.04 → +0.03 → +0.01 MB. That's a decaying
warm-up curve, not a linear leak.

**Where the growth comes from.** A heap-snapshot diff over 4 idle minutes (+212 KB)
attributes it to V8 internals and bounded browser buffers:

- ~190 KB of JIT code objects (optimised code for `update`, `frame`, `renderClock`, …)
- 23 KB of `PerformanceLongAnimationFrameTiming` entries. These are recorded because
  SwiftShader frames exceed 50 ms, and Chromium caps that buffer.
- the rest is V8 `WeakArrayList`s

**No application objects grew:** no three.js objects, arrays, closures or DOM.

Helper RSS stayed between 8.3 and 9.1 MB with no trend.

**This is not the 24-hour soak.** The 24-hour soak (one sample per 10 minutes) must run
on Windows:
`.\tools\windows\perf-sample.ps1 -Label soak -DurationSec 86400 -IntervalSec 600`.
Status: **PENDING**.

## 5. Windows measurements (to be filled on the target PC)

Procedure: `docs/WINDOWS_TEST_PLAN.md`. Paste the `perf-sample.ps1` summaries here.

### 5.1 Renderer benchmark (Phase 0 probe, inside Lively)

| Backend | 100k segments fps / p95 ms | 400k | 1.6M |
|---|---|---|---|
| WebGL2 | PENDING | PENDING | PENDING |
| WebGPU | PENDING (or "unavailable") | | |

### 5.2 Resource usage

| Scenario | Quality | Wallpaper CPU % | Wallpaper GPU % | Wallpaper RAM MB | FPS (overlay) | GPU ms (overlay) | Helper CPU % | Helper RAM MB |
|---|---|---|---|---|---|---|---|---|
| Idle | Medium | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| Interaction | Medium | PENDING | PENDING | PENDING | PENDING | PENDING | | |
| Paused (fullscreen app) | Medium | PENDING | PENDING | PENDING | 0 expected | | | |
| Idle | Low | PENDING | PENDING | PENDING | PENDING | PENDING | | |
| Idle | High | PENDING | PENDING | PENDING | PENDING | PENDING | | |

### 5.3 Lively audio feed cost (decides the `--audio` default, DECISIONS §14)

| Idle, Medium | Wallpaper CPU % | Lively process CPU % |
|---|---|---|
| Without `--audio` (default) | PENDING | PENDING |
| With `--audio` (`enable-audio.ps1`) | PENDING | PENDING |

### 5.4 Game test

| Run | Avg FPS | 1% low | Frame-time SD | Wallpaper CPU/GPU during game |
|---|---|---|---|---|
| Lively closed (×3) | PENDING | | | — |
| VISION running (×3) | PENDING | | | PENDING |

### 5.5 24-hour soak

| | Start | End | Trend | Link offline samples |
|---|---|---|---|---|
| Wallpaper RAM MB | PENDING | | | |
| Helper RAM MB | PENDING | | | PENDING |

## 6. Optimisations applied, measured against the source orb

The Sagar orb creates about 120 `Line` objects, 30 panel groups, 1,700 text sprites
(each with its own `CanvasTexture`) and 250 debris meshes. It moves the sprites and
debris in JavaScript every frame and renders at a fixed 60 fps.

That's roughly **2,100+ draw calls** and several thousand JS object updates per frame.
The figure comes from counting the objects in `lib/orbScene.ts`, not from a measurement.

VISION draws a larger, denser network in **10 draw calls**, with zero per-element JS,
and spends most of its time at 30 fps or paused.

# 4D procedural noise: where it is used, what it costs, and what could come next

This document describes the current build (`30fed06`). It records decisions only; **no
visual changes are made here**. Any change it proposes waits until the Windows / NVIDIA
measurements in `docs/WINDOWS_TEST_PLAN.md` are collected.

## 1. The noise function

`web/src/shaders/common.glsl`:

- **`snoise(vec4)` (line 26)** is 4D simplex noise from Ashima Arts / Stefan Gustavson
  webgl-noise, MIT. Its 4th coordinate is time, so the field **evolves** instead of
  scrolling through a fixed 3D volume. Nothing ever repeats and nothing visibly slides.
- **`livingDisplace(vec3 p)` (lines 83–92)** is a domain-warped displacement. It makes
  **four `snoise(vec4)` calls per vertex**:
  - 3 calls build a vector warp `(xyz·0.85 + offset, uDrift)`
  - 1 call gives a radial term sampled at the *warped* position `(p·1.6 + warp·0.6, uDrift·1.3)`

  The result is `(p + warp·uWarp + normal·radial·uWarp·0.7) · uBreath`.
- **The 4th dimension is `uDrift`, not wall-clock time.** It's integrated on the CPU
  (`OrbSystem.update`, `web/src/orb/OrbSystem.ts:379`) at `0.045/s`, faster when hovering
  (+0.02) or with audio (+0.03). Because it's integrated, changing the speed never makes
  the network jump.
- **`uWarp`** is 0.05 at idle, rising with hover and audio (`OrbSystem.ts:380`).

## 2. Every call site

| # | Where | Shader stage | Noise calls | Invocations per frame (Medium / High) | Purpose |
|---|---|---|---|---|---|
| 1 | `web/src/orb/shaders.ts:49` — filament vertex shader, `livingDisplace(position)` | vertex | 4 × snoise4 | 64,600 / 99,600 vertices (2,600×20 + 900×14 / 4,000×20 + 1,400×14) → **≈258k / ≈398k snoise4** | The living drift, bending and breathing of every outer and inner filament |
| 2 | `shaders.ts:144` — pulse-head vertex shader, `livingDisplace(p)` | vertex | 4 × snoise4, **only for active heads** (inactive heads return early) | ≤ 2,100 / 3,500 points | Keeps each bright head exactly on its displaced filament |
| 3 | `shaders.ts:250` — data-glyph vertex shader, `livingDisplace(position)` | vertex | 4 × snoise4 | 360 / 700 points | Glyphs ride the same living surface |
| 4 | `shaders.ts:301` — core fragment shader, `snoise(vec4(cos a, sin a, r − t, t))` | fragment | 1 × snoise4 | Core disc only: ≈ 316 px across at 1080p, DPR 1.25 → **≈ 120k fragments** | Wobble in the radial spokes. Angle is fed as (cos, sin) so there's no seam. |

**Not 4D:**

- **The rewiring fade** (`shaders.ts:59`) is a per-strand `sin(uDrift · rate + seed)`.
  It's driven by the same drift clock but costs no noise.
- **Shimmer, pulses, sparks and dust** use hashes and sines only.
- **Generation-time noise** (`web/src/orb/filamentGen.ts:93, 196`) is 3D value noise on
  the CPU. It runs once at start-up (147 ms total) to build the density field and strand
  wobble, and has zero per-frame cost.

## 3. What it costs, and how to measure it on the NVIDIA machine

The filament displacement (row 1) dominates. Roughly 258k snoise4 evaluations per frame
on Medium, at about 30 ops each, is a small vertex workload for any discrete NVIDIA GPU.
Fill-rate from additive lines, points and the bloom chain usually costs more.

**Not yet measured:** the container's software renderer can't give real numbers. The
split between noise and fill is exactly what the Windows run must measure, as follows:

1. **Total GPU ms per frame:** Debug overlay → `frame (gpu)`. It uses
   `EXT_disjoint_timer_query_webgl2` where the driver exposes it.
2. **Isolate the vertex noise share:** compare Quality Low / Medium / High with bloom and
   DPR held constant (auto-quality off). The strand count is the only variable that scales
   the noise work, so the ms-per-strand slope is the vertex cost.
3. **Record both in `PERF_REPORT.md` §5.2.**

**Keep/cut rule:** the idle budget is 3.3 GPU ms/frame (10% at 30 fps). The 4D system
stays as-is unless the Low→High slope shows the filament vertex stage alone exceeds about
half that budget on the target GPU.

## 4. Further procedural techniques: would they materially improve it?

Each candidate below is judged on visual gain for *this* neural-energy look against its
per-frame cost. **None is implemented.** They're ranked, and every one needs to be measured
first.

| Rank | Technique | Visual gain | Per-frame cost | Verdict |
|---|---|---|---|---|
| 1 | **Graph-propagated firing waves.** At generation, link strands whose endpoints meet within a small radius. Store each strand's hop-distance from the core as a vertex attribute (one float). Drive pulse timing by `(clock − hops·delay)` so activity cascades core → shell and shell → core like neural firing. | **High.** Currently pulses fire independently per strand. Cascades read as *intelligent*, coordinated activity, and make the launch burst travel through the network instead of being a radial ring. | ≈ 0: one attribute, one multiply-add in the existing pulse function. Generation +~20 ms. | **Recommended first** |
| 2 | **Curl noise from 4D gradient noise.** Replace the 3-channel warp with a divergence-free curl field (`psrdnoise`-style simplex with analytic gradients). | **Medium–high.** Divergence-free flow swirls filaments around each other without the bunching and stretching the current warp can produce. The motion looks more like fluid energy. | About neutral: two gradient-noise evaluations instead of three value calls. | **Recommended**, A/B against the current warp at equal GPU ms |
| 3 | **Drifting "activity regions."** One extra low-frequency `snoise(vec4)` per filament vertex modulates brightness and pulse density, so bright zones wander slowly across the sphere (the uneven hot regions in the reference images). | **Medium.** More large-scale variation and a sense of "thought" moving. | +25% of vertex noise (1 call on top of 4) | **Worth testing** if §3 shows vertex headroom |
| 4 | **Temporal afterimage for pulse trails** (a feedback buffer, 1 extra full-screen pass) | Low–medium. Longer, smoother light trails. It risks smearing the fine filaments and adds a fixed fill cost that doesn't scale down with quality. | +1 full-res pass and 1 extra render target | Optional; only if the GPU numbers leave clear room |
| 5 | **Thick "hero" strands** (the ~3% brightest strands as instanced camera-facing quads) | Low–medium. Some strands in reference 3 read thicker. | +~6× the vertices of those strands, plus overdraw | Optional |
| — | Reaction–diffusion surface | Low for this look | Ping-pong simulation (2 passes per frame, all day) | Rejected (DECISIONS §7) |
| — | Raymarched volumetric haze | Low over the existing halo + bloom | Orders of magnitude more fill | Rejected |
| — | Hypersphere (S³ / Hopf) projections | Produces geometric fibration patterns, the opposite of "organic" | Low | Rejected on appearance |

**Sequence after the Windows data is in:**

1. Measure the current build (PERF_REPORT §5).
2. If the idle budget holds, prototype #1. It costs almost nothing, so its main risk is
   visual.
3. A/B #2.
4. Try #3 only if there's measured vertex headroom.

Each change gets before/after screenshots at the same frozen time (`?t=`) and GPU-ms
numbers from the overlay.

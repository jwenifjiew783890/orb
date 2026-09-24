# Windows Acceptance Test Plan

These are the brief's acceptance items that **need a real Windows PC with Lively and a
GPU**, so they could not run in the build container (Linux, no GPU, no Lively). Each item
lists exact steps and where to record the result.

Record numbers in `PERF_REPORT.md` §5 and tick the boxes in `docs/TEST_RESULTS.md`. Don't
write "looks smooth": record the numbers.

Setup for the whole plan: follow `SETUP.md` steps 1–5 first. Open an elevated or normal
PowerShell in `VISION-Orb\tools\windows`.

---

## 1. Phase 0 runtime proof inside Lively

1. In Lively, add `tools\phase0\index.html` as a wallpaper and apply it.
2. Enable **Wallpaper Input → Mouse**.
3. Expected: every row is **PASS** except the two informational rows (local `fetch()` and
   WebGPU). Move the mouse over the desktop to get the *Mouse input* row to PASS. Open
   **Customise** and toggle the checkbox to get *Lively property listener* to PASS.
4. Start any fullscreen app. When you return, *Lively pause event* must show
   `IsPaused=false`, having been `true`.
5. Press **Run renderer benchmark**. Screenshot the result block and copy the
   `[VISION phase0 bench]` JSON from the WebView2 DevTools console (Lively → wallpaper
   ⋯ → *Open DevTools*, if your Lively version offers it). Paste both into
   `PERF_REPORT.md` §5.1.
6. **Decision rule** (DECISIONS.md §1): only if WebGPU is available, stable, and at least
   as fast at 100k and 400k segments should switching the renderer be considered.

## 2. Performance: idle, interaction, paused

With VISION Orb applied, quality Medium, auto-quality on, and the debug overlay **off**:

| Run | What to do while it samples |
|---|---|
| `.\perf-sample.ps1 -Label idle -DurationSec 120` | Don't touch the mouse; the desktop stays visible. |
| `.\perf-sample.ps1 -Label interaction -DurationSec 60` | Keep hovering over and dragging the orb the whole time. |
| `.\perf-sample.ps1 -Label paused -DurationSec 120` | Start a fullscreen app or game over the desktop first. |

Then turn the Debug overlay on for 30 s and note **fps** idle (target 30) and during
drag (target 60), plus the **frame (gpu)** ms and the auto step. Repeat idle on **Low**
and **High**.

**Targets:**

| Scenario | CPU | GPU | FPS | RAM |
|---|---|---|---|---|
| Idle | ≤ 3% | ≤ 10% | 30 | ≤ 200 MB (wallpaper) |
| Interaction | — | — | smooth 60 | — |
| Paused | ≈ 0 rendering | ≈ 0 | 0 | — |

## 3. Helper benchmark (Windows)

- Look at the *helper* columns from the runs above: RAM target ≤ 20 MB, and CPU.
- **Startup time:** `Measure-Command { Start-ScheduledTask 'VISION Helper'; do { Start-Sleep -m 20 } until (Test-NetConnection 127.0.0.1 -Port 47821 -InformationLevel Quiet) }`
  (stop the task first).
- **Stats accuracy:** compare the HUD against Task Manager's CPU, memory, GPU 3D and
  Ethernet/Wi-Fi graphs for 1 minute.

## 4. Watchdog and helper crash recovery

1. Kill the helper in Task Manager (`vision-helper.exe` → End task).
2. Expected: the HUD shows **STATS OFFLINE** within a few seconds, and the orb keeps
   animating.
3. Expected: the helper is back within 1 minute (restart-on-failure) or at most 5 minutes
   (watchdog trigger). The HUD recovers without reloading the wallpaper.
4. Start `helper\bin\vision-helper.exe` manually while the task's copy is running.
   Expected: the second copy exits immediately, and Task Manager shows only one
   `vision-helper.exe`.
5. Launch an app from the ring, then stop the task (`Stop-ScheduledTask 'VISION Helper'`).
   Expected: the launched app stays open.

## 5. Reboot test

Reboot, log in, wait 1 minute. Then check each item:

- [ ] Lively starts and VISION Orb shows its boot sequence
- [ ] `vision-helper.exe` is running (only once)
- [ ] The HUD gauges show live values (token authentication works after reboot)
- [ ] Clicking the orb shows your `apps.json` apps
- [ ] Launching an app works

## 6. Game test

Use a demanding game with a benchmark mode, or a fixed replayable scene, and
[PresentMon](https://github.com/GameTechDev/PresentMon) or CapFrameX for frame times.

1. Run the benchmark 3× with Lively **closed**. Record avg FPS, 1% low and frame-time
   standard deviation.
2. Run it 3× with VISION Orb applied, the helper running, and Lively's "pause when
   fullscreen/maximised" setting at default.
3. During run 2, also run `.\perf-sample.ps1 -Label game -DurationSec 120`. Wallpaper
   CPU and GPU should be ≈ 0.
4. Record the difference and its spread. Report "no measurable degradation" only if the
   difference is within run-to-run variance.

## 7. 24-hour soak

```powershell
.\perf-sample.ps1 -Label soak -DurationSec 86400 -IntervalSec 600
```

Leave the PC on with the desktop visible most of the time (occasional use is fine).

- Expected: wallpaper RAM and helper RAM stay roughly flat (no steady upward trend),
  `link` stays `online`, and there are no crashes.
- Also enable the Debug overlay at the end and note the `js heap` value.

## 8. Visual and settings checks on real hardware

Theme Gold / Arc Blue / Crimson / Custom, Quality Low / Medium / High, HUD toggle, Audio
toggle (play music: the core breathes with it; off means no reaction), Debug overlay.
Take screenshots with `Win+Shift+S` for the README if they differ noticeably from the
reference renders in `docs/screenshots/`.

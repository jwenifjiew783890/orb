# Desktop-shell interaction validation (Windows + Lively)

**Status: tooling ready — NOT yet run.** The build container has no Windows/Lively, so
what Lively actually delivers is unknown until `tools/windows/run-desktop-probe.ps1`
runs on the target PC. The desktop shell is not implemented until the results are in.

## How to run (≈ 7 minutes)

1. Install/update the helper: `helper\install-helper.ps1` (the rebuilt exe adds the
   probe report endpoint and the shortcut test).
2. PowerShell: `tools\windows\run-desktop-probe.ps1`, then follow it:
   - **Part 1** — add `tools\desktop-probe\index.html` to Lively, apply it, reload once
     after pairing, and follow the 18 on-screen steps (answers by left click).
   - **Part 2** — 90 s global-shortcut test: press Ctrl+Space on the desktop, in a
     normal window, in a fullscreen game/video, and Ctrl+Alt+Space once.
3. Send the folder it prints: `tools\windows\results\desktop-shell-<time>\`
   (`environment.json`, `desktop-probe-report.json`, `hotkey-probe.json`).
   If the report can't reach the helper, the probe shows it on screen — photograph it.
4. Re-apply VISION Orb in Lively.

## What is measured

| # | Capability | How |
|---|---|---|
| 1 | Pointer movement on empty desktop, over desktop icons; event rate (Hz) | `pointermove` counts/intervals |
| 2 | Left click, double click, drag; whether Windows *also* reacts (selection rectangle, icon activation) | `pointerdown/up/click/dblclick` + your answers |
| 3 | Mouse wheel, middle click | `wheel`, `pointerdown` button 1 |
| 4 | **Right click** on empty desktop: delivered? does the Windows desktop menu also open? — with icons visible and hidden | `pointerdown` button 2, `contextmenu`, your answers |
| 5 | **Keyboard**: Lively input = Mouse vs Keyboard; with desktop focused, with another window focused, with icons hidden; typed text and Ctrl+Space | `keydown` log |
| 6 | **Focus**: does clicking the desktop deactivate the previous window; page focus/blur | focus/blur events, `document.hasFocus()` sampling, your answer |
| 7 | **Desktop icons hidden**: do clicks/right-clicks/keys still reach the wallpaper | repeated steps |
| 8 | **Maximized / fullscreen / game**: Lively pause events, page visibility, frames rendered while paused/hidden | `livelyWallpaperPlaybackChanged`, `visibilitychange`, rAF counter |
| 9 | **Global shortcut**: can Ctrl+Space / Ctrl+Alt+Space be registered; which window was in front at each press; installed keyboard layouts | helper `--probe-hotkey` (`RegisterHotKey`) |
| 10 | Lively Customise → property hook | `livelyPropertyListener` |

`RegisterHotKey` is the standard per-application shortcut API. It is **not** an input
hook: the helper is told only about that one key combination and sees no other input.
No hook of any kind is used in the probe or planned for the shell.

## Decision rules (agreed in advance; least invasive fallback wins)

### Right click on empty desktop
| Result | Decision |
|---|---|
| Delivered, Windows menu **never** appears | VISION radial menu on right-click. |
| Delivered, but the Windows menu **also** appears (expected) | Do **not** use right-click on empty space — Windows keeps its menu untouched. VISION menu opens from the **orb** (click → navigation, which includes the menu actions) and by **press-and-hold** (left button ~0.45 s without moving) on empty space. |
| Not delivered | Same as above. |
| Press-and-hold not delivered reliably either | Orb-only access. No hook in any case. |
| Right-click on a **VISION node** | Used for the node menu only if delivered and Windows' menu does not also appear there; otherwise press-and-hold on the node. |

### Keyboard / search
| Result | Decision |
|---|---|
| Keys reach the wallpaper while the desktop is focused (Keyboard mode) | Search opens **in the wallpaper** from an orb click; typing works directly. |
| Keys do not reach the wallpaper | Search runs in the helper's small **transparent, focusable search window** placed over the orb (same web UI, visually integrated). Opened by orb click (wallpaper asks helper) or the global shortcut. |
| Global shortcut from other apps | Needs `RegisterHotKey` in the helper. **Registering a combo takes it away from every other app**, so the default must not break common software. Ctrl+Space is used by IME switching (e.g. Chinese/Japanese input), VS Code/IDE autocomplete and others. Proposed default: **Ctrl+Alt+Space**; Ctrl+Space available as an opt-in setting. If Lively forwards keys, Ctrl+Space also works *without registration* whenever the desktop itself is focused. |
| Registration fails (combo already owned) | Show it in Personalize, fall back to the next combo; never force. |

### Clicks with desktop icons hidden
| Result | Decision |
|---|---|
| Clicks/moves still delivered everywhere | Offer "Hide Windows desktop icons" toggle in Personalize (reversible). |
| Not delivered | Keep icons visible; document; VISION nodes are placed away from the icon grid area. |

### Focus
Clicking the desktop activating the desktop (previous window deactivates) is normal
Windows behaviour and is kept. VISION never steals focus from other apps except when
the user explicitly opens search.

### Fullscreen / games
| Result | Decision |
|---|---|
| Lively pause events or hidden visibility arrive | Existing 0-fps pause is sufficient. |
| Neither arrives in some case (e.g. borderless-windowed game) | Document Lively's "pause when another app is fullscreen/maximised" settings; add a VISION setting to pause on "maximised window" if Lively exposes it. |

## Results

_To be filled from the probe output (table per capability: supported / partial / not
supported, with the numbers), followed by the chosen fallback per row._

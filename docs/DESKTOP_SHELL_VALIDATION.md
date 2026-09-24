# Desktop-shell interaction validation (Windows + Lively)

**Status: tooling ready — NOT yet run.** The build container has no Windows/Lively, so
what Lively actually delivers is unknown until `tools/windows/run-desktop-probe.ps1`
runs on the target PC. The desktop shell is not implemented until the results are in.

## How to run (≈ 7 minutes)

1. Install/update the helper: `helper\install-helper.ps1` (the rebuilt exe adds the
   probe report endpoint and the shortcut test).
2. PowerShell: `tools\windows\run-desktop-probe.ps1`, then follow it:
   - **Part 1** — add `tools\desktop-probe\index.html` to Lively, apply it, reload once
     after pairing, and follow the 19 on-screen steps (answers by left click).
   - **Part 2** — 90 s global-shortcut test: press **Ctrl+Alt+Space** on the desktop, in a
     normal window and in a fullscreen game/video. (Ctrl+Space is tested only with
     `-IncludeCtrlSpace`.)
3. Send the folder it prints: `tools\windows\results\desktop-shell-<time>\`
   (`environment.json`, `desktop-probe-report.json`, `hotkey-probe.json`).
   If the report can't reach the helper, the probe shows it on screen — photograph it.
4. Re-apply VISION Orb in Lively.

## Agreed input policy (owner decisions)

- **Mouse-first.** Normal desktop use never requires the keyboard: click the orb for
  navigation (and search), hover wakes nearby nodes, click nodes to launch, click
  groups to open them.
- **Global search shortcut: Ctrl+Alt+Space** (registered with `RegisterHotKey`).
  **Ctrl+Space** is an optional, user-chosen setting and is **never registered by
  default** (IME/input-method and application conflicts).
- **Right-click** only if Lively delivers it reliably *and* Windows is not affected.
- **No global keyboard or mouse hooks**, ever. Fallbacks must be non-invasive.
- Nothing is marked "supported" unless it was tested inside Lively on Windows.

## What is measured

| # | Capability | How |
|---|---|---|
| 1 | Pointer movement on empty desktop, over desktop icons; event rate (Hz) | `pointermove` counts/intervals |
| 2 | Left click, double click, drag, **press-and-hold** (the menu fallback); whether Windows *also* reacts (selection rectangle, icon activation) | `pointerdown/up/click/dblclick`, hold durations + your answers |
| 3 | Mouse wheel, middle click | `wheel`, `pointerdown` button 1 |
| 4 | **Right click** on empty desktop: delivered? does the Windows desktop menu also open? — with icons visible and hidden | `pointerdown` button 2, `contextmenu`, your answers |
| 5 | **Keyboard**: Lively input = Mouse vs Keyboard; with desktop focused, with another window focused, with icons hidden; typed text and Ctrl+Space | `keydown` log |
| 6 | **Focus**: does clicking the desktop deactivate the previous window; page focus/blur | focus/blur events, `document.hasFocus()` sampling, your answer |
| 7 | **Desktop icons hidden**: do clicks/right-clicks/keys still reach the wallpaper | repeated steps |
| 8 | **Maximized / fullscreen / game**: Lively pause events, page visibility, frames rendered while paused/hidden | `livelyWallpaperPlaybackChanged`, `visibilitychange`, rAF counter |
| 9 | **Global shortcut**: can Ctrl+Alt+Space be registered (Ctrl+Space only on opt-in); which window was in front at each press; installed keyboard layouts | helper `--probe-hotkey` (`RegisterHotKey`) |
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
| Global shortcut from other apps | **Ctrl+Alt+Space** via `RegisterHotKey` (decided). Ctrl+Space only if the user selects it in Personalize. The shortcut is a convenience; search is always reachable from the orb. |
| Ctrl+Alt+Space registration fails (owned by another app) | Personalize shows "shortcut unavailable" and offers other combos; never forced, never hooked. Orb search unaffected. |

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

**Not run yet.** No capability below has been tested inside Lively on Windows, so none
is marked supported.

| Capability | Status | Measured value | Chosen behaviour |
|---|---|---|---|
| Mouse move on empty desktop / over icons | Not tested | — | pending |
| Left click / double click / drag | Not tested | — | pending |
| Press-and-hold | Not tested | — | pending |
| Wheel / middle click | Not tested | — | pending |
| Right click (icons visible / hidden), Windows menu interference | Not tested | — | pending |
| Keyboard: Mouse mode / Keyboard mode / other window focused / icons hidden | Not tested | — | pending |
| Focus behaviour | Not tested | — | pending |
| Clicks with desktop icons hidden | Not tested | — | pending |
| Maximized / fullscreen / game pause | Not tested | — | pending |
| Ctrl+Alt+Space registration and delivery | Not tested | — | pending |
| Lively property hook | Not tested (headless only) | — | pending |

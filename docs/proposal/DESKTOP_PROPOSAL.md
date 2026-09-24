# VISION Desktop — interaction proposal (for approval, not implemented)

Mockups: `rest.jpg`, `awake.jpg`, `launch.jpg`, `search.jpg`, `menu.jpg` in this folder.
Backgrounds are real renders of the current orb; overlays are illustrative HTML
(`mockup.html`). The orb, the neural filament system and 4D noise are kept unchanged.

## 1. Screen layout

```
                    TERMINAL                                   
         CHROME ·        \           ╭─────────╮          · STEAM
                  `·.     \        ╱   living    ╲      .·'
        FILES ·─────── ~ ~ ~ ~ ~ ~ ~   neural     ~ ~ ~ ~ ~ ~ ◇ GAMES ─┬─ Racing
                  .·'              ╲    orb      ╱               ├─ Strategy
         WORK ·'        DOWNLOADS    ╰─────────╯       `· PROJECTS └─ …
```

- **Centre:** the orb, same size and position as today (≈ 290 px radius at 1080p,
  slightly above centre).
- **Pinned nodes form a "constellation"** on two arcs left and right of the orb, never
  above or below it, so the orb's silhouette and rings stay clear. Ring 1 holds up to
  **8 nodes**; more items go into **groups** (diamond nodes) that open a small sub-arc.
- **Each node is tethered to the orb** by a thin living filament (same shader family
  as the orb's strands) with occasional pulses travelling along it. That is what makes
  nodes read as *part of the orb* rather than icons on a wallpaper.
- **No permanent HUD.** Removed: CPU/RAM/GPU/network gauges and the link-status line.
  Clock: off by default (the taskbar already shows it), optional tiny top-left clock in
  Personalize. The greeting appears only during the boot sequence, then fades.
- **Rest vs awake** (mockup A vs B): with no pointer activity for ~4 s, nodes dim to
  ~25 % and labels hide — the screen is just the orb and faint points of light. Moving
  the pointer toward the orb or a node wakes the constellation (proximity-based, eased).
- **Layout modes** (Personalize): *Constellation* (default, above), *Orbit* (the
  existing tilted 3D ring that expands from the orb on click), *Hidden* (nothing until
  the orb is clicked).

## 2. Node design

- Glass disc, thin gold rim, soft outer halo; label in spaced small caps below; a
  one-word kind (APP / FOLDER / FILE / URL / GROUP / ACTION) under that only when awake.
- **Icons:** the helper extracts each target's real Windows icon, and VISION renders it
  as a **theme-tinted luminous silhouette** at rest (so Chrome, Steam, a folder all share
  one visual language), switching to **true colour on hover**. Toggle in Personalize.
  No third-party logos are shipped; icons come from the user's own installed apps.
- Groups are diamond-shaped with a small count; folders/files/URLs use their own glyphs.
- Hover: node scales 1.1, rim brightens, its tether carries a pulse, the orb's nearby
  filaments brighten slightly (orb "notices" you).

## 3. Interactions

| Input | Where | Result |
|---|---|---|
| Move pointer | anywhere | Orb reacts (hover glow near it); constellation wakes near pointer |
| Click | node (app/file/folder/url/action) | **Launch** (below) |
| Click | group node | Group opens a sub-arc; click elsewhere/Esc closes |
| Click | orb | Opens **Search** (orb swells ~7 %, field appears beneath) |
| Drag | orb | Rotate orb (existing physics, momentum, idle return) |
| Double-click | orb | Reset view, close everything |
| Right-click | empty space | **Radial menu** at the pointer (mockup E) |
| Right-click | node | Node menu: Open · Open file location · Unpin · Move to group · Rename |
| Ctrl+Space (configurable) | anywhere, any app | Search (via helper global hotkey) |
| Esc | — | Close search/menu/group |

**Launch** (mockup C) — fast, animation never delays the app:

| t | What happens |
|---|---|
| 0 ms | Node highlights |
| ~80 ms | Launch request sent to the helper (in parallel with the animation) |
| 0–350 ms | Energy travels along the node's tether into the core |
| ~350 ms | Core flares (existing burst), returns to normal over ~1 s |

(Today's app ring waits 400 ms before sending; this halves it and runs the rest in
parallel with Windows starting the app.)

**Radial menu** (mockup E): Apps · Files · Folders · Search · Settings · Personalize ·
Refresh · Power. Power fans into Lock · Sleep · Restart · Shut down (Shut down/Restart
are **hold-to-confirm**, ~0.8 s ring fill). Apps = all installed apps as a scrollable
node arc; Files/Folders = pinned + (optional) recent; Settings = common Windows
Settings pages; Personalize = VISION's own settings sheet; Refresh = reload VISION and
re-index.

## 4. Search

- Opens from orb click or Ctrl+Space. Results appear **as nodes around the orb**
  (mockup D), best match brightest with a strong tether; ↑/↓/Tab cycle, Enter opens,
  Ctrl+P pins, Esc closes.
- Sources, all resolved **in the helper**, results in < 50 ms target:
  1. Installed apps — Start Menu shortcuts (all-users + per-user) and Store apps
     (AppsFolder).
  2. Pinned items and groups.
  3. Folders and files under **configured roots only** (default: Desktop, Documents,
     Downloads, Pictures, pinned folders), depth-limited, indexed in the background,
     in memory, never uploaded anywhere.
  4. Windows Settings pages (built-in list of `ms-settings:` targets: Display, Sound,
     Bluetooth, Wi-Fi, Printers, Apps, Personalization, Update…).
  5. Actions (Lock, Sleep, Restart, Refresh, Personalize…).
- Fuzzy/prefix ranking with a small boost for recently opened items.

## 5. Files, folders, favourites, recent

- **Explorer is not replaced.** Folders open in Explorer; files open in their default
  app — exactly as double-clicking them on the Windows desktop would.
- **Pinning** (no config editing needed):
  - Ctrl+P on any search result;
  - Explorer right-click **"Pin to VISION"** (per-user registry verb, no admin, no
    shell-extension DLL; it just calls `vision-helper --pin "<path>"`);
  - Personalize → Pins: reorder, group, rename, remove, add URL / custom shortcut.
  - Stored in `helper/pins.json` (the successor of `apps.json`, which is migrated).
- **Recent items:** **off by default**. When on, at most 5, drawn only in the search
  empty-state and the Files/Folders menu — never on the main screen. Source is Windows'
  own Recent list; executables/scripts are never shown.
- **Replacing desktop icons:** Personalize offers "Hide Windows desktop icons" (the
  same setting as Explorer's View → Show desktop icons), fully reversible.

## 6. Architecture changes

- **Wallpaper:** removes the gauge HUD; adds the constellation layer (DOM nodes +
  one merged WebGL draw for all tethers and their pulses), radial menu, search view,
  Personalize sheet. The stats view moves to a Diagnostics page inside Personalize
  (helper collects stats only while that page is open — already idle-suspending).
- **Helper → "VISION Shell service":**
  - `GET /items` (pins, groups), `GET /search?q=`, `POST /open/{id}`,
    `POST /pin`, `POST /action/{name}` (lock/sleep/restart/shutdown/refresh),
    icon extraction (cached PNG data URLs), global hotkey, event stream to the
    wallpaper (hotkey pressed, pins changed).
  - **Security model stays id-based:** the browser never sends a path or command.
    Pins have stable ids; search results get short-lived random ids (expire after
    60 s) that map to helper-side targets. Opening non-exe targets uses
    `ShellExecuteW` "open" (Explorer/default app) — still never `cmd.exe`/PowerShell.
    Files reached via search/recent with executable or script extensions
    (`.exe .msi .bat .cmd .ps1 .vbs .js .scr .com …`) are refused unless the user
    pinned them explicitly. URLs: `http(s)` only. Settings: allow-listed
    `ms-settings:` URIs only. Power actions require the hold-to-confirm gesture and a
    separate rate limit.
- **Performance:** +1 draw call for tethers, ≤ ~30 DOM nodes when awake, 0 when
  asleep beyond ~10 dim dots; idle 30 fps / pause behaviour unchanged. Search index
  capped (e.g. 50k entries) to keep the helper near its ≤ 20 MB target — measured
  before shipping.

## 7. Windows-only unknowns — must be proven first

The wallpaper lives *behind* Explorer's desktop window. Three things decide the design
of menu and search and cannot be verified from the build container:

| Question | If yes | If no |
|---|---|---|
| Does Lively forward **right-click** on empty desktop to the wallpaper? And does Explorer's own desktop context menu *also* open? | If only VISION's opens: use it directly | Helper installs a low-level mouse hook active **only over bare desktop** that swallows the right-click and shows VISION's menu; **Shift+right-click keeps the classic Windows menu** |
| Does Lively's **keyboard forwarding** (Settings → Wallpaper Input → Keyboard) deliver keys to the wallpaper while the desktop is focused? | Search field lives in the wallpaper; Ctrl+Space (helper hotkey) focuses the desktop then opens search | Helper opens a borderless, transparent, top-most **overlay window** (WebView2) aligned over the orb for search only; same web code, same look |
| With Windows desktop icons hidden, do clicks still reach the wallpaper everywhere? | Proceed | Adjust hit-testing / recommend keeping icons hidden via VISION toggle |

These go into an extended Phase 0 probe (`tools/phase0`, "desktop-shell" page) run in
Lively on the target PC **before** building the menu and search.

## 8. Proposed build order (after approval)

1. **Desktop-shell probe** on Windows (section 7) + the pending Windows perf validation.
2. Remove gauge HUD; pins model (`pins.json` + migration from `apps.json`); helper
   `ShellExecuteW` open, icon extraction; constellation layout with tethers; rest/awake;
   fast launch.
3. Groups; node right-click menu; radial desktop menu; Power actions; Personalize sheet
   (layout mode, pins, theme/quality, hotkey, clock, hide desktop icons, Diagnostics).
4. Search: helper index + ranking, hotkey, results-as-nodes (in wallpaper or overlay,
   per probe).
5. Recent (opt-in), "Pin to VISION" Explorer verb.
6. Full Windows validation again (perf, reboot, soak) with the new UI.

## 9. Decisions requested

1. Constellation as the default layout (Orbit and Hidden as options)?
2. Tinted-silhouette icons at rest, true colour on hover?
3. Right-click strategy if Lively can't own it: low-level hook over bare desktop with
   Shift+right-click for the Windows menu — acceptable?
4. Clock off by default?
5. Ring-1 capacity of 8 nodes (rest in groups)?

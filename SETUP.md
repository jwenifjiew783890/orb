# VISION Orb: Setup

This guide assumes no programming knowledge. It takes about five minutes.

You need:

- Windows 10 or 11
- this folder: download it and unzip it somewhere permanent, for example
  `C:\Users\<you>\VISION-Orb`
- an internet connection only for installing Lively (the wallpaper itself works offline)

---

## 1. Install Lively Wallpaper

Install **Lively Wallpaper** (free) from the Microsoft Store, or from
<https://www.rocksdanister.com/lively/>. Start it once.

## 2. Add the `wallpaper` folder to Lively

1. In Lively, click **+ (Add Wallpaper)**.
2. Choose **Browse** → select the file `VISION-Orb\wallpaper\index.html`
   (or drag the `wallpaper` folder onto the Lively window).
3. Click the new **VISION Orb** tile to set it as your wallpaper.

You should see the boot sequence: rings appear, the core ignites, **VISION ONLINE** types
and fades. The orb works right away. System stats and the app launcher start working
after step 4.

## 3. Turn on mouse input

In Lively: **Settings → Wallpaper → Wallpaper Input → Mouse**.

This lets the orb react when you hover over, drag, click or double-click it on the
desktop, wherever no icon or window is in the way.

## 4. Run the helper installer

The helper is a small background program (about 7–9 MB of memory in testing) that shows
CPU, RAM, GPU and network stats and opens the apps you choose. It only accepts
connections from your own PC, and it needs no administrator rights.

1. Open the folder `VISION-Orb\helper`.
2. Right-click **`install-helper.ps1`** → **Run with PowerShell**.
   - If Windows says scripts are disabled, open **PowerShell** and run:

     ```powershell
     cd "$env:USERPROFILE\VISION-Orb\helper"
     powershell -ExecutionPolicy Bypass -File .\install-helper.ps1
     ```

3. The installer does four things:
   - creates a secret random key for this PC
   - connects ("pairs") the wallpaper to the helper
   - makes the helper start when you log in, and restart if it ever stops
   - starts it
4. **Reload the wallpaper** so it picks up the pairing: in Lively, click another
   wallpaper, then click **VISION Orb** again.

The bottom of the screen now shows live **CPU · RAM · GPU · NETWORK** gauges.

> Run the installer again any time. It keeps your key and settings. Always run it again
> after re-adding the wallpaper to Lively.

## 5. Choose your apps: edit `helper\apps.json`

Click the orb to open the app ring. To change which apps appear, open
`helper\apps.json` in Notepad. Each app looks like this:

```json
{
  "id": "chrome",
  "label": "Chrome",
  "icon": null,
  "exe": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "hotkey": null
}
```

| Field | What to put there |
|---|---|
| `id` | A short unique name: lowercase letters, numbers, `-` or `_` (up to 32 characters). |
| `label` | The text shown under the icon (up to 24 characters). |
| `icon` | `null` shows a glowing letter. To use an image, put a PNG/ICO/SVG file in `helper\icons\` and write its file name, for example `"chrome.png"`. |
| `exe` | The **full path** to the program's `.exe`. Write every `\` twice (`\\`). You can use `%LOCALAPPDATA%`, `%APPDATA%`, `%PROGRAMFILES%`, `%USERPROFILE%` or `%WINDIR%`. |
| `args` | *(optional)* A fixed list of extra arguments, for example `["ms-settings:"]`. |
| `hotkey` | Reserved; leave `null`. |

**Tips:**

- **Finding an exe path:** right-click a Start-menu app → **Open file location**, then
  right-click the shortcut → **Properties** → the **Target** box.
- **Store apps:** use Explorer with the app's shell address, for example:

  ```json
  { "id": "photos", "label": "Photos", "exe": "%WINDIR%\\explorer.exe", "args": ["shell:AppsFolder\\Microsoft.Windows.Photos_8wekyb3d8bbwe!App"] }
  ```

- **Limits:** up to 12 apps. Only `.exe` files can be launched. Shortcuts (`.lnk`) and
  scripts (`.bat`/`.cmd`) are refused for security.
- **Saving:** changes apply automatically within a few seconds, with no restart. To check
  your file, run `helper\bin\vision-helper.exe --check-apps` from PowerShell.

---

## Everyday use

| Action | What happens |
|---|---|
| Hover over the orb | It brightens, pulses speed up, and the rings accelerate |
| Drag | Rotates the orb, with momentum. After about 3 s it drifts back on its own. |
| Scroll | Gentle, limited zoom |
| Click the orb | Opens the app ring |
| Click an app | Energy flows into the core and the app opens |
| Click empty space | Closes the ring |
| Double-click the orb | Resets the view and closes the ring |

When a game or any fullscreen app covers the desktop, Lively pauses the wallpaper, and
VISION stops drawing completely.

## Changing settings

In Lively, click the **VISION Orb** tile's **⋯ → Customise**:

| Setting | Options |
|---|---|
| **Theme** | Gold (default), Arc Blue, Crimson, or Custom (then pick **Custom colour**) |
| **Rotation speed**, **Bloom strength**, **Particle density** | Sliders |
| **Quality** | Low / Medium / High. Use Low on laptops or older graphics cards. |
| **Auto-reduce quality** | On by default. VISION steps quality down if your PC can't keep up. |
| **Audio reactive** | Makes the orb respond gently to music playing on your PC. Off by default. It never uses a microphone or webcam. **One-time step:** right-click `tools\windows\enable-audio.ps1` → Run with PowerShell, then reload the wallpaper. This turns on Lively's audio feed, which VISION leaves off by default because it costs a little CPU all the time. Undo it with `enable-audio.ps1 -Disable`. |
| **HUD stats** | Shows or hides the gauges at the bottom |
| **Name for greeting** | Changes "Good morning, …" |
| **Debug overlay** | Shows technical numbers (FPS, draw calls). For troubleshooting only. |

## Turning the helper off

- **Stop it from starting with Windows, but keep it installed:** open **Task Scheduler**
  → **Task Scheduler Library** → right-click **VISION Helper** → **Disable**. Choose
  **Enable** later to turn it back on. Or run in PowerShell:
  `Disable-ScheduledTask -TaskName "VISION Helper"`
- **Uninstall it completely:** right-click `helper\uninstall-helper.ps1` → **Run with
  PowerShell**. This removes the startup task, stops the helper, unpairs the wallpaper and
  deletes the secret key. Add `-KeepConfig` to keep the key for a later reinstall. The orb
  keeps working without the helper; only the stats and the app ring go quiet.

## Troubleshooting

**"STATS OFFLINE"** (the gauges are dim). The wallpaper can't reach the helper.

1. Wait 10–15 seconds. The wallpaper reconnects on its own.
2. Check the helper is running: Task Manager → **Details** → `vision-helper.exe`. If it
   isn't, open Task Scheduler, right-click **VISION Helper** → **Run**. The watchdog also
   restarts it within 5 minutes.
3. Still offline? Run `install-helper.ps1` again and reload the wallpaper.
4. Look at `helper\config\helper.log` for the reason (for example, "listen failed" if
   another program took port 47821). To change the port, edit `"port"` in
   `helper\config\config.json`, run the installer again, and set the same number in
   Customise → **Helper port**.

**"SYSTEM LINK UNPAIRED".** The wallpaper doesn't have the helper's key. Usually the
wallpaper was added to Lively *after* the installer ran.

- Fix: run `install-helper.ps1` again, then reload the wallpaper.
- Manual fallback: copy the `"token"` value from `helper\config\config.json` into
  Customise → **Helper token**.

**An app doesn't open ("LAUNCH FAILED · APP_UNAVAILABLE").** The `exe` path in
`apps.json` is wrong or the program isn't installed. Run
`helper\bin\vision-helper.exe --check-apps` to see which paths are missing.

**The orb is choppy or the PC runs hot.** Set Quality to **Low** and keep
**Auto-reduce quality** on. Check that Lively's performance settings pause wallpapers
when other apps are fullscreen.

**The orb doesn't react to the mouse.** Enable Lively → Settings → Wallpaper → Wallpaper
Input → **Mouse** (step 3). The orb only receives the mouse where no icon or window
covers it.

**The screen is black.** Your graphics driver may have reset. VISION recovers by itself;
if it doesn't within a few seconds, reload the wallpaper in Lively. Updating your
graphics driver helps.

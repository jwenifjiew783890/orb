# Test Results

Run everything with `tests/run-all.sh`. The results below are from the build container:
Linux, Chromium 141 headless on SwiftShader, Go 1.24. Items that need Windows or Lively
are listed in §6 with their procedure in `WINDOWS_TEST_PLAN.md`.

## 1. Helper unit tests (Go): 20/20 pass

`cd helper/service && go test ./...`. These tests are also compiled for `GOOS=windows`,
and `go vet` passes for both linux and windows.

| Test | Covers |
|---|---|
| TestTokenIsRandom64Hex | 256-bit `crypto/rand` token, 64 lowercase hex characters, unique per run |
| TestInitKeepsTokenUnlessRotated | `--init` is idempotent, `--rotate-token` replaces the token, config file is 0600 |
| TestConfigRejectsBadValues | short or uppercase token, port < 1024, unknown field (e.g. `"bind"`), non-JSON rejected; UTF-8 BOM accepted |
| TestSecurityMatrix | 26 request cases (below): status, code, and no path or token in any response |
| TestLaunchViaBodyOnly | `POST /launch` with `{"app_id":…}` |
| TestStatsAndAppsEndpoints | payload shape; CORS for origin `null`; `/apps` never exposes exe, args or paths |
| TestPreflight | CORS + Private Network Access preflight; foreign origin → 403 |
| TestRateLimits | launch burst 3 then 429; repeated bad tokens throttled |
| TestBucketRefills | token-bucket refill arithmetic |
| TestAppValidation | uppercase, space or `../` ids; relative, UNC (`\\`, `//`), `..`, NUL, >16 args, newline args, `%COMSPEC%`, relative cwd; on Windows also `.bat` and `.lnk` |
| TestEnvExpansionWhitelist | `%LOCALAPPDATA%` expands, `%PATH%` is refused |
| TestLoadAppsSkipsInvalidAndLimits | invalid, typo'd and duplicate entries skipped with warnings; max 12 apps; malformed file rejected |
| TestRegistryHotReload | edits to apps.json apply; removed apps become unlaunchable |
| TestIconLoadingIsConfined | `../`, `..\`, absolute and `.exe` icon names refused |
| TestWriteTokenJSOnlyIntoVisionWallpaper | pairing writes only into a folder whose LivelyInfo title is "VISION Orb"; clearing removes the token |
| TestStatsCacheNeverCollectsPerRequest | 1,000 requests → 1 collection |
| TestStatsCacheIdlesWithoutRequests | collection stops when nobody polls and resumes on the next request |
| TestRealCollector | real OS collector returns plausible CPU and RAM |
| TestLauncherNeverUsesShell | exe run directly; `&`, `\|` and spaces passed as literal argv; missing exe → `app_unavailable` |
| TestHTTPServerBindsLoopbackOnly | listener address is `127.0.0.1:*`; timeouts set |

`TestSecurityMatrix` covers: no token, wrong token, wrong-length token, token in the query
string, unknown id, raw exe path (URL-encoded and with slashes), path traversal, raw path
in the body, `exe` or `args` fields in the body, shell command id, `&` in the id, shell
command in the body, query args, malformed JSON, JSON array, trailing JSON, body/path
mismatch, oversized body, GET on `/launch`, foreign Host (DNS rebinding), foreign Origin,
unknown route, missing exe, and a valid id.

## 2. Security matrix against the real binary (brief §53): 13/13 pass

`node --test tests/helper-security/*.test.mjs` builds the helper, runs it with a fresh
random token, and sends real HTTP requests.

| Case | Expected | Result |
|---|---|---|
| no token | reject | **PASS** 401 unauthorized |
| wrong token | reject | **PASS** 401 unauthorized |
| unknown app ID | reject | **PASS** 404 unknown_app |
| raw executable path (URL) | reject | **PASS** 400 invalid_id |
| raw path in body | reject | **PASS** 400 invalid_id |
| shell command (URL) | reject | **PASS** 400 invalid_id |
| shell command in body | reject | **PASS** 400 invalid_id |
| extra args in body | reject | **PASS** 400 malformed_request |
| malformed JSON | reject | **PASS** 400 malformed_request |
| foreign Origin | reject | **PASS** 403 bad_origin |
| DNS-rebinding Host header | reject | **PASS** 421 bad_host |
| reachable from non-loopback interfaces | no | **PASS** connection refused |
| valid whitelisted ID | launch | **PASS** 200 launched; the exe ran with only its configured args |

The file also checks that no response contains the token or a filesystem path, and that
the stats payload has the expected shape.

## 3. Launch tests: 5/5 pass

`node --test tests/launch/*.test.mjs`:

- literal args with no shell interpretation: `x y`, `&&` and `$(id)` arrive verbatim
- missing exe → 422 app_unavailable
- a launched app outlives the helper
- apps.json edits apply without restart
- launch rate limit (3 allowed, then 429)

## 4. Wallpaper behaviour: 10/10 pass

`node --test tests/integration/wallpaper.test.mjs` loads the built wallpaper from
`file://`, as Lively does.

| Test | Result |
|---|---|
| Boot types "VISION ONLINE", fades it, and every layer finishes revealing | PASS |
| Scheduler: idle **30.0 fps**, hover **60.0 fps**, idle again **30.0 fps** | PASS |
| Lively `IsPaused:true` → 0 frames, rAF stopped, state PAUSED; resume restores | PASS |
| Page hidden → 0 frames; visible restores | PASS |
| `WEBGL_lose_context`: lose → 0 fps; restore → frames resume, centre pixel lit, no reload | PASS |
| Lively properties live: theme, custom colour, quality (4,000 / 1,500 strands), HUD off → helper polling disabled, debug overlay (orb draw calls < 20) | PASS |
| Audio: ignored when off, responds when on, back to 0 when off; `getUserMedia` and `enumerateDevices` called **0** times | PASS |
| Click opens the ring; empty click closes; drag → DRAG state and camera moves; double-click returns the camera home (< 0.05) with the ring closed | PASS |
| Zoom stays inside [0.77, 1.31] × home distance after 30 wheel steps each way | PASS |
| Zero console errors or warnings | PASS |

## 5. Wallpaper ↔ helper end to end: 4/4 pass

`node --test tests/integration/wallpaper-helper.test.mjs`:

- `--write-token-js` pairing works, the HUD shows live stats, and the offline indicator
  is hidden
- the app ring lists the helper's apps; clicking **Notes** launched the real process
- `SIGKILL` the helper → HUD shows "STATS OFFLINE" within seconds; the orb keeps
  rendering (frame counter advancing); restart the helper → reconnects automatically and
  the indicator clears
- no console errors or warnings

**Phase 0 probe** (`tests/integration/phase0.probe.mjs`): all checks pass, with local
`fetch` blocked as expected (see DECISIONS.md §0).

## 6. Not run here: needs Windows, Lively and a GPU

| Item | Procedure |
|---|---|
| Phase 0 inside Lively (WebView2) + WebGPU benchmark | WINDOWS_TEST_PLAN §1 |
| CPU/GPU/RAM idle, interaction, paused | §2 |
| Helper on Windows (PDH stats accuracy, RAM) | §3 |
| Task Scheduler watchdog, duplicate prevention, app outlives the task | §4 |
| Reboot | §5 |
| Game impact | §6 |
| 24-hour soak | §7 |

## Acceptance criteria status

Status key:

- ✅ **verified here**
- 🟨 **implemented, needs Windows or Lively confirmation**
- ⬜ **pending measurement**

**Orb**

- ✅ Looks organic rather than geometric (screenshots)
- ✅ 1,500–4,000 filaments scaling by quality
- ✅ Core visually dominant
- ✅ Pulses travel through the network
- ✅ Continuously alive
- ✅ Auto-rotates
- ✅ Drag with momentum
- ✅ Returns to idle smoothly

**Interaction**

- ✅ Hover increases activity
- ✅ Click opens the ring
- ✅ Nodes animate
- ✅ Node launches the correct app (by id; the real process is started in the E2E test)
- ✅ Double-click resets
- ✅ Empty click closes

**Helper**

- ✅ localhost only
- ✅ Token required
- ✅ Random token at install
- ✅ Whitelist enforced
- ✅ Arbitrary paths rejected
- ✅ Arbitrary commands rejected
- ✅ Reconnects after failure
- 🟨 Watchdog restarts the helper (Task Scheduler config written; confirm on Windows)

**Performance**

- ⬜ Idle ≤ 3% CPU
- ⬜ Idle ≤ 10% GPU
- ✅ Idle 30 fps (pacing)
- ✅ Interaction 60 fps (pacing; real-GPU fps ⬜)
- ✅ Paused rendering stops
- ⬜ Wallpaper RAM ≤ 200 MB
- ✅ Helper RAM ≤ 20 MB (Linux; Windows ⬜)
- ⬜ No game FPS degradation

**Stability**

- ✅ No console errors
- ✅ No console warnings
- ✅ Context recovery
- ✅ Helper crash recovery
- ⬜ 24-hour soak (10- and 20-minute container soaks: heap plateaus at ~3.7 MB, helper ~8.8 MB, no leak found in a heap diff)
- ⬜ Reboot

**Settings**

- ✅ Gold
- ✅ Blue
- ✅ Crimson
- ✅ Custom
- ✅ Quality switching
- ✅ HUD toggle
- ✅ Audio toggle
- ✅ Debug overlay

**Documentation**

- ✅ README
- ✅ SETUP
- ✅ DECISIONS
- ✅ PERF_REPORT (Windows sections pending)
- ✅ MIT credit
- ✅ Screenshots

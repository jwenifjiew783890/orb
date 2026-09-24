# Helper configuration (private)

`config.json` is created by `install-helper.ps1` (via `vision-helper.exe --init`)
and contains the random API token. It is **not** committed to git and should
not be shared. `helper.log` is also written here (capped at 1 MB).

Fields: `port` (default 47821), `token` (64 hex chars, generated), `allowedOrigins`
(default `["null","file://"]` — the Lively wallpaper's origin), `appsFile`,
`iconsDir`, `statsIntervalMs` (≥ 1000).

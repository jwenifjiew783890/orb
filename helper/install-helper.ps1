<#
.SYNOPSIS
  Installs the VISION Helper for the current user (no administrator rights needed).

.DESCRIPTION
  1. Creates helper\config\config.json with a cryptographically random token
     (kept if it already exists; use -RotateToken for a new one).
  2. Pairs every copy of the VISION Orb wallpaper it can find (this repo's
     wallpaper folder and Lively's library folders) by writing token.js.
  3. Registers the "VISION Helper" scheduled task:
       - starts at logon, runs hidden, as you (limited rights)
       - restarts automatically if it exits with an error (every 1 min)
       - watchdog trigger every 5 minutes: if the helper crashed it is started
         again; if it is running, the new start is ignored (no duplicates —
         the helper also holds a single-instance mutex)
  4. Starts the helper and checks that it answers on 127.0.0.1.

  Re-run this script at any time (for example after adding the wallpaper to
  Lively again). It is idempotent.
#>
[CmdletBinding()]
param(
  [switch]$RotateToken,
  [string[]]$WallpaperDir = @()
)

$ErrorActionPreference = 'Stop'
$TaskName = 'VISION Helper'
$HelperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $HelperDir 'bin\vision-helper.exe'
$ConfigPath = Join-Path $HelperDir 'config\config.json'
$RepoWallpaper = Join-Path (Split-Path -Parent $HelperDir) 'wallpaper'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

Say ''
Say '  VISION Helper installer' 'Yellow'
Say '  -----------------------' 'Yellow'

if (-not (Test-Path $Exe)) { throw "vision-helper.exe not found at $Exe" }

# Stop a running helper so files can be updated.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
Get-Process -Name 'vision-helper' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $Exe } | Stop-Process -Force -ErrorAction SilentlyContinue

# 1. Config + token
$initArgs = @('--init', '--config', $ConfigPath)
if ($RotateToken) { $initArgs += '--rotate-token' }
& $Exe @initArgs | ForEach-Object { Say "  $_" }
if ($LASTEXITCODE -ne 0) { throw 'Could not create the helper configuration.' }

# Restrict config folder to the current user (token is secret).
try {
  $cfgDir = Split-Path -Parent $ConfigPath
  icacls $cfgDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F" | Out-Null
} catch { Say "  (could not tighten config folder permissions: $_)" 'DarkYellow' }

if (-not (Test-Path (Join-Path $HelperDir 'apps.json'))) {
  Copy-Item (Join-Path $HelperDir 'apps.example.json') (Join-Path $HelperDir 'apps.json')
  Say '  created helper\apps.json from the example'
}

# 2. Pair wallpaper copies
function Find-WallpaperDirs {
  $dirs = New-Object System.Collections.Generic.List[string]
  if (Test-Path (Join-Path $RepoWallpaper 'LivelyInfo.json')) { $dirs.Add($RepoWallpaper) }
  $libs = @(
    (Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Library\wallpapers')
  )
  Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter '*LivelyWallpaper*' -ErrorAction SilentlyContinue |
    ForEach-Object { $libs += (Join-Path $_.FullName 'LocalCache\Local\Lively Wallpaper\Library\wallpapers') }
  # Custom library location from Lively's settings, if any.
  foreach ($settings in @(
      (Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Settings.json')) + (
      Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter '*LivelyWallpaper*' -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'LocalCache\Local\Lively Wallpaper\Settings.json' })) {
    if (Test-Path $settings) {
      try {
        $s = Get-Content $settings -Raw | ConvertFrom-Json
        if ($s.WallpaperDir) { $libs += (Join-Path $s.WallpaperDir 'wallpapers') }
      } catch { }
    }
  }
  foreach ($lib in ($libs | Select-Object -Unique)) {
    if (-not (Test-Path $lib)) { continue }
    Get-ChildItem $lib -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $info = Join-Path $_.FullName 'LivelyInfo.json'
      if (Test-Path $info) {
        try {
          if ((Get-Content $info -Raw | ConvertFrom-Json).Title -eq 'VISION Orb') { $dirs.Add($_.FullName) }
        } catch { }
      }
    }
  }
  $dirs + $WallpaperDir | Select-Object -Unique
}

$targets = @(Find-WallpaperDirs)
if ($targets.Count -gt 0) {
  $pairArgs = @('--config', $ConfigPath)
  foreach ($d in $targets) { $pairArgs += @('--write-token-js', $d) }
  & $Exe @pairArgs | ForEach-Object { Say "  $_" }
} else {
  Say '  No VISION Orb wallpaper found yet. Add it to Lively, then run this script again.' 'DarkYellow'
}
$lively = @($targets | Where-Object { $_ -ne $RepoWallpaper })
if ($lively.Count -eq 0) {
  Say '  Note: the wallpaper was not found in Lively''s library. If the HUD shows' 'DarkYellow'
  Say '  "SYSTEM LINK UNPAIRED", run this script again after adding it to Lively.' 'DarkYellow'
}

# 3. Scheduled task (current user, no admin)
$action = New-ScheduledTaskAction -Execute $Exe -Argument ('--config "{0}"' -f $ConfigPath) -WorkingDirectory $HelperDir
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
try {
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
} catch {
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
}
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -Priority 7
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger @($logon, $watchdog) -Settings $settings -Principal $principal `
  -Description 'VISION Orb helper: local system stats and whitelisted app launching for the wallpaper (127.0.0.1 only).'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Say "  scheduled task '$TaskName' registered (logon + watchdog)" 'Green'

# 4. Start and verify
Start-ScheduledTask -TaskName $TaskName
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $cfg.port) -Headers @{ 'X-Vision-Token' = $cfg.token } -TimeoutSec 2
    $ok = $r.ok
  } catch { }
}
if ($ok) {
  Say ("  helper is running on 127.0.0.1:{0}" -f $cfg.port) 'Green'
} else {
  Say '  helper did not answer yet - see helper\config\helper.log' 'Red'
}
& $Exe --config $ConfigPath --check-apps | ForEach-Object { Say "  $_" }
Say ''
Say '  Done. In Lively, reload the wallpaper (switch to another wallpaper and back)' 'Yellow'
Say '  so it picks up the pairing. Edit helper\apps.json to choose your apps.' 'Yellow'
Say ''

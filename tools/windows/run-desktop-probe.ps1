<#
.SYNOPSIS
  Runs the VISION desktop-interaction validation on this PC and collects the
  results in one folder.

.DESCRIPTION
  Part 1 - Lively wallpaper probe (tools\desktop-probe): a guided on-screen test
           of mouse, right-click, keyboard, focus, hidden desktop icons,
           maximized/fullscreen pause. Its report is saved by the helper.
  Part 2 - Global shortcut test: the helper registers Ctrl+Alt+Space (the
           default VISION search shortcut; Ctrl+Space only with -IncludeCtrlSpace)
           with RegisterHotKey (the normal Windows API for app
           shortcuts; NOT an input hook) for 90 seconds and records which
           window was in front at each press, plus installed keyboard layouts.

  Requirements: VISION helper installed (helper\install-helper.ps1) and Lively.
  Nothing is changed permanently. Re-apply the VISION Orb wallpaper afterwards.
#>
[CmdletBinding()]
param([int]$HotkeySeconds = 90, [switch]$IncludeCtrlSpace)

$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot)
$exe = Join-Path $repo 'helper\bin\vision-helper.exe'
$cfgPath = Join-Path $repo 'helper\config\config.json'
$cfgDir = Split-Path $cfgPath
$probeDir = Join-Path $repo 'tools\desktop-probe'
$outDir = Join-Path $PSScriptRoot ("results\desktop-shell-{0:yyyyMMdd-HHmmss}" -f (Get-Date))

function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Yellow }
function Wait-Enter($t) { Read-Host "   $t  [Enter]" | Out-Null }

if (-not (Test-Path $cfgPath)) { throw 'The VISION helper is not installed. Run helper\install-helper.ps1 first.' }
if (-not (Get-Process -Name 'vision-helper' -ErrorAction SilentlyContinue)) {
  Start-ScheduledTask -TaskName 'VISION Helper' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$lively = Get-Process | Where-Object { $_.ProcessName -like 'Lively*' } | Select-Object -First 1
$sysInfo = [ordered]@{
  when = (Get-Date).ToString('s')
  os = (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + [Environment]::OSVersion.Version
  gpu = (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join '; '
  livelyProcess = if ($lively) { $lively.ProcessName } else { 'not running' }
  livelyVersion = if ($lively -and $lively.Path) { (Get-Item $lively.Path).VersionInfo.ProductVersion } else { '' }
  monitors = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue).Count
}
$sysInfo | ConvertTo-Json | Set-Content (Join-Path $outDir 'environment.json') -Encoding UTF8

# ---------------------------------------------------------------- part 1
Step 'Part 1 - Lively wallpaper probe'
Write-Host "   1. In Lively: + (Add Wallpaper) -> Browse -> $probeDir\index.html"
Write-Host '   2. Apply "VISION Desktop Probe" as the wallpaper.'
Write-Host '   3. Lively -> Settings -> Wallpaper -> Wallpaper Input -> Mouse.'
Wait-Enter 'Done?'

# Pair every copy of the probe (repo folder + Lively library copies).
$dirs = @($probeDir)
$libs = @(Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Library\wallpapers')
Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter '*LivelyWallpaper*' -ErrorAction SilentlyContinue |
  ForEach-Object { $libs += (Join-Path $_.FullName 'LocalCache\Local\Lively Wallpaper\Library\wallpapers') }
foreach ($lib in $libs) {
  if (-not (Test-Path $lib)) { continue }
  Get-ChildItem $lib -Directory | ForEach-Object {
    $info = Join-Path $_.FullName 'LivelyInfo.json'
    if ((Test-Path $info) -and ((Get-Content $info -Raw | ConvertFrom-Json).Title -eq 'VISION Desktop Probe')) { $dirs += $_.FullName }
  }
}
$pairArgs = @('--config', $cfgPath)
foreach ($d in $dirs) { $pairArgs += @('--write-token-js', $d) }
& $exe @pairArgs 2>&1 | ForEach-Object { Write-Host "   $_" }
if ($dirs.Count -lt 2) { Write-Host '   (The Lively library copy was not found; the report may not reach the helper. The probe will still show it on screen.)' -ForegroundColor DarkYellow }

Write-Host ''
Write-Host '   4. Reload the probe so it picks up the pairing: in Lively pick another wallpaper, then "VISION Desktop Probe" again.'
Write-Host '   5. Follow the on-screen steps on your desktop (19 steps, about 5 minutes).'
Write-Host '      Answer the questions with left clicks. The last screen says "Report saved".'
$report = Join-Path $cfgDir 'desktop-probe-report.json'
$startTime = Get-Date
Write-Host '   Waiting for the report...' -NoNewline
while (-not ((Test-Path $report) -and ((Get-Item $report).LastWriteTime -gt $startTime))) {
  Start-Sleep -Seconds 2
  Write-Host '.' -NoNewline
  if ([Console]::KeyAvailable) {
    $k = [Console]::ReadKey($true)
    if ($k.Key -eq 'S') { Write-Host ' skipped (photograph the probe screen instead)'; break }
  }
}
if (Test-Path $report) { Copy-Item $report $outDir; Write-Host ' saved.' -ForegroundColor Green }

# ---------------------------------------------------------------- part 2
Step "Part 2 - Global shortcut test ($HotkeySeconds s)"
Write-Host '   Put Lively Wallpaper Input back to what you prefer. During the next seconds press Ctrl+Alt+Space:'
Write-Host '     a) with the DESKTOP focused (click empty desktop first)'
Write-Host '     b) inside a normal window (Explorer, browser)'
Write-Host '     c) inside a fullscreen game or video, if you can'
if ($IncludeCtrlSpace) { Write-Host '     d) and Ctrl+Space once in each of those places (opt-in test)' }
Wait-Enter 'Ready to start the timer?'
$hkArgs = @('--config', "`"$cfgPath`"", '--probe-hotkey', $HotkeySeconds)
if ($IncludeCtrlSpace) { $hkArgs += '--probe-ctrl-space' }
$p = Start-Process -FilePath $exe -ArgumentList $hkArgs -PassThru
Write-Host "   Recording for $HotkeySeconds s..."
$p.WaitForExit()
$hk = Join-Path $cfgDir 'hotkey-probe.json'
if (Test-Path $hk) {
  Copy-Item $hk $outDir
  $j = Get-Content $hk -Raw | ConvertFrom-Json
  foreach ($c in $j.combos) { Write-Host ("   {0,-15} registered: {1} {2}" -f $c.name, $c.registered, $c.error) }
  Write-Host ("   presses recorded: {0}" -f @($j.presses).Count)
  foreach ($pr in $j.presses) { Write-Host ("     {0,-15} at {1,6:N1}s  foreground: {2}" -f $pr.combo, $pr.atSeconds, $pr.foregroundClass) }
  Write-Host ("   keyboard layouts: {0}" -f ($j.keyboardLayouts -join ', '))
}

Step 'Done'
Write-Host "   Results: $outDir" -ForegroundColor Green
Write-Host '   Send the files in that folder (environment.json, desktop-probe-report.json, hotkey-probe.json).'
Write-Host '   Then re-apply the VISION Orb wallpaper in Lively.'

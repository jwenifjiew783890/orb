<#
.SYNOPSIS
  Turns Lively's system-audio feed on (or off with -Disable) for VISION Orb.

.DESCRIPTION
  Lively only sends audio data to a web wallpaper whose LivelyInfo.json has
  "--audio true" in "Arguments". VISION Orb ships without it, because the feed
  costs a little CPU all the time even when Audio reactive is switched off.
  This script edits every VISION Orb copy Lively has (and the repo copy).
  Afterwards, reload the wallpaper in Lively and switch on
  Customise -> Audio reactive. No microphone or webcam is ever used: Lively
  captures what your speakers play.
#>
[CmdletBinding()]
param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot)
$dirs = @(Join-Path $repo 'wallpaper')
$libs = @(Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Library\wallpapers')
Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter '*LivelyWallpaper*' -ErrorAction SilentlyContinue |
  ForEach-Object { $libs += (Join-Path $_.FullName 'LocalCache\Local\Lively Wallpaper\Library\wallpapers') }
foreach ($lib in $libs) {
  if (Test-Path $lib) { Get-ChildItem $lib -Directory | ForEach-Object { $dirs += $_.FullName } }
}
$n = 0
foreach ($d in $dirs) {
  $f = Join-Path $d 'LivelyInfo.json'
  if (-not (Test-Path $f)) { continue }
  $j = Get-Content $f -Raw | ConvertFrom-Json
  if ($j.Title -ne 'VISION Orb') { continue }
  $args2 = ($j.Arguments -replace '\s*--audio\s+true', '').Trim()
  if (-not $Disable) { $args2 = ($args2 + ' --audio true').Trim() }
  $j.Arguments = $args2
  $j | ConvertTo-Json -Depth 4 | Set-Content -Path $f -Encoding UTF8
  Write-Host "  updated $f"
  $n++
}
if ($n -eq 0) { Write-Host '  No VISION Orb wallpaper found.' -ForegroundColor Yellow }
else { Write-Host '  Done. Reload the wallpaper in Lively (pick another wallpaper, then VISION Orb again).' -ForegroundColor Green }

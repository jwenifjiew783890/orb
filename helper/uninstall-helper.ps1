<#
.SYNOPSIS
  Removes the VISION Helper scheduled task, stops the helper and unpairs the
  wallpaper. Use -KeepConfig to keep the token/config for a later reinstall.
#>
[CmdletBinding()]
param([switch]$KeepConfig)

$ErrorActionPreference = 'Continue'
$TaskName = 'VISION Helper'
$HelperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $HelperDir 'bin\vision-helper.exe'
$ConfigPath = Join-Path $HelperDir 'config\config.json'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  removed scheduled task '$TaskName'" -ForegroundColor Green
}
Get-Process -Name 'vision-helper' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
Write-Host '  helper stopped'

# Unpair wallpaper copies (token.js → empty stub)
if (Test-Path $ConfigPath) {
  $dirs = @()
  $repoWp = Join-Path (Split-Path -Parent $HelperDir) 'wallpaper'
  if (Test-Path (Join-Path $repoWp 'token.js')) { $dirs += $repoWp }
  $libs = @(Join-Path $env:LOCALAPPDATA 'Lively Wallpaper\Library\wallpapers')
  Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter '*LivelyWallpaper*' -ErrorAction SilentlyContinue |
    ForEach-Object { $libs += (Join-Path $_.FullName 'LocalCache\Local\Lively Wallpaper\Library\wallpapers') }
  foreach ($lib in $libs) {
    if (Test-Path $lib) {
      Get-ChildItem $lib -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'token.js') } | ForEach-Object { $dirs += $_.FullName }
    }
  }
  $clearArgs = @('--config', $ConfigPath)
  foreach ($d in $dirs) { $clearArgs += @('--clear-token-js', $d) }
  if ($dirs.Count -gt 0) { & $Exe @clearArgs 2>$null | ForEach-Object { Write-Host "  $_" } }
}

if (-not $KeepConfig -and (Test-Path $ConfigPath)) {
  Remove-Item $ConfigPath -Force
  Write-Host '  deleted helper\config\config.json (token)'
}
Write-Host '  VISION Helper uninstalled. The wallpaper keeps working without stats/app launching.' -ForegroundColor Yellow

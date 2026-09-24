<#
.SYNOPSIS
  Measures VISION Orb resource usage on Windows (for PERF_REPORT.md).

.DESCRIPTION
  Samples, every -IntervalSec seconds for -DurationSec seconds:
    - wallpaper CPU %  (all processes in the Lively tree: Lively*, msedgewebview2)
    - wallpaper GPU %  (GPU Engine 3D utilisation of those processes)
    - wallpaper RAM    (private bytes, MB)
    - helper CPU %, RAM (private bytes and working set, MB)
    - helper link      (GET /health with the configured token)
  Writes a CSV and prints a summary (mean / p95 / max).

  CPU % is normalised to the whole machine (100 % = all logical cores), like
  Task Manager's Processes tab. FPS is not visible from outside the page: read
  it from the wallpaper's Debug Overlay, or measure presents with PresentMon.

.EXAMPLE
  # idle: leave the desktop visible, don't touch the mouse
  .\perf-sample.ps1 -Label idle -DurationSec 120

  # interaction: keep moving/dragging over the orb while it samples
  .\perf-sample.ps1 -Label interaction -DurationSec 60

  # paused: open a fullscreen app/game over the wallpaper
  .\perf-sample.ps1 -Label paused -DurationSec 120

  # 24-hour soak, one sample per 10 minutes
  .\perf-sample.ps1 -Label soak -DurationSec 86400 -IntervalSec 600
#>
[CmdletBinding()]
param(
  [string]$Label = 'sample',
  [int]$DurationSec = 60,
  [int]$IntervalSec = 2,
  [string]$OutDir = (Join-Path $PSScriptRoot 'results')
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$csv = Join-Path $OutDir ("{0}-{1:yyyyMMdd-HHmmss}.csv" -f $Label, (Get-Date))
$cores = [Environment]::ProcessorCount
$helperCfg = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'helper\config\config.json'
$cfg = if (Test-Path $helperCfg) { Get-Content $helperCfg -Raw | ConvertFrom-Json } else { $null }

function Get-LivelyTree {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  $byParent = @{}
  foreach ($p in $all) { $byParent[[int]$p.ParentProcessId] += @($p) }
  $roots = $all | Where-Object { $_.Name -like 'Lively*' }
  $ids = New-Object System.Collections.Generic.HashSet[int]
  $stack = New-Object System.Collections.Stack
  foreach ($r in $roots) { $stack.Push($r) }
  while ($stack.Count) {
    $p = $stack.Pop()
    if ($ids.Add([int]$p.ProcessId)) { foreach ($c in @($byParent[[int]$p.ProcessId])) { if ($c) { $stack.Push($c) } } }
  }
  return $ids
}

function Get-CpuTimes([int[]]$ids) {
  $t = @{}
  foreach ($id in $ids) {
    try { $p = Get-Process -Id $id -ErrorAction Stop; $t[$id] = $p.TotalProcessorTime.TotalMilliseconds } catch { }
  }
  return $t
}

function Get-GpuPercent([int[]]$ids) {
  if (-not $ids -or $ids.Count -eq 0) { return 0 }
  try {
    $samples = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction Stop).CounterSamples
  } catch { return [double]::NaN }
  $sum = 0.0
  foreach ($s in $samples) {
    if ($s.InstanceName -match '^pid_(\d+)_') { if ($ids -contains [int]$Matches[1]) { $sum += $s.CookedValue } }
  }
  return [math]::Round($sum, 2)
}

function Get-PrivateMB([int[]]$ids) {
  $sum = 0
  foreach ($id in $ids) { try { $sum += (Get-Process -Id $id -ErrorAction Stop).PrivateMemorySize64 } catch { } }
  return [math]::Round($sum / 1MB, 1)
}

function Get-HelperProc {
  Get-Process -Name 'vision-helper' -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Test-Link {
  if (-not $cfg) { return 'no-config' }
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $cfg.port) -Headers @{ 'X-Vision-Token' = $cfg.token } -TimeoutSec 2
    if ($r.ok) { 'online' } else { 'error' }
  } catch { 'offline' }
}

Write-Host "Sampling '$Label' for $DurationSec s every $IntervalSec s -> $csv"
"time,label,wall_cpu_pct,wall_gpu_pct,wall_private_mb,wall_procs,helper_cpu_pct,helper_private_mb,helper_ws_mb,link" | Set-Content $csv

$rows = @()
$end = (Get-Date).AddSeconds($DurationSec)
$ids = [int[]]@(Get-LivelyTree)
$prev = Get-CpuTimes $ids
$h = Get-HelperProc
$hPrev = if ($h) { $h.TotalProcessorTime.TotalMilliseconds } else { 0 }
$tPrev = Get-Date
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds $IntervalSec
  $now = Get-Date
  $dtMs = ($now - $tPrev).TotalMilliseconds
  $ids = [int[]]@(Get-LivelyTree)
  $cur = Get-CpuTimes $ids
  $cpuMs = 0.0
  foreach ($id in $cur.Keys) { if ($prev.ContainsKey($id)) { $cpuMs += $cur[$id] - $prev[$id] } }
  $wallCpu = [math]::Round(100 * $cpuMs / ($dtMs * $cores), 2)
  $gpu = Get-GpuPercent $ids
  $mem = Get-PrivateMB $ids
  $h = Get-HelperProc
  $hCpu = 0; $hPriv = 0; $hWs = 0
  if ($h) {
    $hMs = $h.TotalProcessorTime.TotalMilliseconds
    $hCpu = [math]::Round(100 * ($hMs - $hPrev) / ($dtMs * $cores), 3)
    $hPrev = $hMs
    $hPriv = [math]::Round($h.PrivateMemorySize64 / 1MB, 1)
    $hWs = [math]::Round($h.WorkingSet64 / 1MB, 1)
  }
  $link = Test-Link
  $row = [pscustomobject]@{ time = $now.ToString('s'); label = $Label; wall_cpu_pct = $wallCpu; wall_gpu_pct = $gpu; wall_private_mb = $mem; wall_procs = $ids.Count; helper_cpu_pct = $hCpu; helper_private_mb = $hPriv; helper_ws_mb = $hWs; link = $link }
  $rows += $row
  ($row.PSObject.Properties.Value -join ',') | Add-Content $csv
  Write-Host ("{0}  wallpaper cpu {1,6}%  gpu {2,6}%  ram {3,7} MB   helper cpu {4,6}%  ram {5,5} MB  link {6}" -f $row.time, $wallCpu, $gpu, $mem, $hCpu, $hPriv, $link)
  $prev = $cur
  $tPrev = $now
}

function Stat($name, $vals) {
  $v = @($vals | Where-Object { -not [double]::IsNaN($_) } | Sort-Object)
  if ($v.Count -eq 0) { return "{0,-18} n/a" -f $name }
  $mean = ($v | Measure-Object -Average).Average
  $p95 = $v[[math]::Min($v.Count - 1, [math]::Floor($v.Count * 0.95))]
  "{0,-18} mean {1,8:N2}   p95 {2,8:N2}   max {3,8:N2}" -f $name, $mean, $p95, $v[-1]
}
Write-Host ''
Write-Host "Summary ($Label, $($rows.Count) samples, $cores logical cores)"
Write-Host (Stat 'wallpaper CPU %' $rows.wall_cpu_pct)
Write-Host (Stat 'wallpaper GPU %' $rows.wall_gpu_pct)
Write-Host (Stat 'wallpaper RAM MB' $rows.wall_private_mb)
Write-Host (Stat 'helper CPU %' $rows.helper_cpu_pct)
Write-Host (Stat 'helper RAM MB' $rows.helper_private_mb)
Write-Host ("link offline samples: {0}" -f @($rows | Where-Object { $_.link -ne 'online' }).Count)
Write-Host "CSV: $csv"

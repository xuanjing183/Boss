param(
  [Parameter(Mandatory=$true)][string]$Url,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Budget = "30000",
  [string]$Exe = ""
)

# Pure ASCII (Windows PowerShell 5.1 reads this file as ANSI otherwise).
#
# Why this wrapper exists -- three things measured on this box with Edge 155:
#   1) Edge is a GUI-subsystem executable. Node's own pipe capture gets 0 bytes
#      and cmd's ">" redirection also gets 0 bytes. Only Start-Process with
#      -RedirectStandardOutput to a real file receives the --dump-dom output.
#   2) Do NOT pass --user-data-dir: headless then exits with code 13 and
#      "Multiple targets are not supported in headless mode". Headless already
#      uses a throwaway profile, so your logged-in data is never touched.
#   3) In a PowerShell array literal the comma binds tighter than "+", so
#      "--x=" + $v, is TWO elements: "--x=" and $v. Parenthesize the concat or
#      Edge sees a stray positional argument and dies with the same
#      "Multiple targets are not supported in headless mode" (exit 13).

$ErrorActionPreference = "Stop"

if ($Exe -eq "") {
  $cands = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $cands) { if (Test-Path $c) { $Exe = $c; break } }
}
if ($Exe -eq "") { Write-Output "NO_BROWSER"; exit 2 }

$errFile = $Out + ".err"
Remove-Item $Out, $errFile -ErrorAction SilentlyContinue

$browserArgs = @(
  "--headless=new",
  "--disable-gpu",
  "--window-size=1280,900",
  "--no-first-run",
  "--no-default-browser-check",
  ("--virtual-time-budget=" + $Budget),
  "--dump-dom",
  $Url
)
if ($browserArgs.Count -ne 8) { Write-Output ("BAD_ARG_COUNT " + $browserArgs.Count); exit 4 }

$p = Start-Process -FilePath $Exe -ArgumentList $browserArgs -PassThru -NoNewWindow `
     -RedirectStandardOutput $Out -RedirectStandardError $errFile

# Wait with a wall-clock deadline instead of "-Wait". Why: run.js caps its own
# spawnSync timeout and kills THIS powershell, but Edge is a separate process --
# it kept running, and after a few dozen suites the box had ~60 leaked headless
# instances eating enough RAM to slow every later suite by 2x. Deadline =
# virtual budget + 3 minutes of slack; on expiry we kill the tree ourselves.
$deadlineSec = [int](([double]$Budget) / 1000.0) + 180
if ($deadlineSec -lt 60) { $deadlineSec = 60 }
$loops = $deadlineSec * 2
$ended = $false
for ($i = 0; $i -lt $loops; $i++) {
  if ($p.HasExited) { $ended = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $ended) {
  Write-Output ("TIMEOUT_KILL after " + $deadlineSec + "s pid=" + $p.Id)
  $kids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.ParentProcessId -eq $p.Id })
  foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

$outBytes = 0
if (Test-Path $Out) { $outBytes = (Get-Item $Out).Length }
Write-Output ("code=" + $p.ExitCode + " bytes=" + $outBytes)

if (Test-Path $errFile) {
  # The QQBrowser importer error Edge always prints is noise; drop it.
  $lines = Get-Content $errFile | Where-Object { $_ -notmatch "QQBrowser" -and $_.Trim().Length -gt 0 }
  foreach ($l in $lines) { Write-Output ("stderr " + $l) }
}
if ($outBytes -eq 0) { exit 3 }

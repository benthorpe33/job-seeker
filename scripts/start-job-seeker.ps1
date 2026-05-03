# start-job-seeker.ps1
#
# Starts the job_seeker dev stack (Fastify API on :5174 + Vite web on :5173) in
# a hidden background process. Idempotent: kills anything currently holding the
# dev ports before launching a fresh pair so dependency changes never leave a
# stale node process behind.
#
# Wired via Task Scheduler at user logon (see scripts/install-startup-task.ps1).

$ErrorActionPreference = "Stop"

$RepoRoot = "c:\repos\job_seeker"
$AppDir   = Join-Path $RepoRoot "app"
$LogDir   = Join-Path $RepoRoot "app\server\.data"
$OutLog   = Join-Path $LogDir "dev-stdout.log"
$ErrLog   = Join-Path $LogDir "dev-stderr.log"

# Make sure the log directory exists. Other parts of the server already use it.
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Stop-PortHolder([int]$Port) {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    try {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    } catch {
      # ignore — process may already be gone
    }
  }
}

function Stop-DevStackByCmdline() {
  # Catch zombies from prior runs that never bound a port (concurrently
  # restart loops, tsx-watch reload failures). The cmdline patterns are tight
  # enough to only match our own processes — they won't kill Claude Code.
  $pids = @()
  $pids += (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "concurrently|tsx.*main\.ts|@job-seeker|vite.*5173" }).ProcessId
  $pids += (Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "npm run dev|dev:server|dev:web|dev-stdout\.log" }).ProcessId
  foreach ($p in ($pids | Sort-Object -Unique)) {
    try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
  }
}

# Ensure a real bash is on PATH ahead of System32\bash.exe (the WSL launcher,
# which fails with `execvpe(/bin/bash) failed: No such file or directory` when
# no WSL distro is installed). Stage 6 (batch) and the draft-answers /
# generate-cv / full-report / profile-diff stages all shell out to bash
# scripts via job_seeker's `detectBash()`.
$gitBashCandidates = @(
  "C:\Program Files\Git\usr\bin",
  "C:\Program Files\Git\bin",
  "C:\Program Files (x86)\Git\usr\bin",
  "C:\Program Files (x86)\Git\bin"
)
foreach ($d in $gitBashCandidates) {
  if (Test-Path (Join-Path $d "bash.exe")) {
    $env:PATH = "$d;$env:PATH"
    break
  }
}

# 1. Kill anything already on the dev ports + any zombies from prior runs.
Stop-PortHolder 5173
Stop-PortHolder 5174
Stop-DevStackByCmdline
Start-Sleep -Milliseconds 500

# 2. Spawn `npm run dev` in a hidden cmd window, redirecting stdio to logs.
#    Using cmd /c with shell-style redirection avoids the Start-Process
#    Hidden+Redirect parameter conflict on Windows.
$cmdArgs = '/c npm run dev > "{0}" 2> "{1}"' -f $OutLog, $ErrLog
Start-Process -FilePath "cmd.exe" `
  -ArgumentList $cmdArgs `
  -WorkingDirectory $AppDir `
  -WindowStyle Hidden | Out-Null

# Brief settling pause so a logon-triggered task doesn't race with later boots.
Start-Sleep -Seconds 2

# fix-neighbor-env.ps1
# Run this in an elevated PowerShell after rotating GEMINI_API_KEY or
# MISTRAL_API_KEY via setx, or any time the scheduled task stops seeing
# the env vars.
#
# Why this exists: Windows Task Scheduler does not reliably inherit User
# env vars that were set AFTER the user logged on. SetEnvironmentVariable
# ('User') writes to the registry, but running processes (including
# Task Scheduler's session) do not reload it. Embedding the keys directly
# in the task's -Command argument is robust to that.
#
# CRITICAL: the task invokes run-dispatcher.ps1 (the wrapper), NOT node
# scripts/dispatch.mjs directly. The wrapper's finally block is what
# syncs the fleet-<machine>.json to the shared gist, which is how the
# fleet has visibility into this machine. Bypassing the wrapper freezes
# the gist at the last wrapper-run timestamp, even while dispatch.mjs
# continues to fire every 20 min.

# Step 1: verify the keys exist in User env
$gemini  = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY',  'User')
$mistral = [Environment]::GetEnvironmentVariable('MISTRAL_API_KEY', 'User')

if (-not $gemini) {
    Write-Host "ERROR: GEMINI_API_KEY not found in User environment." -ForegroundColor Red
    Write-Host "Set it first: setx GEMINI_API_KEY 'your-key' (then open a fresh shell)"
    exit 1
}
Write-Host "GEMINI_API_KEY found ($($gemini.Substring(0,8))...)" -ForegroundColor Green
if ($mistral) { Write-Host "MISTRAL_API_KEY found" -ForegroundColor Green }

# Step 2: resolve the repo path from THIS script's location. Works whether
# the local dir is called claude-budget-dispatcher, budget-dispatcher, or
# any other name -- avoids the old hardcoded path bug that broke after
# the repo rename.
$repoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$wrapper  = Join-Path $repoPath "scripts\run-dispatcher.ps1"

if (-not (Test-Path $wrapper)) {
    Write-Host "ERROR: run-dispatcher.ps1 not found at: $wrapper" -ForegroundColor Red
    exit 1
}

# Build the task command. Backticks before $env: make those dollar signs
# LITERAL in the argument string so they are expanded inside the task's
# powershell.exe session (at run time), not the authoring session (now).
$envBlock = "`$env:GEMINI_API_KEY='$gemini';"
if ($mistral) { $envBlock += " `$env:MISTRAL_API_KEY='$mistral';" }
$envBlock += " & '$wrapper' -RepoRoot '$repoPath' -Engine auto"

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `"$envBlock`"" `
    -WorkingDirectory $repoPath

# Step 3: apply to the existing task
try {
    Set-ScheduledTask -TaskName "BudgetDispatcher-Node" -Action $action | Out-Null
    Write-Host "`nScheduled task updated: embedded keys + wrapper invocation." -ForegroundColor Green
    Write-Host "Next run will have env vars AND sync the fleet gist on every exit path."
} catch {
    Write-Host "ERROR: Could not update scheduled task. Run as Administrator?" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}

# Step 4: verify
Write-Host "`n--- Verification ---"
$task = Get-ScheduledTask -TaskName "BudgetDispatcher-Node"
Write-Host "Task state: $($task.State)"
Write-Host "Next run:   $((Get-ScheduledTaskInfo -TaskName 'BudgetDispatcher-Node').NextRunTime)"
Write-Host "`nDone. Wait for the next 20-min fire, or trigger manually:"
Write-Host "  Start-ScheduledTask -TaskName 'BudgetDispatcher-Node'"

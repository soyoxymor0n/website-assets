# One-shot Bitwarden sync for .scaffold-secrets.
#
# Double-click bw-push.cmd (or run this file directly in PowerShell) any
# time .scaffold-secrets has changed. It logs in if needed, prompts for
# your master password to unlock, pushes the file to the 'scaffold-secrets'
# vault note, then exits - the unlock session lives only in THIS process's
# environment and is discarded when the window closes. Nothing is written
# to disk, and no session token is ever stored anywhere.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail($msg) {
    Write-Host $msg -ForegroundColor Red
    exit 1
}

try {
    $status = bw status | ConvertFrom-Json
} catch {
    Fail "Bitwarden CLI not found. Install with: npm i -g @bitwarden/cli"
}

if ($status.status -eq "unauthenticated") {
    Write-Host "Not logged in to Bitwarden - logging in now (one-time)." -ForegroundColor Cyan
    bw login
    if ($LASTEXITCODE -ne 0) { Fail "Login failed or was cancelled." }
}

Write-Host "Unlocking your vault (enter your Bitwarden master password)..." -ForegroundColor Cyan
$session = bw unlock --raw
if (-not $session) { Fail "Unlock failed or was cancelled." }

$env:BW_SESSION = $session

node "$scriptDir/secrets-sync.mjs" push
$exitCode = $LASTEXITCODE

Remove-Item Env:\BW_SESSION -ErrorAction SilentlyContinue

if ($exitCode -eq 0) {
    Write-Host ""
    Write-Host "Done. This window's session has been discarded." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Sync reported a problem - see above." -ForegroundColor Yellow
}
exit $exitCode

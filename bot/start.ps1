$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$botNode = (Get-Command node -ErrorAction Stop).Source
$botLogDir = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $botLogDir -Force | Out-Null
# NapCat dominates a 2 GB box: cap heap and young generation, trade speed for memory.
$botArgs = @('--max-old-space-size=128', '--max-semi-space-size=4', '--optimize-for-size',
    (Join-Path $PSScriptRoot 'run.js'))

# Keep the worker alive: a V8 crash or an unexpected exit must not leave the bot offline
# until someone logs in. The lock port inside run.js still prevents duplicate instances.
while ($true) {
    $botLogFile = Join-Path $botLogDir ('worker-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
    $started = Get-Date
    & $botNode @botArgs *>> $botLogFile
    $code = $LASTEXITCODE
    # 0 means the worker finished on purpose (--preview/--status/dryRun); do not restart.
    if ($code -eq 0) { exit 0 }
    $ran = ((Get-Date) - $started).TotalSeconds
    $wait = if ($ran -lt 60) { 15 } else { 5 }
    "[$(Get-Date -Format o)] worker exited with code $code after $([int]$ran)s; restarting in ${wait}s" |
        Out-File -FilePath $botLogFile -Append -Encoding utf8
    Start-Sleep -Seconds $wait
}

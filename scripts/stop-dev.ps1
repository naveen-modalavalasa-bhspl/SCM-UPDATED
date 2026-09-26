# Stop the dev servers. The one teardown door.
#
# Reads logs/dev/dev.pid and stops the supervisor FIRST -- while it lives it
# reads every server we kill as a crash and restarts it three seconds later,
# which is why the old stop-dev appeared not to work and why the start-dev that
# followed it threw on a port that had come back to life. Then the recorded
# process trees, then a port sweep for anything orphaned by a supervisor that was
# force-killed before its own cleanup could run.
#
#   .\scripts\stop-dev.ps1
#   .\scripts\stop-dev.ps1 -Ports 8000,5173,4173
#
# The real work is Stop-DevAll in dev-common.ps1, shared with start-dev.ps1 so
# both scripts agree on what stopping means.

param(
    [int[]]$Ports = @(8000, 5173)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "dev-common.ps1")

$Root = Split-Path -Parent $PSScriptRoot

$stopped = Stop-DevAll -Root $Root -Ports $Ports

if ($stopped -eq 0) {
    Write-DevInfo "Nothing to stop: no dev run recorded and no listener on $($Ports -join ', ')."
} else {
    Write-DevInfo "Stopped $stopped process tree(s). Ports $($Ports -join ', ') are free."
}

# Start the dev servers and leave them running.
#
# Default behaviour is DETACHED: launch backend and frontend, wait until each
# answers, record what was started in logs/dev/dev.pid, and exit. The servers do
# not belong to this script's lifetime, so closing the terminal, pressing Ctrl+C,
# an IDE task ending or a tool-call timeout no longer stops them. The previous
# version held both as children of a blocking watch loop with a `finally` block
# that ran `taskkill /T /F` on the way out, which meant every one of those
# perfectly ordinary events killed both servers -- and a supervisor force-killed
# hard enough to skip its `finally` orphaned them instead. Teardown has one door
# now: scripts/stop-dev.ps1.
#
#   .\scripts\start-dev.ps1                 # start, verify, exit (servers stay up)
#   .\scripts\start-dev.ps1 -Supervise      # also stay and restart on crash
#   .\scripts\start-dev.ps1 -Supervise -StopOnExit   # old behaviour, opt-in
#
# Starting is idempotent: whatever is already running is stopped first, through
# the same code path stop-dev uses, so the two scripts can no longer fight.

param(
    [string]$HostAddress = "0.0.0.0",
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173,
    [int]$RestartDelaySeconds = 3,
    [int]$MaxRestarts = 5,
    [int]$KeepLogFiles = 20,
    [switch]$NoReload,
    [switch]$Supervise,
    [switch]$StopOnExit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "dev-common.ps1")

$Root = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
$LogDir = Get-DevLogDir $Root
$BackendPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
$ViteEntry = Join-Path $FrontendDir "node_modules\vite\bin\vite.js"
$ViteEntryArg = ".\node_modules\vite\bin\vite.js"
$Ports = @($BackendPort, $FrontendPort)

function Assert-DevPath {
    param([string]$Path, [string]$Message)
    if (-not (Test-Path $Path)) { throw $Message }
}

# Liveness is /health, which touches nothing. /health/ready returns 503 when
# MySQL is down, and 503 read as "the server never started" -- so a database
# hiccup used to cost a 45s wait and a bogus failure line about a backend that
# was up and fine. Readiness is probed once, separately, and only reported.
function Wait-DevHttp {
    param(
        [string]$Name,
        [string]$Url,
        [int]$TimeoutSeconds,
        [System.Diagnostics.Process]$Process
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($null -ne $Process -and $Process.HasExited) {
            Write-DevInfo "$Name exited during startup with code $($Process.ExitCode). See $LogDir."
            return $false
        }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ([int]$response.StatusCode -lt 500) {
                Write-DevInfo "$Name ready at $Url"
                return $true
            }
        } catch {
            # Not up yet, or a 5xx while warming. Either way, keep polling.
        }
        Start-Sleep -Milliseconds 500
    }
    Write-DevInfo "$Name did not answer at $Url within ${TimeoutSeconds}s."
    return $false
}

function Report-DevReadiness {
    param([int]$Port)
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health/ready" -UseBasicParsing -TimeoutSec 3 | Out-Null
        Write-DevInfo "Backend readiness: MySQL is answering."
    } catch {
        Write-DevInfo "Backend readiness: MySQL is NOT answering (/health/ready). The API is up; DB-backed routes will fail."
    }
}

# Log names end in .log.out / .log.err on purpose. frontend/vite.config.ts
# ignores '**/*.log.out' and '**/*.log.err' in its file watcher because the dev
# server writing its own output inside the watched root is a reload loop that
# feeds itself. Naming these '<name>.<stamp>.out.log' -- as the first version of
# this script did -- does not match that guard and puts the loop back.
function Start-DevProcess {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $stdout = Join-Path $LogDir "$($Name.ToLower()).$stamp.log.out"
    $stderr = Join-Path $LogDir "$($Name.ToLower()).$stamp.log.err"
    Write-DevInfo "Starting $Name"
    Write-DevInfo "$Name logs: $stdout"
    return Start-Process `
        -FilePath $FilePath `
        -ArgumentList $Arguments `
        -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden `
        -PassThru
}

function Remove-OldDevLogs {
    if ($KeepLogFiles -le 0) { return }
    # "*.log*" and not "*.log.*": it has to sweep up the '<name>.<stamp>.out.log'
    # files an earlier version of this script wrote, which are never rewritten and
    # so would otherwise sit in vite's watched root forever.
    $logs = @(Get-ChildItem -Path $LogDir -Filter "*.log*" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "dev.pid" } |
        Sort-Object LastWriteTime -Descending)
    if ($logs.Count -le $KeepLogFiles) { return }
    $stale = $logs[$KeepLogFiles..($logs.Count - 1)]
    foreach ($file in $stale) {
        Remove-Item -Force -ErrorAction SilentlyContinue $file.FullName
    }
    Write-DevInfo "Pruned $($stale.Count) old log file(s); keeping the newest $KeepLogFiles."
}

# A crash loop used to restart every 3s forever, minting two log files each pass.
function Start-Backend {
    $arguments = @("-m", "uvicorn", "app.main:app", "--host", $HostAddress, "--port", "$BackendPort")
    if (-not $NoReload) { $arguments += @("--reload", "--reload-dir", "app") }
    return Start-DevProcess "backend" $BackendPython $arguments $BackendDir
}

# node straight to vite.js, skipping npm.cmd. `Start-Process npm.cmd` built a
# cmd.exe -> node(npm-cli) -> cmd.exe -> node(vite) chain, so the PID this script
# held was three levels above the process that actually binds the port: killing
# the server left three ancestors alive, and killing the recorded PID's tree
# depended on which layer had exited first.
function Start-Frontend {
    $arguments = @($ViteEntryArg, "--host", $HostAddress, "--port", "$FrontendPort")
    return Start-DevProcess "frontend" "node" $arguments $FrontendDir
}

# What this script launched is not always what listens. The venv's python.exe
# re-execs the base interpreter as a child, and uvicorn --reload then forks a
# worker, so :8000 is held two levels below the PID Start-Process returns.
# Record the launched process AND the port owners, and stop both trees later.
function Get-DevRecords {
    param([string]$Role, [System.Diagnostics.Process]$Process, [int]$Port)
    $records = @()
    if ($null -ne $Process -and -not $Process.HasExited) {
        $records += (New-DevProcessRecord -Role $Role -ProcessId $Process.Id)
    }
    foreach ($owner in (Get-DevPortOwner -Port $Port)) {
        if (@($records | ForEach-Object { $_.Pid }) -notcontains $owner) {
            $records += (New-DevProcessRecord -Role "$Role (port $Port)" -ProcessId $owner)
        }
    }
    return $records
}

function Save-DevState {
    param($BackendProcess, $FrontendProcess, $SupervisorRecord)
    $state = [pscustomobject]@{
        StartedAt  = (Get-Date).ToString("o")
        Ports      = $Ports
        Supervisor = $SupervisorRecord
        Processes  = @(
            @(Get-DevRecords -Role "backend" -Process $BackendProcess -Port $BackendPort) +
            @(Get-DevRecords -Role "frontend" -Process $FrontendProcess -Port $FrontendPort)
        )
    }
    Write-DevState -Root $Root -State $state
}

Assert-DevPath $BackendPython "Backend virtualenv not found at $BackendPython. Create it and install requirements first."
Assert-DevPath (Join-Path $BackendDir ".env") "Backend .env not found. Copy backend/.env.example to backend/.env and set DATABASE_URL."
Assert-DevPath (Join-Path $FrontendDir "package-lock.json") "Frontend package-lock.json not found."
Assert-DevPath (Join-Path $FrontendDir "node_modules") "Frontend node_modules not found. Run npm install in frontend first."
Assert-DevPath $ViteEntry "Vite not found at $ViteEntry. Run npm install in frontend first."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node was not found on PATH." }

New-Item -ItemType Directory -Force $LogDir | Out-Null
Remove-OldDevLogs

# Idempotent start. The old version threw "Port 8000 is already in use" here,
# which turned the ordinary stop-dev-then-start-dev sequence into a race: the
# still-running supervisor restarted the servers stop-dev had just killed, and
# this check then refused to run at all.
if ((Read-DevState -Root $Root) -or (Test-DevPort -Port $BackendPort) -or (Test-DevPort -Port $FrontendPort)) {
    Write-DevInfo "A previous dev run is still around. Stopping it first."
    Stop-DevAll -Root $Root -Ports $Ports | Out-Null
}
foreach ($port in $Ports) {
    if (Test-DevPort -Port $port) {
        throw "Port $port is still held by a process these scripts did not start. Free it and try again."
    }
}

$backend = Start-Backend
$backendUp = Wait-DevHttp "Backend" "http://127.0.0.1:$BackendPort/health" 45 $backend
if ($backendUp) { Report-DevReadiness -Port $BackendPort }

$frontend = Start-Frontend
$frontendUp = Wait-DevHttp "Frontend" "http://127.0.0.1:$FrontendPort/" 30 $frontend

$supervisorRecord = $null
if ($Supervise) { $supervisorRecord = (New-DevProcessRecord -Role "supervisor" -ProcessId $PID) }
Save-DevState -BackendProcess $backend -FrontendProcess $frontend -SupervisorRecord $supervisorRecord

if (-not ($backendUp -and $frontendUp)) {
    Write-DevInfo "WARNING: not everything came up. Logs are in $LogDir; run scripts\stop-dev.ps1 to clean up."
}

if (-not $Supervise) {
    Write-DevInfo "Dev servers are running detached. Open http://localhost:$FrontendPort"
    Write-DevInfo "They will keep running after this window closes. Stop them with: .\scripts\stop-dev.ps1"
    return
}

Write-DevInfo "Supervising. Open http://localhost:$FrontendPort"
if ($StopOnExit) {
    Write-DevInfo "Ctrl+C stops both servers (-StopOnExit)."
} else {
    Write-DevInfo "Ctrl+C stops supervising and LEAVES both servers running. Stop them with: .\scripts\stop-dev.ps1"
}

$restarts = @{ backend = 0; frontend = 0 }

try {
    while ($true) {
        Start-Sleep -Seconds 2

        foreach ($role in @("backend", "frontend")) {
            if ($role -eq "backend") { $port = $BackendPort } else { $port = $FrontendPort }

            # Liveness is the LISTENING socket, not HasExited on the process this
            # script launched -- that PID is a wrapper around the real server and
            # can outlive it (or exit while it keeps serving).
            if (Test-DevPort -Port $port) { continue }

            if ($restarts[$role] -ge $MaxRestarts) {
                Write-DevInfo "$role has failed $MaxRestarts times. Not restarting again -- fix the cause, then rerun this script."
                Write-DevInfo "Logs: $LogDir"
                return
            }

            $restarts[$role]++
            $delay = [Math]::Min($RestartDelaySeconds * $restarts[$role], 30)
            Write-DevInfo "$role is not listening on $port (attempt $($restarts[$role]) of $MaxRestarts). Restarting in ${delay}s."
            Start-Sleep -Seconds $delay

            # Each restart is contained. Without this, one failed Start-Process --
            # a locked log file, node briefly off PATH -- threw out of the loop
            # under $ErrorActionPreference='Stop' and took the other, healthy
            # server down with it on the way through `finally`.
            try {
                if ($role -eq "backend") {
                    $backend = Start-Backend
                    if (Wait-DevHttp "Backend" "http://127.0.0.1:$BackendPort/health" 45 $backend) {
                        Report-DevReadiness -Port $BackendPort
                    }
                } else {
                    $frontend = Start-Frontend
                    Wait-DevHttp "Frontend" "http://127.0.0.1:$FrontendPort/" 30 $frontend | Out-Null
                }
                Save-DevState -BackendProcess $backend -FrontendProcess $frontend -SupervisorRecord $supervisorRecord
            } catch {
                Write-DevInfo "Could not restart ${role}: $($_.Exception.Message)"
            }
        }
    }
} finally {
    if ($StopOnExit) {
        Write-DevInfo "Stopping both servers (-StopOnExit)."
        Stop-DevAll -Root $Root -Ports $Ports | Out-Null
    } else {
        # Drop the supervisor from the run state and leave the servers alone, so
        # stop-dev does not later chase a PID that is no longer supervising.
        Save-DevState -BackendProcess $backend -FrontendProcess $frontend -SupervisorRecord $null
        Write-DevInfo "No longer supervising. Both servers are still running; stop them with .\scripts\stop-dev.ps1"
    }
}

# Shared helpers for scripts/start-dev.ps1 and scripts/stop-dev.ps1.
#
# One copy of: where the dev files live, how a listening port is traced back to a
# PID, how the run-state file is read and written, and -- above all -- what
# "stop the dev servers" means. The two scripts used to discover processes two
# different ways and could not see each other's work: stop-dev killed whatever
# held a port while start-dev's supervisor, still alive and unaware, restarted
# both servers three seconds later, and the next start-dev then threw on the
# port it had just been handed back. Teardown lives here now, so both sides
# agree.
#
# Every function takes $Root explicitly rather than reading $PSScriptRoot: this
# file is dot-sourced, and a helper that resolves paths from its own location is
# a trap the first time someone moves it.

Set-StrictMode -Version Latest

function Write-DevInfo {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Message)
    Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message)
}

function Get-DevLogDir {
    param([Parameter(Mandatory = $true)][string]$Root)
    return (Join-Path $Root "logs\dev")
}

function Get-DevStateFile {
    param([Parameter(Mandatory = $true)][string]$Root)
    return (Join-Path (Get-DevLogDir $Root) "dev.pid")
}

# StrictMode makes a missing property an error rather than $null, and run-state
# files written by an older version of these scripts are common enough to matter.
function Get-DevProp {
    param($Object, [Parameter(Mandatory = $true)][string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    if ($Object -isnot [psobject]) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    if ($null -eq $property.Value) { return $Default }
    return $property.Value
}

function Get-DevProcessStamp {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    try {
        return $process.StartTime.ToString("o")
    } catch {
        # A process whose start time we cannot read: no rights, or it just exited.
        return $null
    }
}

# The run-state file outlives the processes it names and Windows recycles PIDs
# freely. Recording the start time beside the PID is what stops a stale file from
# making us kill a stranger that inherited the number.
function Test-DevProcessIdentity {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [string]$StartTime
    )
    if ($ProcessId -le 4) { return $false }
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $false }
    if ([string]::IsNullOrWhiteSpace($StartTime)) {
        # Nothing recorded: the PID alone is all we have to go on.
        return $true
    }
    $actual = Get-DevProcessStamp -ProcessId $ProcessId
    if ([string]::IsNullOrWhiteSpace($actual)) { return $false }
    return ((([datetime]$actual) - ([datetime]$StartTime)).Duration().TotalSeconds -lt 2)
}

function Get-DevPortOwner {
    param([Parameter(Mandatory = $true)][int]$Port)

    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $owners = @()
        try {
            foreach ($connection in (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)) {
                $owner = [int]$connection.OwningProcess
                if ($owner -gt 4) { $owners += $owner }
            }
            # Only trust an empty result when the query itself succeeded. On locked
            # down Windows accounts Get-NetTCPConnection exists but throws Access
            # Denied; treating that as "no listener" allowed a second uvicorn to bind
            # the same port and requests alternated between old and new application
            # code. A successful query may safely return here; a failed one must use
            # the netstat fallback below.
            return @($owners | Sort-Object -Unique)
        } catch {
            # AccessDenied and provider failures fall through to netstat. It is also
            # harmless to do so for ObjectNotFound (nothing listening).
        }
    }

    # netstat fallback, anchored on the LOCAL address column and requiring the
    # LISTENING state -- so a TIME_WAIT row (netstat reports those with PID 0) and
    # a foreign address that merely mentions the port cannot match. The old
    # scripts matched ':<port>\s+.*LISTENING' anywhere on the line and then took
    # the last field as a PID.
    $pattern = '^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$'
    $owners = @()
    foreach ($line in (netstat -ano)) {
        $match = [regex]::Match([string]$line, $pattern)
        if ($match.Success) {
            $owner = [int]$match.Groups[1].Value
            if ($owner -gt 4) { $owners += $owner }
        }
    }
    return @($owners | Sort-Object -Unique)
}

function Test-DevPort {
    param([Parameter(Mandatory = $true)][int]$Port)
    # @() because PowerShell unrolls an array on return: no listener comes back
    # as $null, not an empty array, and $null.Count is an error under StrictMode.
    return (@(Get-DevPortOwner -Port $Port).Count -gt 0)
}

function Stop-DevTree {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [string]$Label = "process"
    )
    if ($ProcessId -le 4) { return $false }
    if ($ProcessId -eq $PID) { return $false }
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $false }

    Write-DevInfo "Stopping $Label (PID $ProcessId) and its children"
    & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
    return $true
}

function Wait-DevPortFree {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutSeconds = 15
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-DevPort -Port $Port)) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return (-not (Test-DevPort -Port $Port))
}

function Read-DevState {
    param([Parameter(Mandatory = $true)][string]$Root)
    $file = Get-DevStateFile $Root
    if (-not (Test-Path $file)) { return $null }
    try {
        return (Get-Content -Raw -Path $file | ConvertFrom-Json)
    } catch {
        Write-DevInfo "Run-state file is unreadable; falling back to a port scan."
        return $null
    }
}

function Write-DevState {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$State
    )
    $file = Get-DevStateFile $Root
    New-Item -ItemType Directory -Force (Split-Path -Parent $file) | Out-Null
    ($State | ConvertTo-Json -Depth 6) | Set-Content -Path $file -Encoding UTF8
}

function Clear-DevState {
    param([Parameter(Mandatory = $true)][string]$Root)
    $file = Get-DevStateFile $Root
    if (Test-Path $file) { Remove-Item -Force $file }
}

function New-DevProcessRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][int]$ProcessId
    )
    return [pscustomobject]@{
        Role      = $Role
        Pid       = $ProcessId
        StartTime = (Get-DevProcessStamp -ProcessId $ProcessId)
    }
}

# THE teardown path, and the order is the whole point of it.
#
# The supervisor dies FIRST, because while it lives it reads every server we stop
# as a crash and restarts it. Then the processes recorded at launch, by tree.
# Then a port sweep, for anything orphaned by a supervisor that was killed hard
# enough to skip its own cleanup.
function Stop-DevAll {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [int[]]$Ports = @(8000, 5173),
        [switch]$KeepSupervisor
    )

    $stopped = 0
    $state = Read-DevState -Root $Root

    if ($null -ne $state) {
        $supervisor = Get-DevProp $state "Supervisor"
        if ($null -ne $supervisor -and -not $KeepSupervisor) {
            $supervisorPid = [int](Get-DevProp $supervisor "Pid" 0)
            $supervisorStamp = [string](Get-DevProp $supervisor "StartTime" "")
            if ($supervisorPid -gt 0 -and $supervisorPid -ne $PID -and
                (Test-DevProcessIdentity -ProcessId $supervisorPid -StartTime $supervisorStamp)) {
                # The supervisor alone, NOT its tree: the servers are its children
                # and they are stopped deliberately below, each with its own tree,
                # rather than swept up in an unlogged /T.
                Write-DevInfo "Stopping supervisor (PID $supervisorPid)"
                & taskkill.exe /PID $supervisorPid /F 2>&1 | Out-Null
                $stopped++
                Start-Sleep -Milliseconds 400
            }
        }

        foreach ($record in @(Get-DevProp $state "Processes" @())) {
            $recordPid = [int](Get-DevProp $record "Pid" 0)
            $recordStamp = [string](Get-DevProp $record "StartTime" "")
            $role = [string](Get-DevProp $record "Role" "process")
            if ($recordPid -le 0) { continue }
            if (-not (Test-DevProcessIdentity -ProcessId $recordPid -StartTime $recordStamp)) { continue }
            if (Stop-DevTree -ProcessId $recordPid -Label $role) { $stopped++ }
        }

        foreach ($statePort in @(Get-DevProp $state "Ports" @())) {
            if ($Ports -notcontains [int]$statePort) { $Ports += [int]$statePort }
        }
    }

    foreach ($port in ($Ports | Sort-Object -Unique)) {
        foreach ($owner in (Get-DevPortOwner -Port $port)) {
            if (Stop-DevTree -ProcessId $owner -Label "orphan on port $port") { $stopped++ }
        }
    }

    if (-not $KeepSupervisor) { Clear-DevState -Root $Root }

    foreach ($port in ($Ports | Sort-Object -Unique)) {
        if (-not (Wait-DevPortFree -Port $port -TimeoutSeconds 15)) {
            Write-DevInfo "WARNING: port $port is still held. Something outside these scripts owns it."
        }
    }

    return $stopped
}

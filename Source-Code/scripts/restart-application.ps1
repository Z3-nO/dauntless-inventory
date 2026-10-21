# SPDX-License-Identifier: AGPL-3.0-only
# Launch a verified managed EXE after the previous editor has finished saving.
# No game file, character save or original application EXE is replaced.
param([Parameter(Mandatory = $true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
# Use Windows PowerShell's own modules even when launched from PowerShell 7.
$env:PSModulePath = [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
function Write-Report([string]$State, [string]$Message) {
    @{ state = $State; message = $Message; version = $job.targetVersion } |
        ConvertTo-Json | Set-Content -LiteralPath $job.reportFile -Encoding UTF8
}
function Start-Version([string]$Executable, [bool]$Updating) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.WorkingDirectory = Split-Path -Parent $Executable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $start.EnvironmentVariables['MATERIALI_USER_DATA'] = $job.userData
    if ($Updating) { $start.EnvironmentVariables['DAUNTLESS_UPDATE_JOB'] = $JobFile }
    else { $start.EnvironmentVariables.Remove('DAUNTLESS_UPDATE_JOB') }
    return [System.Diagnostics.Process]::Start($start)
}
try {
    @{ id = $job.id } | ConvertTo-Json | Set-Content -LiteralPath $job.preparedFile -Encoding UTF8
    foreach ($processId in @($job.parentPid, $job.servicePid)) {
        if (-not $processId) { continue }
        $previous = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($previous -and -not $previous.WaitForExit(90000)) { throw 'The previous editor did not close. No update started.' }
    }
    if ((Get-FileHash -LiteralPath $job.executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.sha256) {
        throw 'The downloaded application changed. No update started.'
    }
    $next = Start-Version $job.executable $true
    Write-Report 'starting' 'Waiting for the updated application.'
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $job.ackFile) {
            try {
                $ack = Get-Content -LiteralPath $job.ackFile -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($ack.id -eq $job.id -and $ack.version -eq $job.targetVersion) {
                    Write-Report 'complete' 'The updated application started successfully.'
                    exit 0
                }
            } catch { }
        }
        if ($next.HasExited) { throw 'The downloaded application closed before confirming startup.' }
        Start-Sleep -Milliseconds 250
    }
    throw 'Startup confirmation timed out. The previous version remains available.'
} catch {
    $message = $_.Exception.Message
    @{ message = $message; time = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $job.failedFile -Encoding UTF8
    Write-Report 'failed' $message
    # Only relaunch if the new launcher has actually exited. An unusually slow
    # application must not be killed or confused with another running session.
    if ((-not $next) -or $next.HasExited) { [void](Start-Version $job.previousExecutable $false) }
    exit 1
}

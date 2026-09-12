<#
.SYNOPSIS
    Starts a mock-server script block as a background job and waits for it to
    report that it is listening.

.DESCRIPTION
    Every Start-Mock*Server.ps1 ended with the same block: Start-Job, poll
    Receive-Job for the MOCK_STARTED / MOCK_ERROR marker, and throw with the
    job's output if neither arrived. Identical apart from the product name in
    the error message, so it lived once per mock server.

    The protocol the script block must follow:
      Write-Output "MOCK_STARTED: port=<port>"   once the listener is up
      Write-Output "MOCK_ERROR: <message>"       if it could not bind

.PARAMETER ScriptBlock
    The server loop to run in the background job.

.PARAMETER ArgumentList
    Arguments passed through to the script block.

.PARAMETER Name
    Product name used in the failure message, e.g. 'SCIM' or 'midPoint'.

.PARAMETER Port
    The port the block was told to listen on — reported in the failure message.
#>
function Start-MockServerJob {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock]$ScriptBlock,
        [Parameter(Mandatory)][object[]]$ArgumentList,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutMs = 4000
    )

    $job = Start-Job -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList
    $started = $false
    $attempts = [math]::Max(1, [int]($TimeoutMs / 200))
    for ($i = 0; $i -lt $attempts; $i++) {
        Start-Sleep -Milliseconds 200
        $out = Receive-Job -Job $job -Keep 2>&1
        if ($out -match 'MOCK_STARTED') { $started = $true; break }
        if ($out -match 'MOCK_ERROR')   { break }
    }
    if (-not $started) {
        $out = Receive-Job -Job $job -Keep 2>&1
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        throw "Mock $Name server failed to start on port $Port. Output: $($out -join '; ')"
    }
    return [PSCustomObject]@{ Job = $job; Port = $Port }
}

<#
.SYNOPSIS
    Runs one crawler job in its own pwsh process (used by scheduler.ps1).

.DESCRIPTION
    Every job used to run inside the long-lived scheduler process, so the Graph
    token, client secret and tenant a job left in $global: variables were still
    there for the next job — of any type, for any tenant. Running each job as a
    child `pwsh -File Invoke-CrawlerJob.ps1` gives it a fresh session that ends
    with the job. (SEC-2026-09 L-08)

    Nothing sensitive goes on the child's command line (SEC-2026-09 L-06): the
    job config (which holds decrypted credentials) is written to its standard
    input, and the API key is handed over in the IA_JOB_API_KEY environment
    variable, which the dispatcher removes as soon as it has read it.

    Behaviour the in-process call had, and this keeps:
      - progress + cancellation: the crawler reports progress over HTTP and aborts
        on a 409 from job-progress, exactly as before; the child then exits non-zero
      - the failure message: the dispatcher writes it to -ResultPath, and this
        function rethrows it so the scheduler can post it to /jobs/:id/fail
      - output: the child's host output streams straight to the container log
#>

function Invoke-CrawlerJobProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [int]$JobId,
        [Parameter(Mandatory)] [string]$JobType,
        $Config = @{},
        [Parameter(Mandatory)] [string]$ApiKey,
        [string]$DispatcherPath = '/app/setup/docker/Invoke-CrawlerJob.ps1',
        [string]$PwshPath = 'pwsh'
    )
    $resultPath = [System.IO.Path]::GetTempFileName()
    $configJson = ConvertTo-Json -InputObject $Config -Depth 100 -Compress
    $env:IA_JOB_API_KEY = $ApiKey
    try {
        $configJson | & $PwshPath -NoProfile -NonInteractive -File $DispatcherPath `
            -JobId $JobId -JobType $JobType -ConfigFromStdin -ResultPath $resultPath | Out-Host
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) { throw (Get-CrawlerJobFailureMessage -ResultPath $resultPath -ExitCode $exitCode) }
    }
    finally {
        Remove-Item Env:IA_JOB_API_KEY -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
    }
}

# The dispatcher's own failure message when it wrote one, else the exit code.
function Get-CrawlerJobFailureMessage {
    [CmdletBinding()]
    param([string]$ResultPath, [int]$ExitCode)
    $message = if (Test-Path -LiteralPath $ResultPath) { "$(Get-Content -LiteralPath $ResultPath -Raw)" } else { '' }
    if ($message.Trim()) { return $message.Trim() }
    return "Crawler job process exited with code $ExitCode"
}

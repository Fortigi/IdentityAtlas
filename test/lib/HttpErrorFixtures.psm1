<#
.SYNOPSIS
    Fixtures for the error records Invoke-RestMethod raises on an HTTP failure.

.DESCRIPTION
    Dot-sourcing crawlers read the status code off a caught error in more than one
    way, and a fixture built for one reader silently yields $null under another.
    That is not hypothetical — it shipped:

      Get-FGHttpStatus          (entra-id)  [int]$err.Exception.Response.StatusCode
      Get-FGIngestErrorDetail   (shared)    $err.Exception.Response.StatusCode.value__
      Get-ODataResponseStatus   (odata)     $err.Exception.Response.StatusCode.value__

    Three readers, two incompatible shapes. Three tests in
    EntraIDCrawlerFunctions.Tests.ps1 built the `value__` shape and handed it to a
    reader that casts [int]. The cast throws, the helper returns $null, and every
    status-specific branch is skipped in favour of the "no status code at all"
    path. The tests were named for HTTP 429, 404 and 503; none of them reached
    those rules, and the 404 one asserted the opposite of its name. Line coverage
    was green. Only mutation testing exposed it.

    Import this module rather than hand-rolling the shape per test file:

        Import-Module (Join-Path $repoRoot 'test' 'lib' 'HttpErrorFixtures.psm1') -Force

.NOTES
    Why not one universal fixture? Only a real [System.Net.HttpStatusCode] satisfies
    both readers (enums expose value__ AND cast to int) — but that enum has no
    member for codes like 499 or 599, and casting those throws. Since boundary
    codes are exactly what retry-policy tests need, the shapes stay separate and
    explicit. New-IntStatusHttpError is the right default for new code; the value__
    variant exists to serve the two helpers that read it that way.
#>

Set-StrictMode -Version Latest

function New-IntStatusHttpError {
    <#
    .SYNOPSIS
        Error whose .Response.StatusCode survives an [int] cast.
    .DESCRIPTION
        For readers shaped like Get-FGHttpStatus. Uses a plain [int] rather than
        [System.Net.HttpStatusCode] so that arbitrary codes — 499, 599, anything a
        boundary test needs — round-trip instead of throwing on the enum cast.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$Status,
        [string]$Message = 'error'
    )
    $resp = [pscustomobject]@{ StatusCode = $Status }
    $ex   = [System.Exception]::new($Message)
    $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
    return $ex
}

function New-ValueDunderHttpError {
    <#
    .SYNOPSIS
        Error whose .Response.StatusCode exposes a .value__ member.
    .DESCRIPTION
        For readers shaped like Get-FGIngestErrorDetail / Get-ODataResponseStatus,
        which mirror how a real HttpStatusCode enum is read. Note this shape does
        NOT survive an [int] cast — handing it to Get-FGHttpStatus yields $null.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$Status,
        [string]$Message = 'error'
    )
    $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = $Status } }
    $ex   = [System.Exception]::new($Message)
    $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
    return $ex
}

function New-StatuslessHttpError {
    <#
    .SYNOPSIS
        Transport-level failure carrying no HTTP response at all (DNS, reset, TLS).
    .DESCRIPTION
        Every retry policy in this repo treats "no status" as transient, so this is
        the case a status-shaped fixture accidentally falls into when its cast
        fails. Use it deliberately, so a test that means to exercise the no-status
        path says so.
    #>
    [CmdletBinding()]
    param([string]$Message = 'The remote name could not be resolved')
    return [System.Exception]::new($Message)
}

function New-RetryAfterHttpError {
    <#
    .SYNOPSIS
        Error carrying a Retry-After response header, for throttling tests.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$Status,
        [Parameter(Mandatory)][int]$RetryAfterSeconds,
        [string]$Message = 'Too Many Requests'
    )
    $headers = [pscustomobject]@{}
    $headers | Add-Member -MemberType ScriptMethod -Name GetValues -Value {
        param($name)
        if ($name -eq 'Retry-After') { @("$($this.RetryAfter)") } else { $null }
    }
    $headers | Add-Member -NotePropertyName RetryAfter -NotePropertyValue $RetryAfterSeconds
    $resp = [pscustomobject]@{ StatusCode = [pscustomobject]@{ value__ = $Status } }
    $resp | Add-Member -NotePropertyName Headers -NotePropertyValue $headers
    $ex = [System.Exception]::new($Message)
    $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force
    return $ex
}

Export-ModuleMember -Function New-IntStatusHttpError, New-ValueDunderHttpError,
                              New-StatuslessHttpError, New-RetryAfterHttpError

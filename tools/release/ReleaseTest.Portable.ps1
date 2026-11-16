<#
.SYNOPSIS
    Portable-ZIP steps of the release test (Windows). Dot-source after
    ReleaseTest.Functions.ps1.

.DESCRIPTION
    Starts Start-IdentityAtlas.ps1 the way docs/architecture/desktop-portable.md
    says to (pwsh -ExecutionPolicy Bypass -File .\Start-IdentityAtlas.ps1), with
    -NoBrowser because a runner has no one to look at the browser, and with
    IA_DATA_DIR pointed at a folder of the test's own, so an upgrade can hand
    the same data directory to the next release.
#>

Set-StrictMode -Version Latest

$script:PortableZips = @{ default = 'IdentityAtlas-portable.zip'; postgres = 'IdentityAtlas-portable-postgres.zip' }

function Get-PortableZipName {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][ValidateSet('default', 'postgres')][string] $Variant)
    $script:PortableZips[$Variant]
}

function Get-PortableDatabase {
    <#
    .SYNOPSIS
        The -Database value for a variant.
    .DESCRIPTION
        The -postgres ZIP is started with -Database Postgres, as its docs say.
        `Auto` would also pick PostgreSQL there, but it falls back to PGlite
        when the binaries are blocked, and a test of the PostgreSQL ZIP that
        quietly ran on PGlite would pass without testing it.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][ValidateSet('default', 'postgres')][string] $Variant)
    if ($Variant -eq 'postgres') { return 'Postgres' }
    return 'Auto'
}

function Expand-PortableZip {
    <# Unpacks a ZIP and returns the folder that holds Start-IdentityAtlas.ps1. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $Zip, [Parameter(Mandatory)][string] $Destination)
    Expand-Archive -Path $Zip -DestinationPath $Destination -Force
    $launcher = Get-ChildItem $Destination -Recurse -Filter 'Start-IdentityAtlas.ps1' | Select-Object -First 1
    if (-not $launcher) { throw "$Zip has no Start-IdentityAtlas.ps1." }
    $launcher.DirectoryName
}

function Start-Portable {
    <# Starts the launcher in the background; returns its process. Output goes to $LogFile. #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string] $AppDir,
        [Parameter(Mandatory)][string] $DataDir,
        [Parameter(Mandatory)][string] $Database,
        [Parameter(Mandatory)][string] $LogFile
    )
    $env:IA_DATA_DIR = $DataDir
    $launchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $AppDir 'Start-IdentityAtlas.ps1'), '-NoBrowser', '-Database', $Database)
    if (-not $PSCmdlet.ShouldProcess($AppDir, 'start the portable app')) { return $null }
    Start-Process pwsh -ArgumentList $launchArgs -WorkingDirectory $AppDir -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -PassThru
}

function Test-PortListening {
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)][int] $Port)
    [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Stop-Portable {
    <#
    .SYNOPSIS
        Ends the launcher and waits until the app and PostgreSQL have let go.
    .DESCRIPTION
        Killing the launcher is how a user closing its window ends it. The
        watchdog (Watch-IdentityAtlas.ps1) then stops node.exe and PostgreSQL
        with a fast, clean shutdown. Waiting for both ports to close is what
        makes the next start a real restart and not a second launcher.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] $Process, [int] $AppPort = 3001, [int] $PostgresPort = 5433)
    if (-not $PSCmdlet.ShouldProcess("launcher $($Process.Id)", 'stop')) { return }
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Wait-Until -Description 'the portable app and PostgreSQL to stop' -TimeoutSec 180 -IntervalSec 2 -Condition {
        -not (Test-PortListening $AppPort) -and -not (Test-PortListening $PostgresPort)
    } | Out-Null
}

function Get-ApiTotal {
    <# What the API reports as totals: users, resources, and the matrix's user count. #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string] $BaseUrl)
    @{
        Users     = [long](Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Path '/users?limit=1') 'total')
        Resources = [long](Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Path '/resources?limit=1') 'total')
        Matrix    = [long](Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Path '/permissions?userLimit=1') 'totalUsers')
    }
}

function Assert-MatrixPage {
    <# One page of the matrix (25 users) comes back with rows, and the UI answers. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl)
    $page = Invoke-Api -BaseUrl $BaseUrl -Path '/permissions?userLimit=25' -TimeoutSec 120
    $rows = @(Get-Prop $page 'data')
    if ($rows.Count -eq 0) { throw 'The matrix returned no rows.' }
    if ((Get-HttpStatus -Url ($BaseUrl -replace '/api$', '/')) -ne 200) { throw 'The UI does not answer on /.' }
}

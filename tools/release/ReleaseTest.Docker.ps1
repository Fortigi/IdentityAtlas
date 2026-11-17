<#
.SYNOPSIS
    Docker Compose steps of the release test. Dot-source after
    ReleaseTest.Functions.ps1.

.DESCRIPTION
    Every command here is the one an operator types from
    docs/quickstart.md and docs/admin/backup-restore-upgrade.md, run in the
    directory that holds docker-compose.prod.yml and its .env. Keep them that
    way: the point of the release test is that the documented procedure works,
    not that some other procedure does.
#>

Set-StrictMode -Version Latest

$script:ComposeFile = 'docker-compose.prod.yml'

# The three quickstart lines (docs/quickstart.md, Linux / macOS tab), verbatim.
# test/unit/ReleaseTestFunctions.Tests.ps1 fails when the quickstart no longer
# contains them, so the fresh-install test cannot quietly drift from the docs.
$script:QuickstartLines = @(
    'curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml'
    '[ -f .env ] || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env'
    'docker compose -f docker-compose.prod.yml up -d --pull always'
)

# The two .env lines docs/reference/report-generator.md adds to switch it on.
$script:ReportGeneratorEnv = [ordered]@{ COMPOSE_PROFILES = 'report-generator'; FEATURE_CUSTOM_REPORTS = 'true' }

function Get-QuickstartLine {
    [CmdletBinding()]
    [OutputType([string[]])]
    param()
    $script:QuickstartLines
}

function Get-QuickstartScript {
    <#
    .SYNOPSIS
        The quickstart as a bash script, for one candidate.
    .DESCRIPTION
        Two substitutions, both from the docs: the compose file comes from the
        candidate's ref instead of main (an older release's images need that
        release's compose file — see COMPOSE_FILE_VERSION in it), and the
        channel is chosen with an IMAGE_TAG= prefix, as under "Image channels".
        With -ReportGenerator, the two .env lines from the report-generator
        page go in between creating .env and starting; -ExtraEnv adds more
        there (the sign-in variant's three AUTH_* lines from
        docs/admin/authentication.md).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string] $Ref,
        [Parameter(Mandatory)][string] $ImageTag,
        [switch] $ReportGenerator,
        [System.Collections.IDictionary] $ExtraEnv = @{}
    )
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('set -euo pipefail')
    $lines.Add($script:QuickstartLines[0].Replace('/main/', "/$Ref/"))
    $lines.Add($script:QuickstartLines[1])
    $envLines = [ordered]@{}
    if ($ReportGenerator) { foreach ($k in $script:ReportGeneratorEnv.Keys) { $envLines[$k] = $script:ReportGeneratorEnv[$k] } }
    foreach ($k in $ExtraEnv.Keys) { $envLines[$k] = $ExtraEnv[$k] }
    foreach ($k in $envLines.Keys) {
        if ($envLines[$k] -notmatch '^[\w.:/@-]*$') { throw "Refusing .env value for ${k}: only plain identifiers are written into the script." }
        $lines.Add("echo `"$k=$($envLines[$k])`" >> .env")
    }
    $lines.Add("IMAGE_TAG=$ImageTag $($script:QuickstartLines[2])")
    ($lines -join "`n") + "`n"
}

function Set-EnvValue {
    <# Sets NAME=value in a .env file: replaces the line when present, appends otherwise. #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)][AllowEmptyString()][string] $Value
    )
    $lines = @(if (Test-Path $Path) { Get-Content $Path })
    $kept = @($lines | Where-Object { $_ -notmatch "^$([regex]::Escape($Name))=" })
    if ($PSCmdlet.ShouldProcess($Path, "set $Name")) {
        Set-Content -Path $Path -Value (@($kept) + "$Name=$Value") -Encoding ascii
    }
}

function Get-EnvValue {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][string] $Name)
    $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
    if ($line) { return $line.Substring($Name.Length + 1) }
    return $null
}

$script:ComposeTimeoutSec = 900

function Get-ComposeCommand {
    <#
    .SYNOPSIS
        The command line Invoke-Compose runs: docker compose under `timeout`.
    .DESCRIPTION
        The first upgrade run hung for 75 minutes without a line of output:
        some compose call blocked outside every Wait-Until. `timeout` turns
        such a hang into a failure that names the command (exit 124).
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string[]] $Arguments = @(), [int] $TimeoutSec = $script:ComposeTimeoutSec)
    @('timeout', "$TimeoutSec", 'docker', 'compose', '-f', $script:ComposeFile) + $Arguments
}

function Invoke-Compose {
    <#
    .SYNOPSIS
        docker compose -f docker-compose.prod.yml <args>, failing on a non-zero
        exit or after $script:ComposeTimeoutSec seconds.
    .DESCRIPTION
        Logs the command first, so the last line of a stuck run says where it
        is, and gives it an empty stdin, so nothing can sit waiting for input.

        Deliberately a SIMPLE function reading $args, not [CmdletBinding()]: an
        advanced function binds `-d` to its own -Debug and `-v` to -Verbose, so
        `up -d` reached docker as `up` (which never returns) and `down -v` would
        have kept the volumes. test/unit/ReleaseTestFunctions.Tests.ps1 pins it.
    #>
    $Arguments = @($args | ForEach-Object { "$_" })
    $cmd = Get-ComposeCommand -Arguments $Arguments
    Write-Host "> docker compose $($Arguments -join ' ')"
    $out = $null | & $cmd[0] @($cmd[1..($cmd.Count - 1)]) 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 124) { throw "docker compose $($Arguments -join ' ') did not finish within $($script:ComposeTimeoutSec) s." }
    if ($code -ne 0) { throw "docker compose $($Arguments -join ' ') failed:`n$($out -join "`n")" }
    $out
}

function Invoke-Psql {
    <# One psql query inside the postgres container; returns the unaligned rows. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Query)
    $escaped = $Query.Replace("'", "'\''")
    Invoke-Compose exec -T postgres sh -c "psql -U `$POSTGRES_USER -d `$POSTGRES_DB -v ON_ERROR_STOP=1 -tAc '$escaped'"
}

function ConvertFrom-PsqlCount {
    <# 'Table|123' rows from psql -tA into a hashtable. #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string[]] $Rows = @())
    $counts = @{}
    foreach ($row in $Rows) {
        if ($row -match '^([A-Za-z]+)\|(\d+)$') { $counts[$Matches[1]] = [long]$Matches[2] }
    }
    $counts
}

function Get-RowCountQuery {
    <# A query counting the given tables, which must all exist (check first). #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string[]] $Table)
    ($Table | ForEach-Object { "SELECT '$_', count(*) FROM `"$_`"" }) -join ' UNION ALL '
}

function Get-DbRowCount {
    <# Row counts of the core tables that exist in this version's schema. #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()
    $names = (Get-CoreTable | ForEach-Object { "'$_'" }) -join ','
    $existing = @(Invoke-Psql "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ($names)" |
        Where-Object { $_ })
    if ($existing.Count -eq 0) { return @{} }
    ConvertFrom-PsqlCount -Rows (Invoke-Psql (Get-RowCountQuery -Table $existing))
}

function Get-ComposeFile {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Ref)
    Invoke-WebRequest -Uri (Get-ComposeUrl -Ref $Ref) -OutFile $script:ComposeFile -ErrorAction Stop
}

function New-EnvFile {
    <# .env for a deployment started by the test itself (the upgrade scenario). #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $ImageTag, [switch] $ReportGenerator)
    $bytes = [byte[]]::new(24)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    Set-EnvValue -Path .env -Name POSTGRES_PASSWORD -Value (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
    Set-EnvValue -Path .env -Name IMAGE_TAG -Value $ImageTag
    if ($ReportGenerator) {
        foreach ($k in $script:ReportGeneratorEnv.Keys) { Set-EnvValue -Path .env -Name $k -Value $script:ReportGeneratorEnv[$k] }
    }
}

function Get-WorkerKey {
    <# The built-in crawler API key the web container writes for the worker. #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $key = Wait-Until -Description 'the built-in worker API key' -TimeoutSec 120 -Condition {
        ((Invoke-Compose exec -T worker cat /data/uploads/.builtin-worker-key) -join '').Trim()
    }
    return $key
}

function Backup-Deployment {
    <#
    .SYNOPSIS
        "Back up" from docs/admin/backup-restore-upgrade.md, steps 1-3.
    .OUTPUTS
        The master key (step 2), for the restore.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $BackupDir)
    New-Item -ItemType Directory -Force $BackupDir | Out-Null
    Invoke-Compose exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER -d $POSTGRES_DB -Fc -f /tmp/identity-atlas.dump' | Out-Null
    Invoke-Compose cp postgres:/tmp/identity-atlas.dump ./identity-atlas.dump | Out-Null
    Invoke-Compose exec -T postgres rm /tmp/identity-atlas.dump | Out-Null
    $key = ((Invoke-Compose exec -T web cat /data/keys/.master-key) -join '').Trim()
    if (-not $key) { throw 'The master key could not be read from the web container.' }
    Copy-Item .env, $script:ComposeFile, identity-atlas.dump -Destination $BackupDir
    return $key
}

function Wait-PostgresReady {
    [CmdletBinding()]
    param()
    Wait-Until -Description 'postgres to accept connections' -TimeoutSec 180 -Condition {
        Invoke-Compose exec -T postgres sh -c 'pg_isready -U $POSTGRES_USER -d $POSTGRES_DB' | Out-Null
        $true
    } | Out-Null
}

function Restore-Deployment {
    <#
    .SYNOPSIS
        "Restore" from docs/admin/backup-restore-upgrade.md onto a host where
        Identity Atlas is not running: the volumes are removed first, so the
        restore cannot lean on anything the old deployment left behind.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $MasterKey)
    Invoke-Compose down -v | Out-Null
    Set-EnvValue -Path .env -Name IDENTITY_ATLAS_MASTER_KEY -Value $MasterKey      # step 2
    Invoke-Compose up -d postgres | Out-Null                                       # step 3
    Wait-PostgresReady
    Invoke-Compose cp ./identity-atlas.dump postgres:/tmp/identity-atlas.dump | Out-Null   # step 4
    Invoke-Compose exec -T postgres sh -c 'pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists --no-owner /tmp/identity-atlas.dump' | Out-Null
    Invoke-Compose exec -T postgres rm /tmp/identity-atlas.dump | Out-Null
    Invoke-Compose up -d | Out-Null                                                # step 5
}

function Get-ComposeService {
    <# Running services as name -> @{ State; Health }, from docker compose ps. #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param()
    $services = @{}
    foreach ($line in (Invoke-Compose ps --format json)) {
        foreach ($s in @($line | ConvertFrom-Json)) { $services[$s.Service] = @{ State = $s.State; Health = $s.Health } }
    }
    $services
}

function Get-MissingService {
    <# Which expected services are not running (postgres must also be healthy). #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][hashtable] $Services, [Parameter(Mandatory)][string[]] $Expected)
    $missing = foreach ($name in $Expected) {
        $s = $Services[$name]
        if (-not $s -or $s.State -ne 'running') { "$name (not running)" }
        elseif ($name -eq 'postgres' -and $s.Health -ne 'healthy') { "postgres ($($s.Health))" }
    }
    @($missing)
}

function Assert-RunningVersion {
    <# /api/version names the candidate's image version and the compose file is current. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][string] $ImageTag)
    $v = Invoke-Api -BaseUrl $BaseUrl -Path '/version'
    $running = Get-Prop $v 'version'
    if ($ImageTag -notin 'edge', 'beta', 'latest' -and $running -ne $ImageTag) {
        throw "Expected version $ImageTag, the running app reports '$running'."
    }
    if (Get-Prop $v 'composeFileOutdated') { throw "The app reports its compose file as outdated (version $(Get-Prop $v 'composeFileVersion'))." }
}

function Assert-ReportGenerator {
    <#
    .SYNOPSIS
        The report generator is reachable and answers one plain question.
    .DESCRIPTION
        The first question after a start prepares the prompt cache (minutes on
        a 2-CPU container), so the timeout is long. A reply the model produced
        passes; an error, a refusal or no reply fails.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token = '')
    Wait-Until -Description 'the report generator to report itself available' -TimeoutSec 600 -IntervalSec 10 -Condition {
        (Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Path '/nl-reports/status' -Token $Token) 'available') -eq $true
    } | Out-Null
    $reply = Invoke-Api -BaseUrl $BaseUrl -Path '/nl-reports/interpret' -Method Post -Token $Token -TimeoutSec 900 `
        -Body @{ question = 'Show all users with their department' }
    if (-not (Test-ReportGeneratorAnswer $reply)) {
        throw "The report generator did not answer: kind='$(Get-Prop $reply 'kind')' $(Get-Prop $reply 'message')"
    }
}

function Assert-NoMissingKeyLog {
    <# The restore must not have started without the vault key it needs. #>
    [CmdletBinding()]
    param()
    $log = (Invoke-Compose logs web) -join "`n"
    if ($log -match 'No master key found') { throw 'The web container started without the master key after the restore.' }
}

function Assert-ReadTokenStored {
    <#
    .SYNOPSIS
        The kept read API key would still sign in: an unrevoked ReadApiKeys row
        holds its hash, which is exactly what the API looks the key up by.
    .DESCRIPTION
        The Docker scenarios run with sign-in off, where the API never checks a
        key, so a request with it would prove nothing. Assert-ReadTokenSignIn
        (ReleaseTest.CuratedData.ps1) makes the request when sign-in is on.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $Token, [Parameter(Mandatory)][string] $Label)
    $found = ((Invoke-Psql (Get-ReadTokenHashQuery $Token)) -join '').Trim()
    if ($found -ne '1') { throw "${Label}: the kept read API key is no longer stored (found $found matching rows)." }
}

function Write-Diagnostic {
    <# Container state and the last log lines, for a failed run. Never throws. #>
    [CmdletBinding()]
    param()
    try {
        & docker compose -f $script:ComposeFile ps -a 2>&1 | Out-Host
        & docker compose -f $script:ComposeFile logs --tail 150 2>&1 | Out-Host
    } catch {
        Write-Warning "Could not collect diagnostics: $_"
    }
}

<#
.SYNOPSIS
    Query the Identity Atlas postgres database from PowerShell test scripts.

.DESCRIPTION
    The one way PowerShell reaches the database. v5 dropped SQL Server, so there
    is no MSSQL driver to use — and `System.Data.SqlClient` isn't available on
    PowerShell 7 anyway. Everything goes through psql inside the postgres
    container via `docker compose exec`.

    Enforced by the Tier 3 scan in app/api/src/db/nativePg.guard.test.js: no .ps1
    may name a SQL Server client, the `dbo.` schema, or the v4 temporal sentinel.

    One rule for callers writing SQL: quote identifiers. The migrations create
    tables as `CREATE TABLE "Resources"`, so the PascalCase sticks. Unquoted
    `FROM Resources` folds to `resources` and does not resolve. Same for
    camelCase columns: `"principalType"`, not `principalType`.

    Ordinary single-quoted SQL literals ('ServicePrincipal') are fine. Note that
    Run-NightlyLocal.ps1 carries a comment claiming single quotes do not survive
    the PowerShell -> docker compose exec -> sh -> psql chain on Windows, and
    dollar-quotes ($$public$$) to work around it. That was tested against this
    module and is not true for SQL sent on **stdin** — `WHERE schemaname =
    'public'` round-trips correctly. The quoting hazard is real only for SQL
    passed as a `-c` argument, where it crosses argv boundaries. This module
    never uses -c, so callers can write normal SQL.

    Errors are loud: psql runs with ON_ERROR_STOP=1 and any error throws rather
    than returning $null. A silent $null is what let the v4 queries in these
    scripts look "passing-ish" instead of broken.

.EXAMPLE
    Import-Module "$PSScriptRoot/../lib/PgQuery.psm1"
    Get-PgCount "SELECT COUNT(*) FROM ""Principals"" WHERE ""principalType"" = 'User'"
#>

Set-StrictMode -Version Latest

# Populated on first use by Get-PgSoftDeleteTables. Must be initialised:
# Set-StrictMode throws on reading a never-assigned variable.
$script:SoftDeleteTables = $null

# Defaults match docker-compose.yml. ComposeFile empty = plain `docker compose`,
# which resolves docker-compose.yml in the working directory; CI runs its stack
# from docker-compose.ci.yml and must pass that explicitly.
$script:PgConn = @{
    Service     = 'postgres'
    User        = 'identity_atlas'
    Password    = 'identity_atlas_local'
    Database    = 'identity_atlas'
    ComposeFile = ''
}

function Set-PgConnection {
    <#
    .SYNOPSIS
        Override the postgres connection defaults for this session.
    #>
    [CmdletBinding()]
    param(
        [string]$Service,
        [string]$User,
        [string]$Password,
        [string]$Database,
        [string]$ComposeFile
    )
    foreach ($k in 'Service', 'User', 'Password', 'Database', 'ComposeFile') {
        if ($PSBoundParameters.ContainsKey($k)) { $script:PgConn[$k] = $PSBoundParameters[$k] }
    }
}

function Get-PgConnection {
    [CmdletBinding()]
    param()
    return $script:PgConn.Clone()
}

# psql diagnostics, and the `(N rows)` footer. Anything else on stdout is data.
$script:PsqlNoiseRe = '^(ERROR|FATAL|PANIC|DETAIL|HINT|CONTEXT|STATEMENT|LINE \d+)\b|^\(\d+ rows?\)$'
$script:PsqlErrorRe = '^(ERROR|FATAL|PANIC)\b'

function ConvertFrom-PsqlOutput {
    <#
    .SYNOPSIS
        Split raw psql output into data rows and error lines.

    .DESCRIPTION
        Kept separate from the transport so it can be unit-tested without Docker.
        `docker compose exec ... 2>&1` merges stderr into the stream as
        ErrorRecord objects, which have no .Trim() — coerce to string first.
    #>
    [CmdletBinding()]
    param([AllowNull()][object[]]$Output)

    $rows = [System.Collections.Generic.List[string]]::new()
    $errors = [System.Collections.Generic.List[string]]::new()

    foreach ($line in @($Output)) {
        if ($null -eq $line) { continue }
        $isErrRecord = $line -is [System.Management.Automation.ErrorRecord]
        $text = ([string]$line).Trim()
        if ($text -eq '') { continue }

        if ($text -match $script:PsqlErrorRe) { $errors.Add($text); continue }
        # A non-error line on stderr is still diagnostic noise, not data.
        if ($isErrRecord) { $errors.Add($text); continue }
        if ($text -match $script:PsqlNoiseRe) { continue }
        $rows.Add($text)
    }

    return [pscustomobject]@{
        Rows   = $rows.ToArray()
        Errors = $errors.ToArray()
    }
}

function Invoke-Psql {
    <#
    .SYNOPSIS
        Run one SQL statement through psql in the postgres container.

    .DESCRIPTION
        The transport, isolated so tests can mock it. SQL goes in on stdin —
        never as a -c argument — so nothing in it has to survive shell quoting.
        MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the psql args
        as paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Query,
        [Parameter(Mandatory)][hashtable]$Connection
    )

    # `docker compose -f <file>` when the caller named one (CI runs its stack from
    # docker-compose.ci.yml); plain `docker compose` otherwise.
    $composeArgs = @('compose')
    if ($Connection.ComposeFile) { $composeArgs += @('-f', $Connection.ComposeFile) }
    $composeArgs += @('exec', '-T', '-e', "PGPASSWORD=$($Connection.Password)", $Connection.Service,
                      'psql', '-U', $Connection.User, '-d', $Connection.Database, '-A', '-t', '-v', 'ON_ERROR_STOP=1')

    $had = Test-Path Env:MSYS_NO_PATHCONV
    $prev = if ($had) { $env:MSYS_NO_PATHCONV } else { $null }
    $env:MSYS_NO_PATHCONV = '1'
    try {
        $out = $Query | & docker @composeArgs 2>&1
        return @{ Output = @($out); ExitCode = $LASTEXITCODE }
    }
    finally {
        if ($had) { $env:MSYS_NO_PATHCONV = $prev }
        else { Remove-Item Env:MSYS_NO_PATHCONV -ErrorAction SilentlyContinue }
    }
}

function Invoke-PgQuery {
    <#
    .SYNOPSIS
        Run a query and return its rows as strings (one per line, -A -t format).

    .DESCRIPTION
        Throws if psql reports an error or exits non-zero — a broken query must
        not look like an empty result set.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Query)

    $result = Invoke-Psql -Query $Query -Connection $script:PgConn
    $parsed = ConvertFrom-PsqlOutput -Output $result.Output

    if ($parsed.Errors.Count -gt 0 -or $result.ExitCode -ne 0) {
        $detail = if ($parsed.Errors.Count -gt 0) { $parsed.Errors -join '; ' } else { "exit code $($result.ExitCode)" }
        throw "psql failed: $detail`nQuery: $Query"
    }
    # Leading comma stops PowerShell unwrapping a one-row result into a bare
    # string — assigning the result always yields an array, so .Count is safe.
    # Consequence: `Invoke-PgQuery ... | ForEach-Object` would see the array as a
    # single item. Assign first, then iterate. Do NOT wrap the call in @() either
    # — that re-wraps the emitted array into a 1-element array of arrays.
    return , $parsed.Rows
}

function Invoke-PgScalar {
    <#
    .SYNOPSIS
        Run a query and return the first column of the first row, or $null.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Query)

    $rows = Invoke-PgQuery -Query $Query
    if ($null -eq $rows -or $rows.Count -eq 0) { return $null }
    return ($rows[0] -split '\|')[0]
}

function Reset-PgSchemaCache {
    <#
    .SYNOPSIS
        Drop the cached soft-delete table list (call after a migration, or in tests).
    #>
    [CmdletBinding()]
    param()
    $script:SoftDeleteTables = $null
}

function Get-PgSoftDeleteTables {
    <#
    .SYNOPSIS
        Tables that use the v5 soft-delete lifecycle, read from the live schema.

    .DESCRIPTION
        Discovered rather than hard-coded so the list cannot drift from the
        migrations: today it's Principals / Resources / ResourceAssignments
        (040_soft_delete.sql), but a later migration adding "deletedAt" elsewhere
        is picked up for free. Cached — the schema doesn't move mid-run.
    #>
    [CmdletBinding()]
    param()
    if ($null -eq $script:SoftDeleteTables) {
        $script:SoftDeleteTables = Invoke-PgQuery -Query @'
SELECT table_name FROM information_schema.columns
WHERE column_name = 'deletedAt' AND table_schema = 'public'
ORDER BY table_name
'@
    }
    return , $script:SoftDeleteTables
}

function Get-PgLiveCount {
    <#
    .SYNOPSIS
        Count the live (non-tombstoned) rows in a table.

    .DESCRIPTION
        The v5 replacement for the v4 `WHERE ValidTo = '9999-12-31...'` predicate.
        v5 dropped temporal tables but did NOT stop hiding removed entities — it
        soft-deletes them by stamping "deletedAt" (040_soft_delete.sql), and the
        live views filter `deletedAt IS NULL`. So a v4 temporal check ports to
        this, NOT to an unfiltered COUNT(*): dropping the predicate outright would
        silently start counting tombstoned leavers and deleted resources.

        Tables without a "deletedAt" column are counted unfiltered.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Table)

    $where = if ((Get-PgSoftDeleteTables) -contains $Table) { ' WHERE "deletedAt" IS NULL' } else { '' }
    return Get-PgCount -Query "SELECT COUNT(*) FROM ""$Table""$where"
}

function Get-PgCount {
    <#
    .SYNOPSIS
        Run a COUNT query and return the number.

    .DESCRIPTION
        Throws on a non-numeric result rather than coercing it to 0 — a query
        that returned something unexpected is a bug, not a zero.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Query)

    $value = Invoke-PgScalar -Query $Query
    if ($null -eq $value -or $value -eq '') { return 0 }

    $parsed = 0
    if (-not [int]::TryParse($value, [ref]$parsed)) {
        throw "Expected a number from: $Query`nGot: $value"
    }
    return $parsed
}

Export-ModuleMember -Function Set-PgConnection, Get-PgConnection, ConvertFrom-PsqlOutput,
    Invoke-Psql, Invoke-PgQuery, Invoke-PgScalar, Get-PgCount,
    Get-PgSoftDeleteTables, Get-PgLiveCount, Reset-PgSchemaCache

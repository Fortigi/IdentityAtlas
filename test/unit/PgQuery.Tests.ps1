# Tests for test/lib/PgQuery.psm1 — the single way PowerShell reaches postgres.
#
# The transport (Invoke-Psql) is mocked so these run without Docker. The parsing
# and error-surfacing logic is what actually matters here: the v4 scripts these
# replaced swallowed psql failures into $null, which read as "0 rows" and let a
# broken query masquerade as a passing check.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'lib' 'PgQuery.psm1') -Force
}

AfterAll {
    Remove-Module PgQuery -Force -ErrorAction SilentlyContinue
}

Describe 'ConvertFrom-PsqlOutput' {
    It 'returns plain lines as rows' {
        $r = ConvertFrom-PsqlOutput -Output @('alice', 'bob')
        $r.Rows | Should -Be @('alice', 'bob')
        $r.Errors | Should -BeNullOrEmpty
    }

    It 'trims whitespace and drops blank lines' {
        $r = ConvertFrom-PsqlOutput -Output @('  alice  ', '', '   ', 'bob')
        $r.Rows | Should -Be @('alice', 'bob')
    }

    It 'drops the (N rows) footer' {
        $r = ConvertFrom-PsqlOutput -Output @('alice', '(1 row)')
        $r.Rows | Should -Be @('alice')
    }

    It 'classifies ERROR/FATAL lines as errors, not data' {
        $r = ConvertFrom-PsqlOutput -Output @('ERROR:  relation "Nope" does not exist')
        $r.Rows | Should -BeNullOrEmpty
        $r.Errors.Count | Should -Be 1
    }

    It 'drops psql diagnostic continuation lines' {
        # LINE/DETAIL/HINT follow an ERROR; they are noise, never data.
        $r = ConvertFrom-PsqlOutput -Output @('LINE 1: SELECT * FROM "Nope"', 'HINT:  check the name')
        $r.Rows | Should -BeNullOrEmpty
    }

    It 'treats stderr ErrorRecords as errors even without an ERROR prefix' {
        # `docker compose exec ... 2>&1` merges stderr in as ErrorRecord objects,
        # which have no .Trim() — the docker daemon being down arrives this way.
        $rec = [System.Management.Automation.ErrorRecord]::new(
            [Exception]::new('cannot connect to the Docker daemon'), 'x', 'NotSpecified', $null)
        $r = ConvertFrom-PsqlOutput -Output @($rec)
        $r.Rows | Should -BeNullOrEmpty
        $r.Errors.Count | Should -Be 1
    }

    It 'handles null and empty input' {
        (ConvertFrom-PsqlOutput -Output $null).Rows | Should -BeNullOrEmpty
        (ConvertFrom-PsqlOutput -Output @()).Rows | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-PgQuery' {
    It 'returns rows on success' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @('a', 'b'); ExitCode = 0 } }
        # Assign, don't pipe: the function returns the array as one object so that
        # a single row can't unwrap to a bare string (see PgQuery.psm1).
        $rows = Invoke-PgQuery -Query 'SELECT 1'
        $rows | Should -Be @('a', 'b')
    }

    It 'returns an array even for a single row' {
        # PowerShell unwraps one-element arrays on return; callers rely on .Count.
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @('only'); ExitCode = 0 } }
        $rows = Invoke-PgQuery -Query 'SELECT 1'
        $rows.Count | Should -Be 1
    }

    It 'returns an empty array for no rows' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @(); ExitCode = 0 } }
        (Invoke-PgQuery -Query 'SELECT 1').Count | Should -Be 0
    }

    It 'throws when psql reports an error' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @('ERROR:  boom'); ExitCode = 1 } }
        { Invoke-PgQuery -Query 'SELECT 1' } | Should -Throw -ExpectedMessage '*boom*'
    }

    It 'throws on a non-zero exit even when nothing looks like an error line' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @(); ExitCode = 2 } }
        { Invoke-PgQuery -Query 'SELECT 1' } | Should -Throw -ExpectedMessage '*exit code 2*'
    }

    It 'never reports an error as an empty result set' {
        # The regression that made #707 invisible: failure must not look like 0 rows.
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @('ERROR:  column "validto" does not exist'); ExitCode = 1 } }
        { Invoke-PgQuery -Query 'SELECT 1' } | Should -Throw
    }
}

Describe 'Invoke-PgScalar' {
    It 'returns the first column of the first row' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @('42|extra'); ExitCode = 0 } }
        Invoke-PgScalar -Query 'SELECT 1' | Should -Be '42'
    }

    It 'returns $null when there are no rows' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @(); ExitCode = 0 } }
        Invoke-PgScalar -Query 'SELECT 1' | Should -BeNullOrEmpty
    }
}

Describe 'Get-PgCount' {
    It 'parses a numeric count' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @('27'); ExitCode = 0 } }
        Get-PgCount -Query 'SELECT COUNT(*) FROM "Principals"' | Should -Be 27
    }

    It 'returns 0 for an empty result' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @(); ExitCode = 0 } }
        Get-PgCount -Query 'SELECT COUNT(*) FROM "Principals"' | Should -Be 0
    }

    It 'throws on a non-numeric result rather than coercing to 0' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @('banana'); ExitCode = 0 } }
        { Get-PgCount -Query 'SELECT 1' } | Should -Throw -ExpectedMessage '*banana*'
    }

    It 'propagates a psql error instead of returning 0' {
        Mock Invoke-Psql -ModuleName PgQuery { @{ Output = @('ERROR:  nope'); ExitCode = 1 } }
        { Get-PgCount -Query 'SELECT 1' } | Should -Throw
    }
}

Describe 'Get-PgLiveCount' {
    BeforeEach {
        Reset-PgSchemaCache
    }

    It 'filters out tombstoned rows on a soft-delete table' {
        # The v4 `ValidTo = <sentinel>` predicate ports to `deletedAt IS NULL` —
        # NOT to an unfiltered COUNT(*), which would count deleted rows.
        $script:seen = $null
        Mock Invoke-Psql -ModuleName PgQuery {
            if ($Query -match 'information_schema') { return @{ Output = @('Principals', 'Resources', 'ResourceAssignments'); ExitCode = 0 } }
            $script:seen = $Query
            return @{ Output = @('5'); ExitCode = 0 }
        }
        Get-PgLiveCount -Table 'Principals' | Should -Be 5
        $script:seen | Should -Match '"deletedAt" IS NULL'
    }

    It 'does not filter a table that has no deletedAt column' {
        $script:seen = $null
        Mock Invoke-Psql -ModuleName PgQuery {
            if ($Query -match 'information_schema') { return @{ Output = @('Principals', 'Resources', 'ResourceAssignments'); ExitCode = 0 } }
            $script:seen = $Query
            return @{ Output = @('3'); ExitCode = 0 }
        }
        Get-PgLiveCount -Table 'Contexts' | Should -Be 3
        $script:seen | Should -Not -Match 'deletedAt'
    }

    It 'derives the soft-delete list from the schema rather than a hard-coded list' {
        # A later migration adding deletedAt elsewhere must be picked up for free.
        Mock Invoke-Psql -ModuleName PgQuery {
            if ($Query -match 'information_schema') { return @{ Output = @('Contexts'); ExitCode = 0 } }
            return @{ Output = @('1'); ExitCode = 0 }
        }
        Get-PgSoftDeleteTables | Should -Be @('Contexts')
    }

    It 'caches the schema lookup instead of re-querying per table' {
        Mock Invoke-Psql -ModuleName PgQuery {
            if ($Query -match 'information_schema') { return @{ Output = @('Principals'); ExitCode = 0 } }
            return @{ Output = @('1'); ExitCode = 0 }
        }
        Get-PgLiveCount -Table 'Principals' | Out-Null
        Get-PgLiveCount -Table 'Resources' | Out-Null
        Should -Invoke Invoke-Psql -ModuleName PgQuery -Exactly 1 `
            -ParameterFilter { $Query -match 'information_schema' }
    }
}

Describe 'Set-PgConnection' {
    It 'defaults to the docker-compose postgres credentials' {
        $c = Get-PgConnection
        $c.User | Should -Be 'identity_atlas'
        $c.Database | Should -Be 'identity_atlas'
        $c.Service | Should -Be 'postgres'
    }

    It 'overrides only the fields it is given' {
        Set-PgConnection -Database 'other_db'
        $c = Get-PgConnection
        $c.Database | Should -Be 'other_db'
        $c.User | Should -Be 'identity_atlas'
        Set-PgConnection -Database 'identity_atlas'   # restore
    }

    It 'defaults to no compose file (plain `docker compose`)' {
        (Get-PgConnection).ComposeFile | Should -BeNullOrEmpty
    }

    It 'accepts a compose file override' {
        # CI starts its stack from docker-compose.ci.yml; a plain `docker compose`
        # would resolve docker-compose.yml instead and miss the running services.
        Set-PgConnection -ComposeFile 'docker-compose.ci.yml'
        (Get-PgConnection).ComposeFile | Should -Be 'docker-compose.ci.yml'
        Set-PgConnection -ComposeFile ''   # restore
    }
}

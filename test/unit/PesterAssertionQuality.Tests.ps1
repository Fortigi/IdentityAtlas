#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Guards against two assertion patterns that read as strict but assert nothing.

.DESCRIPTION
    Both patterns below shipped in this repo, both survived code review, and both
    were invisible to line coverage. Mutation testing is what exposed them, which
    makes them worth pinning here rather than rediscovering.

    ── 1. Bare `Should -Invoke -Times N` is an AT-LEAST assertion ───────────────

    Verified against Pester 5.8: a mock called THREE times satisfies
    `Should -Invoke Foo -Times 1`. Only `-Exactly` pins the count. (`-Times 0` is
    special-cased by Pester as exact, so it is safe and is not counted here.)

    So a test named "throws on HTTP 400, without retrying" whose only count
    assertion is `-Times 1` still passes when the code retries five times. That
    reads as a guard against retry storms and is not one.

    This is a RATCHET, not a ban. "At least N" is occasionally what you mean — a
    retry happened at least once, a logger fired at least once. Express that by
    OMITTING -Times, which reads honestly, rather than by naming a count you do
    not mean. The tally is at 0 and may only go down.

    ── 2. Hand-rolled HTTP-error fixtures drift from their reader ───────────────

    Helpers in this repo read a caught error's status two different ways:

        Get-FGHttpStatus        [int]$err.Exception.Response.StatusCode
        Get-FGIngestErrorDetail $err.Exception.Response.StatusCode.value__
        Get-ODataResponseStatus $err.Exception.Response.StatusCode.value__

    A fixture built for one returns $null under another — the [int] cast on a
    PSCustomObject throws, and the helper's own try/catch swallows it. The test
    then passes down the "no status code at all" branch, no matter which status
    its name claims to be about.

    test/lib/HttpErrorFixtures.psm1 owns these shapes so they cannot drift again.
    The tests below pin its contract, including the part that bites: the two
    shapes are NOT interchangeable.

.USAGE
    Invoke-Pester -Path test/unit/PesterAssertionQuality.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:unitDir  = Join-Path $script:repoRoot 'test' 'unit'

    Import-Module (Join-Path $script:repoRoot 'test' 'lib' 'HttpErrorFixtures.psm1') -Force

    # Committed floor. The suite is clean; this may only ever stay at 0.
    $script:BARE_TIMES_BASELINE = 0

    function Measure-BareTimes {
        param([string]$Path)
        $rx = [regex]'Should\s+-Invoke\b(?<args>[^\r\n]*)'
        $n  = 0
        foreach ($m in $rx.Matches((Get-Content $Path -Raw))) {
            $a = $m.Groups['args'].Value
            if ($a -match '-Exactly') { continue }
            # -Times 0 is exact in Pester, so it is not part of the problem.
            if ($a -match '-Times\s+(\d+)' -and [int]$Matches[1] -ge 1) { $n++ }
        }
        return $n
    }

    $script:bareByFile = @{}
    Get-ChildItem $script:unitDir -Filter '*.Tests.ps1' -File | ForEach-Object {
        $c = Measure-BareTimes -Path $_.FullName
        if ($c -gt 0) { $script:bareByFile[$_.Name] = $c }
    }
    $script:bareTotal = ($script:bareByFile.Values | Measure-Object -Sum).Sum
    if (-not $script:bareTotal) { $script:bareTotal = 0 }
}

Describe 'Pester assertion quality — bare -Times ratchet' {

    It 'the scanner actually finds Should -Invoke calls (guard is not vacuous)' {
        # If the regex ever stops matching, the ratchet would pass at zero and
        # silently stop guarding anything.
        $allInvokes = Get-ChildItem $script:unitDir -Filter '*.Tests.ps1' -File |
            ForEach-Object { ([regex]'Should\s+-Invoke\b').Matches((Get-Content $_.FullName -Raw)).Count } |
            Measure-Object -Sum
        $allInvokes.Sum | Should -BeGreaterThan 100
    }

    It 'the number of bare -Times assertions never rises' {
        $detail = ($script:bareByFile.GetEnumerator() | Sort-Object Value -Descending |
                   ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '
        $script:bareTotal | Should -BeLessOrEqual $script:BARE_TIMES_BASELINE -Because @"
bare 'Should -Invoke -Times N' is an AT-LEAST assertion — a mock called 3 times
satisfies -Times 1. Use -Exactly when you mean a count. Current: $detail
"@
    }

    It 'the suite still counts invocations at all' {
        # The cheapest way to satisfy the ratchet is to DELETE the count rather
        # than convert it to -Exactly, which trades a weak assertion for none.
        # A per-file "these stay clean" list cannot catch that — at a baseline of
        # 0 it can never fail independently of the tally above, so this guards
        # the other direction instead.
        $exactly = Get-ChildItem $script:unitDir -Filter '*.Tests.ps1' -File |
            ForEach-Object { ([regex]'Should\s+-Invoke\b[^\r\n]*-Exactly').Matches((Get-Content $_.FullName -Raw)).Count } |
            Measure-Object -Sum
        $exactly.Sum | Should -BeGreaterThan 250 -Because @"
the bare -Times tally is 0 because those assertions were converted to -Exactly,
not removed. A sharp drop here means counts were dropped instead of tightened.
"@
    }
}

Describe 'HttpErrorFixtures — the shapes are not interchangeable' {

    It 'New-IntStatusHttpError survives an [int] cast (the Get-FGHttpStatus shape)' {
        $err = New-IntStatusHttpError -Status 429
        [int]$err.Response.StatusCode | Should -Be 429
    }

    It 'New-IntStatusHttpError carries arbitrary codes the HttpStatusCode enum lacks' {
        # 499 and 599 have no enum member; casting them to [System.Net.HttpStatusCode]
        # throws, which is why this fixture uses a plain [int]. Boundary tests for a
        # 5xx range need exactly these values.
        foreach ($code in 499, 599) {
            [int]((New-IntStatusHttpError -Status $code).Response.StatusCode) | Should -Be $code
        }
    }

    It 'New-ValueDunderHttpError exposes .value__ (the Get-FGIngestErrorDetail shape)' {
        $err = New-ValueDunderHttpError -Status 503
        $err.Response.StatusCode.value__ | Should -Be 503
    }

    It 'the value__ shape does NOT survive an [int] cast — the original defect' {
        # This is the whole reason both fixtures exist. Handing this shape to a
        # reader that casts [int] yields $null, and the caller silently takes its
        # "no status code" path.
        $err = New-ValueDunderHttpError -Status 429
        { [int]$err.Response.StatusCode } | Should -Throw
    }

    It 'New-StatuslessHttpError carries no response at all' {
        $err = New-StatuslessHttpError
        $err.PSObject.Properties.Name | Should -Not -Contain 'Response'
        $err.Message | Should -Not -BeNullOrEmpty
    }

    It 'New-RetryAfterHttpError exposes both the status and the Retry-After header' {
        $err = New-RetryAfterHttpError -Status 429 -RetryAfterSeconds 42
        $err.Response.StatusCode.value__ | Should -Be 429
        $err.Response.Headers.GetValues('Retry-After') | Should -Be @('42')
    }

    It 'New-RetryAfterHttpError returns nothing for an unrelated header' {
        $err = New-RetryAfterHttpError -Status 429 -RetryAfterSeconds 5
        $err.Response.Headers.GetValues('X-Other') | Should -BeNullOrEmpty
    }
}

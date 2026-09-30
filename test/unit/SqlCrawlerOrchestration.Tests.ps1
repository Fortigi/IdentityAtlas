#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the end-of-run ordering in
    tools/crawlers/mssql/Start-SqlCrawler.ps1.

.DESCRIPTION
    The entry point runs live I/O the moment it is dot-sourced, so it cannot be
    tested by running it. What CAN be tested is the one region that carries a
    rule: the try/finally that decides what still happens when the run fails.

    Both halves of that rule were broken in production at once:

      * Test-SqlRunCounts THROWS, and the view refresh used to sit after it. A
        run that loaded 42.6 million assignments and then failed unrelated
        checks left both matrix views empty at 40 kB — the person detail page
        showed business roles and no entitlements, a team matrix showed zero,
        and the data underneath was perfect. Rows are committed batch by batch
        and are durable long before the verdict exists, so the refresh belongs
        in a `finally`.
      * Save-SqlWatermarks / Save-SqlSweepMarks must NOT move with it. An
        unverified run has to re-read its window and re-sweep next time rather
        than step over rows it never loaded. That is the whole point of the
        ordering.

    So the tests do two things. They assert the structure (which calls sit in
    the body and which in the finally), and then they EXECUTE the region's own
    source text — parsed out of the shipped file, not retyped here — against
    stubs, so a reordering that keeps the shape but changes the behaviour is
    caught as well.

.USAGE
    Invoke-Pester -Path test/unit/SqlCrawlerOrchestration.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:entryPath = Join-Path $script:repoRoot 'tools' 'crawlers' 'mssql' 'Start-SqlCrawler.ps1'
    $script:entryText = Get-Content -LiteralPath $script:entryPath -Raw

    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:entryPath, [ref]$null, [ref]$parseErrors)
    if ($parseErrors) { throw "Start-SqlCrawler.ps1 does not parse: $($parseErrors[0].Message)" }

    # The region under test: the try whose finally refreshes the views.
    $tries = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.TryStatementAst] }, $true)
    $script:guards = @($tries | Where-Object { $_.Finally -and $_.Finally.Extent.Text -match 'Update-SqlMatrixViews' })

    # ── Stubs. Each records its own name; two of them can be told to throw. ──
    $script:calls   = [System.Collections.Generic.List[string]]::new()
    $script:throwOn = ''

    function Get-SqlSlotsInOrder { param($Slots) return @($Slots) }
    function Invoke-SqlSlot {
        param($Slot, $Connection, $State, $Pct)
        $script:calls.Add('slot')
        if ($script:throwOn -eq 'slot') { throw 'the reader died mid-stream' }
    }
    function Invoke-SqlSweep     { param($State, $Connection, $Slots) $script:calls.Add('sweep') }
    function Complete-SqlStagedLoads {
        param($State)
        $script:calls.Add('finalize')
        if ($script:throwOn -eq 'finalize') { throw 'the stage finalize failed' }
    }
    function Invoke-SqlReconcile { param($State) $script:calls.Add('reconcile') }
    function Test-SqlRunCounts {
        param($State)
        $script:calls.Add('verify')
        if ($script:throwOn -eq 'verify') { throw 'Verification failed for 2 of 9 check(s)' }
    }
    function Save-SqlWatermarks    { param($State) $script:calls.Add('watermarks') }
    function Save-SqlSweepMarks    { param($State) $script:calls.Add('sweepmarks') }
    function Update-SqlMatrixViews { $script:calls.Add('refresh'); return $true }

    # Runs the shipped region's own text. Returns the error it let escape, or $null.
    function Invoke-EntryPointTail {
        param([string]$ThrowOn = '')
        $script:calls   = [System.Collections.Generic.List[string]]::new()
        $script:throwOn = $ThrowOn
        $Cfg   = @{ queries = @(@{ name = 'grants'; target = 'assignments' }) }
        $State = @{ SystemId = 7 }
        $Connection = [pscustomobject]@{}
        $Connection | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:calls.Add('dispose') }
        $escaped = $null
        try { & ([scriptblock]::Create($script:guards[0].Extent.Text)) } catch { $escaped = $_ }
        return $escaped
    }
}

Describe 'Start-SqlCrawler end-of-run ordering — structure' {
    It 'has exactly one view refresh in the whole entry point, in a finally' {
        # Two would mean a successful run rebuilds twice: 3m17s and 7.6 GB each
        # at the customer's 42.6M assignments.
        ([regex]::Matches($script:entryText, 'Update-SqlMatrixViews')).Count | Should -Be 1
        $script:guards.Count | Should -Be 1
    }

    It 'guards the read, the reconcile and the verification — not just the verification' {
        # A crawl that throws for any other reason has still committed its rows.
        $body = $script:guards[0].Body.Extent.Text
        foreach ($call in 'Invoke-SqlSlot', 'Invoke-SqlSweep', 'Complete-SqlStagedLoads', 'Invoke-SqlReconcile', 'Test-SqlRunCounts') {
            $body | Should -Match ([regex]::Escape($call))
        }
    }

    It 'keeps the watermark and sweep-mark saves in the body, behind the verdict' {
        $script:guards[0].Body.Extent.Text | Should -Match ([regex]::Escape('Save-SqlWatermarks'))
        $script:guards[0].Body.Extent.Text | Should -Match ([regex]::Escape('Save-SqlSweepMarks'))
        # Moving either into the finally would save a mark for a run that never
        # verified, which is the regression this whole ordering exists to prevent.
        $script:guards[0].Finally.Extent.Text | Should -Not -Match 'Save-Sql'
    }
}

Describe 'Start-SqlCrawler end-of-run ordering — behaviour' {
    It 'a clean run verifies, saves both marks, and refreshes once' {
        (Invoke-EntryPointTail) | Should -BeNullOrEmpty
        $script:calls | Should -Be @('slot', 'sweep', 'dispose', 'finalize', 'reconcile', 'verify', 'watermarks', 'sweepmarks', 'refresh')
    }

    It 'a FAILED verification still refreshes the views' {
        $escaped = Invoke-EntryPointTail -ThrowOn 'verify'
        $script:calls | Should -Contain 'refresh'
        # …and the failure is still the job's failure: the refresh must not
        # swallow it, or the run would report success on a partial load.
        $escaped | Should -Not -BeNullOrEmpty
        "$escaped" | Should -Match 'Verification failed'
    }

    It 'a FAILED verification saves neither the watermarks nor the sweep marks' {
        Invoke-EntryPointTail -ThrowOn 'verify' | Out-Null
        # The discriminating half: an unverified run must re-read its window and
        # re-sweep. If these were saved, the next delta run would start after
        # rows this one never loaded and they would be invisible for good.
        $script:calls | Should -Not -Contain 'watermarks'
        $script:calls | Should -Not -Contain 'sweepmarks'
        $script:calls | Should -Be @('slot', 'sweep', 'dispose', 'finalize', 'reconcile', 'verify', 'refresh')
    }

    # A staged scope is only APPLIED by the finalize. If it fails, the scopes it
    # carried were never written — so there is nothing to reconcile against and
    # nothing a verification could pass, and no mark may move.
    It 'a failed finalize stops the run before the reconcile and the marks, and still refreshes' {
        $escaped = Invoke-EntryPointTail -ThrowOn 'finalize'
        "$escaped" | Should -Match 'stage finalize failed'
        $script:calls | Should -Be @('slot', 'sweep', 'dispose', 'finalize', 'refresh')
    }

    It 'a read that dies mid-stream still refreshes, and never reaches the verdict' {
        $escaped = Invoke-EntryPointTail -ThrowOn 'slot'
        "$escaped" | Should -Match 'reader died'
        # The connection is disposed, the rows already committed get their views,
        # and nothing downstream of the failed read pretends to have run.
        $script:calls | Should -Be @('slot', 'dispose', 'refresh')
    }
}

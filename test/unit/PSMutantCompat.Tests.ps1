#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Keeps the unit tests runnable by PSMutant, not only by plain Pester.

.DESCRIPTION
    PSMutant (ps-mutation.yml, weekly) first runs the mapped tests as a baseline
    and refuses to mutate anything unless it is green. It calls Invoke-Pester from
    INSIDE its own module, so a test can pass in PR Checks and still fail there —
    and nothing tells anyone until a Monday run, which then fails every week. That
    happened from 14 Sep to 9 Nov 2026 with two such tests:

      * `Mock … -ModuleName $null` places the mock outside the scope the
        dot-sourced functions live in under PSMutant, so the real command runs.
      * A -ParameterFilter testing an UNBOUND parameter by name (`-not $ConfigFile`)
        resolves that name up the caller chain — which under PSMutant includes
        Invoke-PSMutation -ConfigFile. Ask `$PesterBoundParameters` instead.

    The first is a literal pattern, so it is banned here. The second can't be
    caught by a text scan without false alarms; it is documented in
    docs/contributing/writing-tests-that-assert.md next to the PSMutant section.
#>

Describe 'Pester tests stay runnable under PSMutant' {
    It 'no test mocks with -ModuleName $null' {
        $root = Join-Path $PSScriptRoot '..' '..'
        $offenders = Get-ChildItem (Join-Path $root 'test') -Recurse -Filter '*.Tests.ps1' -File |
            Where-Object { $_.Name -ne 'PSMutantCompat.Tests.ps1' } |
            Select-String -Pattern '-ModuleName\s+\$null\b' |
            Where-Object { $_.Line -notmatch '^\s*#' } |
            ForEach-Object { '{0}:{1}' -f $_.Path.Substring((Resolve-Path $root).Path.Length + 1), $_.LineNumber }
        $offenders | Should -BeNullOrEmpty -Because 'under PSMutant such a mock never intercepts the call (see this file''s header)'
    }

    It 'the pattern it bans is the one that breaks' {
        # Discriminates the scan itself: a matcher that never fires would pass the
        # test above for ever.
        'Mock Write-Host { } -ModuleName $null' | Should -Match '-ModuleName\s+\$null\b'
        'Mock Write-Host { } -ModuleName IdentityAtlas' | Should -Not -Match '-ModuleName\s+\$null\b'
        'Mock X { } -ModuleName $nullable' | Should -Not -Match '-ModuleName\s+\$null\b'
    }
}

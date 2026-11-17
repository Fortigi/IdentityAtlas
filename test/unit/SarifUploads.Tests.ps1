#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }
<#
.SYNOPSIS
    Each SARIF log CI produces is the one it uploads.

.DESCRIPTION
    PSComplexity and PSMutant write a SARIF log to a path set in one place (a ratchet.py
    flag, a measure_ps.ps1 parameter, the PSMutant config) and a workflow step uploads a
    path set in another. If the two ever differ, the upload's hashFiles() guard sees no
    file and skips the step, the job stays green, and code scanning silently stops
    receiving findings -- no step fails to say so. These tests hold each pair together,
    and the conditions that make the upload happen on the runs that have findings.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    function Get-Workflow([string]$Name) {
        Get-Content (Join-Path $script:repoRoot '.github' 'workflows' $Name) -Raw
    }
    # The upload steps that name this category, each as text up to the next step.
    # Callers wrap the call in @(): one step returned bare is a string, and [0] of a
    # string is its first character.
    function Get-UploadStep([string]$Workflow, [string]$Category) {
        $steps = (Get-Workflow $Workflow) -split '(?m)^(?=      - (?:name|uses): )'
        @($steps | Where-Object { $_ -match 'upload-sarif@' -and $_ -match "(?m)^\s+category: $Category\s*$" })
    }
    function Get-UploadedFile([string]$Step) {
        if ($Step -match '(?m)^\s+sarif_file: (\S+)\s*$') { $Matches[1] }
    }
}

Describe 'PSMutant: the log the config names is the one ps-mutation.yml uploads' {
    BeforeAll {
        $script:cfg = Get-Content (Join-Path $script:repoRoot '.ci' 'psmutant.config.json') -Raw | ConvertFrom-Json
        $script:step = @(Get-UploadStep 'ps-mutation.yml' 'psmutant')
    }

    It 'has exactly one psmutant upload step' {
        $script:step.Count | Should -Be 1
    }

    It 'uploads the sarifPath the run writes' {
        $script:cfg.sarifPath | Should -Not -BeNullOrEmpty
        Get-UploadedFile $script:step[0] | Should -Be $script:cfg.sarifPath
    }

    It 'uploads even when the run fails its floor' {
        $script:step[0] | Should -Match 'if: always\(\)'
    }
}

Describe 'PSComplexity: the log each run writes is the one it uploads' {
    It 'pr.yml uploads what the cyclomatic ratchet writes, even when the ratchet fails' {
        $wf = Get-Workflow 'pr.yml'
        # -match, not Should -Match: only the operator sets $Matches here.
        $wf -match 'ratchet\.py --ps-sarif (\S+)' | Should -BeTrue
        $written = $Matches[1]
        $step = @(Get-UploadStep 'pr.yml' 'pscomplexity')
        $step.Count | Should -Be 1
        Get-UploadedFile $step[0] | Should -Be $written
        $step[0] | Should -Match 'always\(\)'
    }

    It 'coverage.yml uploads what measure_ps.ps1 writes on main' {
        $wf = Get-Workflow 'coverage.yml'
        $wf -match 'measure_ps\.ps1 -SarifPath (\S+)' | Should -BeTrue
        $written = $Matches[1]
        $step = @(Get-UploadStep 'coverage.yml' 'pscomplexity')
        $step.Count | Should -Be 1
        Get-UploadedFile $step[0] | Should -Be $written
    }
}

Describe 'Every workflow that uploads SARIF may write security events' {
    It '<_> grants security-events: write' -ForEach @('pr.yml', 'coverage.yml', 'ps-mutation.yml') {
        Get-Workflow $_ | Should -Match '(?m)^\s+security-events: write'
    }
}

Describe 'The step finder itself' {
    It 'finds nothing for a category no workflow uses' {
        # Without this, a finder that matched nothing would let the Count checks above
        # fail for the wrong reason -- or, rewritten, pass vacuously.
        @(Get-UploadStep 'pr.yml' 'no-such-category').Count | Should -Be 0
    }
}

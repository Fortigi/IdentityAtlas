#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester tests for the exit code of tools/crawlers/entra-id/Test-EntraIdCrawler.ps1 when its
    credential pre-flight fails.

.DESCRIPTION
    CI runs the Entra crawler integration test with `pwsh -File` and trusts its exit code. A failed
    pre-flight used to end the script with a bare `return`, which exits 0, so CI recorded "passed"
    under a printed FAIL line. That hid an expired client secret for five weeks (Oct–Nov 2026).

    Each case runs the real script as a child process against a fake API on localhost and asserts
    the exit code. The three failure inputs are the three pre-flight exits: the API call throws,
    the API says the credentials are invalid, and a permission is missing. Before the fix all
    three returned 0. The no-credentials skip must still exit 0, so a fix that simply made every
    early exit non-zero would fail here too.

.USAGE
    Invoke-Pester -Path test/unit/EntraIdCrawlerTestPreflight.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:testScript = Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id' 'Test-EntraIdCrawler.ps1'
    $script:secretsFile = Join-Path $script:repoRoot 'test' 'test.secrets.json'

    # Serve one fixed JSON body for every request until stopped. HttpListener on `localhost`
    # needs no URL reservation on Windows and works unchanged on Linux runners.
    function Start-FakeApi {
        param([string]$Json)
        $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $probe.Start(); $port = $probe.LocalEndpoint.Port; $probe.Stop()
        $prefix = "http://localhost:$port/"
        $listener = [System.Net.HttpListener]::new()
        $listener.Prefixes.Add($prefix)
        $listener.Start()
        $job = Start-ThreadJob -ArgumentList $listener, $Json -ScriptBlock {
            param($l, $body)
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            while ($l.IsListening) {
                try { $ctx = $l.GetContext() } catch { break }
                $ctx.Response.ContentType = 'application/json'
                $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $ctx.Response.Close()
            }
        }
        [pscustomobject]@{ Url = "${prefix}api"; Listener = $listener; Job = $job }
    }

    function Stop-FakeApi {
        param($Api)
        $Api.Listener.Stop(); $Api.Listener.Close()
        Remove-Job $Api.Job -Force -ErrorAction SilentlyContinue
    }

    # Run the integration test script as CI does and return its exit code.
    function Invoke-EntraTestScript {
        param([string]$ApiBaseUrl, [switch]$WithCreds)
        $saved = @{}
        foreach ($n in 'TEST_GRAPH_TENANT_ID', 'TEST_GRAPH_CLIENT_ID', 'TEST_GRAPH_CLIENT_SECRET') {
            $saved[$n] = [Environment]::GetEnvironmentVariable($n)
            [Environment]::SetEnvironmentVariable($n, $(if ($WithCreds) { "fake-$n" } else { $null }))
        }
        try {
            $null = & pwsh -NoProfile -File $script:testScript -ApiBaseUrl $ApiBaseUrl -ApiKey 'fgc_test' `
                -LogFolder ([System.IO.Path]::GetTempPath()) 2>&1
            $LASTEXITCODE
        } finally {
            foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
        }
    }
}

Describe 'Test-EntraIdCrawler.ps1 pre-flight exit code' {
    It 'exits non-zero when the API cannot be reached' {
        # Port 9 (discard) on loopback refuses the connection at once, so Invoke-RestMethod throws.
        Invoke-EntraTestScript -ApiBaseUrl 'http://localhost:9/api' -WithCreds | Should -Not -Be 0
    }

    It 'exits non-zero when the API reports the credentials as invalid' {
        $api = Start-FakeApi '{"valid":false,"error":"AADSTS7000222: The provided client secret keys are expired."}'
        try {
            Invoke-EntraTestScript -ApiBaseUrl $api.Url -WithCreds | Should -Not -Be 0
        } finally { Stop-FakeApi $api }
    }

    It 'exits non-zero when a required permission is not granted' {
        $api = Start-FakeApi '{"valid":true,"organization":"Contoso","permissions":{"User.Read.All":true,"Group.Read.All":false}}'
        try {
            Invoke-EntraTestScript -ApiBaseUrl $api.Url -WithCreds | Should -Not -Be 0
        } finally { Stop-FakeApi $api }
    }

    It 'still exits 0 when there are no credentials, because that is a skip' {
        if (Test-Path $script:secretsFile) {
            Set-ItResult -Skipped -Because 'a local test/test.secrets.json supplies credentials'
            return
        }
        Invoke-EntraTestScript -ApiBaseUrl 'http://localhost:9/api' | Should -Be 0
    }
}

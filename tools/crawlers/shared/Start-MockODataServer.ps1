<#
.SYNOPSIS
    Reusable mock OData HTTP server for crawler integration tests.

.DESCRIPTION
    Starts a TcpListener background job that serves configurable OData-shaped
    JSON responses. A single mock instance runs for the lifetime of a test file
    and can be reconfigured mid-test via the /_control endpoint.

    Using TcpListener (not HttpListener) means no URL ACL registration is needed
    on Windows and the Host header is not validated, so Docker containers can
    reach the mock via host.docker.internal without admin privileges.

    Lifecycle:
        $mock = Start-MockODataServer -EntitySets @{ ... }
        # run tests — reconfigure mid-test via /_control if needed
        Stop-MockODataServer -Mock $mock

    Control endpoint (POST /_control, body is JSON):
        {"alwaysReturnStatus": 401}   — all data GETs return that status
        {"errorAfterN": 2}            — return 500 after N successful data GETs
        {"resetCount": true}          — reset the data-request counter to 0
        {"reset": true}               — reset all state to normal

.EXAMPLE
    . tools/crawlers/shared/Start-MockODataServer.ps1
    $mock = Start-MockODataServer -EntitySets @{
        Users = @( @{ UId='u1'; DisplayName='Alice' } )
    }
    # ... tests ...
    # switch mock to always return 401:
    Invoke-RestMethod "http://localhost:$($mock.Port)/_control" -Method POST `
        -ContentType 'application/json' -Body '{"alwaysReturnStatus":401}'
    # ... error-path tests ...
    Stop-MockODataServer -Mock $mock
#>

function Get-FreePort {
    [CmdletBinding()] param()
    $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $tcp.Start()
    $port = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port
    $tcp.Stop()
    return $port
}

function Start-MockODataServer {
    <#
    .SYNOPSIS
        Start a background TCP-based HTTP server that serves mock OData responses.

    .PARAMETER EntitySets
        Hashtable mapping entity set names to arrays of entity objects.

    .PARAMETER EdmxEntitySets
        Entity set names to include in the $metadata EDMX response.
        Defaults to keys of EntitySets plus 'System'.

    .OUTPUTS
        [PSCustomObject] with Job (background job handle) and Port (int).
    #>
    [CmdletBinding()]
    param(
        [hashtable]$EntitySets = @{},
        [string[]]$EdmxEntitySets = @()
    )

    $port = Get-FreePort

    if ($EdmxEntitySets.Count -eq 0) {
        $EdmxEntitySets = @('System') + @($EntitySets.Keys)
    }

    $entitySetsJson = $EntitySets     | ConvertTo-Json -Depth 20 -Compress
    $edmxSetsJson   = $EdmxEntitySets | ConvertTo-Json -Compress

    $serverScript = {
        param([int]$Port, [string]$EntitySetsJson, [string]$EdmxSetsJson)

        $entitySets = $EntitySetsJson | ConvertFrom-Json -AsHashtable
        $edmxSets   = $EdmxSetsJson   | ConvertFrom-Json

        $entitySetEntries = ($edmxSets | ForEach-Object {
            "        <EntitySet Name=""$_"" EntityType=""Model.$_""/>"
        }) -join "`n"
        $edmxBody = @"
<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityContainer>
$entitySetEntries
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
"@

        # Mutable state — updated via POST /_control
        $ctrl = @{ AlwaysReturnStatus = 0; ErrorAfterN = 0; DataRequestCount = 0 }

        function Send-Response {
            param($Stream, [int]$Status = 200, [string]$ContentType = 'application/json; charset=utf-8', [string]$Body = '')
            $statusText = @{ 200='OK'; 400='Bad Request'; 401='Unauthorized'; 404='Not Found'; 405='Method Not Allowed'; 500='Internal Server Error' }[$Status] ?? 'Unknown'
            $bodyBytes   = [System.Text.Encoding]::UTF8.GetBytes($Body)
            $headerStr   = "HTTP/1.1 $Status $statusText`r`nContent-Type: $ContentType`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($headerStr)
            try {
                $Stream.Write($headerBytes, 0, $headerBytes.Length)
                if ($bodyBytes.Length -gt 0) { $Stream.Write($bodyBytes, 0, $bodyBytes.Length) }
                $Stream.Flush()
            } catch {}
        }

        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
        try { $listener.Start() }
        catch {
            Write-Output "MOCK_ERROR: Failed to start on port $Port — $($_.Exception.Message)"
            return
        }
        Write-Output "MOCK_STARTED: port=$Port"

        try {
            while ($true) {
                if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }

                $client = $listener.AcceptTcpClient()
                try {
                    $stream = $client.GetStream()
                    $stream.ReadTimeout = 2000

                    # Read raw HTTP request
                    $buf = [byte[]]::new(65536)
                    $n = 0
                    try { $n = $stream.Read($buf, 0, $buf.Length) } catch {}
                    if ($n -eq 0) { continue }
                    $raw = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)

                    # Parse request line and headers
                    $lines     = $raw -split "`r`n"
                    $reqParts  = ($lines[0] -split ' ', 3)
                    $method    = $reqParts[0]
                    $fullPath  = if ($reqParts.Count -gt 1) { $reqParts[1] } else { '/' }
                    $path      = ($fullPath -split '\?')[0]
                    $query     = if ($fullPath -match '\?(.+)$') { $Matches[1] } else { '' }

                    $authHeader     = ($lines | Where-Object { $_ -match '^Authorization:'  } | Select-Object -First 1) -replace '^Authorization:\s*',  ''
                    $cookieHeader   = ($lines | Where-Object { $_ -match '^Cookie:'         } | Select-Object -First 1) -replace '^Cookie:\s*',          ''
                    $apiTokenHeader = ($lines | Where-Object { $_ -match '^X-Api-Token:'    } | Select-Object -First 1) -replace '^X-Api-Token:\s*',     ''
                    $reqBody        = if ($raw -match "\r\n\r\n([\s\S]+)$") { $Matches[1].Trim() } else { '' }

                    Write-Output "REQUEST: $method $path$(if($query){'?'+$query}) Auth=[$authHeader] Cookie=[$cookieHeader] ApiToken=[$apiTokenHeader]"

                    # ── /_control — reconfigure mock at runtime ───────────────
                    if ($path -eq '/_control' -and $method -eq 'POST') {
                        try {
                            $c = $reqBody | ConvertFrom-Json -AsHashtable
                            if ($c.ContainsKey('alwaysReturnStatus')) { $ctrl.AlwaysReturnStatus = [int]$c.alwaysReturnStatus }
                            if ($c.ContainsKey('errorAfterN'))        { $ctrl.ErrorAfterN        = [int]$c.errorAfterN }
                            if ($c['resetCount']) { $ctrl.DataRequestCount   = 0 }
                            if ($c['reset'])      { $ctrl.AlwaysReturnStatus = 0; $ctrl.ErrorAfterN = 0; $ctrl.DataRequestCount = 0 }
                            Send-Response $stream -Body '{"ok":true}'
                        } catch {
                            Send-Response $stream -Status 400 -Body "{""error"":""$($_.Exception.Message)""}"
                        }
                        continue
                    }

                    # ── FormCookie auth endpoint ──────────────────────────────
                    if ($path -eq '/api/authenticate' -and $method -eq 'POST') {
                        $headerExtra = "Set-Cookie: session=mock-session-token; Path=/`r`n"
                        $body = '{"success":true}'
                        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
                        $hdr = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`n${headerExtra}Content-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
                        $hdrBytes = [System.Text.Encoding]::UTF8.GetBytes($hdr)
                        try { $stream.Write($hdrBytes, 0, $hdrBytes.Length); $stream.Write($bodyBytes, 0, $bodyBytes.Length); $stream.Flush() } catch {}
                        continue
                    }

                    # ── OAuth2 token endpoint ─────────────────────────────────
                    if ($path -match '/token' -and $method -eq 'POST') {
                        $token = 'mock-bearer-token-' + [guid]::NewGuid().ToString('N').Substring(0,8)
                        Send-Response $stream -Body "{""access_token"":""$token"",""token_type"":""Bearer"",""expires_in"":3600}"
                        continue
                    }

                    # ── OData $metadata ───────────────────────────────────────
                    if ($path -match '\$metadata' -and $method -eq 'GET') {
                        Send-Response $stream -ContentType 'application/xml; charset=utf-8' -Body $edmxBody
                        continue
                    }

                    # ── Data GET ──────────────────────────────────────────────
                    if ($method -eq 'GET') {
                        if ($ctrl.AlwaysReturnStatus -gt 0) {
                            Send-Response $stream -Status $ctrl.AlwaysReturnStatus -Body "{""error"":""HTTP $($ctrl.AlwaysReturnStatus) from mock""}"
                            continue
                        }
                        if ($ctrl.ErrorAfterN -gt 0 -and $ctrl.DataRequestCount -ge $ctrl.ErrorAfterN) {
                            Send-Response $stream -Status 500 -Body '{"error":"Mock error-after-N triggered"}'
                            continue
                        }
                        $ctrl.DataRequestCount++

                        $entityName = ($path.Split('/')[-1])

                        # @odata.nextLink pagination test path
                        if ($entityName -eq 'Paginated') {
                            if ($query -match 'page=2') {
                                $json = @{ value = @(@{ UId = 'page2-entity'; DisplayName = 'Page 2 Entity' }) } | ConvertTo-Json -Depth 5 -Compress
                            } else {
                                $json = @{
                                    value = @(@{ UId = 'page1-entity'; DisplayName = 'Page 1 Entity' })
                                    '@odata.nextLink' = "http://localhost:$Port/odata/v4/Paginated?page=2"
                                } | ConvertTo-Json -Depth 5 -Compress
                            }
                            Send-Response $stream -Body $json
                            continue
                        }

                        if ($entitySets.ContainsKey($entityName)) {
                            $entities = @($entitySets[$entityName])
                            $skip = 0; $top = $entities.Count
                            if ($query -match '(?i)\$skip=(\d+)') { $skip = [int]$Matches[1] }
                            if ($query -match '(?i)\$top=(\d+)')  { $top  = [int]$Matches[1] }
                            $slice = @($entities | Select-Object -Skip $skip -First $top)
                            $json = @{ value = $slice } | ConvertTo-Json -Depth 10 -Compress
                            Send-Response $stream -Body $json
                        } else {
                            Send-Response $stream -Body '{"value":[]}'
                        }
                        continue
                    }

                    Send-Response $stream -Status 405 -Body '{"error":"Method not allowed"}'

                } finally {
                    try { $client.Close() } catch {}
                }
            }
        } finally {
            try { $listener.Stop() } catch {}
            Write-Output "MOCK_STOPPED"
        }
    }

    $job = Start-Job -ScriptBlock $serverScript -ArgumentList $port, $entitySetsJson, $edmxSetsJson

    # Wait up to 4s for startup confirmation
    $started = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 200
        $out = Receive-Job -Job $job -Keep 2>&1
        if ($out -match 'MOCK_STARTED') { $started = $true; break }
        if ($out -match 'MOCK_ERROR')   { break }
    }

    if (-not $started) {
        $out = Receive-Job -Job $job -Keep 2>&1
        Stop-Job   -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        throw "Mock OData server failed to start on port $port. Output: $($out -join '; ')"
    }

    return [PSCustomObject]@{ Job = $job; Port = $port }
}

function Stop-MockODataServer {
    <#
    .SYNOPSIS Stop a mock OData server started by Start-MockODataServer. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][PSCustomObject]$Mock)

    try { Stop-Job -Job $Mock.Job -ErrorAction SilentlyContinue } catch {}
    try {
        $output = Receive-Job -Job $Mock.Job -Keep 2>&1
        if ($output) { foreach ($line in $output) { Write-Host "  [mock] $line" -ForegroundColor DarkGray } }
    } catch {}
    try { Remove-Job -Job $Mock.Job -Force -ErrorAction SilentlyContinue } catch {}
}

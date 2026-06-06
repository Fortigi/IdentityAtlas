<#
.SYNOPSIS
    Reusable mock OData HTTP server for crawler integration tests.

.DESCRIPTION
    Starts a System.Net.HttpListener background job that serves configurable
    OData-shaped JSON responses. Call Start-MockODataServer to get a mock handle,
    and Stop-MockODataServer when done.

    IMPORTANT: Designed for ubuntu-latest GitHub Actions runners only.
    System.Net.HttpListener on Windows requires URL ACL registration (netsh).
    All CI steps use runs-on: ubuntu-latest — this is safe there.

    Mock validated against Omada OData API shape as of 2026-06-06
    (cloud endpoint rdw-e.omada.cloud).

.EXAMPLE
    . tools/crawlers/shared/Start-MockODataServer.ps1
    $mock = Start-MockODataServer -EntitySets @{
        Identity = @( @{ UId='id1'; IDENTITYID='I1'; IDENTITYTYPE=@{Value='Employee'} } )
    }
    Write-Host "Mock running on port $($mock.Port)"
    Stop-MockODataServer -Mock $mock
#>

function Get-FreePort {
    [CmdletBinding()]
    param()
    # Bind to port 0 — OS assigns a free port. Close immediately and return the port.
    # There is a tiny race window, but on CI machines this is safe in practice.
    $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $tcp.Start()
    $port = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port
    $tcp.Stop()
    return $port
}

function Start-MockODataServer {
    <#
    .SYNOPSIS
        Start a background HTTP server that serves mock OData responses.

    .PARAMETER EntitySets
        Hashtable mapping entity set names to arrays of entity objects.
        E.g. @{ Identity = @(@{ UId='…' }); User = @(@{ UId='…' }) }

    .PARAMETER EdmxEntitySets
        List of entity set names to include in $metadata EDMX.
        Defaults to keys of EntitySets plus 'System'.

    .PARAMETER AlwaysReturnStatus
        If set, all data GET requests return this HTTP status code (e.g. 401).

    .PARAMETER ErrorAfterN
        Return HTTP 500 for data GET requests after N successful ones.

    .OUTPUTS
        [PSCustomObject] with Job (background job handle) and Port (int).
    #>
    [CmdletBinding()]
    param(
        [hashtable]$EntitySets = @{},
        [string[]]$EdmxEntitySets = @(),
        [int]$AlwaysReturnStatus = 0,
        [int]$ErrorAfterN = 0
    )

    $port = Get-FreePort

    # Resolve EDMX entity sets: caller-specified or keys of EntitySets + System
    if ($EdmxEntitySets.Count -eq 0) {
        $EdmxEntitySets = @('System') + @($EntitySets.Keys)
    }

    # Serialize entity data for cross-process transfer
    $entitySetsJson  = $EntitySets  | ConvertTo-Json -Depth 20 -Compress
    $edmxSetsJson    = $EdmxEntitySets | ConvertTo-Json -Compress

    $serverScript = {
        param([int]$Port, [string]$EntitySetsJson, [string]$EdmxSetsJson,
              [int]$AlwaysReturnStatus, [int]$ErrorAfterN)

        $entitySets   = $EntitySetsJson | ConvertFrom-Json -AsHashtable
        $edmxSets     = $EdmxSetsJson   | ConvertFrom-Json

        # Build EDMX body from entity set names
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

        $listener = [System.Net.HttpListener]::new()
        $listener.Prefixes.Add("http://localhost:$Port/")
        try { $listener.Start() }
        catch {
            Write-Output "MOCK_ERROR: Failed to start listener on port $Port — $($_.Exception.Message)"
            return
        }

        Write-Output "MOCK_STARTED: port=$Port"

        $dataRequestCount = 0

        try {
            while ($listener.IsListening) {
                # Non-blocking wait: check every 2 s so Stop-Job terminates cleanly
                $ar = $listener.BeginGetContext($null, $null)
                if (-not $ar.AsyncWaitHandle.WaitOne(2000)) { continue }

                $ctx = $null
                try { $ctx = $listener.EndGetContext($ar) }
                catch { continue }

                $req = $ctx.Request
                $res = $ctx.Response
                $path   = $req.Url.AbsolutePath
                $method = $req.HttpMethod
                $query  = $req.Url.Query

                Write-Output "REQUEST: $method $path$query Auth=[$($req.Headers['Authorization'])] Cookie=[$($req.Headers['Cookie'])] ApiToken=[$($req.Headers['X-Api-Token'])]"

                $statusCode   = 200
                $contentType  = 'application/json; charset=utf-8'
                $responseBody = ''

                if ($path -eq '/api/authenticate' -and $method -eq 'POST') {
                    # FormCookie auth endpoint
                    $res.Headers.Add('Set-Cookie', 'session=mock-session-token; Path=/')
                    $responseBody = '{"success":true}'

                } elseif ($path -match '/token' -and $method -eq 'POST') {
                    # OAuth2 token endpoint (CC or ROPC)
                    $responseBody = '{"access_token":"mock-bearer-token-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '","token_type":"Bearer","expires_in":3600}'

                } elseif ($path -match '\$metadata' -and $method -eq 'GET') {
                    # OData metadata document
                    $contentType  = 'application/xml; charset=utf-8'
                    $responseBody = $edmxBody

                } elseif ($method -eq 'GET') {
                    # Data request
                    if ($AlwaysReturnStatus -gt 0) {
                        $statusCode   = $AlwaysReturnStatus
                        $responseBody = "{`"error`":`"HTTP $AlwaysReturnStatus from mock`"}"
                    } elseif ($ErrorAfterN -gt 0 -and $dataRequestCount -ge $ErrorAfterN) {
                        $statusCode   = 500
                        $responseBody = '{"error":"Mock server error-after-N triggered"}'
                    } else {
                        $dataRequestCount++

                        # Extract entity set name: last path segment, strip query
                        $entityName = ($path.Split('/')[-1] -split '\?')[0]

                        # Handle @odata.nextLink pagination test
                        # If query contains page=2, return final page without nextLink
                        if ($query -match 'page=2') {
                            $extraEntity = @{ UId = 'page2-entity'; DisplayName = 'Page 2 Entity' }
                            $json = @{ value = @($extraEntity) } | ConvertTo-Json -Depth 10 -Compress
                            $responseBody = $json
                        } elseif ($entitySets.ContainsKey($entityName)) {
                            $entities = @($entitySets[$entityName])
                            # For $skip pagination: slice the entity set based on $skip and $top params
                            $skip = 0; $top = $entities.Count
                            if ($query -match '\$skip=(\d+)') { $skip = [int]$Matches[1] }
                            if ($query -match '\$top=(\d+)')  { $top  = [int]$Matches[1] }
                            $slice = @($entities | Select-Object -Skip $skip -First $top)
                            $json = @{ value = $slice } | ConvertTo-Json -Depth 10 -Compress
                            $responseBody = $json
                        } else {
                            # Unknown entity set or Pagination test path '/Paginated'
                            if ($entityName -eq 'Paginated' -and $query -notmatch 'page=2') {
                                # First page: return 1 item + nextLink
                                $nextLink = "http://localhost:$Port/odata/v4/Paginated?page=2"
                                $json = @{
                                    value = @(@{ UId = 'page1-entity'; DisplayName = 'Page 1 Entity' })
                                    '@odata.nextLink' = $nextLink
                                } | ConvertTo-Json -Depth 10 -Compress
                                $responseBody = $json
                            } else {
                                $responseBody = '{"value":[]}'
                            }
                        }
                    }
                } else {
                    $statusCode   = 405
                    $responseBody = '{"error":"Method not allowed"}'
                }

                $res.StatusCode  = $statusCode
                $res.ContentType = $contentType
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($responseBody)
                $res.ContentLength64 = $bytes.Length
                try {
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } catch {}
                try { $res.OutputStream.Close() } catch {}
            }
        } finally {
            try { $listener.Stop() } catch {}
            Write-Output "MOCK_STOPPED"
        }
    }

    $job = Start-Job -ScriptBlock $serverScript `
        -ArgumentList $port, $entitySetsJson, $edmxSetsJson, $AlwaysReturnStatus, $ErrorAfterN

    # Poll until started (max 4 s)
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
    .SYNOPSIS
        Stop a mock OData server started by Start-MockODataServer.
    .PARAMETER Mock
        The PSCustomObject returned by Start-MockODataServer.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][PSCustomObject]$Mock)

    try { Stop-Job   -Job $Mock.Job -ErrorAction SilentlyContinue } catch {}

    # Flush job output to host so CI log shows server-side request log
    try {
        $output = Receive-Job -Job $Mock.Job -Keep 2>&1
        if ($output) {
            foreach ($line in $output) {
                Write-Host "  [mock] $line" -ForegroundColor DarkGray
            }
        }
    } catch {}

    try { Remove-Job -Job $Mock.Job -Force -ErrorAction SilentlyContinue } catch {}
}

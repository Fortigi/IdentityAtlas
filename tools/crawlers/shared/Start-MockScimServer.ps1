<#
.SYNOPSIS
    Reusable mock SCIM 2.0 server for crawler integration tests.

.DESCRIPTION
    Starts a TcpListener background job that serves the SCIM 2.0 endpoints the
    crawler and the wizard's discovery handler use:

      GET /ServiceProviderConfig → the provider capability document
      GET /ResourceTypes         → ListResponse of resource types
      GET /Schemas               → ListResponse of schemas (drives the attribute picker)
      GET /Users?startIndex&count  → paged ListResponse
      GET /Groups?startIndex&count → paged ListResponse

    Paging is REAL: startIndex/count are honoured and totalResults is reported, so a
    test can assert the crawler walks every page instead of silently reading only
    the first one. Every request is recorded and can be read back with
    Get-MockScimRequests, which is what makes "three requests with an advancing
    startIndex" an assertion rather than an assumption.

    Authorization is required (any credential is accepted) unless -Require401 is set,
    in which case every collection request answers 401 — that is the error-path
    fixture.

    Using TcpListener (not HttpListener) means no URL ACL registration is needed and
    the Host header is not validated, so a Docker worker can reach the mock via
    host.docker.internal.

.EXAMPLE
    . tools/crawlers/shared/Start-MockScimServer.ps1
    $mock = Start-MockScimServer -Users @( @{ id='u1'; userName='alice' } ) -Groups @()
    # ... tests ...
    Stop-MockScimServer -Mock $mock
#>

function Get-FreeScimPort {
    [CmdletBinding()] param()
    $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $tcp.Start(); $port = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port; $tcp.Stop()
    return $port
}

function Start-MockScimServer {
    <#
    .PARAMETER Users
        Array of SCIM User resource hashtables served by /Users.
    .PARAMETER Groups
        Array of SCIM Group resource hashtables served by /Groups.
    .PARAMETER Schemas
        Optional array of SCIM schema hashtables served by /Schemas. Defaults to a
        minimal core User schema with a `department` attribute.
    .PARAMETER Require401
        Answer every collection request with 401 (credential-failure fixture).
    .OUTPUTS
        [PSCustomObject] with Job and Port.
    #>
    [CmdletBinding()]
    param(
        [array]$Users   = @(),
        [array]$Groups  = @(),
        [array]$Schemas = @(),
        [switch]$Require401
    )

    if ($Schemas.Count -eq 0) {
        $Schemas = @(
            @{ id = 'urn:ietf:params:scim:schemas:core:2.0:User'; name = 'User'
               attributes = @(
                   @{ name = 'userName';    type = 'string';  multiValued = $false }
                   @{ name = 'displayName'; type = 'string';  multiValued = $false }
                   @{ name = 'active';      type = 'boolean'; multiValued = $false }
                   @{ name = 'department';  type = 'string';  multiValued = $false }
                   @{ name = 'title';       type = 'string';  multiValued = $false }
                   @{ name = 'emails';      type = 'complex'; multiValued = $true }
               ) }
            @{ id = 'urn:ietf:params:scim:schemas:core:2.0:Group'; name = 'Group'
               attributes = @(
                   @{ name = 'displayName'; type = 'string';  multiValued = $false }
                   @{ name = 'members';     type = 'complex'; multiValued = $true }
               ) }
        )
    }

    $port    = Get-FreeScimPort
    $payload = @{ users = $Users; groups = $Groups; schemas = $Schemas; require401 = [bool]$Require401 } | ConvertTo-Json -Depth 30 -Compress

    $serverScript = {
        param([int]$Port, [string]$PayloadJson)
        $data = $PayloadJson | ConvertFrom-Json -AsHashtable

        function Send-Response {
            param($Stream, [int]$Status = 200, [string]$Body = '')
            $statusText = @{ 200='OK'; 400='Bad Request'; 401='Unauthorized'; 404='Not Found' }[$Status] ?? 'Unknown'
            $bodyBytes  = [System.Text.Encoding]::UTF8.GetBytes($Body)
            $hdr        = "HTTP/1.1 $Status $statusText`r`nContent-Type: application/scim+json; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
            $hdrBytes   = [System.Text.Encoding]::UTF8.GetBytes($hdr)
            try { $Stream.Write($hdrBytes,0,$hdrBytes.Length); if ($bodyBytes.Length) { $Stream.Write($bodyBytes,0,$bodyBytes.Length) }; $Stream.Flush() } catch {}
        }

        # RFC 7644 §3.4.2: startIndex is 1-based and names the FIRST result.
        function New-ListResponse {
            param([array]$Items, [int]$StartIndex, [int]$Count)
            $total = $Items.Count
            $page  = @()
            if ($StartIndex -le $total -and $Count -gt 0) {
                $from = $StartIndex - 1
                $to   = [Math]::Min($from + $Count - 1, $total - 1)
                if ($to -ge $from) { $page = @($Items[$from..$to]) }
            }
            return @{
                schemas      = @('urn:ietf:params:scim:api:messages:2.0:ListResponse')
                totalResults = $total
                startIndex   = $StartIndex
                itemsPerPage = $page.Count
                Resources    = $page
            } | ConvertTo-Json -Depth 30 -Compress
        }

        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
        try { $listener.Start() } catch { Write-Output "MOCK_ERROR: $($_.Exception.Message)"; return }
        Write-Output "MOCK_STARTED: port=$Port"

        try {
            while ($true) {
                if (-not $listener.Pending()) { Start-Sleep -Milliseconds 50; continue }
                $client = $listener.AcceptTcpClient()
                try {
                    $stream = $client.GetStream(); $stream.ReadTimeout = 2000
                    $buf = [byte[]]::new(65536); $n = 0
                    try { $n = $stream.Read($buf,0,$buf.Length) } catch {}
                    if ($n -eq 0) { continue }
                    $raw      = [System.Text.Encoding]::UTF8.GetString($buf,0,$n)
                    $lines    = $raw -split "`r`n"
                    $reqParts = ($lines[0] -split ' ',3)
                    $fullPath = if ($reqParts.Count -gt 1) { $reqParts[1] } else { '/' }
                    $path     = ($fullPath -split '\?')[0]
                    $query    = if ($fullPath -match '\?(.*)$') { $Matches[1] } else { '' }
                    $hasAuth  = $raw -match '(?im)^Authorization:\s*\S+'

                    Write-Output "MOCK_REQUEST: $fullPath"

                    # Test-control endpoint (not part of SCIM): replace the served
                    # data in place. Lets a reconcile test change what the source
                    # returns WITHOUT restarting on a new port — the crawler keys its
                    # Identity Atlas system on the base URL, so a port change would
                    # silently create a second system and the delete assertions would
                    # be looking at the wrong rows.
                    if ($path -eq '/__mock/state') {
                        $body = if ($raw -match "\r\n\r\n([\s\S]+)$") { $Matches[1].Trim() } else { '' }
                        try {
                            $next = $body | ConvertFrom-Json -AsHashtable
                            foreach ($k in @('users', 'groups')) { if ($next.ContainsKey($k)) { $data[$k] = $next[$k] } }
                            Send-Response $stream -Body '{"ok":true}'
                        } catch { Send-Response $stream -Status 400 -Body '{"detail":"bad state payload"}' }
                        continue
                    }

                    if ($path -match '/ServiceProviderConfig$') {
                        Send-Response $stream -Body (@{
                            schemas = @('urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig')
                            patch = @{ supported = $false }; bulk = @{ supported = $false }
                            filter = @{ supported = $true; maxResults = 200 }
                            changePassword = @{ supported = $false }; sort = @{ supported = $false }
                            etag = @{ supported = $false }
                            authenticationSchemes = @( @{ type = 'httpbasic'; name = 'HTTP Basic' } )
                        } | ConvertTo-Json -Depth 10 -Compress)
                        continue
                    }
                    if ($path -match '/ResourceTypes$') {
                        Send-Response $stream -Body (New-ListResponse -Items @(
                            @{ id = 'User';  name = 'User';  endpoint = '/Users';  schema = 'urn:ietf:params:scim:schemas:core:2.0:User' }
                            @{ id = 'Group'; name = 'Group'; endpoint = '/Groups'; schema = 'urn:ietf:params:scim:schemas:core:2.0:Group' }
                            @{ id = 'Device'; name = 'Device'; endpoint = '/Devices'; schema = 'urn:example:params:scim:schemas:Device' }
                        ) -StartIndex 1 -Count 100)
                        continue
                    }
                    if ($path -match '/Schemas$') {
                        Send-Response $stream -Body (New-ListResponse -Items @($data.schemas) -StartIndex 1 -Count 100)
                        continue
                    }

                    $collection = if ($path -match '/Users$') { 'users' } elseif ($path -match '/Groups$') { 'groups' } else { $null }
                    if ($collection) {
                        if ($data.require401 -or -not $hasAuth) { Send-Response $stream -Status 401 -Body '{"detail":"unauthorized","status":"401"}'; continue }
                        $startIndex = 1; $count = 100
                        if ($query -match 'startIndex=(\d+)') { $startIndex = [int]$Matches[1] }
                        if ($query -match 'count=(\d+)')      { $count      = [int]$Matches[1] }
                        Send-Response $stream -Body (New-ListResponse -Items @($data[$collection]) -StartIndex $startIndex -Count $count)
                        continue
                    }
                    Send-Response $stream -Status 404 -Body '{"detail":"not found","status":"404"}'
                } finally { try { $client.Close() } catch {} }
            }
        } finally { try { $listener.Stop() } catch {}; Write-Output "MOCK_STOPPED" }
    }

    $job = Start-Job -ScriptBlock $serverScript -ArgumentList $port, $payload
    $started = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 200
        $out = Receive-Job -Job $job -Keep 2>&1
        if ($out -match 'MOCK_STARTED') { $started = $true; break }
        if ($out -match 'MOCK_ERROR')   { break }
    }
    if (-not $started) {
        $out = Receive-Job -Job $job -Keep 2>&1
        Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
        throw "Mock SCIM server failed to start on port $port. Output: $($out -join '; ')"
    }
    return [PSCustomObject]@{ Job = $job; Port = $port }
}

# Replace what the running mock serves, without restarting it (and therefore
# without changing its port — see the /__mock/state handler for why that matters).
function Set-MockScimData {
    [CmdletBinding()]
    param([Parameter(Mandatory)][PSCustomObject]$Mock, [array]$Users, [array]$Groups)
    $payload = @{ users = @($Users); groups = @($Groups) } | ConvertTo-Json -Depth 30 -Compress
    Invoke-RestMethod -Uri "http://127.0.0.1:$($Mock.Port)/__mock/state" -Method Post -Body $payload `
        -ContentType 'application/json' -TimeoutSec 10 | Out-Null
}

# Every request path (with query string) the mock has served so far, in order.
# Lets a test assert on the actual paging calls instead of inferring them.
function Get-MockScimRequests {
    [CmdletBinding()]
    param([Parameter(Mandatory)][PSCustomObject]$Mock)
    $out = Receive-Job -Job $Mock.Job -Keep 2>&1
    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($line in @($out)) {
        if ([string]$line -match '^MOCK_REQUEST: (.+)$') { [void]$paths.Add($Matches[1]) }
    }
    return @($paths)
}

function Stop-MockScimServer {
    [CmdletBinding()]
    param([Parameter(Mandatory)][PSCustomObject]$Mock)
    try { Stop-Job -Job $Mock.Job -ErrorAction SilentlyContinue } catch {}
    try { Remove-Job -Job $Mock.Job -Force -ErrorAction SilentlyContinue } catch {}
}

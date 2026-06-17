<#
.SYNOPSIS
    Reusable mock midPoint REST server for crawler integration tests.

.DESCRIPTION
    Starts a TcpListener background job that serves midPoint-shaped REST responses,
    mirroring Start-MockODataServer but for the midPoint REST API contract:

      POST /midpoint/ws/rest/{type}/search  → { object: { "@type": "ObjectListType", object: [ ... ] } }

    The crawler only issues search requests, so GET-by-oid and resource test are not
    implemented. Basic auth is accepted from any credentials. Paging is honoured:
    a request with paging.offset > 0 returns an empty list so the crawler's paging
    loop terminates after one page.

    Using TcpListener (not HttpListener) means no URL ACL registration is needed and
    the Host header is not validated, so a Docker worker can reach the mock via
    host.docker.internal.

.EXAMPLE
    . tools/crawlers/shared/Start-MockMidpointServer.ps1
    $mock = Start-MockMidpointServer -Objects @{
        users = @( @{ oid='...'; name='alice'; fullName='Alice' } )
        roles = @( @{ oid='...'; name='r1' } )
    }
    # ... tests ...
    Stop-MockMidpointServer -Mock $mock
#>

function Get-FreeMidpointPort {
    [CmdletBinding()] param()
    $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $tcp.Start(); $port = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port; $tcp.Stop()
    return $port
}

function Start-MockMidpointServer {
    <#
    .PARAMETER Objects
        Hashtable mapping REST collection names (users, roles, orgs, services, resources,
        shadows) to arrays of midPoint object hashtables.
    .OUTPUTS
        [PSCustomObject] with Job and Port.
    #>
    [CmdletBinding()]
    param([hashtable]$Objects = @{})

    $port        = Get-FreeMidpointPort
    $objectsJson = $Objects | ConvertTo-Json -Depth 30 -Compress

    $serverScript = {
        param([int]$Port, [string]$ObjectsJson)
        $objects = $ObjectsJson | ConvertFrom-Json -AsHashtable

        function Send-Response {
            param($Stream, [int]$Status = 200, [string]$Body = '')
            $statusText = @{ 200='OK'; 400='Bad Request'; 401='Unauthorized'; 404='Not Found'; 405='Method Not Allowed' }[$Status] ?? 'Unknown'
            $bodyBytes  = [System.Text.Encoding]::UTF8.GetBytes($Body)
            $hdr        = "HTTP/1.1 $Status $statusText`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
            $hdrBytes   = [System.Text.Encoding]::UTF8.GetBytes($hdr)
            try { $Stream.Write($hdrBytes,0,$hdrBytes.Length); if ($bodyBytes.Length) { $Stream.Write($bodyBytes,0,$bodyBytes.Length) }; $Stream.Flush() } catch {}
        }

        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
        try { $listener.Start() } catch { Write-Output "MOCK_ERROR: $($_.Exception.Message)"; return }
        Write-Output "MOCK_STARTED: port=$Port"

        try {
            while ($true) {
                if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
                $client = $listener.AcceptTcpClient()
                try {
                    $stream = $client.GetStream(); $stream.ReadTimeout = 2000
                    $buf = [byte[]]::new(65536); $n = 0
                    try { $n = $stream.Read($buf,0,$buf.Length) } catch {}
                    if ($n -eq 0) { continue }
                    $raw      = [System.Text.Encoding]::UTF8.GetString($buf,0,$n)
                    $lines    = $raw -split "`r`n"
                    $reqParts = ($lines[0] -split ' ',3)
                    $method   = $reqParts[0]
                    $fullPath = if ($reqParts.Count -gt 1) { $reqParts[1] } else { '/' }
                    $path     = ($fullPath -split '\?')[0]
                    $body     = if ($raw -match "\r\n\r\n([\s\S]+)$") { $Matches[1].Trim() } else { '' }

                    # midPoint REST: POST /midpoint/ws/rest/{type}/search
                    if ($method -eq 'POST' -and $path -match '/ws/rest/([^/]+)/search$') {
                        $type   = $Matches[1]
                        $offset = 0
                        if ($body -match '"offset"\s*:\s*(\d+)') { $offset = [int]$Matches[1] }
                        $items = if ($offset -gt 0) { @() } elseif ($objects.ContainsKey($type)) { @($objects[$type]) } else { @() }
                        $envelope = @{
                            '@ns'  = 'http://prism.evolveum.com/xml/ns/public/types-3'
                            object = @{ '@ns' = 'http://midpoint.evolveum.com/xml/ns/public/common/common-3'; '@type' = 'ObjectListType'; object = $items }
                        } | ConvertTo-Json -Depth 30 -Compress
                        Send-Response $stream -Body $envelope
                        continue
                    }
                    # Health/actuator probe
                    if ($method -eq 'GET' -and $path -match '/actuator/health') { Send-Response $stream -Body '{"status":"UP"}'; continue }
                    Send-Response $stream -Status 404 -Body '{"error":"not found"}'
                } finally { try { $client.Close() } catch {} }
            }
        } finally { try { $listener.Stop() } catch {}; Write-Output "MOCK_STOPPED" }
    }

    $job = Start-Job -ScriptBlock $serverScript -ArgumentList $port, $objectsJson
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
        throw "Mock midPoint server failed to start on port $port. Output: $($out -join '; ')"
    }
    return [PSCustomObject]@{ Job = $job; Port = $port }
}

function Stop-MockMidpointServer {
    [CmdletBinding()]
    param([Parameter(Mandatory)][PSCustomObject]$Mock)
    try { Stop-Job -Job $Mock.Job -ErrorAction SilentlyContinue } catch {}
    try { Remove-Job -Job $Mock.Job -Force -ErrorAction SilentlyContinue } catch {}
}

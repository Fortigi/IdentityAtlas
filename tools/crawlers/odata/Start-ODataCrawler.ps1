<#
.SYNOPSIS
    Generic OData crawler — connects to any OData v4 endpoint and imports data into Identity Atlas.

.DESCRIPTION
    Standard crawler interface: reads config from -ConfigPath JSON file.
    Depends on the OData protocol functions in this same directory (auto-loaded by dispatcher).

    Implementation note: The generic OData crawler maps entity sets to Identity Atlas
    resource types via configurable typeMappings in the crawler config.
    See docs/architecture/odata-crawler.md for the configuration schema.

.PARAMETER ApiBaseUrl
    Identity Atlas API base URL.

.PARAMETER ApiKey
    Built-in crawler API key for authenticating to the Identity Atlas API.

.PARAMETER JobId
    Job ID for progress reporting.

.PARAMETER ConfigPath
    Path to a temporary JSON file containing the full crawler configuration.
    Written by the dispatcher; deleted by the dispatcher after the crawler exits.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [string]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable

throw "Generic OData crawler is not yet implemented. Use an OData-based crawler (e.g. 'omada') or implement Start-ODataCrawler.ps1 for your specific OData endpoint."

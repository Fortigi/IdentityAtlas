<#
.SYNOPSIS
    Custom connectors push data to Identity Atlas via the ingest API — they are
    not run by the worker. This entry point exists so the type appears in the
    registry; invoking it as a job will fail by design.
#>
[CmdletBinding()]
Param()
throw "Custom connectors push data via the ingest API and cannot be run as a crawler job. Register a connector via POST /api/admin/crawlers and use the returned API key to call /api/ingest/*."

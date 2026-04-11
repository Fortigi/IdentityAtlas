<#
.SYNOPSIS
    Save-FGResourceClusters (v5 stub).

.DESCRIPTION
    The risk scoring + account correlation feature was disabled during the
    postgres migration because the v4 implementation talked directly to SQL
    Server. The v5 replacement will go through new API endpoints that don't
    exist yet. This file is a placeholder so module loading doesn't fail.

    See docs/architecture/postgres-migration.md for the planned approach.
#>
function Save-FGResourceClusters {
    [CmdletBinding()] Param()
    Write-Warning 'Save-FGResourceClusters is not yet implemented in v5 (postgres). Risk scoring is currently disabled.'
}

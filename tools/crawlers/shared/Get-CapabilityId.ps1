<#
.SYNOPSIS
    Deterministic capability-resource id (SHA256-UUID) — PowerShell counterpart of
    app/api/src/lib/capabilityId.js.

.DESCRIPTION
    A capability-resource represents "<capability> @ <target node>" (an Azure role at a scope,
    an app role on an application, a permission level on a folder, ...). Its id must be
    identical whether a crawler writes the row or the effective-access engine synthesizes it,
    so that an inherited (synthesized) row and a directly-declared (stored) row for the same
    (capability, node) collapse into a single matrix row.

    Algorithm (docs/architecture/effective-access-engine.md §11):
        input = UTF-8 bytes of "<TargetNodeId>|<CapabilityId>"
        hash  = SHA256(input)
        id    = lowercase hex of hash[0..15], formatted xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

    No RFC-4122 version/variant bits are set — this is an opaque deterministic primary key.

.NOTES
    Cross-language conformance with the JS implementation is pinned by identical golden vectors
    in test/unit/CapabilityId.Tests.ps1. Dot-source this file from a crawler entry point:
        . (Join-Path $PSScriptRoot '..' 'shared' 'Get-CapabilityId.ps1')
#>

function Get-CapabilityId {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string]$TargetNodeId,
        [Parameter(Mandatory)] [string]$CapabilityId
    )

    # The separator must be unambiguous: a '|' inside either component would make the input
    # format ambiguous and could collide two distinct (node, capability) pairs. Reject it.
    if ($TargetNodeId.Contains('|') -or $CapabilityId.Contains('|')) {
        throw "Get-CapabilityId: '|' is reserved as the field separator and must not appear in TargetNodeId or CapabilityId"
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$TargetNodeId|$CapabilityId")
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }

    # First 16 bytes, lowercase hex, formatted as a UUID.
    $hex = ([System.BitConverter]::ToString($hash[0..15]) -replace '-', '').ToLowerInvariant()
    return '{0}-{1}-{2}-{3}-{4}' -f `
        $hex.Substring(0, 8), $hex.Substring(8, 4), $hex.Substring(12, 4), `
        $hex.Substring(16, 4), $hex.Substring(20, 12)
}

<#
.SYNOPSIS
    Builds the $select used when PRIMING a Graph delta token.

.DESCRIPTION
    A delta query tracks changes only on the properties named in its $select.
    Priming with `$select=id` therefore produces a token that reports a
    membership/tombstone change but never an attribute change — so every delta
    run silently missed a renamed department, a new job title, a flipped
    accountEnabled, and those values only corrected themselves on the next full
    sync.

    The fix is to prime with the SAME select the full fetch uses, minus the
    properties a delta query cannot serve:

      signInActivity  — not supported on /users/delta. Sign-in activity comes
                        from the daily full sync (the expected operating model
                        is one full sync per day, delta in between).

    Plus the properties a delta query must track although the full fetch
    does not select them:

      manager         — the full fetch reads it with `$expand=manager`, which
                        /users/delta rejects. Named in the delta `$select`
                        instead, Graph tracks the relationship and reports it
                        as a `manager@delta` annotation (an `@removed` entry
                        when it is cleared). Without it a token never reports a
                        manager-only change, and every manager stayed stale
                        until the next full sync (#1627).

    Pure string work, no I/O, so it unit-tests directly.
#>

[CmdletBinding()]
param()

# Properties Graph will not track (or return) on a delta query, so they must be
# dropped from a select before it is used to prime a delta token.
$script:FGDeltaUnsupportedUserSelect = @('signInActivity')

# Properties a user delta token must track that the full-fetch select never
# names, appended to the priming select (see the header).
$script:FGDeltaRequiredUserSelect = @('manager')

function Get-EntraDeltaSelect {
    <#
    .SYNOPSIS
        A full-fetch $select reduced to what a delta query can track.

    .PARAMETER Select
        The comma-separated $select the full fetch uses.

    .PARAMETER Unsupported
        Property names to drop. Defaults to the user-delta set above; pass an
        empty array for a collection (service principals) where every selected
        property is supported.

    .PARAMETER Required
        Property names to append when the select does not already name them.
        Defaults to the user-delta set above; pass an empty array for any other
        collection.

    .OUTPUTS
        The comma-separated select, with order and duplicates preserved as-is
        and the required properties last.
    #>
    [CmdletBinding()]
    param(
        [string]$Select,
        [string[]]$Unsupported = $script:FGDeltaUnsupportedUserSelect,
        [string[]]$Required = $script:FGDeltaRequiredUserSelect
    )

    $kept = @(
        $Select -split ',' |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and ($Unsupported -notcontains $_) }
    )

    # A select that filtered down to nothing would make Graph return the default
    # property set; `id` is the minimum that still identifies a changed object.
    if ($kept.Count -eq 0) {
        $kept = @('id')
    }

    foreach ($property in $Required) {
        if ($kept -notcontains $property) { $kept += $property }
    }

    return ($kept -join ',')
}

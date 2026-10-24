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

    `$expand=manager` is likewise unsupported on /users/delta, but it is a
    separate query option rather than part of the select, so it is simply not
    added to the priming URI — manager keeps coming from the full sync.

    Pure string work, no I/O, so it unit-tests directly.
#>

[CmdletBinding()]
param()

# Properties Graph will not track (or return) on a delta query, so they must be
# dropped from a select before it is used to prime a delta token.
$script:FGDeltaUnsupportedUserSelect = @('signInActivity')

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

    .OUTPUTS
        The comma-separated select, with order and duplicates preserved as-is.
    #>
    [CmdletBinding()]
    param(
        [string]$Select,
        [string[]]$Unsupported = $script:FGDeltaUnsupportedUserSelect
    )

    if ([string]::IsNullOrWhiteSpace($Select)) {
        return 'id'
    }

    $kept = @(
        $Select -split ',' |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and ($Unsupported -notcontains $_) }
    )

    # A select that filtered down to nothing would make Graph return the default
    # property set; `id` is the minimum that still identifies a changed object.
    if ($kept.Count -eq 0) {
        return 'id'
    }

    return ($kept -join ',')
}

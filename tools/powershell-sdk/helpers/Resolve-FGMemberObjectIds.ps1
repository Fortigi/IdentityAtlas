function Resolve-FGSingleMemberObjectId {
    # Private helper: resolves one display-name / UPN string to a single Entra
    # object ID. Tried as a group display name first, then as a user UPN. Throws
    # if the name matches more than one object or none at all.
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$Member,
        [Parameter(Mandatory = $true)]
        [string]$GroupName
    )

    $MemberGroupObjectID = (Get-FGGroup -DisplayName $Member).id
    $MemberUserObjectID  = (Get-FGUser -UPN $Member).id

    if ($MemberGroupObjectID) {
        if ($MemberGroupObjectID.count -gt 1) {
            throw "More than one possible match found, for member: $Member of Group: $GroupName"
        }
        return $MemberGroupObjectID
    }

    if ($MemberUserObjectID) {
        if ($MemberUserObjectID.count -gt 1) {
            throw "More than one possible match found, for member: $Member of Group: $GroupName"
        }
        return $MemberUserObjectID
    }

    throw "Member: $Member of group: $GroupName could not be found."
}

function Resolve-FGMemberObjectIds {
    # Private helper: resolves an array of display-name / UPN strings to Entra
    # object IDs. Each name is tried as a group display name first, then as a
    # user UPN. Throws if a name matches more than one object or none at all.
    # Used by Confirm-FGGroupMember and Confirm-FGNotGroupMember.
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$GroupName,
        [Parameter(Mandatory = $false)]
        [array]$Members
    )

    [array]$MemberObjectIDs = $null

    If ($Members) {
        Foreach ($Member in $Members) {
            $MemberObjectIDs += Resolve-FGSingleMemberObjectId -Member $Member -GroupName $GroupName
        }
    }

    return $MemberObjectIDs
}

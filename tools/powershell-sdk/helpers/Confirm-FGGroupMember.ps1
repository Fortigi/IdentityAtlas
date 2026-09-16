function Confirm-FGGroupMember {
    [alias("Confirm-GroupMember")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$GroupName,
        [Parameter(Mandatory = $false)]
        [array]$Members,
        [Parameter(Mandatory = $false)]
        [boolean]$RemoveMembers
    )

    $Group = Confirm-FGGroup -GroupName $GroupName
    [array]$MemberObjectIDs = Resolve-FGMemberObjectIds -GroupName $GroupName -Members $Members
    $CurrentMemberObjectIDs = (Get-FGGroupMember -ObjectId $Group.id).id

    # Group currently empty: every desired member is an addition.
    If ($null -eq $CurrentMemberObjectIDs) {
        foreach ($MemberObjectID in $MemberObjectIDs) {
            Write-Host ("Adding Member: $MemberObjectID to " + $GroupName) -ForegroundColor Yellow
            Add-FGGroupMember -ObjectId $Group.id -MemberId $MemberObjectID
        }
        return
    }

    # Nothing desired: every current member is a removal (only when allowed).
    If ($null -eq $MemberObjectIDs) {
        If ($RemoveMembers -ne $true) { return }
        foreach ($CurrentMemberObjectID in $CurrentMemberObjectIDs) {
            Write-Host ("Removing Member: $CurrentMemberObjectID from " + $GroupName) -ForegroundColor Red
            Remove-FGGroupMember -ObjectId $Group.id -MemberId $CurrentMemberObjectID
        }
        return
    }

    # Both sides present: reconcile the difference.
    $Difs = Compare-Object -ReferenceObject $CurrentMemberObjectIDs -DifferenceObject $MemberObjectIDs
    If ($null -eq $Difs) {
        Write-host ("Group: " + $GroupName + " members confirmed.") -ForegroundColor Green
    }
    Foreach ($Dif in $Difs) {
        if ($Dif.SideIndicator -eq "=>") {
            Write-Host ("Adding Member: " + $Dif.InputObject + " to " + $GroupName) -ForegroundColor Yellow
            Add-FGGroupMember -ObjectId $Group.id -MemberId $Dif.InputObject
        }
        if (($Dif.SideIndicator -eq "<=") -and ($RemoveMembers -eq $true)) {
            Write-Host ("Removing Member: " + $Dif.InputObject + " from " + $GroupName) -ForegroundColor Red
            Remove-FGGroupMember -ObjectId $Group.id -MemberId $Dif.InputObject
        }
    }
}

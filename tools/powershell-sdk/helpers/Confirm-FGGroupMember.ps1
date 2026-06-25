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

    If ($null -eq $CurrentMemberObjectIDs) {
        foreach ($MemberObjectID in $MemberObjectIDs) {
            Write-Host ("Adding Member: $MemberObjectID to " + $GroupName) -ForegroundColor Yellow
            Add-FGGroupMember -ObjectId $Group.id -MemberId $MemberObjectID
        }
    }

    If ($null -eq $MemberObjectIDs) {
        foreach ($CurrentMemberObjectID in $CurrentMemberObjectIDs) {
            If ($RemoveMembers -eq $true) {
                Write-Host ("Removing Member: $CurrentMemberObjectID from " + $GroupName) -ForegroundColor Red
                Remove-FGGroupMember -ObjectId $Group.id -MemberId $CurrentMemberObjectID
            }
        }
    }

    If (($null -ne $CurrentMemberObjectIDs) -and ($null -ne $MemberObjectIDs)) {
        $Difs = Compare-Object -ReferenceObject $CurrentMemberObjectIDs -DifferenceObject $MemberObjectIDs

        If ($null -eq $Difs) {
            Write-host ("Group: " + $GroupName + " members confirmed.") -ForegroundColor Green
        }
        Foreach ($Dif in $Difs) {
            if ($Dif.SideIndicator -eq "=>") {
                Write-Host ("Adding Member: " + $Dif.InputObject + " to " + $GroupName) -ForegroundColor Yellow
                Add-FGGroupMember -ObjectId $Group.id -MemberId $Dif.InputObject
            }
            if ($Dif.SideIndicator -eq "<=") {
                If ($RemoveMembers -eq $true) {
                    Write-Host ("Removing Member: " + $Dif.InputObject + " from " + $GroupName) -ForegroundColor Red
                    Remove-FGGroupMember -ObjectId $Group.id -MemberId $Dif.InputObject
                }
            }
        }
    }
}

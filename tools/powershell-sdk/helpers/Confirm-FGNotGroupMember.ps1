function Confirm-FGNotGroupMember {
    [alias("Confirm-NotGroupMember")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$GroupName,
        [Parameter(Mandatory = $true)]
        [array]$Members
    )

    $Group = Confirm-FGGroup -GroupName $GroupName
    [array]$MemberObjectIDs = Resolve-FGMemberObjectIds -GroupName $GroupName -Members $Members
    $CurrentMemberObjectIDs = (Get-FGGroupMember -ObjectId $Group.id).id

    If ($null -eq $CurrentMemberObjectIDs) {
        Write-host ("Group: " + $GroupName + " members confirmed.") -ForegroundColor Green
    }
    else {
        Foreach ($MemberObjectID in $MemberObjectIDs) {
            If ($CurrentMemberObjectIDs -contains $MemberObjectID) {
                Write-Host ("Removing Member: $MemberObjectID from " + $GroupName) -ForegroundColor Red
                Remove-FGGroupMember -ObjectId $Group.id -MemberId $MemberObjectID
            }
        }
    }
}

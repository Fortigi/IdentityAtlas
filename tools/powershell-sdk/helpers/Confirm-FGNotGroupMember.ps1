function Confirm-FGNotGroupMember {
    [alias("Confirm-NotGroupMember")]
    [cmdletbinding()]
    Param (
        [Parameter(Mandatory = $true)]
        [string]$GroupName,
        [Parameter(Mandatory = $true)]
        [array]$Members
    )

    #Get Group
    $Group = Confirm-FGGroup -GroupName $GroupName

    #Check if members exist
    [array]$MemberObjectIDs = $null
    If ($Members) {
        Foreach ($Member in $Members) {
            
            $MemberGroupObjectID = (Get-FGGroup -DisplayName $Member).id
            $MemberUserObjectID = (Get-FGUser -UPN $Member).id

            if ($MemberGroupObjectID) {
                If ($MemberGroupObjectID.count -gt 1) {
                    throw "More than one possible match found, for member: $Member of Group: $GroupName"
                }
                Else {
                    $MemberObjectIDs += $MemberGroupObjectID
                }
            }
            elseif ($MemberUserObjectID) {
                If ($MemberUserObjectID.count -gt 1) {
                    throw "More than one possible match found, for member: $Member of Group: $GroupName"
                }
                Else {
                    $MemberObjectIDs += $MemberUserObjectID
                }
            }
            else {
                throw "Member: $Member of group: $GroupName could not be found."
            }
        } 
    }
    
    #Compair Current and Set Members
    $CurrentMemberObjectIDs = (Get-FGGroupMember -ObjectId $Group.id).id

    #If it has no members.. good.
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
function Confirm-FGGroupMember {
    [alias("Confirm-GroupMember")]
    [cmdletbinding()]
    Param (
        [Parameter(Mandatory = $true)]
        [string]$GroupName,
        [Parameter(Mandatory = $false)]
        [array]$Members,
        [Parameter(Mandatory = $false)]
        [boolean]$RemoveMembers
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

    #If it has not members.. just and any new members
    If ($null -eq $CurrentMemberObjectIDs) {
        foreach ($MemberObjectID in $MemberObjectIDs) {
            Write-Host ("Adding Member: $MemberObjectID to " + $GroupName) -ForegroundColor Yellow
            Add-FGGroupMember -ObjectId $Group.id -MemberId $MemberObjectID
        }
    }

    #If it should not have members, remove any existing members
    If ($null -eq $MemberObjectIDs) {
        foreach ($CurrentMemberObjectID in $CurrentMemberObjectIDs) {
            If ($RemoveMembers -eq $true) {
                Write-Host ("Removing Member: $CurrentMemberObjectID from " + $GroupName) -ForegroundColor Red
                Remove-FGGroupMember -ObjectId $Group.id -MemberId $CurrentMemberObjectID
            }
        }
    }

    #If it has members and shoud have members, check if they are the correct
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
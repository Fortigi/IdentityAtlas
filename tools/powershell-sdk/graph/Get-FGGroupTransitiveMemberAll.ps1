function Get-FGGroupTransitiveMemberAll {
    [alias("Get-GroupTransitiveMemberAll")]
    [cmdletbinding()]
    #Get Groups
    $GraphURI = 'https://graph.microsoft.com/beta'
    $URI = $GraphURI + '/groups?$select=id'
    [array]$Groups = Invoke-FGGetRequest -URI $URI

    [int]$GroupCount = $Groups.Count
    [int]$Count = 0

    #Export Group Memberships
    $GroupMembership = [System.Collections.Generic.List[hashtable]]::new()

    Foreach ($Group in $Groups) {

        $Count++
        $Completed = ($Count/$GroupCount) * 100
        Write-Progress -Activity "Getting All Group Transitive Members" -Status "Progress:" -PercentComplete $Completed

        $URI = $GraphURI + "/groups/" + $Group.id + '/transitiveMembers?$select=id'
        [array]$Members = Invoke-FGGetRequest -URI $URI

        Foreach ($Member in $Members) {
            $Row = @{
                "groupId"    = $Group.id
                "memberId"   = $Member.id
                "memberType" = $Member.'@odata.type'
            }
            $GroupMembership.Add($Row)
        }

    }

    Return $GroupMembership.ToArray()
}
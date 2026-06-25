function Get-FGGroupMemberAll {
    [alias("Get-GroupMemberAll")]
    [cmdletbinding()]
    Param(
        [switch]$Transitive
    )

    $GraphURI = 'https://graph.microsoft.com/beta'
    $URI = $GraphURI + '/groups?$select=id'
    [array]$Groups = Invoke-FGGetRequest -URI $URI

    [int]$GroupCount = $Groups.Count
    [int]$Count = 0

    $GroupMembership = [System.Collections.Generic.List[hashtable]]::new()

    $memberSegment    = if ($Transitive) { 'transitiveMembers' } else { 'members' }
    $progressActivity = if ($Transitive) { 'Getting All Group Transitive Members' } else { 'Getting All Group Members' }

    Foreach ($Group in $Groups) {
        $Count++
        $Completed = ($Count / $GroupCount) * 100
        Write-Progress -Activity $progressActivity -Status "Progress:" -PercentComplete $Completed

        $URI = $GraphURI + "/groups/" + $Group.id + "/${memberSegment}?`$select=id"
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

function Get-FGGroupMemberAllToFile {
    [alias("Get-GroupMemberAllToFile")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$File,
        [switch]$Transitive
    )

    $GraphURI = 'https://graph.microsoft.com/beta'
    $URI = $GraphURI + '/groups?$select=id'

    Write-Host "Getting Groups..."
    [array]$Groups = Invoke-FGGetRequest -URI $URI

    [int]$GroupCount = $Groups.Count
    [int]$Count = 0
    Write-Host $GroupCount " found."

    If (Test-Path $File) {
        Remove-Item $File -Force
    }

    $memberSegment    = if ($Transitive) { 'transitiveMembers' } else { 'members' }
    $progressActivity = if ($Transitive) { 'Getting All Group Transitive Members' } else { 'Getting All Group Members' }

    "[" | Out-File $File -Append

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
            $Row | ConvertTo-Json | Out-File $File -Append
            "," | Out-File $File -Append
        }
    }

    "]" | Out-File $File -Append

    # Remove the trailing comma before the closing bracket.
    Remove-FGTrailingCommaFromJsonFile -File $File
}

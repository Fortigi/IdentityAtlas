function Get-FGGroupTransitiveMemberAllToFile {
    [alias("Get-GroupTransitiveMemberAllToFile")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$File
    )
    Get-FGGroupMemberAllToFile -File $File -Transitive
}

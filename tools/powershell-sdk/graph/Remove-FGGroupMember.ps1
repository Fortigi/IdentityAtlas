function Remove-FGGroupMember {
    [alias("Remove-GroupMember")]
    [cmdletbinding()]
    Param
    (
        [Alias("ObjectId")]
        [Parameter(Mandatory = $true)]
        [string]$Id,
        [Alias("MemberObjectId")]
        [Parameter(Mandatory = $true)]
        [string]$MemberId
    )


    $URI = 'https://graph.microsoft.com/beta/groups/'+$Id+'/members/'+$MemberId+'/$ref'

    $Result = Invoke-FGDeleteRequest -URI $URI
    $Result
   
}
function Remove-FGAccessPackage {
    [alias("Remove-AccessPackage")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$AccessPackageID,
        [Parameter(Mandatory = $false)]
        [string]$Force
    )

    #If force is used.. remove all active assignments
    If ($Force -eq $True) {
        
        #Get Assignements
        $URI = 'https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignments?$expand=target,accessPackage'
        $Assignements = Invoke-FGGetRequest -URI $URI
        [array]$ActiveAccessPackageAssignments = $Assignements | Where-Object { $_.state -ne "expired" -and $_.accessPackage.id -eq $AccessPackageID }

        #Remove them
        Foreach ($ActiveAccessPackageAssignment in $ActiveAccessPackageAssignments) {
            $Body = @{
                requestType = "AdminRemove"
                assignment  = @{
                    id = $ActiveAccessPackageAssignment.id
                }
            }

            $URI = 'https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentRequests'
            Invoke-FGPostRequest -URI $URI -Body $Body
        }
    }

    $URI = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackages/$AccessPackageID"

    $Result = Invoke-FGDeleteRequest -URI $URI
    $Result

}
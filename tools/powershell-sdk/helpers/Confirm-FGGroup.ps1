function Confirm-FGGroup {
    [alias("Confirm-Group")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$GroupName,
        [Parameter(Mandatory = $false)]
        [string]$GroupDescription
    )

    #Check if group exists only once
    [array]$Group = Get-FGGroup -GroupName $GroupName
    if ($Group.count -eq 1) {
        Write-Host "Confirmed Group exists: $GroupName" -ForegroundColor Green

        If ($GroupDescription) {
            If ($Group.Description -eq $GroupDescription) {
                Write-Host ("Confirmed Group Description: " + $GroupDescription) -ForegroundColor Green
            }
            else {
                Write-Host ("Setting Group Description: " + $GroupDescription ) -ForegroundColor Yellow
                #$Updates = @{description = $GroupDescription }
                Set-Group -ObjectId $Group[0].id -Description $GroupDescription
            }
        }
    }
    elseif ($Group.count -gt 1) {
        throw "More than one group found with name: $GroupName"
    }
    else {
        Write-Host ("Creating Group:" + $GroupName) -ForegroundColor Yellow
        If ($GroupDescription) {
            $Group = @{
                displayName     = $GroupName
                description     = $GroupDescription
                groupTypes      = @()
                mailEnabled     = $false
                mailNickname    = $GroupName.Replace(" ", "").ToLower()
                securityEnabled = $true
            }
        }
        else {
            $Group = @{
                displayName     = $GroupName
                groupTypes      = @()
                mailEnabled     = $false
                mailNickname    = $GroupName.Replace(" ", "").ToLower()
                securityEnabled = $true
            }
        }

        #Create Group
        New-FGGroup @Group

        #Get Group with all attributes.. including the object ID.
        # Group creation may take a moment. Try immediately, retry after 5 seconds up to 6 times.
        $GroupIsCreated = $False
        $Count = 0

        while (($GroupIsCreated -ne $True) -and ($Count -lt 6)) {
            $Group = Get-Group -GroupName $GroupName
            If ($Group.id) {
                Write-Host "Found"
                $GroupIsCreated = $True
            }
            else {
                Write-Host "Not Found, Trying again 5sec"
                Start-Sleep -s 5
                $Count++
            }
        }

        if ($GroupIsCreated -eq $false) {
            Throw "Group creation failed. After trying to create the group it could not be read back in time."
        }

    }

    return $Group

}
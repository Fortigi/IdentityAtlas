function Get-FGGroupEligibleMemberAll {
    [alias("Get-GroupEligibleMemberAll")]
    [cmdletbinding()]
    # Query all groups and check each for PIM eligibility schedules
    # Note: isAssignableToRole and PIM-enabled are INDEPENDENT properties since January 2023
    # Any group (except dynamic/on-prem synced) can be PIM-enabled, not just role-assignable groups
    # The Graph API requires filtering eligibilitySchedules by groupId - cannot query all at once
    # See: https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/concept-pim-for-groups
    # API: https://learn.microsoft.com/en-us/graph/api/privilegedaccessgroup-list-eligibilityschedules

    $GraphURI = 'https://graph.microsoft.com/beta'

    Write-Progress -Activity "Getting All Group Eligible Members" -Status "Fetching all groups..." -PercentComplete 0

    # Get ALL groups - don't pre-filter by isAssignableToRole since PIM-enabled is independent
    $URI = $GraphURI + '/groups?$select=id,displayName,groupTypes'
    Try {
        [array]$AllGroups = Invoke-FGGetRequest -URI $URI

        # Filter out groups that CANNOT be PIM-enabled (dynamic membership)
        # Any other group type CAN be PIM-enabled
        $CandidateGroups = $AllGroups | Where-Object {
            $_.groupTypes -notcontains "DynamicMembership"
        }

        [int]$GroupCount = $CandidateGroups.Count
        [int]$Count = 0
        [int]$PIMGroupCount = 0

        Write-Progress -Activity "Getting All Group Eligible Members" -Status "Found $GroupCount groups to check for PIM eligibility" -PercentComplete 10

        #Export Eligible Group Members
        [array]$GroupEligibleMembers = @()

        Foreach ($Group in $CandidateGroups) {
            $Count++
            $Completed = ($Count/$GroupCount) * 100
            Write-Progress -Activity "Getting All Group Eligible Members" -Status "Checking group $Count of $GroupCount" -PercentComplete $Completed

            # Query eligibility schedules for this specific group (API requires groupId filter)
            $URI = $GraphURI + "/identityGovernance/privilegedAccess/group/eligibilitySchedules?`$filter=groupId eq '$($Group.id)'"
            Try {
                $Results = Invoke-FGGetRequest -Uri $URI

                # Only process if group has eligible members
                if ($Results -and $Results.Count -gt 0) {
                    $PIMGroupCount++

                    Foreach ($Result in $Results) {
                        $Row = @{
                            "groupId"    = $Result.groupId
                            "memberId"   = $Result.principalId
                        }
                        $GroupEligibleMembers += $Row
                    }
                }
            }
            Catch {
                # Group has no PIM eligibilities or error occurred - skip it
                # This is expected for non-PIM groups
            }
        }

        Write-Progress -Activity "Getting All Group Eligible Members" -Completed

        Write-Host "Checked $GroupCount groups, found $PIMGroupCount PIM-enabled groups with $($GroupEligibleMembers.Count) eligible memberships" -ForegroundColor Green

        Return $GroupEligibleMembers
    }
    Catch {
        Write-Progress -Activity "Getting All Group Eligible Members" -Completed
        Write-Error "Failed to retrieve eligible group members: $_"
        Return $null
    }
}

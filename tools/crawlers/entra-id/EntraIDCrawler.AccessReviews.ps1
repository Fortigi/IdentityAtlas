<#
.SYNOPSIS
    Access-review decision fetching for the Entra ID crawler.

.DESCRIPTION
    Moved out of EntraIDCrawler.Phases.ps1 (grandfathered over the file-length
    ceiling, allowed only to shrink) when the decisions gained the reviewers each
    round contacted. Sync-EntraGovernanceReviews, which walks the definitions,
    stays in the Phases file and calls Get-EntraAccessReviewCertRecords here.
    Record shaping is pure and lives in EntraIDCrawler.Transform.ps1.
#>

# Fetch every decision under an access-review definition's instances and shape
# them into CertificationDecisions records. All Graph I/O for one definition;
# per-instance failures are logged and skipped. Pulled out of the review loop so
# Sync-EntraGovernanceReviews stays under the complexity threshold.
function Get-EntraAccessReviewCertRecords {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Definition,
        [string]$ApId
    )
    $out = [System.Collections.Generic.List[object]]::new()
    try {
        $instances = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions/$($Definition.id)/instances?`$top=100")
        foreach ($inst in $instances) {
            $out.AddRange([object[]]@(Get-EntraReviewInstanceDecisions -Definition $Definition -Instance $inst -ApId $ApId))
        }
    } catch {
        Write-Host "  Skipping review definition $($Definition.id): $($_.Exception.Message)" -ForegroundColor Yellow
    }
    return $out
}

# All CertificationDecisions records for one access-review instance. Graph caps the
# decisions collection at 100/page (larger $top 400s — rely on @odata.nextLink). A
# per-instance failure is logged (with the real Graph error body) and skipped.
function Get-EntraReviewInstanceDecisions {
    [CmdletBinding()]
    param($Definition, $Instance, [string]$ApId)
    $out = [System.Collections.Generic.List[object]]::new()
    try {
        $decisions = @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions/$($Definition.id)/instances/$($Instance.id)/decisions")
        $contacted = @(Get-EntraReviewContactedReviewers -Definition $Definition -Instance $Instance)
        foreach ($d in $decisions) {
            $out.Add((ConvertTo-EntraCertificationDecisionRecord -Decision $d -Definition $Definition -Instance $Instance -ApId $ApId -ContactedReviewers $contacted))
        }
    } catch {
        Write-Host "    Skipping instance $($Instance.id): $(Get-FGGraphErrorDetail $_)" -ForegroundColor Yellow
    }
    return $out
}

# The reviewers Entra contacted for one instance — who was asked to decide,
# whether or not they did. Best effort: an older tenant or a missing permission
# must not cost the decisions themselves, so a failure is logged and yields none.
function Get-EntraReviewContactedReviewers {
    [CmdletBinding()]
    param($Definition, $Instance)
    try {
        return @(Invoke-FGGetRequest -URI "https://graph.microsoft.com/beta/identityGovernance/accessReviews/definitions/$($Definition.id)/instances/$($Instance.id)/contactedReviewers")
    } catch {
        Write-Host "    No contacted reviewers for instance $($Instance.id): $(Get-FGGraphErrorDetail $_)" -ForegroundColor Yellow
        return @()
    }
}

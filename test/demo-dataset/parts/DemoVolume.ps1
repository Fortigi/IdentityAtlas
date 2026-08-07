<#
.SYNOPSIS
    Fortigi Demo Corp — the optional high-cardinality volume slice.

.DESCRIPTION
    Opt-in (Generate-DemoDataset.ps1 -IncludeVolume). Adds a block of synthetic
    Entra groups whose descriptions are all distinct, so a deployment loaded from
    the demo dataset holds more than 500 distinct `Resources.description` values.

    Why it exists: the matrix wizard's "+ Attribute" picker serves ONE PAGE of a
    column's distinct values (500 by default, see MATRIX_VALUE_PAGE_SIZE) and
    flags the column as truncated when there are more. That path — the subject of
    issue #928 — simply does not appear on the standard 46-resource dataset,
    which carries about a dozen distinct descriptions, so a test environment
    loaded from it cannot demonstrate or verify the behaviour.

    The slice is deliberately NOT part of the default dataset: the public demo,
    the Capture-the-Flag answers, Verify-DemoDataset.ps1's exact row counts and
    the E2E suite all assume the small, hand-reasoned company.

    Shape of the slice:
      * $VolumeGroupCount groups `SG-Vol-0001`… each with its own description.
      * One sentinel group, `SG-Zzz-Cap-Probe`, whose description starts with
        'Zzz' so it sorts alphabetically LAST — guaranteeing it falls outside the
        preloaded page. That is exactly the reporter's scenario in #928: a value
        that exists in the data (and in the Excel export) but is past the end of
        the list, reachable only through the picker's value search.

    Descriptions are plain ASCII on purpose: a tester types part of one into the
    search box, so they must survive the generator → ingest → database → UI round
    trip without any encoding subtlety.
#>

Set-StrictMode -Version Latest

# Comfortably past the 500-value default page, leaving room for the descriptions
# the rest of the dataset already contributes plus the sentinel behind them.
$script:VolumeGroupCount = 520

# The sentinel's description — sorts after every generated 'Volume group …' value.
$script:VolumeSentinelDescription = 'Zzz - beyond the preloaded 500 (#928 probe)'

function Add-DemoVolume {
    param([Parameter(Mandatory)]$State)

    $sysEntra = $State.SystemIds['entra']

    # One Direct assignment per group, rotating over the provisioned employees,
    # so every volume group is a real matrix row rather than an orphan resource.
    $employees = @(Get-DemoProvisioned $State)
    if ($employees.Count -eq 0) { throw 'Add-DemoVolume must run after Add-DemoOrg — no provisioned employees found' }

    for ($i = 1; $i -le $script:VolumeGroupCount; $i++) {
        $n = '{0:D4}' -f $i
        $id = Add-DemoResource $State `
            -Id (New-DemoGuid "res-vol-group-$n") `
            -DisplayName "SG-Vol-$n" `
            -ResourceType 'Group' `
            -SystemId $sysEntra `
            -Description "Volume group $n - synthetic high-cardinality description (#928)"

        $employee = $employees[($i - 1) % $employees.Count]
        Add-DemoAssignment $State -ResourceId $id -PrincipalId (Get-DemoPrincipalId $employee.id) -AssignmentType 'Direct'
    }

    $sentinelId = Add-DemoResource $State `
        -Id (New-DemoGuid 'res-vol-group-sentinel') `
        -DisplayName 'SG-Zzz-Cap-Probe' `
        -ResourceType 'Group' `
        -SystemId $sysEntra `
        -Description $script:VolumeSentinelDescription

    Add-DemoAssignment $State -ResourceId $sentinelId -PrincipalId (Get-DemoPrincipalId $employees[0].id) -AssignmentType 'Direct'
}

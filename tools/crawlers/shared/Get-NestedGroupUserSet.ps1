<#
.SYNOPSIS
    Walks group-in-group nesting and returns every user reachable from a set of
    seed groups.

.DESCRIPTION
    The closure walk behind every crawler's Indirect-assignment materialisation.
    The matrix reads a declared-only matview and never walks nesting itself, so
    each crawler that supports nested groups has to materialise the inherited
    rows — and each had written this same iterative depth-first walk out for
    itself (Entra ID and SCIM, identically).

    Iterative rather than recursive, with a `visited` set, so a membership cycle
    (A contains B contains A — which real directories do contain) terminates
    instead of blowing the stack.

.PARAMETER SeedGroups
    Group ids to start from — typically the direct child groups of the group
    whose inherited members are being computed.

.PARAMETER ChildGroups
    Hashtable: group id → its child group ids.

.PARAMETER DirectUsers
    Hashtable: group id → the user ids directly assigned to it.

.OUTPUTS
    [System.Collections.Generic.HashSet[string]] of user ids.
#>
function Get-NestedGroupUserSet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $SeedGroups,
        [Parameter(Mandatory)] $ChildGroups,
        [Parameter(Mandatory)] $DirectUsers
    )
    $users   = [System.Collections.Generic.HashSet[string]]::new()
    $visited = [System.Collections.Generic.HashSet[string]]::new()
    $stack   = [System.Collections.Generic.Stack[string]]::new()
    foreach ($g in $SeedGroups) { [void]$stack.Push($g) }
    while ($stack.Count -gt 0) {
        $g = $stack.Pop()
        if (-not $visited.Add($g)) { continue }
        if ($DirectUsers.ContainsKey($g)) {
            foreach ($u in $DirectUsers[$g]) { [void]$users.Add($u) }
        }
        if ($ChildGroups.ContainsKey($g)) {
            foreach ($cg in $ChildGroups[$g]) { [void]$stack.Push($cg) }
        }
    }
    return $users
}

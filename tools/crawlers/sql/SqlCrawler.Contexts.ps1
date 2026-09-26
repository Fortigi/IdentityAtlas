<#
.SYNOPSIS
    Contexts for the SQL Database crawler: a catalogue of groupings (logical
    applications, say) and the resources that belong to each.

.DESCRIPTION
    Dot-sourced after SqlCrawler.Transform.ps1. Two query targets use it:

      contexts          one row per context: id (optional key), displayName, …
      context-members   one row per membership: contextId OR contextName, memberId

    A source often names the grouping on each member only by its display name,
    and names drift: "Finance", "Finance " and "finance" are one application to a
    person and three strings to a computer. So resolution happens HERE, in one
    place, and never in SQL on either side. A case-insensitive source collation
    would hide the drift that PostgreSQL then exposes, and the two would disagree.

      * A context's key is its `id` column when the statement returns one (a
        configuration-management reference is stable across renames), else its
        normalised name. The key becomes the Context's externalId; the display
        name stays the source's own string.
      * A member resolves by contextId, else by normalised contextName, through a
        map built from the catalogue.
      * Nothing is folded silently. Every spelling that differs from the
        catalogue's own, every member naming a context the catalogue lacks, every
        ambiguous name and every duplicate key is counted and logged with
        samples. A member whose context is unknown keeps its resource and loses
        only the membership: inventing a context the catalogue does not have
        would make a grouping look complete while being wrong.

    Contexts and ContextMembers have no systemId, so the timestamp reconcile
    cannot remove their stale rows. Both are therefore buffered (a catalogue is
    small; memberships are one short record per resource) and sent as one full
    sync, exactly as the CSV crawler does.
#>

#region Catalogue

$script:SqlContextSampleSize = 10

# The one normalisation of a context reference. Trim, then fold case with the
# INVARIANT culture: ToLower() follows the current culture, and under a Turkish
# locale "I" folds to a dotless "ı" while "i" stays "i" — two machines would then
# disagree about whether two application names are the same.
function ConvertTo-SqlContextName {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()] [AllowEmptyString()] [string]$Name)
    if ($null -eq $Name) { return '' }
    return $Name.Trim().ToLowerInvariant()
}

function New-SqlContextCatalog {
    [CmdletBinding()]
    param()
    $ord = [System.StringComparer]::Ordinal
    return @{
        Records    = [System.Collections.Generic.List[object]]::new()
        ByKey      = [System.Collections.Generic.Dictionary[string, object]]::new($ord)
        ByName     = [System.Collections.Generic.Dictionary[string, string]]::new($ord)
        Ambiguous  = [System.Collections.Generic.HashSet[string]]::new($ord)
        Duplicates = [System.Collections.Generic.List[string]]::new()
        # key -> the source spellings that resolved to it but differ from the catalogue's
        Folded     = [System.Collections.Generic.Dictionary[string, object]]::new($ord)
        # raw context reference -> number of members that named it
        Unresolved = [System.Collections.Generic.Dictionary[string, int]]::new($ord)
        Members    = [System.Collections.Generic.List[object]]::new()
        MemberKeys = [System.Collections.Generic.HashSet[string]]::new($ord)
    }
}

# One contexts-target row -> a Context record in the catalogue. Returns $null
# (skip) without a usable name; counts a repeated key and keeps the first.
function Add-SqlContextRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$Catalog)
    $display = [string](Get-SqlMapped -Row $Row -Map $Map -Name 'displayName')
    if (-not $display.Trim()) { $display = [string](Get-SqlMapped -Row $Row -Map $Map -Name 'name') }
    $name = ConvertTo-SqlContextName $display
    if (-not $name) { return $null }
    $id  = ([string](Get-SqlMapped -Row $Row -Map $Map -Name 'id')).Trim()
    $key = if ($id) { $id } else { $name }
    if ($Catalog.ByKey.ContainsKey($key)) { $Catalog.Duplicates.Add($key); return $null }
    $rec = [ordered]@{
        externalId  = $key
        displayName = $display
        variant     = 'synced'
        contextType = $Slot.contextType
        targetType  = $Slot.targetType
    }
    $desc = Get-SqlMapped -Row $Row -Map $Map -Name 'description'
    if ($null -ne $desc -and [string]$desc -ne '') { $rec['description'] = [string]$desc }
    $owner = Get-SqlMapped -Row $Row -Map $Map -Name 'ownerUserId'
    if ($null -ne $owner -and [string]$owner -ne '') { $rec['ownerUserId'] = [string]$owner }
    $ext = Get-SqlExtendedAttributes -Row $Row -Map $Map
    if ($ext) { $rec['extendedAttributes'] = $ext }
    $Catalog.ByKey[$key] = $rec
    $Catalog.Records.Add($rec)
    # Two catalogue entries folding to one name make that name ambiguous: a member
    # naming it cannot be placed, and says so, rather than landing in either.
    if ($Catalog.ByName.ContainsKey($name) -and $Catalog.ByName[$name] -ne $key) { [void]$Catalog.Ambiguous.Add($name) }
    else { $Catalog.ByName[$name] = $key }
    return $rec
}

# A member's context reference -> the catalogue key, or $null. Records a folded
# spelling (resolved, but not the catalogue's own string) and an unresolved one.
function Resolve-SqlContextReference {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Catalog, [AllowNull()] [string]$ContextId, [AllowNull()] [string]$ContextName)
    $id = if ($ContextId) { $ContextId.Trim() } else { '' }
    if ($id) {
        if ($Catalog.ByKey.ContainsKey($id)) { return $id }
        $Catalog.Unresolved[$id] = 1 + ($Catalog.Unresolved[$id] ?? 0)
        return $null
    }
    $name = ConvertTo-SqlContextName $ContextName
    if (-not $name) { return $null }
    if ($Catalog.Ambiguous.Contains($name) -or -not $Catalog.ByName.ContainsKey($name)) {
        $Catalog.Unresolved[$ContextName] = 1 + ($Catalog.Unresolved[$ContextName] ?? 0)
        return $null
    }
    $key = $Catalog.ByName[$name]
    if ($ContextName -cne $Catalog.ByKey[$key].displayName) {
        if (-not $Catalog.Folded.ContainsKey($key)) { $Catalog.Folded[$key] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal) }
        [void]$Catalog.Folded[$key].Add($ContextName)
    }
    return $key
}

#endregion Catalogue

#region Row handlers

function Add-SqlContextRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $rec = Add-SqlContextRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot -Catalog $Ctx.State.Contexts
    if (-not $rec) { $Ctx.Skipped++ }
}

# A membership row. No member id → skipped; a member the run has not seen →
# dangling; a context the catalogue cannot place → unresolved (counted inside
# the catalogue, and reported). The resource itself is never affected.
function Add-SqlContextMemberRow {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Ctx)
    $member = ([string](Get-SqlMapped -Row $Row -Map $Ctx.Map -Name 'memberId')).Trim()
    $contextId = [string](Get-SqlMapped -Row $Row -Map $Ctx.Map -Name 'contextId')
    $contextName = [string](Get-SqlMapped -Row $Row -Map $Ctx.Map -Name 'contextName')
    # A member that names no context at all is not a membership (a resource
    # without a logical application): skipped, not "unresolved".
    if (-not $member -or -not ($contextId.Trim() -or $contextName.Trim())) { $Ctx.Skipped++; return }
    $st = $Ctx.State
    if ($st.HasResources -and $Ctx.Slot.memberType -eq 'Resource' -and -not $st.KnownResources.Contains($member)) { $Ctx.Dangling++; return }
    $catalog = $st.Contexts
    $key = Resolve-SqlContextReference -Catalog $catalog -ContextId $contextId -ContextName $contextName
    if (-not $key) { $Ctx.Unresolved++; return }
    if (-not $catalog.MemberKeys.Add("$key|$member")) { return }
    $catalog.Members.Add([ordered]@{ contextExternalId = $key; memberExternalId = $member; memberType = $Ctx.Slot.memberType; addedBy = 'sync' })
}

#endregion Row handlers

#region Send and report

# The data-quality facts a catalogue run produced, as plain numbers and samples.
function Get-SqlContextReport {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Catalog)
    $n = $script:SqlContextSampleSize
    $folded = foreach ($e in $Catalog.Folded.GetEnumerator()) {
        foreach ($s in $e.Value) { "'$s' -> '$($Catalog.ByKey[$e.Key].displayName)'" }
    }
    $unresolved = $Catalog.Unresolved.GetEnumerator() | Sort-Object -Property @{ Expression = 'Value'; Descending = $true }, Key |
        Select-Object -First $n | ForEach-Object { "'$($_.Key)' ($($_.Value))" }
    return [ordered]@{
        contexts            = $Catalog.Records.Count
        members             = $Catalog.Members.Count
        foldedSpellings     = @($folded).Count
        foldedIntoContexts  = $Catalog.Folded.Count
        foldedSample        = @($folded | Select-Object -First $n)
        unresolvedNames     = $Catalog.Unresolved.Count
        unresolvedMembers   = [int](($Catalog.Unresolved.Values | Measure-Object -Sum).Sum)
        unresolvedSample    = @($unresolved)
        ambiguousNames      = @($Catalog.Ambiguous | Select-Object -First $n)
        duplicateKeys       = @($Catalog.Duplicates | Select-Object -First $n)
        duplicateKeyCount   = $Catalog.Duplicates.Count
    }
}

function Write-SqlContextReport {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Report)
    Write-Host "  Contexts: $($Report.contexts.ToString('N0')), memberships: $($Report.members.ToString('N0'))" -ForegroundColor Gray
    if ($Report.foldedSpellings) {
        Write-Host "  $($Report.foldedSpellings) source spelling(s) differ from the catalogue only by case or surrounding spaces and were matched to $($Report.foldedIntoContexts) context(s):" -ForegroundColor Yellow
        foreach ($s in $Report.foldedSample) { Write-Host "    $s" -ForegroundColor Yellow }
    }
    if ($Report.unresolvedNames) {
        Write-Host "  $($Report.unresolvedMembers.ToString('N0')) membership(s) name $($Report.unresolvedNames) context(s) the catalogue does not have; those resources are kept, without a context:" -ForegroundColor Yellow
        foreach ($s in $Report.unresolvedSample) { Write-Host "    $s" -ForegroundColor Yellow }
    }
    if ($Report.ambiguousNames.Count) { Write-Host "  Ambiguous catalogue names (several entries fold to one): $($Report.ambiguousNames -join ', ')" -ForegroundColor Yellow }
    if ($Report.duplicateKeyCount) { Write-Host "  $($Report.duplicateKeyCount) catalogue row(s) repeat a key and were skipped: $($Report.duplicateKeys -join ', ')" -ForegroundColor Yellow }
}

# Send the buffered catalogue or memberships for the slot that just finished.
# Returns the number of records sent.
function Send-SqlContextBuffer {
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$State)
    $catalog = $State.Contexts
    $isMembers = $Slot.target -eq 'context-members'
    # Plain assignment, not `$records = if (…) { … }`: an if-expression unrolls the
    # list, so ONE record arrives bare and .Count counts that record's keys.
    $records = $catalog.Records
    if ($isMembers) { $records = $catalog.Members }
    $endpoint = if ($isMembers) { 'ingest/context-members' } else { 'ingest/contexts' }
    $scope = if ($isMembers) { @{} } else { @{ variant = 'synced' } }
    Invoke-CrawlerIngestBatch -Endpoint $endpoint -SystemId $State.SystemId -SyncMode $State.SyncMode -Scope $scope `
        -Records @($records) -BatchSize $State.BatchSize -IdGeneration 'deterministic' -IdPrefix $State.IdPrefix -SkipWhenEmpty | Out-Null
    if ($isMembers) {
        $report = Get-SqlContextReport -Catalog $catalog
        Write-SqlContextReport -Report $report
        $State.ContextReport = $report
    }
    return $records.Count
}

#endregion Send and report

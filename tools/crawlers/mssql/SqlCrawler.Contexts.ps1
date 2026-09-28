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
        # Owners: how many the catalogue already named by account key, how many
        # an employee number had to be translated for, and the ones that match
        # nobody (raw value -> how many contexts named it).
        OwnerDirect     = 0
        OwnerMapped     = 0
        OwnerUnresolved = [System.Collections.Generic.Dictionary[string, int]]::new($ord)
    }
}

# A catalogue's owner reference -> the account key that owner is stored under.
#
# The catalogue and the directory do not have to agree on how a person is named.
# IdentityIQ's application catalogue names the owner by employee number, while
# every account is keyed on the identity id — so the owner the UI showed resolved
# to nobody, on data that was otherwise correct. The translation happens here,
# against the accounts this run has already read, and never in SQL: the same
# statement has to work when the owner is already an account key.
#
# An owner that matches nothing is returned UNCHANGED and counted. Dropping it
# would hide an owner the source does have; inventing one would be worse than
# either.
function Resolve-SqlContextOwner {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [hashtable]$Catalog,
        [AllowNull()] [AllowEmptyString()] [string]$Owner,
        [hashtable]$State
    )
    $value = if ($null -eq $Owner) { '' } else { $Owner.Trim() }
    if (-not $value) { return '' }
    # No accounts in this run: nothing to resolve against, so the owner is
    # passed through and NOT counted as unresolved — that number has to mean
    # "the source names an owner we cannot find", not "we did not look".
    if ($null -eq $State -or -not $State.HasPrincipals) { return $value }
    if ($State.KnownPrincipals.Contains($value)) { $Catalog.OwnerDirect++; return $value }
    $mapped = $null
    if ($State.PrincipalsByEmployeeId.TryGetValue($value, [ref]$mapped)) { $Catalog.OwnerMapped++; return $mapped }
    $Catalog.OwnerUnresolved[$value] = 1 + ($Catalog.OwnerUnresolved[$value] ?? 0)
    return $value
}

# One contexts-target row -> a Context record in the catalogue. Returns $null
# (skip) without a usable name; counts a repeated key and keeps the first.
function Add-SqlContextRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Row, [Parameter(Mandatory)] [hashtable]$Map, [Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$Catalog, [hashtable]$State)
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
    $owner = Resolve-SqlContextOwner -Catalog $Catalog -Owner ([string](Get-SqlMapped -Row $Row -Map $Map -Name 'ownerUserId')) -State $State
    if ($owner) { $rec['ownerUserId'] = $owner }
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
    $rec = Add-SqlContextRecord -Row $Row -Map $Ctx.Map -Slot $Ctx.Slot -Catalog $Ctx.State.Contexts -State $Ctx.State
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

#region The root

# 'LogicalApplication' -> 'Logical Applications'. Only ever a fallback: a slot
# that cares what its root is called says so in rootDisplayName, and the shipped
# IdentityIQ preset does. English pluralisation is not a science, so this covers
# the three regular cases and no more.
function ConvertTo-SqlPluralLabel {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()] [AllowEmptyString()] [string]$Value)
    $words = (([string]$Value) -creplace '(?<!^)([A-Z])', ' $1').Trim()
    if (-not $words) { return 'Contexts' }
    if ($words -match '(?i)(s|x|z|ch|sh)$')  { return $words + 'es' }
    if ($words -match '(?i)[^aeiou]y$')      { return $words.Substring(0, $words.Length - 1) + 'ies' }
    return $words + 's'
}

function Get-SqlContextRootName {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Slot)
    $named = ([string]$Slot.rootDisplayName).Trim()
    if ($named) { return $named }
    return ConvertTo-SqlPluralLabel ([string]$Slot.contextType)
}

# The key of the root. Namespaced with a colon, which a configuration-management
# reference and a normalised application name both lack, so it cannot collide
# with a catalogue entry by accident — and if it somehow does, Get-SqlContextRoot
# leaves the catalogue alone rather than overwriting a real application.
function Get-SqlContextRootKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)] [hashtable]$Slot)
    return "root:$($Slot.contextType)"
}

# The one context every catalogue entry hangs under, or $null when there should
# not be one.
#
# Without it a source with 1,500 logical applications renders as 1,500 top-level
# rows: a list, not a tree, and unusable however correct the counts are.
#
# The root is a synced context of the SAME contextType, sent in the same batch
# and stamped with the same scopeSystemId as its children. That is deliberate:
# the full sync's reconcile is bounded by (variant, contextType, scopeSystemId),
# so a root of some other type would sit OUTSIDE the scope — never deleted, but
# never refreshed either, and a rename would strand the old one forever. Inside
# the scope, being in the batch is what keeps it; a second identical run upserts
# the same deterministic id and changes nothing.
#
# An empty catalogue gets no root. A full sync carrying only a root would
# reconcile away every context a previous run created, and an empty tree is not
# an improvement on an empty list.
function Get-SqlContextRoot {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$Catalog)
    if ($Catalog.Records.Count -eq 0) { return $null }
    $key = Get-SqlContextRootKey -Slot $Slot
    if ($Catalog.ByKey.ContainsKey($key)) { return $null }
    return [ordered]@{
        externalId  = $key
        displayName = Get-SqlContextRootName -Slot $Slot
        variant     = 'synced'
        contextType = $Slot.contextType
        targetType  = $Slot.targetType
        description = "Every $($Slot.contextType) this system syncs."
    }
}

# The catalogue, hung under its root: the root first, then every entry parented
# to it. Returns a List so a one-entry catalogue does not unroll to a bare
# record on the way back (the same trap the buffer-sending code documents).
function Get-SqlRootedContextRecords {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [hashtable]$Slot, [Parameter(Mandatory)] [hashtable]$Catalog)
    $out = [System.Collections.Generic.List[object]]::new()
    $root = Get-SqlContextRoot -Slot $Slot -Catalog $Catalog
    if ($root) {
        $out.Add($root)
        # A catalogue entry that already names a parent keeps it: the root is the
        # fallback for entries with nowhere else to go, not an override.
        foreach ($r in $Catalog.Records) { if (-not $r.Contains('parentExternalId')) { $r['parentExternalId'] = $root.externalId } }
    } elseif ($Catalog.Records.Count -gt 0) {
        Write-Host "  Catalogue already has a context keyed '$(Get-SqlContextRootKey -Slot $Slot)'; leaving it as the tree's own root." -ForegroundColor Yellow
    }
    $out.AddRange($Catalog.Records)
    return , $out
}

#endregion The root

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
    $ownerLost = $Catalog.OwnerUnresolved.GetEnumerator() | Sort-Object -Property @{ Expression = 'Value'; Descending = $true }, Key |
        Select-Object -First $n | ForEach-Object { "'$($_.Key)' ($($_.Value))" }
    return [ordered]@{
        ownersKeyed            = $Catalog.OwnerDirect
        ownersMapped           = $Catalog.OwnerMapped
        ownersUnresolved       = $Catalog.OwnerUnresolved.Count
        ownersUnresolvedRows   = [int](($Catalog.OwnerUnresolved.Values | Measure-Object -Sum).Sum)
        ownersUnresolvedSample = @($ownerLost)
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

# The owner facts, printed when the catalogue is sent (the rest of the report
# waits for the memberships). An owner nobody can find is the finding here: it
# is kept exactly as the source spelled it, so the number says how much of the
# catalogue will show a raw string where a person should be.
function Write-SqlContextOwnerReport {
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Report)
    if ($Report.ownersMapped) {
        Write-Host "  $($Report.ownersMapped.ToString('N0')) owner(s) named by employee number were resolved to an account; $($Report.ownersKeyed.ToString('N0')) already named one." -ForegroundColor Gray
    }
    if ($Report.ownersUnresolved) {
        Write-Host "  $($Report.ownersUnresolvedRows.ToString('N0')) context(s) name $($Report.ownersUnresolved) owner(s) that match no account; the value is kept as the source spells it:" -ForegroundColor Yellow
        foreach ($s in $Report.ownersUnresolvedSample) { Write-Host "    $s" -ForegroundColor Yellow }
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
    else { $records = Get-SqlRootedContextRecords -Slot $Slot -Catalog $catalog }
    $endpoint = if ($isMembers) { 'ingest/context-members' } else { 'ingest/contexts' }
    # Contexts and memberships are shared by every crawler. Stamping this system as
    # the owner is what lets the ingest bound a full sync to them: without it, one
    # run's reconcile removed other systems' contexts and every membership outside
    # its batch. The type goes in the scope too, so one catalogue replaces only its own.
    if (-not $isMembers) { foreach ($r in $records) { $r['scopeSystemId'] = $State.SystemId } }
    $scope = if ($isMembers) { @{} } else { @{ variant = 'synced'; contextType = $Slot.contextType; scopeSystemId = $State.SystemId } }
    Invoke-CrawlerIngestBatch -Endpoint $endpoint -SystemId $State.SystemId -SyncMode $State.SyncMode -Scope $scope `
        -Records @($records) -BatchSize $State.BatchSize -IdGeneration 'deterministic' -IdPrefix $State.IdPrefix -SkipWhenEmpty | Out-Null
    if ($isMembers) {
        $report = Get-SqlContextReport -Catalog $catalog
        Write-SqlContextReport -Report $report
        $State.ContextReport = $report
    } else {
        Write-SqlContextOwnerReport -Report (Get-SqlContextReport -Catalog $catalog)
    }
    return $records.Count
}

#endregion Send and report

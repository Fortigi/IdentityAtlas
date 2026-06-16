<#
.SYNOPSIS
    Load-test data seeder for the midPoint crawler — creates a large fictitious AD
    (users + groups + group memberships) directly in midPoint as RAW shadows.

.DESCRIPTION
    This is a function library (no side effects on dot-source). It seeds, at scale, the
    exact object graph the crawler reads in its Shadows phase:

      • 1 ResourceType "LT-AD-Resource" — a CLONE of the existing AD resource's cached
        SCHEMA + schemaHandling + connectorRef, with the connectorConfiguration STRIPPED so
        it can never connect to the real AD. The cloned schema defines the `ri:user` /
        `ri:group` object classes and the `group` reference attribute, which is what makes
        raw shadows with referenceAttributes round-trip through `search?...&include=association`
        (without a schema definition midPoint throws a ClassCastException on that search).
      • N group entitlement-shadows  — objectClass `ri:group`,  kind=entitlement.
      • N account shadows            — objectClass `ri:user`,   kind=account, each carrying its
                                        group memberships in `referenceAttributes.group[]`.
      • N users                      — each linkRef → its account shadow.

    Memberships follow a deterministic POWER-LAW distribution (a few mega-groups + a long
    tail; some users in many groups, most in few), summing to the tier's target count.

    Everything is created RAW (`?options=raw&options=overwrite`) so midPoint stores the repo
    objects directly without invoking the connector or recomputing projections — fast and
    side-effect-free. Fixed OIDs in the `1b…` block make it idempotent and safely removable.

    WHY raw + cloned schema (not real provisioning): provisioning 300k memberships through a
    live connector needs a backing store and is far too slow. Raw shadows on a schema-bearing
    resource reproduce the same data the crawler reads, at a fraction of the cost.

.NOTES
    OID scheme (all in the 1b… block, disjoint from IA-Test's 1a… block):
      Resource : 1b000000-0000-4000-8000-000000000001
      Groups   : 1b000000-0000-4000-8000-0001XXXXXXXX  (entitlement shadows)
      Users    : 1b000000-0000-4000-8000-0002XXXXXXXX
      Accounts : 1b000000-0000-4000-8000-0003XXXXXXXX  (account shadows)

    Run from any host that can reach the midPoint REST endpoint, e.g.:
      . ./Seed-MidpointLoadData.ps1
      New-MidpointLoadData -BaseUrl http://midpoint-dev:8080/midpoint -Username administrator -Password $pw -Tier T1
#>

#region Specification

function Get-MidpointLoadSpec {
    <#
    .SYNOPSIS  Tier definitions for the ramp-up (users / groups / target memberships).
    #>
    [CmdletBinding()]
    param([ValidateSet('T1', 'T2', 'T3', 'T4')] [string]$Tier = 'T3')
    $tiers = @{
        T1 = @{ users = 250;  groups = 1000;  memberships = 30000   }
        T2 = @{ users = 1250; groups = 5000;  memberships = 150000  }
        T3 = @{ users = 2500; groups = 10000; memberships = 300000  }
        # T4 = beyond-spec stress tier to locate midpoint-dev's actual ceiling.
        T4 = @{ users = 5000; groups = 20000; memberships = 1000000 }
    }
    $t = $tiers[$Tier]
    return [pscustomobject]@{
        tier        = $Tier
        users       = $t.users
        groups      = $t.groups
        memberships = $t.memberships
        resourceOid = '1b000000-0000-4000-8000-000000000001'
        resourceName = 'LT-AD-Resource'
        # OID node-part (last 12 hex) prefixes per object kind
        groupPrefix   = '0001'
        userPrefix    = '0002'
        accountPrefix = '0003'
    }
}

function Get-LoadOid {
    <# .SYNOPSIS  Deterministic fixed OID for a (kind, index): 1b…-<prefix><8-hex index>. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Prefix, [Parameter(Mandatory)][int]$Index)
    return '1b000000-0000-4000-8000-{0}{1:x8}' -f $Prefix, $Index
}

#endregion Specification

#region Distribution (pure, deterministic — unit-tested)

function Get-LoadAssignmentPlan {
    <#
    .SYNOPSIS
        Build a deterministic, realistically-skewed membership plan: which group indices each
        user belongs to, summing to ~Memberships. Pure (no I/O); same Seed → same plan.
    .DESCRIPTION
        GROUP-DRIVEN power law (the realistic shape): group popularity follows a Zipf weight
        1/((j+1)^GroupSkew). A handful of "universal" head groups end up holding every user
        (think "Domain Users"); a long tail of small groups holds a few each. Group sizes are
        assigned by WATER-FILLING — because the weights are monotonically decreasing, the head
        groups that would exceed the user count are exactly a prefix; they clamp to Users and
        the remaining membership budget is renormalised over the unclamped tail. This hits
        ~Memberships without the per-user count ever exceeding the number of groups (the bug a
        user-driven power law has: head users wanting more groups than exist).

        Members of each group are then sampled (uniformly, deduped) from the user population —
        cheap and collision-light because tail groups are small and head groups take everyone.
        Per-user counts emerge moderately skewed (everyone gets the universal groups + a
        binomial tail), which is the realistic outcome.
    .OUTPUTS
        [pscustomobject] with:
          UserGroups  — [int[][]] : UserGroups[i] = sorted distinct group indices for user i
          Total       — actual total memberships produced (≈ Memberships)
          MaxPerUser / MaxPerGroup — observed extremes
          UniversalGroups — number of head groups holding every user
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$Users,
        [Parameter(Mandatory)][int]$Groups,
        [Parameter(Mandatory)][int]$Memberships,
        [int]$Seed       = 1337,
        [double]$GroupSkew = 1.1
    )
    if ($Users -le 0 -or $Groups -le 0) { throw "Users and Groups must be positive" }
    if ($Memberships -gt ([long]$Users * $Groups)) { throw "Memberships ($Memberships) exceeds Users*Groups capacity" }
    $rnd = [System.Random]::new($Seed)

    # ── Group weights (monotonically decreasing) + suffix sums for water-filling ──
    $w = [double[]]::new($Groups)
    for ($j = 0; $j -lt $Groups; $j++) { $w[$j] = [math]::Pow($j + 1, -$GroupSkew) }
    $suffix = [double[]]::new($Groups + 1)   # suffix[k] = sum_{j>=k} w[j]
    for ($j = $Groups - 1; $j -ge 0; $j--) { $suffix[$j] = $suffix[$j + 1] + $w[$j] }

    # Water-fill: find k = #head groups that clamp to Users. Group k is the first whose
    # proportional allocation of the remaining budget is <= Users.
    $k = 0
    while ($k -lt $Groups) {
        $remainingBudget = $Memberships - ([double]$k * $Users)
        if ($remainingBudget -le 0) { break }
        $allocK = $remainingBudget * $w[$k] / $suffix[$k]
        if ($allocK -le $Users) { break }
        $k++
    }

    $sizes = [int[]]::new($Groups)
    for ($j = 0; $j -lt $k; $j++) { $sizes[$j] = $Users }                  # universal head groups
    $tailBudget = $Memberships - ($k * $Users)
    $tailW = $suffix[$k]
    $running = 0
    for ($j = $k; $j -lt $Groups; $j++) {
        $c = if ($tailW -gt 0) { [int][math]::Round($tailBudget * $w[$j] / $tailW) } else { 0 }
        if ($c -gt $Users) { $c = $Users }
        if ($c -lt 0) { $c = 0 }
        $sizes[$j] = $c
        $running += $c
    }
    # Reconcile rounding drift on the tail toward the exact budget.
    $diff = $tailBudget - $running
    $j = $k
    $guard = 0
    while ($diff -ne 0 -and $guard -lt ($Groups * 4)) {
        if ($j -ge $Groups) { $j = $k }
        if ($diff -gt 0 -and $sizes[$j] -lt $Users) { $sizes[$j]++; $diff-- }
        elseif ($diff -lt 0 -and $sizes[$j] -gt 0)  { $sizes[$j]--; $diff++ }
        $j++; $guard++
    }

    # ── Materialise per-user group lists by sampling members for each group ──
    $userLists = [object[]]::new($Users)
    for ($i = 0; $i -lt $Users; $i++) { $userLists[$i] = [System.Collections.Generic.List[int]]::new() }
    $total      = 0
    $maxPerGroup = 0
    for ($j = 0; $j -lt $Groups; $j++) {
        $m = $sizes[$j]
        if ($m -le 0) { continue }
        if ($m -gt $maxPerGroup) { $maxPerGroup = $m }
        if ($m -ge $Users) {
            for ($i = 0; $i -lt $Users; $i++) { $userLists[$i].Add($j) }
            $total += $Users
        }
        elseif ($m -le ($Users / 2)) {
            # sample m distinct members
            $chosen = [System.Collections.Generic.HashSet[int]]::new()
            while ($chosen.Count -lt $m) { [void]$chosen.Add($rnd.Next($Users)) }
            foreach ($u in $chosen) { $userLists[$u].Add($j) }
            $total += $m
        }
        else {
            # sample the (Users-m) NON-members instead (cheaper when m is large)
            $excluded = [System.Collections.Generic.HashSet[int]]::new()
            $ex = $Users - $m
            while ($excluded.Count -lt $ex) { [void]$excluded.Add($rnd.Next($Users)) }
            for ($i = 0; $i -lt $Users; $i++) { if (-not $excluded.Contains($i)) { $userLists[$i].Add($j) } }
            $total += $m
        }
    }

    $userGroups = [int[][]]::new($Users)
    $maxPerUser = 0
    for ($i = 0; $i -lt $Users; $i++) {
        $arr = $userLists[$i].ToArray()
        [array]::Sort($arr)
        $userGroups[$i] = $arr
        if ($arr.Length -gt $maxPerUser) { $maxPerUser = $arr.Length }
    }

    return [pscustomobject]@{
        UserGroups      = $userGroups
        Total           = $total
        MaxPerUser      = $maxPerUser
        MaxPerGroup     = $maxPerGroup
        UniversalGroups = $k
    }
}

#endregion Distribution

#region REST helpers (internal, standalone — no load-order coupling)

function Get-LoadHeaders {
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()] param([string]$Username, [string]$Password)
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("${Username}:${Password}"))
    return @{ Authorization = "Basic $enc"; 'Content-Type' = 'application/json'; Accept = 'application/json' }
}

function Get-LoadRestRoot {
    [CmdletBinding()] param([string]$BaseUrl)
    $b = $BaseUrl.Trim().TrimEnd('/')
    if ($b -match '(?i)/ws/rest$') { return $b }
    if ($b -match '(?i)/midpoint$') { return "$b/ws/rest" }
    return "$b/midpoint/ws/rest"
}

function Invoke-LoadPut {
    <# .SYNOPSIS  Idempotent raw PUT with retry on transient/partition-creation failures. #>
    [CmdletBinding()]
    param(
        [string]$RestRoot, [hashtable]$Headers, [string]$Type, [string]$Oid,
        $Object, [string]$SingularKey, [int]$MaxRetries = 5
    )
    $body = @{ $SingularKey = $Object } | ConvertTo-Json -Depth 64 -Compress
    $uri  = "$RestRoot/$Type/$Oid`?options=raw&options=overwrite"
    $attempt = 0
    while ($true) {
        $attempt++
        try { Invoke-RestMethod -Uri $uri -Method Put -Headers $Headers -Body $body -TimeoutSec 120 | Out-Null; return }
        catch {
            $code = $null; try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
            # 500 here is typically the midPoint 4.9 shadow-partition-creation race (handled_error) —
            # retry with backoff; the first shadow of each (resource,objectClass) creates a partition.
            $transient = (-not $code) -or ($code -ge 500) -or ($code -eq 409) -or ($code -eq 412)
            if ($transient -and $attempt -le $MaxRetries) { Start-Sleep -Milliseconds (200 * [math]::Pow(2, $attempt)); continue }
            throw "PUT $Type/$Oid failed (HTTP $code): $($_.Exception.Message)"
        }
    }
}

#endregion REST helpers

#region Seeding

function New-MidpointLoadResource {
    <#
    .SYNOPSIS  Clone the existing AD resource's schema into LT-AD-Resource (connector neutralised).
    .DESCRIPTION
        Discovers the source AD resource (by -AdResourceOid, else by -AdResourceName), GETs it,
        and PUTs a new resource that keeps connectorRef + schema + schemaHandling + capabilities
        but DROPS connectorConfiguration (and all operational/metadata state). The cached schema
        is what lets raw shadows + referenceAttributes round-trip through the crawler's search.
    #>
    [CmdletBinding()]
    param(
        [string]$RestRoot, [hashtable]$Headers,
        [string]$ResourceOid, [string]$ResourceName,
        [string]$AdResourceOid = '', [string]$AdResourceName = 'Import AD Corporate.com'
    )
    # Resolve the source AD resource OID.
    if (-not $AdResourceOid) {
        $resp = Invoke-RestMethod -Uri "$RestRoot/resources/search" -Method Post -Headers $Headers `
            -Body (@{ query = @{ paging = @{ maxSize = 200 } } } | ConvertTo-Json -Depth 10) -TimeoutSec 60
        $list = $resp.object.object; if ($list -and $list -isnot [array]) { $list = @($list) }
        foreach ($r in @($list)) {
            $nm = if ($r.name.orig) { [string]$r.name.orig } else { [string]$r.name }
            if ($nm -eq $AdResourceName) { $AdResourceOid = [string]$r.oid; break }
        }
        if (-not $AdResourceOid) { throw "Could not find source AD resource named '$AdResourceName'. Pass -AdResourceOid." }
    }
    Write-Host "  Cloning schema from AD resource $AdResourceOid → $ResourceName" -ForegroundColor DarkGray
    $ad = Invoke-RestMethod -Uri "$RestRoot/resources/$AdResourceOid" -Method Get -Headers $Headers -TimeoutSec 120
    $src = if ($ad.resource) { $ad.resource } else { $ad }
    if (-not $src.schema) { throw "Source AD resource has no cached schema — cannot clone." }

    $lt = [ordered]@{
        oid            = $ResourceOid
        name           = $ResourceName
        description    = 'Load-test fictitious AD (cloned schema, connector neutralised). Raw shadows only — never provisioned.'
        lifecycleState = 'active'
        connectorRef   = $src.connectorRef
        schema         = $src.schema
        schemaHandling = $src.schemaHandling
        capabilities   = $src.capabilities
    }
    Invoke-LoadPut -RestRoot $RestRoot -Headers $Headers -Type 'resources' -Oid $ResourceOid -Object $lt -SingularKey 'resource'
    Write-Host "  Resource $ResourceName ready (connectorConfiguration stripped)" -ForegroundColor DarkGray
}

function New-MidpointLoadData {
    <#
    .SYNOPSIS  Seed a full load-test tier (resource + groups + accounts + users). Idempotent.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][string]$Username,
        [Parameter(Mandatory)][string]$Password,
        [ValidateSet('T1', 'T2', 'T3', 'T4')][string]$Tier = 'T3',
        [int]$Seed = 1337,
        [string]$AdResourceOid = ''
    )
    $spec    = Get-MidpointLoadSpec -Tier $Tier
    $root    = Get-LoadRestRoot -BaseUrl $BaseUrl
    $headers = Get-LoadHeaders -Username $Username -Password $Password
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    Write-Host "Seeding load-test tier $Tier → $root" -ForegroundColor Cyan
    Write-Host "  target: $($spec.users) users · $($spec.groups) groups · $($spec.memberships) memberships" -ForegroundColor Cyan

    # 1. Resource (cloned schema)
    New-MidpointLoadResource -RestRoot $root -Headers $headers -ResourceOid $spec.resourceOid `
        -ResourceName $spec.resourceName -AdResourceOid $AdResourceOid

    # 2. Build the deterministic membership plan
    Write-Host "  Building power-law membership plan (seed $Seed)…" -ForegroundColor DarkGray
    $plan = Get-LoadAssignmentPlan -Users $spec.users -Groups $spec.groups -Memberships $spec.memberships -Seed $Seed
    Write-Host "    plan: $($plan.Total) memberships · max/user $($plan.MaxPerUser) · max/group $($plan.MaxPerGroup)" -ForegroundColor DarkGray

    # 3. Pre-warm partitions: first group + first account (serial, retried) create the
    #    (resource, ri:group) and (resource, ri:user) partitions before the bulk inserts.
    $g0 = Get-LoadOid -Prefix $spec.groupPrefix -Index 0
    Invoke-LoadPut -RestRoot $root -Headers $headers -Type 'shadows' -Oid $g0 -SingularKey 'shadow' -Object (New-LoadGroupShadow -Oid $g0 -Index 0 -ResourceOid $spec.resourceOid)
    $a0 = Get-LoadOid -Prefix $spec.accountPrefix -Index 0
    Invoke-LoadPut -RestRoot $root -Headers $headers -Type 'shadows' -Oid $a0 -SingularKey 'shadow' -Object (New-LoadAccountShadow -Oid $a0 -Index 0 -ResourceOid $spec.resourceOid -GroupIndices @() -GroupPrefix $spec.groupPrefix)
    Write-Host "  Partitions pre-warmed (ri:group, ri:user)" -ForegroundColor DarkGray

    # 4. Group entitlement-shadows
    Write-Host "  Seeding $($spec.groups) group shadows…" -ForegroundColor DarkGray
    for ($j = 0; $j -lt $spec.groups; $j++) {
        $oid = Get-LoadOid -Prefix $spec.groupPrefix -Index $j
        if ($j -eq 0) { continue }   # pre-warmed
        Invoke-LoadPut -RestRoot $root -Headers $headers -Type 'shadows' -Oid $oid -SingularKey 'shadow' -Object (New-LoadGroupShadow -Oid $oid -Index $j -ResourceOid $spec.resourceOid)
        if (($j % 1000) -eq 0) { Write-Host "    groups $j/$($spec.groups)" -ForegroundColor DarkGray }
    }

    # 5. Account shadows (with memberships) + users (linkRef → account)
    Write-Host "  Seeding $($spec.users) accounts + users…" -ForegroundColor DarkGray
    for ($i = 0; $i -lt $spec.users; $i++) {
        $accOid = Get-LoadOid -Prefix $spec.accountPrefix -Index $i
        $usrOid = Get-LoadOid -Prefix $spec.userPrefix -Index $i
        $groups = $plan.UserGroups[$i]
        if ($i -ne 0) {   # account 0 pre-warmed (no memberships); overwrite it below with its real memberships too
            Invoke-LoadPut -RestRoot $root -Headers $headers -Type 'shadows' -Oid $accOid -SingularKey 'shadow' -Object (New-LoadAccountShadow -Oid $accOid -Index $i -ResourceOid $spec.resourceOid -GroupIndices $groups -GroupPrefix $spec.groupPrefix)
        } else {
            # give pre-warmed account 0 its real memberships
            Invoke-LoadPut -RestRoot $root -Headers $headers -Type 'shadows' -Oid $accOid -SingularKey 'shadow' -Object (New-LoadAccountShadow -Oid $accOid -Index 0 -ResourceOid $spec.resourceOid -GroupIndices $groups -GroupPrefix $spec.groupPrefix)
        }
        Invoke-LoadPut -RestRoot $root -Headers $headers -Type 'users' -Oid $usrOid -SingularKey 'user' -Object (New-LoadUser -Oid $usrOid -Index $i -AccountOid $accOid)
        if ((($i + 1) % 250) -eq 0) { Write-Host "    users $($i+1)/$($spec.users)" -ForegroundColor DarkGray }
    }

    $sw.Stop()
    Write-Host "Seeding tier $Tier complete in $([math]::Round($sw.Elapsed.TotalSeconds,1))s — $($plan.Total) memberships." -ForegroundColor Green
    return [pscustomobject]@{ tier = $Tier; users = $spec.users; groups = $spec.groups; memberships = $plan.Total; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}

function New-LoadGroupShadow {
    [CmdletBinding()] param([string]$Oid, [int]$Index, [string]$ResourceOid)
    return @{
        oid         = $Oid
        name        = ('LT-Group-{0:D5}' -f $Index)
        resourceRef = @{ oid = $ResourceOid; type = 'ResourceType' }
        objectClass = 'ri:group'
        kind        = 'entitlement'
        intent      = 'group'
    }
}

function New-LoadAccountShadow {
    [CmdletBinding()] param([string]$Oid, [int]$Index, [string]$ResourceOid, [int[]]$GroupIndices, [string]$GroupPrefix)
    $shadow = @{
        oid         = $Oid
        name        = ('LT-Acct-{0:D5}' -f $Index)
        resourceRef = @{ oid = $ResourceOid; type = 'ResourceType' }
        objectClass = 'ri:user'
        kind        = 'account'
        intent      = 'default'
    }
    if ($GroupIndices -and $GroupIndices.Count -gt 0) {
        $refs = foreach ($g in $GroupIndices) {
            @{ oid = (Get-LoadOid -Prefix $GroupPrefix -Index $g); relation = 'org:default'; type = 'ShadowType' }
        }
        $shadow['referenceAttributes'] = @{ group = @($refs) }
    }
    return $shadow
}

function New-LoadUser {
    [CmdletBinding()] param([string]$Oid, [int]$Index, [string]$AccountOid)
    return @{
        oid          = $Oid
        name         = ('LT-User-{0:D5}' -f $Index)
        fullName     = ('LT User {0:D5}' -f $Index)
        givenName    = 'LT'
        familyName   = ('User{0:D5}' -f $Index)
        emailAddress = ('lt-user-{0:D5}@loadtest.local' -f $Index)
        linkRef      = @( @{ oid = $AccountOid; type = 'ShadowType' } )
    }
}

function Remove-MidpointLoadData {
    <#
    .SYNOPSIS  Delete a load-test tier's objects (users, accounts, groups, resource) by OID.
    .DESCRIPTION  DESTRUCTIVE bulk delete — only the 1b… load-test OIDs are touched. Run only
                  with explicit approval. Idempotent (404s ignored).
    #>
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingUsernameAndPasswordParams', '')]
    [Diagnostics.CodeAnalysis.SuppressMessage('PSAvoidUsingPlainTextForPassword', '')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][string]$Username,
        [Parameter(Mandatory)][string]$Password,
        [ValidateSet('T1', 'T2', 'T3', 'T4')][string]$Tier = 'T3'
    )
    $spec    = Get-MidpointLoadSpec -Tier $Tier
    $root    = Get-LoadRestRoot -BaseUrl $BaseUrl
    $headers = Get-LoadHeaders -Username $Username -Password $Password

    function Remove-One { param([string]$Type, [string]$Oid, [switch]$Raw)
        $uri = "$root/$Type/$Oid"; if ($Raw) { $uri += '?options=raw' }
        try { Invoke-RestMethod -Uri $uri -Method Delete -Headers $headers -TimeoutSec 60 | Out-Null }
        catch { $c = $null; try { $c = $_.Exception.Response.StatusCode.value__ } catch {}; if ($c -ne 404) { Write-Host "  ! $Type/$Oid -> HTTP $c" -ForegroundColor Yellow } }
    }

    Write-Host "Removing load-test tier $Tier ($($spec.users) users / $($spec.groups) groups) → $root" -ForegroundColor Cyan
    for ($i = 0; $i -lt $spec.users; $i++) {
        Remove-One -Type 'users'   -Oid (Get-LoadOid -Prefix $spec.userPrefix    -Index $i)
        Remove-One -Type 'shadows' -Oid (Get-LoadOid -Prefix $spec.accountPrefix -Index $i) -Raw
        if ((($i + 1) % 500) -eq 0) { Write-Host "  removed users/accounts $($i+1)/$($spec.users)" -ForegroundColor DarkGray }
    }
    for ($j = 0; $j -lt $spec.groups; $j++) {
        Remove-One -Type 'shadows' -Oid (Get-LoadOid -Prefix $spec.groupPrefix -Index $j) -Raw
        if ((($j + 1) % 2000) -eq 0) { Write-Host "  removed groups $($j+1)/$($spec.groups)" -ForegroundColor DarkGray }
    }
    Remove-One -Type 'resources' -Oid $spec.resourceOid -Raw
    Write-Host "Removal of tier $Tier complete." -ForegroundColor Green
}

#endregion Seeding

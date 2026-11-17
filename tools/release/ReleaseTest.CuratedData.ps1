<#
.SYNOPSIS
    Person-made data for the release test: made before the backup (or the
    upgrade), read back after, compared value by value. Dot-source after
    ReleaseTest.Functions.ps1.

.DESCRIPTION
    Row counts prove the synced data survived. They say nothing about what
    people made in the app, which no crawler can bring back: a tag and who is
    in it, a manual context, a crawler configuration and its schedule, a
    category, the account-linking threshold, a role -> permission mapping, a
    feature switch, a saved matrix, a read API key and an analyst's decision on
    an identity link. Backup and restore (docs/admin/backup-restore-upgrade.md)
    is the way to move an instance, so it has to keep all of them, exactly.

    Every record is made through the endpoint the UI uses, with values a
    default or a fresh install would never have. The previous stable release
    makes them, so only endpoints that release already has are used.

    New-CuratedData returns a manifest: the ids it made (Ids), the plaintext
    read key (ReadToken) and, per record, the expected value as one canonical
    string (Expected). Read-CuratedData reads the same records back into
    strings of the same shape, and Compare-CuratedData lists every difference.
    The strings come from Format-CuratedRecord and ConvertTo-CanonicalJson on
    both sides, so a stored value that changed in any way is a difference,
    while JSON key order (which jsonb does not keep) is not.

    Risk profiles and risk overrides are left out on purpose: risk scoring is
    experimental and is not certified per release beyond "off is really off"
    (docs/contributing/release-process.md).

    test/unit/ReleaseTestCuratedData.Tests.ps1 covers the pure functions.
#>

Set-StrictMode -Version Latest

$script:Missing = '<missing>'

function Get-CuratedSeed {
    <# The values the person-made records get. None is a default of any version. #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param()
    [ordered]@{
        TagName         = 'Release test: kept tag'
        TagColor        = '#7a3e9d'
        ContextName     = 'Release test: kept context'
        ContextType     = 'ReleaseTestTeam'
        ContextNote     = 'Made by a person before the backup'
        CrawlerName     = 'Release test: kept crawler'
        CrawlerFolder   = '/data/uploads/release-test-kept'
        # Switched off, so it never fires during the test; weekly so every field is set.
        CrawlerSchedule = [ordered]@{ enabled = $false; frequency = 'weekly'; day = 3; hour = 4; minute = 37; syncMode = 'full' }
        CategoryName    = 'Release test: kept category'
        CategoryColor   = '#2e8b57'
        LinkThreshold   = 73
        RoleName        = 'ReleaseTest.KeptRole'
        RolePermissions = @('data.read', 'data.write.tags')
        Feature         = 'matrixSharing'
        MatrixName      = 'Release test: kept matrix'
        MatrixFilter    = [ordered]@{ userLimit = 37; filters = [ordered]@{ department = 'Release Test Dept' }; columns = @('department', 'jobTitle') }
        TokenName       = 'Release test: kept read key'
        Override        = 'confirmed'
    }
}

function ConvertTo-CanonicalJson {
    <#
    .SYNOPSIS
        Compact JSON with object keys sorted (ordinal), arrays kept in order.
    .DESCRIPTION
        jsonb stores objects with its own key order, so the same value can come
        back with its keys moved. Sorting them on both sides leaves only real
        differences. Hashtables, ordered dictionaries and the PSCustomObjects
        ConvertFrom-Json makes all produce the same text.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()] $Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [System.Collections.IDictionary]) { return ConvertTo-CanonicalObject $Value }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $fields = @{}
        foreach ($p in $Value.PSObject.Properties) { $fields[$p.Name] = $p.Value }
        return ConvertTo-CanonicalObject $fields
    }
    if ($Value -is [string]) { return ConvertTo-Json -InputObject $Value -Compress }
    if ($Value -is [System.Collections.IEnumerable]) {
        return '[' + ((@($Value) | ForEach-Object { ConvertTo-CanonicalJson $_ }) -join ',') + ']'
    }
    ConvertTo-Json -InputObject $Value -Compress
}

function ConvertTo-CanonicalObject {
    <# A dictionary as a JSON object with its keys in ordinal order. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.IDictionary] $Field)
    $sorted = [string[]]@($Field.Keys)
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    $pairs = foreach ($n in $sorted) { (ConvertTo-Json -InputObject $n -Compress) + ':' + (ConvertTo-CanonicalJson $Field[$n]) }
    '{' + (@($pairs) -join ',') + '}'
}

function Format-CuratedRecord {
    <# One record as 'name=value; name=value', in the order given. A $null value reads <missing>. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][System.Collections.IDictionary] $Field)
    $parts = foreach ($k in $Field.Keys) {
        $v = $Field[$k]
        "$k=$(if ($null -eq $v) { $script:Missing } else { $v })"
    }
    @($parts) -join '; '
}

function Format-IdSet {
    <# A set of ids as one string: lower-cased, sorted, comma-separated. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()][AllowEmptyCollection()][object[]] $Id = @())
    $ids = [string[]]@($Id | Where-Object { $_ } | ForEach-Object { "$_".ToLowerInvariant() })
    [Array]::Sort($ids, [StringComparer]::Ordinal)
    $ids -join ','
}

function Find-ById {
    <# The item of a list reply whose id is $Id (compared as text, case-insensitively), or $null. #>
    [CmdletBinding()]
    param([AllowNull()] $List, [Parameter(Mandatory)] $Id)
    @($List | Where-Object { $_ -and "$(Get-Prop $_ 'id')" -eq "$Id" }) | Select-Object -First 1
}

function Compare-CuratedData {
    <#
    .SYNOPSIS
        Every expected record whose value came back different, or not at all.
    .DESCRIPTION
        An empty $Expected is itself a problem: a check against nothing would
        pass without checking. Records only $Actual has are ignored.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.IDictionary] $Expected,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.IDictionary] $Actual
    )
    if ($Expected.Count -eq 0) { return @('no person-made records were made before the change') }
    $problems = foreach ($label in $Expected.Keys) {
        if (-not $Actual.Contains($label)) { "${label}: not read back" }
        elseif ("$($Actual[$label])" -cne "$($Expected[$label])") { "${label}: expected '$($Expected[$label])', found '$($Actual[$label])'" }
    }
    @($problems)
}

function Get-ReadTokenHash {
    <# SHA-256 of a read key, lower-case hex: what ReadApiKeys.tokenHash holds (app/api/src/auth/readTokens.js). #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $Token)
    $bytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Token))
    -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-ReadTokenHashQuery {
    <# psql query: 1 when an unrevoked ReadApiKeys row still holds this key's hash, else 0. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string] $Token)
    $hash = Get-ReadTokenHash $Token
    "SELECT count(*) FROM `"ReadApiKeys`" WHERE `"tokenHash`" = '$hash' AND NOT revoked"
}

# ─── Making the records (previous stable release) ───────────────────────────

function Get-SamplePrincipalId {
    <# Two principal ids from the demo data, for the tag and the context to hold. #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token = '')
    $ids = @(Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Path '/users?limit=2' -Token $Token) 'data' | ForEach-Object { "$(Get-Prop $_ 'id')".ToLowerInvariant() })
    if ($ids.Count -lt 2) { throw 'The demo data has fewer than two users to put in the person-made tag and context.' }
    $ids
}

function New-CuratedGrouping {
    <# A tag on two users and a manual context holding the same two. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token, [Parameter(Mandatory)] $Seed, [Parameter(Mandatory)] $Manifest)
    $members = Get-SamplePrincipalId -BaseUrl $BaseUrl -Token $Token
    $tag = Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/tags' -Method Post -Body @{ name = $Seed.TagName; color = $Seed.TagColor; entityType = 'user' }
    $Manifest.Ids.Tag = Get-Prop $tag 'id'
    Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path "/tags/$($Manifest.Ids.Tag)/assign" -Method Post -Body @{ entityIds = $members } | Out-Null
    $ctx = Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/contexts' -Method Post -Body @{
        targetType = 'Principal'; contextType = $Seed.ContextType; displayName = $Seed.ContextName; description = $Seed.ContextNote
    }
    $Manifest.Ids.Context = Get-Prop $ctx 'id'
    foreach ($m in $members) {
        Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path "/contexts/$($Manifest.Ids.Context)/members" -Method Post -Body @{ memberId = $m } | Out-Null
    }
    $Manifest.Expected['tag'] = Format-CuratedRecord ([ordered]@{ name = $Seed.TagName; color = $Seed.TagColor; entityType = 'user' })
    $Manifest.Expected['tag members'] = Format-IdSet $members
    $Manifest.Expected['manual context'] = Format-CuratedRecord ([ordered]@{ name = $Seed.ContextName; type = $Seed.ContextType; description = $Seed.ContextNote; variant = 'manual' })
    $Manifest.Expected['manual context members'] = Format-IdSet $members
}

function New-CuratedConfig {
    <# A CSV crawler configuration with a schedule, and a governance category. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token, [Parameter(Mandatory)] $Seed, [Parameter(Mandatory)] $Manifest)
    $config = [ordered]@{ csvFolder = $Seed.CrawlerFolder; schedules = @($Seed.CrawlerSchedule) }
    $crawler = Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/admin/crawler-configs' -Method Post -Body @{ crawlerType = 'csv'; displayName = $Seed.CrawlerName; config = $config }
    $Manifest.Ids.Crawler = Get-Prop $crawler 'id'
    $category = Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/categories' -Method Post -Body @{ name = $Seed.CategoryName; color = $Seed.CategoryColor }
    $Manifest.Ids.Category = Get-Prop $category 'id'
    $Manifest.Expected['crawler configuration'] = Format-CuratedRecord ([ordered]@{
            type = 'csv'; name = $Seed.CrawlerName; folder = $Seed.CrawlerFolder; schedules = ConvertTo-CanonicalJson @($Seed.CrawlerSchedule)
        })
    $Manifest.Expected['category'] = Format-CuratedRecord ([ordered]@{ name = $Seed.CategoryName; color = $Seed.CategoryColor })
}

function Set-CuratedSetting {
    <# The account-linking threshold, an extra role in the role mapping, and one feature switched the other way. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token, [Parameter(Mandatory)] $Seed, [Parameter(Mandatory)] $Manifest)
    $linking = Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/account-linking/config'
    $rules = Get-Prop $linking 'rules'
    $rules | Add-Member -NotePropertyName linkThreshold -NotePropertyValue $Seed.LinkThreshold -Force
    Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/account-linking/config' -Method Put -Body @{
        rules = $rules; schedules = @(Get-Prop $linking 'schedules' | Where-Object { $_ }); isActive = $true
    } | Out-Null

    $mapping = Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/admin/roles') 'mapping'
    $mapping | Add-Member -NotePropertyName $Seed.RoleName -NotePropertyValue @($Seed.RolePermissions) -Force
    Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/admin/roles' -Method Put -Body @{ mapping = $mapping } | Out-Null

    $enabled = -not [bool](Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/features') $Seed.Feature)
    Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/admin/features/toggle' -Method Post -Body @{ feature = $Seed.Feature; enabled = $enabled } | Out-Null

    $Manifest.Expected['account-linking threshold'] = "$($Seed.LinkThreshold)"
    $Manifest.Expected['role mapping'] = Format-CuratedRecord ([ordered]@{ role = $Seed.RoleName; permissions = Format-IdSet $Seed.RolePermissions })
    $Manifest.Expected['feature switch'] = Format-CuratedRecord ([ordered]@{ feature = $Seed.Feature; enabled = "$enabled" })
}

function New-CuratedAccess {
    <# A saved matrix, a read API key, and an analyst's confirmation of one identity link. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token, [Parameter(Mandatory)] $Seed, [Parameter(Mandatory)] $Manifest)
    $matrix = Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/matrix/saved-filters' -Method Post -Body @{ name = $Seed.MatrixName; filter = $Seed.MatrixFilter }
    $Manifest.Ids.Matrix = Get-Prop $matrix 'id'
    $key = Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/admin/read-tokens' -Method Post -Body @{ name = $Seed.TokenName }
    $Manifest.ReadToken = Get-Prop $key 'token'
    if ($env:GITHUB_ACTIONS -and $Manifest.ReadToken) { Write-Host "::add-mask::$($Manifest.ReadToken)" }
    $Manifest.Ids.ReadToken = Get-Prop (Get-Prop $key 'row') 'id'
    $Manifest.Expected['saved matrix'] = Format-CuratedRecord ([ordered]@{ name = $Seed.MatrixName; filter = ConvertTo-CanonicalJson $Seed.MatrixFilter })
    $Manifest.Expected['read API key'] = Format-CuratedRecord ([ordered]@{
            name = $Seed.TokenName; prefix = "$($Manifest.ReadToken)".Substring(0, [Math]::Min(12, "$($Manifest.ReadToken)".Length)); revoked = 'False'
        })

    $link = Find-IdentityLink -BaseUrl $BaseUrl -Token $Token
    if (-not $link) {
        # Not every release's demo data links accounts into identities; say so instead of passing quietly.
        Write-Warning 'No identity with a linked account in the demo data: the identity-link decision is not checked in this run.'
        return
    }
    $Manifest.Ids.Identity = $link.Identity
    $Manifest.Ids.IdentityMember = $link.Member
    Invoke-Api -BaseUrl $BaseUrl -Token $Token -Method Put -Body @{ action = $Seed.Override } `
        -Path "/identities/$($link.Identity)/members/$($link.Member)/override" | Out-Null
    $Manifest.Expected['identity link decision'] = $Seed.Override
}

function Find-IdentityLink {
    <# The first identity (of the first 25) with a linked account, as @{ Identity; Member }, or $null. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token)
    foreach ($identity in @(Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/identities?limit=25') 'data')) {
        $id = Get-Prop $identity 'id'
        $member = @(Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path "/identities/$id") 'members' | Where-Object { Get-Prop $_ 'principalId' }) | Select-Object -First 1
        if ($member) { return @{ Identity = $id; Member = Get-Prop $member 'principalId' } }
    }
    $null
}

function New-CuratedData {
    <#
    .SYNOPSIS
        Makes every person-made record through the API; returns the manifest
        Read-CuratedData and Compare-CuratedData take.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token = '')
    $seed = Get-CuratedSeed
    $manifest = @{ Ids = @{}; Expected = [ordered]@{}; ReadToken = '' }
    foreach ($step in 'New-CuratedGrouping', 'New-CuratedConfig', 'Set-CuratedSetting', 'New-CuratedAccess') {
        & $step -BaseUrl $BaseUrl -Token $Token -Seed $seed -Manifest $manifest
    }
    $manifest
}

# ─── Reading them back (the candidate) ──────────────────────────────────────

function Read-CuratedGrouping {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token, [Parameter(Mandatory)] $Manifest, [Parameter(Mandatory)] $Actual)
    $tag = Find-ById (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/tags') $Manifest.Ids.Tag
    if ($tag) { $Actual['tag'] = Format-CuratedRecord ([ordered]@{ name = Get-Prop $tag 'name'; color = Get-Prop $tag 'color'; entityType = Get-Prop $tag 'entityType' }) }
    $Actual['tag members'] = Format-IdSet @(Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path "/contexts/$($Manifest.Ids.Tag)/members?limit=500") 'data' | ForEach-Object { Get-Prop $_ 'id' })
    $ctx = Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path "/contexts/$($Manifest.Ids.Context)") 'attributes'
    $Actual['manual context'] = Format-CuratedRecord ([ordered]@{
            name = Get-Prop $ctx 'displayName'; type = Get-Prop $ctx 'contextType'; description = Get-Prop $ctx 'description'; variant = Get-Prop $ctx 'variant'
        })
    $Actual['manual context members'] = Format-IdSet @(Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path "/contexts/$($Manifest.Ids.Context)/members?limit=500") 'data' | ForEach-Object { Get-Prop $_ 'id' })
}

function Read-CuratedConfig {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token, [Parameter(Mandatory)] $Manifest, [Parameter(Mandatory)] $Actual)
    $crawler = Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path "/admin/crawler-configs/$($Manifest.Ids.Crawler)"
    $config = Get-Prop $crawler 'config'
    $Actual['crawler configuration'] = Format-CuratedRecord ([ordered]@{
            type = Get-Prop $crawler 'crawlerType'; name = Get-Prop $crawler 'displayName'; folder = Get-Prop $config 'csvFolder'
            schedules = ConvertTo-CanonicalJson @(Get-Prop $config 'schedules')
        })
    $category = Find-ById (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/categories') $Manifest.Ids.Category
    if ($category) { $Actual['category'] = Format-CuratedRecord ([ordered]@{ name = Get-Prop $category 'name'; color = Get-Prop $category 'color' }) }
}

function Read-CuratedSetting {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token, [Parameter(Mandatory)] $Manifest, [Parameter(Mandatory)] $Actual)
    $seed = Get-CuratedSeed
    $rules = Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/account-linking/config') 'rules'
    $Actual['account-linking threshold'] = "$(Get-Prop $rules 'linkThreshold')"
    $mapping = Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/admin/roles') 'mapping'
    $perms = Get-Prop $mapping $seed.RoleName
    $Actual['role mapping'] = Format-CuratedRecord ([ordered]@{ role = $(if ($null -ne $perms) { $seed.RoleName }); permissions = Format-IdSet @($perms) })
    $enabled = Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/features') $seed.Feature
    $Actual['feature switch'] = Format-CuratedRecord ([ordered]@{ feature = $seed.Feature; enabled = $(if ($null -ne $enabled) { "$enabled" }) })
    $null = $Manifest   # same signature as the other readers
}

function Read-CuratedAccess {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [string] $Token, [Parameter(Mandatory)] $Manifest, [Parameter(Mandatory)] $Actual)
    $matrix = Find-ById (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/matrix/saved-filters') $Manifest.Ids.Matrix
    if ($matrix) { $Actual['saved matrix'] = Format-CuratedRecord ([ordered]@{ name = Get-Prop $matrix 'name'; filter = ConvertTo-CanonicalJson (Get-Prop $matrix 'filter') }) }
    $key = Find-ById (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path '/admin/read-tokens') $Manifest.Ids.ReadToken
    if ($key) { $Actual['read API key'] = Format-CuratedRecord ([ordered]@{ name = Get-Prop $key 'name'; prefix = Get-Prop $key 'tokenPrefix'; revoked = "$(Get-Prop $key 'revoked')" }) }
    if (-not $Manifest.Ids.ContainsKey('Identity')) { return }   # none was made (see New-CuratedAccess)
    $members = @(Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Token $Token -Path "/identities/$($Manifest.Ids.Identity)") 'members')
    $member = @($members | Where-Object { $_ -and "$(Get-Prop $_ 'principalId')" -eq "$($Manifest.Ids.IdentityMember)" }) | Select-Object -First 1
    if ($member) { $Actual['identity link decision'] = "$(Get-Prop $member 'analystOverride')" }
}

function Read-CuratedData {
    <# The records the manifest names, read back through the API as the same canonical strings. #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][hashtable] $Manifest, [string] $Token = '')
    $actual = [ordered]@{}
    foreach ($step in 'Read-CuratedGrouping', 'Read-CuratedConfig', 'Read-CuratedSetting', 'Read-CuratedAccess') {
        & $step -BaseUrl $BaseUrl -Token $Token -Manifest $Manifest -Actual $actual
    }
    $actual
}

function Assert-ReadTokenSignIn {
    <#
    .SYNOPSIS
        With sign-in on: the kept read key still opens a data endpoint, and the
        same key with one character changed does not. With sign-in off the API
        never checks a key, so this proves nothing there and is skipped
        (the Docker test checks the stored hash instead).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][string] $ReadToken)
    if (-not (Get-Prop (Invoke-Api -BaseUrl $BaseUrl -Path '/auth-config') 'enabled')) { return }
    $kept = Get-HttpStatus -Url "$BaseUrl/users?limit=1" -Token $ReadToken
    $wrong = Get-HttpStatus -Url "$BaseUrl/users?limit=1" -Token ($ReadToken.Substring(0, $ReadToken.Length - 1) + $(if ($ReadToken.EndsWith('A')) { 'B' } else { 'A' }))
    if ($kept -ne 200) { throw "The kept read API key no longer signs in ($kept)." }
    if ($wrong -ne 401) { throw "A changed read API key was not refused ($wrong)." }
}

function Assert-CuratedData {
    <# Reads the manifest's records back and throws, naming each difference, when any changed. #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string] $BaseUrl, [Parameter(Mandatory)][hashtable] $Manifest, [Parameter(Mandatory)][string] $Label, [string] $Token = '')
    $actual = Read-CuratedData -BaseUrl $BaseUrl -Manifest $Manifest -Token $Token
    $problems = @(Compare-CuratedData -Expected $Manifest.Expected -Actual $actual)
    if ($problems.Count -gt 0) { throw "${Label}: person-made data changed: $($problems -join '; ')" }
    Assert-ReadTokenSignIn -BaseUrl $BaseUrl -ReadToken $Manifest.ReadToken
    Write-Step "${Label}: all $($Manifest.Expected.Count) person-made records are unchanged"
}

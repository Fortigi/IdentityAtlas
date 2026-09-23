#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester unit tests for the Entra ID profile-photo phase
    (EntraIDCrawler.Photos.ps1).

.DESCRIPTION
    Covers the three pure decisions in the phase, which are the ones that
    decide what the crawl costs and what it stores:

      Get-EntraUserPhoto       — the three-way found / definitely-absent /
                                 unknown result. Getting this wrong either
                                 caches a throttled response as "no photo"
                                 (losing a face until the max age expires) or
                                 re-asks Graph about every photoless account on
                                 every run.
      Select-EntraPhotoTargets — which principals are worth asking about.
      ConvertTo-EntraPhotoRecord — the shape sent to ingest/principals, which
                                 must be a PARTIAL update.

    Invoke-FGGetRequestBytes and Get-FGHttpStatus are stubbed, so no network
    and no SDK load is needed.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'entra-id' 'EntraIDCrawler.Photos.ps1')

    # Stubs for the two external helpers the fetch function leans on. Defined in the
    # test scope so the dot-sourced functions resolve them at call time.
    # $stubStatus starts null — the "no HTTP response at all" case — so a test
    # that never sets it still exercises a real branch instead of erroring.
    $script:stubStatus = $null
    function Invoke-FGGetRequestBytes { param($URI) throw 'stub not configured' }
    function Get-FGHttpStatus { param($ErrorRecord) return $script:stubStatus }
}

Describe 'Get-EntraUserPhoto' {
    It 'returns the bytes when the user has a photo' {
        Mock Invoke-FGGetRequestBytes { return [byte[]]@(1, 2, 3) }

        $result = Get-EntraUserPhoto -UserId 'u1'

        $result.found | Should -BeTrue
        $result.bytes | Should -Be ([byte[]]@(1, 2, 3))
        # Graph renders the sized variants as JPEG regardless of the uploaded
        # format, so the stored content type must not be guessed from the URL.
        $result.contentType | Should -Be 'image/jpeg'
    }

    It 'requests the small rendered variant, not the full-size original' {
        # The original can be megabytes; the avatar renders at 40px. This is
        # the single biggest control on how much data the phase moves.
        Mock Invoke-FGGetRequestBytes { return [byte[]]@(1) }

        Get-EntraUserPhoto -UserId 'u1' | Out-Null

        # -Exactly matters: without it, -Times 1 means "at least once" and
        # would pass against an implementation that requested several sizes.
        Should -Invoke Invoke-FGGetRequestBytes -Exactly -Times 1 -ParameterFilter {
            $URI -eq 'https://graph.microsoft.com/beta/users/u1/photos/48x48/$value'
        }
    }

    It 'reports a definite absence for an empty 200 body' {
        # Graph does this for some unlicensed accounts instead of a clean 404.
        Mock Invoke-FGGetRequestBytes { return [byte[]]@() }

        (Get-EntraUserPhoto -UserId 'u1').found | Should -BeFalse
    }

    It 'reports a definite absence for a null body' {
        Mock Invoke-FGGetRequestBytes { return $null }

        (Get-EntraUserPhoto -UserId 'u1').found | Should -BeFalse
    }

    It 'treats 404, 403 and 401 as a settled "no photo"' {
        # All three mean "this account has no readable profile photo resource",
        # which is worth caching. Service accounts and unlicensed users hit
        # 403/404 constantly; re-asking every run is the cost being avoided.
        foreach ($status in 404, 403, 401) {
            $script:stubStatus = $status
            Mock Invoke-FGGetRequestBytes { throw 'graph said no' }

            $result = Get-EntraUserPhoto -UserId 'u1'

            $result | Should -Not -BeNullOrEmpty -Because "status $status must be a settled answer, not unknown"
            $result.found | Should -BeFalse -Because "status $status means the user has no photo"
        }
    }

    It 'returns $null — unknown — when throttled' {
        # 429 must NOT be cached as "no photo". If it were, a throttled run
        # would blank every affected user until the 30-day max age expired.
        $script:stubStatus = 429
        Mock Invoke-FGGetRequestBytes { throw 'too many requests' }

        Get-EntraUserPhoto -UserId 'u1' | Should -BeNullOrEmpty
    }

    It 'returns $null — unknown — on a server error or a connectionless failure' {
        foreach ($status in 503, $null) {
            $script:stubStatus = $status
            Mock Invoke-FGGetRequestBytes { throw 'boom' }

            Get-EntraUserPhoto -UserId 'u1' |
                Should -BeNullOrEmpty -Because "status '$status' is not an answer about the photo"
        }
    }
}

Describe 'Select-EntraPhotoTargets' {
    It 'includes a principal we have never checked' {
        $targets = Select-EntraPhotoTargets -Candidates @{ 'u1' = $null }
        $targets | Should -Be @('u1')
    }

    It 'skips a principal checked more recently than the max age' {
        $recent = (Get-Date).ToUniversalTime().AddDays(-2).ToString('o')
        $targets = Select-EntraPhotoTargets -Candidates @{ 'u1' = $recent } -MaxAgeDays 30
        $targets.Count | Should -Be 0
    }

    It 'includes a principal whose answer is older than the max age' {
        $stale = (Get-Date).ToUniversalTime().AddDays(-40).ToString('o')
        $targets = Select-EntraPhotoTargets -Candidates @{ 'u1' = $stale } -MaxAgeDays 30
        $targets | Should -Be @('u1')
    }

    It 'honours the boundary either side of the max age' {
        # A single cutoff test can pass against an implementation with the
        # comparison inverted, so both sides are asserted against the SAME
        # max age.
        $justInside  = (Get-Date).ToUniversalTime().AddDays(-9).ToString('o')
        $justOutside = (Get-Date).ToUniversalTime().AddDays(-11).ToString('o')

        (Select-EntraPhotoTargets -Candidates @{ 'u1' = $justInside }  -MaxAgeDays 10).Count | Should -Be 0
        (Select-EntraPhotoTargets -Candidates @{ 'u1' = $justOutside } -MaxAgeDays 10) | Should -Be @('u1')
    }

    It 'includes a principal whose stored timestamp is unparseable' {
        # Corrupt state must degrade to "check again", never to "skip forever".
        $targets = Select-EntraPhotoTargets -Candidates @{ 'u1' = 'not-a-date' }
        $targets | Should -Be @('u1')
    }

    It 'returns an empty array for no candidates rather than $null' {
        # The phase enumerates the result under Set-StrictMode; an unwrapped
        # return would collapse to $null and fail there. Pester's
        # -BeNullOrEmpty treats an empty array AS empty, so the type is what
        # has to be asserted, not emptiness.
        # Evaluated BEFORE the pipe: piping an empty array sends zero items, so
        # `$targets | Should ...` would assert against $null no matter what the
        # function returned.
        $targets = Select-EntraPhotoTargets -Candidates @{}
        ($targets -is [System.Array]) | Should -BeTrue -Because 'the comma operator must survive the return'
        @($targets).Count | Should -Be 0
    }

    It 'splits a mixed set correctly' {
        $candidates = @{
            'never'  = $null
            'fresh'  = (Get-Date).ToUniversalTime().AddDays(-1).ToString('o')
            'stale'  = (Get-Date).ToUniversalTime().AddDays(-99).ToString('o')
        }
        $targets = Select-EntraPhotoTargets -Candidates $candidates -MaxAgeDays 30

        @($targets).Count | Should -Be 2
        $targets | Should -Contain 'never'
        $targets | Should -Contain 'stale'
        $targets | Should -Not -Contain 'fresh'
    }
}

Describe 'ConvertTo-EntraPhotoRecord' {
    It 'base64-encodes the bytes with the content type' {
        $photo = @{ found = $true; bytes = [byte[]]@(1, 2, 3); contentType = 'image/jpeg' }

        $rec = ConvertTo-EntraPhotoRecord -UserId 'u1' -Photo $photo

        $rec.id | Should -Be 'u1'
        $rec.photo | Should -Be 'AQID'
        $rec.photoContentType | Should -Be 'image/jpeg'
        $rec.photoFetchedAt | Should -Not -BeNullOrEmpty
    }

    It 'records a null photo WITH a timestamp when the user has none' {
        # This pair is the negative cache entry. A record without the timestamp
        # would leave the user on the target list forever; a record without the
        # explicit null would not clear a photo that was removed in the source.
        $rec = ConvertTo-EntraPhotoRecord -UserId 'u1' -Photo @{ found = $false }

        $rec.ContainsKey('photo') | Should -BeTrue
        $rec.photo | Should -BeNullOrEmpty
        $rec.photoFetchedAt | Should -Not -BeNullOrEmpty
    }

    It 'treats a null photo argument as "no photo"' {
        $rec = ConvertTo-EntraPhotoRecord -UserId 'u1' -Photo $null
        $rec.photo | Should -BeNullOrEmpty
        $rec.photoFetchedAt | Should -Not -BeNullOrEmpty
    }

    It 'emits only the id and photo fields, so the upsert is a partial update' {
        # The record goes to ingest/principals. Any extra key would overwrite a
        # real column on the user with whatever this phase happened to hold —
        # blanking displayName, department and the rest.
        $photo = @{ found = $true; bytes = [byte[]]@(9); contentType = 'image/jpeg' }

        $rec = ConvertTo-EntraPhotoRecord -UserId 'u1' -Photo $photo

        ($rec.Keys | Sort-Object) | Should -Be @('id', 'photo', 'photoContentType', 'photoFetchedAt')
    }

    It 'stamps the timestamp as round-trippable UTC' {
        $rec = ConvertTo-EntraPhotoRecord -UserId 'u1' -Photo @{ found = $false }

        $parsed = [datetime]::MinValue
        [datetime]::TryParse($rec.photoFetchedAt, [ref]$parsed) | Should -BeTrue
        # Select-EntraPhotoTargets compares this against a UTC cutoff on the
        # next run; a local-time stamp would skew every staleness decision.
        $rec.photoFetchedAt | Should -Match 'Z$'
    }
}

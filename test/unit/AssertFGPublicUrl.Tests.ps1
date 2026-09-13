#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Pester tests for the worker-side SSRF guard, tools/crawlers/shared/Assert-FGPublicUrl.ps1
    (SEC-2026-09 M-03).

.DESCRIPTION
    Inputs are chosen to sit on range boundaries (172.15/172.16, 100.63/100.64,
    223/224 …) and to spell one address several ways, so an off-by-one or a
    missed IPv6 spelling changes the answer. DNS is mocked through
    Resolve-FGHostAddress; no network calls are made.
#>

BeforeAll {
    $script:repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $script:repoRoot 'tools' 'crawlers' 'shared' 'Assert-FGPublicUrl.ps1')
}

Describe 'Get-FGAddressClass' {
    It 'classifies <Address> as <Class>' -ForEach @(
        # IPv4 range edges
        @{ Address = '9.255.255.255'; Class = 'public' }
        @{ Address = '10.0.0.0'; Class = 'private' }
        @{ Address = '11.0.0.0'; Class = 'public' }
        @{ Address = '172.15.255.255'; Class = 'public' }
        @{ Address = '172.16.0.0'; Class = 'private' }
        @{ Address = '172.31.255.255'; Class = 'private' }
        @{ Address = '172.32.0.0'; Class = 'public' }
        @{ Address = '192.167.255.255'; Class = 'public' }
        @{ Address = '192.168.0.1'; Class = 'private' }
        @{ Address = '100.63.255.255'; Class = 'public' }
        @{ Address = '100.64.0.0'; Class = 'private' }
        @{ Address = '100.127.255.255'; Class = 'private' }
        @{ Address = '100.128.0.0'; Class = 'public' }
        @{ Address = '126.255.255.255'; Class = 'public' }
        @{ Address = '127.0.0.1'; Class = 'private' }
        @{ Address = '128.0.0.0'; Class = 'public' }
        @{ Address = '0.0.0.0'; Class = 'forbidden' }
        @{ Address = '1.0.0.0'; Class = 'public' }
        @{ Address = '169.253.255.255'; Class = 'public' }
        @{ Address = '169.254.169.254'; Class = 'forbidden' }
        @{ Address = '169.255.0.0'; Class = 'public' }
        @{ Address = '223.255.255.255'; Class = 'public' }
        @{ Address = '224.0.0.1'; Class = 'forbidden' }
        # IPv6 — embedded IPv4 in every spelling
        @{ Address = '::ffff:169.254.169.254'; Class = 'forbidden' }
        @{ Address = '::ffff:a9fe:a9fe'; Class = 'forbidden' }
        @{ Address = '[::ffff:7f00:1]'; Class = 'private' }
        @{ Address = '::ffff:808:808'; Class = 'public' }
        @{ Address = '64:ff9b::a9fe:a9fe'; Class = 'forbidden' }
        @{ Address = '64:ff9b::808:808'; Class = 'public' }
        @{ Address = '64:ff9b:1::808:808'; Class = 'forbidden' }
        @{ Address = '2002:a9fe:a9fe::'; Class = 'forbidden' }
        @{ Address = '2002:c0a8:0101::1'; Class = 'private' }
        @{ Address = '2002:808:808::1'; Class = 'public' }
        @{ Address = '::a9fe:a9fe'; Class = 'forbidden' }
        # IPv6 — special ranges and their edges
        @{ Address = '::1'; Class = 'private' }
        @{ Address = '::2'; Class = 'forbidden' }
        @{ Address = '::'; Class = 'forbidden' }
        @{ Address = '1fff:ffff::1'; Class = 'forbidden' }
        @{ Address = '2000::1'; Class = 'public' }
        @{ Address = '3fff:ffff::1'; Class = 'public' }
        @{ Address = '4000::1'; Class = 'forbidden' }
        @{ Address = 'fbff::1'; Class = 'forbidden' }
        @{ Address = 'fc00::1'; Class = 'private' }
        @{ Address = 'fdff::1'; Class = 'private' }
        @{ Address = 'fe7f::1'; Class = 'forbidden' }
        @{ Address = 'fe80::1'; Class = 'forbidden' }
        @{ Address = 'fe80::1%eth0'; Class = 'forbidden' }
        @{ Address = 'febf::1'; Class = 'forbidden' }
        @{ Address = 'fec0::1'; Class = 'private' }
        @{ Address = 'feff::1'; Class = 'private' }
        @{ Address = 'ff02::1'; Class = 'forbidden' }
        @{ Address = '2001::1'; Class = 'forbidden' }
        @{ Address = '2001:1::1'; Class = 'public' }
        @{ Address = '2001:db8::1'; Class = 'forbidden' }
        @{ Address = '2606:4700:4700::1111'; Class = 'public' }
        # Not an address at all — fail closed
        @{ Address = '10'; Class = 'forbidden' }
        @{ Address = '1.2.3'; Class = 'forbidden' }
        @{ Address = '256.0.0.1'; Class = 'forbidden' }
        @{ Address = 'fe80::zz'; Class = 'forbidden' }
        @{ Address = 'example.com'; Class = 'forbidden' }
        @{ Address = ''; Class = 'forbidden' }
    ) {
        Get-FGAddressClass -Address $Address | Should -BeExactly $Class
    }
}

Describe 'Test-FGPublicUrl' {
    BeforeEach {
        Mock Resolve-FGHostAddress { @('93.184.216.34') }
    }

    It 'allows an https URL on a host that resolves to a public address' {
        $v = Test-FGPublicUrl -Url 'https://idp.example.com/token'
        $v.IsAllowed | Should -BeTrue
        $v.Reason | Should -BeExactly ''
        Should -Invoke Resolve-FGHostAddress -Exactly 1 -ParameterFilter { $HostName -eq 'idp.example.com' }
    }

    It 'refuses http unless AllowInsecureHttp is set' {
        $refused = Test-FGPublicUrl -Url 'http://idp.example.com/'
        $refused.IsAllowed | Should -BeFalse
        $refused.Reason | Should -Match 'must use https'
        (Test-FGPublicUrl -Url 'http://idp.example.com/' -AllowInsecureHttp).IsAllowed | Should -BeTrue
    }

    It 'refuses a non-web scheme even with AllowInsecureHttp' {
        foreach ($url in 'ftp://idp.example.com/', 'file:///etc/passwd') {
            $v = Test-FGPublicUrl -Url $url -AllowInsecureHttp
            $v.IsAllowed | Should -BeFalse -Because $url
        }
        Should -Invoke Resolve-FGHostAddress -Exactly 0
    }

    It 'refuses a relative or malformed URL' {
        (Test-FGPublicUrl -Url '/odata/dataobjects').Reason | Should -BeExactly 'is not a valid absolute URL'
        (Test-FGPublicUrl -Url '').Reason | Should -BeExactly 'is not a valid absolute URL'
    }

    It 'checks an IP-literal host without DNS, including the spellings URL parsing normalises' -ForEach @(
        @{ Url = 'https://[::ffff:169.254.169.254]/latest/meta-data/' }
        @{ Url = 'https://[::ffff:a9fe:a9fe]/' }
        @{ Url = 'https://[64:ff9b::a9fe:a9fe]/' }
        @{ Url = 'https://[2002:a9fe:a9fe::]/' }
        @{ Url = 'https://2852039166/' }
        @{ Url = 'https://0xa9.0xfe.0xa9.0xfe/' }
    ) {
        $v = Test-FGPublicUrl -Url $Url -AllowPrivateNetwork
        $v.IsAllowed | Should -BeFalse
        $v.Reason | Should -Match 'link-local, metadata, or reserved'
        Should -Invoke Resolve-FGHostAddress -Exactly 0
    }

    It 'refuses a private address by default and allows it with AllowPrivateNetwork' {
        Mock Resolve-FGHostAddress { @('10.20.30.40') }
        $v = Test-FGPublicUrl -Url 'https://omada.corp.local/odata/dataobjects'
        $v.IsAllowed | Should -BeFalse
        $v.Reason | Should -Match 'private or loopback.*allowPrivateNetwork'
        (Test-FGPublicUrl -Url 'https://omada.corp.local/odata/dataobjects' -AllowPrivateNetwork).IsAllowed | Should -BeTrue
    }

    It 'refuses when ANY resolved address is private, even if the first is public' {
        Mock Resolve-FGHostAddress { @('93.184.216.34', '::ffff:10.0.0.5') }
        (Test-FGPublicUrl -Url 'https://mixed.example.com/').IsAllowed | Should -BeFalse
    }

    It 'refuses a metadata address even with AllowPrivateNetwork, whichever resolved entry it is' {
        Mock Resolve-FGHostAddress { @('10.0.0.5', '169.254.169.254') }
        $v = Test-FGPublicUrl -Url 'https://rebind.example.com/' -AllowPrivateNetwork
        $v.IsAllowed | Should -BeFalse
        $v.Reason | Should -Match 'metadata'
    }

    It 'refuses a host that does not resolve, or resolves to nothing' {
        Mock Resolve-FGHostAddress { throw 'No such host is known.' }
        (Test-FGPublicUrl -Url 'https://nowhere.example.com/').Reason | Should -Match "host 'nowhere.example.com' could not be resolved"
        Mock Resolve-FGHostAddress { @() }
        (Test-FGPublicUrl -Url 'https://empty.example.com/').Reason | Should -Match 'did not resolve to any address'
    }
}

Describe 'Resolve-FGHostAddress' {
    It 'returns address strings for localhost' {
        $addresses = @(Resolve-FGHostAddress -HostName 'localhost')
        $addresses.Count | Should -BeGreaterThan 0
        foreach ($a in $addresses) { Get-FGAddressClass -Address $a | Should -BeExactly 'private' }
    }
}

Describe 'Assert-FGPublicUrl' {
    BeforeEach {
        Mock Resolve-FGHostAddress { @('172.16.0.9') }
    }

    It 'throws a message naming the field but not the URL, which may hold credentials' {
        $err = { Assert-FGPublicUrl -Url 'https://svc:S3cret@omada.corp.local/' -Label 'baseUrl' } | Should -Throw -PassThru
        $err.Exception.Message | Should -Match '^baseUrl rejected: it resolves to a private or loopback address'
        $err.Exception.Message | Should -Not -Match 'S3cret'
    }

    It 'passes the opt-ins through' {
        { Assert-FGPublicUrl -Url 'http://omada.corp.local/' -Label 'baseUrl' -AllowPrivateNetwork -AllowInsecureHttp } | Should -Not -Throw
        { Assert-FGPublicUrl -Url 'http://omada.corp.local/' -Label 'baseUrl' -AllowPrivateNetwork } | Should -Throw -ExpectedMessage '*must use https*'
        { Assert-FGPublicUrl -Url 'https://omada.corp.local/' -Label 'baseUrl' -AllowInsecureHttp } | Should -Throw -ExpectedMessage '*private or loopback*'
    }
}

Describe 'Assert-FGSameHostLink' {
    It 'accepts a link on the configured host' {
        { Assert-FGSameHostLink -Url 'https://tenant.omada.cloud/odata/dataobjects/Identity?$skiptoken=2' -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' -Label 'nextLink' } |
            Should -Not -Throw
    }

    It 'refuses a link to another host, including a look-alike suffix' -ForEach @(
        @{ Link = 'https://attacker.example/odata?$skip=1' }
        @{ Link = 'https://tenant.omada.cloud.attacker.example/odata' }
        @{ Link = 'https://169.254.169.254/latest/meta-data/' }
    ) {
        { Assert-FGSameHostLink -Url $Link -BaseUrl 'https://tenant.omada.cloud/odata/dataobjects' -Label 'nextLink' } |
            Should -Throw -ExpectedMessage '*different host*'
    }

    It 'refuses an http link unless AllowInsecureHttp is set' {
        { Assert-FGSameHostLink -Url 'http://tenant.omada.cloud/odata?$skip=1' -BaseUrl 'https://tenant.omada.cloud/odata' -Label 'nextLink' } |
            Should -Throw -ExpectedMessage '*must use https*'
        { Assert-FGSameHostLink -Url 'http://tenant.omada.cloud/odata?$skip=1' -BaseUrl 'https://tenant.omada.cloud/odata' -Label 'nextLink' -AllowInsecureHttp } |
            Should -Not -Throw
    }

    It 'refuses a link that is not an absolute URL' {
        { Assert-FGSameHostLink -Url 'Identity?$skip=1' -BaseUrl 'https://tenant.omada.cloud/odata' -Label 'nextLink' } |
            Should -Throw -ExpectedMessage '*not a valid absolute URL*'
    }
}

Describe 'Get-FGUrlPolicyParam' {
    It 'reads a hashtable config' {
        $p = Get-FGUrlPolicyParam -Cfg @{ allowPrivateNetwork = $true; allowInsecureHttp = $false }
        $p.AllowPrivateNetwork | Should -BeTrue
        $p.AllowInsecureHttp | Should -BeFalse
    }

    It 'reads a PSCustomObject config' {
        $p = Get-FGUrlPolicyParam -Cfg ([pscustomobject]@{ allowInsecureHttp = $true })
        $p.AllowPrivateNetwork | Should -BeFalse
        $p.AllowInsecureHttp | Should -BeTrue
    }

    It 'treats only a real boolean true as an opt-in' {
        $p = Get-FGUrlPolicyParam -Cfg @{ allowPrivateNetwork = 'true'; allowInsecureHttp = 1 }
        $p.AllowPrivateNetwork | Should -BeFalse
        $p.AllowInsecureHttp | Should -BeFalse
    }

    It 'returns both flags off for a null config' {
        $p = Get-FGUrlPolicyParam -Cfg $null
        $p.Keys | Sort-Object | Should -Be @('AllowInsecureHttp', 'AllowPrivateNetwork')
        $p.AllowPrivateNetwork | Should -BeFalse
        $p.AllowInsecureHttp | Should -BeFalse
    }
}

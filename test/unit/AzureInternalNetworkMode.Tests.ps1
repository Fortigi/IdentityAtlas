#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    The internal network mode of the Azure template: a web app without a public
    endpoint, reachable only through its private endpoint.

.DESCRIPTION
    Checked against the COMPILED azure/main.json — what the Deploy to Azure
    button and `az deployment` actually run — not the Bicep source.

    The mode is only safe as a set. Each half on its own is a broken deployment:

      - public access off without the private endpoint: nobody reaches the app;
      - the private endpoint without its DNS zone: the worker keeps resolving the
        public address, which now refuses it, and no crawler result arrives;
      - the private endpoint with public access still on: the app is on the
        internet while the documentation says it is not.

    So the tests pin that all parts hang on the SAME switch (internalNetworking),
    that the switch is true for 'internal' only, and that the two existing modes
    get none of it.

.USAGE
    Invoke-Pester -Path test/unit/AzureInternalNetworkMode.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:Template = Get-Content (Join-Path $root 'azure/main.json') -Raw | ConvertFrom-Json

    function Get-Module {
        param([Parameter(Mandatory)][string] $Name)
        $found = @($script:Template.resources | Where-Object { $_.type -eq 'Microsoft.Resources/deployments' -and $_.name -eq $Name })
        if ($found.Count -ne 1) { throw "Expected exactly one nested deployment named '$Name', found $($found.Count)" }
        return $found[0]
    }

    # The value main.json passes to a module parameter, as written in the template.
    function Get-ModuleArgument {
        param([Parameter(Mandatory)][string] $Module, [Parameter(Mandatory)][string] $Parameter)
        return (Get-Module $Module).properties.parameters.$Parameter.value
    }

    function Get-ModuleResource {
        param([Parameter(Mandatory)][string] $Module, [Parameter(Mandatory)][string] $Type)
        return @((Get-Module $Module).properties.template.resources | Where-Object type -eq $Type)
    }

    $script:InternalSwitch = "[variables('internalNetworking')]"
}

Describe 'Azure template: the internal network mode' {

    Context 'the mode and its two switches' {
        It 'offers public, private and internal, and still defaults to public' {
            $script:Template.parameters.networkMode.allowedValues | Should -Be @('public', 'private', 'internal')
            $script:Template.parameters.networkMode.defaultValue | Should -BeExactly 'public'
        }

        # 'internal' is the private shape plus more, so it must switch the VNet and
        # the Key Vault / Storage / Postgres endpoints on as well. Written as
        # "not public": "equals private" would leave internal without a VNet.
        It 'treats every mode except public as private networking' {
            $script:Template.variables.privateNetworking | Should -BeExactly "[not(equals(parameters('networkMode'), 'public'))]"
        }

        It 'turns the internal parts on for internal only' {
            $script:Template.variables.internalNetworking | Should -BeExactly "[equals(parameters('networkMode'), 'internal')]"
        }
    }

    Context 'the web app has no public endpoint' {
        It 'passes the internal switch to the web app module' {
            Get-ModuleArgument 'app-service' 'disablePublicNetworkAccess' | Should -BeExactly $script:InternalSwitch
        }

        # null in the other modes, not 'Enabled': an explicit value would change
        # what existing public and private deployments send on their next redeploy.
        It 'disables public network access on the site, and leaves the property unset otherwise' {
            $site = Get-ModuleResource 'app-service' 'Microsoft.Web/sites'
            $site.Count | Should -Be 1
            $site[0].properties.publicNetworkAccess | Should -BeExactly "[if(parameters('disablePublicNetworkAccess'), 'Disabled', null())]"
        }

        It 'leaves the switch off when the web app module is used without it' {
            (Get-Module 'app-service').properties.template.parameters.disablePublicNetworkAccess.defaultValue | Should -BeFalse
        }
    }

    Context 'the web app is reachable through a private endpoint instead' {
        It 'deploys the web private endpoint on the internal switch only' {
            (Get-Module 'web-private-endpoint').condition | Should -BeExactly $script:InternalSwitch
        }

        # 'sites' is the web app itself. Any other group ID is a different service.
        It 'points the endpoint at the web app' {
            $pe = Get-ModuleResource 'web-private-endpoint' 'Microsoft.Network/privateEndpoints'
            $pe.Count | Should -Be 1
            $connection = $pe[0].properties.privateLinkServiceConnections[0].properties
            $connection.groupIds | Should -Be @('sites')
            $connection.privateLinkServiceId | Should -BeExactly "[parameters('webAppId')]"
            Get-ModuleArgument 'web-private-endpoint' 'webAppId' | Should -Match "'app-service'\).*outputs\.appId\.value"
        }

        It 'registers the endpoint in the web private DNS zone' {
            $group = Get-ModuleResource 'web-private-endpoint' 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups'
            $group.Count | Should -Be 1
            $group[0].properties.privateDnsZoneConfigs[0].properties.privateDnsZoneId | Should -BeExactly "[parameters('webZoneId')]"
            Get-ModuleArgument 'web-private-endpoint' 'webZoneId' | Should -Match "'network'\).*outputs\.webZoneId\.value"
        }

        # Without the zone linked to the VNet the worker resolves the public
        # address of the web app, which the internal mode has switched off.
        It 'creates that zone, linked to the VNet, on the internal switch only' {
            Get-ModuleArgument 'network' 'includeWebZone' | Should -BeExactly $script:InternalSwitch

            $zone = @(Get-ModuleResource 'network' 'Microsoft.Network/privateDnsZones' | Where-Object name -eq 'privatelink.azurewebsites.net')
            $zone.Count | Should -Be 1
            $zone[0].condition | Should -BeExactly "[parameters('includeWebZone')]"

            $link = @(Get-ModuleResource 'network' 'Microsoft.Network/privateDnsZones/virtualNetworkLinks' |
                Where-Object { $_.name -like "*'privatelink.azurewebsites.net'*" })
            $link.Count | Should -Be 1
            $link[0].condition | Should -BeExactly "[parameters('includeWebZone')]"
        }

        It 'starts the worker only after the web private endpoint exists' {
            (Get-Module 'aca-app-worker').dependsOn | Should -Contain "[resourceId('Microsoft.Resources/deployments', 'web-private-endpoint')]"
        }

        It 'reports the private address and the VNet to connect, empty outside their modes' {
            $script:Template.outputs.webPrivateIpAddress.value | Should -Match "^\[if\(variables\('internalNetworking'\), .*'web-private-endpoint'.*privateIpAddress\.value, ''\)\]$"
            $script:Template.outputs.vnetName.value | Should -Match "^\[if\(variables\('privateNetworking'\), .*'network'.*vnetName\.value, ''\)\]$"
        }
    }

    Context 'the worker environment has no public address' {
        It 'passes the internal switch to the worker environment' {
            Get-ModuleArgument 'aca-env' 'internalOnly' | Should -BeExactly $script:InternalSwitch
        }

        It 'makes the environment internal from that switch, and not by default' {
            $module = Get-Module 'aca-env'
            $module.properties.template.parameters.internalOnly.defaultValue | Should -BeFalse
            $env = @($module.properties.template.resources | Where-Object type -eq 'Microsoft.App/managedEnvironments')
            $env.Count | Should -Be 1
            # The environment's properties are one union() expression in the compiled
            # template; the VNet part must carry the switch, not a literal.
            $env[0].properties | Should -BeLike "*createObject('vnetConfiguration', createObject('infrastructureSubnetId', parameters('infrastructureSubnetId'), 'internal', parameters('internalOnly')))*"
        }
    }

    Context 'the VNet can be given an address range that fits the customer network' {
        It 'keeps 10.42.0.0/16 as the default and hands the range to the network module' {
            $script:Template.parameters.vnetAddressPrefix.defaultValue | Should -BeExactly '10.42.0.0/16'
            Get-ModuleArgument 'network' 'addressPrefix' | Should -BeExactly "[parameters('vnetAddressPrefix')]"
        }
    }

    Context 'the report generator' {
        # Its ingress lives in the worker environment, which has no public address
        # in this mode and no DNS zone the web app could find it through.
        It 'refuses internal mode together with the report generator, before deploying anything' {
            $guard = $script:Template.variables.reportGeneratorAllowed
            $guard | Should -Match "^\[if\(and\(parameters\('deployReportGenerator'\), variables\('internalNetworking'\)\), fail\('"
            $guard | Should -Match ", true\(\)\)\]$"
            (Get-Module 'aca-app-report-generator').condition | Should -BeExactly "[and(parameters('deployReportGenerator'), variables('reportGeneratorAllowed'))]"
        }
    }
}

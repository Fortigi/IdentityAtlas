<#
.SYNOPSIS
    Fortigi Demo Corp — logical applications, who answers for them, and one
    unit seen as its resources.

.DESCRIPTION
    The org tree (DemoOrg.ps1) groups PEOPLE. This part groups RESOURCES: the
    business applications the demo company runs, as the IGA system's application
    catalogue lists them. Each one is a synced LogicalApplication context
    (targetType Resource) whose members are the demo resources that make up the
    application — SAP roles, Entra groups, app roles, Azure role assignments.

    The applications tell the ownership story the context page is built around.
    Every case is deliberate:

      * Accountable + Responsible set ............ SAP ERP, Customer Relationship
                                                   Management, Engineering Platform
      * No Accountable, but one account owns at
        least 40 % of the members (the "best
        guess", roleSuggestion.js) ............... SAP ERP – Financial Accounting
                                                   (Maria Novak, 2 of 4),
                                                   IT Service Management
                                                   (Eva Fischer, 3 of 5)
      * No Accountable, an owner below the
        threshold, so no suggestion .............. Privileged Access Management
                                                   (1 of 3 owned)
      * No Accountable and no owner at all ....... Employee Portal & Intranet

    The best-guess owners are real group owners in the existing ownership model
    (a GroupOwnership resource linked by HasOwnership, with a Direct assignment
    per owner): the groups this part needs owned get them here.

    Unit variants: the Security Team (a people context in DemoOrg.ps1) is also
    emitted as its resources — an OrganizationalUnit context with targetType
    Resource — and the two are linked SameUnitAs, so the people unit's
    "Download report" card has a resources variant to run on.

    Runs after every other fixed part: it reads the resources they created, by
    name, and only appends.
#>

Set-StrictMode -Version Latest

# The best-guess threshold the API applies (app/api/src/contexts/roleSuggestion.js
# SUGGESTION_THRESHOLD). The Pester tests check the data against it.
$script:DemoSuggestionThreshold = 0.4

# The application catalogue. Members are resource display names; Accountable and
# Responsible are employee ids. Owners gives groups their owners (employee ids)
# where the ownership model does not have them yet.
$script:DemoApplications = @(
    @{
        Key = 'sap-erp'; ExternalId = 'APP-0001'; Name = 'SAP ERP'
        Description = 'Order-to-cash and procure-to-pay on SAP: sales orders, materials and the SAP Basis platform.'
        Members = @('SAP_SD_SALES', 'SAP_MM_VIEWER', 'SAP_BASIS_ADMIN')
        Accountable = 'E0003'; Responsible = @('E0029')
    }
    @{
        Key = 'sap-erp-fi'; ExternalId = 'APP-0002'; Name = 'SAP ERP – Financial Accounting'; Parent = 'sap-erp'
        Description = 'The FI module of SAP ERP: journal entries, period close and the finance reports built on them.'
        Members = @('SAP_FI_ACCOUNTANT', 'SAP-Finance-Role', 'SG-Finance', 'SG-Finance-Reports')
        Owners = @(@{ Group = 'SG-Finance-Reports'; By = @('E0012') })
    }
    @{
        Key = 'crm'; ExternalId = 'APP-0003'; Name = 'Customer Relationship Management'
        Description = 'Accounts, opportunities and the sales team workspace.'
        Members = @('SG-CRM-Users', 'SG-Sales', 'SG-Sales-SharePoint')
        Accountable = 'E0004'; Responsible = @('E0013')
    }
    @{
        Key = 'itsm'; ExternalId = 'APP-0004'; Name = 'IT Service Management'
        Description = 'Service desk tooling: tickets, the knowledge base and infrastructure monitoring.'
        Members = @('SG-Servicedesk-Tools', 'SG-Servicedesk-KB', 'SG-Servicedesk-Admin', 'Ticketing-Agent', 'SG-Monitoring-Tools')
        Owners = @(
            @{ Group = 'SG-Servicedesk-Tools'; By = @('E0005') }
            @{ Group = 'SG-Servicedesk-KB';    By = @('E0005') }
            @{ Group = 'SG-Servicedesk-Admin'; By = @('E0005') }
            # A second owner on the side, so the guess has to pick the top one.
            @{ Group = 'SG-Monitoring-Tools';  By = @('E0030') }
        )
    }
    @{
        Key = 'eng-platform'; ExternalId = 'APP-0005'; Name = 'Engineering Platform'
        Description = 'The Azure production estate and the engineering tooling that deploys to it.'
        Members = @('Contributor @ rg-prod-eastus', 'Storage Blob Data Contributor @ stprodeastus01',
                    'Reader @ rg-prod-westeurope', 'Contributor @ rg-prod-westeurope', 'SG-Engineering', 'FortigiGraph-App')
        Accountable = 'E0002'; Responsible = @('E0010', 'E0029')
    }
    @{
        Key = 'pam'; ExternalId = 'APP-0006'; Name = 'Privileged Access Management'
        Description = 'Tier-0 administration and the privileged access workstation users.'
        Members = @('SG-Admin-Tier0', 'SG-PAM-Users', 'Global Administrator')
    }
    @{
        Key = 'intranet'; ExternalId = 'APP-0007'; Name = 'Employee Portal & Intranet'
        Description = 'The company intranet, project sites and the timesheet portal every employee uses.'
        Members = @('SG-AllEmployees', 'SharePoint Admin', 'SG-Project-Atlas', 'Contoso Timesheets', 'User.Read')
    }
)

# The Security Team's resources: the unit seen through what it administers.
$script:DemoSecurityTeamResources = @('SG-Admin-Tier0', 'SG-PAM-Users', 'Global Administrator')

# The id of the one access-granting resource with this display name. Ownership
# resources are named after the group they own, so they are left out of the
# lookup; any other ambiguity is a dataset bug and stops the build.
function Get-DemoResourceIdByName {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][string]$Name
    )
    $found = @($State.Resources | Where-Object { $_.displayName -ceq $Name -and $_.resourceType -ne 'GroupOwnership' })
    if ($found.Count -ne 1) {
        throw "Demo applications: expected exactly one resource named '$Name', found $($found.Count)"
    }
    return $found[0].id
}

function Add-DemoApplications {
    param([Parameter(Mandatory)]$State)

    $sysIga = $State.SystemIds['iga']
    $appIds = @{}

    foreach ($app in $script:DemoApplications) {
        $ctxId = New-DemoGuid "ctx-app-$($app.Key)"
        $appIds[$app.Key] = $ctxId
        $parentId = if ($app.ContainsKey('Parent')) { $appIds[$app.Parent] } else { $null }
        Add-DemoContext $State -Id $ctxId -DisplayName $app.Name -ContextType 'LogicalApplication' `
            -TargetType 'Resource' -ScopeSystemId $sysIga -ParentContextId $parentId `
            -ExternalId $app.ExternalId -Description $app.Description

        foreach ($name in $app.Members) {
            Add-DemoContextMember $State -ContextId $ctxId -MemberId (Get-DemoResourceIdByName $State $name) -MemberType 'Resource'
        }
        Add-DemoApplicationOwnership $State -App $app -ContextId $ctxId
    }
    $State['AppCtx'] = $appIds

    Add-DemoUnitVariants $State
}

# One application's ownership facts: the group owners it needs (the best-guess
# signal) and its Accountable / Responsible. Each key is optional.
function Add-DemoApplicationOwnership {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][hashtable]$App,
        [Parameter(Mandatory)][string]$ContextId
    )
    foreach ($o in @($App['Owners'] | Where-Object { $_ })) {
        Add-DemoGroupOwner $State -GroupId (Get-DemoResourceIdByName $State $o.Group) -GroupName $o.Group -Owners $o.By
    }
    foreach ($emp in @($App['Accountable'] | Where-Object { $_ })) {
        Add-DemoContextRole $State -ContextId $ContextId -Role 'Accountable' -PrincipalId (Get-DemoPrincipalId $emp)
    }
    foreach ($emp in @($App['Responsible'] | Where-Object { $_ })) {
        Add-DemoContextRole $State -ContextId $ContextId -Role 'Responsible' -PrincipalId (Get-DemoPrincipalId $emp)
    }
}

# The Security Team as its resources, linked SameUnitAs to the people context.
function Add-DemoUnitVariants {
    param([Parameter(Mandatory)]$State)

    $variantId = New-DemoGuid 'ctx-security-team-resources'
    Add-DemoContext $State -Id $variantId -DisplayName 'Security Team (resources)' -ContextType 'Team' `
        -TargetType 'Resource' -ScopeSystemId $State.SystemIds['hr'] `
        -Description 'What the Security Team administers.'
    foreach ($name in $script:DemoSecurityTeamResources) {
        Add-DemoContextMember $State -ContextId $variantId -MemberId (Get-DemoResourceIdByName $State $name) -MemberType 'Resource'
    }
    Add-DemoContextRelationship $State -ContextId $State.Ctx.Security -RelatedContextId $variantId
}

function New-FGAttributeMappingObject {
    # Build one flat attribute-mapping record from an attributeMapping and its context.
    param(
        [object]$Sp,
        [object]$Rule,
        [string]$JobId,
        [object]$ObjMapping,
        [object]$AttrMapping
    )

    # Extract source attributes from expression using regex
    # Matches all text between square brackets [...]
    $sourceAttributes = @()
    if ($AttrMapping.source.expression) {
        $regexMatches = [regex]::Matches($AttrMapping.source.expression, '\[([^\]]+)\]')
        $sourceAttributes = $regexMatches | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
    }

    # Build the mapping object
    return [PSCustomObject]@{
        # App information
        AppDisplayName         = $Sp.DisplayName
        AppType               = $Sp.AppType
        ServicePrincipalId    = $Sp.ServicePrincipalId
        AppId                 = $Sp.AppId
        JobId                 = $JobId

        # Sync direction
        SourceDirectory       = $Rule.sourceDirectoryName
        TargetDirectory       = $Rule.targetDirectoryName
        SyncDirection         = "$($Rule.sourceDirectoryName) -> $($Rule.targetDirectoryName)"

        # Object mapping info
        SourceObjectName      = $ObjMapping.sourceObjectName
        TargetObjectName      = $ObjMapping.targetObjectName
        ObjectMappingEnabled  = $ObjMapping.enabled

        # Attribute mapping details
        TargetAttributeName   = $AttrMapping.targetAttributeName
        SourceExpression      = $AttrMapping.source.expression
        SourceType            = $AttrMapping.source.type
        SourceName            = $AttrMapping.source.name
        SourceAttributes      = $sourceAttributes
        FlowType              = $AttrMapping.flowType
        FlowBehavior          = $AttrMapping.flowBehavior
        MatchingPriority      = $AttrMapping.matchingPriority
        DefaultValue          = $AttrMapping.defaultValue
    }
}

function Get-FGObjectMappingRecord {
    # Emit one record per attribute mapping in an object mapping, honouring the ObjectType filter.
    param(
        [object]$Sp,
        [object]$Rule,
        [string]$JobId,
        [object]$ObjMapping,
        [string]$ObjectType
    )

    # Filter by object type if specified
    if ($ObjectType -and
        $ObjMapping.sourceObjectName -ne $ObjectType -and
        $ObjMapping.targetObjectName -ne $ObjectType) {
        return
    }

    if (-not $ObjMapping.attributeMappings) {
        return
    }

    foreach ($attrMapping in $ObjMapping.attributeMappings) {
        New-FGAttributeMappingObject -Sp $Sp -Rule $Rule -JobId $JobId -ObjMapping $ObjMapping -AttrMapping $attrMapping
    }
}

function Get-FGSchemaMappingRecord {
    # Emit records for every object mapping across all synchronization rules in one schema.
    param(
        [object]$Sp,
        [object]$SchemaObj,
        [string]$ObjectType
    )

    $schema = $SchemaObj.Schema
    $jobId = $SchemaObj.JobId

    if (-not $schema -or -not $schema.synchronizationRules) {
        Write-Verbose "  No synchronization rules in schema"
        return
    }

    foreach ($rule in $schema.synchronizationRules) {
        Write-Verbose "  Processing rule: $($rule.name)"
        foreach ($objMapping in $rule.objectMappings) {
            Get-FGObjectMappingRecord -Sp $Sp -Rule $rule -JobId $jobId -ObjMapping $objMapping -ObjectType $ObjectType
        }
    }
}

function Get-FGServicePrincipalMappingRecord {
    # Emit records for every schema on one service principal (skips SPs without schemas).
    param(
        [object]$Sp,
        [string]$ObjectType
    )

    Write-Verbose "Processing: $($Sp.DisplayName)"

    # Skip if no schemas
    if (-not $Sp.Schemas) {
        Write-Verbose "  No schemas found, skipping"
        return
    }

    foreach ($schemaObj in $Sp.Schemas) {
        Get-FGSchemaMappingRecord -Sp $Sp -SchemaObj $schemaObj -ObjectType $ObjectType
    }
}

function Get-FGAttributeMapping {
    <#
    .SYNOPSIS
        Extracts attribute mappings from service principal synchronization schemas.

    .DESCRIPTION
        Takes the output from Get-FGServicePrincipalWithSync and extracts all attribute
        mappings into simple, flat objects that are easy to query and analyze.

        For each attribute mapping, extracts:
        - Target attribute name
        - Source expression
        - Source attributes (extracted from expression using regex)
        - Flow type
        - Matching priority
        - App/service principal information
        - Direction of sync

    .PARAMETER ServicePrincipalWithSync
        One or more service principal objects from Get-FGServicePrincipalWithSync
        (must include schemas with -IncludeSchema parameter).

    .PARAMETER ObjectType
        Filter mappings by object type (User, Group, etc.)
        If not specified, returns all object mappings.

    .EXAMPLE
        $apps = Get-FGServicePrincipalWithSync -IncludeSchema
        Get-FGAttributeMapping -ServicePrincipalWithSync $apps
        Returns all attribute mappings from all apps.

    .EXAMPLE
        $apps = Get-FGServicePrincipalWithSync -IncludeSchema
        Get-FGAttributeMapping -ServicePrincipalWithSync $apps -ObjectType "User"
        Returns only User object attribute mappings.

    .EXAMPLE
        $apps = Get-FGServicePrincipalWithSync -IncludeSchema
        $mappings = Get-FGAttributeMapping -ServicePrincipalWithSync $apps
        $mappings | Where-Object { $_.TargetAttributeName -eq "mail" }
        Find all mappings that target the "mail" attribute.

    .EXAMPLE
        $apps = Get-FGServicePrincipalWithSync -IncludeSchema
        $mappings = Get-FGAttributeMapping -ServicePrincipalWithSync $apps
        $mappings | Where-Object { $_.SourceAttributes -contains "employeeId" }
        Find all mappings that use "employeeId" as a source.

    .NOTES
        Source attributes are extracted from expressions using regex to find all values
        between square brackets []. For example:
        - "[mail]" -> "mail"
        - "Join(' ', [givenName], [surname])" -> "givenName", "surname"
        - "[extension_abc_customField]" -> "extension_abc_customField"

    .LINK
        Get-FGServicePrincipalWithSync
        Get-FGSynchronizationSchema
    #>

    [alias("Get-AttributeMapping")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
        [Alias("ServicePrincipal", "App")]
        [object[]]$ServicePrincipalWithSync,

        [Parameter(Mandatory = $false)]
        [string]$ObjectType
    )

    Begin {
        $allMappings = @()
    }

    Process {
        foreach ($sp in $ServicePrincipalWithSync) {
            $allMappings += Get-FGServicePrincipalMappingRecord -Sp $sp -ObjectType $ObjectType
        }
    }

    End {
        Write-Verbose "Total mappings extracted: $($allMappings.Count)"
        return $allMappings
    }
}

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
            Write-Verbose "Processing: $($sp.DisplayName)"

            # Skip if no schemas
            if (-not $sp.Schemas) {
                Write-Verbose "  No schemas found, skipping"
                continue
            }

            foreach ($schemaObj in $sp.Schemas) {
                $schema = $schemaObj.Schema
                $jobId = $schemaObj.JobId

                if (-not $schema -or -not $schema.synchronizationRules) {
                    Write-Verbose "  No synchronization rules in schema"
                    continue
                }

                foreach ($rule in $schema.synchronizationRules) {
                    Write-Verbose "  Processing rule: $($rule.name)"

                    foreach ($objMapping in $rule.objectMappings) {
                        # Filter by object type if specified
                        if ($ObjectType -and
                            $objMapping.sourceObjectName -ne $ObjectType -and
                            $objMapping.targetObjectName -ne $ObjectType) {
                            continue
                        }

                        if (-not $objMapping.attributeMappings) {
                            continue
                        }

                        foreach ($attrMapping in $objMapping.attributeMappings) {
                            # Extract source attributes from expression using regex
                            # Matches all text between square brackets [...]
                            $sourceAttributes = @()
                            if ($attrMapping.source.expression) {
                                $matches = [regex]::Matches($attrMapping.source.expression, '\[([^\]]+)\]')
                                $sourceAttributes = $matches | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
                            }

                            # Build the mapping object
                            $mapping = [PSCustomObject]@{
                                # App information
                                AppDisplayName         = $sp.DisplayName
                                AppType               = $sp.AppType
                                ServicePrincipalId    = $sp.ServicePrincipalId
                                AppId                 = $sp.AppId
                                JobId                 = $jobId

                                # Sync direction
                                SourceDirectory       = $rule.sourceDirectoryName
                                TargetDirectory       = $rule.targetDirectoryName
                                SyncDirection         = "$($rule.sourceDirectoryName) -> $($rule.targetDirectoryName)"

                                # Object mapping info
                                SourceObjectName      = $objMapping.sourceObjectName
                                TargetObjectName      = $objMapping.targetObjectName
                                ObjectMappingEnabled  = $objMapping.enabled

                                # Attribute mapping details
                                TargetAttributeName   = $attrMapping.targetAttributeName
                                SourceExpression      = $attrMapping.source.expression
                                SourceType            = $attrMapping.source.type
                                SourceName            = $attrMapping.source.name
                                SourceAttributes      = $sourceAttributes
                                FlowType              = $attrMapping.flowType
                                FlowBehavior          = $attrMapping.flowBehavior
                                MatchingPriority      = $attrMapping.matchingPriority
                                DefaultValue          = $attrMapping.defaultValue
                            }

                            $allMappings += $mapping
                        }
                    }
                }
            }
        }
    }

    End {
        Write-Verbose "Total mappings extracted: $($allMappings.Count)"
        return $allMappings
    }
}

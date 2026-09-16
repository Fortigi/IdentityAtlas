function Test-FGSPTagIsAIAgent {
    <#
    .SYNOPSIS
        True when a single service-principal tag marks the SP as an AI agent.

    .DESCRIPTION
        Keep the exact-match list narrow; speculative additions produce false
        positives that then propagate into risk scoring.

        The exact-match list covers classic AI-related platform tags plus the
        Entra Agent ID markers introduced in 2025 (AgenticInstance, AgenticApp).
        Power Virtual Agents stamps a per-instance tag of the form
        `power-virtual-agents-<guid>`, so PVA is detected via prefix match.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    Param(
        [string]$Tag
    )

    if (-not $Tag) { return $false }

    $AIPlatformTags = @(
        'CopilotStudio', 'PowerVirtualAgents', 'AzureOpenAI', 'CognitiveServices',
        'AgenticInstance', 'AgenticApp'
    )
    if ($AIPlatformTags -contains $Tag) { return $true }

    $AIPlatformTagPrefixes = @('power-virtual-agents-')
    foreach ($prefix in $AIPlatformTagPrefixes) {
        if ($Tag.StartsWith($prefix)) { return $true }
    }

    return $false
}

function Test-FGSPTagsContainAIAgent {
    <#
    .SYNOPSIS
        True when any tag in the collection marks the SP as an AI agent.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    Param(
        $Tags
    )

    foreach ($t in $Tags) {
        if (Test-FGSPTagIsAIAgent -Tag $t) { return $true }
    }

    return $false
}

function Test-FGSPNameIsAIAgent {
    <#
    .SYNOPSIS
        True when a service principal's displayName matches a built-in or
        caller-supplied AI-agent name heuristic.

    .DESCRIPTION
        Only applied when displayName is non-empty. Built-in patterns are
        combined with any caller-supplied fragments and matched
        case-insensitively; blank fragments are skipped.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    Param(
        [string]$DisplayName,

        [string[]]$ExtraPatterns = @()
    )

    if (-not $DisplayName) { return $false }

    $builtInPatterns = @('copilot', 'openai', 'azure-ai', 'cognitive-service', '\bgpt\b', '\bbot\b')
    $allPatterns = @($builtInPatterns) + @($ExtraPatterns)
    foreach ($pattern in $allPatterns) {
        if ([string]::IsNullOrWhiteSpace($pattern)) { continue }
        if ($DisplayName -match "(?i)$pattern") { return $true }
    }

    return $false
}

function Get-FGServicePrincipalType {
    <#
    .SYNOPSIS
        Classifies an Entra ID service principal into one of the principalType
        values the Identity Atlas schema understands.

    .DESCRIPTION
        Implements the detection taxonomy documented in CLAUDE.md. Applied in
        priority order:

          1. servicePrincipalType = 'ManagedIdentity'  -> ManagedIdentity
          2. Tag contains one of the well-known AI platform markers
             (CopilotStudio, PowerVirtualAgents, AzureOpenAI, CognitiveServices)
             -> AIAgent
          3. displayName matches a built-in AI name heuristic or a caller-
             supplied custom pattern -> AIAgent
          4. Default -> ServicePrincipal

        WorkloadIdentity (federated credentials) is intentionally out of scope
        here because it can't be decided from a servicePrincipal object alone.

    .PARAMETER ServicePrincipal
        The Graph service principal object (as returned by
        /beta/servicePrincipals). Must have at least `servicePrincipalType`,
        `tags`, and `displayName` fields populated if the caller wants
        accurate classification.

    .PARAMETER AINamePatterns
        Optional extra regex fragments to treat as AI-agent indicators. Matched
        case-insensitively against displayName. Callers with domain-specific
        naming ("pwc-bot-", "svc_ai_") pass them here.

    .OUTPUTS
        [string] — one of: 'ManagedIdentity', 'AIAgent', 'ServicePrincipal'
    #>
    [CmdletBinding()]
    [OutputType([string])]
    Param(
        [Parameter(Mandatory = $true)]
        $ServicePrincipal,

        [Parameter(Mandatory = $false)]
        [string[]]$AINamePatterns = @()
    )

    # Rule 1 — Managed Identity is authoritative: Graph tells us directly.
    if ($ServicePrincipal.servicePrincipalType -eq 'ManagedIdentity') {
        return 'ManagedIdentity'
    }

    # Rule 2 — Well-known AI platform tags that Microsoft stamps on SPs.
    if (Test-FGSPTagsContainAIAgent -Tags $ServicePrincipal.tags) {
        return 'AIAgent'
    }

    # Rule 3 — Name heuristics (built-in + caller-supplied patterns).
    if (Test-FGSPNameIsAIAgent -DisplayName $ServicePrincipal.displayName -ExtraPatterns $AINamePatterns) {
        return 'AIAgent'
    }

    return 'ServicePrincipal'
}

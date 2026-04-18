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
    # Keep this list narrow; speculative additions produce false positives that
    # then propagate into risk scoring.
    $AIPlatformTags = @('CopilotStudio', 'PowerVirtualAgents', 'AzureOpenAI', 'CognitiveServices')
    if ($ServicePrincipal.tags) {
        foreach ($t in $ServicePrincipal.tags) {
            if ($AIPlatformTags -contains $t) { return 'AIAgent' }
        }
    }

    # Rule 3 — Name heuristics. Only applied if displayName is non-empty.
    if ($ServicePrincipal.displayName) {
        $builtInPatterns = @('copilot', 'openai', 'azure-ai', 'cognitive-service', '\bgpt\b', '\bbot\b')
        $allPatterns = @($builtInPatterns) + @($AINamePatterns)
        foreach ($pattern in $allPatterns) {
            if ([string]::IsNullOrWhiteSpace($pattern)) { continue }
            if ($ServicePrincipal.displayName -match "(?i)$pattern") { return 'AIAgent' }
        }
    }

    return 'ServicePrincipal'
}

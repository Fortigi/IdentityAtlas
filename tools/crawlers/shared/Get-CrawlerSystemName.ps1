<#
.SYNOPSIS
    Resolve the display name of the Identity Atlas System a crawler registers for
    its own endpoint/tenant.

.DESCRIPTION
    Every pull crawler registers one System for the endpoint it connects to. That
    row's display name is what the operator sees on the Systems page, in the
    matrix and in every `__system` filter, so it has to be the name the operator
    recognises: the crawler's own name.

    Precedence (#1240):
      1. an explicit System-name override from the crawler's wizard, unless it is
         an exact copy of the type default (see below);
      2. the crawler's name, which the job dispatcher stamps onto the job config
         as the reserved `_configName` key (`app/api/src/lib/jobConfig.js`);
      3. the crawler type's own default label ("SCIM", "Entra ID (<tenant>)", …),
         which only applies to a run that carries no crawler name at all — an
         unnamed config, or an inline-config run.

    A stored override that is *exactly* the type default is treated as not set.
    Configs saved before the crawler name was plumbed through baked the type
    literal into `systemName`, which is indistinguishable from a deliberate
    override and would otherwise shadow the crawler's name forever. The trade-off
    is deliberate: an operator who wants a system named exactly like the type
    default gets it by naming the crawler that. Only an exact (trimmed,
    case-sensitive) match counts — "SCIM Test" is somebody's own label and is kept.

.NOTES
    Dot-source from a crawler file that registers a system:
        . (Join-Path $PSScriptRoot '..' 'shared' 'Get-CrawlerSystemName.ps1')

    Only the crawler's *own* endpoint/tenant row follows the crawler name. Systems
    discovered THROUGH a crawler — Omada's connected systems, midPoint's resources —
    keep the name their source gives them.
#>

function Get-CrawlerSystemName {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        # The type's own label, used when the run carries no crawler name.
        [Parameter(Mandatory)] [string]$TypeDefault,
        # CrawlerConfigs.displayName, injected into the job config as `_configName`.
        [string]$ConfigName,
        # An explicit override from the crawler's wizard, if that type has one.
        [string]$SystemName
    )

    $default  = ([string]$TypeDefault).Trim()
    $override = ([string]$SystemName).Trim()
    $name     = ([string]$ConfigName).Trim()

    # -cne, not -ne: a stale value is a byte-for-byte copy of the literal the wizard
    # baked in, so anything the operator typed differently (including in different
    # casing) is their own label and is kept.
    if ($override -and $override -cne $default) { return $override }
    if ($name) { return $name }
    return $default
}

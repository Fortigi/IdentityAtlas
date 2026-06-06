<#
.SYNOPSIS
    Omada-specific helper functions for extracting values from Omada OData reference objects.
.DESCRIPTION
    These helpers understand Omada's OIS.SetValue / OIS.ReferenceValue data model.
    They depend on $script:ODataSession being established by Connect-ODataAPI (from the odata base).
#>

#region Functions

function Get-OmadaRefValue {
    <#
    .SYNOPSIS
        Extract the display value from an Omada reference object or return a string as-is.
    .DESCRIPTION
        OData 4.0 (on-prem/cloud): OIS.SetValue has .Value (string label);
        OIS.ReferenceValue has .DisplayName (string label).
        CSV export fallback: column_VALUE, column_ENGLISH, _DISPLAYNAME.
    #>
    [CmdletBinding()]
    param($Ref, [string]$Fallback = '')
    if ($null -eq $Ref)           { return $Fallback }
    if ($Ref -is [string])        { return $Ref }
    if ($Ref.Value)               { return [string]$Ref.Value }       # OIS.SetValue
    if ($Ref.DisplayName)         { return [string]$Ref.DisplayName } # OIS.ReferenceValue (OData)
    if ($Ref.english)             { return [string]$Ref.english }
    if ($Ref._DISPLAYNAME)        { return [string]$Ref._DISPLAYNAME }
    if ($Ref.displayName)         { return [string]$Ref.displayName }
    return $Fallback
}

function Get-OmadaRefUid {
    <#
    .SYNOPSIS
        Extract the UId (Guid) from an Omada reference object or return the string as-is.
    .DESCRIPTION
        OData 4.0: OIS.ReferenceValue has .UId (Guid). Legacy: ._UID.
    #>
    [CmdletBinding()]
    param($Ref, [string]$Fallback = '')
    if ($null -eq $Ref)    { return $Fallback }
    if ($Ref -is [string]) { return $Ref }
    if ($Ref.UId)          { return [string]$Ref.UId }  # OIS.ReferenceValue (OData)
    if ($Ref._UID)         { return [string]$Ref._UID }
    if ($Ref.uid)          { return [string]$Ref.uid }
    if ($Ref.id)           { return [string]$Ref.id }
    return $Fallback
}

#endregion Functions

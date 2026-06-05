<#
.SYNOPSIS
    Omada-specific helper functions for extracting values from Omada OData reference objects
    and discovering available entity sets.
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

function Get-OmadaEntitySets {
    <#
    .SYNOPSIS
        Fetch the OData $metadata document and return the list of entity set names.
        Returns an empty array if the fetch fails (non-blocking — caller decides how to handle).
    #>
    [CmdletBinding()]
    param()
    if ($null -eq $script:ODataSession) { return @() }
    # Build URI via string concat — NOT interpolation — to keep the literal '$metadata' intact
    $metaUri = $script:ODataSession.BaseUrl.TrimEnd('/') + '/$metadata'
    $reqParams = @{ Uri = $metaUri; Method = 'Get'; ErrorAction = 'Stop' }
    switch ($script:ODataSession.AuthMethod) {
        { $_ -in 'OAuth2CC','OAuth2ROPC','ApiToken' } {
            $reqParams['Headers'] = @{ Authorization = "Bearer $($script:ODataSession.AccessToken)" }
        }
        'CookieString' {
            # $metadata returns XML — do NOT send Accept: application/json or Content-Type
            # here; those headers cause a 500 on cloud instances when the server tries to
            # serialize the metadata as JSON (which it does not support on this endpoint).
            $reqParams['Headers'] = @{ Cookie = $script:ODataSession.CookieHeader }
        }
        'FormCookie' {
            $reqParams['WebSession'] = $script:ODataSession.WebSession
        }
        'BasicAuth' {
            $reqParams['Headers'] = @{ Authorization = $script:ODataSession.BasicAuthHeader }
        }
    }
    try {
        $content = (Invoke-WebRequest @reqParams).Content
        return @([regex]::Matches($content, 'EntitySet\s+Name="([^"]+)"') |
                 ForEach-Object { $_.Groups[1].Value } |
                 Where-Object { $_ })
    } catch {
        Write-Host "  Warning: OData metadata fetch failed — $($_.Exception.Message)" -ForegroundColor Yellow
        return @()
    }
}

#endregion Functions

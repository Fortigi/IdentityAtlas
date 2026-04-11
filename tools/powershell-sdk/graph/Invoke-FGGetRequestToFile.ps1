function Invoke-FGGetRequestToFile {
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$URI,
        [Parameter(Mandatory = $true)]
        [string]$File
    )

    If (!($Global:AccessToken)) {
        Throw "No Access Token found. Please run Get-AccessToken or Get-AccessTokenInteractive before running this function."
    }
    Else {
        $AccessToken = $Global:AccessToken
    }
    
    If ($Global:DebugMode) {
        If ($Global:DebugMode.Contains('G')) {
            Write-Host "++++++++++++++++++++++++++++++++++++++++++++++++ Debug Message ++++++++++++++++++++++++++++++++++++++++++++++++++++++++" -ForegroundColor Blue
            Write-Host "Invoke-FGGetRequest" -ForegroundColor Blue
            Write-Host $URI -ForegroundColor Blue
        }
    }

    #Check if Access token is expired, if so get new one.
    Update-FGAccessTokenIfExpired -DebugFlag 'G'

    # Retry settings for transient Graph API errors
    $maxRetries = 3
    $retryDelays = @(2, 5, 15)  # Exponential backoff in seconds

    [array]$ReturnValue = $Null
    $Result = $null
    $retryCount = 0
    $success = $false

    while (-not $success -and $retryCount -le $maxRetries) {
        try {
            $Result = Invoke-RestMethod -Method Get -Uri $URI -Headers @{"Authorization" = "Bearer $AccessToken" }
            $success = $true
        }
        catch {
            $statusCode = $null
            if ($_.Exception.Response) {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }

            $errorMsg = $_.Exception.Message
            $isTransientError = $statusCode -in @(429, 500, 502, 503, 504) -or $errorMsg -match 'UnknownError|ServiceNotAvailable|GatewayTimeout'

            if ($isTransientError -and $retryCount -lt $maxRetries) {
                $retryCount++
                $waitTime = $retryDelays[$retryCount - 1]
                if ($statusCode -eq 429 -and $_.Exception.Response.Headers) {
                    try {
                        $retryAfter = $_.Exception.Response.Headers | Where-Object { $_.Key -eq 'Retry-After' } | Select-Object -ExpandProperty Value -First 1
                        if ($retryAfter -and [int]::TryParse($retryAfter, [ref]$null)) {
                            $waitTime = [math]::Max([int]$retryAfter, $waitTime)
                        }
                    } catch { }
                }

                Write-Warning "[Invoke-FGGetRequestToFile] Transient error (Status: $statusCode). Retry $retryCount/$maxRetries after ${waitTime}s..."
                Start-Sleep -Seconds $waitTime

                Update-FGAccessTokenIfExpired -DebugFlag 'G'
                $AccessToken = $Global:AccessToken
            }
            else {
                if ($retryCount -gt 0) {
                    Write-Warning "[Invoke-FGGetRequestToFile] Failed after $retryCount retry attempt(s)"
                }
                Throw $_
            }
        }
    }

    #Most get requests will return results in .value but not all.. grr... watch out.. having the propery .value doesn't mean it has a value
    if ($Result.PSobject.Properties.name -match "value") {
        [array]$ReturnValue = $Result.value
    }
    else {
        [array]$ReturnValue = $Result
    }

    #Add results to file
    ConvertTo-Json -Depth 10 -InputObject ([array]$ReturnValue) | Out-File $File -Force

    #By default you only get 100 results... its paged
    While ($Result.'@odata.nextLink') {
        # Check token validity before fetching next page
        Update-FGAccessTokenIfExpired -DebugFlag 'G'
        $AccessToken = $Global:AccessToken

        $nextLink = $Result.'@odata.nextLink'
        $Result = $null
        $retryCount = 0
        $success = $false

        while (-not $success -and $retryCount -le $maxRetries) {
            try {
                $Result = Invoke-RestMethod -Method Get -Uri $nextLink -Headers @{"Authorization" = "Bearer $AccessToken" }
                $success = $true
            }
            catch {
                $statusCode = $null
                if ($_.Exception.Response) {
                    $statusCode = [int]$_.Exception.Response.StatusCode
                }

                $errorMsg = $_.Exception.Message
                $isTransientError = $statusCode -in @(429, 500, 502, 503, 504) -or $errorMsg -match 'UnknownError|ServiceNotAvailable|GatewayTimeout'

                if ($isTransientError -and $retryCount -lt $maxRetries) {
                    $retryCount++
                    $waitTime = $retryDelays[$retryCount - 1]
                    if ($statusCode -eq 429 -and $_.Exception.Response.Headers) {
                        try {
                            $retryAfter = $_.Exception.Response.Headers | Where-Object { $_.Key -eq 'Retry-After' } | Select-Object -ExpandProperty Value -First 1
                            if ($retryAfter -and [int]::TryParse($retryAfter, [ref]$null)) {
                                $waitTime = [math]::Max([int]$retryAfter, $waitTime)
                            }
                        } catch { }
                    }

                    Write-Warning "[Invoke-FGGetRequestToFile] Pagination: Transient error (Status: $statusCode). Retry $retryCount/$maxRetries after ${waitTime}s..."
                    Start-Sleep -Seconds $waitTime

                    Update-FGAccessTokenIfExpired -DebugFlag 'G'
                    $AccessToken = $Global:AccessToken
                }
                else {
                    if ($retryCount -gt 0) {
                        Write-Warning "[Invoke-FGGetRequestToFile] Pagination: Failed after $retryCount retry attempt(s)"
                    }
                    Throw $_
                }
            }
        }

        #Most get requests will return results in .value but not all.. grr... watch out.. having the propery .value doesn't mean it has a value
        if ($Result.PSobject.Properties.name -match "value") {
            [array]$ReturnValue = $Result.value
        }
        else {
            [array]$ReturnValue = $Result
        }

        #Add results to file
        ConvertTo-Json -Depth 10 -InputObject ([array]$ReturnValue) | Out-File $File -Append
        
    }

    #We now have a file with multiple jsons not a single one. We need to make it a single JSON again.
    $FileObject = Get-Item -Path $File
    $FilePath = $FileObject.Directory.FullName
    Rename-Item -Path $File -NewName "Input.json"
    
    # Define the input and output file paths
    $InputFilePath = $FilePath + "\Input.json"
    $OutputFilePath = $File

    # Create a StreamReader to read the input file
    $Reader = [System.IO.StreamReader]::new($InputFilePath)

    # Create a StreamWriter to write to the output file
    $Writer = [System.IO.StreamWriter]::new($OutputFilePath)

    # Read the first line from the file
    $PreviousLine = $Reader.ReadLine()

    # Write the first line to the output file
    $Writer.WriteLine($PreviousLine)

    # Read the next line from the file
    $PreviousLine = $Reader.ReadLine()

    # Read subsequent lines and check for consecutive lines containing ']' and '['
    while (-not $Reader.EndOfStream) {
        # Read the next line
        $CurrentLine = $Reader.ReadLine()

        # Check if the current line and the previous line contain ']' and '[' respectively
        if ($PreviousLine -eq ']' -and $CurrentLine -eq '[') {
            # Skip writing both lines since they match the condition
            # Read the next line and update the previous line
            $Writer.WriteLine(',')
            $PreviousLine = $Reader.ReadLine()
        }
        else {
            # Write the previous line to the output file
            $Writer.WriteLine($PreviousLine)
            # Update the previous line with the current line
            $PreviousLine = $CurrentLine
        }
    }

    # Write the last line if it doesn't match the condition
    If ($PreviousLine.Length -gt 0) {
        $Writer.WriteLine($PreviousLine)
    }

    # Close the StreamReader and StreamWriter
    $Reader.Close()
    $Writer.Close() 

    Remove-Item $InputFilePath -Force

}
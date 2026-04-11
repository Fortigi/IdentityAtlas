function Get-FGGroupTransitiveMemberAllToFile {
    [alias("Get-GroupTransitiveMemberAllToFile")]
    [cmdletbinding()]
    Param
    (
        [Parameter(Mandatory = $true)]
        [string]$File
    )

    #Get Groups
    
    $GraphURI = 'https://graph.microsoft.com/beta'
    $URI = $GraphURI + '/groups?$select=id'
    
    Write-Host "Getting Groups..."
    [array]$Groups = Invoke-FGGetRequest -URI $URI

    [int]$GroupCount = $Groups.Count
    [int]$Count = 0
    Write-Host $GroupCount " found."

    If (Test-Path $File) {
        Remove-Item $File -Force
    }


    "[" | Out-File $File -Append
    #Export Group Memberships
    Foreach ($Group in $Groups) {
        
        $Count++
        $Completed = ($Count/$GroupCount) * 100
        Write-Progress -Activity "Getting All Group Members" -Status "Progress:" -PercentComplete $Completed

        $URI = $GraphURI + "/groups/" + $Group.id + '/transitiveMembers?$select=id'
        
        [array]$Members = Invoke-FGGetRequest -URI $URI

        Foreach ($Member in $Members) {
            $Row = @{
                "groupId"    = $Group.id
                "memberId"   = $Member.id
                "memberType" = $Member.'@odata.type'
            }
            
            $Row | ConvertTo-Json | Out-File $File -Append
            "," | Out-File $File -Append
        }
    }

    "]" | Out-File $File -Append
    
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

    # Read subsequent lines and check for consecutive lines containing ',' and ']'
    while (-not $Reader.EndOfStream) {
        # Read the next line
        $CurrentLine = $Reader.ReadLine()

        # Check if the current line and the previous line contain ',' and ']' respectively
        if ($PreviousLine -eq ',' -and $CurrentLine -eq ']') {
            # Skip writing both lines since they match the condition
            # Read the next line and update the previous line
            $Writer.WriteLine(']')
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
    $Writer.WriteLine($PreviousLine)

    # Close the StreamReader and StreamWriter
    $Reader.Close()
    $Writer.Close() 

    Remove-Item $InputFilePath -Force
}
function Remove-FGTrailingCommaFromJsonFile {
    # Private helper: rewrites a JSON array file that has a trailing comma before
    # the closing bracket (e.g. `{...},` then `]`). Reads line-by-line so the
    # file never needs to fit in memory. Used by Get-FGGroupMemberAllToFile and
    # Get-FGGroupTransitiveMemberAllToFile.
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$File
    )

    $FileObject = Get-Item -Path $File
    $FilePath = $FileObject.Directory.FullName
    Rename-Item -Path $File -NewName "Input.json"

    $InputFilePath  = $FilePath + "\Input.json"
    $OutputFilePath = $File

    $Reader = [System.IO.StreamReader]::new($InputFilePath)
    $Writer = [System.IO.StreamWriter]::new($OutputFilePath)

    $PreviousLine = $Reader.ReadLine()
    $Writer.WriteLine($PreviousLine)
    $PreviousLine = $Reader.ReadLine()

    while (-not $Reader.EndOfStream) {
        $CurrentLine = $Reader.ReadLine()
        if ($PreviousLine -eq ',' -and $CurrentLine -eq ']') {
            $Writer.WriteLine(']')
            $PreviousLine = $Reader.ReadLine()
        }
        else {
            $Writer.WriteLine($PreviousLine)
            $PreviousLine = $CurrentLine
        }
    }

    $Writer.WriteLine($PreviousLine)

    $Reader.Close()
    $Writer.Close()
    Remove-Item $InputFilePath -Force
}

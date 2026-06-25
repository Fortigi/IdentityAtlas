function Merge-FGJsonArrayFile {
    # Private helper: merges multiple consecutive JSON arrays appended to the
    # same file (one per page) into a single valid JSON array. Replaces the
    # '][' boundary between arrays with a comma, reading with a StreamReader
    # and writing with a StreamWriter to avoid loading the whole file into
    # memory. Used by Invoke-FGGetRequestToFile and Get-FGGroupMember*ToFile.
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$File
    )

    $FileObject = Get-Item -Path $File
    $FilePath = $FileObject.Directory.FullName
    Rename-Item -Path $File -NewName "Input.json"

    $InputFilePath  = Join-Path $FilePath "Input.json"
    $OutputFilePath = $File

    $Reader = [System.IO.StreamReader]::new($InputFilePath)
    $Writer = [System.IO.StreamWriter]::new($OutputFilePath)

    $PreviousLine = $Reader.ReadLine()
    $Writer.WriteLine($PreviousLine)
    $PreviousLine = $Reader.ReadLine()

    while (-not $Reader.EndOfStream) {
        $CurrentLine = $Reader.ReadLine()
        if ($PreviousLine -eq ']' -and $CurrentLine -eq '[') {
            $Writer.WriteLine(',')
            $PreviousLine = $Reader.ReadLine()
        }
        else {
            $Writer.WriteLine($PreviousLine)
            $PreviousLine = $CurrentLine
        }
    }

    if ($PreviousLine.Length -gt 0) {
        $Writer.WriteLine($PreviousLine)
    }

    $Reader.Close()
    $Writer.Close()
    Remove-Item $InputFilePath -Force
}

<#
.SYNOPSIS
    Test support for the SQL crawler: replay rows held in memory through
    whichever callback a statement was given.

.DESCRIPTION
    The unit tests and Test-SqlCrawler.ps1 stub Invoke-SqlQueryStream and replay
    canned rows through the crawler's own callback. A statement is read either
    row by row (-OnRow gets one ordered row, as ConvertTo-SqlRow builds it) or a
    batch at a time (-OnBatch gets the column names and an array of raw value
    arrays — the assignments hot path, SqlCrawler.Batch.ps1). This hands the same
    rows to either, so a double does not decide which path a test exercises.

    The batch's columns are the FIRST row's keys, because that is what the
    per-row path resolves its column map from; a key a later row adds is ignored
    by both paths, and a key a later row lacks arrives as NULL.
#>

function Invoke-SqlTestReplay {
    [CmdletBinding()]
    param([AllowEmptyCollection()] [object[]]$Rows = @(), [scriptblock]$OnRow, [scriptblock]$OnBatch, [int]$BatchRows = 1000)
    if ($OnRow) {
        foreach ($r in $Rows) { & $OnRow $r }
        return
    }
    if ($Rows.Count -eq 0) { return }
    $columns = [string[]]@($Rows[0].Keys)
    $batch = [System.Collections.Generic.List[object]]::new()
    foreach ($r in $Rows) {
        $values = [object[]]::new($columns.Length)
        for ($i = 0; $i -lt $columns.Length; $i++) { $values[$i] = $r[$columns[$i]] }
        $batch.Add($values)
        if ($batch.Count -ge $BatchRows) {
            & $OnBatch $columns $batch.ToArray()
            $batch = [System.Collections.Generic.List[object]]::new()
        }
    }
    if ($batch.Count -gt 0) { & $OnBatch $columns $batch.ToArray() }
}

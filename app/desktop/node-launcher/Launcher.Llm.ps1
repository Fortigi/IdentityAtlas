# The report model for Start-IdentityAtlas.ps1 -WithLLM. Dot-sourced by
# Launcher.Functions.ps1; defines functions only, so
# test/unit/NodeLauncherLlm.Tests.ps1 can load it.
#
# Two things are needed, and neither ships in the portable ZIP:
#   llama.cpp's llama-server.exe (~20 MB zip) and the model (~2.5 GB GGUF file).
# Each is looked for in the LLM folder first, so a machine without internet access
# can have both copied in beforehand; whatever is missing is downloaded once and
# checked against the SHA-256 pinned below. The running is done by node.exe
# (llmSupervisor.mjs): it starts llama-server on first use and stops it when idle.
# See docs/architecture/desktop-portable.md.

# The model and its checksum are the ones the Docker image ships
# (setup/docker/Dockerfile.report-generator); llmPins.guard.test.js keeps them equal.
$script:LlmModelFile   = 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
$script:LlmModelUrl    = 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
$script:LlmModelSha256 = '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597'
$script:LlmModelBytes  = 2497281120
$script:LlmModelAlias  = 'qwen3:4b-instruct-2507-q4_K_M'

# llama.cpp's official Windows CPU build. The zip carries every llama.cpp tool;
# only the files llama-server loads are unpacked, so an application-control
# policy needs rules for these files and no others.
$script:LlamaCppBuild  = 'b11306'
$script:LlamaCppZip    = "llama-$script:LlamaCppBuild-bin-win-cpu-x64.zip"
$script:LlamaCppUrl    = "https://github.com/ggml-org/llama.cpp/releases/download/$script:LlamaCppBuild/$script:LlamaCppZip"
$script:LlamaCppSha256 = 'dc63fb6c55e1aae2e68c1a42d21d3d985a970edeb14858dbedbd8a5bd1e1d8e4'
$script:LlamaServerFiles = '^(llama-server\.exe|llama-server-impl\.dll|llama-common\.dll|llama\.dll|mtmd\.dll|libomp\.dll|ggml(-base|-cpu-[a-z0-9]+)?\.dll|LICENSE[-\w]*)$'

# ── Where the files live ─────────────────────────────────────────────────────

# -LlmRoot when given; else an llm\ folder next to the launcher, when someone put
# one there; else llm\ in the data directory, which is always writable.
function Resolve-LlmRoot {
    param([string]$Override, [Parameter(Mandatory)][string]$ScriptDir, [Parameter(Mandatory)][string]$DataDir)
    if ($Override) { return $Override }
    $beside = Join-Path $ScriptDir 'llm'
    if (Test-Path -LiteralPath $beside -PathType Container) { return $beside }
    Join-Path $DataDir 'llm'
}

# llama-server.exe in llama.cpp\ (where this launcher unpacks it), or loose in
# the folder itself (an official zip unpacked by hand). $null when neither.
function Find-LlamaServer {
    param([Parameter(Mandatory)][string]$Root)
    foreach ($candidate in (Join-Path $Root 'llama.cpp' 'llama-server.exe'), (Join-Path $Root 'llama-server.exe')) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $null
}

# ── Download and verification ────────────────────────────────────────────────

# The one place that touches the network, so tests mock one thing. Resumes a
# partial file, and lets an authenticating corporate proxy see who is asking.
function Invoke-LlmDownload {
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$OutFile)
    try { [System.Net.Http.HttpClient]::DefaultProxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials }
    catch { Write-Verbose "Proxy credentials not set: $($_.Exception.Message)" }
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -Resume -UseBasicParsing
}

function Test-FileSha256 {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Expected)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Expected.ToUpperInvariant()
}

function Get-FreeBytes {
    param([Parameter(Mandatory)][string]$Path)
    [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Path).Path)).AvailableFreeSpace
}

# Downloads into <name>.partial, which a later run resumes, and gives the file its
# real name only once its checksum matches: a file under the real name is whole.
function Save-VerifiedDownload {
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Destination,
          [Parameter(Mandatory)][string]$Sha256, [Parameter(Mandatory)][string]$What)
    $partial = "$Destination.partial"
    Write-Host "Downloading $What from $Uri ..." -ForegroundColor Cyan
    try {
        Invoke-LlmDownload -Uri $Uri -OutFile $partial
    } catch {
        throw "Could not download $What ($($_.Exception.Message)). Without internet access, download $Uri on another machine and copy it to $Destination."
    }
    if (-not (Test-FileSha256 -Path $partial -Expected $Sha256)) {
        Remove-Item -LiteralPath $partial -Force
        throw "The downloaded $What does not match its expected SHA-256 and was deleted. Try again; if it keeps failing, something between you and $Uri is changing the file."
    }
    Move-Item -LiteralPath $partial -Destination $Destination -Force
}

# Unpacks only the files llama-server needs, into llama.cpp.partial first and
# renamed when complete, so a half-unpacked folder is never mistaken for a whole one.
function Expand-LlamaServer {
    param([Parameter(Mandatory)][string]$Zip, [Parameter(Mandatory)][string]$Root)
    $target = Join-Path $Root 'llama.cpp'
    $tmp = "$target.partial"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $tmp -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        foreach ($entry in $archive.Entries) {
            if ($entry.Name -match $script:LlamaServerFiles) {
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $tmp $entry.Name), $true)
            }
        }
    } finally {
        $archive.Dispose()
    }
    if (-not (Test-Path -LiteralPath (Join-Path $tmp 'llama-server.exe'))) {
        Remove-Item -LiteralPath $tmp -Recurse -Force
        throw "$Zip does not contain llama-server.exe."
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Move-Item -LiteralPath $tmp -Destination $target
    Join-Path $target 'llama-server.exe'
}

# llama-server.exe as found, or unpacked from the pinned zip: one copied into the
# folder beforehand is used (after its checksum is checked), otherwise it is
# downloaded and removed again once unpacked.
function Install-LlamaServer {
    param([Parameter(Mandatory)][string]$Root)
    $exe = Find-LlamaServer -Root $Root
    if ($exe) { return $exe }
    $zip = Join-Path $Root $script:LlamaCppZip
    $downloaded = $false
    if (Test-Path -LiteralPath $zip) {
        if (-not (Test-FileSha256 -Path $zip -Expected $script:LlamaCppSha256)) {
            throw "$zip does not match the expected SHA-256 for llama.cpp $script:LlamaCppBuild. Replace it with the file from $script:LlamaCppUrl."
        }
    } else {
        $null = Save-VerifiedDownload -Uri $script:LlamaCppUrl -Destination $zip -Sha256 $script:LlamaCppSha256 -What "llama.cpp $script:LlamaCppBuild (about 20 MB)"
        $downloaded = $true
    }
    $exe = Expand-LlamaServer -Zip $zip -Root $Root
    if ($downloaded) { Remove-Item -LiteralPath $zip -Force }
    $exe
}

# Hashing 2.5 GB takes a while, so a model file that passed once is remembered by
# its size and timestamp in <model>.verified and not hashed again until it changes.
function Get-ModelStamp {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-Item -LiteralPath $Path
    "$($item.Length):$($item.LastWriteTimeUtc.Ticks):$script:LlmModelSha256"
}

function Install-LlmModel {
    param([Parameter(Mandatory)][string]$Root)
    $model = Join-Path $Root $script:LlmModelFile
    $stampFile = "$model.verified"
    if (-not (Test-Path -LiteralPath $model)) {
        $needed = $script:LlmModelBytes + 512MB
        $partial = "$model.partial"
        if (Test-Path -LiteralPath $partial) { $needed -= (Get-Item -LiteralPath $partial).Length }
        $free = Get-FreeBytes -Path $Root
        if ($free -lt $needed) {
            throw [string]::Format([cultureinfo]::InvariantCulture,
                'The model needs {0:N1} GB of free disk space in {1}; {2:N1} GB is free. Free some space, or pass -LlmRoot to put it elsewhere.',
                $needed / 1GB, $Root, $free / 1GB)
        }
        $null = Save-VerifiedDownload -Uri $script:LlmModelUrl -Destination $model -Sha256 $script:LlmModelSha256 -What 'the report model (2.5 GB, once)'
    } elseif ((Get-Content -LiteralPath $stampFile -Raw -ErrorAction SilentlyContinue) -ne (Get-ModelStamp -Path $model)) {
        Write-Host 'Checking the report model file (once)...' -ForegroundColor Gray
        if (-not (Test-FileSha256 -Path $model -Expected $script:LlmModelSha256)) {
            throw "$model does not match the expected SHA-256. Replace it with the file from $script:LlmModelUrl."
        }
    }
    Set-Content -LiteralPath $stampFile -Value (Get-ModelStamp -Path $model) -NoNewline
    $model
}

# ── Preflight ────────────────────────────────────────────────────────────────

function Invoke-LlamaServerVersion {
    param([Parameter(Mandatory)][string]$ServerExe)
    $output = & $ServerExe --version 2>&1 | ForEach-Object { "$_" }
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

# The same check the bundled PostgreSQL gets (Test-PostgresBinaries): run it once
# and turn the two ways a locked-down laptop refuses it into a readable reason.
# Returns $null when it runs.
function Test-LlamaServer {
    param([Parameter(Mandatory)][string]$ServerExe)
    try {
        $r = Invoke-LlamaServerVersion -ServerExe $ServerExe
    } catch {
        return "llama-server.exe could not be started: $($_.Exception.Message) (an application-control policy blocks unsigned executables this way)."
    }
    if ($r.ExitCode -eq $script:DllNotFound) { return 'llama-server.exe is missing one of its DLLs; delete the llama.cpp folder so it is unpacked again.' }
    if ($r.ExitCode -ne 0) { return "llama-server.exe --version exited with code $($r.ExitCode): $($r.Output)" }
    $null
}

# ── Orchestration (called by Start-IdentityAtlas.ps1) ────────────────────────

# Everything -WithLLM needs, found or fetched, and checked. A problem is reported
# and the app starts without the model: custom reports can still be built by
# hand, so it is no reason to keep someone out of their data.
function Initialize-Llm {
    param([Parameter(Mandatory)][string]$Root)
    try {
        $null = New-Item -ItemType Directory -Path $Root -Force
        Write-Host "Report model folder: $Root" -ForegroundColor Gray
        $server = Install-LlamaServer -Root $Root
        $problem = Test-LlamaServer -ServerExe $server
        if ($problem) { throw $problem }
        $model = Install-LlmModel -Root $Root
        [pscustomobject]@{ Server = $server; Model = $model; Alias = $script:LlmModelAlias }
    } catch {
        Write-Warning "Starting without the report model: $($_.Exception.Message) Custom reports can still be switched on in Admin → Experimental and built by hand."
        $null
    }
}

# What node.exe reads (llmConfigFromEnv in llmSupervisor.mjs). Cleared first, so a
# value left in the shell never starts a model nobody asked for.
function Set-ChildLlmEnvironment {
    param($Llm)
    foreach ($name in 'IA_LLM_SERVER', 'IA_LLM_MODEL', 'IA_LLM_ALIAS') { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    if (-not $Llm) { return }
    $env:IA_LLM_SERVER = $Llm.Server
    $env:IA_LLM_MODEL = $Llm.Model
    $env:IA_LLM_ALIAS = $Llm.Alias
}

# Windows does not end llama-server.exe when the node.exe that started it dies.
# node.exe records its pid while it runs; one still alive after node.exe has gone
# is left over. Returns $true when it stopped one.
function Stop-OrphanedLlamaServer {
    param([Parameter(Mandatory)][string]$DataDir)
    $file = Join-Path $DataDir 'llm-server.pid'
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    $id = 0
    $null = [int]::TryParse((Get-Content -LiteralPath $file -Raw), [ref]$id)
    $proc = if ($id) { Get-Process -Id $id -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'llama-server' }
    if ($proc) {
        Stop-Process -Id $proc.Id -Force
        $null = $proc.WaitForExit(10000)
    }
    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
    [bool]$proc
}

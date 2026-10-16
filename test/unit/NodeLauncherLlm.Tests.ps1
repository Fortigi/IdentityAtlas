#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
<#
.SYNOPSIS
    Unit tests for the portable launcher's report model (app/desktop/node-launcher/Launcher.Llm.ps1):
    finding llama-server and the model, downloading and verifying what is missing, the preflight,
    starting without the model when anything fails, and stopping a llama-server left behind.

    The network is reached only through Invoke-LlmDownload, which these tests mock. The supervisor
    that runs llama-server is node code, tested in app/desktop/llmSupervisor.test.js.

.USAGE
    Invoke-Pester -Path test/unit/NodeLauncherLlm.Tests.ps1 -Output Detailed
#>

BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    . (Join-Path $root 'app' 'desktop' 'node-launcher' 'Launcher.Functions.ps1')

    function Get-Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

    # A zip shaped like llama.cpp's Windows release: flat, many tools, few needed.
    function New-LlamaZip([string]$Path, [string[]]$Names) {
        $src = Join-Path $TestDrive ([guid]::NewGuid())
        $null = New-Item -ItemType Directory $src
        foreach ($n in $Names) { Set-Content -LiteralPath (Join-Path $src $n) -Value $n }
        Compress-Archive -Path (Join-Path $src '*') -DestinationPath $Path -Force
        $Path
    }
    $script:ReleaseNames = @('llama-server.exe', 'llama-server-impl.dll', 'llama-common.dll', 'llama.dll', 'mtmd.dll',
        'libomp.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-haswell.dll', 'ggml-cpu-x64.dll', 'LICENSE-LLVM-OpenMP',
        'llama-cli.exe', 'llama-cli-impl.dll', 'llama-quantize.exe', 'ggml-rpc.dll', 'ggml-rpc-server.exe', 'llama.exe')
}

Describe 'Resolve-LlmRoot' {
    It 'uses -LlmRoot when given' {
        Resolve-LlmRoot -Override 'E:\models' -ScriptDir $TestDrive -DataDir 'D:\data' | Should -BeExactly 'E:\models'
    }
    It 'uses llm\ next to the launcher when someone put one there' {
        $dir = Join-Path $TestDrive 'pkg'
        $null = New-Item -ItemType Directory (Join-Path $dir 'llm') -Force
        Resolve-LlmRoot -ScriptDir $dir -DataDir 'D:\data' | Should -BeExactly (Join-Path $dir 'llm')
    }
    It 'otherwise uses llm\ in the data directory' {
        $data = Join-Path $TestDrive 'data'   # a real path: Join-Path needs the drive to exist on Linux runners
        Resolve-LlmRoot -ScriptDir (Join-Path $TestDrive 'empty-pkg') -DataDir $data | Should -BeExactly (Join-Path $data 'llm')
    }
}

Describe 'Find-LlamaServer' {
    BeforeEach { $r = Join-Path $TestDrive ([guid]::NewGuid()); $null = New-Item -ItemType Directory $r }
    It 'finds it where the launcher unpacks it' {
        $null = New-Item -ItemType Directory (Join-Path $r 'llama.cpp')
        Set-Content (Join-Path $r 'llama.cpp' 'llama-server.exe') 'x'
        Set-Content (Join-Path $r 'llama-server.exe') 'x'
        Find-LlamaServer -Root $r | Should -BeExactly (Join-Path $r 'llama.cpp' 'llama-server.exe')
    }
    It 'finds an official zip unpacked by hand into the folder itself' {
        Set-Content (Join-Path $r 'llama-server.exe') 'x'
        Find-LlamaServer -Root $r | Should -BeExactly (Join-Path $r 'llama-server.exe')
    }
    It 'is $null when there is none' {
        Find-LlamaServer -Root $r | Should -BeNullOrEmpty
    }
}

Describe 'Test-FileSha256' {
    It 'compares case-insensitively against the pinned lowercase hash' {
        $f = Join-Path $TestDrive 'h.txt'; Set-Content $f 'abc' -NoNewline
        Test-FileSha256 -Path $f -Expected 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' | Should -BeTrue
        Test-FileSha256 -Path $f -Expected ('0' * 64) | Should -BeFalse
    }
}

Describe 'Save-VerifiedDownload' {
    BeforeEach {
        $dest = Join-Path $TestDrive "$([guid]::NewGuid()).bin"
        $okHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'   # sha256('abc')
    }
    It 'downloads into .partial and renames only once the checksum matches' {
        Mock Invoke-LlmDownload { param($Uri, $OutFile) Set-Content -LiteralPath $OutFile -Value 'abc' -NoNewline }
        Save-VerifiedDownload -Uri 'https://x/f' -Destination $dest -Sha256 $okHash -What 'f'
        Get-Content $dest -Raw | Should -BeExactly 'abc'
        Test-Path "$dest.partial" | Should -BeFalse
        Should -Invoke Invoke-LlmDownload -Times 1 -Exactly -ParameterFilter { $OutFile -eq "$dest.partial" -and $Uri -eq 'https://x/f' }
    }
    It 'deletes a download whose checksum is wrong and never gives it the real name' {
        Mock Invoke-LlmDownload { param($Uri, $OutFile) Set-Content -LiteralPath $OutFile -Value 'abd' -NoNewline }
        { Save-VerifiedDownload -Uri 'https://x/f' -Destination $dest -Sha256 $okHash -What 'f' } | Should -Throw '*does not match its expected SHA-256*'
        Test-Path $dest | Should -BeFalse
        Test-Path "$dest.partial" | Should -BeFalse
    }
    It 'keeps a broken-off download for the next run to resume, and says how to copy the file in' {
        Mock Invoke-LlmDownload { param($Uri, $OutFile) Set-Content -LiteralPath $OutFile -Value 'ab' -NoNewline; throw 'proxy said no' }
        { Save-VerifiedDownload -Uri 'https://x/f' -Destination $dest -Sha256 $okHash -What 'f' } |
            Should -Throw "*proxy said no*download https://x/f on another machine and copy it to $dest*"
        Test-Path "$dest.partial" | Should -BeTrue
        Test-Path $dest | Should -BeFalse
    }
}

Describe 'Expand-LlamaServer' {
    BeforeEach { $r = Join-Path $TestDrive ([guid]::NewGuid()); $null = New-Item -ItemType Directory $r }
    It 'unpacks only what llama-server loads' {
        $zip = New-LlamaZip (Join-Path $r 'l.zip') $script:ReleaseNames
        Expand-LlamaServer -Zip $zip -Root $r | Should -BeExactly (Join-Path $r 'llama.cpp' 'llama-server.exe')
        (Get-ChildItem (Join-Path $r 'llama.cpp')).Name | Sort-Object | Should -Be (@(
            'ggml-base.dll', 'ggml-cpu-haswell.dll', 'ggml-cpu-x64.dll', 'ggml.dll', 'libomp.dll', 'LICENSE-LLVM-OpenMP',
            'llama-common.dll', 'llama-server-impl.dll', 'llama-server.exe', 'llama.dll', 'mtmd.dll') | Sort-Object)
        Test-Path (Join-Path $r 'llama.cpp.partial') | Should -BeFalse
    }
    It 'replaces an earlier, possibly damaged, unpack' {
        $null = New-Item -ItemType Directory (Join-Path $r 'llama.cpp')
        Set-Content (Join-Path $r 'llama.cpp' 'stale.dll') 'x'
        $zip = New-LlamaZip (Join-Path $r 'l.zip') @('llama-server.exe')
        $null = Expand-LlamaServer -Zip $zip -Root $r
        Test-Path (Join-Path $r 'llama.cpp' 'stale.dll') | Should -BeFalse
    }
    It 'refuses a zip without llama-server.exe and leaves nothing behind' {
        $zip = New-LlamaZip (Join-Path $r 'l.zip') @('llama-cli.exe', 'ggml.dll')
        { Expand-LlamaServer -Zip $zip -Root $r } | Should -Throw '*does not contain llama-server.exe*'
        Test-Path (Join-Path $r 'llama.cpp') | Should -BeFalse
        Test-Path (Join-Path $r 'llama.cpp.partial') | Should -BeFalse
    }
}

Describe 'Install-LlamaServer' {
    BeforeAll { $savedSha = $script:LlamaCppSha256 }
    AfterAll { $script:LlamaCppSha256 = $savedSha }
    BeforeEach { $r = Join-Path $TestDrive ([guid]::NewGuid()); $null = New-Item -ItemType Directory $r }

    It 'uses llama-server that is already there, without downloading' {
        Mock Save-VerifiedDownload { }
        Set-Content (Join-Path $r 'llama-server.exe') 'x'
        Install-LlamaServer -Root $r | Should -BeExactly (Join-Path $r 'llama-server.exe')
        Should -Invoke Save-VerifiedDownload -Times 0 -Exactly
    }
    It 'unpacks the pinned zip copied in beforehand, and keeps that zip' {
        Mock Save-VerifiedDownload { }
        $zip = New-LlamaZip (Join-Path $r $script:LlamaCppZip) @('llama-server.exe', 'ggml.dll')
        $script:LlamaCppSha256 = Get-Sha $zip
        Install-LlamaServer -Root $r | Should -BeExactly (Join-Path $r 'llama.cpp' 'llama-server.exe')
        Test-Path $zip | Should -BeTrue
        Should -Invoke Save-VerifiedDownload -Times 0 -Exactly
    }
    It 'refuses a copied-in zip with the wrong checksum' {
        $null = New-LlamaZip (Join-Path $r $script:LlamaCppZip) @('llama-server.exe')
        $script:LlamaCppSha256 = '0' * 64
        { Install-LlamaServer -Root $r } | Should -Throw "*does not match the expected SHA-256 for llama.cpp*$script:LlamaCppUrl*"
        Test-Path (Join-Path $r 'llama.cpp') | Should -BeFalse
    }
    It 'downloads the pinned zip when nothing is there, and removes it once unpacked' {
        Mock Save-VerifiedDownload { param($Uri, $Destination, $Sha256, $What) New-LlamaZip $Destination @('llama-server.exe') }
        Install-LlamaServer -Root $r | Should -BeExactly (Join-Path $r 'llama.cpp' 'llama-server.exe')
        Should -Invoke Save-VerifiedDownload -Times 1 -Exactly -ParameterFilter {
            $Uri -eq $script:LlamaCppUrl -and $Sha256 -eq $script:LlamaCppSha256 -and $Destination -eq (Join-Path $r $script:LlamaCppZip)
        }
        Test-Path (Join-Path $r $script:LlamaCppZip) | Should -BeFalse
    }
}

Describe 'Install-LlmModel' {
    BeforeEach {
        $r = Join-Path $TestDrive ([guid]::NewGuid()); $null = New-Item -ItemType Directory $r
        $model = Join-Path $r $script:LlmModelFile
    }
    It 'checks a copied-in model once and remembers it passed' {
        Set-Content $model 'weights'
        Mock Test-FileSha256 { $true }
        Install-LlmModel -Root $r | Should -BeExactly $model
        Install-LlmModel -Root $r | Should -BeExactly $model
        Should -Invoke Test-FileSha256 -Times 1 -Exactly -ParameterFilter { $Path -eq $model -and $Expected -eq $script:LlmModelSha256 }
        Get-Content "$model.verified" -Raw | Should -BeExactly (Get-ModelStamp -Path $model)
    }
    It 'checks again once the file changed' {
        Set-Content $model 'weights'
        Mock Test-FileSha256 { $true }
        $null = Install-LlmModel -Root $r
        Add-Content $model 'more'
        $null = Install-LlmModel -Root $r
        Should -Invoke Test-FileSha256 -Times 2 -Exactly
    }
    It 'refuses a copied-in model with the wrong checksum, and does not delete it' {
        Set-Content $model 'other weights'
        Mock Test-FileSha256 { $false }
        { Install-LlmModel -Root $r } | Should -Throw "*does not match the expected SHA-256*$script:LlmModelUrl*"
        Test-Path $model | Should -BeTrue
        Test-Path "$model.verified" | Should -BeFalse
    }
    It 'downloads a missing model when there is room, and does not hash it twice' {
        Mock Get-FreeBytes { 10GB }
        Mock Test-FileSha256 { $true }
        Mock Save-VerifiedDownload { param($Uri, $Destination) Set-Content -LiteralPath $Destination -Value 'weights' }
        Install-LlmModel -Root $r | Should -BeExactly $model
        Should -Invoke Save-VerifiedDownload -Times 1 -Exactly -ParameterFilter { $Uri -eq $script:LlmModelUrl -and $Destination -eq $model }
        Should -Invoke Test-FileSha256 -Times 0 -Exactly
        Test-Path "$model.verified" | Should -BeTrue
    }
    It 'says how much space it needs instead of filling the disk' {
        Mock Get-FreeBytes { 1GB }
        Mock Save-VerifiedDownload { }
        { Install-LlmModel -Root $r } | Should -Throw '*needs 2.8 GB of free disk space*1.0 GB is free*-LlmRoot*'
        Should -Invoke Save-VerifiedDownload -Times 0 -Exactly
    }
    It 'counts what a broken-off download already has' {
        $partial = [System.IO.File]::Create("$model.partial"); $partial.SetLength(2GB); $partial.Dispose()
        Mock Get-FreeBytes { 1GB }
        Mock Save-VerifiedDownload { param($Uri, $Destination) Set-Content -LiteralPath $Destination -Value 'weights' }
        $null = Install-LlmModel -Root $r
        Should -Invoke Save-VerifiedDownload -Times 1 -Exactly
    }
}

Describe 'Get-FreeBytes' {
    It 'reports the free space of the drive holding the folder' {
        Get-FreeBytes -Path $TestDrive | Should -BeGreaterThan 0
    }
}

Describe 'Test-LlamaServer' {
    It 'is $null when it runs' {
        Mock Invoke-LlamaServerVersion { [pscustomobject]@{ ExitCode = 0; Output = 'version: 0.5.0 (build 11306)' } }
        Test-LlamaServer -ServerExe 'x.exe' | Should -BeNullOrEmpty
    }
    It 'names application control when Windows refuses to start it' {
        Mock Invoke-LlamaServerVersion { throw 'This program is blocked by group policy.' }
        Test-LlamaServer -ServerExe 'x.exe' | Should -BeLike '*blocked by group policy*application-control policy*'
    }
    It 'names a missing DLL' {
        Mock Invoke-LlamaServerVersion { [pscustomobject]@{ ExitCode = -1073741515; Output = '' } }
        Test-LlamaServer -ServerExe 'x.exe' | Should -BeLike '*missing one of its DLLs*'
    }
    It 'reports any other failure with its output' {
        Mock Invoke-LlamaServerVersion { [pscustomobject]@{ ExitCode = 2; Output = 'bad cpu' } }
        Test-LlamaServer -ServerExe 'x.exe' | Should -BeLike '*exited with code 2: bad cpu'
    }
}

Describe 'Invoke-LlamaServerVersion' -Skip:(-not $IsWindows) {
    It 'runs the executable with --version and captures its output and exit code' {
        $cmd = Join-Path $TestDrive 'fake-server.cmd'
        Set-Content $cmd "@echo got %1`r`n@exit /b 3"
        $r = Invoke-LlamaServerVersion -ServerExe $cmd
        $r.ExitCode | Should -Be 3
        $r.Output | Should -BeExactly 'got --version'
    }
}

Describe 'Initialize-Llm' {
    BeforeEach { $r = Join-Path $TestDrive ([guid]::NewGuid()) }
    It 'returns what node.exe needs when everything is in place' {
        Mock Install-LlamaServer { 'C:\llm\llama.cpp\llama-server.exe' }
        Mock Test-LlamaServer { $null }
        Mock Install-LlmModel { 'C:\llm\model.gguf' }
        $llm = Initialize-Llm -Root $r
        $llm.Server | Should -BeExactly 'C:\llm\llama.cpp\llama-server.exe'
        $llm.Model | Should -BeExactly 'C:\llm\model.gguf'
        $llm.Alias | Should -BeExactly $script:LlmModelAlias
        Test-Path $r | Should -BeTrue
    }
    It 'does not fetch 2.5 GB for a server this machine will not run' {
        Mock Install-LlamaServer { 'C:\llm\llama-server.exe' }
        Mock Test-LlamaServer { 'blocked by policy.' }
        Mock Install-LlmModel { 'never' }
        Mock Write-Warning { }
        Initialize-Llm -Root $r | Should -BeNullOrEmpty
        Should -Invoke Install-LlmModel -Times 0 -Exactly
        Should -Invoke Write-Warning -Times 1 -Exactly -ParameterFilter { $Message -like '*blocked by policy.*switched on in Admin → Experimental and built by hand*' }
    }
    It 'starts without the model when a download fails' {
        Mock Install-LlamaServer { throw 'Could not download llama.cpp' }
        Mock Write-Warning { }
        Initialize-Llm -Root $r | Should -BeNullOrEmpty
        Should -Invoke Write-Warning -Times 1 -Exactly -ParameterFilter { $Message -like 'Starting without the report model: Could not download llama.cpp*' }
    }
}

Describe 'Set-ChildLlmEnvironment' {
    AfterEach { foreach ($n in 'IA_LLM_SERVER', 'IA_LLM_MODEL', 'IA_LLM_ALIAS') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue } }
    It 'hands the server, model and alias to node.exe' {
        Set-ChildLlmEnvironment -Llm ([pscustomobject]@{ Server = 's.exe'; Model = 'm.gguf'; Alias = 'a' })
        $env:IA_LLM_SERVER | Should -BeExactly 's.exe'
        $env:IA_LLM_MODEL | Should -BeExactly 'm.gguf'
        $env:IA_LLM_ALIAS | Should -BeExactly 'a'
    }
    It 'clears values left in the shell when started without the model' {
        $env:IA_LLM_SERVER = 'stale.exe'; $env:IA_LLM_MODEL = 'stale.gguf'; $env:IA_LLM_ALIAS = 'stale'
        Set-ChildLlmEnvironment -Llm $null
        $env:IA_LLM_SERVER | Should -BeNullOrEmpty
        $env:IA_LLM_MODEL | Should -BeNullOrEmpty
        $env:IA_LLM_ALIAS | Should -BeNullOrEmpty
    }
}

Describe 'Stop-OrphanedLlamaServer' {
    BeforeEach {
        $d = Join-Path $TestDrive ([guid]::NewGuid()); $null = New-Item -ItemType Directory $d
        $pidFile = Join-Path $d 'llm-server.pid'
    }
    It 'does nothing without a pid file' {
        Mock Stop-Process { }
        Stop-OrphanedLlamaServer -DataDir $d | Should -BeFalse
        Should -Invoke Stop-Process -Times 0 -Exactly
    }
    It 'stops the recorded llama-server and forgets it' {
        Set-Content $pidFile '4711' -NoNewline
        $fake = [pscustomobject]@{ Id = 4711; ProcessName = 'llama-server' }
        $fake | Add-Member ScriptMethod WaitForExit { param($ms) $true }
        Mock Get-Process { $fake } -ParameterFilter { $Id -eq 4711 }
        Mock Stop-Process { }
        Stop-OrphanedLlamaServer -DataDir $d | Should -BeTrue
        Should -Invoke Stop-Process -Times 1 -Exactly -ParameterFilter { $Id -eq 4711 }
        Test-Path $pidFile | Should -BeFalse
    }
    It 'never stops a different process that has since been given the same pid' {
        Set-Content $pidFile '4711' -NoNewline
        Mock Get-Process { [pscustomobject]@{ Id = 4711; ProcessName = 'excel' } } -ParameterFilter { $Id -eq 4711 }
        Mock Stop-Process { }
        Stop-OrphanedLlamaServer -DataDir $d | Should -BeFalse
        Should -Invoke Stop-Process -Times 0 -Exactly
        Test-Path $pidFile | Should -BeFalse
    }
    It 'ignores a pid file that does not hold a number' {
        Set-Content $pidFile 'garbage'
        Mock Get-Process { throw 'should not be asked' }
        Stop-OrphanedLlamaServer -DataDir $d | Should -BeFalse
        Test-Path $pidFile | Should -BeFalse
    }
}

Describe 'Invoke-LauncherCleanup stops a left-behind model server too' {
    It 'calls Stop-OrphanedLlamaServer for the data directory, after node.exe' {
        $lock = [pscustomobject]@{}; $lock | Add-Member ScriptMethod Dispose { }
        Mock Enter-LauncherLock { $lock }
        $script:order = [System.Collections.Generic.List[string]]::new()
        Mock Stop-OrphanedNode { $script:order.Add('node'); $false }
        Mock Stop-OrphanedLlamaServer { $script:order.Add('llm'); $false }
        Invoke-LauncherCleanup -DataDir 'D:\data' | Should -BeTrue
        Should -Invoke Stop-OrphanedLlamaServer -Times 1 -Exactly -ParameterFilter { $DataDir -eq 'D:\data' }
        $script:order | Should -Be @('node', 'llm')
    }
}

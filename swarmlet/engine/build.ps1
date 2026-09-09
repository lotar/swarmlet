<#
.SYNOPSIS
    Build the Swarmlet engine on Windows: upstream llama.cpp at patches/UPSTREAM_REF plus
    patches/llama-mesh-engine-*.patch, the same recipe as build.sh for darwin and linux.

.DESCRIPTION
    CPU build by default (MSVC, static). -Cuda adds the CUDA backend (needs the CUDA toolkit);
    -Vulkan adds the Vulkan backend (needs the Vulkan SDK). Ninja is used when it is on PATH,
    otherwise the default Visual Studio generator.

    Output: <OutDir>\{ggml-rpc-server,llama-server,llama-ring-bench}.exe, sha256.txt, engine.json.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build.ps1
    powershell -ExecutionPolicy Bypass -File build.ps1 -Cuda -Jobs 8
#>
[CmdletBinding()]
param(
    [string] $OutDir,
    [string] $SrcDir,
    [switch] $Cuda,
    [switch] $Vulkan,
    [int]    $Jobs = 0
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = 'windows'
if (-not $OutDir) { $OutDir = Join-Path $Here "dist\$Target" }
if (-not $SrcDir) { $SrcDir = Join-Path $Here ".build\llama.cpp-$Target" }
if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }
$Ref = (Get-Content (Join-Path $Here 'patches\UPSTREAM_REF') -Raw).Trim()
$Patch = Get-ChildItem (Join-Path $Here 'patches') -Filter 'llama-mesh-engine-*.patch' | Select-Object -First 1
if (-not $Patch) { throw "missing patch under $Here\patches" }

function Log([string]$m) { Write-Host "[engine $((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))] $m" }
# Windows PowerShell 5.1 turns redirected native stderr into a terminating error under
# $ErrorActionPreference = 'Stop'; run native tools with 'Continue' and check the exit code ourselves.
function Native([string]$Exe, [string[]]$Arguments) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } | Write-Host; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    if ($code -ne 0) { throw "$Exe $($Arguments -join ' ') failed ($code)" }
}
function Quiet([string]$Exe, [string[]]$Arguments) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments 2>&1 | Out-Null; return $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
}

# 1. source at the exact upstream ref (shallow fetch of one commit); LF checkout so the patch applies.
if (-not (Test-Path (Join-Path $SrcDir '.git'))) {
    Log "fetching upstream llama.cpp @ $Ref -> $SrcDir"
    New-Item -ItemType Directory -Force -Path $SrcDir | Out-Null
    Native git @('-C', $SrcDir, 'init', '-q')
    Native git @('-C', $SrcDir, 'config', 'core.autocrlf', 'false')
    Native git @('-C', $SrcDir, 'config', 'core.longpaths', 'true')
    Native git @('-C', $SrcDir, 'remote', 'add', 'origin', 'https://github.com/ggml-org/llama.cpp.git')
    Native git @('-C', $SrcDir, 'fetch', '-q', '--depth', '1', 'origin', $Ref)
    Native git @('-C', $SrcDir, 'checkout', '-q', 'FETCH_HEAD')
}
$Head = (& git -C $SrcDir rev-parse HEAD).Trim()
if ($Head -ne $Ref) { throw "checkout at $Head, expected $Ref" }

# 2. patch (idempotent: skip when already applied, fail loudly on partial state)
if ((Quiet git @('-C', $SrcDir, 'apply', '--check', $Patch.FullName)) -eq 0) {
    Log "applying $($Patch.Name)"; Native git @('-C', $SrcDir, 'apply', $Patch.FullName)
} elseif ((Quiet git @('-C', $SrcDir, 'apply', '--check', '--reverse', $Patch.FullName)) -eq 0) {
    Log 'patch already applied'
} else {
    throw "patch does not apply cleanly to $SrcDir (dirty tree?)"
}

# 3. configure
$Build = Join-Path $SrcDir "build-$Target"
$Common = @('-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_RPC=ON', '-DGGML_RPC_RDMA=OFF',
            '-DLLAMA_CURL=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_TOOLS=ON', '-DLLAMA_BUILD_SERVER=ON')
$Flags = @()
$Backend = 'cpu'
if ($Cuda) { $Flags += '-DGGML_CUDA=ON'; if ($env:CUDA_ARCH) { $Flags += "-DCMAKE_CUDA_ARCHITECTURES=$env:CUDA_ARCH" }; $Backend = 'cuda' }
if ($Vulkan) { $Flags += '-DGGML_VULKAN=ON'; $Backend = if ($Cuda) { 'cuda+vulkan' } else { 'vulkan' } }
$Gen = @()
if (Get-Command ninja -ErrorAction SilentlyContinue) { $Gen = @('-G', 'Ninja') }
Log "configure $Build ($Backend)"
Native cmake (@('-S', $SrcDir, '-B', $Build) + $Gen + $Common + $Flags)

# 4. build the three deliverables
Log "build (-j $Jobs)"
Native cmake @('--build', $Build, '--config', 'Release', '--target', 'ggml-rpc-server', 'llama-server', 'llama-ring-bench', '-j', "$Jobs")

# 5. collect + manifest (sha256.txt in shasum format, LF, so the agent parses it like the other OSes)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$BinDir = if (Test-Path (Join-Path $Build 'bin\Release')) { Join-Path $Build 'bin\Release' } else { Join-Path $Build 'bin' }
$lines = @(); $binaries = [ordered]@{}
foreach ($b in 'ggml-rpc-server', 'llama-server', 'llama-ring-bench') {
    Copy-Item (Join-Path $BinDir "$b.exe") (Join-Path $OutDir "$b.exe") -Force
    $h = (Get-FileHash -Algorithm SHA256 (Join-Path $OutDir "$b.exe")).Hash.ToLower()
    $lines += "$h  $b.exe"; $binaries["$b.exe"] = $h
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutDir 'sha256.txt'), (($lines -join "`n") + "`n"), $utf8)
$manifest = [ordered]@{
    schemaVersion = 1; target = $Target; upstreamRef = $Ref; patch = $Patch.Name
    patchSha256 = (Get-FileHash -Algorithm SHA256 $Patch.FullName).Hash.ToLower()
    backend = $Backend
    builtOn = "Windows $([Environment]::OSVersion.Version) $env:PROCESSOR_ARCHITECTURE"
    builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss+00:00')
    binaries = $binaries
}
[IO.File]::WriteAllText((Join-Path $OutDir 'engine.json'), ((ConvertTo-Json $manifest -Depth 4) + "`n"), $utf8)
Log "done -> $OutDir"
Get-Content (Join-Path $OutDir 'sha256.txt')

<#
.SYNOPSIS
    Windows counterpart of build-sidecar.sh + build-release.sh: compile the agent, stage the
    identical binary and the engine into the Tauri package, build the NSIS installer.

.DESCRIPTION
    Steps:
      1. bun run node-agent/build.ts windows  -> dist/agent/windows/swarmlet-node.exe (+ engine copy)
         (skipped with -ReuseAgent; the recorded hash is checked either way)
      2. stage src-tauri/binaries/swarmlet-node-x86_64-pc-windows-msvc.exe, agent-build.json, engine/
      3. cargo tauri build --bundles nsis
      4. copy the installer to dist/shell/windows/

    Never installs or starts anything.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 -ReuseAgent
#>
[CmdletBinding()]
param([switch] $ReuseAgent)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $Here '..\..')).Path
$Tauri = Join-Path $Here '..\src-tauri'
$Triple = 'x86_64-pc-windows-msvc'
function Log([string]$m) { Write-Host "[shell $((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))] $m" }
function Native([string]$Exe, [string[]]$Arguments, [string]$Cwd) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { Push-Location $Cwd; & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } | Write-Host; $code = $LASTEXITCODE }
    finally { Pop-Location; $ErrorActionPreference = $prev }
    if ($code -ne 0) { throw "$Exe $($Arguments -join ' ') failed ($code)" }
}
function Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 $Path).Hash.ToLower() }

# 1. canonical agent
$Agent = Join-Path $Root 'dist\agent\windows'
if (-not $ReuseAgent) { Native bun @('run', 'node-agent/build.ts', 'windows') $Root }
$Manifest = Get-Content (Join-Path $Agent 'agent-build.json') -Raw | ConvertFrom-Json
$Digest = Sha256 (Join-Path $Agent 'swarmlet-node.exe')
if ($Digest -ne $Manifest.sha256) { throw 'canonical agent hash mismatch' }
Log "canonical agent $Digest ($($Manifest.revision))"
foreach ($b in 'ggml-rpc-server.exe', 'llama-server.exe', 'llama-ring-bench.exe') {
    if (-not (Test-Path (Join-Path $Agent "engine\$b"))) { throw "missing engine executable: $Agent\engine\$b (run engine\build.ps1 first)" }
}
# sha256.txt check, like `shasum -c`
foreach ($line in Get-Content (Join-Path $Agent 'engine\sha256.txt')) {
    if ($line -notmatch '^([0-9a-f]{64})\s+\*?(.+?)\s*$') { continue }
    $want = $Matches[1]; $name = $Matches[2]
    $have = Sha256 (Join-Path $Agent "engine\$name")
    if ($have -ne $want) { throw "engine hash mismatch for $name" }
}
Log 'engine manifest verified'

# 2. stage into the Tauri package
$Bin = Join-Path $Tauri 'binaries'
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
Copy-Item (Join-Path $Agent 'swarmlet-node.exe') (Join-Path $Bin "swarmlet-node-$Triple.exe") -Force
Copy-Item (Join-Path $Agent 'agent-build.json') (Join-Path $Bin 'agent-build.json') -Force
if (Test-Path (Join-Path $Bin 'engine')) { Remove-Item (Join-Path $Bin 'engine') -Recurse -Force }
Copy-Item (Join-Path $Agent 'engine') (Join-Path $Bin 'engine') -Recurse
if ((Sha256 (Join-Path $Bin "swarmlet-node-$Triple.exe")) -ne $Digest) { throw 'staged sidecar differs from the canonical agent' }
Log 'staged identical service and shell agents for windows'

# 3. build the installer (cargo-tauri when installed, otherwise the prebuilt npm CLI through bunx)
$env:CARGO_BUILD_JOBS = if ($env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS } else { '4' }
if (Get-Command cargo-tauri -ErrorAction SilentlyContinue) {
    Native cargo @('tauri', 'build', '--bundles', 'nsis') $Tauri
} else {
    Native bunx @('@tauri-apps/cli@^2', 'build', '--bundles', 'nsis') $Tauri
}

# 4. publish
$Conf = Get-Content (Join-Path $Tauri 'tauri.conf.json') -Raw | ConvertFrom-Json
$TargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $Tauri 'target' }
$Installer = Get-ChildItem (Join-Path $TargetDir 'release\bundle\nsis') -Filter '*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Installer) { throw 'no NSIS installer produced' }
$Out = Join-Path $Root 'dist\shell\windows'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Name = "swarmlet-node_$($Conf.version)_x64-setup.exe"
Copy-Item $Installer.FullName (Join-Path $Out $Name) -Force
Copy-Item (Join-Path $Agent 'agent-build.json') (Join-Path $Out 'agent-build.json') -Force
Log "release staged at $Out\$Name; service artifact at $Agent (not installed)"

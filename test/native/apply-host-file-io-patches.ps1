<#
.SYNOPSIS
Applies (or reverses) the native host file I/O patches to the Venus core submodules.

.DESCRIPTION
The binary-safe host file I/O bridge for ecalls 13/14/15/16 lives in the upstream Venus core
repositories, which this repository cannot push to. The change is therefore carried as patches in
test/native/patches and applied to a checked out submodule tree. See
test/native/HOST-BINARY-FILE-IO.md for the full story.

.PARAMETER Check
Only verify that the patches apply; no file is modified.

.PARAMETER Reverse
Reverse the patches instead of applying them.
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Reverse
)

$ErrorActionPreference = 'Stop'
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$venus = Join-Path $root 'src/runtime/venus'
$venusbackend = Join-Path $venus 'src/main/kotlin/venusbackend'
$patches = Join-Path $PSScriptRoot 'patches'

function Invoke-CorePatch {
    param([string]$Repository, [string]$Patch)

    if (-not (Test-Path (Join-Path $Repository '.git'))) {
        throw "$Repository is not checked out; run 'git submodule update --init --recursive' first"
    }
    $patchPath = Join-Path $patches $Patch
    if (-not (Test-Path $patchPath)) {
        throw "missing patch file $patchPath"
    }
    $gitArgs = @('-C', $Repository, 'apply')
    if ($Check) { $gitArgs += '--check' }
    if ($Reverse) { $gitArgs += '--reverse' }
    $gitArgs += $patchPath
    & git @gitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git apply failed for $Patch in $Repository"
    }
    $verb = if ($Check) { 'verified' } elseif ($Reverse) { 'reversed' } else { 'applied' }
    Write-Host "$verb $Patch in $Repository"
}

Invoke-CorePatch -Repository $venusbackend -Patch '0001-venusbackend-binary-safe-file-io.patch'
Invoke-CorePatch -Repository $venus -Patch '0002-venus-host-file-io-api.patch'

Write-Host 'Rebuild the core (npm run compileAll), then run: node test/native/host-file-io.test.js'
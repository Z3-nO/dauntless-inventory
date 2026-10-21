param([Parameter(Mandatory=$true)][string]$Compiler)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$minhook = @('hook.c','buffer.c','trampoline.c','hde/hde64.c') | ForEach-Object { Join-Path $root ('native147/minhook/'+$_) }
$destination = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($version in @('1.6.2','1.14.7')) {
    $sourceFile = if ($version -eq '1.6.2') { 'native162.cpp' } else { 'native147/d1147-live.cpp' }
    $name = if ($version -eq '1.6.2') { 'UndauntedInternalServer.dll' } else { 'dxgi.dll' }
    $binary = Join-Path $destination $name
    & $Compiler c++ -target x86_64-windows-gnu -shared -O2 -o $binary (Join-Path $root $sourceFile) @minhook -luser32 -lkernel32 -lgdi32
    if ($LASTEXITCODE -ne 0) { throw ('Native build failed: '+$version) }
    Get-FileHash -LiteralPath $binary -Algorithm SHA256
}


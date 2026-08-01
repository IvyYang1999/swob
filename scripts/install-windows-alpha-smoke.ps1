$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installer = Get-ChildItem -Path 'dist' -Filter '*-windows-beta-x64.exe' |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw 'Windows x64 installer was not produced.'
}

$installRoot = Join-Path $env:RUNNER_TEMP ("swob-beta-installed-{0}" -f [guid]::NewGuid().ToString('N'))
$process = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$installRoot") -PassThru -Wait
if ($process.ExitCode -ne 0) {
  throw "NSIS installer exited with code $($process.ExitCode)."
}

$executable = Join-Path $installRoot 'Swob.exe'
$asar = Join-Path $installRoot 'resources\app.asar'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Installed executable is missing: $executable"
}
if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) {
  throw "Installed app.asar is missing: $asar"
}

# Read the PE COFF machine field. 0x8664 is AMD64; checking the installed
# executable catches packaging an x86/Arm binary behind an x64 filename.
$stream = [System.IO.File]::OpenRead($executable)
$reader = [System.IO.BinaryReader]::new($stream)
try {
  $stream.Position = 0x3c
  $peOffset = $reader.ReadInt32()
  $stream.Position = $peOffset + 4
  $machine = $reader.ReadUInt16()
} finally {
  $reader.Dispose()
  $stream.Dispose()
}
if ($machine -ne 0x8664) {
  throw ('Installed Swob.exe is not x64 (PE machine 0x{0:X4}).' -f $machine)
}

$asarCli = Join-Path (Get-Location) 'node_modules\.bin\asar.cmd'
if (-not (Test-Path -LiteralPath $asarCli -PathType Leaf)) {
  throw "Local asar CLI is missing: $asarCli"
}
$asarEntries = & $asarCli list $asar
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to inspect installed app.asar.'
}
if (-not ($asarEntries -match 'better-sqlite3[\\/]prebuilds[\\/]win32-x64\.node$')) {
  throw 'Installed app.asar does not contain better-sqlite3 win32-x64.node.'
}

"SWOB_PACKAGED_EXE=$executable" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"SWOB_INSTALL_ROOT=$installRoot" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "Installed and verified x64 package at $installRoot"

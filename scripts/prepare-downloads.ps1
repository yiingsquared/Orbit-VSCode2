$ErrorActionPreference = 'Stop'

# Windows build

$orbitProject = Split-Path $PSScriptRoot
& (Join-Path $orbitProject 'desktop/build.ps1')

# Website downloads

$orbitDownloads = Join-Path $orbitProject 'public/downloads'
$orbitRelease = Join-Path $orbitProject 'desktop/release'
$orbitExtension = Join-Path $orbitProject 'extension'

New-Item -ItemType Directory -Force -Path $orbitDownloads | Out-Null

foreach ($orbitFile in @('Orbit-Setup.exe', 'installer.json')) {
  Copy-Item -LiteralPath (Join-Path $orbitRelease $orbitFile) -Destination (Join-Path $orbitDownloads $orbitFile) -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$orbitArchive = Join-Path $orbitDownloads 'Orbit-Chrome.zip'

if (Test-Path -LiteralPath $orbitArchive) {
  Remove-Item -LiteralPath $orbitArchive -Force
}

[System.IO.Compression.ZipFile]::CreateFromDirectory($orbitExtension, $orbitArchive)

Write-Output 'Prepared Windows setup and Chrome connection downloads'

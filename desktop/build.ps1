$ErrorActionPreference = 'Stop'

# Framework compiler

$orbitRoot = $PSScriptRoot
$orbitCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$orbitFramework = Split-Path $orbitCompiler
$orbitWpf = Join-Path $orbitFramework 'WPF'
$orbitRelease = Join-Path $orbitRoot 'release'

if (-not (Test-Path -LiteralPath $orbitCompiler)) {
  throw 'The Windows .NET Framework C# compiler is required'
}

New-Item -ItemType Directory -Force -Path $orbitRelease | Out-Null

# Native companion

$orbitReferences = @(
  'System.dll', 'System.Core.dll', 'System.Xaml.dll',
  'System.Security.dll', 'System.Net.Http.dll', 'System.Web.Extensions.dll'
) | ForEach-Object { '/reference:' + (Join-Path $orbitFramework $_) }

$orbitReferences += @(
  'PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll',
  'UIAutomationClient.dll', 'UIAutomationTypes.dll'
) | ForEach-Object { '/reference:' + (Join-Path $orbitWpf $_) }

$orbitSources = @('AssemblyInfo.cs', 'Program.cs', 'NativeMethods.cs', 'BridgeClient.cs', 'InstallBootstrap.cs', 'ContextReader.cs', 'PetWindow.cs', 'HomePull.cs', 'QaWindow.cs', 'AttachmentPolicy.cs', 'InteractionQaWindow.cs') | ForEach-Object { Join-Path $orbitRoot $_ }

& $orbitCompiler /nologo /optimize+ /target:winexe /platform:anycpu "/win32manifest:$orbitRoot\app.manifest" "/out:$orbitRelease\Orbit.exe" @orbitReferences @orbitSources
if ($LASTEXITCODE -ne 0) { throw 'Companion compilation failed' }

# Per-user setup

$orbitSetupReferences = @('/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Security.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll')

& $orbitCompiler /nologo /optimize+ /target:winexe /platform:anycpu "/win32manifest:$orbitRoot\app.manifest" "/out:$orbitRelease\Uninstall.exe" @orbitSetupReferences "$orbitRoot\AssemblyInfo.cs" "$orbitRoot\Uninstall.cs"
if ($LASTEXITCODE -ne 0) { throw 'Uninstaller compilation failed' }

& $orbitCompiler /nologo /optimize+ /target:winexe /platform:anycpu "/win32manifest:$orbitRoot\app.manifest" "/out:$orbitRelease\Orbit-Setup.exe" @orbitSetupReferences "/resource:$orbitRelease\Orbit.exe,OrbitPayload" "/resource:$orbitRelease\Uninstall.exe,OrbitUninstaller" "$orbitRoot\AssemblyInfo.cs" "$orbitRoot\InstallBootstrap.cs" "$orbitRoot\Setup.cs"
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }

# Build fingerprints

$orbitSetup = Get-Item -LiteralPath "$orbitRelease\Orbit-Setup.exe"
$orbitHashAlgorithm = [Security.Cryptography.SHA256]::Create()
$orbitSetupStream = [IO.File]::OpenRead($orbitSetup.FullName)

try {
  $orbitDigest = [BitConverter]::ToString($orbitHashAlgorithm.ComputeHash($orbitSetupStream)).Replace('-', '').ToLowerInvariant()
}
finally {
  $orbitSetupStream.Dispose()
  $orbitHashAlgorithm.Dispose()
}

$orbitMetadata = '{"filename":"Orbit-Setup.exe","size":' + $orbitSetup.Length + ',"sha256":"' + $orbitDigest + '","version":"1.0.7","architecture":"anycpu","platform":"windows"}'
[IO.File]::WriteAllText((Join-Path $orbitRelease 'installer.json'), $orbitMetadata, (New-Object Text.UTF8Encoding $false))

Write-Output "Built companion and installer in $orbitRelease"

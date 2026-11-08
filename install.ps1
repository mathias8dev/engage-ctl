param([string]$Version = "latest", [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\engage-ctl"))
$ErrorActionPreference = "Stop"
$Repo = "mathias8dev/engage-ctl"
if ($Version -eq "latest") { $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name }
$Version = $Version -replace '^v', ''
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw "Expected a stable version such as 0.1.0" }
$Arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) { "X64" { "x64" }; "Arm64" { "arm64" }; default { throw "Unsupported Windows architecture" } }
$Archive = "engagectl-$Version-windows-$Arch.zip"
$Base = "https://github.com/$Repo/releases/download/v$Version"
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TempDir | Out-Null
try {
  Invoke-WebRequest "$Base/SHA256SUMS" -OutFile (Join-Path $TempDir "SHA256SUMS")
  Invoke-WebRequest "$Base/$Archive" -OutFile (Join-Path $TempDir $Archive)
  $Lines = @(Get-Content (Join-Path $TempDir "SHA256SUMS") | Where-Object { $_.EndsWith("  $Archive") })
  if ($Lines.Count -ne 1) { throw "Missing or ambiguous checksum" }
  $Expected = $Lines[0].Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[0]
  $Actual = (Get-FileHash (Join-Path $TempDir $Archive) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Expected -cne $Actual) { throw "Checksum mismatch; installation aborted" }
  $Unpacked = Join-Path $TempDir "unpacked"
  Expand-Archive (Join-Path $TempDir $Archive) -DestinationPath $Unpacked
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item (Join-Path $Unpacked "NODE-LICENSE.txt"), (Join-Path $Unpacked "THIRD-PARTY-NOTICES.txt") -Destination $InstallDir -Force
  Move-Item (Join-Path $Unpacked "engagectl.exe") -Destination (Join-Path $InstallDir "engagectl.exe") -Force
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($UserPath -split ';') -notcontains $InstallDir) { [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User") }
  & (Join-Path $InstallDir "engagectl.exe") --version
  if ($LASTEXITCODE -ne 0) { throw "Installed executable failed to start" }
  Write-Host "Installed in $InstallDir. Open a new terminal to use engagectl."
} finally { Remove-Item -Recurse -Force $TempDir }

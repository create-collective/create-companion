<#
.SYNOPSIS
  Build the Windows installer: engine + configuration UI in one NSIS setup.

.DESCRIPTION
  1. cargo build --release -p create-companion          (the engine)
  2. copy it to ui/src-tauri/binaries/ with the target-triple suffix Tauri
     expects for a sidecar (create-companion-x86_64-pc-windows-msvc.exe)
  3. npm run tauri build                                  (frontend, UI exe, NSIS)
  Output: target\release\bundle\nsis\Create Companion_<version>_x64-setup.exe

  Code signing (Azure Artifact Signing) switches on when the environment carries its inputs,
  which is what the release workflow does once the secrets exist: AZURE_SIGNING_ENDPOINT,
  AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE, AZURE_TENANT_ID, AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET. With none of them the installer is unsigned, as on a developer's
  machine. tools/sign_windows.ps1 signs each file.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\CreateCompanion\tools\build_installer.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path" }

$triple = (rustc -vV | Select-String '^host: (.*)$').Matches[0].Groups[1].Value
Write-Host "target triple: $triple"

# Signing is all or nothing: a partial set is a rotated secret or a deleted variable, and an
# installer that only looks signed in the workflow is worse than a failed build.
$signInputs = "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE",
              "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"
$missing = @($signInputs | Where-Object { -not [Environment]::GetEnvironmentVariable($_) })
$signing = $missing.Count -eq 0
if (-not $signing -and $missing.Count -lt $signInputs.Count) {
  Write-Host "signing inputs are incomplete; missing $($missing -join ', ')" -ForegroundColor Red
  exit 1
}
$tauriArgs = @()
if ($signing) {
  Write-Host "== signing: ON (Azure Artifact Signing) ==" -ForegroundColor Cyan
  # One PowerShell for both the module install and every signature, so the module is found.
  $ps = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }
  & $ps -NoProfile -NonInteractive -Command "if (-not (Get-Module -ListAvailable TrustedSigning)) { Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser }"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $signScript = Join-Path $root "tools\sign_windows.ps1"
  $signConfig = Join-Path ([IO.Path]::GetTempPath()) "create-companion-signing.json"
  $json = @{ bundle = @{ windows = @{ signCommand = @{
    cmd  = $ps
    args = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $signScript, "%1")
  } } } } | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($signConfig, $json)      # no BOM; the Tauri CLI reads it as JSON
  $tauriArgs = @("--", "--config", $signConfig)
} else {
  Write-Host "== signing: off (no signing inputs); the installer will be UNSIGNED ==" -ForegroundColor Yellow
}

Write-Host "== engine ==" -ForegroundColor Cyan
cargo build --release -p create-companion
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($signing) {
  # The engine goes in as a sidecar; sign it here so the copy the installer carries is signed
  # whatever the bundler decides about sidecars.
  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $signScript (Join-Path $root "target\release\create-companion.exe")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$bin = Join-Path $root "ui\src-tauri\binaries"
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item (Join-Path $root "target\release\create-companion.exe") (Join-Path $bin "create-companion-$triple.exe") -Force

Write-Host "== installer ==" -ForegroundColor Cyan
Set-Location (Join-Path $root "ui")
if (-not (Test-Path node_modules)) { npm ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
npm run tauri build @tauriArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location $root
Get-ChildItem "target\release\bundle\nsis\*.exe" | ForEach-Object {
  $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  "$h  $($_.Name)" | Out-File "$($_.FullName).sha256" -Encoding ascii
  Write-Host ("{0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB)) -ForegroundColor Green
}

if ($signing) {
  # The bundler reports a skipped signature as a log line, not a failure: ask the files.
  $signed = @(Get-ChildItem "target\release\bundle\nsis\*.exe") + @(Get-Item "target\release\create-companion.exe", "target\release\create-companion-ui.exe")
  foreach ($f in $signed) {
    $s = Get-AuthenticodeSignature -LiteralPath $f.FullName
    Write-Host ("{0}  {1}  {2}" -f $s.Status, $s.SignerCertificate.Subject, $f.Name)
    if ($s.Status -ne "Valid") { Write-Host "not signed: $($f.FullName)" -ForegroundColor Red; exit 1 }
  }
}

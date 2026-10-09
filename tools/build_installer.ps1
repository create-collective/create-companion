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

  Update artefacts (the .sig next to the installer that the in-app updater checks) switch on
  the same way, with TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD: the
  private half of the key whose public half is in tauri.conf.json. CREATE_COMPANION_EXTRA_CONFIG
  names a Tauri config file merged last (the updater test uses it to change the version, the
  key and the manifest's address).

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
# Everything the release build adds to tauri.conf.json, written to one file for --config.
$extra = @{ bundle = @{} }
if ($signing) {
  Write-Host "== signing: ON (Azure Artifact Signing) ==" -ForegroundColor Cyan
  # One PowerShell for both the module install and every signature, so the module is found.
  $ps = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }
  & $ps -NoProfile -NonInteractive -Command "if (-not (Get-Module -ListAvailable TrustedSigning)) { Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser }"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $signScript = Join-Path $root "tools\sign_windows.ps1"
  $extra.bundle.windows = @{ signCommand = @{
    cmd  = $ps
    args = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $signScript, "%1")
  } }
} else {
  Write-Host "== signing: off (no signing inputs); the installer will be UNSIGNED ==" -ForegroundColor Yellow
}

$updInputs = "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
$updMissing = @($updInputs | Where-Object { -not [Environment]::GetEnvironmentVariable($_) })
$updater = $updMissing.Count -eq 0
if (-not $updater -and $updMissing.Count -lt $updInputs.Count) {
  Write-Host "updater key inputs are incomplete; missing $($updMissing -join ', ')" -ForegroundColor Red
  exit 1
}
if ($updater) {
  Write-Host "== update artefacts: ON (the installer's .sig for the in-app updater) ==" -ForegroundColor Cyan
  $extra.bundle.createUpdaterArtifacts = $true
} else {
  Write-Host "== update artefacts: off (no updater key) ==" -ForegroundColor Yellow
}

$extraConfig = Join-Path ([IO.Path]::GetTempPath()) "create-companion-build.json"
[IO.File]::WriteAllText($extraConfig, ($extra | ConvertTo-Json -Depth 8))   # no BOM; the Tauri CLI reads it as JSON
$tauriArgs = @("--", "--config", $extraConfig)
if ($env:CREATE_COMPANION_EXTRA_CONFIG) {
  Write-Host "extra Tauri config: $env:CREATE_COMPANION_EXTRA_CONFIG"
  $tauriArgs += @("--config", $env:CREATE_COMPANION_EXTRA_CONFIG)
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
if ($updater) {
  $setup = Get-ChildItem "target\release\bundle\nsis\*-setup.exe" | Select-Object -First 1
  if (-not (Test-Path "$($setup.FullName).sig")) {
    Write-Host "no update signature next to $($setup.Name)" -ForegroundColor Red; exit 1
  }
  Write-Host "update signature: $($setup.Name).sig" -ForegroundColor Green
}
Get-ChildItem "target\release\bundle\nsis\*.exe" | ForEach-Object {
  $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  "$h  $($_.Name)" | Out-File "$($_.FullName).sha256" -Encoding ascii
  Write-Host ("{0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB)) -ForegroundColor Green
}

if ($signing) {
  # The bundler reports a skipped signature as a log line, not a failure: ask the files. The
  # configuration window is checked INSIDE the installer: Tauri patches the built exe with its
  # bundle type, signs it, packs it, then puts the unsigned original back in target\release,
  # so the signed copy exists only in the installer. 7-Zip reads an NSIS installer as an
  # archive; the GitHub runners have it, a developer machine may not, and then the installer
  # and the engine are checked alone.
  $signed = @(Get-ChildItem "target\release\bundle\nsis\*.exe") + @(Get-Item "target\release\create-companion.exe")
  $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
  if (-not $sevenZip -and (Test-Path "$env:ProgramFiles\7-Zip\7z.exe")) { $sevenZip = Get-Item "$env:ProgramFiles\7-Zip\7z.exe" }
  if ($sevenZip) {
    $extract = Join-Path ([IO.Path]::GetTempPath()) "create-companion-installer-contents"
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    & $sevenZip.Source x -y "-o$extract" (Get-ChildItem "target\release\bundle\nsis\*-setup.exe" | Select-Object -First 1).FullName | Out-Null
    $inside = @(Get-ChildItem $extract -Recurse -Filter "create-companion*.exe")
    if (-not ($inside | Where-Object Name -eq "create-companion-ui.exe")) {
      Write-Host "create-companion-ui.exe not found inside the installer (7-Zip extraction failed?)" -ForegroundColor Red; exit 1
    }
    $signed += $inside
  } else {
    Write-Host "7-Zip not found; the configuration window inside the installer is not checked here" -ForegroundColor Yellow
  }
  foreach ($f in $signed) {
    $s = Get-AuthenticodeSignature -LiteralPath $f.FullName
    Write-Host ("{0}  {1}  {2}" -f $s.Status, $s.SignerCertificate.Subject, $f.Name)
    if ($s.Status -ne "Valid") { Write-Host "not signed: $($f.FullName)" -ForegroundColor Red; exit 1 }
  }
}

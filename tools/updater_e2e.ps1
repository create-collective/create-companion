<#
.SYNOPSIS
  End-to-end test of the in-app updater on Windows: an installed build updates itself.

.DESCRIPTION
  Builds the installer twice with tools/build_installer.ps1, both signed with a throwaway
  updater key: "old" at the version in the repository and "new" at 9.9.9. Serves the new one
  and a latest.json from localhost, installs the old one silently, runs its
  `create-companion-ui --update-now`, and passes when the installed version reads 9.9.9 and the
  9.9.9 engine has started. Meant for a clean CI runner (updater-e2e.yml): it installs Create
  Companion for the current user and stops any running copy.
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$work = Join-Path ([IO.Path]::GetTempPath()) "cc-updater-e2e"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force (Join-Path $work "serve") | Out-Null
$port = 8765
$newVersion = "9.9.9"

function Step($m) { Write-Host "== $m ==" -ForegroundColor Cyan }
function Fail($m) { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }

Step "throwaway updater key"
Push-Location ui
npx tauri signer generate --ci -p e2e -w (Join-Path $work "e2e.key") | Out-Null
Pop-Location
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw (Join-Path $work "e2e.key")).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "e2e"
$pubkey = (Get-Content -Raw (Join-Path $work "e2e.key.pub")).Trim()

function Build($version) {
  # The test's own key, and plain http to localhost (refused in a release build).
  $conf = @{ plugins = @{ updater = @{ pubkey = $pubkey; dangerousInsecureTransportProtocol = $true } } }
  if ($version) { $conf.version = $version }
  $file = Join-Path $work "extra-$([guid]::NewGuid()).json"
  [IO.File]::WriteAllText($file, ($conf | ConvertTo-Json -Depth 6))
  $env:CREATE_COMPANION_EXTRA_CONFIG = $file
  # Out-Host: the build's output must not become part of what this function returns.
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "tools\build_installer.ps1") | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "build failed" }
  Get-ChildItem "target\release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime | Select-Object -Last 1
}

Step "old build"
$old = Build $null
Copy-Item $old.FullName (Join-Path $work "old-setup.exe")
$oldVersion = (Get-Content -Raw "ui\src-tauri\tauri.conf.json" | ConvertFrom-Json).version

Step "new build ($newVersion)"
# The engine reports the workspace version; stamp it too so its log proves which one started.
$cargo = Join-Path $root "Cargo.toml"
[IO.File]::WriteAllText($cargo, ((Get-Content -Raw $cargo) -replace '(?m)^version = "[^"]+"', "version = `"$newVersion`""))
Remove-Item "target\release\bundle\nsis\*" -Force
$new = Build $newVersion
git checkout -- Cargo.toml Cargo.lock
Copy-Item $new.FullName (Join-Path $work "serve\new-setup.exe")
$manifest = @{
  version   = $newVersion
  notes     = "updater end-to-end test"
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = @{ "windows-x86_64" = @{
    signature = (Get-Content -Raw "$($new.FullName).sig").Trim()
    url       = "http://127.0.0.1:$port/new-setup.exe"
  } }
}
[IO.File]::WriteAllText((Join-Path $work "serve\latest.json"), ($manifest | ConvertTo-Json -Depth 6))

Step "serve on localhost:$port"
$server = Start-Process python -ArgumentList "-m", "http.server", "$port", "--bind", "127.0.0.1", "--directory", (Join-Path $work "serve") -PassThru -WindowStyle Hidden
Start-Sleep 2

function InstalledVersion {
  $k = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -eq "Create Companion" } |
    Select-Object -First 1
  if ($k) { (Get-ItemProperty $k.PSPath).DisplayVersion }
}

try {
  Step "install old ($oldVersion)"
  # The installer's own exit only: -Wait would also wait for the engine it starts, which runs on.
  $setup = Start-Process (Join-Path $work "old-setup.exe") -ArgumentList "/S" -PassThru
  if (-not $setup.WaitForExit(180000)) { Fail "the old installer did not finish in 3 minutes" }
  $v = InstalledVersion
  if ($v -ne $oldVersion) { Fail "installed version is '$v', expected $oldVersion" }
  $dir = Join-Path $env:LOCALAPPDATA "Create Companion"
  $ui = Join-Path $dir "create-companion-ui.exe"
  if (-not (Test-Path $ui)) { Fail "$ui not installed" }
  Write-Host "installed $v in $dir"

  Step "update through create-companion-ui --update-now"
  $env:CREATE_COMPANION_UPDATE_URL = "http://127.0.0.1:$port/latest.json"
  Start-Process $ui -ArgumentList "--update-now"
  $deadline = (Get-Date).AddMinutes(4)
  while ((Get-Date) -lt $deadline -and (InstalledVersion) -ne $newVersion) { Start-Sleep 3 }
  $v = InstalledVersion
  if ($v -ne $newVersion) { Fail "installed version is still '$v' after 4 minutes" }
  Write-Host "installed version now $v" -ForegroundColor Green

  Step "the $newVersion engine started"
  $logs = Join-Path $env:LOCALAPPDATA "CreateCompanion\logs"
  $deadline = (Get-Date).AddMinutes(1)
  $started = $false
  while ((Get-Date) -lt $deadline -and -not $started) {
    $started = [bool](Get-ChildItem $logs -Filter "companion.log*" -ErrorAction SilentlyContinue |
      Select-String -SimpleMatch "version=`"$newVersion`"" -Quiet)
    if (-not $started) { Start-Sleep 2 }
  }
  if (-not $started) { Fail "no engine start line with version=`"$newVersion`" in $logs" }
  $engine = Get-Process create-companion -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dir*" }
  if (-not $engine) { Fail "create-companion.exe is not running from $dir" }
  Write-Host "engine running: pid $($engine.Id) $($engine.Path)" -ForegroundColor Green
  Write-Host "PASS: $oldVersion updated itself to $newVersion" -ForegroundColor Green
}
finally {
  Write-Host "--- update.log ---"
  Get-Content (Join-Path $env:LOCALAPPDATA "CreateCompanion\logs\update.log") -ErrorAction SilentlyContinue
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}

<#
.SYNOPSIS
  Sign one file with Azure Artifact Signing.

.DESCRIPTION
  build_installer.ps1 hands this to the Tauri bundler as its signCommand when signing is on,
  so it runs once per file: the configuration window, the engine, the NSIS plugins, the
  uninstaller and the installer itself.

  Where the certificate lives: AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,
  AZURE_SIGNING_PROFILE. Who is signing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
  (an app registration holding the Certificate Profile Signer role). Needs the TrustedSigning
  module, which build_installer.ps1 installs.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\sign_windows.ps1 target\release\create-companion.exe
#>
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = "Stop"

foreach ($name in "AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE",
                  "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET") {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "sign_windows: $name is not set" }
}

# The certificates live three days, so the timestamp is what keeps a signature valid after that.
Invoke-TrustedSigning `
  -Endpoint $env:AZURE_SIGNING_ENDPOINT `
  -CodeSigningAccountName $env:AZURE_SIGNING_ACCOUNT `
  -CertificateProfileName $env:AZURE_SIGNING_PROFILE `
  -Files $File `
  -FileDigest SHA256 `
  -TimestampRfc3161 "http://timestamp.acs.microsoft.com" `
  -TimestampDigest SHA256

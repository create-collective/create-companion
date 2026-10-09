#!/usr/bin/env bash
# Build the macOS installer: a universal (Intel + Apple Silicon) app bundle and
# a dmg containing the configuration window with the engine as its sidecar.
#
#   1. cargo build --release -p create-companion for both Apple targets
#   2. copy them to ui/src-tauri/binaries/create-companion-<triple> (Tauri builds
#      the app per architecture and merges the sidecars into the universal bundle)
#   3. npm run tauri build -- --target universal-apple-darwin
#   Output: target/universal-apple-darwin/release/bundle/dmg/Create Companion_<version>_universal.dmg
#
# Signing and notarization switch on when the environment carries their inputs, which is what
# the release workflow does once the secrets exist: APPLE_CERTIFICATE_P12 (base64 of the
# Developer ID Application .p12), APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY (the
# certificate's name, "Developer ID Application: ... (TEAMID)"), APPLE_API_KEY_P8 (the text of
# the App Store Connect key), APPLE_API_KEY_ID, APPLE_API_ISSUER_ID. With none of them the
# dmg is unsigned, as on a developer's machine.
#
# Update artefacts (Create Companion.app.tar.gz and its .sig, what the in-app updater
# downloads and checks) switch on the same way, with TAURI_SIGNING_PRIVATE_KEY and
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD: the private half of the key whose public half is in
# tauri.conf.json. CREATE_COMPANION_EXTRA_CONFIG names a Tauri config file merged last (the
# updater test uses it to change the version, the key and the manifest's address).
# CREATE_COMPANION_TARGET builds one architecture instead of the universal app (the test).
#
# Usage: tools/build_installer.sh          (from anywhere; needs rustup targets, Node 22, Xcode CLT)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Signing is all or nothing: a partial set is a rotated secret or a deleted variable, and a
# dmg that only looks signed in the workflow is worse than a failed build.
sign_inputs=(APPLE_CERTIFICATE_P12 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER_ID)
missing=()
for name in "${sign_inputs[@]}"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
signing=0
# The names Tauri reads. Cleared first: an empty one (a secret that does not exist) is not
# the same to the bundler as an absent one.
unset APPLE_CERTIFICATE APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
if [ "${#missing[@]}" -eq 0 ]; then
  signing=1
  echo "== signing: ON (Developer ID + notarization) =="
  key_path="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/AuthKey_${APPLE_API_KEY_ID}.p8"
  (umask 077; printf '%s\n' "$APPLE_API_KEY_P8" > "$key_path")
  export APPLE_CERTIFICATE="$APPLE_CERTIFICATE_P12"
  export APPLE_API_KEY="$APPLE_API_KEY_ID"
  export APPLE_API_ISSUER="$APPLE_API_ISSUER_ID"
  export APPLE_API_KEY_PATH="$key_path"
  export APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
elif [ "${#missing[@]}" -eq "${#sign_inputs[@]}" ]; then
  unset APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
  echo "== signing: off (no signing inputs); the dmg will be UNSIGNED =="
else
  echo "signing inputs are incomplete; missing ${missing[*]}" >&2
  exit 1
fi

upd_inputs=(TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
upd_missing=()
for name in "${upd_inputs[@]}"; do
  [ -n "${!name:-}" ] || upd_missing+=("$name")
done
updater=0
if [ "${#upd_missing[@]}" -eq 0 ]; then
  updater=1
  echo "== update artefacts: ON (app.tar.gz + .sig for the in-app updater) =="
elif [ "${#upd_missing[@]}" -eq "${#upd_inputs[@]}" ]; then
  echo "== update artefacts: off (no updater key) =="
else
  echo "updater key inputs are incomplete; missing ${upd_missing[*]}" >&2
  exit 1
fi
tauri_args=()
[ "$updater" -eq 1 ] && tauri_args+=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
if [ -n "${CREATE_COMPANION_EXTRA_CONFIG:-}" ]; then
  echo "extra Tauri config: $CREATE_COMPANION_EXTRA_CONFIG"
  tauri_args+=(--config "$CREATE_COMPANION_EXTRA_CONFIG")
fi

target="${CREATE_COMPANION_TARGET:-universal-apple-darwin}"
if [ "$target" = universal-apple-darwin ]; then
  arches=(aarch64-apple-darwin x86_64-apple-darwin)
else
  arches=("$target")
fi
for t in "${arches[@]}"; do
  rustup target add "$t" >/dev/null
done

echo "== engine (${arches[*]}) =="
for t in "${arches[@]}"; do
  cargo build --release -p create-companion --target "$t"
done

# Tauri builds the app once per architecture and wants a sidecar named for
# each; it merges them into the universal bundle itself.
mkdir -p ui/src-tauri/binaries
for t in "${arches[@]}"; do
  cp "target/$t/release/create-companion" "ui/src-tauri/binaries/create-companion-$t"
done
if [ "$target" = universal-apple-darwin ]; then
  lipo -create \
    target/aarch64-apple-darwin/release/create-companion \
    target/x86_64-apple-darwin/release/create-companion \
    -output ui/src-tauri/binaries/create-companion-universal-apple-darwin
  lipo -info ui/src-tauri/binaries/create-companion-universal-apple-darwin
fi

echo "== app bundle + dmg =="
cd ui
[ -d node_modules ] || npm ci
npm run tauri build -- --target "$target" ${tauri_args[@]+"${tauri_args[@]}"}
cd "$root"

if [ "$updater" -eq 1 ]; then
  for tgz in "target/$target/release/bundle/macos/"*.app.tar.gz; do
    [ -f "$tgz.sig" ] || { echo "no update signature next to $tgz" >&2; exit 1; }
    echo "update signature: $(basename "$tgz").sig"
  done
fi

out="target/$target/release/bundle/dmg"
for f in "$out"/*.dmg; do
  shasum -a 256 "$f" | sed "s#$out/##" > "$f.sha256"
  ls -lh "$f" | awk '{print $5, $9}'
done

if [ "$signing" -eq 1 ]; then
  # The bundler reports a skipped step as a log line, not a failure: ask the bundle itself.
  for app in "target/$target/release/bundle/macos/"*.app; do
    codesign --verify --deep --strict --verbose=2 "$app"
    xcrun stapler validate "$app"
    spctl --assess --type execute --verbose=2 "$app"
  done
fi

#!/usr/bin/env bash
# End-to-end test of the in-app updater on macOS: an installed app updates itself.
#
# Builds the app twice for this Mac's architecture with tools/build_installer.sh, both signed
# with a throwaway updater key: "old" at the repository's version and "new" at 9.9.9. Serves
# the new app.tar.gz and a latest.json from localhost, puts the old app in ~/Applications, runs
# its `create-companion-ui --update-now`, and passes when the app there reads 9.9.9 and the
# 9.9.9 engine has started. Meant for a CI runner (updater-e2e.yml).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
work="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cc-updater-e2e"
rm -rf "$work" && mkdir -p "$work/serve"
port=8765
new_version=9.9.9
target="$(rustc -vV | sed -n 's/^host: //p')"
export CREATE_COMPANION_TARGET="$target"
bundle="target/$target/release/bundle/macos"
app="$HOME/Applications/Create Companion.app"
logs="$HOME/Library/Logs/CreateCompanion"

step() { echo "== $* =="; }
fail() { echo "FAIL: $*" >&2; exit 1; }
plist_version() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist" 2>/dev/null || true; }

step "throwaway updater key"
(cd ui && npx tauri signer generate --ci -p e2e -w "$work/e2e.key" >/dev/null)
TAURI_SIGNING_PRIVATE_KEY="$(cat "$work/e2e.key")"
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD=e2e
pubkey="$(cat "$work/e2e.key.pub")"

# The test's own key, and plain http to localhost (refused in a release build).
build() {
  local conf="$work/extra-${1:-old}.json"
  python3 - "$conf" "$pubkey" "${1:-}" <<'PY'
import json, sys
conf = {"plugins": {"updater": {"pubkey": sys.argv[2], "dangerousInsecureTransportProtocol": True}}}
if sys.argv[3]:
    conf["version"] = sys.argv[3]
json.dump(conf, open(sys.argv[1], "w"))
PY
  CREATE_COMPANION_EXTRA_CONFIG="$conf" bash tools/build_installer.sh
}

step "old build"
build ""
old_version=$(python3 -c "import json; print(json.load(open('ui/src-tauri/tauri.conf.json'))['version'])")
ditto "$bundle/Create Companion.app" "$work/old.app"

step "new build ($new_version)"
# The engine reports the workspace version; stamp it too so its log proves which one started.
sed -i '' -E "s/^version = \"[^\"]+\"/version = \"$new_version\"/" Cargo.toml
rm -rf "$bundle"
build "$new_version"
git checkout -- Cargo.toml Cargo.lock
cp "$bundle/Create Companion.app.tar.gz" "$work/serve/new.app.tar.gz"
platform="darwin-$(uname -m | sed 's/arm64/aarch64/')"
python3 - "$work/serve/latest.json" "$new_version" "$platform" "$bundle/Create Companion.app.tar.gz.sig" "$port" <<'PY'
import json, sys
from datetime import datetime, timezone
out, version, platform, sig, port = sys.argv[1:]
json.dump({
    "version": version,
    "notes": "updater end-to-end test",
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {platform: {
        "signature": open(sig).read().strip(),
        "url": f"http://127.0.0.1:{port}/new.app.tar.gz",
    }},
}, open(out, "w"), indent=2)
PY

step "serve on localhost:$port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/serve" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true; echo "--- update.log ---"; cat "$logs/update.log" 2>/dev/null || true' EXIT
sleep 2

step "install old ($old_version) in ~/Applications"
mkdir -p "$HOME/Applications"
rm -rf "$app"
ditto "$work/old.app" "$app"
[ "$(plist_version)" = "$old_version" ] || fail "installed app reads '$(plist_version)', expected $old_version"

step "update through create-companion-ui --update-now"
CREATE_COMPANION_UPDATE_URL="http://127.0.0.1:$port/latest.json" "$app/Contents/MacOS/create-companion-ui" --update-now &
ui=$!
for _ in $(seq 1 120); do
  [ "$(plist_version)" = "$new_version" ] && break
  sleep 2
done
[ "$(plist_version)" = "$new_version" ] || fail "the app still reads '$(plist_version)' after 4 minutes"
echo "app in ~/Applications now reads $(plist_version)"
for _ in $(seq 1 30); do kill -0 "$ui" 2>/dev/null || break; sleep 1; done
kill -0 "$ui" 2>/dev/null && fail "create-companion-ui --update-now did not exit after installing"

step "the $new_version engine started"
for _ in $(seq 1 30); do
  grep -qs "version=\"$new_version\"" "$logs"/companion.log* && break
  sleep 2
done
grep -qs "version=\"$new_version\"" "$logs"/companion.log* || fail "no engine start line with version=\"$new_version\" in $logs"
echo "PASS: $old_version updated itself to $new_version"

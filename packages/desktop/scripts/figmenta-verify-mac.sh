#!/usr/bin/env bash
# Figmenta fork: checks a signed macOS release of Orchestra Desktop, artifact by artifact.
#   packages/desktop/scripts/figmenta-verify-mac.sh <release-dir> <version>
# Every Orchestra-<version>-<arch>.dmg and .zip: Gatekeeper on the dmg itself, then on the
# app inside (codesign --deep --strict, spctl, stapler), bundle id it.figmenta.orchestra,
# LSEnvironment limited to Electron's MallocNanoZone (the e2e flavor injects its env there), version, architecture of the main binary
# and of every native module, updater cache directory. Then latest-mac.yml against the
# files on disk. Exits non-zero at the first failing artifact.
set -euo pipefail

release="${1:?release dir}"
version="${2:?version}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bundle_id="it.figmenta.orchestra"
fail() { echo "FAIL: $*" >&2; exit 1; }

check_app() {
  local app="$1" want="$2" label="$3"
  codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | grep -v -e '--prepared:' -e '--validated:' | sed 's/^/codesign: /'
  spctl -a -vv "$app" 2>&1 | sed 's/^/spctl: /'
  spctl -a -vv "$app" 2>&1 | grep -q "source=Notarized Developer ID" || fail "$label: not Notarized Developer ID"
  xcrun stapler validate "$app" 2>&1 | sed 's/^/stapler: /'
  local plist="$app/Contents/Info.plist"
  local exe got id shortver
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
  got="$(lipo -archs "$app/Contents/MacOS/$exe")"
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
  shortver="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
  echo "lipo: $exe = $got (want $want)"
  echo "bundle: $id $shortver"
  # Electron's own Info.plist sets LSEnvironment { MallocNanoZone = 0 }; any other key is
  # injected (the e2e flavor carries its isolation env there) and fails the release.
  local env_keys
  env_keys="$(plutil -extract LSEnvironment json -o - "$plist" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s||"{}")).sort().join(" ")))')"
  echo "LSEnvironment keys: ${env_keys:-none}"
  for key in $env_keys; do
    [[ "$key" == MallocNanoZone ]] || fail "$label: Info.plist LSEnvironment carries $key (e2e flavor?)"
  done
  grep '^updaterCacheDirName:' "$app/Contents/Resources/app-update.yml" | sed 's/^/app-update.yml: /'
  grep -q '^url: https://downloads.figmenta.site/orchestra-desktop/updates/$' \
    "$app/Contents/Resources/app-update.yml" || fail "$label: app-update.yml feed is not the production one"
  local bad_native=0 native archs
  while IFS= read -r -d '' native; do
    archs="$(lipo -archs "$native" 2>/dev/null || echo '?')"
    case " $archs " in
      *" $want "*) ;;
      *) echo "native without $want: $archs ${native#"$app"/}"; bad_native=1 ;;
    esac
  done < <(find "$app" \( -name '*.node' -o -name 'esbuild' -path '*/bin/*' \) -type f -print0)

  [[ "$got" == "$want" ]] || fail "$label: $exe is $got, expected $want"
  [[ "$id" == "$bundle_id" ]] || fail "$label: bundle id $id, expected $bundle_id"
  [[ "$shortver" == "$version" ]] || fail "$label: bundle version $shortver, expected $version"
  [[ $bad_native -eq 0 ]] || fail "$label: native modules without $want"
}

want_arch() {
  local arch="${1##*-}"
  arch="${arch%.*}"
  [[ "$arch" == x64 ]] && arch=x86_64
  echo "$arch"
}

shopt -s nullglob
dmgs=("$release"/Orchestra-"$version"-*.dmg)
zips=("$release"/Orchestra-"$version"-*.zip)
[[ ${#dmgs[@]} -gt 0 ]] || fail "no Orchestra-$version-*.dmg in $release"
[[ ${#zips[@]} -gt 0 ]] || fail "no Orchestra-$version-*.zip in $release"

for dmg in "${dmgs[@]}"; do
  want="$(want_arch "$dmg")"
  echo "== $(basename "$dmg")"
  spctl -a -vv -t open --context context:primary-signature "$dmg" 2>&1 | sed 's/^/dmg: /'
  mount="$(mktemp -d)"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" > /dev/null
  status=0
  (check_app "$mount/Orchestra.app" "$want" "$(basename "$dmg")") || status=$?
  hdiutil detach "$mount" -quiet
  rmdir "$mount" 2>/dev/null || true
  [[ $status -eq 0 ]] || exit "$status"
done

for zip in "${zips[@]}"; do
  want="$(want_arch "$zip")"
  echo "== $(basename "$zip")"
  unpacked="$(mktemp -d)"
  ditto -x -k "$zip" "$unpacked"
  status=0
  (check_app "$unpacked/Orchestra.app" "$want" "$(basename "$zip")") || status=$?
  rm -rf "$unpacked"
  [[ $status -eq 0 ]] || exit "$status"
done

echo "== latest-mac.yml"
node "$here/figmenta-mac-manifest.mjs" verify "$release/latest-mac.yml" "$release"
echo "OK: ${#dmgs[@]} dmg + ${#zips[@]} zip + manifest verified"

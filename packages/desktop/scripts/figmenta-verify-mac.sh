#!/usr/bin/env bash
# Figmenta fork: checks a signed macOS release of Orchestra Desktop, dmg by dmg.
#   packages/desktop/scripts/figmenta-verify-mac.sh <release-dir> <version>
# For each Orchestra-<version>-<arch>.dmg: Gatekeeper on the dmg, then on the app inside
# it (codesign --deep --strict, spctl), the architecture of the main binary and of every
# native module, and the updater cache directory. Exits non-zero on the first failure.
set -euo pipefail

release="${1:?release dir}"
version="${2:?version}"
fail() { echo "FAIL: $*" >&2; exit 1; }

shopt -s nullglob
dmgs=("$release"/Orchestra-"$version"-*.dmg)
[[ ${#dmgs[@]} -gt 0 ]] || fail "no Orchestra-$version-*.dmg in $release"

for dmg in "${dmgs[@]}"; do
  arch="${dmg##*-}"
  arch="${arch%.dmg}"
  want="$arch"
  [[ "$want" == x64 ]] && want=x86_64
  echo "== $(basename "$dmg")"
  spctl -a -vv -t open --context context:primary-signature "$dmg" 2>&1 | sed 's/^/dmg: /'

  mount="$(mktemp -d)"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" > /dev/null
  app="$mount/Orchestra.app"
  codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | sed 's/^/codesign: /'
  spctl -a -vv "$app" 2>&1 | sed 's/^/spctl: /'
  xcrun stapler validate "$app" 2>&1 | sed 's/^/stapler: /'
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
  got="$(lipo -archs "$app/Contents/MacOS/$exe")"
  echo "lipo: $exe = $got (want $want)"
  shortver="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
  echo "version: $shortver"
  grep '^updaterCacheDirName:' "$app/Contents/Resources/app-update.yml" | sed 's/^/app-update.yml: /'
  bad_native=0
  while IFS= read -r -d '' native; do
    archs="$(lipo -archs "$native" 2>/dev/null || echo '?')"
    case " $archs " in
      *" $want "*) ;;
      *) echo "native without $want: $archs ${native#"$app"/}"; bad_native=1 ;;
    esac
  done < <(find "$app" \( -name '*.node' -o -name 'esbuild' -path '*/bin/*' \) -type f -print0)
  hdiutil detach "$mount" -quiet
  rmdir "$mount" 2>/dev/null || true

  [[ "$got" == "$want" ]] || fail "$exe is $got, expected $want"
  [[ "$shortver" == "$version" ]] || fail "bundle version $shortver, expected $version"
  [[ $bad_native -eq 0 ]] || fail "native modules without $want in $(basename "$dmg")"
done
echo "OK: ${#dmgs[@]} dmg verified"

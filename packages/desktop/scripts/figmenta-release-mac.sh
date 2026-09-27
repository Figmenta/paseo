#!/usr/bin/env bash
# Figmenta fork: signed + notarized macOS release of Orchestra Desktop, arm64 AND x64,
# built on the Mac that holds the Developer ID identity. Never in CI: this repository is
# public and the signing material must not go near it.
#
#   packages/desktop/scripts/figmenta-release-mac.sh [--skip-web] [extra electron-builder args]
#
# Output in packages/desktop/release/:
#   Orchestra-<v>-arm64.dmg / .zip   Orchestra-<v>-x64.dmg / .zip   (+ .blockmap)
#   latest-mac.yml                   both arches, the manifest the mandatory updater reads
#
# Secrets are read from files and never printed. Defaults (override with env):
#   FIGMENTA_CODESIGN_DIR       ~/.figmenta-codesign   (keychain.pw, AuthKey_<id>.p8, asc_issuer)
#   FIGMENTA_CODESIGN_KEYCHAIN  ~/Library/Keychains/figmenta-codesign.keychain-db
#   FIGMENTA_CODESIGN_IDENTITY  "Figmenta S.r.l. (8UK563QG96)"  (Developer ID Application)
#   FIGMENTA_ASC_ISSUER         App Store Connect issuer id (else read from asc_issuer)
#
# x64 is cross-built on Apple Silicon. npm installs only the host's optional native
# packages, so the x64 twins of the two the app ships (esbuild's binary, sherpa-onnx) are
# unpacked next to the arm64 ones for the x64 pass and removed afterwards.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop="$(cd "$here/.." && pwd)"
repo="$(cd "$desktop/../.." && pwd)"
release="$desktop/release"

sign_dir="${FIGMENTA_CODESIGN_DIR:-$HOME/.figmenta-codesign}"
keychain="${FIGMENTA_CODESIGN_KEYCHAIN:-$HOME/Library/Keychains/figmenta-codesign.keychain-db}"
identity="${FIGMENTA_CODESIGN_IDENTITY:-Figmenta S.r.l. (8UK563QG96)}"

skip_web=0
if [[ "${1:-}" == "--skip-web" ]]; then
  skip_web=1
  shift
fi

shopt -s nullglob
keys=("$sign_dir"/AuthKey_*.p8)
[[ ${#keys[@]} -eq 1 ]] || { echo "expected exactly one AuthKey_*.p8 in $sign_dir" >&2; exit 1; }
asc_key="${keys[0]}"
asc_key_id="$(basename "$asc_key" .p8)"
asc_key_id="${asc_key_id#AuthKey_}"
asc_issuer="${FIGMENTA_ASC_ISSUER:-}"
if [[ -z "$asc_issuer" && -f "$sign_dir/asc_issuer" ]]; then
  asc_issuer="$(tr -d '[:space:]' < "$sign_dir/asc_issuer")"
fi
[[ -n "$asc_issuer" ]] || { echo "set FIGMENTA_ASC_ISSUER or write $sign_dir/asc_issuer" >&2; exit 1; }
[[ -f "$keychain" ]] || { echo "missing keychain $keychain" >&2; exit 1; }
[[ -f "$sign_dir/keychain.pw" ]] || { echo "missing $sign_dir/keychain.pw" >&2; exit 1; }

# Unlock the dedicated keychain for this run (the password never reaches stdout).
security unlock-keychain -p "$(cat "$sign_dir/keychain.pw")" "$keychain"
security find-identity -v -p codesigning "$keychain" | grep -q "Developer ID Application: $identity" \
  || { echo "identity '$identity' not found in $keychain" >&2; exit 1; }

export CSC_KEYCHAIN="$keychain"
export APPLE_API_KEY="$asc_key"
export APPLE_API_KEY_ID="$asc_key_id"
export APPLE_API_ISSUER="$asc_issuer"
export CSC_IDENTITY_AUTO_DISCOVERY=false

sign_args=(
  --publish never
  "-c.mac.identity=$identity"
  -c.mac.hardenedRuntime=true
  -c.mac.notarize=true
  -c.dmg.sign=true
)

version="$(node -p "require('$desktop/package.json').version")"
rm -rf "$release"
mkdir -p "$release"
manifests="$(mktemp -d)"
twins="$(mktemp -d)"

# x64 twins of the arm64-only optional packages that end up inside the app.
twin_specs=()
while IFS= read -r line; do twin_specs+=("$line"); done < <(
  cd "$repo" && node -e '
    const fs = require("fs"), path = require("path");
    const out = [];
    for (const dir of ["node_modules/@esbuild/darwin-arm64", "packages/server/node_modules/@esbuild/darwin-arm64", "node_modules/sherpa-onnx-darwin-arm64"]) {
      if (!fs.existsSync(dir)) continue;
      const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      out.push([path.dirname(dir), name.replace("arm64", "x64"), version].join(" "));
    }
    console.log(out.join("\n"));
  '
)

installed_twins=()
remove_twins() {
  # ${a[@]+...}: bash 3.2 treats an empty array as unbound under `set -u`.
  for target in ${installed_twins[@]+"${installed_twins[@]}"}; do rm -rf "$target"; done
}
trap 'remove_twins; rm -rf "$manifests" "$twins"' EXIT

build_arch() {
  local arch="$1"
  shift
  (
    cd "$desktop"
    npm run build:main
    npx electron-builder --config electron-builder.yml --mac dmg zip "--$arch" "${sign_args[@]}" "$@"
  )
  cp "$release/latest-mac.yml" "$manifests/latest-mac-$arch.yml"
}

cd "$repo"
if [[ $skip_web -eq 0 ]]; then
  # Same preparation as `npm run build:desktop`: app export, server build.
  npm run build:app-deps:clean
  (cd packages/app && npx cross-env PASEO_WEB_PLATFORM=electron npx expo export --platform web)
  npm run build:server:clean
fi

build_arch arm64 "$@"

for spec in "${twin_specs[@]}"; do
  read -r parent name ver <<< "$spec"
  (cd "$twins" && npm pack --silent "$name@$ver" > /dev/null)
  tarball=("$twins"/*"$(basename "$name")-$ver.tgz")
  target="$repo/$parent/$(basename "$name")"
  mkdir -p "$target"
  tar -xzf "${tarball[0]}" -C "$target" --strip-components 1
  installed_twins+=("$target")
  echo "x64 twin: $parent/$(basename "$name")@$ver"
done

build_arch x64 "$@"
remove_twins
installed_twins=()

# One manifest for both architectures (upstream's merge script, as in desktop-release.yml).
node "$repo/scripts/merge-mac-manifest.mjs" \
  "$manifests/latest-mac-arm64.yml" "$manifests/latest-mac-x64.yml" "$release/latest-mac.yml"

# electron-builder notarizes and staples the .app; the dmg around it is notarized here.
for dmg in "$release"/Orchestra-"$version"-*.dmg; do
  xcrun notarytool submit "$dmg" --key "$asc_key" --key-id "$asc_key_id" --issuer "$asc_issuer" --wait
  xcrun stapler staple "$dmg"
done

"$here/figmenta-verify-mac.sh" "$release" "$version"

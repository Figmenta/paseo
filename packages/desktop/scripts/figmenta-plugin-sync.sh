#!/usr/bin/env bash
# Figmenta fork: inject the private figmenta-sessions plugin into the desktop build.
#
#   packages/desktop/scripts/figmenta-plugin-sync.sh <plugin-repo-path> <git-ref>
#
# The plugin (Figmenta/paseo-orchestra-plugin) is private and this repository is public, so
# its source is never committed here: packages/desktop/figmenta-plugin/ is git-ignored and
# refilled by this script from a checkout of the plugin, at one exact commit, right before a
# build. Only what the daemon needs to esbuild the plugin is extracted; tests, fixtures,
# docs, lockfile and CI files stay out. figmenta-plugin/.source records ref, sha and version.
#
# scripts/figmenta-plugin-guard.js then fails the build when the folder is missing or holds
# a version other than packages/desktop/figmenta-plugin.version (docs/FIGMENTA.md,
# "Plugin injection").
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <plugin-repo-path> <git-ref>" >&2
  exit 2
fi
[[ -d "$1" ]] || { echo "no such directory: $1" >&2; exit 1; }
repo="$(cd "$1" && pwd)"
ref="$2"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop="$(cd "$here/.." && pwd)"
dest="$desktop/figmenta-plugin"

# Top-level entries of the plugin tree. `keep` ships in the app; `skip_re` never does.
# Anything else fails the sync, so a new runtime directory in the plugin can never be left
# out of the app (or a new private file slipped into it) without someone deciding.
keep=(index.server.ts index.client.tsx server client shared package.json paseo-plugin.json tsconfig.json)
skip_re='^(\.github|\.gitignore|\.gitattributes|\.editorconfig|README\.md|CHANGELOG\.md|LICENSE|package-lock\.json|desktop|docs|scripts|.*\.(test|spec)\.tsx?|vitest\.config\.[cm]?[jt]s)$'
# Inside the kept directories: tests and fixtures stay out.
drop_re='(^|/)(__fixtures__|__tests__|__mocks__)(/|$)|\.(test|spec)\.tsx?$'

git -C "$repo" rev-parse --git-dir > /dev/null 2>&1 || { echo "not a git repository: $repo" >&2; exit 1; }
sha="$(git -C "$repo" rev-parse --verify --quiet "$ref^{commit}")" || {
  echo "unknown ref in $repo: $ref" >&2
  exit 1
}

while IFS= read -r name; do
  for k in "${keep[@]}"; do
    [[ "$name" == "$k" ]] && continue 2
  done
  [[ "$name" =~ $skip_re ]] && continue
  echo "unexpected top-level entry in the plugin at $sha: $name" >&2
  echo "decide whether it ships: add it to keep or to skip_re in $0" >&2
  exit 1
done < <(git -C "$repo" ls-tree --name-only "$sha")

for k in "${keep[@]}"; do
  git -C "$repo" cat-file -e "$sha:$k" 2> /dev/null || { echo "the plugin at $sha has no $k" >&2; exit 1; }
done

files=()
while IFS= read -r f; do
  [[ "$f" =~ $drop_re ]] && continue
  files+=("$f")
done < <(git -C "$repo" ls-tree -r --name-only "$sha" -- "${keep[@]}")

rm -rf "$dest"
mkdir -p "$dest"
# core.autocrlf=false: the same bytes on every host (hosted Windows runners default to true).
git -c core.autocrlf=false --literal-pathspecs -C "$repo" archive --format=tar "$sha" -- "${files[@]}" \
  | tar -xf - -C "$dest"

version="$(cd "$dest" && node -p "require('./package.json').version")"
cat > "$dest/.source" << EOF
# Written by packages/desktop/scripts/figmenta-plugin-sync.sh; not part of the plugin repo.
ref=$ref
sha=$sha
version=$version
EOF

echo "figmenta-plugin $version <- $repo @ $ref ($sha), ${#files[@]} files"
expected_file="$desktop/figmenta-plugin.version"
if [[ -f "$expected_file" ]]; then
  expected="$(tr -d '[:space:]' < "$expected_file")"
  if [[ "$version" != "$expected" ]]; then
    echo "warning: packages/desktop/figmenta-plugin.version says $expected; the build guard will refuse $version" >&2
  fi
fi

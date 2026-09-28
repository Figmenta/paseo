// Figmenta fork: build guard for the private figmenta-sessions plugin.
//
// The plugin's source is not in this public repository: scripts/figmenta-plugin-sync.sh
// extracts it from the private checkout into packages/desktop/figmenta-plugin/ (git-ignored)
// right before a build. electron-builder skips a missing extraResources source without
// failing, so without this guard a build would ship an Orchestra with no plugin, or with a
// stale one.
//
// Wired as electron-builder's `beforePack` hook (electron-builder.yml), so it stops every
// build path: `npm run build:desktop`, the signed macOS release, CI. It also runs alone:
//   node packages/desktop/scripts/figmenta-plugin-guard.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_DIR = path.resolve(__dirname, "..");
const SYNC_HINT =
  "run packages/desktop/scripts/figmenta-plugin-sync.sh <plugin-repo-path> <git-ref> " +
  '(docs/FIGMENTA.md, "Plugin injection")';
// Files the daemon needs to load and esbuild the plugin.
const REQUIRED_FILES = ["paseo-plugin.json", "index.server.ts", "index.client.tsx", ".source"];

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseSource(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

// The synced package.json: present, parseable, at the expected version, with every required file.
function checkPackage(pluginDir, expected, errors) {
  const pkgText = readText(path.join(pluginDir, "package.json"));
  if (pkgText === null) {
    errors.push(
      "packages/desktop/figmenta-plugin/package.json is missing: the plugin was not synced",
    );
    return null;
  }
  let version = null;
  try {
    version = JSON.parse(pkgText).version ?? null;
  } catch (error) {
    errors.push(`figmenta-plugin/package.json does not parse: ${error.message}`);
  }
  if (expected && version !== expected) {
    errors.push(`figmenta-plugin is ${version ?? "unversioned"}, this app expects ${expected}`);
  }
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(pluginDir, file)))
      errors.push(`figmenta-plugin/${file} is missing`);
  }
  return version;
}

function checkFigmentaPlugin(desktopDir = DESKTOP_DIR) {
  const pluginDir = path.join(desktopDir, "figmenta-plugin");
  const errors = [];

  const expectedText = readText(path.join(desktopDir, "figmenta-plugin.version"));
  const expected = expectedText === null ? null : expectedText.trim();
  if (!expected) {
    errors.push("packages/desktop/figmenta-plugin.version is missing or empty");
  }

  const version = checkPackage(pluginDir, expected, errors);

  const sourceText = readText(path.join(pluginDir, ".source"));
  const source = sourceText === null ? {} : parseSource(sourceText);
  if (sourceText !== null && expected && source.version !== expected) {
    errors.push(
      `figmenta-plugin/.source records ${source.version ?? "no version"}, expected ${expected}`,
    );
  }

  // The version the plugin announces over the bridge must match package.json.
  const versionTs = readText(path.join(pluginDir, "shared", "version.ts"));
  const announced = versionTs && /PLUGIN_VERSION\s*=\s*["']([^"']+)["']/.exec(versionTs);
  if (announced && expected && announced[1] !== expected) {
    errors.push(
      `figmenta-plugin/shared/version.ts announces ${announced[1]}, expected ${expected}`,
    );
  }

  return { ok: errors.length === 0, errors, expected, version, source, pluginDir };
}

function assertFigmentaPlugin(desktopDir) {
  const result = checkFigmentaPlugin(desktopDir);
  if (!result.ok) {
    const lines = result.errors.map((error) => `  - ${error}`).join("\n");
    throw new Error(`figmenta-plugin guard failed:\n${lines}\n${SYNC_HINT}`);
  }
  return result;
}

function describe(result) {
  const sha = result.source.sha ? result.source.sha.slice(0, 12) : "unknown sha";
  return `figmenta-plugin guard: ${result.version} OK (${sha}, ref ${result.source.ref ?? "?"})`;
}

exports.checkFigmentaPlugin = checkFigmentaPlugin;
exports.assertFigmentaPlugin = assertFigmentaPlugin;

// electron-builder beforePack hook: throwing fails the build before anything is packed.
exports.default = async function beforePack() {
  console.log(describe(assertFigmentaPlugin()));
};

if (require.main === module) {
  try {
    console.log(describe(assertFigmentaPlugin()));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

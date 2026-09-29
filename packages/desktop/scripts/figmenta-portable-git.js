// Figmenta fork: Git Bash inside Orchestra for Windows (runtime side: src/figmenta/git-bash-setup.ts).
//
// Claude Code on Windows runs hooks and its Bash tool in Git Bash. Without one it falls back to
// PowerShell and the plugin's expiry hook, a POSIX sh command, fails open (measured on
// windows-latest, plugin repo branch probe/zero-setup, run 36536223926). A clean Windows has no
// Git, so the Windows build carries Git for Windows' PortableGit self-extractor, pinned by version
// and by the SHA-256 published in its release notes, under resources/git/ with a manifest the app
// reads. MinGit was measured too: no bash.exe, and its sh.exe breaks the Bash tool.
//
// Called from after-pack.js for win32 targets; the download is cached in
// packages/desktop/.cache/portable-git (git-ignored). Also runs alone to fill that cache:
//   node packages/desktop/scripts/figmenta-portable-git.js [x64|arm64]
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PORTABLE_GIT = {
  version: "2.56.0",
  tag: "v2.56.0.windows.1",
  assets: {
    x64: {
      file: "PortableGit-2.56.0-64-bit.7z.exe",
      sha256: "eceb5e061aa90df2f69ddd3e90f0030e1b8037a7829934bc40e4be1caa1accc1",
    },
    arm64: {
      file: "PortableGit-2.56.0-arm64.7z.exe",
      sha256: "edd9bd32aefa5d2bd4b938c38c18ceca306a7f6b29a6951cd6a4bb16d9d28d8f",
    },
  },
};
const MANIFEST_NAME = "portable-git.json";
const DEFAULT_CACHE_DIR = path.resolve(__dirname, "..", ".cache", "portable-git");

// `pinned` is replaceable only so the tests can pin a small fake archive.
function portableGitAsset(arch, pinned = PORTABLE_GIT) {
  const asset = pinned.assets[arch];
  if (!asset) throw new Error(`PortableGit: no pinned build for Windows ${arch}`);
  return {
    ...asset,
    version: pinned.version,
    url: `https://github.com/git-for-windows/git/releases/download/${pinned.tag}/${asset.file}`,
  };
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/** The pinned archive in the cache, downloaded when absent; a wrong hash is never used. */
async function ensurePortableGitCached(arch, options = {}) {
  const asset = portableGitAsset(arch, options.pinned);
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const fetchImpl = options.fetch ?? fetch;
  const cached = path.join(cacheDir, asset.file);
  if (fs.existsSync(cached) && (await sha256File(cached)) === asset.sha256) return cached;

  fs.mkdirSync(cacheDir, { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  try {
    const response = await fetchImpl(asset.url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`PortableGit: download failed, HTTP ${response.status} for ${asset.url}`);
    }
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
    const actual = await sha256File(partial);
    if (actual !== asset.sha256) {
      throw new Error(
        `PortableGit: ${asset.file} has SHA-256 ${actual}, expected ${asset.sha256}: not bundled`,
      );
    }
    fs.renameSync(partial, cached);
    return cached;
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

/** resources/git/<archive> + resources/git/portable-git.json, replacing whatever was there. */
async function bundlePortableGit(resourcesDir, arch, options = {}) {
  const asset = portableGitAsset(arch, options.pinned);
  const cached = await ensurePortableGitCached(arch, options);
  const gitDir = path.join(resourcesDir, "git");
  fs.rmSync(gitDir, { recursive: true, force: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.copyFileSync(cached, path.join(gitDir, asset.file));
  const manifest = { version: asset.version, file: asset.file, sha256: asset.sha256 };
  fs.writeFileSync(path.join(gitDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`PortableGit ${asset.version} (${arch}) bundled in ${gitDir}`);
  return manifest;
}

exports.PORTABLE_GIT = PORTABLE_GIT;
exports.MANIFEST_NAME = MANIFEST_NAME;
exports.portableGitAsset = portableGitAsset;
exports.ensurePortableGitCached = ensurePortableGitCached;
exports.bundlePortableGit = bundlePortableGit;

if (require.main === module) {
  const arch = process.argv[2] ?? "x64";
  ensurePortableGitCached(arch).then(
    (file) => console.log(`PortableGit ${PORTABLE_GIT.version} (${arch}) cached: ${file}`),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}

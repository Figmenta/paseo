const fs = require("fs");
const path = require("path");

const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");

const { installLinuxLauncher } = require("./linux-sandbox");

const EXECUTABLE_NAME = "Orchestra";

// Figmenta fork: electron-updater keeps downloads in ~/Library/Caches/<updaterCacheDirName>
// (%LOCALAPPDATA% on Windows) and cleans that directory on every check. electron-builder
// derives the name from the package name, `@getpaseo/desktop`, the same as an installed
// Paseo Desktop: the two apps would delete each other's pending update. Orchestra gets
// its own. User hooks run after electron-builder's own afterPack handlers, so the
// app-update.yml it writes already exists here, and signing has not happened yet.
const UPDATER_CACHE_DIR_NAME = "orchestra-desktop-updater";

function resourcesDirFor(appOutDir, platform) {
  return platform === "darwin"
    ? path.join(appOutDir, `${EXECUTABLE_NAME}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");
}

function setUpdaterCacheDirName(resourcesDir, dirName = UPDATER_CACHE_DIR_NAME) {
  const file = path.join(resourcesDir, "app-update.yml");
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const line = `updaterCacheDirName: ${dirName}`;
  const next = /^updaterCacheDirName:.*$/m.test(text)
    ? text.replace(/^updaterCacheDirName:.*$/m, line)
    : `${text.replace(/\n?$/, "\n")}${line}\n`;
  if (next !== text) fs.writeFileSync(file, next);
  console.log(`app-update.yml: ${line}`);
  return true;
}

// electron-builder arch enum → Node.js arch string
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

const RIPGREP_PLATFORM_DIR = {
  darwin: { arm64: "arm64-darwin", x64: "x64-darwin" },
  linux: { arm64: "arm64-linux", x64: "x64-linux" },
  win32: { arm64: "arm64-win32", x64: "x64-win32" },
};

function rmSafe(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneChildrenExcept(parent, keep) {
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent)) {
    if (!keep.has(entry)) {
      rmSafe(path.join(parent, entry));
    }
  }
}

function pruneClaudeAgentSdk(nodeModules, platform, arch) {
  const vendorRoot = path.join(nodeModules, "@anthropic-ai", "claude-agent-sdk", "vendor");
  const keepName = RIPGREP_PLATFORM_DIR[platform]?.[arch];
  if (keepName) {
    pruneChildrenExcept(path.join(vendorRoot, "ripgrep"), new Set(["COPYING", keepName]));
    pruneChildrenExcept(path.join(vendorRoot, "tree-sitter-bash"), new Set([keepName]));
  }

  // SDK ≥0.2.113 ships per-platform Claude Code binaries via optionalDependencies
  // (~210 MB each). Paseo requires user-installed `claude` on PATH, matching how
  // Codex/OpenCode are integrated, so drop every bundled copy.
  const anthropicDir = path.join(nodeModules, "@anthropic-ai");
  if (fs.existsSync(anthropicDir)) {
    for (const entry of fs.readdirSync(anthropicDir)) {
      if (entry.startsWith("claude-agent-sdk-")) {
        rmSafe(path.join(anthropicDir, entry));
      }
    }
  }
}

function pruneNodePty(nodeModules, platform, arch) {
  const prebuilds = path.join(nodeModules, "node-pty", "prebuilds");
  pruneChildrenExcept(prebuilds, new Set([`${platform}-${arch}`]));

  if (platform !== "win32") {
    rmSafe(path.join(nodeModules, "node-pty", "third_party"));
  }
}

function pruneSharpLibvips(nodeModules, platform, arch) {
  const prefix = `sharp-libvips-${platform}-${arch}`;
  const imgDir = path.join(nodeModules, "@img");
  if (!fs.existsSync(imgDir)) return;

  for (const entry of fs.readdirSync(imgDir)) {
    if (
      entry.startsWith("sharp-") &&
      entry !== prefix &&
      !entry.startsWith(`sharp-${platform}-${arch}`)
    ) {
      rmSafe(path.join(imgDir, entry));
    }
  }
}

// Figmenta fork: a cross-arch build (x64 on Apple Silicon, figmenta-release-mac.sh) has both
// arches of esbuild's and sherpa-onnx's platform packages in node_modules. Keep the target
// arch only, and make esbuild/bin/esbuild — which esbuild's installer overwrites with the
// HOST binary — the target-arch binary too. On a native build this finds nothing to do.
function isNativeExecutable(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    const magic = head.toString("hex");
    return ["cffaedfe", "cefaedfe", "cafebabe", "7f454c46"].includes(magic);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function keepTargetArchOnly(nodeModules, platform, arch) {
  const target = `${platform}-${arch}`;

  const esbuildScope = path.join(nodeModules, "@esbuild");
  if (fs.existsSync(path.join(esbuildScope, target))) {
    pruneChildrenExcept(esbuildScope, new Set([target]));
    const targetBinary = path.join(esbuildScope, target, "bin", "esbuild");
    const shim = path.join(nodeModules, "esbuild", "bin", "esbuild");
    if (fs.existsSync(targetBinary) && isNativeExecutable(shim)) {
      fs.copyFileSync(targetBinary, shim);
      fs.chmodSync(shim, 0o755);
    }
  }

  const sherpaTarget = `sherpa-onnx-${target}`;
  if (fs.existsSync(path.join(nodeModules, sherpaTarget))) {
    for (const entry of fs.readdirSync(nodeModules)) {
      if (entry.startsWith(`sherpa-onnx-${platform}-`) && entry !== sherpaTarget) {
        rmSafe(path.join(nodeModules, entry));
      }
    }
  }
}

function pruneNativeModules(appOutDir, platform, arch) {
  const resourcesDir = resourcesDirFor(appOutDir, platform);

  const nodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  if (!fs.existsSync(nodeModules)) return;

  const before = dirSizeSync(nodeModules);

  pruneClaudeAgentSdk(nodeModules, platform, arch);
  pruneNodePty(nodeModules, platform, arch);
  pruneSharpLibvips(nodeModules, platform, arch);
  keepTargetArchOnly(nodeModules, platform, arch);

  const after = dirSizeSync(nodeModules);
  const savedMB = ((before - after) / 1024 / 1024).toFixed(1);
  console.log(`Pruned native modules: ${savedMB} MB removed (${fmtMB(before)} → ${fmtMB(after)})`);
}

function dirSizeSync(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      try {
        total += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size;
      } catch {}
    }
  }
  return total;
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

exports.setUpdaterCacheDirName = setUpdaterCacheDirName;
exports.keepTargetArchOnly = keepTargetArchOnly;
exports.UPDATER_CACHE_DIR_NAME = UPDATER_CACHE_DIR_NAME;

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH_MAP[context.arch] || process.arch;

  pruneNativeModules(context.appOutDir, platform, arch);
  setUpdaterCacheDirName(resourcesDirFor(context.appOutDir, platform));

  if (platform === "linux") {
    installLinuxLauncher(context.appOutDir);
  }

  if (platform === "linux" || platform === "win32") {
    if (arch !== process.arch) {
      console.log(
        `Skipping packaged-app smoke: build arch ${arch} differs from host ${process.arch}.`,
      );
    } else {
      await smokeUnpackedAppIfRequested(context.appOutDir);
    }
  }
};

async function smokeUnpackedAppIfRequested(appOutDir) {
  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  await smokePackagedDesktopApp({
    appPath: appOutDir,
  });
}

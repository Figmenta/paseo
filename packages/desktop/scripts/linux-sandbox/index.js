const fs = require("node:fs");
const path = require("node:path");

// Keep one pre-Chromium entrypoint for AppRun, desktop entries, updates, and tarballs.
exports.installLinuxLauncher = function installLinuxLauncher(appOutDir, executableName) {
  if (typeof executableName !== "string" || executableName.length === 0) {
    throw new Error(
      `installLinuxLauncher: executableName must be a non-empty string, got ${JSON.stringify(executableName)}`,
    );
  }
  const launcher = path.join(appOutDir, executableName);
  if (!fs.existsSync(`${launcher}.bin`)) {
    fs.renameSync(launcher, `${launcher}.bin`);
  }
  fs.copyFileSync(path.join(__dirname, "launcher.sh"), launcher);
  fs.chmodSync(launcher, 0o755);
};

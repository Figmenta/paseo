import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const { installLinuxLauncher } = require("./index.js");

const LAUNCHER_SOURCE = path.join(path.dirname(require.resolve("./index.js")), "launcher.sh");
const ELF_STUB = "\u007fELF original electron binary";

describe("installLinuxLauncher", () => {
  let appOutDir;

  beforeEach(() => {
    appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "linux-launcher-"));
    fs.writeFileSync(path.join(appOutDir, "Orchestra"), ELF_STUB);
  });

  afterEach(() => {
    fs.rmSync(appOutDir, { recursive: true, force: true });
  });

  test("moves the executable to <name>.bin and installs launcher.sh as <name> with mode 755", () => {
    installLinuxLauncher(appOutDir, "Orchestra");

    expect(fs.readFileSync(path.join(appOutDir, "Orchestra.bin"), "utf8")).toBe(ELF_STUB);
    expect(fs.readFileSync(path.join(appOutDir, "Orchestra"), "utf8")).toBe(
      fs.readFileSync(LAUNCHER_SOURCE, "utf8"),
    );
    expect(fs.statSync(path.join(appOutDir, "Orchestra")).mode & 0o777).toBe(0o755);
  });

  test("is idempotent: a second call keeps the original binary in <name>.bin", () => {
    installLinuxLauncher(appOutDir, "Orchestra");
    installLinuxLauncher(appOutDir, "Orchestra");

    expect(fs.readFileSync(path.join(appOutDir, "Orchestra.bin"), "utf8")).toBe(ELF_STUB);
    expect(fs.readFileSync(path.join(appOutDir, "Orchestra"), "utf8")).toBe(
      fs.readFileSync(LAUNCHER_SOURCE, "utf8"),
    );
    expect(fs.statSync(path.join(appOutDir, "Orchestra")).mode & 0o777).toBe(0o755);
  });

  test("throws when the executable name is missing", () => {
    expect(() => installLinuxLauncher(appOutDir)).toThrow(/executableName/);
    expect(() => installLinuxLauncher(appOutDir, "")).toThrow(/executableName/);
    expect(fs.readFileSync(path.join(appOutDir, "Orchestra"), "utf8")).toBe(ELF_STUB);
    expect(fs.existsSync(path.join(appOutDir, "Orchestra.bin"))).toBe(false);
  });
});

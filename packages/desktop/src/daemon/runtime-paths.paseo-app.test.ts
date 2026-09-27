import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Figmenta fork: resolvePaseoAppDaemonRuntime against a fake Paseo.app on disk (real fs).

vi.mock("electron", () => ({ app: { isPackaged: true } }));

const { resolvePaseoAppDaemonRuntime } = await import("./runtime-paths.js");

const describeOnMac = process.platform === "darwin" ? describe : describe.skip;

describeOnMac("resolvePaseoAppDaemonRuntime", () => {
  let root: string;
  let appPath: string;
  let helper: string;
  let runner: string;
  let entry: string;
  let serverPackageJson: string;
  let cli: string;

  function write(file: string, contents: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "paseo-app-runtime-"));
    appPath = path.join(root, "Paseo.app");
    const contents = path.join(appPath, "Contents");
    helper = path.join(
      contents,
      "Frameworks",
      "Paseo Helper.app",
      "Contents",
      "MacOS",
      "Paseo Helper",
    );
    runner = path.join(
      contents,
      "Resources",
      "app.asar.unpacked",
      "dist",
      "daemon",
      "node-entrypoint-runner.js",
    );
    const server = path.join(
      contents,
      "Resources",
      "app.asar",
      "node_modules",
      "@getpaseo",
      "server",
    );
    entry = path.join(server, "dist", "scripts", "supervisor-entrypoint.js");
    serverPackageJson = path.join(server, "package.json");
    cli = path.join(contents, "Resources", "bin", "paseo");
    write(helper, "#!/bin/sh\n");
    chmodSync(helper, 0o755);
    write(runner, "");
    write(entry, "");
    write(serverPackageJson, JSON.stringify({ name: "@getpaseo/server", version: "0.9.2" }));
    write(cli, "#!/bin/sh\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs Paseo.app's server with Paseo's own helper, runner and CLI", () => {
    const runtime = resolvePaseoAppDaemonRuntime(appPath);
    expect(runtime).not.toBeNull();
    expect(runtime?.source).toBe("paseo-app");
    expect(runtime?.version).toBe("0.9.2");
    expect(runtime?.cliPath).toBe(cli);
    const invocation = runtime!.createInvocation({
      argvMode: "node-script",
      args: [],
      baseEnv: {},
    });
    expect(invocation.command).toBe(helper);
    expect(invocation.args).toEqual(["--disable-warning=DEP0040", runner, "node-script", entry]);
    expect(invocation.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("is absent when Paseo.app is not installed", () => {
    expect(resolvePaseoAppDaemonRuntime(path.join(root, "Nope.app"))).toBeNull();
  });

  it("is absent when the helper is missing", () => {
    rmSync(path.dirname(path.dirname(path.dirname(helper))), { recursive: true });
    expect(resolvePaseoAppDaemonRuntime(appPath)).toBeNull();
  });

  it("refuses a server whose version cannot be read", () => {
    writeFileSync(serverPackageJson, "{ not json");
    expect(() => resolvePaseoAppDaemonRuntime(appPath)).toThrow();
    writeFileSync(serverPackageJson, JSON.stringify({ name: "@getpaseo/server" }));
    expect(() => resolvePaseoAppDaemonRuntime(appPath)).toThrow(/No version/);
  });
});

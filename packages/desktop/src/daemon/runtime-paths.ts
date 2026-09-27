import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { app } from "electron";
import {
  createNodeEntrypointInvocation as createSharedNodeEntrypointInvocation,
  type NodeEntrypointArgvMode,
  type NodeEntrypointInvocation,
  type NodeEntrypointSpec,
} from "./node-entrypoint-launcher.js";
import type { DaemonRuntimeCandidate } from "../figmenta/daemon-runtime.js";
import {
  assertPathExists,
  findPackageRootFromResolvedPath,
  resolvePackagedAsarPath,
  type PackageInfo,
} from "./package-paths.js";

const SERVER_PACKAGE_NAME = "@getpaseo/server";

const esmRequire = createRequire(__filename);

function resolveServerPackageInfo(): PackageInfo {
  const serverExportPath = esmRequire.resolve(SERVER_PACKAGE_NAME);
  return findPackageRootFromResolvedPath({
    resolvedPath: serverExportPath,
    packageName: SERVER_PACKAGE_NAME,
  });
}

export function resolvePackagedNodeEntrypointRunnerPath(): string {
  return path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "dist",
    "daemon",
    "node-entrypoint-runner.js",
  );
}

export function resolveDaemonRunnerEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    return {
      entryPath: assertPathExists({
        label: "Bundled daemon runner",
        filePath: path.join(
          resolvePackagedAsarPath(),
          "node_modules",
          "@getpaseo",
          "server",
          "dist",
          "scripts",
          "supervisor-entrypoint.js",
        ),
      }),
      execArgv: [],
    };
  }

  const serverPackage = resolveServerPackageInfo();
  const distRunner = path.join(serverPackage.root, "dist", "scripts", "supervisor-entrypoint.js");
  if (existsSync(distRunner)) {
    return {
      entryPath: distRunner,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "Daemon runner source",
      filePath: path.join(serverPackage.root, "scripts", "supervisor-entrypoint.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

export function resolveNodeExecPath(): string {
  if (app.isPackaged && process.platform === "darwin") {
    const marker = ".app/Contents/MacOS/";
    const markerIndex = process.execPath.indexOf(marker);
    if (markerIndex !== -1) {
      const bundleRoot = process.execPath.substring(0, markerIndex + ".app".length);
      const name = path.basename(process.execPath);
      const helperPath = path.posix.join(
        bundleRoot,
        "Contents",
        "Frameworks",
        `${name} Helper.app`,
        "Contents",
        "MacOS",
        `${name} Helper`,
      );
      if (existsSync(helperPath)) {
        return helperPath;
      }
    }
  }
  return process.execPath;
}

export function createNodeEntrypointInvocation(input: {
  entrypoint: NodeEntrypointSpec;
  argvMode: NodeEntrypointArgvMode;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
}): NodeEntrypointInvocation {
  return createSharedNodeEntrypointInvocation({
    execPath: resolveNodeExecPath(),
    isPackaged: app.isPackaged,
    packagedRunnerPath: app.isPackaged
      ? assertPathExists({
          label: "Bundled node entrypoint runner",
          filePath: resolvePackagedNodeEntrypointRunnerPath(),
        })
      : null,
    entrypoint: input.entrypoint,
    argvMode: input.argvMode,
    args: input.args,
    baseEnv: input.baseEnv,
  });
}

// ---------------------------------------------------------------------------
// Figmenta fork: daemon runtimes Orchestra can launch (see figmenta/daemon-runtime.ts)
// ---------------------------------------------------------------------------

export interface DaemonLaunchRuntime extends DaemonRuntimeCandidate {
  /** Where the runtime lives, for the log. */
  location: string;
  /** Value handed to the daemon as PASEO_CLI: the CLI that ships with that same server. */
  cliPath: string;
  createInvocation(input: {
    argvMode: NodeEntrypointArgvMode;
    args: string[];
    baseEnv: NodeJS.ProcessEnv;
  }): NodeEntrypointInvocation;
}

function readPackageVersion(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.trim().length === 0) {
    throw new Error(`No version in ${packageJsonPath}`);
  }
  return pkg.version.trim();
}

/** The @getpaseo/server this build of Orchestra ships (or runs from, in development). */
export function resolveBundledServerVersion(): string {
  const root = app.isPackaged
    ? path.join(resolvePackagedAsarPath(), "node_modules", "@getpaseo", "server")
    : resolveServerPackageInfo().root;
  return readPackageVersion(path.join(root, "package.json"));
}

export function resolveBundledDaemonRuntime(cliPath: string): DaemonLaunchRuntime {
  return {
    source: "bundled",
    version: resolveBundledServerVersion(),
    location: app.isPackaged ? resolvePackagedAsarPath() : resolveServerPackageInfo().root,
    cliPath,
    createInvocation: (input) =>
      createNodeEntrypointInvocation({ entrypoint: resolveDaemonRunnerEntrypoint(), ...input }),
  };
}

export const PASEO_APP_PATH_DARWIN = "/Applications/Paseo.app";

/**
 * An installed Paseo Desktop (macOS only), launched with ITS OWN Electron helper, runner
 * and server — never our binary on its code. Null when it is not installed or its layout
 * is not the one we know; Windows has no equally reliable install location, so there the
 * bundled server is the only runtime.
 */
export function resolvePaseoAppDaemonRuntime(
  appPath: string = PASEO_APP_PATH_DARWIN,
): DaemonLaunchRuntime | null {
  if (process.platform !== "darwin" || !existsSync(appPath)) return null;
  const resources = path.join(appPath, "Contents", "Resources");
  const asar = path.join(resources, "app.asar");
  const serverRoot = path.join(asar, "node_modules", "@getpaseo", "server");
  const helperPath = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Paseo Helper.app",
    "Contents",
    "MacOS",
    "Paseo Helper",
  );
  const runnerPath = path.join(
    resources,
    "app.asar.unpacked",
    "dist",
    "daemon",
    "node-entrypoint-runner.js",
  );
  const entryPath = path.join(serverRoot, "dist", "scripts", "supervisor-entrypoint.js");
  const cliPath = path.join(resources, "bin", "paseo");
  for (const required of [helperPath, runnerPath, entryPath, cliPath]) {
    if (!existsSync(required)) return null;
  }
  const version = readPackageVersion(path.join(serverRoot, "package.json"));
  return {
    source: "paseo-app",
    version,
    location: appPath,
    cliPath,
    createInvocation: (input) =>
      createSharedNodeEntrypointInvocation({
        execPath: helperPath,
        isPackaged: true,
        packagedRunnerPath: runnerPath,
        entrypoint: { entryPath, execArgv: [] },
        ...input,
      }),
  };
}

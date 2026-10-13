import { describe, expect, it } from "vitest";

import {
  corsAllowsOrchestra,
  DEFAULT_ORCHESTRA_URL,
  isAllowedNavigation,
  isOrchestraOrigin,
  permissionPolicy,
  resolveOrchestraUrl,
  pluginIsRunning,
  shouldRestartDaemonForVersion,
  titleBarInset,
  seedPaseoConfig,
  seedPaseoConfigText,
  seedPaseoConfigWithReport,
  stalePluginEntry,
  loadedPluginPath,
  loadedPluginIsOutdated,
  classifyDaemonOwner,
  daemonSeedWarningText,
  isOrchestraExecutable,
  parseProcessExecutable,
  planDaemonSeedAction,
  type PluginVersionProbe,
  type SeedOptions,
} from "./orchestra.js";

const PLUGIN_PATH = "/Applications/Orchestra.app/Contents/Resources/plugins/figmenta-sessions";

describe("resolveOrchestraUrl", () => {
  it("defaults to the production Orchestra", () => {
    expect(resolveOrchestraUrl({})).toBe(DEFAULT_ORCHESTRA_URL);
  });

  it("honours the ORCHESTRA_URL override and drops the trailing slash", () => {
    expect(resolveOrchestraUrl({ ORCHESTRA_URL: "http://localhost:3000/" })).toBe(
      "http://localhost:3000",
    );
  });

  it("falls back when the override is not a URL", () => {
    expect(resolveOrchestraUrl({ ORCHESTRA_URL: "not a url" })).toBe(DEFAULT_ORCHESTRA_URL);
  });
});

describe("isOrchestraOrigin", () => {
  it("accepts the Orchestra origin, any path", () => {
    expect(isOrchestraOrigin("https://orchestra.figmenta.site/login?x=1")).toBe(true);
  });

  it("rejects other hosts, plain http and garbage", () => {
    expect(isOrchestraOrigin("https://dms.figmenta.site/")).toBe(false);
    expect(isOrchestraOrigin("http://orchestra.figmenta.site/")).toBe(false);
    expect(isOrchestraOrigin("https://orchestra.figmenta.site.evil.com/")).toBe(false);
    expect(isOrchestraOrigin("javascript:alert(1)")).toBe(false);
  });
});

describe("isAllowedNavigation", () => {
  it("allows the Orchestra origin, login included", () => {
    expect(isAllowedNavigation("https://orchestra.figmenta.site/login")).toBe(true);
    expect(isAllowedNavigation("https://orchestra.figmenta.site/api/auth/callback?code=1")).toBe(
      true,
    );
  });

  it("refuses every other host, siblings included", () => {
    expect(isAllowedNavigation("https://auth.figmenta.site/authorize")).toBe(false);
    expect(isAllowedNavigation("https://figmenta.site/")).toBe(false);
    expect(isAllowedNavigation("https://accounts.google.com/o/oauth2")).toBe(false);
    expect(isAllowedNavigation("http://orchestra.figmenta.site/")).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd")).toBe(false);
  });
});

describe("shouldRestartDaemonForVersion", () => {
  const base = { spawnedByThisApp: true, desktopManaged: true, expectedVersion: "0.8.0" };

  it("restarts our own daemon when the versions differ", () => {
    expect(shouldRestartDaemonForVersion({ ...base, daemonVersion: "v0.7.9" })).toBe(true);
  });

  it("never restarts a daemon this app did not spawn", () => {
    expect(
      shouldRestartDaemonForVersion({ ...base, spawnedByThisApp: false, daemonVersion: "0.7.9" }),
    ).toBe(false);
  });

  it("leaves a matching or unknown version alone", () => {
    expect(shouldRestartDaemonForVersion({ ...base, daemonVersion: "0.8.0" })).toBe(false);
    expect(shouldRestartDaemonForVersion({ ...base, daemonVersion: null })).toBe(false);
    expect(
      shouldRestartDaemonForVersion({ ...base, desktopManaged: false, daemonVersion: "0.7.9" }),
    ).toBe(false);
  });
});

describe("permissionPolicy", () => {
  it("grants the short list to Orchestra", () => {
    for (const permission of ["media", "notifications", "clipboard-read", "localNetworkAccess"]) {
      expect(permissionPolicy("https://orchestra.figmenta.site", permission)).toBe(true);
    }
  });

  it("denies anything else, and denies everything to other origins", () => {
    expect(permissionPolicy("https://orchestra.figmenta.site", "geolocation")).toBe(false);
    expect(permissionPolicy("https://orchestra.figmenta.site", "openExternal")).toBe(false);
    expect(permissionPolicy("https://evil.example", "media")).toBe(false);
  });
});

describe("seedPaseoConfig", () => {
  it("seeds an empty config", () => {
    expect(seedPaseoConfig({}, { pluginPath: PLUGIN_PATH })).toEqual({
      pluginsEnabled: true,
      plugins: {
        "figmenta-sessions": { source: "directory", path: PLUGIN_PATH, enabled: true },
      },
      daemon: { cors: { allowedOrigins: ["https://orchestra.figmenta.site"] } },
    });
  });

  it("is idempotent", () => {
    const once = seedPaseoConfig({}, { pluginPath: PLUGIN_PATH });
    const twice = seedPaseoConfig(once, { pluginPath: PLUGIN_PATH });
    expect(twice).toEqual(once);
  });

  it("leaves an existing plugin entry alone when it cannot compare versions", () => {
    const seeded = seedPaseoConfig(
      {
        plugins: {
          "figmenta-sessions": { source: "directory", path: "/work/plugin", enabled: false },
        },
      },
      { pluginPath: PLUGIN_PATH },
    );
    expect(seeded.plugins).toEqual({
      "figmenta-sessions": { source: "directory", path: "/work/plugin", enabled: false },
    });
  });

  it("appends the origin and keeps the ones already configured", () => {
    const seeded = seedPaseoConfig(
      { daemon: { cors: { allowedOrigins: ["https://app.paseo.sh"] }, hostnames: ["localhost"] } },
      { pluginPath: PLUGIN_PATH },
    );
    expect((seeded.daemon as Record<string, unknown>).cors).toEqual({
      allowedOrigins: ["https://app.paseo.sh", "https://orchestra.figmenta.site"],
    });
    expect((seeded.daemon as Record<string, unknown>).hostnames).toEqual(["localhost"]);
  });

  it("leaves unrelated keys untouched", () => {
    const seeded = seedPaseoConfig(
      { providers: { anthropic: { apiKey: "x" } }, worktrees: { root: "/w" } },
      { pluginPath: PLUGIN_PATH },
    );
    expect(seeded.providers).toEqual({ anthropic: { apiKey: "x" } });
    expect(seeded.worktrees).toEqual({ root: "/w" });
  });

  it("treats other plugins as siblings", () => {
    const seeded = seedPaseoConfig(
      { plugins: { other: { source: "directory", path: "/o", enabled: true } } },
      { pluginPath: PLUGIN_PATH },
    );
    expect(Object.keys(seeded.plugins as Record<string, unknown>).sort()).toEqual([
      "figmenta-sessions",
      "other",
    ]);
  });
});

// 2026-10-13: a ~/.paseo/config.json written by Desktop 0.8.1 pointed figmenta-sessions at
// an old copy of the plugin (0.3.0). Seeding added the entry only when absent, so every
// later Orchestra kept loading 0.3.0, which never asks for the seat token: Claude Code ran
// "Not logged in". These cases pin the repointing rule.
describe("seedPaseoConfig: stale plugin entries", () => {
  const BUNDLED_VERSION = "0.11.0";
  const OLD_PATH =
    "/Volumes/Orchestra 0.8.1/Orchestra.app/Contents/Resources/plugins/figmenta-sessions";
  const DEV_PATH = "/work/figmenta-plugin";

  function options(disk: Record<string, PluginVersionProbe>): SeedOptions {
    return {
      pluginPath: PLUGIN_PATH,
      bundledPluginVersion: BUNDLED_VERSION,
      probePluginVersion: (pluginPath) =>
        disk[pluginPath] ?? { status: "missing", reason: `${pluginPath}: ENOENT` },
    };
  }

  function withEntry(entry: Record<string, unknown>) {
    return { plugins: { "figmenta-sessions": entry }, providers: { claude: { x: 1 } } };
  }

  const BUNDLED_ENTRY = { source: "directory", path: PLUGIN_PATH, enabled: true };

  it("adds the bundled entry when there is none", () => {
    const report = seedPaseoConfigWithReport({}, options({}));
    expect((report.config.plugins as Record<string, unknown>)["figmenta-sessions"]).toEqual(
      BUNDLED_ENTRY,
    );
    expect(report.repointed).toBeNull();
  });

  it("repoints an entry whose directory no longer exists", () => {
    const report = seedPaseoConfigWithReport(
      withEntry({ source: "directory", path: OLD_PATH, enabled: true }),
      options({}),
    );
    expect((report.config.plugins as Record<string, unknown>)["figmenta-sessions"]).toEqual(
      BUNDLED_ENTRY,
    );
    expect(report.repointed).toMatchObject({
      reason: "missing",
      fromPath: OLD_PATH,
      fromVersion: null,
      toPath: PLUGIN_PATH,
      toVersion: BUNDLED_VERSION,
    });
    expect(report.config.providers).toEqual({ claude: { x: 1 } });
  });

  it("repoints an entry at an older plugin (0.3.0), and enables it", () => {
    const report = seedPaseoConfigWithReport(
      withEntry({ source: "directory", path: OLD_PATH, enabled: false }),
      options({ [OLD_PATH]: { status: "ok", version: "0.3.0" } }),
    );
    expect((report.config.plugins as Record<string, unknown>)["figmenta-sessions"]).toEqual(
      BUNDLED_ENTRY,
    );
    expect(report.repointed).toMatchObject({
      reason: "older",
      fromPath: OLD_PATH,
      fromVersion: "0.3.0",
      fromEnabled: false,
      toVersion: BUNDLED_VERSION,
    });
  });

  it("never touches an entry at an equal or newer plugin (a developer's working copy)", () => {
    for (const version of ["0.11.0", "0.12.0-dev.1", "1.0.0"]) {
      const entry = { source: "directory", path: DEV_PATH, enabled: false };
      const report = seedPaseoConfigWithReport(
        withEntry(entry),
        options({ [DEV_PATH]: { status: "ok", version } }),
      );
      expect(
        (report.config.plugins as Record<string, unknown>)["figmenta-sessions"],
        version,
      ).toEqual(entry);
      expect(report.repointed, version).toBeNull();
    }
  });

  it("does not repoint without a readable bundled version", () => {
    for (const bundledPluginVersion of [null, "", "not-semver"]) {
      const entry = { source: "directory", path: OLD_PATH, enabled: true };
      const report = seedPaseoConfigWithReport(withEntry(entry), {
        ...options({ [OLD_PATH]: { status: "ok", version: "0.3.0" } }),
        bundledPluginVersion,
      });
      expect((report.config.plugins as Record<string, unknown>)["figmenta-sessions"]).toEqual(
        entry,
      );
    }
  });

  it("is idempotent once repointed", () => {
    const opts = options({
      [OLD_PATH]: { status: "ok", version: "0.3.0" },
      [PLUGIN_PATH]: { status: "ok", version: BUNDLED_VERSION },
    });
    const once = seedPaseoConfigWithReport(
      withEntry({ source: "directory", path: OLD_PATH, enabled: true }),
      opts,
    );
    const twice = seedPaseoConfigWithReport(once.config, opts);
    expect(twice.config).toEqual(once.config);
    expect(twice.repointed).toBeNull();
  });

  it("leaves a corrupt config.json untouched, whatever the plugin on disk", () => {
    const result = seedPaseoConfigText(
      '{ "plugins": { "figmenta-sessions": { "path": "/old" ',
      options({ "/old": { status: "ok", version: "0.3.0" } }),
    );
    expect(result.status).toBe("corrupt");
  });

  it("reports the repoint through the text wrapper and writes the bundled path", () => {
    const result = seedPaseoConfigText(
      JSON.stringify(withEntry({ source: "directory", path: OLD_PATH, enabled: true })),
      options({ [OLD_PATH]: { status: "ok", version: "0.3.0" } }),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(JSON.parse(result.text).plugins["figmenta-sessions"].path).toBe(PLUGIN_PATH);
    expect(result.repointed?.fromVersion).toBe("0.3.0");
  });
});

describe("stalePluginEntry", () => {
  const probe =
    (version: string): ((p: string) => PluginVersionProbe) =>
    () => ({
      status: "ok",
      version,
    });

  it("treats an entry without a path as missing", () => {
    expect(
      stalePluginEntry(
        { source: "directory" },
        {
          bundledPath: PLUGIN_PATH,
          bundledVersion: "0.11.0",
          probe: probe("0.3.0"),
        },
      )?.reason,
    ).toBe("missing");
  });

  it("leaves an entry already at the bundled path alone", () => {
    expect(
      stalePluginEntry(
        { source: "directory", path: PLUGIN_PATH },
        {
          bundledPath: PLUGIN_PATH,
          bundledVersion: "0.11.0",
          probe: probe("0.3.0"),
        },
      ),
    ).toBeNull();
  });

  it("leaves a non-semver version alone", () => {
    expect(
      stalePluginEntry(
        { source: "directory", path: "/x" },
        {
          bundledPath: PLUGIN_PATH,
          bundledVersion: "0.11.0",
          probe: probe("main"),
        },
      ),
    ).toBeNull();
  });
});

describe("loadedPluginPath / loadedPluginIsOutdated", () => {
  it("reads the path the daemon reports for our plugin", () => {
    const list = [
      { id: "other", path: "/o", status: "running" },
      { id: "figmenta-sessions", path: "/old/figmenta-sessions", status: "running" },
    ];
    expect(loadedPluginPath(list)).toBe("/old/figmenta-sessions");
    expect(loadedPluginPath({ data: list })).toBe("/old/figmenta-sessions");
    expect(loadedPluginPath([{ id: "other", path: "/o" }])).toBeNull();
    expect(loadedPluginPath(null)).toBeNull();
  });

  it("is outdated below the bundled version, or when the loaded copy cannot be read", () => {
    expect(loadedPluginIsOutdated("0.3.0", "0.11.0")).toBe(true);
    expect(loadedPluginIsOutdated(null, "0.11.0")).toBe(true);
    expect(loadedPluginIsOutdated("0.11.0", "0.11.0")).toBe(false);
    expect(loadedPluginIsOutdated("0.12.0", "0.11.0")).toBe(false);
    expect(loadedPluginIsOutdated("0.3.0", null)).toBe(false);
  });
});

describe("classifyDaemonOwner", () => {
  const lock = { pid: 4242, startedAt: "2026-10-13T08:00:00.000Z", desktopManaged: true };
  const ORCHESTRA_EXE =
    "/Users/x/Downloads/Orchestra.app/Contents/Frameworks/Orchestra Helper.app/Contents/MacOS/Orchestra Helper";
  const PASEO_EXE =
    "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";

  it("this app's own launch wins", () => {
    expect(
      classifyDaemonOwner({ spawnedByThisApp: true, lock: null, marker: null, executable: null }),
    ).toBe("this-app");
  });

  it("an Orchestra launch is recognised by the marker or by an Orchestra executable", () => {
    expect(
      classifyDaemonOwner({
        spawnedByThisApp: false,
        lock,
        marker: { pid: lock.pid, startedAt: lock.startedAt },
        executable: PASEO_EXE,
      }),
    ).toBe("orchestra");
    expect(
      classifyDaemonOwner({
        spawnedByThisApp: false,
        lock,
        marker: null,
        executable: ORCHESTRA_EXE,
      }),
    ).toBe("orchestra");
  });

  it("a Paseo.app daemon, a hand-started one, or a stale marker is foreign", () => {
    expect(
      classifyDaemonOwner({ spawnedByThisApp: false, lock, marker: null, executable: PASEO_EXE }),
    ).toBe("foreign");
    expect(
      classifyDaemonOwner({
        spawnedByThisApp: false,
        lock,
        marker: { pid: lock.pid, startedAt: "2026-10-12T08:00:00.000Z" },
        executable: PASEO_EXE,
      }),
    ).toBe("foreign");
    expect(
      classifyDaemonOwner({
        spawnedByThisApp: false,
        lock: { ...lock, desktopManaged: false },
        marker: { pid: lock.pid, startedAt: lock.startedAt },
        executable: ORCHESTRA_EXE,
      }),
    ).toBe("foreign");
    expect(
      classifyDaemonOwner({ spawnedByThisApp: false, lock: null, marker: null, executable: null }),
    ).toBe("foreign");
  });
});

// 2026-10-13 review: the supervisor sets process.title = "Paseo Supervisor", so `ps -o
// command=` shows the title and never the Orchestra bundle. The owner is read from the
// executable image; these pin the parsers of each platform's probe and the path rule.
describe("parseProcessExecutable / isOrchestraExecutable", () => {
  it("takes the first name field of lsof -Fn (macOS)", () => {
    const out =
      "p81466\nftxt\nn/Applications/Orchestra.app/Contents/Frameworks/Orchestra Helper.app/Contents/MacOS/Orchestra Helper\nftxt\nn/Applications/Orchestra.app/Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel\n";
    expect(parseProcessExecutable("lsof", out)).toBe(
      "/Applications/Orchestra.app/Contents/Frameworks/Orchestra Helper.app/Contents/MacOS/Orchestra Helper",
    );
    expect(parseProcessExecutable("lsof", "p1\nftxt\n")).toBeNull();
    expect(parseProcessExecutable("lsof", null)).toBeNull();
  });

  it("reads /proc/<pid>/exe, ps -o ucomm= and PowerShell's Path as they are", () => {
    expect(parseProcessExecutable("proc", "/opt/Orchestra/orchestra")).toBe(
      "/opt/Orchestra/orchestra",
    );
    expect(parseProcessExecutable("proc", "Orchestra Helper\n")).toBe("Orchestra Helper");
    expect(
      parseProcessExecutable(
        "powershell",
        "\r\nC:\\Users\\x\\AppData\\Local\\Programs\\Orchestra\\Orchestra.exe\r\n",
      ),
    ).toBe("C:\\Users\\x\\AppData\\Local\\Programs\\Orchestra\\Orchestra.exe");
    expect(parseProcessExecutable("powershell", "  \r\n")).toBeNull();
  });

  it("recognises every Orchestra install, and nothing inside Paseo", () => {
    for (const exe of [
      "/Applications/Orchestra.app/Contents/Frameworks/Orchestra Helper.app/Contents/MacOS/Orchestra Helper",
      "/Users/x/Downloads/Orchestra 2.app/Contents/MacOS/Orchestra",
      "C:\\Users\\x\\AppData\\Local\\Programs\\Orchestra\\Orchestra.exe",
      "D:\\Apps\\Orchestra.exe",
      "/opt/Orchestra/orchestra",
      "/usr/bin/orchestra",
      "Orchestra Helper",
      "Orchestra",
    ]) {
      expect(isOrchestraExecutable(exe), exe).toBe(true);
    }
    for (const exe of [
      "Paseo Supervisor",
      "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
      "C:\\Users\\x\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
      "/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      "/usr/local/bin/node",
      null,
    ]) {
      expect(isOrchestraExecutable(exe), String(exe)).toBe(false);
    }
  });
});

describe("daemonSeedWarningText", () => {
  const base = { loadedVersion: "0.3.0", bundledVersion: "0.11.0" };

  it("offers a restart for any daemon an Orchestra launched, never for a foreign one", () => {
    for (const owner of ["this-app", "orchestra"] as const) {
      const text = daemonSeedWarningText({ ...base, kind: "plugin-outdated", owner });
      expect(text.canRestart, owner).toBe(true);
      expect(text.message).toBe("The engine is running an older Orchestra plugin");
      expect(text.detail).toContain("Restarting it takes a few seconds.");
      expect(text.detail).not.toContain("outside Orchestra");
    }
    const foreign = daemonSeedWarningText({ ...base, kind: "plugin-outdated", owner: "foreign" });
    expect(foreign.canRestart).toBe(false);
    expect(foreign.detail).toContain("started outside Orchestra");
    expect(foreign.detail).toContain("v0.3.0");
    expect(daemonSeedWarningText({ ...base, kind: "seed", owner: "orchestra" }).canRestart).toBe(
      true,
    );
  });
});

describe("planDaemonSeedAction", () => {
  const healthy = { corsOk: true, pluginRunning: true, pluginOutdated: false };

  it("is ok when the daemon runs the seed with a current plugin", () => {
    expect(planDaemonSeedAction({ ...healthy, owner: "foreign", alreadyRestarted: false })).toBe(
      "ok",
    );
  });

  it("restarts an outdated plugin on an Orchestra daemon, once", () => {
    for (const owner of ["this-app", "orchestra"] as const) {
      expect(
        planDaemonSeedAction({ ...healthy, pluginOutdated: true, owner, alreadyRestarted: false }),
      ).toBe("restart");
      expect(
        planDaemonSeedAction({ ...healthy, pluginOutdated: true, owner, alreadyRestarted: true }),
      ).toBe("warn");
    }
  });

  it("never restarts a foreign daemon, and warns on other failures", () => {
    expect(
      planDaemonSeedAction({
        ...healthy,
        pluginOutdated: true,
        owner: "foreign",
        alreadyRestarted: false,
      }),
    ).toBe("warn");
    expect(
      planDaemonSeedAction({
        ...healthy,
        corsOk: false,
        owner: "this-app",
        alreadyRestarted: false,
      }),
    ).toBe("warn");
  });
});

describe("seedPaseoConfigText", () => {
  it("round-trips through JSON text", () => {
    const result = seedPaseoConfigText('{"pluginsEnabled": false}', { pluginPath: PLUGIN_PATH });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(JSON.parse(result.text).pluginsEnabled).toBe(true);
    expect(result.text.endsWith("\n")).toBe(true);
  });

  it("seeds an empty file from scratch", () => {
    for (const input of ["", "   "]) {
      const result = seedPaseoConfigText(input, { pluginPath: PLUGIN_PATH });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      expect(JSON.parse(result.text).pluginsEnabled).toBe(true);
    }
  });

  it("refuses to rewrite a file it cannot parse", () => {
    for (const input of ["{ not json", "[1,2,3]", "null", '"a string"']) {
      const result = seedPaseoConfigText(input, { pluginPath: PLUGIN_PATH });
      expect(result.status, input).toBe("corrupt");
    }
  });
});

describe("titleBarInset", () => {
  it("reserves the traffic-light strip on macOS only", () => {
    expect(titleBarInset("darwin")).toBe(28);
    expect(titleBarInset("win32")).toBe(0);
    expect(titleBarInset("linux")).toBe(0);
  });
});

describe("corsAllowsOrchestra", () => {
  it("accepts the exact origin or a wildcard", () => {
    expect(corsAllowsOrchestra("https://orchestra.figmenta.site")).toBe(true);
    expect(corsAllowsOrchestra("*")).toBe(true);
  });

  it("rejects a missing, empty or foreign value", () => {
    expect(corsAllowsOrchestra(null)).toBe(false);
    expect(corsAllowsOrchestra("")).toBe(false);
    expect(corsAllowsOrchestra("https://app.paseo.sh")).toBe(false);
  });
});

describe("pluginIsRunning", () => {
  const running = [{ id: "figmenta-sessions", status: "running" }];

  it("sees the plugin in a bare list or a { data } envelope", () => {
    expect(pluginIsRunning(running)).toBe(true);
    expect(pluginIsRunning({ data: running })).toBe(true);
  });

  it("is false when the plugin is absent, disabled or failed", () => {
    expect(pluginIsRunning([])).toBe(false);
    expect(pluginIsRunning([{ id: "figmenta-sessions", status: "failed" }])).toBe(false);
    expect(pluginIsRunning([{ id: "figmenta-sessions", status: "disabled" }])).toBe(false);
    expect(pluginIsRunning([{ id: "other", status: "running" }])).toBe(false);
    expect(pluginIsRunning(null)).toBe(false);
  });
});

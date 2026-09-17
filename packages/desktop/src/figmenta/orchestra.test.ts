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
  const base = { spawnedByThisApp: true, desktopManaged: true, appVersion: "0.8.0" };

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

  it("never overwrites an existing plugin entry", () => {
    const seeded = seedPaseoConfig(
      { plugins: { "figmenta-sessions": { source: "directory", path: "/work/plugin", enabled: false } } },
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

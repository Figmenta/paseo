import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORCHESTRA_URL,
  isAllowedNavigation,
  isOrchestraOrigin,
  permissionPolicy,
  resolveOrchestraUrl,
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
  it("allows Orchestra and https figmenta.site siblings", () => {
    expect(isAllowedNavigation("https://orchestra.figmenta.site/login")).toBe(true);
    expect(isAllowedNavigation("https://auth.figmenta.site/authorize")).toBe(true);
    expect(isAllowedNavigation("https://figmenta.site/")).toBe(true);
  });

  it("refuses everything else", () => {
    expect(isAllowedNavigation("https://accounts.google.com/o/oauth2")).toBe(false);
    expect(isAllowedNavigation("http://auth.figmenta.site/")).toBe(false);
    expect(isAllowedNavigation("https://evil-figmenta.site/")).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd")).toBe(false);
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
    const text = seedPaseoConfigText('{"pluginsEnabled": false}', { pluginPath: PLUGIN_PATH });
    expect(JSON.parse(text).pluginsEnabled).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("recovers from an empty or corrupt file", () => {
    for (const input of ["", "   ", "{ not json"]) {
      const parsed = JSON.parse(seedPaseoConfigText(input, { pluginPath: PLUGIN_PATH })) as Record<
        string,
        unknown
      >;
      expect(parsed.pluginsEnabled).toBe(true);
    }
  });
});

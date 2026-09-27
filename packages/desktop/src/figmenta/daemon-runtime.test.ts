import { describe, expect, it } from "vitest";
import {
  compareVersions,
  pickDaemonRuntime,
  type DaemonRuntimeCandidate,
} from "./daemon-runtime.js";

const bundled = (version: string): DaemonRuntimeCandidate => ({ source: "bundled", version });
const paseoApp = (version: string): DaemonRuntimeCandidate => ({ source: "paseo-app", version });

describe("compareVersions", () => {
  it("orders by major, minor, patch — numerically, not as strings", () => {
    expect(compareVersions("0.9.2", "0.8.0")).toBe(1);
    expect(compareVersions("0.8.0", "0.9.2")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.9.10", "0.9.9")).toBe(1);
    expect(compareVersions("v0.9.2", "0.9.2")).toBe(0);
  });

  it("ranks a release above its own prereleases, prereleases among themselves", () => {
    expect(compareVersions("0.9.3", "0.9.3-beta.2")).toBe(1);
    expect(compareVersions("0.9.3-beta.2", "0.9.3")).toBe(-1);
    expect(compareVersions("0.9.3-beta.10", "0.9.3-beta.2")).toBe(1);
    expect(compareVersions("0.9.3-beta.1", "0.9.2")).toBe(1);
    expect(compareVersions("0.9.3-beta", "0.9.3-beta.1")).toBe(-1);
  });

  it("refuses to compare what is not semver", () => {
    expect(compareVersions("", "0.9.2")).toBeNull();
    expect(compareVersions("0.9", "0.9.2")).toBeNull();
    expect(compareVersions("latest", "0.9.2")).toBeNull();
  });
});

describe("pickDaemonRuntime", () => {
  it("starts Paseo.app's server when it is newer than the bundled one (the 2026-09-27 case)", () => {
    expect(pickDaemonRuntime(bundled("0.8.0"), [paseoApp("0.9.2")]).source).toBe("paseo-app");
  });

  it("keeps the bundled server when Paseo.app is older", () => {
    expect(pickDaemonRuntime(bundled("0.9.2"), [paseoApp("0.8.0")]).source).toBe("bundled");
  });

  it("keeps the bundled server on a tie", () => {
    expect(pickDaemonRuntime(bundled("0.9.2"), [paseoApp("0.9.2")]).source).toBe("bundled");
  });

  it("keeps the bundled server when Paseo.app is not installed", () => {
    expect(pickDaemonRuntime(bundled("0.9.2"), []).source).toBe("bundled");
  });

  it("ignores a candidate whose version cannot be read", () => {
    expect(pickDaemonRuntime(bundled("0.9.2"), [paseoApp("unknown")]).source).toBe("bundled");
  });

  it("prefers a newer release over a prerelease of the same core", () => {
    expect(pickDaemonRuntime(bundled("0.9.3-beta.1"), [paseoApp("0.9.3")]).source).toBe(
      "paseo-app",
    );
  });
});

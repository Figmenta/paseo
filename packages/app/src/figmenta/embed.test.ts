// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  readEmbedTheme,
  reduceComposerInsert,
  resetEmbedModeCache,
  shouldBlockEmbedRoute,
} from "./embed";

function setLocation(search: string): void {
  window.history.replaceState({}, "", `/agents-ui/${search}`);
}

describe("readEmbedTheme", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetEmbedModeCache();
    setLocation("");
  });

  it("reads the theme from the query string", () => {
    setLocation("?embed=1&theme=dark");
    expect(readEmbedTheme()).toBe("dark");
  });

  it("latches the theme so a rewritten URL keeps it", () => {
    setLocation("?embed=1&theme=light");
    expect(readEmbedTheme()).toBe("light");
    resetEmbedModeCache();
    setLocation("h/abc/agent/def");
    expect(readEmbedTheme()).toBe("light");
  });

  it("is null when Orchestra imposed nothing", () => {
    setLocation("?embed=1");
    expect(readEmbedTheme()).toBeNull();
  });

  it("ignores a theme it does not know", () => {
    setLocation("?embed=1&theme=solarized");
    expect(readEmbedTheme()).toBeNull();
  });
});

describe("reduceComposerInsert", () => {
  it("inserts into an empty draft verbatim", () => {
    expect(reduceComposerInsert("", "/maestro ")).toBe("/maestro ");
  });

  it("appends with exactly one separating space", () => {
    expect(reduceComposerInsert("ciao", "/maestro")).toBe("ciao /maestro");
    expect(reduceComposerInsert("ciao   ", "/maestro")).toBe("ciao /maestro");
    expect(reduceComposerInsert("ciao\n", "/maestro")).toBe("ciao /maestro");
  });

  it("keeps leading whitespace of the existing draft", () => {
    expect(reduceComposerInsert("  ciao", "x")).toBe("  ciao x");
  });
});

describe("shouldBlockEmbedRoute", () => {
  it("blocks the settings tree", () => {
    expect(shouldBlockEmbedRoute("/settings")).toBe(true);
    expect(shouldBlockEmbedRoute("/settings/hosts/x")).toBe(true);
  });

  it("blocks per-host settings", () => {
    expect(shouldBlockEmbedRoute("/h/x/settings")).toBe(true);
    expect(shouldBlockEmbedRoute("/h/x/settings/agents")).toBe(true);
  });

  it("lets the conversation through", () => {
    expect(shouldBlockEmbedRoute("/h/x/agent/y")).toBe(false);
    expect(shouldBlockEmbedRoute("/")).toBe(false);
    expect(shouldBlockEmbedRoute("/h/x")).toBe(false);
  });

  it("ignores query and hash", () => {
    expect(shouldBlockEmbedRoute("/settings?tab=hosts")).toBe(true);
    expect(shouldBlockEmbedRoute("/h/x/agent/y?embed=1")).toBe(false);
  });
});

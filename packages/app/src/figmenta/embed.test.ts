// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  installEmbedBridge,
  lastAgentRoute,
  readEmbedTheme,
  reduceComposerInsert,
  rememberAgentRoute,
  resetEmbedModeCache,
  shouldBlockEmbedRoute,
  subscribeToEmbedComposerInsert,
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

describe("maestro.composer.insert routing", () => {
  const unsubscribes: Array<() => void> = [];

  beforeEach(() => {
    window.sessionStorage.clear();
    setLocation("?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    while (unsubscribes.length) unsubscribes.pop()?.();
  });

  /** Mirrors the guard in `useAgentInputDraft`: a composer keeps its own agent only. */
  function composerFor(agentId: string, applied: string[]): void {
    unsubscribes.push(
      subscribeToEmbedComposerInsert((insert) => {
        if (insert.agentId !== agentId) return;
        applied.push(insert.text);
      }),
    );
  }

  function post(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  }

  it("applies the insert in the composer of that agent only", () => {
    const first: string[] = [];
    const second: string[] = [];
    composerFor("a1", first);
    composerFor("a2", second);

    post({ type: "maestro.composer.insert", text: "/maestro", agentId: "a1" });

    expect(first).toEqual(["/maestro"]);
    expect(second).toEqual([]);
  });

  it("drops a message without a usable agentId", () => {
    const first: string[] = [];
    const second: string[] = [];
    composerFor("a1", first);
    composerFor("a2", second);

    post({ type: "maestro.composer.insert", text: "/maestro" });
    post({ type: "maestro.composer.insert", text: "/maestro", agentId: "" });
    post({ type: "maestro.composer.insert", text: "/maestro", agentId: 7 });

    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });
});

describe("rememberAgentRoute / lastAgentRoute", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("remembers an agent route and hands it back", () => {
    rememberAgentRoute("/h/srv1/agent/ag1");
    expect(lastAgentRoute()).toBe("/h/srv1/agent/ag1");
  });

  it("drops the query string and the hash", () => {
    rememberAgentRoute("/h/srv1/agent/ag1?embed=1#top");
    expect(lastAgentRoute()).toBe("/h/srv1/agent/ag1");
  });

  it("ignores everything that is not an agent route", () => {
    for (const pathname of [
      "/",
      "/settings",
      "/settings/models",
      "/h/srv1/settings",
      "/h/srv1/agent",
      "/h/srv1/agent/ag1/files",
      "",
    ]) {
      rememberAgentRoute(pathname);
      expect(lastAgentRoute()).toBeNull();
    }
  });

  it("keeps the last agent route seen", () => {
    rememberAgentRoute("/h/srv1/agent/ag1");
    rememberAgentRoute("/h/srv2/agent/ag2");
    rememberAgentRoute("/settings");
    expect(lastAgentRoute()).toBe("/h/srv2/agent/ag2");
  });

  it("returns null when nothing was remembered", () => {
    expect(lastAgentRoute()).toBeNull();
  });
});

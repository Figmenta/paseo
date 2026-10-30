// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbedFileClick,
  DEFAULT_COMPOSER_LOCK_LABEL,
  EMBED_MODELS_ALLOW_DEFAULT_ID,
  EMBED_READY_TYPE,
  installEmbedBridge,
  lastAgentRoute,
  readEmbedComposerLock,
  readEmbedModelsAllow,
  readEmbedTheme,
  reduceComposerInsert,
  rememberAgentRoute,
  resetEmbedModeCache,
  shouldBlockEmbedRoute,
  subscribeToEmbedComposerInsert,
  subscribeToEmbedComposerLock,
  subscribeToEmbedModelsAllow,
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

describe("maestro.composer.lock routing", () => {
  const unsubscribes: Array<() => void> = [];

  beforeEach(() => {
    window.sessionStorage.clear();
    setLocation("?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    while (unsubscribes.length) unsubscribes.pop()?.();
  });

  function post(data: unknown, origin = window.location.origin): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin }));
  }

  it("locks the agent it names and no other", () => {
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Not available" });

    expect(readEmbedComposerLock("a1")).toBe("Not available");
    expect(readEmbedComposerLock("a2")).toBeNull();
  });

  it("unlocks with locked:false, leaving the other agents locked", () => {
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Session expired" });
    post({ type: "maestro.composer.lock", agentId: "a2", locked: true, label: "Not available" });

    post({ type: "maestro.composer.lock", agentId: "a1", locked: false });

    expect(readEmbedComposerLock("a1")).toBeNull();
    expect(readEmbedComposerLock("a2")).toBe("Not available");
  });

  it("falls back to «Session expired» when the label is null, absent or blank", () => {
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: null });
    post({ type: "maestro.composer.lock", agentId: "a2", locked: true });
    post({ type: "maestro.composer.lock", agentId: "a3", locked: true, label: "  " });

    expect(DEFAULT_COMPOSER_LOCK_LABEL).toBe("Session expired");
    expect(readEmbedComposerLock("a1")).toBe("Session expired");
    expect(readEmbedComposerLock("a2")).toBe("Session expired");
    expect(readEmbedComposerLock("a3")).toBe("Session expired");
  });

  it("takes the latest label for an agent already locked", () => {
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Session expired" });
    post({
      type: "maestro.composer.lock",
      agentId: "a1",
      locked: true,
      label: "Resumed in another tab",
    });

    expect(readEmbedComposerLock("a1")).toBe("Resumed in another tab");
  });

  it("ignores a lock without a usable agentId", () => {
    const notified: number[] = [];
    unsubscribes.push(subscribeToEmbedComposerLock(() => notified.push(1)));

    post({ type: "maestro.composer.lock", locked: true, label: "x" });
    post({ type: "maestro.composer.lock", agentId: "", locked: true, label: "x" });
    post({ type: "maestro.composer.lock", agentId: 7, locked: true, label: "x" });

    expect(readEmbedComposerLock("")).toBeNull();
    expect(readEmbedComposerLock("7")).toBeNull();
    expect(notified).toEqual([]);
  });

  it("ignores a lock whose locked flag is not a boolean, either way", () => {
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Session expired" });

    // Neither unlocks a1 ...
    post({ type: "maestro.composer.lock", agentId: "a1", label: "x" });
    post({ type: "maestro.composer.lock", agentId: "a1", locked: "false", label: "x" });
    post({ type: "maestro.composer.lock", agentId: "a1", locked: 0, label: "x" });
    // ... nor locks a2.
    post({ type: "maestro.composer.lock", agentId: "a2", locked: "true", label: "x" });

    expect(readEmbedComposerLock("a1")).toBe("Session expired");
    expect(readEmbedComposerLock("a2")).toBeNull();
  });

  it("ignores a lock from another origin", () => {
    post(
      { type: "maestro.composer.lock", agentId: "a1", locked: true, label: "x" },
      "https://elsewhere.example",
    );

    expect(readEmbedComposerLock("a1")).toBeNull();
  });

  it("notifies subscribers on lock and unlock, not on a repeat", () => {
    const notified: Array<string | null> = [];
    unsubscribes.push(
      subscribeToEmbedComposerLock(() => notified.push(readEmbedComposerLock("a1"))),
    );

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Session expired" });
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Session expired" });
    post({ type: "maestro.composer.lock", agentId: "a1", locked: false });
    post({ type: "maestro.composer.lock", agentId: "a1", locked: false });

    expect(notified).toEqual(["Session expired", null]);
  });

  it("drops a composer insert for a locked agent, and delivers again once unlocked", () => {
    const applied: string[] = [];
    unsubscribes.push(
      subscribeToEmbedComposerInsert((insert) => {
        if (insert.agentId === "a1") applied.push(insert.text);
      }),
    );

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true });
    post({ type: "maestro.composer.insert", text: "/maestro", agentId: "a1" });
    post({ type: "maestro.composer.lock", agentId: "a1", locked: false });
    post({ type: "maestro.composer.insert", text: "/again", agentId: "a1" });

    expect(applied).toEqual(["/again"]);
  });
});

describe("maestro.models.allow routing", () => {
  const unsubscribes: Array<() => void> = [];

  beforeEach(() => {
    window.sessionStorage.clear();
    setLocation("?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    while (unsubscribes.length) unsubscribes.pop()?.();
  });

  function post(data: unknown, origin = window.location.origin): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin }));
  }

  const shown = (models: string[]) => ({ models, hidden: false });

  it("stores the list for the agent it names and no other", () => {
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    expect(readEmbedModelsAllow("a1")).toEqual(shown(["claude-sonnet-5"]));
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });

  it("replaces an agent's list with the next one, leaving the other agents alone", () => {
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });
    post({ type: "maestro.models.allow", agentId: "a2", models: ["claude-sonnet-5"] });

    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-opus-5", "claude-sonnet-5"],
    });

    expect(readEmbedModelsAllow("a1")).toEqual(shown(["claude-opus-5", "claude-sonnet-5"]));
    expect(readEmbedModelsAllow("a2")).toEqual(shown(["claude-sonnet-5"]));
  });

  it("ignores a list without a usable agentId", () => {
    const notified: string[] = [];
    unsubscribes.push(subscribeToEmbedModelsAllow((agentId) => notified.push(agentId)));

    post({ type: "maestro.models.allow", models: ["claude-sonnet-5"] });
    post({ type: "maestro.models.allow", agentId: "", models: ["claude-sonnet-5"] });
    post({ type: "maestro.models.allow", agentId: 7, models: ["claude-sonnet-5"] });
    post({ type: "maestro.models.allow", agentId: "", models: [], hidden: true });

    expect(readEmbedModelsAllow("")).toBeNull();
    expect(readEmbedModelsAllow("7")).toBeNull();
    expect(notified).toEqual([]);
  });

  it("ignores models that are not a list of non-empty strings, keeping the previous list", () => {
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    for (const models of [
      undefined,
      null,
      "claude-opus-5",
      { 0: "claude-opus-5" },
      ["claude-opus-5", 7],
      ["claude-opus-5", null],
      ["claude-opus-5", ""],
    ]) {
      for (const hidden of [undefined, false, true]) {
        post({ type: "maestro.models.allow", agentId: "a1", models, hidden });
        post({ type: "maestro.models.allow", agentId: "a2", models, hidden });
      }
    }

    expect(readEmbedModelsAllow("a1")).toEqual(shown(["claude-sonnet-5"]));
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });

  it("ignores an empty list while shown: it neither empties the menu nor lifts the filter", () => {
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });

    post({ type: "maestro.models.allow", agentId: "a1", models: [] });
    post({ type: "maestro.models.allow", agentId: "a1", models: [], hidden: false });
    post({ type: "maestro.models.allow", agentId: "a2", models: [] });

    expect(readEmbedModelsAllow("a1")).toEqual(shown(["claude-sonnet-5"]));
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });

  it("ignores a list from another origin", () => {
    post(
      { type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] },
      "https://elsewhere.example",
    );
    post(
      { type: "maestro.models.allow", agentId: "a2", models: [], hidden: true },
      "https://elsewhere.example",
    );

    expect(readEmbedModelsAllow("a1")).toBeNull();
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });

  it("notifies on a new list, not on a repeat, and keeps the same object for a repeat", () => {
    const notified: string[] = [];
    unsubscribes.push(subscribeToEmbedModelsAllow((agentId) => notified.push(agentId)));

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });
    const first = readEmbedModelsAllow("a1");
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });
    // An explicit `hidden: false` is the same state as no `hidden`.
    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      hidden: false,
    });
    expect(readEmbedModelsAllow("a1")).toBe(first);

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-opus-5"] });

    expect(notified).toEqual(["a1", "a1"]);
    expect(readEmbedModelsAllow("a1")).toEqual(shown(["claude-opus-5"]));
  });

  it("keeps its own copy: mutating the posted array changes nothing", () => {
    const models = ["claude-sonnet-5"];
    post({ type: "maestro.models.allow", agentId: "a1", models });

    models.push("claude-opus-5");

    expect(readEmbedModelsAllow("a1")).toEqual(shown(["claude-sonnet-5"]));
  });

  it("is inert outside the embed, even if a message reaches the document", () => {
    window.sessionStorage.clear();
    setLocation("");
    resetEmbedModeCache();

    // The listener installed by an earlier test is still on the window.
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });
    post({ type: "maestro.models.allow", agentId: "a2", models: [], hidden: true });

    expect(readEmbedModelsAllow("a1")).toBeNull();
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });
});

describe("maestro.models.allow hidden", () => {
  const unsubscribes: Array<() => void> = [];

  beforeEach(() => {
    window.sessionStorage.clear();
    setLocation("?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    while (unsubscribes.length) unsubscribes.pop()?.();
  });

  function post(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  }

  it("stores hidden:true for the agent it names and no other", () => {
    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      hidden: true,
    });

    expect(readEmbedModelsAllow("a1")).toEqual({ models: ["claude-sonnet-5"], hidden: true });
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });

  it("reads an absent or false hidden as a shown selector", () => {
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });
    post({
      type: "maestro.models.allow",
      agentId: "a2",
      models: ["claude-sonnet-5"],
      hidden: false,
    });

    expect(readEmbedModelsAllow("a1")?.hidden).toBe(false);
    expect(readEmbedModelsAllow("a2")?.hidden).toBe(false);
  });

  it("accepts an empty list with hidden:true: the list plays no part while hidden", () => {
    post({ type: "maestro.models.allow", agentId: "a1", models: [], hidden: true });

    expect(readEmbedModelsAllow("a1")).toEqual({ models: [], hidden: true });
  });

  it("ignores a hidden that is not a boolean, keeping the previous state", () => {
    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      hidden: true,
    });
    const before = readEmbedModelsAllow("a1");

    for (const hidden of ["true", "false", 1, 0, null, {}]) {
      post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-opus-5"], hidden });
      post({ type: "maestro.models.allow", agentId: "a2", models: ["claude-opus-5"], hidden });
    }

    expect(readEmbedModelsAllow("a1")).toBe(before);
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });

  it("a later message replaces the state whole: hidden true, then false, shows it again", () => {
    const notified: string[] = [];
    unsubscribes.push(subscribeToEmbedModelsAllow((agentId) => notified.push(agentId)));

    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      hidden: true,
    });
    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      hidden: false,
    });
    expect(readEmbedModelsAllow("a1")).toEqual({ models: ["claude-sonnet-5"], hidden: false });

    post({ type: "maestro.models.allow", agentId: "a1", models: [], hidden: true });
    // No `hidden` at all is shown too: the previous hidden:true does not carry over.
    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-opus-5"] });
    expect(readEmbedModelsAllow("a1")).toEqual({ models: ["claude-opus-5"], hidden: false });

    expect(notified).toEqual(["a1", "a1", "a1", "a1"]);
  });

  it("notifies when only hidden changes, not on a repeat of the same hidden state", () => {
    const notified: string[] = [];
    unsubscribes.push(subscribeToEmbedModelsAllow((agentId) => notified.push(agentId)));

    post({ type: "maestro.models.allow", agentId: "a1", models: ["claude-sonnet-5"] });
    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      hidden: true,
    });
    const hidden = readEmbedModelsAllow("a1");
    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: ["claude-sonnet-5"],
      hidden: true,
    });

    expect(readEmbedModelsAllow("a1")).toBe(hidden);
    expect(notified).toEqual(["a1", "a1"]);
  });
});

describe('maestro.models.allow default (agentId "*")', () => {
  const unsubscribes: Array<() => void> = [];

  beforeEach(() => {
    window.sessionStorage.clear();
    setLocation("?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    while (unsubscribes.length) unsubscribes.pop()?.();
  });

  function post(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  }

  function allow(agentId: string, models: string[], hidden?: boolean): void {
    post({
      type: "maestro.models.allow",
      agentId,
      models,
      ...(hidden === undefined ? {} : { hidden }),
    });
  }

  it('is the "*" agentId', () => {
    expect(EMBED_MODELS_ALLOW_DEFAULT_ID).toBe("*");
  });

  it("stores the default and hands it to drafts and to every agent Orchestra never named", () => {
    allow("*", [], true);

    expect(readEmbedModelsAllow(EMBED_MODELS_ALLOW_DEFAULT_ID)).toEqual({
      models: [],
      hidden: true,
    });
    // An agent created after /clear or a fork: an id Orchestra has not named.
    expect(readEmbedModelsAllow("created-after-clear")).toBe(
      readEmbedModelsAllow(EMBED_MODELS_ALLOW_DEFAULT_ID),
    );
  });

  it("an agent's own entry beats the default, whichever arrived first", () => {
    allow("a1", ["claude-opus-5"]);
    allow("*", [], true);
    allow("a2", ["claude-sonnet-5"], false);

    expect(readEmbedModelsAllow("a1")).toEqual({ models: ["claude-opus-5"], hidden: false });
    expect(readEmbedModelsAllow("a2")).toEqual({ models: ["claude-sonnet-5"], hidden: false });
    expect(readEmbedModelsAllow("a3")).toEqual({ models: [], hidden: true });
    expect(readEmbedModelsAllow("*")).toEqual({ models: [], hidden: true });
  });

  it("a per-agent hidden stays hidden under a shown default", () => {
    allow("*", ["claude-sonnet-5"]);
    allow("a1", ["claude-sonnet-5"], true);

    expect(readEmbedModelsAllow("a1")?.hidden).toBe(true);
    expect(readEmbedModelsAllow("a2")).toEqual({ models: ["claude-sonnet-5"], hidden: false });
  });

  it("a later default replaces the previous one whole, per-agent entries untouched", () => {
    allow("a1", ["claude-opus-5"], true);
    allow("*", ["claude-sonnet-5"], true);
    allow("*", ["claude-sonnet-5"]);

    expect(readEmbedModelsAllow("a2")).toEqual({ models: ["claude-sonnet-5"], hidden: false });
    expect(readEmbedModelsAllow("a1")).toEqual({ models: ["claude-opus-5"], hidden: true });

    allow("*", ["claude-opus-5", "claude-sonnet-5"]);
    expect(readEmbedModelsAllow("a2")).toEqual({
      models: ["claude-opus-5", "claude-sonnet-5"],
      hidden: false,
    });
  });

  it("is validated like a per-agent message: malformed or empty-while-shown keeps the default", () => {
    allow("*", ["claude-sonnet-5"]);
    const before = readEmbedModelsAllow("*");

    allow("*", []);
    post({ type: "maestro.models.allow", agentId: "*", models: ["claude-opus-5"], hidden: "true" });
    post({ type: "maestro.models.allow", agentId: "*", models: [7] });
    post({ type: "maestro.models.allow", agentId: "*" });

    expect(readEmbedModelsAllow("*")).toBe(before);
    expect(readEmbedModelsAllow("a1")).toBe(before);
  });

  it('notifies "*" on a new default, nobody on a repeat', () => {
    const notified: string[] = [];
    unsubscribes.push(subscribeToEmbedModelsAllow((agentId) => notified.push(agentId)));

    allow("*", [], true);
    allow("*", [], true);
    allow("*", ["claude-sonnet-5"]);

    expect(notified).toEqual(["*", "*"]);
  });

  it("is inert outside the embed", () => {
    window.sessionStorage.clear();
    setLocation("");
    resetEmbedModeCache();

    allow("*", [], true);

    expect(readEmbedModelsAllow("*")).toBeNull();
    expect(readEmbedModelsAllow("a1")).toBeNull();
  });
});

describe("maestro.embed.ready", () => {
  const BRIDGE_FLAG = "__figmentaEmbedBridgeInstalled";
  let parentPost: ReturnType<typeof vi.fn>;
  let order: string[];

  /** A new document: the bridge flag lives on the window, a reload starts without it. */
  function freshDocument(search: string): void {
    delete (window as unknown as Record<string, unknown>)[BRIDGE_FLAG];
    window.sessionStorage.clear();
    setLocation(search);
    resetEmbedModeCache();
  }

  beforeEach(() => {
    order = [];
    parentPost = vi.fn(() => order.push("ready"));
    vi.spyOn(window, "parent", "get").mockReturnValue({
      postMessage: parentPost,
    } as unknown as Window);
    const addEventListener = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "message") order.push("listener");
      addEventListener(type, listener, options);
    });
    freshDocument("?embed=1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts ready to the parent, same origin, never '*', after the listener is up", () => {
    installEmbedBridge();

    expect(parentPost).toHaveBeenCalledTimes(1);
    expect(parentPost).toHaveBeenCalledWith({ type: EMBED_READY_TYPE }, window.location.origin);
    expect(EMBED_READY_TYPE).toBe("maestro.embed.ready");
    expect(parentPost.mock.calls[0][1]).not.toBe("*");
    expect(order).toEqual(["listener", "ready"]);
  });

  it("posts once per install: a second call in the same document posts nothing", () => {
    installEmbedBridge();
    installEmbedBridge();
    installEmbedBridge();

    expect(parentPost).toHaveBeenCalledTimes(1);
  });

  it("posts again on every fresh install, one per document load", () => {
    installEmbedBridge();
    freshDocument("?embed=1");
    installEmbedBridge();
    installEmbedBridge();

    expect(parentPost).toHaveBeenCalledTimes(2);
  });

  it("posts nothing outside the embed", () => {
    freshDocument("");

    installEmbedBridge();

    expect(parentPost).not.toHaveBeenCalled();
  });

  it("a post that throws (opaque origin) leaves the listener installed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parentPost.mockImplementation(() => {
      throw new DOMException("Invalid target origin 'null'", "SyntaxError");
    });

    installEmbedBridge();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "maestro.models.allow", agentId: "r1", models: [], hidden: true },
        origin: window.location.origin,
      }),
    );

    expect(readEmbedModelsAllow("r1")).toEqual({ models: [], hidden: true });
    expect(warn).toHaveBeenCalled();
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

describe("maestro.models.allow modes and efforts", () => {
  const unsubscribes: Array<() => void> = [];
  const MODELS = ["claude-sonnet-5"];

  beforeEach(() => {
    window.sessionStorage.clear();
    setLocation("?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
    while (unsubscribes.length) unsubscribes.pop()?.();
  });

  function post(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  }

  function allow(agentId: string, extra: Record<string, unknown>): void {
    post({ type: "maestro.models.allow", agentId, models: MODELS, ...extra });
  }

  it("stores modes and efforts with the models of the agent it names", () => {
    allow("a1", { modes: ["auto", "plan"], efforts: ["low"] });

    expect(readEmbedModelsAllow("a1")).toEqual({
      models: MODELS,
      hidden: false,
      modes: ["auto", "plan"],
      efforts: ["low"],
    });
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });

  it("absent = no filter: the entry carries no modes and no efforts", () => {
    allow("a1", {});

    const entry = readEmbedModelsAllow("a1");
    expect(entry).not.toBeNull();
    expect("modes" in entry!).toBe(false);
    expect("efforts" in entry!).toBe(false);
  });

  it("keeps modes and efforts under hidden: they are not model settings", () => {
    post({
      type: "maestro.models.allow",
      agentId: "a1",
      models: [],
      hidden: true,
      modes: ["plan"],
      efforts: ["medium", "high"],
    });

    expect(readEmbedModelsAllow("a1")).toEqual({
      models: [],
      hidden: true,
      modes: ["plan"],
      efforts: ["medium", "high"],
    });
  });

  it("accepts an empty list: nothing of that kind is offered", () => {
    allow("a1", { modes: [], efforts: [] });

    expect(readEmbedModelsAllow("a1")?.modes).toEqual([]);
    expect(readEmbedModelsAllow("a1")?.efforts).toEqual([]);
  });

  it("the next message replaces the entry whole: modes absent there lifts the mode filter", () => {
    allow("a1", { modes: ["auto", "plan"], efforts: ["low"] });

    allow("a1", { efforts: ["high"] });

    expect(readEmbedModelsAllow("a1")?.modes).toBeUndefined();
    expect(readEmbedModelsAllow("a1")?.efforts).toEqual(["high"]);
  });

  it("the default ('*') carries them to drafts and unnamed agents; an agent's own entry wins whole", () => {
    allow("*", { modes: ["auto", "plan"], efforts: ["low"] });
    allow("a1", {});

    expect(readEmbedModelsAllow("unnamed")?.modes).toEqual(["auto", "plan"]);
    expect(readEmbedModelsAllow("unnamed")?.efforts).toEqual(["low"]);
    // Its own entry sent no modes and no efforts: no filter for a1, the default does not leak in.
    expect(readEmbedModelsAllow("a1")?.modes).toBeUndefined();
    expect(readEmbedModelsAllow("a1")?.efforts).toBeUndefined();
  });

  it("a malformed modes or efforts voids the whole message, the previous state stays", () => {
    allow("a1", { modes: ["auto"], efforts: ["low"] });
    const before = readEmbedModelsAllow("a1");

    for (const bad of [null, "auto", 7, { 0: "auto" }, ["auto", 7], ["auto", ""], [null]]) {
      post({
        type: "maestro.models.allow",
        agentId: "a1",
        models: ["claude-opus-5"],
        modes: bad,
      });
      post({
        type: "maestro.models.allow",
        agentId: "a1",
        models: ["claude-opus-5"],
        efforts: bad,
      });
      post({ type: "maestro.models.allow", agentId: "a2", models: MODELS, modes: bad });
      post({ type: "maestro.models.allow", agentId: "a2", models: MODELS, efforts: bad });
    }

    // Not even the models of the malformed messages were taken.
    expect(readEmbedModelsAllow("a1")).toBe(before);
    expect(readEmbedModelsAllow("a2")).toBeNull();
  });

  it("notifies on a change of modes or efforts, not on a repeat", () => {
    const notified: string[] = [];
    unsubscribes.push(subscribeToEmbedModelsAllow((agentId) => notified.push(agentId)));

    allow("a1", { modes: ["auto", "plan"] });
    const first = readEmbedModelsAllow("a1");
    allow("a1", { modes: ["auto", "plan"] });
    expect(readEmbedModelsAllow("a1")).toBe(first);

    allow("a1", { modes: ["plan", "auto"] });
    allow("a1", { modes: ["plan", "auto"], efforts: ["low"] });
    allow("a1", { modes: ["plan", "auto"], efforts: [] });

    expect(notified).toEqual(["a1", "a1", "a1", "a1"]);
  });

  it("keeps its own copies: mutating the posted arrays changes nothing", () => {
    const modes = ["auto"];
    const efforts = ["low"];
    allow("a1", { modes, efforts });

    modes.push("bypassPermissions");
    efforts.push("max");

    expect(readEmbedModelsAllow("a1")?.modes).toEqual(["auto"]);
    expect(readEmbedModelsAllow("a1")?.efforts).toEqual(["low"]);
  });
});

describe("frame events to the parent (contract notes-maestro §10.1)", () => {
  const BRIDGE_FLAG = "__figmentaEmbedBridgeInstalled";
  let parentPost: ReturnType<typeof vi.fn>;

  function freshDocument(search: string): void {
    delete (window as unknown as Record<string, unknown>)[BRIDGE_FLAG];
    window.sessionStorage.clear();
    setLocation(search);
    resetEmbedModeCache();
  }

  function box(x: number, y: number, w: number, h: number): DOMRect {
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h } as DOMRect;
  }

  function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`#${id} missing`);
    return element as T;
  }

  /** What the page received: everything but the ready of the install. */
  function posted(): unknown[] {
    return parentPost.mock.calls.map((call) => call[0]);
  }

  function mouse(type: "click" | "contextmenu", target: Element, init: MouseEventInit = {}) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 12,
      button: type === "contextmenu" ? 2 : 0,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  }

  function escape(): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    // Shaped like the fork's DOM: assistant-file-links/link.tsx writes a `display: contents`
    // <a href> around the Pressable; message.tsx tags the assistant message by testID.
    document.body.innerHTML = `
      <div data-testid="assistant-message">
        <div>See <a id="web" href="https://example.com/doc" title="Doc" style="display: contents"><div id="web-press"><span id="web-text">  Example
          doc </span></div></a>
        and <a id="file" href="ROOT/notes/file.md"><div id="file-press">ROOT/notes/file.md</div></a>
        and <a id="mail" href="mailto:a@b.c"><span id="mail-text">mail</span></a></div>
      </div>
      <div data-testid="user-message"><a href="https://example.com/user"><span id="user-text">user</span></a></div>
      <textarea id="composer"></textarea>
      <input id="search" />
      <div id="editable" contenteditable="true" tabindex="0"><span id="inside-editable">x</span></div>
      <div id="frozen" contenteditable="false" tabindex="0"></div>
    `;
    parentPost = vi.fn();
    vi.spyOn(window, "parent", "get").mockReturnValue({
      postMessage: parentPost,
    } as unknown as Window);
    vi.spyOn(byId("web-press"), "getBoundingClientRect").mockReturnValue(box(30, 5, 100, 18));
    freshDocument("?embed=1");
    installEmbedBridge();
    parentPost.mockClear();
  });

  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("a left click on an http link of an assistant message goes to the page, not to the link", () => {
    const reachedLink = vi.fn();
    byId("web-press").addEventListener("click", reachedLink);

    const event = mouse("click", byId("web-text"));

    expect(event.defaultPrevented).toBe(true);
    expect(reachedLink).not.toHaveBeenCalled();
    expect(parentPost).toHaveBeenCalledTimes(1);
    expect(parentPost).toHaveBeenCalledWith(
      {
        type: "maestro.link.click",
        href: "https://example.com/doc",
        text: "Example doc",
        role: "assistant",
        x: 40,
        y: 12,
        rect: { x: 30, y: 5, w: 100, h: 18 },
      },
      window.location.origin,
    );
  });

  it("takes the link's own box when it has one", () => {
    vi.spyOn(byId("web"), "getBoundingClientRect").mockReturnValue(box(1, 2, 3, 4));

    mouse("click", byId("web-text"));

    expect(posted()).toEqual([expect.objectContaining({ rect: { x: 1, y: 2, w: 3, h: 4 } })]);
  });

  it("a right click on the same link sends the contextmenu message, and no browser menu", () => {
    const event = mouse("contextmenu", byId("web-text"), { clientX: 7, clientY: 9 });

    expect(event.defaultPrevented).toBe(true);
    expect(posted()).toEqual([
      {
        type: "maestro.link.contextmenu",
        href: "https://example.com/doc",
        text: "Example doc",
        role: "assistant",
        x: 7,
        y: 9,
        rect: { x: 30, y: 5, w: 100, h: 18 },
      },
    ]);
  });

  it("file paths and other schemes pass untouched: view.tsx handles the paths", () => {
    const reachedLink = vi.fn();
    byId("file-press").addEventListener("click", reachedLink);

    const fileClick = mouse("click", byId("file-press"));
    const fileMenu = mouse("contextmenu", byId("file-press"));
    const mailClick = mouse("click", byId("mail-text"));

    expect(fileClick.defaultPrevented).toBe(false);
    expect(fileMenu.defaultPrevented).toBe(false);
    expect(mailClick.defaultPrevented).toBe(false);
    expect(reachedLink).toHaveBeenCalledTimes(1);
    expect(posted()).toEqual([]);
  });

  it("an http link outside an assistant message passes untouched", () => {
    const event = mouse("click", byId("user-text"));

    expect(event.defaultPrevented).toBe(false);
    expect(posted()).toEqual([]);
  });

  it("a pointerdown anywhere in the frame tells the page, and is not cancelled", () => {
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    byId("user-text").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(posted()).toEqual([{ type: "maestro.frame.pointerdown" }]);
  });

  it("Escape with no field focused goes to the page", () => {
    escape();

    expect(posted()).toEqual([{ type: "maestro.frame.escape" }]);
  });

  it("Escape in a textarea, an input or a contenteditable stays in the field", () => {
    for (const id of ["composer", "search", "editable"]) {
      byId(id).focus();
      expect(document.activeElement?.id).toBe(id);
      escape();
    }

    expect(posted()).toEqual([]);
  });

  it('contenteditable="false" is not a field', () => {
    byId("frozen").focus();
    escape();

    expect(posted()).toEqual([{ type: "maestro.frame.escape" }]);
  });

  it("other keys send nothing", () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(posted()).toEqual([]);
  });

  it("a second install in a new document does not double the messages", () => {
    freshDocument("?embed=1");
    installEmbedBridge();
    parentPost.mockClear();

    mouse("click", byId("web-text"));
    escape();

    expect(posted().map((m) => (m as { type: string }).type)).toEqual([
      "maestro.link.click",
      "maestro.frame.escape",
    ]);
  });

  it("outside the embed nothing is intercepted and nothing is sent", () => {
    freshDocument("");

    const click = mouse("click", byId("web-text"));
    const menu = mouse("contextmenu", byId("web-text"));
    byId("user-text").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    escape();

    expect(click.defaultPrevented).toBe(false);
    expect(menu.defaultPrevented).toBe(false);
    expect(posted()).toEqual([]);
  });
});

describe("buildEmbedFileClick", () => {
  const root = "/Users/fhg/vault";

  it("keeps the absolute path Paseo resolved and gives it relative to the root", () => {
    expect(
      buildEmbedFileClick({ raw: "ROOT/a/b.md", path: "/Users/fhg/vault/ROOT/a/b.md" }, root),
    ).toEqual({
      type: "maestro.file.click",
      path: "/Users/fhg/vault/ROOT/a/b.md",
      rel: "ROOT/a/b.md",
      raw: "ROOT/a/b.md",
    });
  });

  it("reads a root with trailing slashes the same", () => {
    expect(buildEmbedFileClick({ raw: "x", path: "/Users/fhg/vault/x.md" }, `${root}//`).rel).toBe(
      "x.md",
    );
  });

  it("an absolute path outside the root has no rel", () => {
    expect(buildEmbedFileClick({ raw: "/etc/hosts", path: "/etc/hosts" }, root)).toEqual({
      type: "maestro.file.click",
      path: "/etc/hosts",
      rel: null,
      raw: "/etc/hosts",
    });
    expect(buildEmbedFileClick({ raw: "v", path: "/Users/fhg/vault-2/v.md" }, root).rel).toBeNull();
    expect(buildEmbedFileClick({ raw: "r", path: root }, root).rel).toBeNull();
  });

  it("joins a relative path to an absolute root", () => {
    expect(buildEmbedFileClick({ raw: "src/a.ts", path: "./src/../src/a.ts" }, root)).toEqual({
      type: "maestro.file.click",
      path: "/Users/fhg/vault/src/a.ts",
      rel: "src/a.ts",
      raw: "src/a.ts",
    });
  });

  it("leaves unresolvable paths null, with the raw text", () => {
    const cases: Array<[string, string | null | undefined]> = [
      ["~/notes/a.md", root],
      ["ROOT/a.md", ""],
      ["ROOT/a.md", null],
      ["ROOT/a.md", "relative/root"],
      ["../outside.md", root],
      ["", root],
    ];
    for (const [path, workspaceRoot] of cases) {
      expect(buildEmbedFileClick({ raw: "as written", path }, workspaceRoot)).toEqual({
        type: "maestro.file.click",
        path: null,
        rel: null,
        raw: "as written",
      });
    }
  });
});

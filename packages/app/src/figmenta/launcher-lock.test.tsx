// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";
import {
  EMBED_LAUNCHER_MESSAGE_TYPE,
  EMBED_SESSION_CLOSED_MESSAGE,
  EMBED_TERMINAL_REFUSED_MESSAGE,
  LAUNCHER_ACTION_IDS,
  canCreateEmbedTerminal,
  launcherLocked,
  readEmbedLauncherAllowed,
  useEmbedLauncherAllowed,
} from "./launcher-lock";
import {
  createKeyboardActionDispatcher,
  type KeyboardActionDefinition,
  type KeyboardActionId,
} from "@/keyboard/keyboard-action-dispatcher";

// The launcher module is compiled with the classic JSX runtime here: it needs a global React.
(globalThis as { React?: typeof React }).React = React;

vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-daemon-config", () => ({ useDaemonConfig: () => ({ config: null }) }));
vi.mock("@/plugins/registry", () => ({ useInstalledPlugins: () => [] }));
vi.mock("@/panels/register-panels", () => ({ ensurePanelsRegistered: () => {} }));
vi.mock("@/panels/panel-registry", () => ({
  getPanelRegistration: () => ({ presentation: { label: () => "panel", icon: () => null } }),
}));
vi.mock("@/panels/panel-manifest", () => ({ panelSupportsHost: () => true }));

const { NewTabLauncherProvider, useWorkspaceTabLaunchCatalog } =
  await import("@/workspace-tabs/launcher");

const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");

function setLocation(search: string): void {
  window.history.replaceState({}, "", `/agents-ui/${search}`);
}

function post(data: unknown, origin = window.location.origin): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin }));
}

/** A new embedded document: embed flag latched, launcher state forgotten. */
function enterEmbed(): void {
  window.sessionStorage.clear();
  setLocation("?embed=1");
  resetEmbedModeCache();
}

/** A plain Paseo document: no embed flag anywhere. */
function leaveEmbed(): void {
  window.sessionStorage.clear();
  setLocation("");
  resetEmbedModeCache();
}

beforeAll(() => {
  enterEmbed();
  installEmbedBridge();
});

beforeEach(() => {
  enterEmbed();
});

afterEach(() => {
  cleanup();
});

describe("launcher lock store", () => {
  it("is closed by default in embed, before any message", () => {
    expect(readEmbedLauncherAllowed()).toBe(false);
    expect(launcherLocked()).toBe(true);
    expect(canCreateEmbedTerminal()).toBe(false);
  });

  it("opens on allowed: true and closes again on allowed: false", () => {
    post({ type: "maestro.launcher", allowed: true });
    expect(launcherLocked()).toBe(false);
    expect(canCreateEmbedTerminal()).toBe(true);

    post({ type: "maestro.launcher", allowed: false });
    expect(launcherLocked()).toBe(true);
    expect(canCreateEmbedTerminal()).toBe(false);
  });

  it("ignores an allowed that is not a boolean, from either state", () => {
    for (const allowed of ["true", 1, null, undefined, {}]) {
      post({ type: "maestro.launcher", allowed });
      expect(launcherLocked()).toBe(true);
    }
    post({ type: "maestro.launcher" });
    expect(launcherLocked()).toBe(true);

    post({ type: "maestro.launcher", allowed: true });
    for (const allowed of ["false", 0, null, undefined]) {
      post({ type: "maestro.launcher", allowed });
      expect(launcherLocked()).toBe(false);
    }
  });

  it("accepts exactly { type: 'maestro.launcher', allowed } from the same origin", () => {
    expect(EMBED_LAUNCHER_MESSAGE_TYPE).toBe("maestro.launcher");
    post({ type: "maestro.launcher.allow", allowed: true });
    post({ type: "maestro.launcher", enabled: true });
    post({ type: "maestro.launcher", allowed: true }, "https://evil.example");
    expect(launcherLocked()).toBe(true);

    post({ type: "maestro.launcher", allowed: true });
    expect(launcherLocked()).toBe(false);
  });

  it("never locks outside embed mode", () => {
    leaveEmbed();
    expect(launcherLocked()).toBe(false);
    expect(canCreateEmbedTerminal()).toBe(true);
  });

  it("re-renders subscribers when the message lands", () => {
    const { result } = renderHook(() => useEmbedLauncherAllowed());
    expect(result.current).toBe(false);
    act(() => post({ type: "maestro.launcher", allowed: true }));
    expect(result.current).toBe(true);
    act(() => post({ type: "maestro.launcher", allowed: false }));
    expect(result.current).toBe(false);
  });

  it("carries the closed-session message in English", () => {
    expect(EMBED_SESSION_CLOSED_MESSAGE).toBe(
      "This session is closed. Open another one from the sidebar.",
    );
  });
});

describe("keyboardActionDispatcher under the launcher gate", () => {
  function actionFor(id: KeyboardActionId): KeyboardActionDefinition {
    if (id === "workspace.tab.open") {
      return { id, scope: "workspace", target: "files", placement: "supporting" };
    }
    return { id, scope: "workspace" } as KeyboardActionDefinition;
  }

  function setup() {
    const dispatcher = createKeyboardActionDispatcher();
    const handle = vi.fn(() => true);
    dispatcher.registerHandler({
      handlerId: "probe",
      actions: [...LAUNCHER_ACTION_IDS, "message-input.focus"],
      enabled: true,
      priority: 0,
      handle,
    });
    return { dispatcher, handle };
  }

  it("covers the terminal, new-tab and new-agent shortcuts", () => {
    for (const id of [
      "workspace.terminal.new",
      "workspace.tab.menu.open",
      "workspace.agent.new",
      "workspace.tab.target.agent",
      "workspace.browser.new",
      "workspace.new",
    ] as const) {
      expect(LAUNCHER_ACTION_IDS.has(id)).toBe(true);
    }
  });

  it("drops every launcher action in a locked embed, lets the rest through", () => {
    const { dispatcher, handle } = setup();
    for (const id of LAUNCHER_ACTION_IDS) {
      expect(dispatcher.dispatch(actionFor(id))).toBe(false);
    }
    expect(handle).not.toHaveBeenCalled();

    expect(dispatcher.dispatch({ id: "message-input.focus", scope: "global" })).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("passes launcher actions through once Orchestra allows them", () => {
    const { dispatcher, handle } = setup();
    post({ type: "maestro.launcher", allowed: true });
    for (const id of LAUNCHER_ACTION_IDS) {
      expect(dispatcher.dispatch(actionFor(id))).toBe(true);
    }
    expect(handle).toHaveBeenCalledTimes(LAUNCHER_ACTION_IDS.size);
  });

  it("passes launcher actions through outside embed mode", () => {
    leaveEmbed();
    const { dispatcher, handle } = setup();
    expect(dispatcher.dispatch(actionFor("workspace.terminal.new"))).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
  });
});

const CATALOG_LAUNCHER = {
  showChanges: true,
  showPullRequest: false,
  showBrowser: true,
  terminalDisabled: false,
  launch: vi.fn(),
};

describe("useWorkspaceTabLaunchCatalog under the launcher gate", () => {
  function wrapper({ children }: { children: ReactNode }) {
    return <NewTabLauncherProvider value={CATALOG_LAUNCHER}>{children}</NewTabLauncherProvider>;
  }
  function renderCatalog() {
    return renderHook(
      () => useWorkspaceTabLaunchCatalog({ serverId: "s1", purpose: "primary", host: "main" }),
      { wrapper },
    );
  }
  function itemIds(groups: ReturnType<typeof useWorkspaceTabLaunchCatalog>): string[] {
    return groups.flatMap((group) => group.items.map((item) => item.id));
  }

  it("is empty in a locked embed, and fills when Orchestra allows it", () => {
    const { result } = renderCatalog();
    expect(result.current).toEqual([]);

    act(() => post({ type: "maestro.launcher", allowed: true }));
    expect(itemIds(result.current)).toEqual(expect.arrayContaining(["agent", "terminal"]));

    act(() => post({ type: "maestro.launcher", allowed: false }));
    expect(result.current).toEqual([]);
  });

  it("is Paseo's catalog outside embed mode", () => {
    leaveEmbed();
    const { result } = renderCatalog();
    expect(itemIds(result.current)).toEqual(expect.arrayContaining(["agent", "terminal"]));
  });
});

describe("DaemonClient.createTerminal under the launcher gate", () => {
  function makeClient() {
    return new DaemonClient({
      url: "ws://launcher-gate.test",
      clientId: "figmenta_launcher_gate_app_test",
      reconnect: { enabled: false },
      canCreateTerminal: canCreateEmbedTerminal,
    });
  }

  it("is refused in a locked embed, with no request sent", async () => {
    const client = makeClient();
    await expect(client.createTerminal("/tmp")).rejects.toThrow(EMBED_TERMINAL_REFUSED_MESSAGE);
  });

  it("is not refused by the gate once Orchestra allows it", async () => {
    post({ type: "maestro.launcher", allowed: true });
    const client = makeClient();
    const outcome = await Promise.race([
      client.createTerminal("/tmp").then(
        () => "sent",
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(outcome).not.toBe(EMBED_TERMINAL_REFUSED_MESSAGE);
  });
});

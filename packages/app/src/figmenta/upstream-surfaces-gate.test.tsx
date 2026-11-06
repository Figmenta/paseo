// @vitest-environment jsdom
// Figmenta embed gates on the surfaces upstream added after 0.9.2 (docs/FIGMENTA.md): plugin
// buttons, account usage, the scripts button and the compact tab switcher footer. The routed-host
// gate is in runtime/host-runtime.test.ts, next to the discovery it stops.
import React from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";
import { EMBED_LAUNCHER_MESSAGE_TYPE } from "./launcher-lock";

// Some modules here are compiled with the classic JSX runtime: they need a global React.
(globalThis as { React?: typeof React }).React = React;

const buttons = vi.hoisted(() => ({ entries: [] as unknown[] }));

vi.mock("@/plugins/buttons/store", () => ({
  pluginButtonStore: {
    subscribe: () => () => {},
    getSnapshot: () => buttons.entries,
  },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
  useHosts: () => [],
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => true }));
vi.mock("@/usage/setting", () => ({ useUsageSetting: () => ({ enabled: true }) }));
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ footer }: { footer?: React.ReactNode }) => footer ?? null,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ testID, children }: { testID?: string; children?: React.ReactNode }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));

const { useHasPluginComposerPills, usePluginWorkspaceMenu } =
  await import("@/plugins/buttons/view");
const { useHostReportsUsage } = await import("@/usage/queries");
const { WorkspaceScriptsButton } = await import("@/screens/workspace/scripts");
const { MobileWorkspaceTabSwitcher } =
  await import("@/screens/workspace/compact-workspace-header/tab-switcher");

function setLocation(search: string): void {
  window.history.replaceState({}, "", `/agents-ui/${search}`);
}

function enterEmbed(): void {
  window.sessionStorage.clear();
  setLocation("?embed=1");
  resetEmbedModeCache();
}

function leaveEmbed(): void {
  window.sessionStorage.clear();
  setLocation("");
  resetEmbedModeCache();
}

function allowLauncher(): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: EMBED_LAUNCHER_MESSAGE_TYPE, allowed: true },
        origin: window.location.origin,
        source: window.parent,
      }),
    );
  });
}

function pluginButton(placement: "header" | "composer") {
  return {
    key: `figmenta-test:${placement}`,
    placement,
    installation: { serverId: "srv" },
    context: { workspaceId: "ws", context: "agent", agentId: "agent" },
    button: { visible: true, label: "Plugin action", behavior: { kind: "action" } },
  };
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
  buttons.entries = [];
});

describe("plugin buttons in the embed", () => {
  it("are gone from the composer bar and the workspace menu in the embed", () => {
    buttons.entries = [pluginButton("header"), pluginButton("composer")];
    expect(renderHook(() => useHasPluginComposerPills("srv", "ws", "agent")).result.current).toBe(
      false,
    );
    expect(renderHook(() => usePluginWorkspaceMenu("srv", "ws")).result.current.rows).toHaveLength(
      0,
    );
  });

  it("stay Paseo's outside the embed", () => {
    leaveEmbed();
    buttons.entries = [pluginButton("header"), pluginButton("composer")];
    expect(renderHook(() => useHasPluginComposerPills("srv", "ws", "agent")).result.current).toBe(
      true,
    );
    expect(
      renderHook(() => usePluginWorkspaceMenu("srv", "ws")).result.current.rows.length,
    ).toBeGreaterThan(0);
  });
});

describe("account usage in the embed", () => {
  it("is not reported in the embed, so no usage card or query", () => {
    expect(renderHook(() => useHostReportsUsage("srv")).result.current).toBe(false);
  });

  it("is reported outside the embed", () => {
    leaveEmbed();
    expect(renderHook(() => useHostReportsUsage("srv")).result.current).toBe(true);
  });
});

describe("scripts button under the launcher gate", () => {
  it("renders nothing in a locked embed", () => {
    const { container } = render(
      <WorkspaceScriptsButton serverId="srv" workspaceId="ws" scripts={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("compact tab switcher footer under the launcher gate", () => {
  const noop = () => {};
  const props = {
    tabs: [],
    activeTabKey: "",
    normalizedServerId: "srv",
    normalizedWorkspaceId: "ws",
    onSelectSwitcherTab: noop,
    createTerminalDisabled: false,
    onCreateDraftTab: noop,
    onCreateTerminal: noop,
    onCopyResumeCommand: noop,
    onCopyAgentId: noop,
    onCopyTerminalId: noop,
    onCopyFilePath: noop,
    onReloadAgent: noop,
    onRenameTab: noop,
    onCloseTab: noop,
    onCloseTabsAbove: noop,
    onCloseTabsBelow: noop,
    onCloseOtherTabs: noop,
  };

  it("has no New agent / New terminal in a locked embed", () => {
    const view = render(<MobileWorkspaceTabSwitcher {...props} />);
    expect(view.queryByTestId("workspace-tab-switcher-new-terminal")).toBeNull();
    expect(view.queryByTestId("workspace-tab-switcher-new-agent")).toBeNull();
  });

  it("shows them once Orchestra allows the launcher", () => {
    allowLauncher();
    const view = render(<MobileWorkspaceTabSwitcher {...props} />);
    expect(view.queryByTestId("workspace-tab-switcher-new-terminal")).not.toBeNull();
    expect(view.queryByTestId("workspace-tab-switcher-new-agent")).not.toBeNull();
  });

  it("shows them outside the embed", () => {
    leaveEmbed();
    const view = render(<MobileWorkspaceTabSwitcher {...props} />);
    expect(view.queryByTestId("workspace-tab-switcher-new-terminal")).not.toBeNull();
  });
});

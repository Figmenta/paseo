// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertEmbedComposerUnlocked,
  EmbedComposerLockGate,
  type EmbedComposerLockVoice,
  isEmbedComposerLocked,
  useEmbedComposerLockGuard,
} from "./composer-lock";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

function post(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  });
}

/** Two composers side by side, each with a stand-in for its message input. */
function renderComposers() {
  return render(
    <>
      <EmbedComposerLockGate agentId="a1" profileId="MessageInput">
        <Text testID="input-a1">input a1</Text>
      </EmbedComposerLockGate>
      <EmbedComposerLockGate agentId="a2" profileId="MessageInput">
        <Text testID="input-a2">input a2</Text>
      </EmbedComposerLockGate>
    </>,
  );
}

describe("EmbedComposerLockGate", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the input while Orchestra holds no lock", () => {
    const view = renderComposers();

    expect(view.queryByTestId("input-a1")).not.toBeNull();
    expect(view.queryByTestId("input-a2")).not.toBeNull();
    expect(view.queryByTestId("composer-embed-lock")).toBeNull();
  });

  it("replaces the input of the locked agent with a bar showing the label", () => {
    const view = renderComposers();

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Not available" });

    expect(view.queryByTestId("input-a1")).toBeNull();
    expect(view.getByTestId("composer-embed-lock").textContent).toBe("Not available");
    expect(view.queryByTestId("input-a2")).not.toBeNull();
  });

  it("shows «Session expired» when the lock carries no label", () => {
    const view = renderComposers();

    post({ type: "maestro.composer.lock", agentId: "a2", locked: true, label: null });

    expect(view.getByTestId("composer-embed-lock").textContent).toBe("Session expired");
    expect(view.queryByTestId("input-a2")).toBeNull();
  });

  it("brings the input back on locked:false", () => {
    const view = renderComposers();
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true });

    post({ type: "maestro.composer.lock", agentId: "a1", locked: false });

    expect(view.queryByTestId("composer-embed-lock")).toBeNull();
    expect(view.queryByTestId("input-a1")).not.toBeNull();
  });

  it("is already locked when it mounts after the message", () => {
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Session expired" });

    const view = renderComposers();

    expect(view.queryByTestId("input-a1")).toBeNull();
    expect(view.getByTestId("composer-embed-lock").textContent).toBe("Session expired");
  });
});

describe("composer guards under a lock", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents-ui/?embed=1");
    resetEmbedModeCache();
    installEmbedBridge();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** Voice mode running on `activeAgentId` of server s1, or on nothing. */
  function fakeVoice(
    activeAgentId: string | null,
    overrides: Partial<EmbedComposerLockVoice> = {},
  ): EmbedComposerLockVoice & { stopVoice: ReturnType<typeof vi.fn> } {
    return {
      isVoiceSwitching: false,
      isVoiceModeForAgent: (serverId, agentId) => serverId === "s1" && agentId === activeAgentId,
      stopVoice: vi.fn(() => Promise.resolve()),
      ...overrides,
    } as EmbedComposerLockVoice & { stopVoice: ReturnType<typeof vi.fn> };
  }

  it("stops submit and queue only for the locked agent, and only while locked", () => {
    expect(isEmbedComposerLocked("a1")).toBe(false);

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true });

    expect(isEmbedComposerLocked("a1")).toBe(true);
    expect(isEmbedComposerLocked("a2")).toBe(false);

    post({ type: "maestro.composer.lock", agentId: "a1", locked: false });

    expect(isEmbedComposerLocked("a1")).toBe(false);
  });

  it("fails a send on the locked agent with the bar's label, lets the others through", () => {
    expect(() => assertEmbedComposerUnlocked("a1")).not.toThrow();

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true, label: "Not available" });

    expect(() => assertEmbedComposerUnlocked("a1")).toThrow(new Error("Not available"));
    expect(() => assertEmbedComposerUnlocked("a2")).not.toThrow();

    post({ type: "maestro.composer.lock", agentId: "a1", locked: false });

    expect(() => assertEmbedComposerUnlocked("a1")).not.toThrow();
  });

  it("flags the render while the agent is locked", () => {
    const view = renderHook(() =>
      useEmbedComposerLockGuard({ agentId: "a1", serverId: "s1", voice: null }),
    );
    expect(view.result.current).toBe(false);

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true });
    expect(view.result.current).toBe(true);

    post({ type: "maestro.composer.lock", agentId: "a2", locked: true });
    post({ type: "maestro.composer.lock", agentId: "a1", locked: false });
    expect(view.result.current).toBe(false);
  });

  it("stops voice mode on the agent when its lock arrives", () => {
    const voice = fakeVoice("a1");
    renderHook(() => useEmbedComposerLockGuard({ agentId: "a1", serverId: "s1", voice }));
    expect(voice.stopVoice).not.toHaveBeenCalled();

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true });

    expect(voice.stopVoice).toHaveBeenCalledTimes(1);
  });

  it("leaves voice mode alone on another agent, another host, or mid-switch", () => {
    const onOtherAgent = fakeVoice("a2");
    const onOtherHost = fakeVoice("a1");
    const switching = fakeVoice("a1", { isVoiceSwitching: true });
    renderHook(() =>
      useEmbedComposerLockGuard({ agentId: "a1", serverId: "s1", voice: onOtherAgent }),
    );
    renderHook(() =>
      useEmbedComposerLockGuard({ agentId: "a1", serverId: "s2", voice: onOtherHost }),
    );
    renderHook(() =>
      useEmbedComposerLockGuard({ agentId: "a1", serverId: "s1", voice: switching }),
    );

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true });

    expect(onOtherAgent.stopVoice).not.toHaveBeenCalled();
    expect(onOtherHost.stopVoice).not.toHaveBeenCalled();
    expect(switching.stopVoice).not.toHaveBeenCalled();
  });

  it("stops voice mode that starts on an agent already locked", () => {
    post({ type: "maestro.composer.lock", agentId: "a1", locked: true });
    const idle = fakeVoice(null);
    const view = renderHook(
      ({ voice }) => useEmbedComposerLockGuard({ agentId: "a1", serverId: "s1", voice }),
      { initialProps: { voice: idle } },
    );
    expect(idle.stopVoice).not.toHaveBeenCalled();

    const started = fakeVoice("a1");
    view.rerender({ voice: started });

    expect(started.stopVoice).toHaveBeenCalledTimes(1);
  });

  it("reports a voice stop that fails instead of swallowing it", async () => {
    const failure = new Error("voice runtime gone");
    const voice = fakeVoice("a1", { stopVoice: vi.fn(() => Promise.reject(failure)) });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderHook(() => useEmbedComposerLockGuard({ agentId: "a1", serverId: "s1", voice }));

    post({ type: "maestro.composer.lock", agentId: "a1", locked: true });

    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(
        "[Composer] Failed to stop voice mode on a locked composer",
        failure,
      );
    });
  });
});

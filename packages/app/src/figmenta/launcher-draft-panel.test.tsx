// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installEmbedBridge, resetEmbedModeCache } from "./embed";
import { EMBED_SESSION_CLOSED_MESSAGE } from "./launcher-lock";

// The panel module is compiled with the classic JSX runtime here: it needs a global React.
(globalThis as { React?: typeof React }).React = React;

const { EmbedDraftGate } = await import("./launcher-closed-notice");
const { generateDraftId } = await import("@/stores/draft-keys");
const { Text } = await import("react-native");

/** What `AgentConversationPanel` renders for a `draft` tab (panels/agent-panel.tsx). */
function DraftTab({ draftId }: { draftId: string }) {
  return (
    <EmbedDraftGate draftId={draftId}>
      <Text testID="draft-composer">draft composer</Text>
    </EmbedDraftGate>
  );
}

/** An id written by an earlier page into the persisted layout: never generated here. */
const RESTORED_DRAFT_ID = "draft_restored_from_layout";

function post(data: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin: window.location.origin, source: window.parent }),
  );
}

function enter(search: string): void {
  window.sessionStorage.clear();
  window.history.replaceState({}, "", `/agents-ui/${search}`);
  resetEmbedModeCache();
}

beforeEach(() => {
  enter("?embed=1");
  installEmbedBridge();
});

afterEach(() => {
  cleanup();
});

describe("draft tab under the launcher gate", () => {
  it("renders the notice for a draft restored from the layout in a locked embed", () => {
    const view = render(<DraftTab draftId={RESTORED_DRAFT_ID} />);
    expect(view.queryByTestId("draft-composer")).toBeNull();
    expect(view.getByText(EMBED_SESSION_CLOSED_MESSAGE)).toBeTruthy();

    act(() => post({ type: "maestro.launcher", allowed: true }));
    expect(view.getByTestId("draft-composer")).toBeTruthy();
  });

  it("renders a draft created in this page (the /clear flow) normally in a locked embed", () => {
    // /clear retargets the agent tab to `{ kind: "draft", draftId: generateDraftId() }`.
    const view = render(<DraftTab draftId={generateDraftId()} />);
    expect(view.getByTestId("draft-composer")).toBeTruthy();
    expect(view.queryByText(EMBED_SESSION_CLOSED_MESSAGE)).toBeNull();
  });

  it("renders a restored draft outside embed mode", () => {
    enter("");
    const view = render(<DraftTab draftId={RESTORED_DRAFT_ID} />);
    expect(view.getByTestId("draft-composer")).toBeTruthy();
  });
});

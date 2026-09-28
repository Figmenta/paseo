import { expect, test } from "../support/fixtures";
import {
  composerLocator,
  expectComposerVisible,
  fillComposerDraft,
} from "../support/helpers/composer";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";

const SHOTS = process.env.E2E_SHOTS_DIR ?? "test-results";

test("embed composer lock swaps the input for a read-only bar", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({ repoPrefix: "embed-lock-", title: "Embed lock" });
  const post = (data: Record<string, unknown>) =>
    page.evaluate((message) => window.postMessage(message, window.location.origin), data);

  try {
    await page.goto(`/h/${getServerId()}/agent/${agent.agentId}?embed=1`);
    await expectComposerVisible(page, { timeout: 60_000 });
    await fillComposerDraft(page, "draft before lock");
    await page.screenshot({ path: `${SHOTS}/1-unlocked.png` });

    await post({
      type: "maestro.composer.lock",
      agentId: agent.agentId,
      locked: true,
      label: null,
    });
    const bar = page.getByTestId("composer-embed-lock");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveText("Session expired");
    await expect(composerLocator(page)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/2-locked-default.png` });

    // Keyboard send shortcuts and an insert while locked must not reach the agent.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Meta+Enter");
    await post({ type: "maestro.composer.insert", agentId: agent.agentId, text: "/inserted" });

    await post({
      type: "maestro.composer.lock",
      agentId: agent.agentId,
      locked: true,
      label: "Resumed in another tab",
    });
    await expect(bar).toHaveText("Resumed in another tab");
    await page.screenshot({ path: `${SHOTS}/3-locked-label.png` });

    // A lock for another agent leaves this one alone.
    await post({ type: "maestro.composer.lock", agentId: "someone-else", locked: false });
    await expect(bar).toBeVisible();

    await post({ type: "maestro.composer.lock", agentId: agent.agentId, locked: false });
    await expect(bar).toHaveCount(0);
    await expectComposerVisible(page);
    await expect(composerLocator(page)).toHaveValue("draft before lock");
    await page.screenshot({ path: `${SHOTS}/4-unlocked-again.png` });
  } finally {
    await agent.cleanup();
  }
});

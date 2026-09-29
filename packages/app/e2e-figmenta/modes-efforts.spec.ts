/**
 * Figmenta «modes and effort decided by the owner» (T-3083), end to end on the real static export,
 * framed by a simulated Orchestra page, against an isolated daemon. Not part of upstream Paseo
 * (docs/FIGMENTA.md). Same harness as model-switch.spec.ts: read its header for how to rerun
 * (nothing here touches ~/.paseo or 127.0.0.1:6767); `FIGMENTA_E2E_ONLY=modes|modes-schedule`
 * runs one of the two tests below.
 *
 * The fleet person: Orchestra sends, for the named agent and as the person's default ("*"),
 * `modes: ["auto", "plan"]` and `efforts: ["low"]`. The agent was created before the owner decided
 * (Always Ask, Max): its menus narrow, its current mode and effort stay named on the triggers. The
 * draft `/clear` opens and the schedule form both start a new agent: they list only Plan and Auto,
 * only Low, and have Auto and Low selected. Nothing is ever submitted.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ORCHESTRA_ORIGIN,
  PARENT_PATH,
  SHOTS_DIR,
  chat,
  chatFrame,
  prepareContext,
  seedClaudeAgent,
  shot,
  simLog,
  startIsolatedDaemon,
  type DefaultAllow,
  type IsolatedDaemon,
} from "./harness";

const ONLY = process.env.FIGMENTA_E2E_ONLY ?? "";
const SONNET_ONLY = ["claude-sonnet-5"];
const MODES = ["auto", "plan"];
const EFFORTS = ["low"];
const FLEET_DEFAULT: DefaultAllow = { models: SONNET_ONLY, modes: MODES, efforts: EFFORTS };
/** What the composer's mode menu shows for them, in the provider's order (formatted labels). */
const MODE_MENU = ["Plan mode", "Auto mode"];

test.describe.configure({ mode: "serial" });

let daemon: IsolatedDaemon | null = null;

test.beforeAll(() => {
  mkdirSync(SHOTS_DIR, { recursive: true });
  daemon = startIsolatedDaemon();
});

test.afterAll(() => {
  daemon?.stop();
});

/** The rows of the combobox the trigger opens, by label, in order; closed again after. */
async function menuLabels(page: Page, trigger: Locator, screenshot: string): Promise<string[]> {
  const frame = chat(page);
  await trigger.click();
  const menu = frame.getByTestId("combobox-desktop-container");
  await expect(menu).toBeVisible();
  const labels = await menu
    .locator('[role="button"][aria-label]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
  await page.screenshot({ path: path.join(SHOTS_DIR, screenshot) });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  return labels;
}

/** The command center's rows for `query` whose testID starts with `prefix`, by their last id. */
async function commandCenterRows(
  page: Page,
  query: string,
  prefix: string,
  screenshot: string,
): Promise<string[]> {
  const frame = chat(page);
  await frame.getByRole("textbox", { name: "Message agent..." }).first().click();
  await page.keyboard.press("ControlOrMeta+K");
  const input = frame.getByTestId("command-center-input").first();
  await expect(input).toBeVisible();
  await input.fill(query);
  await expect(frame.getByTestId("command-center-results").first()).toBeVisible();
  const ids = await frame
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute("data-testid") ?? "").split(":").pop() ?? ""),
    );
  await page.screenshot({ path: path.join(SHOTS_DIR, screenshot) });
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  return ids;
}

/** The handshake's answer reached a listening bridge: the lists are in force. */
async function waitForAllowInForce(page: Page): Promise<void> {
  await expect
    .poll(async () => (await simLog(page)).filter((entry) => entry.kind === "ready").length, {
      timeout: 90_000,
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() =>
      chatFrame(page).evaluate(() =>
        (
          window as unknown as {
            __embedProbe: {
              received: Array<{
                data: { type?: string; modes?: unknown } | null;
                bridgeListening: boolean;
              }>;
            };
          }
        ).__embedProbe.received.some(
          (entry) =>
            entry.data?.type === "maestro.models.allow" &&
            entry.data.modes !== undefined &&
            entry.bridgeListening,
        ),
      ),
    )
    .toBe(true);
}

test("modes: the agent's menus narrow, /clear starts a draft on Auto and Low", async ({
  browser,
}) => {
  test.skip(ONLY !== "" && ONLY !== "modes", `FIGMENTA_E2E_ONLY=${ONLY}`);
  test.setTimeout(300_000);
  // Created before the owner decided: Always Ask, Max. /clear archives it.
  const seeded = await seedClaudeAgent({ modeId: "default", thinkingOptionId: "max" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareContext(context, {
    serverId: daemon!.serverId,
    agentId: seeded.agentId,
    models: SONNET_ONLY,
    modes: MODES,
    efforts: EFFORTS,
    defaultAllow: FLEET_DEFAULT,
    timing: { repostAfterMs: 30 * 60_000, answerReady: true },
  });
  const page = await context.newPage();
  const frame = chat(page);
  const modeTrigger = frame.getByTestId("mode-control").first();
  const effortTrigger = frame.getByTestId("agent-thinking-selector").first();
  const input = frame.getByRole("textbox", { name: "Message agent..." }).first();
  try {
    await page.goto(`${ORCHESTRA_ORIGIN}${PARENT_PATH}`);
    await expect(modeTrigger).toBeVisible({ timeout: 90_000 });
    await waitForAllowInForce(page);

    // The existing agent: only Plan and Auto, only Low; its own mode and effort still named.
    expect(await menuLabels(page, modeTrigger, "modes-1-agent-mode-menu.png")).toEqual(MODE_MENU);
    expect(await menuLabels(page, effortTrigger, "modes-2-agent-effort-menu.png")).toEqual(["Low"]);
    await expect(modeTrigger).toHaveAttribute("aria-label", /\(Always ask\)/);
    await expect(effortTrigger).toHaveAttribute("aria-label", /\(Max\)/);
    // The command center's mode group (planning modes live in the plan-mode toggle): Auto only.
    expect(
      await commandCenterRows(
        page,
        "mode",
        "command-center-mode-",
        "modes-3-agent-command-center.png",
      ),
    ).toEqual(["auto"]);
    await shot(page, "modes-4-agent.png");

    // /clear: the tab becomes a draft, which starts a new agent from the person's default.
    await expect(input).toBeEditable({ timeout: 30_000 });
    await input.fill("/clear");
    await expect(input).toHaveValue("/clear");
    await input.press("Enter");
    await expect(frame.getByTestId("composer-import-agent-pill")).toBeVisible({ timeout: 30_000 });
    await expect(modeTrigger).toHaveAttribute("aria-label", /\(Auto mode\)/);
    await expect(effortTrigger).toHaveAttribute("aria-label", /\(Low\)/);
    await shot(page, "modes-5-draft-selected.png");
    expect(await menuLabels(page, modeTrigger, "modes-6-draft-mode-menu.png")).toEqual(MODE_MENU);
    expect(await menuLabels(page, effortTrigger, "modes-7-draft-effort-menu.png")).toEqual(["Low"]);
  } finally {
    await context.close();
    await seeded.cleanup();
  }
});

test("modes-schedule: a new schedule's Thinking and Mode follow the default", async ({
  browser,
}) => {
  test.skip(ONLY !== "" && ONLY !== "modes-schedule", `FIGMENTA_E2E_ONLY=${ONLY}`);
  test.setTimeout(300_000);
  const seeded = await seedClaudeAgent();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareContext(context, {
    serverId: daemon!.serverId,
    agentId: seeded.agentId,
    models: SONNET_ONLY,
    modes: MODES,
    efforts: EFFORTS,
    defaultAllow: FLEET_DEFAULT,
    timing: { repostAfterMs: 30 * 60_000, answerReady: true },
  });
  const page = await context.newPage();
  const frame = chat(page);
  try {
    await page.goto(`${ORCHESTRA_ORIGIN}${PARENT_PATH}`);
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible({ timeout: 90_000 });
    await waitForAllowInForce(page);
    // command center -> schedules -> New schedule -> a project, as in model-switch.spec.ts.
    await frame.getByRole("textbox", { name: "Message agent..." }).first().click();
    await page.keyboard.press("ControlOrMeta+K");
    const input = frame.getByTestId("command-center-input").first();
    await expect(input).toBeVisible();
    await input.fill("schedules");
    await input.press("Enter");
    await expect.poll(() => chatFrame(page).url(), { timeout: 30_000 }).toContain("/schedules");
    await frame.getByText("New schedule").first().click();
    await expect(frame.getByTestId("schedule-form-sheet").first()).toBeVisible({ timeout: 30_000 });
    await frame.getByTestId("schedule-project-trigger").first().click();
    await frame.locator('[data-testid^="schedule-project-option-"]').first().click();
    // A fresh browser has no saved model: the person picks one, then Thinking and Mode appear.
    await frame.getByTestId("schedule-model-trigger").first().click();
    await frame.getByTestId("model-row-claude-claude-sonnet-5").first().click();

    const thinkingTrigger = frame.getByTestId("schedule-thinking-trigger").first();
    const modeTrigger = frame.getByTestId("schedule-mode-trigger").first();
    await expect(thinkingTrigger).toBeVisible({ timeout: 30_000 });
    await expect(modeTrigger).toBeVisible();
    // The form's selection was moved into the lists.
    await expect(thinkingTrigger).toHaveAttribute("aria-label", "Thinking (Low)");
    await expect(modeTrigger).toHaveAttribute("aria-label", "Mode (Auto mode)");
    await shot(page, "modes-schedule-1-form.png");

    await thinkingTrigger.click();
    const thinkingRows = frame.locator('[data-testid^="schedule-thinking-option-"]');
    await expect(thinkingRows.first()).toBeVisible();
    const thinkingIds = await thinkingRows.evaluateAll((nodes) =>
      nodes.map((node) =>
        (node.getAttribute("data-testid") ?? "").replace("schedule-thinking-option-", ""),
      ),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, "modes-schedule-2-thinking-menu.png") });
    expect(thinkingIds).toEqual(["low"]);
    await page.keyboard.press("Escape");
    await expect(thinkingRows).toHaveCount(0);

    // The schedule's Mode field lists the provider's raw labels.
    expect(await menuLabels(page, modeTrigger, "modes-schedule-3-mode-menu.png")).toEqual([
      "Plan Mode",
      "Auto mode",
    ]);
  } finally {
    await context.close();
    await seeded.cleanup();
  }
});

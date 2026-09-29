/**
 * Figmenta «model switch» (T-3083), end to end on the real static export, framed by a simulated
 * Orchestra page, against an isolated daemon. Not part of upstream Paseo (docs/FIGMENTA.md).
 *
 * HOW TO RERUN (from the repo root; nothing here touches ~/.paseo or 127.0.0.1:6767):
 *
 *   npm run build:server                      # only if packages/server or packages/cli changed
 *   PASEO_WEB_BASE_URL=/agents-ui npm run build --workspace=@getpaseo/app
 *   cd packages/app && npx playwright test --config e2e-figmenta/playwright.config.ts
 *
 * Knobs (env): FIGMENTA_EMBED_DIST (default packages/app/dist: point it at another export to
 * measure an older build), FIGMENTA_E2E_REPOST_MS (default 60000, Orchestra's state poll),
 * FIGMENTA_E2E_HOME (default /tmp/ph-model-switch), FIGMENTA_E2E_LISTEN (default 127.0.0.1:6869),
 * FIGMENTA_E2E_SHOTS (screenshots and measurement JSON, default packages/app/test-results/e2e-figmenta),
 * FIGMENTA_E2E_ONLY=timing|contract|draft|schedule to run one of the four tests.
 *
 * The daemon is started with `paseo daemon start --home <home>` and stopped with
 * `paseo daemon stop --home <home>` in afterAll, pass or fail. The agent is a Claude agent whose
 * binary is a stub that only answers `--version` (see harness.ts): the menu is the real Claude
 * manifest, no Claude Code runs, no credential is read, and the agent is never prompted. The
 * "draft" test seeds its own two agents: `/clear` archives the first one, and its draft is never
 * submitted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Frame, type FrameLocator, type Page } from "@playwright/test";
import {
  ORCHESTRA_ORIGIN,
  PARENT_PATH,
  SHOTS_DIR,
  EMBED_DIST,
  prepareContext,
  seedClaudeAgent,
  startIsolatedDaemon,
  type DefaultAllow,
  type IsolatedDaemon,
  type SeededAgent,
} from "./harness";

const REPOST_MS = Number(process.env.FIGMENTA_E2E_REPOST_MS ?? "60000");
const ONLY = process.env.FIGMENTA_E2E_ONLY ?? "";
const SONNET_ONLY = ["claude-sonnet-5"];
/** Any model name or id the composer could show: none may be on screen while hidden. */
const MODEL_NAMES = /Sonnet|Opus|Fable|Haiku|claude-/;

test.describe.configure({ mode: "serial" });

let daemon: IsolatedDaemon | null = null;
let agent: SeededAgent | null = null;

test.beforeAll(async () => {
  mkdirSync(SHOTS_DIR, { recursive: true });
  daemon = startIsolatedDaemon();
  agent = await seedClaudeAgent();
});

test.afterAll(async () => {
  try {
    await agent?.cleanup();
  } finally {
    daemon?.stop();
  }
});

interface SimLogEntry {
  at: number;
  kind: "load" | "post" | "ready";
  reason?: string;
  fromFrame?: boolean;
  msg?: Record<string, unknown>;
}

interface EmbedProbe {
  bridgeInstalledAt: number | null;
  received: Array<{ at: number; data: { type?: string } | null; bridgeListening: boolean }>;
}

function chat(page: Page): FrameLocator {
  return page.frameLocator("#chat");
}

function chatFrame(page: Page): Frame {
  const frame = page
    .frames()
    .find((entry) => new URL(entry.url()).pathname.startsWith("/agents-ui"));
  if (!frame) throw new Error("The embed frame is not attached");
  return frame;
}

async function simLog(page: Page): Promise<SimLogEntry[]> {
  return page.evaluate(
    () => (window as unknown as { __orchestraSim: { log: SimLogEntry[] } }).__orchestraSim.log,
  );
}

async function embedProbe(page: Page): Promise<EmbedProbe> {
  return chatFrame(page).evaluate(
    () => (window as unknown as { __embedProbe: EmbedProbe }).__embedProbe,
  );
}

async function simSetAndPost(
  page: Page,
  next: { models?: string[]; hidden?: boolean; defaultAllow?: DefaultAllow | null },
  reason: string,
): Promise<void> {
  await page.evaluate(
    ({ state, why }) => {
      const sim = (
        window as unknown as {
          __orchestraSim: { set(next: unknown): void; post(reason: string): void };
        }
      ).__orchestraSim;
      sim.set(state);
      sim.post(why);
    },
    { state: next, why: reason },
  );
}

/** The model rows the open menu lists, by model id, in order. */
async function openMenuRows(page: Page, screenshot: string): Promise<string[]> {
  const frame = chat(page);
  await frame.getByTestId("combined-model-selector").first().click();
  const rows = frame.locator('[data-testid^="model-row-claude-"]');
  await expect(rows.first()).toBeVisible();
  const ids = await rows.evaluateAll((nodes) =>
    nodes.map((node) => (node.getAttribute("data-testid") ?? "").replace("model-row-claude-", "")),
  );
  await page.screenshot({ path: path.join(SHOTS_DIR, screenshot) });
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(0);
  return ids;
}

/** Parks the pointer off the composer, so no hover tooltip sits in the screenshot. */
async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(SHOTS_DIR, name) });
}

async function openParent(page: Page): Promise<void> {
  await page.goto(`${ORCHESTRA_ORIGIN}${PARENT_PATH}`);
  // The composer of the agent is on screen: its model trigger shows the current model.
  await expect(chat(page).getByTestId("combined-model-selector").first()).toBeVisible({
    timeout: 90_000,
  });
}

test("timing: Orchestra posting at the frame load and on the 60 s poll only (no handshake)", async ({
  browser,
}) => {
  test.skip(ONLY !== "" && ONLY !== "timing", `FIGMENTA_E2E_ONLY=${ONLY}`);
  test.setTimeout(REPOST_MS + 180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareContext(context, {
    serverId: daemon!.serverId,
    agentId: agent!.agentId,
    models: SONNET_ONLY,
    timing: { repostAfterMs: REPOST_MS, answerReady: false },
  });
  const page = await context.newPage();
  try {
    await openParent(page);
    const rowsBeforePoll = await openMenuRows(page, "timing-1-before-poll.png");
    const logBeforePoll = await simLog(page);

    const loadAt = logBeforePoll.find((entry) => entry.kind === "load")?.at ?? 0;
    await expect
      .poll(async () => (await simLog(page)).some((entry) => entry.reason === "poll"), {
        timeout: REPOST_MS + 30_000,
        intervals: [1000],
      })
      .toBe(true);
    const rowsAfterPoll = await openMenuRows(page, "timing-2-after-poll.png");
    const probe = await embedProbe(page);
    const log = await simLog(page);

    const measurement = {
      build: EMBED_DIST,
      repostAfterMs: REPOST_MS,
      frameLoadAt: loadAt,
      bridgeInstalledAt: probe.bridgeInstalledAt,
      bridgeInstalledAfterLoadMs:
        probe.bridgeInstalledAt === null ? null : probe.bridgeInstalledAt - loadAt,
      parentLog: log,
      frameReceived: probe.received
        .filter((entry) => entry.data?.type?.startsWith("maestro."))
        .map((entry) => ({
          at: entry.at,
          sinceLoadMs: entry.at - loadAt,
          bridgeListening: entry.bridgeListening,
          data: entry.data,
        })),
      rowsBeforePoll,
      rowsAfterPoll,
    };
    writeFileSync(
      path.join(SHOTS_DIR, "timing-measurement.json"),
      `${JSON.stringify(measurement, null, 2)}\n`,
    );
    console.log(JSON.stringify(measurement, null, 2));

    // Whatever the load-time post did, the poll's post reaches a listening bridge and narrows it.
    expect(rowsAfterPoll).toEqual(SONNET_ONLY);
  } finally {
    await context.close();
  }
});

test("contract: embed.ready handshake, allow list, hidden, shown again", async ({ browser }) => {
  test.skip(ONLY !== "" && ONLY !== "contract", `FIGMENTA_E2E_ONLY=${ONLY}`);
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareContext(context, {
    serverId: daemon!.serverId,
    agentId: agent!.agentId,
    models: SONNET_ONLY,
    // The poll is pushed out of the test's reach: only the handshake can deliver the list.
    timing: { repostAfterMs: 30 * 60_000, answerReady: true },
  });
  const page = await context.newPage();
  const frame = chat(page);
  try {
    await openParent(page);

    // (iv) the frame announced itself to the parent, once, after its listener was up.
    await expect
      .poll(async () => (await simLog(page)).filter((entry) => entry.kind === "ready").length)
      .toBe(1);
    const ready = (await simLog(page)).find((entry) => entry.kind === "ready");
    expect(ready?.fromFrame).toBe(true);
    const probe = await embedProbe(page);
    expect(probe.bridgeInstalledAt).not.toBeNull();
    expect(ready!.at).toBeGreaterThanOrEqual(probe.bridgeInstalledAt!);
    // The answer to the handshake reached a listening bridge.
    const answered = probe.received.filter(
      (entry) => entry.data?.type === "maestro.models.allow" && entry.bridgeListening,
    );
    expect(answered.length).toBeGreaterThanOrEqual(1);

    // (i) the menu lists only Sonnet 5, long before any poll.
    expect(await openMenuRows(page, "contract-1-allow-sonnet.png")).toEqual(SONNET_ONLY);
    const trigger = frame.getByTestId("combined-model-selector");
    await expect(trigger).toHaveText(/Sonnet 5/);

    // (ii) hidden: no model trigger, no model name; effort and permission mode stay.
    await simSetAndPost(page, { hidden: true }, "checkbox-off");
    await expect(trigger).toHaveCount(0);
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible();
    await expect(frame.getByTestId("mode-control")).toBeVisible();
    const composerText = await frame.locator("body").innerText();
    expect(composerText).not.toMatch(MODEL_NAMES);
    await shot(page, "contract-2-hidden-desktop.png");

    // (ii, compact) the same on the compact form factor: the sheet trigger carried the model name.
    await page.setViewportSize({ width: 420, height: 820 });
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible();
    await expect(trigger).toHaveCount(0);
    expect(await frame.locator("body").innerText()).not.toMatch(MODEL_NAMES);
    await shot(page, "contract-3-hidden-compact.png");

    // (iii) hidden:false again: the trigger comes back, still narrowed by the list.
    await simSetAndPost(page, { hidden: false }, "checkbox-on");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText(/Sonnet 5/);
    await shot(page, "contract-4-shown-compact.png");
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(trigger).toBeVisible();
    expect(await openMenuRows(page, "contract-5-shown-desktop.png")).toEqual(SONNET_ONLY);

    // A reload of the frame is a fresh document: a fresh install, a second ready, the state back.
    await simSetAndPost(page, { hidden: true }, "checkbox-off-before-reload");
    await expect(trigger).toHaveCount(0);
    await chatFrame(page).evaluate(() => window.location.reload());
    await expect
      .poll(async () => (await simLog(page)).filter((entry) => entry.kind === "ready").length, {
        timeout: 90_000,
      })
      .toBe(2);
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible({ timeout: 90_000 });
    await expect(trigger).toHaveCount(0);
    await shot(page, "contract-6-hidden-after-reload.png");

    writeFileSync(
      path.join(SHOTS_DIR, "contract-log.json"),
      `${JSON.stringify({ parentLog: await simLog(page), probe: await embedProbe(page) }, null, 2)}\n`,
    );
  } finally {
    await context.close();
  }
});

/**
 * The command center's model rows for the query "model", by model id; the panel is closed again
 * after. The model group is query-only, and "model" is in its keywords: an empty result means the
 * group has no rows, not that the query missed it (the shown case below proves the same query).
 */
async function commandCenterModelRows(page: Page, screenshot: string): Promise<string[]> {
  const frame = chat(page);
  await frame.getByRole("textbox", { name: "Message agent..." }).first().click();
  await page.keyboard.press("ControlOrMeta+K");
  const input = frame.getByTestId("command-center-input").first();
  await expect(input).toBeVisible();
  await input.fill("model");
  await expect(frame.getByTestId("command-center-results").first()).toBeVisible();
  const rows = frame.locator('[data-testid^="command-center-model-"]');
  const ids = await rows.evaluateAll((nodes) =>
    nodes.map((node) => (node.getAttribute("data-testid") ?? "").split(":").pop() ?? ""),
  );
  await page.screenshot({ path: path.join(SHOTS_DIR, screenshot) });
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  return ids;
}

test('draft: /clear and unnamed agents follow the person\'s default (agentId "*")', async ({
  browser,
}) => {
  test.skip(ONLY !== "" && ONLY !== "draft", `FIGMENTA_E2E_ONLY=${ONLY}`);
  test.setTimeout(300_000);
  // Its own agents: /clear archives the first, the second is one Orchestra never names.
  const cleared = await seedClaudeAgent();
  const unnamed = await seedClaudeAgent();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareContext(context, {
    serverId: daemon!.serverId,
    agentId: cleared.agentId,
    models: SONNET_ONLY,
    // A fleet person with the switch off: the agent hidden, and the person's default hidden.
    hidden: true,
    defaultAllow: { models: [], hidden: true },
    timing: { repostAfterMs: 30 * 60_000, answerReady: true },
  });
  const page = await context.newPage();
  const frame = chat(page);
  const trigger = frame.getByTestId("combined-model-selector");
  const input = frame.getByRole("textbox", { name: "Message agent..." }).first();
  try {
    await page.goto(`${ORCHESTRA_ORIGIN}${PARENT_PATH}`);
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(async () => (await simLog(page)).filter((entry) => entry.kind === "ready").length)
      .toBe(1);
    await expect(trigger).toHaveCount(0);
    expect(await frame.locator("body").innerText()).not.toMatch(MODEL_NAMES);
    await shot(page, "draft-1-agent-hidden.png");

    // /clear: the agent is archived, its tab becomes a draft (agent-panel.tsx, the path B1 found).
    await expect(input).toBeEditable({ timeout: 30_000 });
    await input.fill("/clear");
    await expect(input).toHaveValue("/clear");
    await input.press("Enter");
    // The draft marker: the import pill lives only on a draft composer.
    await expect(frame.getByTestId("composer-import-agent-pill")).toBeVisible({ timeout: 30_000 });
    const draftUrl = chatFrame(page).url();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible();
    await expect(frame.getByTestId("mode-control")).toBeVisible();
    await expect(trigger).toHaveCount(0);
    expect(await frame.locator("body").innerText()).not.toMatch(MODEL_NAMES);
    await shot(page, "draft-2-cleared-hidden-desktop.png");
    expect(await commandCenterModelRows(page, "draft-3-cleared-hidden-command-center.png")).toEqual(
      [],
    );

    // Compact form factor: the draft's model sheet trigger carried the model name.
    await page.setViewportSize({ width: 420, height: 820 });
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible();
    await expect(trigger).toHaveCount(0);
    expect(await frame.locator("body").innerText()).not.toMatch(MODEL_NAMES);
    await shot(page, "draft-4-cleared-hidden-compact.png");
    await page.setViewportSize({ width: 1280, height: 800 });

    // The default, shown and narrowed: the draft menu and its command center list Sonnet 5 only.
    await simSetAndPost(page, { defaultAllow: { models: SONNET_ONLY } }, "default-sonnet");
    await expect(trigger).toBeVisible();
    expect(await openMenuRows(page, "draft-5-default-sonnet-menu.png")).toEqual(SONNET_ONLY);
    expect(await commandCenterModelRows(page, "draft-6-default-sonnet-command-center.png")).toEqual(
      SONNET_ONLY,
    );

    // An agent Orchestra never names (what the draft creates, or a session switch) takes it too.
    await page.evaluate(
      (agentId) =>
        (
          window as unknown as { __orchestraSim: { openUnnamed(id: string): void } }
        ).__orchestraSim.openUnnamed(agentId),
      unnamed.agentId,
    );
    await expect
      .poll(async () => (await simLog(page)).filter((entry) => entry.kind === "ready").length, {
        timeout: 90_000,
      })
      .toBe(2);
    await expect(trigger).toBeVisible({ timeout: 90_000 });
    // The agent route resolves to that agent's own workspace: not the draft, not its workspace.
    await expect(frame.getByTestId("composer-import-agent-pill")).toHaveCount(0);
    expect(chatFrame(page).url()).not.toBe(draftUrl);
    expect(await openMenuRows(page, "draft-7-unnamed-agent-sonnet.png")).toEqual(SONNET_ONLY);
    await simSetAndPost(page, { defaultAllow: { models: [], hidden: true } }, "default-hidden");
    await expect(trigger).toHaveCount(0);
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible();
    expect(await frame.locator("body").innerText()).not.toMatch(MODEL_NAMES);
    await shot(page, "draft-8-unnamed-agent-hidden.png");

    writeFileSync(
      path.join(SHOTS_DIR, "draft-log.json"),
      `${JSON.stringify({ parentLog: await simLog(page), probe: await embedProbe(page) }, null, 2)}\n`,
    );
  } finally {
    await context.close();
    await cleared.cleanup();
    await unnamed.cleanup();
  }
});

test("schedule: a new schedule's model field follows the person's default (agentId \"*\")", async ({
  browser,
}) => {
  test.skip(ONLY !== "" && ONLY !== "schedule", `FIGMENTA_E2E_ONLY=${ONLY}`);
  test.setTimeout(300_000);
  const seeded = await seedClaudeAgent();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareContext(context, {
    serverId: daemon!.serverId,
    agentId: seeded.agentId,
    models: SONNET_ONLY,
    hidden: true,
    defaultAllow: { models: [], hidden: true },
    timing: { repostAfterMs: 30 * 60_000, answerReady: true },
  });
  const page = await context.newPage();
  const frame = chat(page);
  try {
    await page.goto(`${ORCHESTRA_ORIGIN}${PARENT_PATH}`);
    await expect(frame.getByTestId("agent-thinking-selector")).toBeVisible({ timeout: 90_000 });
    // The route the review found: command center -> schedules -> New schedule -> a project.
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
    // Hidden default: the form has a project, and still no model field, no model name.
    await expect(frame.getByTestId("schedule-archive-on-finish-switch").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(frame.getByTestId("schedule-model-trigger")).toHaveCount(0);
    expect(await frame.getByTestId("schedule-form-sheet").first().innerText()).not.toMatch(
      MODEL_NAMES,
    );
    await shot(page, "schedule-1-hidden.png");

    // Shown and narrowed: the model field lists Sonnet 5 only.
    await simSetAndPost(page, { defaultAllow: { models: SONNET_ONLY } }, "default-sonnet");
    const modelTrigger = frame.getByTestId("schedule-model-trigger").first();
    await expect(modelTrigger).toBeVisible({ timeout: 30_000 });
    await modelTrigger.click();
    const rows = frame.locator('[data-testid^="model-row-claude-"]');
    await expect(rows.first()).toBeVisible();
    const ids = await rows.evaluateAll((nodes) =>
      nodes.map((node) =>
        (node.getAttribute("data-testid") ?? "").replace("model-row-claude-", ""),
      ),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, "schedule-2-default-sonnet-menu.png") });
    expect(ids).toEqual(SONNET_ONLY);
    await page.keyboard.press("Escape");
  } finally {
    await context.close();
    await seeded.cleanup();
  }
});

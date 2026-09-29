/**
 * Figmenta embed harness: the static web export, framed by a page that plays Orchestra, talking to
 * an ISOLATED daemon. Not part of upstream Paseo (docs/FIGMENTA.md). No Metro, no dev server, no
 * simulator: the bytes under test are `packages/app/dist` (or `FIGMENTA_EMBED_DIST`), exactly what
 * Orchestra serves under `/agents-ui`.
 *
 * - The Orchestra origin is simulated with Playwright request routing: nothing leaves the machine
 *   for `https://orchestra.figmenta.site`, the page and the export are fulfilled from here.
 * - The daemon is started with the repo's own CLI in its own PASEO_HOME, on its own port. Every
 *   provider but Claude is disabled in that home, and Claude's command is a stub written into that
 *   home: it answers `--version` and refuses everything else. The catalog is therefore the real
 *   Claude manifest (what production shows) with no Claude Code install, no credential and no token
 *   involved. CLAUDE_CONFIG_DIR points into the same home, so no operator setting is read either.
 * - The agent is a Claude agent created WITHOUT an initial prompt and never prompted; `/clear` turns
 *   it into a draft that is never submitted.
 * - The operator's daemon (127.0.0.1:6767) is refused at the network layer, HTTP and WebSocket.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { BrowserContext, Route } from "@playwright/test";
import { createNodeWebSocketFactory } from "../e2e/support/helpers/node-ws-factory";

export const ORCHESTRA_ORIGIN = "https://orchestra.figmenta.site";
export const PARENT_PATH = "/maestro-sim";

const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "../..");
const CLI_BIN = path.join(REPO_ROOT, "packages/cli/bin/paseo");

export const DAEMON_HOME = process.env.FIGMENTA_E2E_HOME ?? "/tmp/ph-model-switch";
export const DAEMON_LISTEN = process.env.FIGMENTA_E2E_LISTEN ?? "127.0.0.1:6869";
export const EMBED_DIST = path.resolve(
  process.env.FIGMENTA_EMBED_DIST ?? path.join(APP_ROOT, "dist"),
);
export const SHOTS_DIR = path.resolve(
  process.env.FIGMENTA_E2E_SHOTS ?? path.join(APP_ROOT, "test-results/e2e-figmenta"),
);

/**
 * Stands in for the Claude Code binary. The version is synthetic: high enough for every entry of the
 * manifest (Opus 5.5 needs 2.1.280), so the menu lists what a current install lists.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.283 (Claude Code)"; exit 0; fi
echo "fake claude (figmenta e2e): refusing to run $*" >&2
exit 1
`;

const DISABLED_PROVIDERS = ["codex", "copilot", "opencode", "pi", "omp"];

function refuseOperatorDaemon(): void {
  const operatorHome = path.join(homedir(), ".paseo");
  if (path.resolve(DAEMON_HOME) === operatorHome) {
    throw new Error(`Refusing to run against the operator's PASEO_HOME (${operatorHome}).`);
  }
  if (DAEMON_LISTEN.endsWith(":6767")) {
    throw new Error("Refusing to listen on 6767: that port belongs to the operator's daemon.");
  }
}

const FAKE_CLAUDE_PATH = path.join(DAEMON_HOME, "fake-claude");
const CLAUDE_CONFIG_DIR = path.join(DAEMON_HOME, "claude-config");

function writeDaemonConfig(): void {
  mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(FAKE_CLAUDE_PATH, FAKE_CLAUDE, { mode: 0o755 });
  const providers: Record<string, unknown> = Object.fromEntries(
    DISABLED_PROVIDERS.map((id) => [id, { enabled: false }]),
  );
  providers.claude = {
    command: [FAKE_CLAUDE_PATH],
    env: { CLAUDE_CONFIG_DIR },
  };
  const config = {
    version: 1,
    daemon: {
      listen: DAEMON_LISTEN,
      cors: { allowedOrigins: [ORCHESTRA_ORIGIN] },
      relay: { enabled: false },
      mcp: { enabled: false, injectIntoAgents: false },
    },
    pluginsEnabled: false,
    agents: { providers },
  };
  writeFileSync(path.join(DAEMON_HOME, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI_BIN, ...args, "--home", DAEMON_HOME], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PASEO_HOME: DAEMON_HOME,
      PASEO_LISTEN: DAEMON_LISTEN,
      // Whatever reads Claude's config in the daemon itself reads the isolated one.
      CLAUDE_CONFIG_DIR,
    },
    timeout: 120_000,
  });
}

export interface IsolatedDaemon {
  serverId: string;
  stop(): void;
}

export function startIsolatedDaemon(): IsolatedDaemon {
  refuseOperatorDaemon();
  writeDaemonConfig();
  runCli(["daemon", "start"]);
  const serverIdPath = path.join(DAEMON_HOME, "server-id");
  if (!existsSync(serverIdPath)) throw new Error(`No server-id in ${DAEMON_HOME} after start`);
  const serverId = readFileSync(serverIdPath, "utf8").trim();
  return {
    serverId,
    stop: () => {
      runCli(["daemon", "stop"]);
    },
  };
}

interface HarnessDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  createWorkspace(input: { source: { kind: "directory"; path: string }; title?: string }): Promise<{
    workspace: { id: string; projectId: string } | null;
    error: string | null;
  }>;
  removeProject(projectId: string): Promise<unknown>;
  createAgent(options: {
    provider: string;
    cwd: string;
    workspaceId?: string;
    title?: string;
    modeId?: string;
    model?: string;
    thinkingOptionId?: string;
  }): Promise<{ id: string }>;
}

async function connectClient(): Promise<HarnessDaemonClient> {
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, "packages/client/dist/daemon-client.js"));
  const mod = (await import(moduleUrl.href)) as {
    DaemonClient: new (config: Record<string, unknown>) => HarnessDaemonClient;
  };
  const appVersion = (
    JSON.parse(readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as { version: string }
  ).version;
  const client = new mod.DaemonClient({
    url: `ws://${DAEMON_LISTEN}/ws`,
    clientId: `figmenta-e2e-${randomUUID()}`,
    clientType: "cli",
    appVersion,
    webSocketFactory: createNodeWebSocketFactory(),
  });
  await client.connect();
  return client;
}

export interface SeededAgent {
  agentId: string;
  cleanup(): Promise<void>;
}

/**
 * A Claude agent on Sonnet 5, as a fleet session of class `normal` runs, created without an
 * initial prompt: it never runs a turn.
 */
export async function seedClaudeAgent(): Promise<SeededAgent> {
  const dir = await mkdtemp(path.join(tmpdir(), "figmenta-model-switch-"));
  await writeFile(path.join(dir, "README.md"), "# model switch e2e\n");
  const client = await connectClient();
  try {
    const created = await client.createWorkspace({
      source: { kind: "directory", path: dir },
      title: "Embed e2e",
    });
    if (!created.workspace) throw new Error(created.error ?? "createWorkspace failed");
    const workspace = created.workspace;
    const agent = await client.createAgent({
      provider: "claude",
      cwd: dir,
      workspaceId: workspace.id,
      title: "Embed e2e",
      model: "claude-sonnet-5",
    });
    return {
      agentId: agent.id,
      cleanup: async () => {
        await client.removeProject(workspace.projectId).catch(() => undefined);
        await client.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Orchestra's person-level default: `maestro.models.allow` with agentId "*". */
export interface DefaultAllow {
  models: string[];
  hidden?: boolean;
}

/** How the simulated Orchestra page behaves. */
export interface ParentTiming {
  /** Re-post after this many ms from the frame's load (Orchestra: the 60 s state poll). */
  repostAfterMs: number;
  /** Answer `maestro.embed.ready` by re-posting (the new contract). */
  answerReady: boolean;
}

interface ParentInput {
  serverId: string;
  agentId: string;
  models: string[];
  /** The agent's `hidden` at load; absent = not sent. */
  hidden?: boolean;
  /** The person's default at load; absent = no "*" message, as before the default existed. */
  defaultAllow?: DefaultAllow;
  timing: ParentTiming;
}

function parentHtml(input: ParentInput): string {
  const src = `/agents-ui/h/${encodeURIComponent(input.serverId)}/agent/${encodeURIComponent(input.agentId)}?embed=1&theme=dark`;
  const boot = JSON.stringify({ ...input, src });
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Orchestra (simulated)</title>
<style>html,body{margin:0;height:100%;background:#111;color:#ddd;font:12px system-ui}
#chat{border:0;width:100%;height:calc(100% - 24px)}#bar{height:24px;padding:4px 8px}</style>
</head><body><div id="bar">Orchestra (simulated) — parent of the embed</div>
<iframe id="chat" title="Session"></iframe>
<script>
(() => {
  const boot = ${boot};
  const frame = document.getElementById("chat");
  const log = [];
  // What the page would send now, for this agent and as the person's default ("*"): tests
  // change it to play the checkbox. defaultAllow null = no "*" message.
  const state = {
    models: boot.models,
    hidden: boot.hidden,
    defaultAllow: boot.defaultAllow ?? null,
  };
  function send(msg, reason) {
    frame.contentWindow.postMessage(msg, window.location.origin);
    log.push({ at: Date.now(), kind: "post", reason, msg });
  }
  function post(reason) {
    if (!frame.contentWindow) return;
    const msg = { type: "maestro.models.allow", agentId: boot.agentId, models: state.models };
    if (state.hidden !== undefined) msg.hidden = state.hidden;
    send(msg, reason);
    if (!state.defaultAllow) return;
    const fallback = { type: "maestro.models.allow", agentId: "*", models: state.defaultAllow.models };
    if (state.defaultAllow.hidden !== undefined) fallback.hidden = state.defaultAllow.hidden;
    send(fallback, reason);
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== "maestro.embed.ready") return;
    log.push({ at: Date.now(), kind: "ready", fromFrame: event.source === frame.contentWindow });
    if (boot.timing.answerReady) post("ready");
  });
  frame.addEventListener("load", () => {
    log.push({ at: Date.now(), kind: "load" });
    post("load");
    setTimeout(() => post("poll"), boot.timing.repostAfterMs);
  });
  window.__orchestraSim = {
    log,
    state,
    post,
    set(next) { Object.assign(state, next); },
    // Load another agent in the frame, as a session switch would, WITHOUT naming it: the
    // per-agent message keeps naming boot.agentId, so this one only has the "*" default.
    openUnnamed(agentId) {
      frame.src = "/agents-ui/h/" + encodeURIComponent(boot.serverId) + "/agent/" +
        encodeURIComponent(agentId) + "?embed=1&theme=dark";
    },
  };
  frame.src = boot.src;
})();
</script></body></html>`;
}

/**
 * Runs in every document, parent and frame. In the frame it records, with wall-clock times
 * comparable across documents, when the embed bridge installs itself and every message the frame
 * receives, with whether the bridge was already listening when it arrived.
 */
function frameProbe(): void {
  if (!window.location.pathname.startsWith("/agents-ui")) return;
  const probe = {
    bridgeInstalledAt: null as number | null,
    received: [] as Array<{ at: number; data: unknown; bridgeListening: boolean }>,
  };
  (window as unknown as { __embedProbe: typeof probe }).__embedProbe = probe;
  let flag: unknown;
  Object.defineProperty(window, "__figmentaEmbedBridgeInstalled", {
    configurable: true,
    get: () => flag,
    set: (value) => {
      flag = value;
      if (value && probe.bridgeInstalledAt === null) probe.bridgeInstalledAt = Date.now();
    },
  });
  // Registered before any app code: it sees every message, including the ones the app missed.
  window.addEventListener("message", (event) => {
    probe.received.push({
      at: Date.now(),
      data: event.data,
      bridgeListening: probe.bridgeInstalledAt !== null,
    });
  });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function serveExport(route: Route, pathname: string): Promise<void> {
  const rel = decodeURIComponent(pathname.replace(/^\/agents-ui\/?/, ""));
  const candidate = path.resolve(EMBED_DIST, rel);
  const inside = candidate.startsWith(`${EMBED_DIST}${path.sep}`);
  // `output: "single"`: every client route is the one index.html, as Orchestra's byte server does.
  const file = inside && rel.length > 0 && existsSync(candidate) ? candidate : null;
  const target = file ?? path.join(EMBED_DIST, "index.html");
  return route.fulfill({
    status: 200,
    contentType: TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
    body: readFileSync(target),
  });
}

/** Wires a fresh browser context: Orchestra simulated, the operator's daemon unreachable. */
export async function prepareContext(context: BrowserContext, input: ParentInput): Promise<void> {
  if (!existsSync(path.join(EMBED_DIST, "index.html"))) {
    throw new Error(`No export at ${EMBED_DIST}: build it first (see the spec header).`);
  }
  await context.grantPermissions(["local-network-access"], { origin: ORCHESTRA_ORIGIN });
  await context.route(/:6767\b/, (route) => route.abort());
  await context.routeWebSocket(/:6767\b/, async (ws) => {
    await ws.close({ code: 1008, reason: "The operator's daemon is off limits to this harness." });
  });
  await context.route(`${ORCHESTRA_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === PARENT_PATH) {
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: parentHtml(input),
      });
    }
    if (url.pathname === "/agents-ui" || url.pathname.startsWith("/agents-ui/")) {
      return serveExport(route, url.pathname);
    }
    return route.fulfill({ status: 404, body: "not simulated" });
  });
  const endpoint = DAEMON_LISTEN;
  const nowIso = new Date().toISOString();
  const host = {
    serverId: input.serverId,
    label: "isolated",
    connections: [{ id: `direct:${endpoint}`, type: "directTcp", endpoint }],
    preferredConnectionId: `direct:${endpoint}`,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await context.addInitScript(
    (registry) => {
      // Same origin for page and frame: this is the storage the embed reads its host from.
      localStorage.setItem("@paseo:daemon-registry", registry);
      localStorage.removeItem("@paseo:settings");
    },
    JSON.stringify([host]),
  );
  await context.addInitScript(frameProbe);
}

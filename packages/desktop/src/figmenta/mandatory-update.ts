// Figmenta fork: Orchestra Desktop's updater is MANDATORY (Federico, 2026-09-27): to use
// Orchestra you need the latest version. No "Skip", no "Remind me later", no countdown.
//
//   check at launch and every 30 minutes
//     -> nothing new, or the feed is unreachable: nothing happens, the app stays usable,
//        the next round tries again
//     -> a newer version: download it at once, behind a screen that covers the window
//        (progress), then ONE button, "Installa e riavvia"
//     -> the download fails: the same screen, with "Riprova"
//
// This module is the state machine only; electron-updater and the covering screen are
// injected (mandatory-update-electron.ts), so every transition is unit-testable.

export const DEFAULT_UPDATE_FEED_URL = "https://downloads.figmenta.site/orchestra-desktop/updates/";
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Env override for the feed, honoured ONLY for a loopback host (end-to-end tests). */
export const UPDATE_FEED_OVERRIDE_ENV = "ORCHESTRA_UPDATE_FEED_URL";

export type MandatoryUpdateState =
  | { phase: "idle" }
  | { phase: "downloading"; version: string | null; percent: number | null }
  | { phase: "ready"; version: string }
  | { phase: "failed"; version: string | null; message: string }
  | { phase: "installing"; version: string };

export interface MandatoryUpdateRuntime {
  /** The newer version the feed announces, null when this build is current. Throws when
   * the feed cannot be read (offline, DNS, 5xx, malformed manifest). */
  check(): Promise<{ version: string } | null>;
  /** Downloads (and on macOS stages) the version the last check announced. */
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Quits and relaunches on the new version. */
  install(): void;
}

export interface MandatoryUpdateView {
  render(state: MandatoryUpdateState): void;
}

export interface MandatoryUpdateDeps {
  runtime: MandatoryUpdateRuntime;
  view: MandatoryUpdateView;
  log: (message: string, details?: Record<string, unknown>) => void;
  /** Runs before install(): stop the daemon this app launched, like upstream does. */
  beforeInstall?: () => Promise<void>;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  intervalMs?: number;
}

export interface MandatoryUpdateController {
  start(): void;
  stop(): void;
  checkNow(): Promise<void>;
  retry(): Promise<void>;
  install(): Promise<void>;
  getState(): MandatoryUpdateState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMandatoryUpdateController(
  deps: MandatoryUpdateDeps,
): MandatoryUpdateController {
  let state: MandatoryUpdateState = { phase: "idle" };
  let checking = false;
  let timer: unknown = null;

  function setState(next: MandatoryUpdateState): void {
    state = next;
    deps.view.render(state);
  }

  async function download(version: string): Promise<void> {
    setState({ phase: "downloading", version, percent: null });
    try {
      await deps.runtime.download((percent) => {
        if (state.phase !== "downloading") return;
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        setState({ phase: "downloading", version, percent: clamped });
      });
    } catch (error) {
      deps.log("download failed", { version, error: errorMessage(error) });
      setState({ phase: "failed", version, message: errorMessage(error) });
      return;
    }
    deps.log("download complete", { version });
    setState({ phase: "ready", version });
  }

  async function checkNow(): Promise<void> {
    // Once a newer version has been seen the window stays blocked until it is installed:
    // a periodic round never reopens it, and never runs two checks at once.
    if (checking || state.phase !== "idle") return;
    checking = true;
    let found: { version: string } | null;
    try {
      found = await deps.runtime.check();
    } catch (error) {
      // Offline, feed down, DNS: never a reason to lock the user out.
      deps.log("update check failed, retrying next round", { error: errorMessage(error) });
      return;
    } finally {
      checking = false;
    }
    if (!found) return;
    deps.log("newer version announced", { version: found.version });
    await download(found.version);
  }

  async function retry(): Promise<void> {
    if (state.phase !== "failed") return;
    const previous = state;
    setState({ phase: "downloading", version: previous.version, percent: null });
    let found: { version: string } | null;
    try {
      found = await deps.runtime.check();
    } catch (error) {
      setState({ phase: "failed", version: previous.version, message: errorMessage(error) });
      return;
    }
    if (!found) {
      // The feed no longer announces anything newer (e.g. a release was pulled).
      deps.log("retry found no newer version, unblocking");
      setState({ phase: "idle" });
      return;
    }
    await download(found.version);
  }

  async function install(): Promise<void> {
    if (state.phase !== "ready") return;
    const version = state.version;
    setState({ phase: "installing", version });
    if (deps.beforeInstall) {
      try {
        await deps.beforeInstall();
      } catch (error) {
        deps.log("pre-install step failed, installing anyway", { error: errorMessage(error) });
      }
    }
    deps.log("quit and install", { version });
    try {
      deps.runtime.install();
    } catch (error) {
      deps.log("install failed", { version, error: errorMessage(error) });
      setState({ phase: "failed", version, message: errorMessage(error) });
    }
  }

  return {
    start() {
      if (timer !== null) return;
      void checkNow();
      timer = deps.setInterval(() => {
        void checkNow();
      }, deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS);
    },
    stop() {
      if (timer === null) return;
      deps.clearInterval(timer);
      timer = null;
    },
    checkNow,
    retry,
    install,
    getState: () => state,
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface ResolvedFeedUrl {
  url: string;
  /** The override that was refused (not loopback, not http(s), not a URL), for the log. */
  refusedOverride: string | null;
}

/**
 * The update feed. `ORCHESTRA_UPDATE_FEED_URL` exists for the end-to-end test only, and
 * is honoured only when it points at this machine: an env var must never be enough to
 * send Orchestra to a remote feed.
 */
export function resolveUpdateFeedUrl(
  env: Record<string, string | undefined> = process.env,
): ResolvedFeedUrl {
  const raw = env[UPDATE_FEED_OVERRIDE_ENV]?.trim();
  if (!raw) return { url: DEFAULT_UPDATE_FEED_URL, refusedOverride: null };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: DEFAULT_UPDATE_FEED_URL, refusedOverride: raw };
  }
  const httpish = parsed.protocol === "http:" || parsed.protocol === "https:";
  if (!httpish || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { url: DEFAULT_UPDATE_FEED_URL, refusedOverride: raw };
  }
  const url = parsed.toString();
  return { url: url.endsWith("/") ? url : `${url}/`, refusedOverride: null };
}

/**
 * The connection to Orchestra, as a state machine.
 *
 * Extracted from the plugin entry so the rules that matter can be tested
 * without a daemon: what is trusted, what happens when Orchestra says no, and
 * what happens when it says nothing at all.
 *
 * The two cases are not the same and must not be treated the same:
 *   - Orchestra answers 401/403 → the token is dead or the profile is paused.
 *     Forget it. `connected` goes false, so the web side knows it has to hand
 *     over a new one.
 *   - Orchestra does not answer → the network is down, not the grant. Keep the
 *     cached profile so sessions keep their model, mode and tools, but say so:
 *     `stale: true`.
 */
import type { MaestroUser } from "../shared/maestro";
import { normalizeAllowedBaseUrl } from "./base-url";
import { ProfileFetchError, type MaestroProfile, type MaestroState } from "./profile";

export const PROFILE_TTL_MS = 60_000;
export const HOOK_FETCH_TIMEOUT_MS = 4000;

export interface ConnectionDeps {
  fetchProfile(baseUrl: string, token: string, timeoutMs?: number): Promise<MaestroProfile>;
  loadState(): Promise<MaestroState>;
  saveState(state: MaestroState): Promise<void>;
  now?(): number;
  log?(message: string, detail?: unknown): void;
}

export interface ConnectionStatus {
  connected: boolean;
  /** True when the cached profile is older than the TTL and the last refresh failed. */
  stale: boolean;
  user: MaestroUser | null;
  baseUrl: string | null;
}

export interface SetConnectionResult {
  ok: boolean;
  user: MaestroUser | null;
  error: string | null;
}

export function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof ProfileFetchError && (error.status === 401 || error.status === 403)
  );
}

export function createMaestroConnection(deps: ConnectionDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);

  let baseUrl: string | null = null;
  let connectToken: string | null = null;
  let cache: { at: number; profile: MaestroProfile } | null = null;
  let stale = false;
  let inflight: Promise<MaestroProfile | null> | null = null;
  let stopped = false;

  const ready = deps.loadState().then((loaded) => {
    // A base URL that was allowed when it was written may not be allowed now:
    // re-check on load rather than trusting the file.
    baseUrl = loaded.baseUrl === null ? null : normalizeAllowedBaseUrl(loaded.baseUrl);
    connectToken = baseUrl === null ? null : loaded.connectToken;
    cache = connectToken === null ? null : loaded.profileCache;
  });

  async function persist(): Promise<void> {
    await deps.saveState({ baseUrl, connectToken, profileCache: cache });
  }

  async function forget(reason: string): Promise<void> {
    log("connection dropped, a new connect token is needed", reason);
    connectToken = null;
    cache = null;
    stale = false;
    await persist();
  }

  async function refresh(timeoutMs: number): Promise<MaestroProfile | null> {
    if (baseUrl === null || connectToken === null) return null;
    if (inflight !== null) return inflight;
    const url = baseUrl;
    const token = connectToken;
    inflight = (async () => {
      try {
        const profile = await deps.fetchProfile(url, token, timeoutMs);
        cache = { at: now(), profile };
        stale = false;
        await persist();
        return profile;
      } catch (error) {
        if (isAuthFailure(error)) {
          await forget((error as Error).message);
          return null;
        }
        stale = true;
        log("profile refresh failed, keeping the cached profile", (error as Error).message);
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    async setConnection(input: { baseUrl: string; token: string }): Promise<SetConnectionResult> {
      await ready;
      const normalized = normalizeAllowedBaseUrl(input.baseUrl);
      if (normalized === null) {
        log("setConnection refused: base URL outside the allow-list", input.baseUrl);
        return { ok: false, user: null, error: "untrusted_base_url" };
      }
      try {
        const profile = await deps.fetchProfile(normalized, input.token);
        baseUrl = normalized;
        connectToken = input.token;
        cache = { at: now(), profile };
        stale = false;
        await persist();
        log(`connected as ${profile.user.handle}`);
        return { ok: true, user: profile.user, error: null };
      } catch (error) {
        const reason =
          error instanceof ProfileFetchError && error.status === 403
            ? "paused"
            : ((error as Error).message ?? "connection failed");
        log("setConnection refused", reason);
        return { ok: false, user: null, error: reason };
      }
    },

    async status(): Promise<ConnectionStatus> {
      await ready;
      return {
        connected: baseUrl !== null && connectToken !== null && cache !== null,
        stale,
        user: cache?.profile.user ?? null,
        baseUrl,
      };
    },

    /** The profile a hook should apply: fresh cache, or stale cache plus a background refresh. */
    async currentProfile(): Promise<MaestroProfile | null> {
      await ready;
      if (stopped) return null;
      if (baseUrl === null || connectToken === null) return null;
      if (cache !== null) {
        if (now() - cache.at > PROFILE_TTL_MS) void refresh(HOOK_FETCH_TIMEOUT_MS);
        return cache.profile;
      }
      return refresh(HOOK_FETCH_TIMEOUT_MS);
    },

    /** The handle of the connected user, for log lines. */
    handle(): string | undefined {
      return cache?.profile.user.handle;
    },

    stop(): void {
      stopped = true;
    },
  };
}

export type MaestroConnection = ReturnType<typeof createMaestroConnection>;

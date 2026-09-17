import { describe, expect, it, vi } from "vitest";
import { createMaestroConnection, PROFILE_TTL_MS } from "./connection";
import { EMPTY_STATE, ProfileFetchError, type MaestroProfile, type MaestroState } from "./profile";

const profile = (handle = "federico"): MaestroProfile => ({
  user: { id: "u1", handle, name: "Federico" },
  status: "active",
  seat_mode: "own",
  seat_id: null,
  models: ["claude-opus-5"],
  modes: ["auto", "plan"],
  tools: ["orchestra"],
  persona: null,
  base_skill: null,
  custom_instructions: "",
  skills: [],
  mcp: { url: "https://orchestra.figmenta.site/mcp/maestro", token: "orcm_1" },
  seat_token: null,
});

function harness(options: {
  fetchProfile: ConnectionFetch;
  state?: MaestroState;
  now?: () => number;
}) {
  const saved: MaestroState[] = [];
  const connection = createMaestroConnection({
    fetchProfile: options.fetchProfile,
    loadState: async () => options.state ?? { ...EMPTY_STATE },
    saveState: async (state) => {
      saved.push(state);
    },
    ...(options.now ? { now: options.now } : {}),
  });
  return { connection, saved };
}

type ConnectionFetch = (
  baseUrl: string,
  token: string,
  timeoutMs?: number,
) => Promise<MaestroProfile>;

describe("setConnection", () => {
  it("refuses a base URL outside the allow-list without touching the network", async () => {
    const fetchProfile = vi.fn(async () => profile());
    const { connection, saved } = harness({ fetchProfile });

    const result = await connection.setConnection({
      baseUrl: "https://evil.tld",
      token: "orcc_1",
    });

    expect(result).toEqual({ ok: false, user: null, error: "untrusted_base_url" });
    expect(fetchProfile).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect((await connection.status()).connected).toBe(false);
  });

  it("accepts the loopback and stores the normalized URL", async () => {
    const fetchProfile = vi.fn(async () => profile());
    const { connection, saved } = harness({ fetchProfile });

    const result = await connection.setConnection({
      baseUrl: "http://localhost:3000/",
      token: "orcc_1",
    });

    expect(result.ok).toBe(true);
    expect(fetchProfile).toHaveBeenCalledWith("http://localhost:3000", "orcc_1");
    expect(saved.at(-1)?.baseUrl).toBe("http://localhost:3000");
    expect(await connection.status()).toMatchObject({ connected: true, stale: false });
  });

  it("reports a paused profile as paused", async () => {
    const fetchProfile = vi.fn(async () => {
      throw new ProfileFetchError("paused", 403);
    });
    const { connection } = harness({ fetchProfile });
    const result = await connection.setConnection({
      baseUrl: "https://orchestra.figmenta.site",
      token: "orcc_1",
    });
    expect(result).toEqual({ ok: false, user: null, error: "paused" });
  });
});

describe("stored state", () => {
  it("drops a stored base URL that is no longer allowed", async () => {
    const { connection } = harness({
      fetchProfile: async () => profile(),
      state: {
        baseUrl: "https://evil.tld",
        connectToken: "orcc_old",
        profileCache: { at: Date.now(), profile: profile() },
      },
    });
    expect(await connection.status()).toMatchObject({ connected: false, baseUrl: null });
    expect(await connection.currentProfile()).toBeNull();
  });
});

describe("refresh", () => {
  const connected: MaestroState = {
    baseUrl: "https://orchestra.figmenta.site",
    connectToken: "orcc_1",
    profileCache: { at: 0, profile: profile() },
  };

  it("forgets the token on 401 and goes disconnected", async () => {
    let clock = PROFILE_TTL_MS + 1;
    const fetchProfile = vi.fn(async () => {
      throw new ProfileFetchError("token revoked", 401);
    });
    const { connection, saved } = harness({ fetchProfile, state: connected, now: () => clock });

    // First read serves the stale cache and kicks off the refresh.
    expect(await connection.currentProfile()).not.toBeNull();
    await vi.waitFor(() => expect(fetchProfile).toHaveBeenCalled());
    clock += 1;

    expect(await connection.status()).toMatchObject({ connected: false, stale: false });
    expect(await connection.currentProfile()).toBeNull();
    expect(saved.at(-1)).toEqual({
      baseUrl: "https://orchestra.figmenta.site",
      connectToken: null,
      profileCache: null,
    });
  });

  it("keeps the cache but flags it stale when the network fails", async () => {
    let clock = PROFILE_TTL_MS + 1;
    const fetchProfile = vi.fn(async () => {
      throw new ProfileFetchError("fetch failed", null);
    });
    const { connection } = harness({ fetchProfile, state: connected, now: () => clock });

    expect(await connection.currentProfile()).not.toBeNull();
    await vi.waitFor(() => expect(fetchProfile).toHaveBeenCalled());
    clock += 1;

    expect(await connection.status()).toMatchObject({ connected: true, stale: true });
    expect(await connection.currentProfile()).not.toBeNull();
  });

  it("clears the stale flag once Orchestra answers again", async () => {
    let clock = PROFILE_TTL_MS + 1;
    let fail = true;
    const fetchProfile = vi.fn(async () => {
      if (fail) throw new ProfileFetchError("fetch failed", null);
      return profile("federico2");
    });
    const { connection } = harness({ fetchProfile, state: connected, now: () => clock });

    await connection.currentProfile();
    await vi.waitFor(async () => expect((await connection.status()).stale).toBe(true));

    fail = false;
    clock += PROFILE_TTL_MS + 1;
    await connection.currentProfile();
    await vi.waitFor(async () => expect((await connection.status()).stale).toBe(false));
    expect((await connection.status()).user?.handle).toBe("federico2");
  });
});

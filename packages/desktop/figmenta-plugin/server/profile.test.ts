import { describe, expect, it, vi } from "vitest";
import {
  fetchProfile,
  MaestroProfileSchema,
  ProfileFetchError,
  PROFILE_PATHS,
  profileUrl,
} from "./profile";

const payload = {
  user: { id: "u1", handle: "federico", name: "Federico" },
  status: "active",
  models: ["claude-opus-5"],
  modes: ["auto"],
  tools: ["orchestra"],
  custom_instructions: "",
  skills: [],
  mcp: { url: "http://127.0.0.1:6344/mcp/maestro", token: "orcm_1" },
  seat_token: null,
};

function responder(routes: Record<string, { status: number; body: string }>) {
  return vi.fn(async (url: string) => {
    const route = routes[url] ?? { status: 404, body: "<!DOCTYPE html>" };
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      text: async () => route.body,
    };
  });
}

describe("fetchProfile", () => {
  it("tries the proxied path first", async () => {
    const fetchImpl = responder({
      "http://x/api/maestro/plugin/profile": { status: 200, body: JSON.stringify(payload) },
    });
    const profile = await fetchProfile("http://x", "orcc_1", 1000, fetchImpl);
    expect(profile.user.handle).toBe("federico");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the bare path when the proxy answers with a login page", async () => {
    const fetchImpl = responder({
      "http://x/api/maestro/plugin/profile": { status: 200, body: "<!DOCTYPE html><html>login" },
      "http://x/maestro/plugin/profile": { status: 200, body: JSON.stringify(payload) },
    });
    const profile = await fetchProfile("http://x", "orcc_1", 1000, fetchImpl);
    expect(profile.user.handle).toBe("federico");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back when the proxied path answers a JSON 404", async () => {
    const fetchImpl = responder({
      "http://x/api/maestro/plugin/profile": { status: 404, body: '{"detail":"Not Found"}' },
      "http://x/maestro/plugin/profile": { status: 200, body: JSON.stringify(payload) },
    });
    const profile = await fetchProfile("http://x", "orcc_1", 1000, fetchImpl);
    expect(profile.user.handle).toBe("federico");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a JSON error as the verdict instead of falling back", async () => {
    const fetchImpl = responder({
      "http://x/api/maestro/plugin/profile": { status: 403, body: '{"error":"paused"}' },
    });
    await expect(fetchProfile("http://x", "orcc_1", 1000, fetchImpl)).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports when no shape answered with JSON", async () => {
    const fetchImpl = responder({});
    await expect(fetchProfile("http://x", "orcc_1", 1000, fetchImpl)).rejects.toBeInstanceOf(
      ProfileFetchError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(PROFILE_PATHS.length);
  });
});

describe("profileUrl", () => {
  it("strips trailing slashes", () => {
    expect(profileUrl("http://x/")).toBe("http://x/api/maestro/plugin/profile");
  });
});

describe("MaestroProfileSchema", () => {
  it("parses a v1 payload that carries neither persona nor base_skill", () => {
    const parsed = MaestroProfileSchema.parse(payload);
    expect(parsed.persona).toBeNull();
    expect(parsed.base_skill).toBeNull();
  });

  it("parses a persona and a base skill, defaulting the avatar", () => {
    const parsed = MaestroProfileSchema.parse({
      ...payload,
      persona: { name: "Pluto", slug: "pluto" },
      base_skill: { slug: "pluto", name: "Pluto", body_md: "Brief." },
    });
    expect(parsed.persona).toEqual({ name: "Pluto", slug: "pluto", avatar: "" });
    expect(parsed.base_skill?.slug).toBe("pluto");
    expect(parsed.base_skill?.name).toBe("Pluto");
  });
});

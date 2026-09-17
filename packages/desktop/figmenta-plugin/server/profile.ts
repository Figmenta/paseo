/**
 * The Maestro profile as Orchestra hands it to the plugin (contract §2.3), and
 * the on-disk connection state.
 *
 * Every field is defaulted: a backend that grows a field must not be able to
 * make session creation fail here. Parsing is lenient on purpose.
 */
import { z } from "zod";
import { MaestroUserSchema, PLUGIN_PROFILE_PATH } from "../shared/maestro";

export const MaestroSkillSchema = z.object({
  slug: z.string(),
  name: z.string().default(""),
  body_md: z.string().default(""),
  summary: z.string().default("").optional(),
  role: z.string().default("").optional(),
});
export type MaestroSkill = z.infer<typeof MaestroSkillSchema>;

/** Who the Maestro is for this user: a name, the slug of its base skill, a picture. */
export const MaestroPersonaSchema = z.object({
  name: z.string(),
  slug: z.string(),
  avatar: z.string().default(""),
});
export type MaestroPersona = z.infer<typeof MaestroPersonaSchema>;

export const MaestroProfileSchema = z.object({
  user: MaestroUserSchema,
  status: z.string().default("active"),
  seat_mode: z.string().default("own"),
  seat_id: z.string().nullable().default(null),
  models: z.array(z.string()).default([]),
  modes: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  custom_instructions: z.string().default(""),
  skills: z.array(MaestroSkillSchema).default([]),
  persona: MaestroPersonaSchema.nullable().default(null),
  base_skill: MaestroSkillSchema.nullable().default(null),
  mcp: z.object({ url: z.string(), token: z.string() }).nullable().default(null),
  seat_token: z.string().nullable().default(null),
});
export type MaestroProfile = z.infer<typeof MaestroProfileSchema>;

export const MaestroStateSchema = z.object({
  baseUrl: z.string().nullable().default(null),
  connectToken: z.string().nullable().default(null),
  profileCache: z
    .object({ at: z.number(), profile: MaestroProfileSchema })
    .nullable()
    .default(null),
});
export type MaestroState = z.infer<typeof MaestroStateSchema>;

export const EMPTY_STATE: MaestroState = { baseUrl: null, connectToken: null, profileCache: null };

/**
 * Where the profile lives, in the order we try.
 *
 * Measured on the smoke stack (2026-09-17): the Next app at :3000 answers
 * `/api/maestro/plugin/profile` with a 307 to `/login` when the request carries
 * a Bearer instead of a session cookie, while the FastAPI backend serves
 * `/maestro/plugin/profile` directly. Both shapes are legitimate base URLs, so
 * the client tries the proxied path first and falls back to the bare one.
 * Whatever answers with JSON wins, and its status is the verdict.
 */
export const PROFILE_PATHS: readonly string[] = [
  PLUGIN_PROFILE_PATH,
  PLUGIN_PROFILE_PATH.replace(/^\/api/, ""),
];

export function profileUrl(baseUrl: string, path: string = PLUGIN_PROFILE_PATH): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export class ProfileFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ProfileFetchError";
  }
}

export type FetchLike = (
  url: string,
  init: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

interface Attempt {
  json: unknown | undefined;
  status: number;
  ok: boolean;
  body: string;
}

async function attempt(
  url: string,
  token: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    let json: unknown | undefined;
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      // A login page, an HTML 404, an empty body: not this path.
      json = undefined;
    }
    return { json, status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One authenticated GET against Orchestra. Throws ProfileFetchError; never
 * returns a partial profile.
 */
export async function fetchProfile(
  baseUrl: string,
  token: string,
  timeoutMs = 8000,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<MaestroProfile> {
  let last: ProfileFetchError = new ProfileFetchError("no endpoint answered", null);
  for (const path of PROFILE_PATHS) {
    let result: Attempt;
    try {
      result = await attempt(profileUrl(baseUrl, path), token, timeoutMs, fetchImpl);
    } catch (error) {
      // Network or timeout: the next path would fail the same way.
      throw new ProfileFetchError((error as Error).message ?? "request failed", null);
    }
    if (result.json === undefined) {
      last = new ProfileFetchError(`No JSON at ${path} (HTTP ${result.status})`, null);
      continue; // try the other shape
    }
    if (result.status === 404) {
      // The route is not mounted under this prefix: try the other shape.
      last = new ProfileFetchError(`No profile route at ${path}`, 404);
      continue;
    }
    if (!result.ok) {
      // JSON error from the real endpoint: this is its answer (401, 403 paused, 5xx).
      throw new ProfileFetchError(
        `Orchestra answered ${result.status}: ${result.body.slice(0, 200)}`,
        result.status,
      );
    }
    const parsed = MaestroProfileSchema.safeParse(result.json);
    if (!parsed.success) {
      last = new ProfileFetchError(`Unreadable profile payload at ${path}`, null);
      continue;
    }
    return parsed.data;
  }
  throw last;
}

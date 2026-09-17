/**
 * RPC contracts shared by the client bundle (which calls them) and the server
 * bundle (which answers them). No Node and no browser API here.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Path appended to the Orchestra base URL. The web app reaches the backend under /api. */
export const PLUGIN_PROFILE_PATH = "/api/maestro/plugin/profile";

export const MaestroUserSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string().default(""),
});
export type MaestroUser = z.infer<typeof MaestroUserSchema>;

export const setConnectionRpc = defineRpc({
  name: "maestro.setconnection",
  input: z.object({ baseUrl: z.string(), token: z.string() }),
  output: z.object({
    ok: z.boolean(),
    user: MaestroUserSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const statusRpc = defineRpc({
  name: "maestro.status",
  input: z.object({}),
  output: z.object({
    connected: z.boolean(),
    /** Connected, but the cached profile could not be refreshed: Orchestra is unreachable. */
    stale: z.boolean(),
    user: MaestroUserSchema.nullable(),
    baseUrl: z.string().nullable(),
    version: z.string(),
  }),
});

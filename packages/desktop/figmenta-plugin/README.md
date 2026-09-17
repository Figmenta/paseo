# figmenta-sessions — Sessions surface + Maestro engine

Adds one item to the Paseo sidebar, **Sessions**, that lists every agent session on
the selected host — across all workspaces — in a single scrollable surface. Clicking a
row opens that session.

Paseo's sidebar lists *workspaces*; the sessions themselves live one level down, in the
horizontal tabs inside a workspace. This plugin puts that second level at the top, so
the whole fleet is visible without opening a workspace first.

It also carries **Maestro**: the daemon-side half of Orchestra's chat. That half holds the
connection to Orchestra, applies the user's profile to every session Paseo creates, keeps
the Maestro skills on disk, and records denied permissions. See *Maestro* below.

Built for **Paseo 0.8** (`requirements.paseo: ">=0.8.0"`).

## What a row shows

| Field         | Source                                                                   |
| ------------- | ------------------------------------------------------------------------ |
| Title         | `agent.title`, whitespace-collapsed and truncated at 72 characters       |
| State         | `running`, `idle`, `waiting`, `finished`, `failed`, `starting`, `closed` |
| Workspace     | `project.workspaceName`, falling back to `project.projectName`           |
| Runtime/model | `agent.provider` and `agent.model`, rendered as `runtime · model`        |
| Last activity | newest of `updatedAt`, `lastUserMessageAt`, `createdAt`, shown relative  |

A pending permission request outranks the lifecycle status: the row reads `waiting`,
because `idle` would hide a session that is stopped on a question.

## Ordering

Rows are **grouped by workspace**, and both the groups and the rows inside them are
ordered by last activity, newest first.

Grouped rather than one flat feed because the sidebar next to this surface is a
workspace list: the workspace is the coordinate you already navigate by, so keeping it
as the header preserves that map while making the *session* the thing you click.
Activity order keeps whatever is live at the top of the scroll.

Archived sessions are excluded (`filter.includeArchived: false`, plus a client-side
guard for archive events arriving live). Closed-but-not-archived sessions are listed:
they are the same sessions the workspace tab bar keeps.

## Live updates

The surface reads the full agent directory once through `paseo.agents.list()`, paging
to the end (200 per page, 10 pages maximum), then stays current through
`paseo.agents.subscribe()`. A state change that arrives without a placement keeps the
workspace already known for that session, so a row never loses its group.

## Maestro

### What it does

| Hook / RPC                      | Effect                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `maestro.setconnection`         | Checks `baseUrl` against the allow-list, then `GET {baseUrl}/api/maestro/plugin/profile` (falling back to `/maestro/plugin/profile`) with `Authorization: Bearer <connect token>`; on success stores it and returns the user |
| `maestro.status`                | `{connected, stale, user, baseUrl, version}`                                                                                |
| `before("agent.create")`        | Model and mode forced into the profile's allow-lists; `mcpServers.maestro` added; the Maestro preamble and the user's custom instructions appended to `systemPrompt` |
| `before("agent.session_open")`  | `MAESTRO_USER=<handle>` in the env (`CLAUDE_CODE_OAUTH_TOKEN` too, but only when Orchestra actually sends a seat token, which it does not yet); Maestro skills synced to `~/.claude/skills/` |
| `on("agent.permission_resolved")` | A `deny` is appended to `~/.paseo/figmenta-maestro-denials.jsonl`                                                          |

Every hook is **fail-open**. If Orchestra is unreachable, the profile is unparseable, or the
skill sync throws, the session is created exactly as the user asked and the reason goes to the
daemon log with a `[figmenta-maestro]` prefix. Nothing here can stop a session from starting.

State lives in `~/.paseo/figmenta-maestro.json`, mode `600`: base URL, connect token, and the
last profile (cached 60 s, refreshed in the background once past the TTL).

### Which Orchestra the plugin will talk to

The local daemon has no password: anything that can open its socket can call
`maestro.setconnection`. So the base URL is checked before a request leaves the machine —
`https://orchestra.figmenta.site`, or `http://localhost:*` / `http://127.0.0.1:*` for
development and smoke runs. Anything else is refused with `untrusted_base_url`, with no
network call, and a URL carrying credentials, a path, a query or a fragment is refused too.
The check runs again when the state file is read at startup, so a base URL that was allowed
when it was written is not trusted forever.

### A dead token and a dead network are not the same thing

`401`/`403` from Orchestra means the grant is gone: the token and the cached profile are
dropped and persisted, so `maestro.status` reports `connected: false` and the web side knows
it has to hand over a new connect token. A network failure means only that Orchestra is
unreachable: the cached profile is kept — sessions keep their model, mode and tools — and
the status says `stale: true` until a refresh succeeds.

### Two shapes of base URL

Orchestra's web origin proxies the backend under `/api`, while the backend itself serves the
route at the root. Measured on the smoke stack (2026-09-17): the Next app answers
`/api/maestro/plugin/profile` with a 307 to `/login` when the request carries a Bearer rather
than a session cookie. The client therefore tries the proxied path first and falls back to the
bare one; whatever answers with JSON wins, and a JSON `404` counts as "wrong prefix", not as a
verdict.

### systemPrompt is an append, not a replace

The claude provider always builds
`systemPrompt: { type: "preset", preset: "claude_code", append: composeSystemPromptParts(config.systemPrompt, …) }`
(`packages/server/src/server/agent/providers/claude/agent.ts:3291`). So `config.systemPrompt`
is **appended** to Claude Code's own preset prompt and to the user's `CLAUDE.md` files: nothing
is lost. The plugin therefore sets `systemPrompt` and writes no `CLAUDE.local.md`. Composition
is idempotent — enforcing the same profile on a resumed session does not stack a second copy of
the preamble.

### Skills on disk

One directory per skill under `~/.claude/skills/<slug>/`, holding `SKILL.md` (frontmatter
`name: <slug>` + `description`, then the body from Orchestra) and a `.maestro-managed` marker.
A directory **without** the marker is the user's own and is never written to and never deleted —
it is reported as skipped. A directory **with** the marker that is no longer in the profile is
removed. Slugs must match `^[a-z0-9-]{2,40}$`; anything else is refused before it becomes a path.

### The postMessage bridge

Orchestra runs this build inside a same-origin iframe and hands over the connect token there.
The bridge is installed in `contribute(client)` itself (`index.client.tsx` → `client/web.ts`),
**not** inside a surface: a surface component only mounts once the user opens it, and the
handshake has to happen at load. The contribution function is the only client code Paseo runs
unconditionally, and `client.rpc` is available on the contribution context
(`PluginClientContext extends PluginCommandCapabilities`), so no React is involved.

- out, at load: `{type:"maestro.plugin.ready", version, connected}` to `window.parent`
- in: `{type:"maestro.connect", baseUrl, token}`, accepted **only** when
  `event.origin === window.location.origin`
- out, after the daemon verified the token: `{type:"maestro.plugin.connected", user:{handle}}`

`client/web.ts` is the one file allowed to touch browser globals, and everything in it is gated
on `Platform.OS === "web"`; on iOS and Android the bridge is a no-op.

## Install

### On another Mac

1. Clone this repo, then point the daemon at the directory in `~/.paseo/config.json`:

   ```jsonc
   {
     "pluginsEnabled": true,
     "plugins": {
       "figmenta-sessions": { "type": "directory", "path": "/absolute/path/to/paseo-orchestra-plugin" }
     }
   }
   ```

   `pluginsEnabled` has no CLI equivalent: set it in the file, or use Settings → Plugins →
   Enable plugins.

2. Let the daemon accept the Orchestra origin, so the web app can talk to it:
   `daemon.cors.allowedOrigins` must contain `https://orchestra.figmenta.site`.

3. `paseo reload`.

4. In Orchestra, open Maestro and press **Connect engine**. The token travels over the bridge;
   nothing is typed into Paseo.

The manifest stays `{ id, requirements }`: the daemon parses `paseo-plugin.json` with a
**strict** schema (`id`, `requirements`, `build` only), and entry points are found by filename —
`index.client.tsx` and `index.server.ts`. Adding a `server` field to the manifest breaks loading.

### From the CLI

```bash
paseo plugin install /absolute/path/to/paseo-orchestra-plugin
paseo plugin ls          # figmenta-sessions -> running
```

Or from Git:

```bash
paseo plugin add Figmenta/paseo-orchestra-plugin
```

Plugins must be enabled daemon-wide first: **Settings → Plugins → Enable plugins**, or
the root `pluginsEnabled: true` in `~/.paseo/config.json` followed by `paseo reload`.
There is no CLI command that sets that field.

After editing the source:

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
paseo plugin reload figmenta-sessions
```

## Limits

- **It does not hide or replace the workspace list.** The plugin API contributes
  surfaces; it cannot remove or reorder a host-owned sidebar section. Sessions is an
  additional entry above Workspaces.
- **One host at a time.** A surface is scoped to the selected host; when the same
  plugin is installed on several daemons, Paseo adds its own host picker.
- **Opening a session needs host navigation.** `navigation.openAgent` is optional in
  the SDK contract; on a client that does not provide it the rows render without the
  press affordance and the header says so.
- **No search or filter yet.** With a few hundred sessions the list is long; the
  virtualized list handles it, the eye does not.
- Sessions beyond 2000 on one host are not fetched (the paging cap).

## Layout

`shared/` holds what both bundles need: the RPC contracts (`maestro.ts`), the bridge protocol
and its parser (`bridge.ts`), the announced version (`version.ts`). `server/` holds the
daemon-side work: `enforce.ts` (pure: profile in, config out), `skills.ts` (the disk sync),
`profile.ts` (fetch + lenient schema), `state.ts`, `denials.ts`. Tests sit beside their module
and cover the pure parts — enforcement, the skill sync against a real temporary directory, the
bridge parser.

`client/model.ts` is the pure derivation layer — grouping, ordering, labelling — with
no React and no react-native, so the rules can be read without a renderer.
`client/use-sessions.ts` owns the fetch and the live subscription.
`client/sessions.tsx` is the surface. All colour and spacing comes from `theme.colors`
and `layout.compact`; nothing is hardcoded.

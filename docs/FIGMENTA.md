# Figmenta branch

Branch `figmenta` = upstream release tag + a minimal set of patches. Rules:

1. Never edit `main`; it mirrors upstream.
2. Patches live here as separate commits on top of the release tag (today `v0.9.2`; rebased
   from `v0.8.0` on 2026-09-27 on branch `figmenta-092`, see "Rebase on 0.9.2" below).
3. To align with a new upstream release: `git fetch upstream --tags && git rebase vX.Y.Z figmenta`,
   resolve, rebuild, test, force-push `figmenta`.
4. Anything that can be a plugin goes to `Figmenta/paseo-orchestra-plugin`, not here.

Patches:

- `packages/app/app.config.js`: optional `experiments.baseUrl` from `PASEO_WEB_BASE_URL`, so the web
  export can be served by Orchestra under `/agents-ui`.
- Embed mode (see below): `packages/app/src/figmenta/embed.ts` (new file) plus three one-line guards.

Build the web client for Orchestra:
`PASEO_WEB_BASE_URL=/agents-ui npm run build --workspace=@getpaseo/app` → `packages/app/dist`.

## Embed mode

Orchestra renders this web build inside a same-origin iframe
(`/agents-ui/h/{serverId}/agent/{agentId}?embed=1`) and supplies its own chrome: the
nav, the SESSIONS sidebar and the session header are Orchestra's. Embed mode is the
switch that keeps Paseo from drawing a second copy of all three.

`packages/app/src/figmenta/embed.ts` — new file, no upstream counterpart, never
conflicts on rebase. `isEmbedMode()` is true on web when the current URL carries
`?embed=1` **or** `sessionStorage.figmentaEmbed === "1"`. The first sighting latches the
flag into `sessionStorage`, because the deep-link route resolves to a workspace route
and rewrites the URL: without the latch the flag would survive exactly one render.
On iOS and Android it is always false.

Three call sites, three hunks to reapply after a rebase:

1. `packages/app/src/app/_layout.tsx`, in `SidebarChrome` — do not mount `LeftSidebar`,
   and keep the sidebar model inactive:

```tsx
   const embedded = isEmbedMode();
   const active = !embedded && visible && (isCompactLayout ? isMobileActive : isDesktopOpen);
   return (
     <SidebarModelProvider active={active}>
       {mounted && !embedded ? <LeftSidebar active={active} /> : null}
```

2. `packages/app/src/components/headers/screen-header.tsx`, in `ScreenHeader` — render
   nothing. The agent deep-link route (`app/h/[serverId]/agent/[agentId].tsx`) only
   resolves and redirects; the header the user actually sees comes from
   `screens/workspace/workspace-screen.tsx`, which renders it through this one shared
   component. One guard here covers every screen, which is what embed mode wants: in the
   iframe, Orchestra owns the whole top bar.

```tsx
   const embedded = isEmbedMode();   // before the other hooks
   ...
   if (embedded) return null;        // after every hook, before the JSX
```

3. `packages/app/src/components/split-container.tsx`, in the pane view — do not draw the
   pane's tab strip. Inside the iframe the sessions are the rows of Orchestra's own
   sidebar, so Paseo's horizontal tab bar (with its `+` and `...`) is a second, wrong
   copy of the same list:

```tsx
{
  isEmbedMode() ? null : (
    <WindowChromeSafeArea placement="inline" style={styles.paneTabs}>
      ...
    </WindowChromeSafeArea>
  );
}
```

Only the strip goes: the pane content below it is untouched. No height needs zeroing —
`styles.paneTabs` carries `position` and `minWidth` only, never a height, so the content
pane takes the room on its own.

Reapplying after `git rebase vX.Y.Z figmenta`: `embed.ts` comes across untouched. If a hunk
fails, find the same three anchors (`LeftSidebar` inside `SidebarChrome`; the `return (` of
`ScreenHeader`; the `WindowChromeSafeArea` wrapping `WorkspaceDesktopTabsRow`) and reapply by
hand — each guard is two lines and none depends on upstream internals beyond the component's
own name.

Verifying without Orchestra: open `http://127.0.0.1:8081/?embed=1` on the dev server; the left
sidebar, the header and the pane tab strip disappear, and they stay gone while navigating
inside the app.
Removing the flag needs a new tab (the latch lives in `sessionStorage`).

## Embed bridge v2

Orchestra drives the embedded client over `postMessage`, same origin. Four messages in, one
out, plus a `theme=` query on the first URL. Schema frozen in
`DMS/OS/Orchestra/PASEO/2026-09-17-maestro-v2-build-contracts.md` §4; `maestro.composer.lock` and
`maestro.models.allow` in `DMS/OS/Orchestra/PASEO/2026-09-28-maestro-disciplina-consumo-contratto.md`
§12.2.

```ts
{ type: "maestro.composer.insert", text: string, agentId: string } // append to that agent, never submit
{ type: "maestro.theme", theme: "dark" | "light" }  // hot switch
{ type: "maestro.composer.lock", agentId: string, locked: boolean, label: string | null } // read-only bar for that agent; null label = "Session expired"
{ type: "maestro.models.allow", agentId: string, models: string[], hidden?: boolean } // that agent's model menu shows only these ids; [] = ignored unless hidden; hidden: true = no model selector at all
{ type: "maestro.models.allow", agentId: "*", models: string[], hidden?: boolean }    // the person's default: drafts and every agent Orchestra never named (fleet only)
// first URL: /agents-ui/h/{serverId}/agent/{agentId}?embed=1&theme=dark|light

// out, frame → window.parent, targetOrigin = location.origin (never "*"):
{ type: "maestro.embed.ready" } // once per document, right after the listener is installed
```

The listener is installed by an effect in `SidebarChrome`, so it is up a few hundred ms AFTER the
iframe's `load` (measured on the static export: 381 ms after `load`, the post Orchestra made at
`load` arrived 8 ms after it and found nobody listening). `maestro.embed.ready` is the parent's
cue to post its per-document state (lock, models, theme) again. `hidden: true` removes the model
trigger (desktop and compact), the model sheet, the command center's model group and every profile
row that names a model; effort and permission mode stay (on the compact form factor the toolbar
layout replaces the model sheet, which is where they lived). A later message replaces the state
whole: `hidden` absent or `false` shows the selector again, narrowed by `models`.

`agentId: "*"` is the person-level default. Orchestra names only the agents it knows: a draft
(`/clear` and its alias `/new`, Fork, a new agent) has no agentId yet, and the agent it then creates
has one Orchestra never named. Resolution for an agent: its own entry if one arrived, else the `"*"`
default, else no filter (the menu Paseo would show anyway). A draft reads the `"*"` default only:
its composer (desktop trigger, compact layout and model sheet) and, while the draft is focused, the
command center's model group. Same checks and same semantics as a per-agent message: validated the
same way (`hidden: true` with `models: []` accepted, `[]` while shown ignored), replaced whole by the
next `"*"` message, never removed, forgotten on frame reload; an agent's own entry always beats it,
whichever arrived first. A draft's preselected model is not moved into the list, as for an agent:
the menu is narrowed, the daemon is the defence.

The hunks, so a rebase can be re-stitched:

| File                                                                 | Function / site                                                                   | What it does                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/figmenta/embed.ts`                                 | `readEmbedTheme`                                                                  | reads `?theme=`, latches it in `sessionStorage.figmentaTheme` (the router drops the query)                                                                                                                                                                                                                           |
|                                                                      | `applyEmbedTheme`                                                                 | `UnistylesRuntime.setAdaptiveThemes(false)` + `setTheme(THEME_TO_UNISTYLES[theme])`                                                                                                                                                                                                                                  |
|                                                                      | `reduceComposerInsert`                                                            | `(draft.length ? draft.trimEnd() + " " : "") + text` — the §4 append rule, pure                                                                                                                                                                                                                                      |
|                                                                      | `shouldBlockEmbedRoute`                                                           | true on `/settings*` and `/h/{id}/settings*`, false on `/h/{id}/agent/{id}`                                                                                                                                                                                                                                          |
|                                                                      | `rememberAgentRoute` / `lastAgentRoute`                                           | latch the last `/h/{id}/agent/{id}` in `sessionStorage.figmentaLastAgentRoute`, so a blocked route bounces back to the conversation and not to `/`                                                                                                                                                                   |
|                                                                      | `installEmbedBridge`                                                              | idempotent (`window.__figmentaEmbedBridgeInstalled`), origin-checked `message` listener, applies the latched theme on install                                                                                                                                                                                        |
|                                                                      | `subscribeToEmbedComposerInsert`                                                  | the seam the composer hook uses; delivers `{ text, agentId }` to every mounted composer, the bridge lives outside React and does not know the draft key                                                                                                                                                              |
|                                                                      | `readEmbedComposerLock` / `subscribeToEmbedComposerLock` / `useEmbedComposerLock` | the `maestro.composer.lock` state per `agentId` (memory only, Orchestra re-sends it on frame load and every 60 s); subscribers get the `agentId` that changed; a `composer.insert` for a locked agent is dropped                                                                                                     |
|                                                                      | `applyEmbedComposerLock`                                                          | the `maestro.composer.lock` case of the bridge past the origin check: `locked` must be a boolean, a blank `label` falls back to «Session expired»; exported so the host runtime tests lock an agent without a window                                                                                                 |
|                                                                      | `readEmbedModelsAllow` / `subscribeToEmbedModelsAllow` / `useEmbedModelsAllow`    | the `maestro.models.allow` state per `agentId`, `{ models, hidden }` (memory only; a new message replaces it whole, a repeat keeps the same object and notifies nobody); resolved as own entry, else the `"*"` default, else null = no filter; always null outside the embed                                         |
|                                                                      | `EMBED_MODELS_ALLOW_DEFAULT_ID`, `resolveModelsAllow` (module-private)            | `"*"`, the person-level default, stored in the same map; the resolution own → `"*"` → null; subscribers are called with `"*"` when the default changes                                                                                                                                                               |
|                                                                      | `applyEmbedModelsAllow` (module-private)                                          | the `maestro.models.allow` case past the origin check: ignored, the previous state (or no filter) staying, without a usable `agentId`, with a non-boolean `hidden`, or when `models` is not an array of non-empty strings (empty only with `hidden: true`); `"*"` alike                                              |
|                                                                      | `EMBED_READY_TYPE`, `announceEmbedReady` (module-private)                         | `installEmbedBridge` posts `{ type: "maestro.embed.ready" }` to `window.parent`, target `location.origin`, right after `addEventListener`; once per document (the install flag lives on the window); a throwing post (opaque origin) is logged, the listener stays                                                   |
| `packages/app/src/figmenta/models-allow.ts`                          | `filterProvidersByModelsAllow`                                                    | keeps the rows whose `modelId` is in the list, exact match (`claude-sonnet-5[1m]` is its own id); a provider left with no rows stays, so the trigger still shows the current model; loading/error pass                                                                                                               |
|                                                                      | `filterProfilesByModelsAllow`                                                     | hides the profile rows that name a model outside the list; a profile with no model stays (applying it leaves the model alone)                                                                                                                                                                                        |
|                                                                      | `useEmbedModelsAllowMenu`                                                         | `{ providers, profiles, hidden }` of one agent, narrowed by its list (own, else `"*"`); the very same inputs when there is no list; `hidden`: no providers, only the profiles that name no model                                                                                                                     |
|                                                                      | `useEmbedDraftModelsAllowMenu`                                                    | the same for a draft, read from the `"*"` default only                                                                                                                                                                                                                                                               |
| `packages/app/src/figmenta/composer-lock.tsx`                        | `EmbedComposerLockGate`                                                           | renders the read-only bar with the label in place of `MessageInput` while the agent is locked                                                                                                                                                                                                                        |
|                                                                      | `isEmbedComposerLocked` / `assertEmbedComposerUnlocked`                           | call-time guards, read the live lock: submit and queue return; every send (`submitMessage`, «send now» on a queued row included) throws with the label, so the text comes back                                                                                                                                       |
|                                                                      | `useEmbedComposerLockGuard`                                                       | the render's flag while locked, and stops voice mode on that agent (not mid-switch, not on another agent or host)                                                                                                                                                                                                    |
| `packages/app/src/composer/index.tsx`                                | `EmbedComposerLockGate`, `useEmbedComposerLockGuard`, the call-time guards        | one call per site at the top of `submitMessage`, `handleSubmit`, `handleQueue`, the decisions live in `composer-lock.tsx`; the gate replaces `<RenderProfile id="MessageInput">`; the flag hides `queueList`, turns off autocomplete and disables `useFileDrop`                                                      |
| `packages/app/src/composer/agent-controls/index.tsx`                 | `AgentControls`, after `useAgentProfilePicker`                                    | `const embedModelMenu = useEmbedModelsAllowMenu({ agentId, providers: agentModelSelectorProviders, profiles: agentProfiles })`                                                                                                                                                                                       |
|                                                                      | `<ControlledAgentControls>`, `commandCenterControls`                              | `modelSelectorProviders={embedModelMenu.providers}` (desktop `CombinedModelSelector`, compact `CompactModelSheet`), `agentProfiles={embedModelMenu.profiles}`, `hideModelSelector={embedModelMenu.hidden}`, `models.providers: embedModelMenu.providers`                                                             |
|                                                                      | `ControlledAgentControls` prop `hideModelSelector`, `resolveModelSelectorLayout`  | hidden: `canSelectModel` false (no `CombinedModelSelector`) and the compact form factor renders the toolbar content instead of `CompactModelSheet`, so effort and mode keep a trigger                                                                                                                                |
|                                                                      | `DraftAgentControls`, after `resolveAgentProfileEditorActions`                    | `const embedModelMenu = useEmbedDraftModelsAllowMenu({ providers: modelSelectorProviders, profiles: agentProfiles })`, then `modelSelectorProviders`, `agentProfiles`, `hideModelSelector` from it; covers every draft composer (workspace draft tab, new workspace, setup dialog)                                   |
| `packages/app/src/composer/draft/workspace-tab.tsx`                  | before `useAgentControlCommandCenterActions`                                      | `const embedDraftModelMenu = useEmbedDraftModelsAllowMenu({ providers: composerState.modelSelectorProviders, profiles: null })`; `models.providers: embedDraftModelMenu.providers`, so the draft's command center model group follows the default                                                                    |
| `packages/app/src/components/schedules/schedule-form-sheet.tsx`      | `ScheduleTargetFields`, before `modeOptions`                                      | `const embedModelMenu = useEmbedDraftModelsAllowMenu({ providers: state.modelSelectorProviders, profiles: null })`; the Model field renders only when `!embedModelMenu.hidden`, with `embedModelMenu.providers`: a schedule creates a new agent, so it follows the person's default ("\*"). E2E: the `schedule` test |
| `packages/app/src/runtime/host-runtime.ts`                           | `drainQueuedAgentMessage`, `drainQueuedAgentMessageAfterEmbedUnlock`              | the drain (turn end, timeline sync) returns while the agent is locked, the row stays queued; the constructor subscribes to lock changes and, on unlock, drains where the agent sits idle (running: at turn end). Inert outside the embed                                                                             |
| `packages/app/src/appearance/provider.tsx`                           | `applyTheme`                                                                      | returns early when `isEmbedMode() && readEmbedTheme()`, so the persisted Paseo preference cannot overwrite the imposed theme                                                                                                                                                                                         |
| `packages/app/src/composer/draft/input-draft.ts`                     | `useAgentInputDraft`                                                              | subscribes to the bridge, applies only when `agentId` matches the `agentId` option passed by `agent-panel.tsx`, then calls `replaceText(reduceComposerInsert(current, text))`. Skipped when `composer` options are passed (create-agent flow) or when no `agentId` is known                                          |
| `packages/app/src/app/_layout.tsx`                                   | `SidebarChrome`                                                                   | `installEmbedBridge()` on mount + route guard, armed only once `useRootNavigationState()?.key` exists (navigating earlier throws «Attempted to navigate before mounting the Root Layout component»): `router.back()` when it can, else `router.replace(lastAgentRoute() ?? "/")`                                     |
| `packages/app/src/components/model-browser.tsx`                      | `ProviderSettingsAction`, `CreateAgentProfileRow`, per-row create-profile action  | `return null` in embed                                                                                                                                                                                                                                                                                               |
| `packages/app/src/screens/workspace/workspace-route-state-views.tsx` | «Manage host» button                                                              | not rendered in embed                                                                                                                                                                                                                                                                                                |
| `packages/app/src/navigation/agent-route-resolution-view.tsx`        | «Manage host» button                                                              | not rendered in embed                                                                                                                                                                                                                                                                                                |

Tests: `packages/app/src/figmenta/embed.test.ts` (jsdom) covers the pure functions and the bridge;
`packages/app/src/figmenta/composer-lock.test.tsx` (jsdom) the lock bar and the composer guards;
`packages/app/src/figmenta/models-allow.test.tsx` (jsdom) the model filters and their hook;
`packages/app/src/figmenta/models-allow-agent-controls.test.tsx` (jsdom) the `AgentControls` and
`DraftAgentControls` hunks (the `"*"` default included), with the menu, the compact sheet and the
command center as stand-ins;
the two «Figmenta embed» cases in `packages/app/src/runtime/host-runtime.test.ts` the queue held under
a lock and released on unlock; `packages/app/e2e/browser/figmenta-embed-composer-lock.spec.ts`
(Playwright, `npm run test:e2e`, not part of the unit run) the lock end to end in a browser;
`packages/app/e2e-figmenta/model-switch.spec.ts` (Playwright, own config, no Metro) the model
switch end to end: the STATIC export framed by a simulated Orchestra page (request routing on
`https://orchestra.figmenta.site`) against an isolated daemon started with the CLI, with Orchestra's
timing (post at `load` and on the 60 s poll) measured and the `embed.ready` handshake, the allow
list, `hidden` and its reversal asserted; its "draft" test posts the `"*"` default, runs `/clear`
and checks the draft (desktop, compact, command center) and an agent Orchestra never named; how
to rerun is in the spec's header.
Run from `packages/app`, not the repo root — the root vitest config has no alias for
`react-native-unistyles`: `npx vitest run --project unit src/figmenta`, and
`npx vitest run --project unit src/runtime/host-runtime.test.ts -t "Figmenta embed"`.

## Orchestra Desktop

The Figmenta desktop app **is** this Electron shell, renamed, pointed at
`https://orchestra.figmenta.site`, with the Paseo daemon running underneath it and the
`figmenta-sessions` plugin preinstalled. It replaces the previous Pake/WKWebView wrapper,
which could not reach the local daemon at all: WebKit refuses `http`/`ws` to loopback from
an `https` document, so Orchestra could never talk to `127.0.0.1:6767`. Chromium, with the
origin allowlisted in the daemon's CORS config, can.

Everything policy-shaped lives in one pure module, `packages/desktop/src/figmenta/orchestra.ts`,
tested by `orchestra.test.ts` (no Electron needed):

- `ORCHESTRA_URL` / `resolveOrchestraUrl(env)` — `https://orchestra.figmenta.site`, override
  with `ORCHESTRA_URL`.
- `isOrchestraOrigin(url)` — exact origin match (scheme + host + port).
- `isAllowedNavigation(url)` — the Orchestra origin only (the OIDC login is on that host).
- `permissionPolicy(origin, permission)` — Orchestra only, and only `media`, `notifications`,
  `clipboard-read`, `clipboard-sanitized-write`, `local-network-access`. Everything else denied.
- `seedPaseoConfig` / `seedPaseoConfigText` — the merge applied to `~/.paseo/config.json`.

### What changed in the shell

`packages/desktop/src/main.ts`

- `APP_NAME` is `Orchestra`; `DEV_SERVER_URL` is gone.
- `createWindow` loads `ORCHESTRA_URL` in both dev and packaged builds. `paseo://app` stays
  registered (deep links), so `options.initialRoute` — a Paseo route — is ignored here.
- `installOrchestraWindowGuards(win)` — `setWindowOpenHandler` keeps same-origin popups in a
  window and sends everything else to `shell.openExternal`; `will-navigate` refuses any
  top-level navigation outside `isAllowedNavigation` and hands it to the system browser.
- Window chrome stays Paseo's (`getMainWindowChromeOptions`, `titleBarStyle: "hidden"`
  with the traffic lights at y=14) and the background is the site's own `--bg` (`#08090B`),
  so there is no white flash. The macOS buttons float over the page, so the preload hands
  Orchestra `titleBarInset` (28 on macOS, 0 elsewhere) and the site indents its own header:
  the shell injects no CSS and overrides no page title.
- `orchestraWebPreferences()` is shared by the main window and every same-origin popup
  (`setWindowOpenHandler` → `overrideBrowserWindowOptions`, plus `did-create-window` so the
  popup inherits the same guards). `webviewTag: false`.
- The navigation boundary covers `will-navigate`, `will-redirect` **and**
  `will-frame-navigate`; refused URLs go to `shell.openExternal` and are logged.
- Permissions: `setPermissionRequestHandler` **and** `setPermissionCheckHandler` share
  `permissionPolicy`; `setDevicePermissionHandler` denies every device.
- Seeding is atomic (`writeFileAtomic`, re-exported from `@getpaseo/server`). A
  `config.json` that does not parse is **never** rewritten: it is copied to
  `config.json.corrupt-<ts>` and reported.
- Seeding a daemon that was already running is a no-op — it read its config at boot. So
  `verifyOrchestraDaemonSeed()` asks the live daemon: `GET /api/health` with an `Origin`
  header (checking `Access-Control-Allow-Origin`) and `paseo plugin ls --json` (checking
  `figmenta-sessions` is `running`). If the seed is not in force it logs and shows a
  non-blocking dialog; the "Restart engine" button appears only for a daemon this app
  spawned, otherwise the text says who has to act.
- A version mismatch restarts the daemon only if this app spawned it
  (`shouldRestartDaemonForVersion`); a foreign daemon is reused and the reuse is logged.
- `installOrchestraSessionPolicies()` — `setPermissionRequestHandler` delegates to
  `permissionPolicy`; `webRequest.onBeforeSendHeaders` stamps `X-Orchestra-Desktop: <version>`
  on requests to the Orchestra origin only.
- `seedOrchestraDaemonConfig()` then `startOrchestraDaemon()` run in `bootstrap()` before the
  first window. In Paseo the renderer called `start_desktop_daemon` over IPC; the Orchestra
  page is remote and has no such bridge, so the main process does it.
- The plugin path is `<resources>/plugins/figmenta-sessions` when packaged, and
  `packages/desktop/figmenta-plugin` in development, filled by the sync (see
  "Plugin injection").

`packages/desktop/src/preload.ts` — rewritten. Upstream exposed `paseoDesktop` (the whole
`paseo:invoke` surface) to any document; against a remote origin that is a hole. It now exposes
only `orchestraDesktop = { version, platform }` and no IPC at all. The version arrives through
`additionalArguments` (`--orchestra-app-version=…`), since the preload can no longer ask.

`packages/desktop/src/daemon/daemon-manager.ts`

- `startDaemon` is exported.
- **Daemon provenance.** `desktopManaged: true` in `~/.paseo/paseo.pid` means "a desktop app
  spawned this daemon", not "_this_ app did". Orchestra and an installed Paseo Desktop share
  `~/.paseo`, so only the daemon THIS process launched may be stopped on quit. Since 0.9.2
  upstream tracks that natively (`ownedLaunch`, set by `startDaemonInstance`'s
  `onAcquired`); `wasDaemonSpawnedByThisApp()` is `ownedLaunch !== null` and gates the
  stop-on-quit path in `main.ts`. `startDaemon()` returns an already-running daemon
  untouched, so reuse is the normal case.
- `check_app_update` / `install_app_update` answer "nothing to do": updates go through the
  mandatory updater (below), not upstream's GitHub feed.

### Which daemon Orchestra starts

Reusing a daemon that is already listening is unchanged. When NOTHING is listening,
Orchestra launches the **newest** `@getpaseo/server` on the machine: its own bundled one, or
the one inside `/Applications/Paseo.app` (macOS only), run with Paseo's own Electron helper,
`node-entrypoint-runner.js` and `bin/paseo` — never our binary on its code. A tie, or a
version that is not semver, keeps the bundled server; a Paseo runtime that fails to start
falls back to the bundled one. Windows keeps the bundled server (no equally reliable install
location to probe). Origin of the fix: on 2026-09-27 Orchestra 0.8.0 started before Paseo
0.9.2 and took `:6767` with a daemon that did not know the newest models.

- `src/figmenta/daemon-runtime.ts` — `compareVersions` (semver precedence) and
  `pickDaemonRuntime`, pure; `daemon-runtime.test.ts`.
- `src/daemon/runtime-paths.ts` — `resolveBundledDaemonRuntime`, `resolvePaseoAppDaemonRuntime`.
- The log says what was chosen: `[desktop daemon] daemon runtime selected {source, version,
bundledVersion, paseoAppVersion}`.
- The version-mismatch restart compares the daemon with the server version this app
  launched (`ownedLaunch.serverVersion`), not with the app version.

### Version line

Orchestra Desktop has its own version line from **1.0.0** (`packages/desktop/package.json`),
independent of the Paseo server it bundles: upstream releases would otherwise collide with
ours in the updater's comparison. `window.orchestraDesktop.version` and the
`X-Orchestra-Desktop` header report it. Bump it for every Orchestra release; the bundled
server version is whatever upstream tag the branch sits on.

### Mandatory updater

Decision (Federico, 2026-09-27): to use Orchestra you need the latest version. No Skip, no
Remind me later, no countdown.

- Feed: `https://downloads.figmenta.site/orchestra-desktop/updates/` (electron-updater,
  `generic` provider): `latest-mac.yml` + `Orchestra-<v>-<arch>.zip` for macOS, `latest.yml` +
  `Orchestra-Setup-<v>-x64.exe` for Windows (+ `.blockmap`).
- Check at launch, every 30 minutes, and on wake — powerMonitor `resume` / `unlock-screen`
  and window focus — at most once every 5 minutes (a machine that slept through the timer
  would otherwise stay on the old version). Nothing newer, offline or feed unreachable: nothing
  happens, the app stays usable, the next round tries again.
- A newer version: download at once behind a screen that covers every window (a
  `WebContentsView` above the page, keyboard to the page blocked), with progress; then one
  button, **«Install and restart»**. A failed download: same screen, **«Retry»** (it checks
  again, then downloads; if the feed is unreachable at that moment the screen goes away until
  the next round). Before relaunching, the daemon this app launched is stopped.
- Windows relaunch: the update runs the installer with `--updated /S --force-run`; the
  installer (one-click, per user, from 1.0.3) relaunches `Orchestra.exe --updated`. Until
  1.0.4 that argument was read as a CLI call (`paseo --updated`) and the relaunched app
  exited at once, so Orchestra never came back after an update (CI run 36404199037).
  `--updated` is now a GUI launch (`daemon/cli/passthrough.ts`). The first version that
  comes back on its own is the one being INSTALLED (the relaunched binary), so an update
  from 1.0.0–1.0.3 to 1.0.4 already reopens.
- UI copy is English from 1.0.5 (Federico, 2026-09-28): the update screen and both
  move-to-Applications dialogs. Up to 1.0.4 they were Italian, and the screen is drawn by
  the RUNNING version, so an update from 1.0.4 to 1.0.5 still shows the Italian one.
- Never a downgrade: an announced version must be strictly newer than the running one,
  checked twice (state machine and runtime). electron-updater's `channel` setter is never
  used — assigning it turns `allowDowngrade` back on.
- macOS, outside `/Applications` (opened from the dmg, a copy in Downloads, a read-only or
  translocated volume): at launch Orchestra offers to move itself there
  (`app.moveToApplicationsFolder`, English dialog, relaunch). Declined or failed, a failed
  update explains the location instead of the connection.
- Code: `src/figmenta/mandatory-update.ts` (state machine, pure, tested),
  `mandatory-update-runtime.ts` (electron-updater configuration, tested with a fake),
  `mandatory-update-electron.ts` (electron-updater + screen), `update-overlay-page.ts`
  (data: URL page, English copy), `update-overlay-preload.ts` (sandboxed).
- `ORCHESTRA_UPDATE_FEED_URL` overrides the feed **only for a loopback host** (the
  end-to-end test); anything else is refused and logged.
- `after-pack.js` sets `updaterCacheDirName: orchestra-desktop-updater` in `app-update.yml`:
  electron-builder derives it from the package name, which is Paseo Desktop's too, and
  electron-updater cleans that directory on every check.
- macOS installs only a **signed** update (Squirrel.Mac checks the code signature against
  the running app): CI's unsigned macOS dmgs are not update material.
- Upstream's updater (`features/auto-updater.ts`, channels, rollout) stays in the tree,
  unwired.

End-to-end check (2026-09-27, Apple Silicon): a signed 1.0.0 in a test folder, isolated
with its own `PASEO_HOME` (daemon on a test port via that home's `config.json`
`daemon.listen` — managed launches drop `PASEO_LISTEN`), `PASEO_ELECTRON_USER_DATA_DIR` and
a loopback feed. Feed down: no screen, the page works. Feed announcing 1.0.1 without the
zip: «Download non riuscito» + «Riprova»; zip published, «Riprova»: download, «Installa e
riavvia», relaunch on 1.0.1 (`orchestraDesktop.version` = 1.0.1) in ~15 s. The e2e build
differs from a release only in bundle id (`it.figmenta.orchestra.e2e`) and an Info.plist
`LSEnvironment` carrying the isolation env across the Squirrel relaunch. Known: the log file
is `~/Library/Logs/Orchestra/main.log` whatever the userData, so a test build writes into
the same log as the installed Orchestra.

Publishing a release on the feed (by hand, VPS-09 `/home/ivan/public-downloads/orchestra-desktop/`):
copy the zip/exe and blockmaps into `updates/` FIRST, the `.yml` manifests LAST. Never reuse
a file name: Cloudflare caches zip/exe/dmg for 4 hours, and a stale file with a new sha512 in
the manifest is a download that fails on every client.

Cache headers measured on 2026-09-27: every file is served with `cache-control:
max-age=14400` and zip/exe/dmg are `cf-cache-status: HIT`; a `.yml` is not in Cloudflare's
default cached extensions, and electron-updater requests the manifest with `Cache-Control:
no-cache` and a random `?noCache=` query, so it is fetched fresh today. Proposed (not
applied) to make that explicit at the origin (Caddy, `downloads-figmenta.service`):

```caddyfile
@orchestra_manifest path /orchestra-desktop/updates/*.yml
header @orchestra_manifest Cache-Control "no-store, max-age=0"
@orchestra_artifacts path /orchestra-desktop/updates/*.zip /orchestra-desktop/updates/*.exe /orchestra-desktop/updates/*.blockmap
header @orchestra_artifacts Cache-Control "public, max-age=31536000, immutable"
```

plus, on Cloudflare, a Cache Rule "bypass cache" for `/orchestra-desktop/updates/*.yml` and
Browser Cache TTL "Respect existing headers" for that path.

### Plugin injection

The `figmenta-sessions` plugin is private (`Figmenta/paseo-orchestra-plugin`) and this
repository is public. Its source is never committed here, pushed here, or uploaded as an
artifact of a workflow of this repository. `packages/desktop/figmenta-plugin/` is
git-ignored and filled right before a build.

1. **Sync**, from a checkout of the private repository at an exact ref:

   ```sh
   packages/desktop/scripts/figmenta-plugin-sync.sh <path-to-paseo-orchestra-plugin> <git-ref>
   ```

   It empties the folder and extracts `git archive` of that commit, keeping only what the
   daemon esbuilds: `index.server.ts`, `index.client.tsx`, `server/`, `client/`, `shared/`,
   `package.json`, `paseo-plugin.json`, `tsconfig.json`. Tests, fixtures, README, lockfile
   and CI files stay out; a top-level entry the script does not know fails the sync until it
   is added to its keep or skip list. `figmenta-plugin/.source` records ref, sha and version.

2. **Guard**. `packages/desktop/figmenta-plugin.version` (committed: a version number, no
   code) names the plugin version this app ships. `scripts/figmenta-plugin-guard.js` fails
   the build when `figmenta-plugin/package.json` is missing, when its version, the one in
   `.source` or `PLUGIN_VERSION` in `shared/version.ts` differs, or when an entry point is
   missing. It is electron-builder's `beforePack` hook, so it stops `npm run build:desktop`,
   the signed macOS release and CI alike; `node packages/desktop/scripts/figmenta-plugin-guard.js`
   runs it alone, and `figmenta-release-mac.sh` runs it before building anything.
3. **Windows** is built in the private repository: `.github/workflows/desktop-windows.yml` of
   `paseo-orchestra-plugin`, on a tag `desktop-win-v<app version>` or by hand. It checks out
   this fork (public, no token) at the full sha in the plugin's `desktop/FORK_REF`, syncs the
   plugin at the triggering ref, runs the guard, then the unsigned NSIS build and the
   `latest.yml` check, and uploads exe, blockmap and `latest.yml` as a private artifact
   (7 days). A tag must equal `packages/desktop/package.json`'s version at `FORK_REF`. This
   repository's `figmenta-windows.yml` only fails, with a pointer.
4. **macOS**: sync, then the signed release on the Mac with the Developer ID identity
   ("Signed macOS release" below).

A release that moves the plugin: bump `figmenta-plugin.version` (and the app version) in the
fork and commit; write that fork commit's full sha into the plugin's `desktop/FORK_REF` and
commit; tag the plugin commit. The tag then pins both sides.

### Packaging

`packages/desktop/electron-builder.yml`: `appId it.figmenta.orchestra`, product and executable
`Orchestra`, `artifactName Orchestra-${version}-${arch}.${ext}`, `publish` = the generic feed
above (electron-builder writes `app-update.yml` into the app and `latest*.yml` next to the
artifacts; `--publish never` uploads nothing), and on macOS `hardenedRuntime: true` with
`identity: null` / `notarize: false` — the repository is public, so signing is switched on
only by the local release script. `afterSign` stays — it only runs the smoke under
`PASEO_DESKTOP_SMOKE=1`. `bin/paseo`, `scripts/after-pack.js`, `scripts/after-sign.js` and
`e2e/packaged-app-smoke.js` carry the `Orchestra`/`Orchestra Helper.app` names. Icons in
`packages/desktop/assets/` were replaced from the Orchestra `.icns`.

The plugin ships as `extraResources` from `packages/desktop/figmenta-plugin` (filled by the
sync above, never committed; tests and `__fixtures__` filtered out). The daemon esbuilds the
plugin from that directory and externalizes only `react`, `react-native` and
`@getpaseo/plugin/*`; `zod` is its one bundled runtime dependency, so `node_modules/zod` is
copied next to it. No other `node_modules` are shipped.

Claude Code is still not bundled (upstream choice, `after-pack.js`): the app uses the `claude`
on the user's PATH, inherited from the login shell.

Unsigned build (development):

```sh
npm install   # root, once — postinstall downloads the Electron binary
packages/desktop/scripts/figmenta-plugin-sync.sh <path-to-paseo-orchestra-plugin> <git-ref>
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop -- --publish never \
  --mac dmg --arm64 -c.mac.identity=null -c.mac.notarize=false -c.mac.hardenedRuntime=false
```

If `dmg-builder` answers 500 on its bundle download, fetch the bundle by hand and point
`ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL` at it.

### Signed macOS release

Only on the Mac that holds the Developer ID identity (never CI: the repo is public):

```sh
packages/desktop/scripts/figmenta-plugin-sync.sh <path-to-paseo-orchestra-plugin> <git-ref>
FIGMENTA_ASC_ISSUER=<App Store Connect issuer id> packages/desktop/scripts/figmenta-release-mac.sh
```

- Signing material, read from files and never printed or put on a command line: the
  keychain is unlocked through the Security framework (`scripts/figmenta-unlock-keychain.py`,
  not `security unlock-keychain -p`) and relocked on exit, error included. The dedicated keychain
  `~/Library/Keychains/figmenta-codesign.keychain-db` (password in
  `~/.figmenta-codesign/keychain.pw`), identity `Developer ID Application: Figmenta S.r.l.
(8UK563QG96)`, App Store Connect API key `~/.figmenta-codesign/AuthKey_<id>.p8` (key id from
  the file name). The issuer id comes from `FIGMENTA_ASC_ISSUER` or
  `~/.figmenta-codesign/asc_issuer`.
- Builds arm64 and x64 (`dmg` + `zip`), hardened runtime with `build/entitlements.mac.plist`
  (upstream's: JIT, unsigned executable memory, microphone), notarizes and staples the app
  (electron-builder), then signs, notarizes and staples each dmg.
- x64 is cross-built on Apple Silicon: node-pty ships N-API prebuilds for both arches, and the
  script unpacks the x64 twins of the two arm64-only optional packages that ship in the app
  (`@esbuild/darwin-*` for the plugin build, `sherpa-onnx-darwin-*`) for the x64 pass only.
- Merges the two `latest-mac.yml` into one (`scripts/merge-mac-manifest.mjs`, as upstream)
  AFTER the dmgs are stapled, keeping the zips only (`scripts/figmenta-mac-manifest.mjs`): the
  updater downloads zips, and a dmg re-stapled after hashing would carry a stale sha512.
- Refuses extra builder arguments that would turn the release into another flavor
  (`--config`, `appId`, `extendInfo`/`LSEnvironment`, `extraMetadata`, `e2e`).
- Ends with `scripts/figmenta-verify-mac.sh`: per dmg AND per zip, `spctl` on the dmg, then
  on the app `codesign --verify --deep --strict`, `spctl -a -vv` (Notarized Developer ID),
  `stapler validate`, bundle id `it.figmenta.orchestra`, `LSEnvironment` limited to Electron's own
  `MallocNanoZone`, production feed
  in `app-update.yml`, `lipo -archs` of the main binary and of every native module; then
  every entry of `latest-mac.yml` against size and sha512 on disk.

Windows: in the private plugin repository (see "Plugin injection").

### Rebase on 0.9.2

On 2026-09-27 the 15 Figmenta commits were rebased from `v0.8.0` onto `v0.9.2` (branch
`figmenta-092`). Conflicts and how they were resolved:

- `daemon-manager.ts`: upstream rewrote daemon start on `startDaemonInstance` /
  `isSameDaemonInstance`, which tracks the instance this app launched. That replaced the
  fork's `daemonSpawnedByThisApp` flag; the fork keeps `startDaemon` exported and
  `wasDaemonSpawnedByThisApp()` now reads `ownedLaunch`.
- `daemon-manager.test.ts`: upstream's rewritten suite kept; the fork's cases targeted the
  old spawn path (the "only our own daemon" rule is covered by `orchestra.test.ts`).
- `after-pack.js`: upstream's `installLinuxLauncher` kept, `EXECUTABLE_NAME = "Orchestra"`.
- `screen-header.tsx`: the embed-mode guard kept on upstream's reworked header.
- Version: `packages/desktop/package.json` took 0.9.2 during the rebase, then 1.0.0.

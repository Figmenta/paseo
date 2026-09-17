# Figmenta branch

Branch `figmenta` = upstream release tag + a minimal set of patches. Rules:

1. Never edit `main`; it mirrors upstream.
2. Patches live here as separate commits on top of the release tag (today `v0.8.0`).
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

Orchestra drives the embedded client over `postMessage`, same origin, no answer back.
Two messages in, plus a `theme=` query on the first URL. Schema frozen in
`DMS/OS/Orchestra/PASEO/2026-09-17-maestro-v2-build-contracts.md` §4.

```ts
{ type: "maestro.composer.insert", text: string, agentId: string } // append to that agent, never submit
{ type: "maestro.theme", theme: "dark" | "light" }  // hot switch
// first URL: /agents-ui/h/{serverId}/agent/{agentId}?embed=1&theme=dark|light
```

The hunks, so a rebase can be re-stitched:

| File                                                                 | Function / site                                                                  | What it does                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/figmenta/embed.ts`                                 | `readEmbedTheme`                                                                 | reads `?theme=`, latches it in `sessionStorage.figmentaTheme` (the router drops the query)                                                                                                                                                                                       |
|                                                                      | `applyEmbedTheme`                                                                | `UnistylesRuntime.setAdaptiveThemes(false)` + `setTheme(THEME_TO_UNISTYLES[theme])`                                                                                                                                                                                              |
|                                                                      | `reduceComposerInsert`                                                           | `(draft.length ? draft.trimEnd() + " " : "") + text` — the §4 append rule, pure                                                                                                                                                                                                  |
|                                                                      | `shouldBlockEmbedRoute`                                                          | true on `/settings*` and `/h/{id}/settings*`, false on `/h/{id}/agent/{id}`                                                                                                                                                                                                      |
|                                                                      | `rememberAgentRoute` / `lastAgentRoute`                                          | latch the last `/h/{id}/agent/{id}` in `sessionStorage.figmentaLastAgentRoute`, so a blocked route bounces back to the conversation and not to `/`                                                                                                                               |
|                                                                      | `installEmbedBridge`                                                             | idempotent (`window.__figmentaEmbedBridgeInstalled`), origin-checked `message` listener, applies the latched theme on install                                                                                                                                                    |
|                                                                      | `subscribeToEmbedComposerInsert`                                                 | the seam the composer hook uses; delivers `{ text, agentId }` to every mounted composer, the bridge lives outside React and does not know the draft key                                                                                                                          |
| `packages/app/src/appearance/provider.tsx`                           | `applyTheme`                                                                     | returns early when `isEmbedMode() && readEmbedTheme()`, so the persisted Paseo preference cannot overwrite the imposed theme                                                                                                                                                     |
| `packages/app/src/composer/draft/input-draft.ts`                     | `useAgentInputDraft`                                                             | subscribes to the bridge, applies only when `agentId` matches the `agentId` option passed by `agent-panel.tsx`, then calls `replaceText(reduceComposerInsert(current, text))`. Skipped when `composer` options are passed (create-agent flow) or when no `agentId` is known      |
| `packages/app/src/app/_layout.tsx`                                   | `SidebarChrome`                                                                  | `installEmbedBridge()` on mount + route guard, armed only once `useRootNavigationState()?.key` exists (navigating earlier throws «Attempted to navigate before mounting the Root Layout component»): `router.back()` when it can, else `router.replace(lastAgentRoute() ?? "/")` |
| `packages/app/src/components/model-browser.tsx`                      | `ProviderSettingsAction`, `CreateAgentProfileRow`, per-row create-profile action | `return null` in embed                                                                                                                                                                                                                                                           |
| `packages/app/src/screens/workspace/workspace-route-state-views.tsx` | «Manage host» button                                                             | not rendered in embed                                                                                                                                                                                                                                                            |
| `packages/app/src/navigation/agent-route-resolution-view.tsx`        | «Manage host» button                                                             | not rendered in embed                                                                                                                                                                                                                                                            |

Tests: `packages/app/src/figmenta/embed.test.ts` (jsdom) covers the pure functions.
Run from `packages/app`, not the repo root — the root vitest config has no alias for
`react-native-unistyles`: `npx vitest run --project unit src/figmenta`.

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
- `isAllowedNavigation(url)` — Orchestra plus https `*.figmenta.site`, for the login hop.
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
  `packages/desktop/figmenta-plugin` in development.

`packages/desktop/src/preload.ts` — rewritten. Upstream exposed `paseoDesktop` (the whole
`paseo:invoke` surface) to any document; against a remote origin that is a hole. It now exposes
only `orchestraDesktop = { version, platform }` and no IPC at all. The version arrives through
`additionalArguments` (`--orchestra-app-version=…`), since the preload can no longer ask.

`packages/desktop/src/daemon/daemon-manager.ts`

- `startDaemon` is exported.
- **Daemon provenance.** `desktopManaged: true` in `~/.paseo/paseo.pid` means "a desktop app
  spawned this daemon", not "_this_ app did". Orchestra and an installed Paseo Desktop share
  `~/.paseo`, so the upstream check would let Orchestra kill Federico's daemon on quit. A
  module-level `daemonSpawnedByThisApp`, set only when our own spawn returns, gates the
  stop-on-quit path in `main.ts`. `startDaemon()` returns an already-running daemon untouched,
  so reuse is the normal case and the flag stays false.
- `check_app_update` / `install_app_update` are logged no-ops, as is `installAppUpdateOnQuit`
  in `main.ts`.

### Packaging

`packages/desktop/electron-builder.yml`: `appId it.figmenta.orchestra`, product and executable
`Orchestra`, `artifactName Orchestra-${version}-${arch}.${ext}`, `publish: null`, and on macOS
`hardenedRuntime: false`, `notarize: false`, `identity: null` (internal distribution, no
Developer ID). `afterSign` stays — it only runs the smoke under `PASEO_DESKTOP_SMOKE=1`.
`bin/paseo`, `scripts/after-pack.js`, `scripts/after-sign.js` and `e2e/packaged-app-smoke.js`
carry the `Orchestra`/`Orchestra Helper.app` names. Icons in `packages/desktop/assets/` were
replaced from the Orchestra `.icns`.

The plugin ships as `extraResources`, from **inside the checkout** (`packages/desktop/figmenta-plugin`,
a copy of `paseo-orchestra-plugin` at `b15c202`) so the build never reaches a sibling repo.
The daemon esbuilds the plugin from that directory and externalizes only `react`,
`react-native` and `@getpaseo/plugin/*`; `zod` is its one bundled runtime dependency, so
`node_modules/zod` is copied next to it. No other `node_modules` are shipped.

Claude Code is still not bundled (upstream choice, `after-pack.js`): the app uses the `claude`
on the user's PATH, inherited from the login shell.

Build:

```sh
npm install   # root, once — postinstall downloads the Electron binary
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop -- --publish never \
  --mac dmg --arm64 -c.mac.identity=null -c.mac.notarize=false -c.mac.hardenedRuntime=false
```

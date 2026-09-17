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
   {isEmbedMode() ? null : (
     <WindowChromeSafeArea placement="inline" style={styles.paneTabs}>
       ...
     </WindowChromeSafeArea>
   )}
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
- `getOrchestraWindowChromeOptions()` — the window takes the **native** title bar
  (`titleBarStyle: "default"` on macOS, `frame: true` elsewhere). Paseo drew its own bar
  (`hidden` + overlay + a traffic-light offset) because its client left a gap for the macOS
  buttons; the Orchestra site leaves none, so the buttons sat on top of its logo. The guards
  also `preventDefault()` `page-title-updated`, so the native bar keeps reading "Orchestra"
  instead of the page's `<title>`. No CSS is injected into the site.
- Cookie durability: `orchestra_session` is a **persistent** cookie (`Max-Age` 7 days,
  `maestro/web/src/lib/session.ts:9,:126-129`), so Chromium keeps it across launches with no
  help from us. Its store writes are asynchronous, so `before-quit` calls
  `session.defaultSession.cookies.flushStore()` — a login seconds before quit could still be
  in flight. No cookie is rewritten or re-dated by the shell.
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
  spawned this daemon", not "*this* app did". Orchestra and an installed Paseo Desktop share
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

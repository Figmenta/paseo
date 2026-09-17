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

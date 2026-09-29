// Figmenta fork: the "Setting up Claude Code" screen (claude-code-setup-electron.ts), served as a
// data: URL like the update screen (update-overlay-page.ts): no file in the bundle, no network. It
// talks to the main process only through `window.orchestraSetup` (claude-code-setup-preload.ts).
// English copy, one action at a time. Closing the window never quits Orchestra: without Claude Code
// it opens anyway, and this page says so when the setup fails.

export const CLAUDE_CODE_SETUP_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Orchestra</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; }
  body {
    background: #08090B;
    color: #E8E9EC;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    -webkit-user-select: none; user-select: none;
  }
  main { width: min(400px, calc(100% - 48px)); text-align: center; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 8px; color: #A4A7AE; }
  .bar { height: 6px; border-radius: 3px; background: #1C1E23; overflow: hidden; margin: 24px 0 8px; }
  .fill { height: 100%; width: 30%; background: #E8E9EC; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  .error {
    font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; color: #E0787A;
    text-align: left; white-space: pre-wrap; word-break: break-word;
    max-height: 120px; overflow: auto; margin-top: 12px; -webkit-user-select: text; user-select: text;
  }
  .after { font-size: 13px; margin-top: 12px; }
  button {
    margin-top: 20px; padding: 10px 22px; border: 0; border-radius: 8px;
    background: #E8E9EC; color: #08090B; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:focus-visible { outline: 2px solid #7AA2F7; outline-offset: 3px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1 id="title">Setting up Claude Code…</h1>
  <p id="lead">Orchestra runs your agents with Claude Code. Installing it now: this happens once and takes a minute or two.</p>
  <div id="bar" class="bar"><div class="fill"></div></div>
  <div id="error" class="error" hidden></div>
  <p id="after" class="after" hidden>Orchestra opens without it: Maestro cannot start sessions until Claude Code is set up. Close this window to go on, and try again later from the File menu.</p>
  <button id="retry" type="button" hidden>Try again</button>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const LEAD = {
    "claude-code": "Orchestra runs your agents with Claude Code. Installing it now: this happens once and takes a minute or two.",
    "git-bash": "Unpacking Git Bash, which Claude Code uses on Windows. This happens once and takes under a minute.",
  };
  const FAILED = { "claude-code": "Claude Code is not set up", "git-bash": "Git Bash is not set up" };
  function render(state) {
    if (!state || typeof state !== "object") return;
    const bar = $("bar"), error = $("error"), after = $("after"), retry = $("retry");
    switch (state.phase) {
      case "installing":
        $("title").textContent = "Setting up Claude Code…";
        $("lead").textContent = state.attempt > 1
          ? "Trying again. This can take a minute or two."
          : (LEAD[state.component] || LEAD["claude-code"]);
        bar.hidden = false; error.hidden = true; after.hidden = true; retry.hidden = true;
        break;
      case "failed":
        $("title").textContent = FAILED[state.component] || FAILED["claude-code"];
        $("lead").textContent = state.message || "";
        bar.hidden = true;
        error.hidden = !state.detail;
        error.textContent = state.detail || "";
        error.scrollTop = error.scrollHeight; // the last lines say why it stopped
        after.hidden = false;
        retry.hidden = false; retry.disabled = false;
        retry.focus();
        break;
      case "starting":
        $("title").textContent = state.restart ? "Restarting the engine…" : "Starting Orchestra…";
        $("lead").textContent = "Claude Code is ready.";
        bar.hidden = false; error.hidden = true; after.hidden = true; retry.hidden = true;
        break;
    }
  }
  $("retry").addEventListener("click", () => { $("retry").disabled = true; window.orchestraSetup.retry(); });
  window.orchestraSetup.onState(render);
  window.orchestraSetup.getState().then(render);
</script>
</body>
</html>`;

export function claudeCodeSetupPageUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(CLAUDE_CODE_SETUP_PAGE_HTML)}`;
}

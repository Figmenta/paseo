// Figmenta fork: the mandatory-update screen, served as a data: URL so it needs no file
// in the bundle and never touches the network. It talks to the main process only through
// `window.orchestraUpdate` (update-overlay-preload.ts). Italian copy, one action at a time.

export const UPDATE_OVERLAY_PAGE_HTML = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Aggiornamento di Orchestra</title>
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
  main { width: min(420px, calc(100% - 48px)); text-align: center; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 8px; color: #A4A7AE; }
  .bar { height: 6px; border-radius: 3px; background: #1C1E23; overflow: hidden; margin: 24px 0 8px; }
  .fill { height: 100%; width: 0; background: #E8E9EC; transition: width .2s ease; }
  .bar.indeterminate .fill { width: 30%; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  .pct { font-variant-numeric: tabular-nums; font-size: 13px; color: #A4A7AE; min-height: 20px; }
  .error { font-size: 13px; color: #E0787A; word-break: break-word; margin-top: 12px; }
  button {
    margin-top: 24px; padding: 10px 22px; border: 0; border-radius: 8px;
    background: #E8E9EC; color: #08090B; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:focus-visible { outline: 2px solid #7AA2F7; outline-offset: 3px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1 id="title">Aggiornamento di Orchestra</h1>
  <p id="lead">Per usare Orchestra serve l'ultima versione.</p>
  <div id="bar" class="bar indeterminate" hidden><div id="fill" class="fill"></div></div>
  <div id="pct" class="pct" hidden></div>
  <div id="error" class="error" hidden></div>
  <button id="install" type="button" hidden>Installa e riavvia</button>
  <button id="retry" type="button" hidden>Riprova</button>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const label = (version) => (version ? "la versione " + version : "una nuova versione");
  function render(state) {
    if (!state || typeof state !== "object") return;
    const bar = $("bar"), fill = $("fill"), pct = $("pct"), error = $("error");
    const install = $("install"), retry = $("retry");
    bar.hidden = pct.hidden = error.hidden = install.hidden = retry.hidden = true;
    switch (state.phase) {
      case "downloading": {
        $("title").textContent = "Aggiornamento di Orchestra";
        $("lead").textContent = "Sto scaricando " + label(state.version) + ". Per usare Orchestra serve l'ultima versione.";
        bar.hidden = false;
        const known = typeof state.percent === "number";
        bar.classList.toggle("indeterminate", !known);
        fill.style.width = known ? state.percent + "%" : "";
        pct.hidden = false;
        pct.textContent = known ? state.percent + "%" : "";
        break;
      }
      case "ready":
        $("title").textContent = "Aggiornamento pronto";
        $("lead").textContent = "Orchestra " + state.version + " è pronta: installala per continuare.";
        install.hidden = false;
        install.disabled = false;
        install.focus();
        break;
      case "failed":
        $("title").textContent = "Download non riuscito";
        $("lead").textContent = "Non sono riuscito a scaricare " + label(state.version) + ". Controlla la connessione e riprova.";
        error.hidden = false;
        error.textContent = state.message || "";
        retry.hidden = false;
        retry.focus();
        break;
      case "installing":
        $("title").textContent = "Installazione in corso";
        $("lead").textContent = "Orchestra si riavvia da sola sulla versione " + state.version + ".";
        bar.hidden = false;
        bar.classList.add("indeterminate");
        fill.style.width = "";
        break;
    }
  }
  $("install").addEventListener("click", () => { $("install").disabled = true; window.orchestraUpdate.install(); });
  $("retry").addEventListener("click", () => window.orchestraUpdate.retry());
  window.orchestraUpdate.onState(render);
  window.orchestraUpdate.getState().then(render);
</script>
</body>
</html>`;

export function updateOverlayPageUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(UPDATE_OVERLAY_PAGE_HTML)}`;
}

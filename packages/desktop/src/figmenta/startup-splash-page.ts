// Figmenta fork: the startup splash page. A data: URL with the logo inlined, so it needs no
// file:// access and never touches the network. No script at all: the CSP says so and the
// window runs with JavaScript off; the loading bar is a CSS animation, the fade-out is the
// window's opacity, driven by the main process. English copy: only "v<version>".

export const STARTUP_SPLASH_WIDTH = 320;
export const STARTUP_SPLASH_HEIGHT = 300;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function startupSplashPageHtml(input: {
  version: string;
  logoDataUrl: string | null;
}): string {
  const logo =
    input.logoDataUrl && input.logoDataUrl.startsWith("data:image/png;base64,")
      ? `<img class="logo" alt="Orchestra" src="${input.logoDataUrl}">`
      : `<div class="logo" aria-label="Orchestra"></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Orchestra</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body {
    background: #08090B;
    color: #A4A7AE;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    -webkit-user-select: none; user-select: none; cursor: default;
  }
  .logo { width: 104px; height: 104px; border-radius: 24px; }
  .bar { width: 120px; height: 3px; border-radius: 2px; background: #1C1E23; overflow: hidden; margin: 32px 0 14px; }
  .fill { width: 40%; height: 100%; border-radius: 2px; background: #E8E9EC; animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
  .version { font-variant-numeric: tabular-nums; letter-spacing: .02em; }
  @media (prefers-reduced-motion: reduce) { .fill { animation-duration: 2.4s; } }
</style>
</head>
<body>
${logo}
<div class="bar" role="progressbar" aria-label="Loading"><div class="fill"></div></div>
<div class="version">v${escapeHtml(input.version)}</div>
</body>
</html>`;
}

export function startupSplashPageUrl(input: {
  version: string;
  logoDataUrl: string | null;
}): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(startupSplashPageHtml(input))}`;
}

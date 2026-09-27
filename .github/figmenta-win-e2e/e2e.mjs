// Figmenta fork: end-to-end test of Orchestra Desktop's mandatory updater on a real Windows
// machine (GitHub Actions windows-latest). Drives the INSTALLED app through the Chrome
// DevTools Protocol (--remote-debugging-port via PASEO_ELECTRON_FLAGS).
//
//   node e2e.mjs
// env: E2E_WORK (dir with installer-1.0.0.exe, feed-new/, feed-old/), E2E_OUT (artifacts)
//
// Cases:
//   negative  feed announces 0.9.0            -> no overlay, page usable
//   positive  feed announces 1.0.1 (built)    -> overlay covers the window, "ready",
//             click "Installa e riavvia" -> silent install -> relaunch on 1.0.1
import { execFileSync, spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORK = process.env.E2E_WORK;
const OUT = process.env.E2E_OUT;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18765;
const CDP = 9222;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, fn, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timeout waiting for ${label} (${timeoutMs} ms); last: ${String(last?.message ?? last)}`,
  );
}

// ---------------------------------------------------------------- local feed + page
const serverLog = path.join(OUT, "server.log");
const routes = [
  ["/updates/", path.join(WORK, "feed-new")],
  ["/updates-old/", path.join(WORK, "feed-old")],
];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  appendFileSync(
    serverLog,
    `${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}\n`,
  );
  let file = null;
  if (url.pathname === "/") file = path.join(HERE, "site.html");
  for (const [prefix, dir] of routes) {
    if (url.pathname.startsWith(prefix))
      file = path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length)));
  }
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Cache-Control": "no-store" }).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Length": statSync(file).size,
    "Content-Type": file.endsWith(".html") ? "text/html" : "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

// ---------------------------------------------------------------- CDP
async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  } catch {
    return null;
  }
}
async function cdp(target, method, params = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const result = await new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  return result;
}
async function evaluate(target, expression) {
  const result = await cdp(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}
async function shot(target, name) {
  const { data } = await cdp(target, "Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
}
function desktopShot(name) {
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(HERE, "desktop-shot.ps1"),
        path.join(OUT, name),
      ],
      { stdio: "pipe" },
    );
    return true;
  } catch (error) {
    console.log(
      `desktop screenshot ${name} not available: ${String(error.stderr ?? error.message).slice(0, 300)}`,
    );
    return false;
  }
}
const isPage = (t) => t.type === "page" && t.url.startsWith(BASE);
const isOverlay = (t) => t.type === "page" && t.url.startsWith("data:text/html");
async function pageTarget() {
  return (await targets())?.find(isPage) ?? null;
}
async function overlayTarget() {
  return (await targets())?.find(isOverlay) ?? null;
}

// ---------------------------------------------------------------- app lifecycle
const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
function findInstalledExe() {
  const root = path.join(localAppData, "Programs");
  for (const dir of existsSync(root) ? readdirSync(root) : []) {
    const exe = path.join(root, dir, "Orchestra.exe");
    if (existsSync(exe)) return exe;
  }
  return null;
}
function fileVersion(exe) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Item '${exe}').VersionInfo.ProductVersion`],
    { encoding: "utf8" },
  ).trim();
}
function logFiles() {
  const found = [];
  for (const base of [appData, localAppData]) {
    for (const dir of existsSync(base) ? readdirSync(base) : []) {
      const file = path.join(base, dir, "logs", "main.log");
      if (/orchestra/i.test(dir) && existsSync(file)) found.push(file);
    }
  }
  return found;
}
function logText() {
  return logFiles()
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}
const paseoHome = path.join(WORK, "paseo-home");
mkdirSync(paseoHome, { recursive: true });
function appEnv(feedPath) {
  return {
    PASEO_HOME: paseoHome,
    ORCHESTRA_URL: BASE,
    ORCHESTRA_UPDATE_FEED_URL: `${BASE}${feedPath}`,
    PASEO_ELECTRON_FLAGS: `--remote-debugging-port=${CDP}`,
  };
}
// The NSIS installer relaunches the app through the shell (explorer), not as our child:
// our process env does not reach it. The same variables are therefore also set at USER
// level (registry + WM_SETTINGCHANGE broadcast), which explorer passes to what it starts.
// The runner VM is thrown away after the job.
function setUserEnv(vars) {
  const script = Object.entries(vars)
    .map(([name, value]) => `[Environment]::SetEnvironmentVariable('${name}', '${value}', 'User')`)
    .join("; ");
  execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "inherit" });
}
function processes() {
  try {
    return execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Orchestra' } | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)\" }",
      ],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    return `process list failed: ${error.message}`;
  }
}
function launch(exe, feedPath) {
  const child = spawn(exe, [], {
    env: { ...process.env, ...appEnv(feedPath) },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child;
}
async function closeApp() {
  try {
    const version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await sleep(500);
    ws.close();
  } catch {
    // nothing listening
  }
  await waitFor("app to exit", async () => (await targets()) === null, 30_000).catch(
    () => undefined,
  );
  try {
    execFileSync("taskkill", ["/IM", "Orchestra.exe", "/T", "/F"], { stdio: "ignore" });
  } catch {
    // none left
  }
  await sleep(2000);
}

// ---------------------------------------------------------------- run
let exitCode = 0;
try {
  execFileSync(path.join(WORK, "installer-1.0.0.exe"), ["/S"], { stdio: "inherit" });
  const exe = await waitFor("installed Orchestra.exe", async () => findInstalledExe(), 60_000);
  const installedVersion = fileVersion(exe);
  record(
    "install 1.0.0 silently (/S)",
    installedVersion.startsWith("1.0.0"),
    `${exe} ProductVersion=${installedVersion}`,
  );

  // Negative: feed announcing 0.9.0.
  launch(exe, "/updates-old/");
  const page0 = await waitFor("Orchestra page (negative)", pageTarget, 120_000);
  await waitFor(
    "update check against the 0.9.0 feed",
    async () => /latest version: 0\.9\.0|announced version is not newer/.test(logText()),
    90_000,
  );
  await sleep(8000);
  const overlayNeg = await overlayTarget();
  const versionNeg = await evaluate(
    page0,
    "window.orchestraDesktop && window.orchestraDesktop.version",
  );
  await shot(page0, "01-negative-feed-0.9.0-page.png");
  desktopShot("01-negative-feed-0.9.0-desktop.png");
  record(
    "negative: feed 0.9.0 -> no overlay",
    overlayNeg === null,
    `overlay=${overlayNeg ? "PRESENT" : "none"}, app version ${versionNeg}`,
  );
  await closeApp();

  // Positive: feed announcing 1.0.1.
  setUserEnv(appEnv("/updates/"));
  launch(exe, "/updates/");
  const page1 = await waitFor("Orchestra page (positive)", pageTarget, 120_000);
  const overlay = await waitFor("update overlay", overlayTarget, 180_000);
  const phases = new Set();
  const ready = await waitFor(
    "overlay state 'Aggiornamento pronto'",
    async () => {
      const title = await evaluate(overlay, "document.getElementById('title').textContent");
      phases.add(title);
      if (title === "Aggiornamento non riuscito")
        throw new Error(await evaluate(overlay, "document.getElementById('error').textContent"));
      return title === "Aggiornamento pronto" ? title : null;
    },
    600_000,
    500,
  );
  const overlaySize = await evaluate(overlay, "JSON.stringify([innerWidth, innerHeight])");
  const pageSize = await evaluate(page1, "JSON.stringify([innerWidth, innerHeight])");
  const installVisible = await evaluate(
    overlay,
    "!document.getElementById('install').hidden && document.getElementById('install').textContent",
  );
  const retryVisible = await evaluate(overlay, "!document.getElementById('retry').hidden");
  await shot(overlay, "02-overlay-ready.png");
  desktopShot("02-overlay-ready-desktop.png");
  record(
    "overlay covers the window",
    overlaySize === pageSize,
    `overlay ${overlaySize} vs page ${pageSize}; titles seen: ${[...phases].join(" -> ")}`,
  );
  record(
    "state 'pronto' with one button",
    ready === "Aggiornamento pronto" && installVisible === "Installa e riavvia" && !retryVisible,
    `button=${installVisible}, retry visible=${retryVisible}`,
  );

  const logBefore = logText().length;
  await evaluate(overlay, "document.getElementById('install').click(), true");
  record("click 'Installa e riavvia'", true, "clicked");
  await waitFor("old app to go away", async () => (await pageTarget()) === null, 120_000, 500);
  // Relaunch by the installer: poll the version the app reports over CDP, and keep evidence
  // (processes, exe version, desktop) while waiting.
  let page2 = null;
  const relaunchDeadline = Date.now() + 300_000;
  let tick = 0;
  while (Date.now() < relaunchDeadline && !page2) {
    const target = await pageTarget();
    if (target) {
      const version = await evaluate(
        target,
        "window.orchestraDesktop && window.orchestraDesktop.version",
      ).catch(() => null);
      if (version === "1.0.1") page2 = target;
    }
    if (!page2 && tick % 30 === 0) {
      appendFileSync(
        path.join(OUT, "relaunch-watch.log"),
        `--- t+${tick}s exe=${fileVersion(exe)}\n${processes()}\n`,
      );
      if (tick % 60 === 0) desktopShot(`03-waiting-relaunch-t${tick}s-desktop.png`);
    }
    if (!page2) await sleep(1000);
    tick += 1;
  }
  const newFileVersion = fileVersion(exe);
  record(
    "silent install replaced the exe with 1.0.1",
    newFileVersion.startsWith("1.0.1"),
    `exe ProductVersion=${newFileVersion}`,
  );
  const logAfter = logText().slice(logBefore);
  const logSaysNew = /currentVersion: '1\.0\.1'/.test(logAfter);
  if (page2) {
    await sleep(5000);
    const pageVersion = await evaluate(page2, "window.orchestraDesktop.version");
    const overlayAfter = await overlayTarget();
    await shot(page2, "03-after-update-1.0.1-page.png");
    desktopShot("03-after-update-1.0.1-desktop.png");
    record(
      "installer relaunched the app on 1.0.1",
      pageVersion === "1.0.1" && overlayAfter === null,
      `orchestraDesktop.version=${pageVersion}, log feed line with 1.0.1=${logSaysNew}, overlay after relaunch=${overlayAfter ? "PRESENT" : "none"}`,
    );
  } else {
    desktopShot("03-no-relaunch-desktop.png");
    record(
      "installer relaunched the app on 1.0.1",
      false,
      `no app answering on CDP with 1.0.1 within 300 s; log feed line with 1.0.1=${logSaysNew}; processes: ${processes() || "none"}`,
    );
    if (newFileVersion.startsWith("1.0.1")) {
      await closeApp();
      launch(exe, "/updates/");
      const manual = await waitFor("installed app (launched by the test)", pageTarget, 120_000);
      const manualVersion = await evaluate(manual, "window.orchestraDesktop.version");
      await shot(manual, "04-installed-1.0.1-launched-by-test-page.png");
      desktopShot("04-installed-1.0.1-launched-by-test-desktop.png");
      record(
        "installed app, launched by the test, runs 1.0.1",
        manualVersion === "1.0.1",
        `orchestraDesktop.version=${manualVersion}`,
      );
    }
  }
  await closeApp();
} catch (error) {
  record("run", false, String(error?.stack ?? error));
} finally {
  for (const file of logFiles())
    copyFileSync(
      file,
      path.join(OUT, `${path.basename(path.dirname(path.dirname(file)))}-main.log`),
    );
  const daemonLog = path.join(paseoHome, "daemon.log");
  if (existsSync(daemonLog)) copyFileSync(daemonLog, path.join(OUT, "daemon.log"));
  writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const summary = [
    "| step | result | detail |",
    "|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.step} | ${r.ok ? "PASS" : "FAIL"} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 400)} |`,
    ),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Orchestra Windows updater e2e\n\n${summary}\n`,
    );
  exitCode = results.every((r) => r.ok) && results.length >= 5 ? 0 : 1;
  server.close();
}
process.exit(exitCode);

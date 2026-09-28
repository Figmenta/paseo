// Figmenta fork: end-to-end test of Orchestra Desktop's mandatory updater on a real Windows
// machine (GitHub Actions windows-latest), with the one-click installer.
//
//   node e2e.mjs
// env: E2E_WORK  dir with installer-published.exe (assisted, e.g. 1.0.1), installer-new.exe
//                (one-click, this commit), feed-a/ (announces NEW), feed-b/ (announces NEXT)
//      E2E_OUT   artifacts dir
//      E2E_PUBLISHED, E2E_NEW, E2E_NEXT  the three versions
//
// Case A, migration: published assisted install -> "Installa e riavvia" -> NEW one-click
//   installed in the same folder, ONE Uninstall entry, Orchestra NEW back on its own <= 60 s.
// Case B, steady state: NEW (one-click) -> NEXT, same checks. Main acceptance.
//
// The relaunch comes from the installer through the shell, which does NOT inherit this
// test's environment: it is detected from the process list (Orchestra.exe main process)
// and from main.log (the relaunched app logs its version), not through CDP.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORK = process.env.E2E_WORK;
const OUT = process.env.E2E_OUT;
const PUBLISHED = process.env.E2E_PUBLISHED;
const NEW = process.env.E2E_NEW;
const NEXT = process.env.E2E_NEXT;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18765;
const CDP = 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const RELAUNCH_BUDGET_MS = 60_000;
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
function ps(command) {
  return execFileSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  }).trim();
}

// ---------------------------------------------------------------- local feed + page
const serverLog = path.join(OUT, "server.log");
const routes = [
  ["/updates-a/", path.join(WORK, "feed-a")],
  ["/updates-b/", path.join(WORK, "feed-b")],
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
    if (url.pathname.startsWith(prefix)) {
      file = path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length)));
    }
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
  } catch (error) {
    console.log(
      `desktop screenshot ${name} not available: ${String(error.stderr ?? error.message).slice(0, 200)}`,
    );
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

// ---------------------------------------------------------------- machine state
const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
const expectedExe = path.join(localAppData, "Programs", "Orchestra", "Orchestra.exe");
function installedExes() {
  const root = path.join(localAppData, "Programs");
  const found = [];
  for (const dir of existsSync(root) ? readdirSync(root) : []) {
    const exe = path.join(root, dir, "Orchestra.exe");
    if (existsSync(exe)) found.push(exe);
  }
  return found;
}
function fileVersion(exe) {
  return ps(`(Get-Item -LiteralPath '${exe}').VersionInfo.ProductVersion`);
}
function uninstallEntries() {
  const out = ps(
    "$keys = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; " +
      "Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Orchestra' } | " +
      "ForEach-Object { '{0} | {1} | {2} | {3}' -f $_.PSPath.Split(':')[-1], $_.DisplayName, $_.DisplayVersion, $_.InstallLocation }",
  );
  return out ? out.split(/\r?\n/) : [];
}
function mainProcesses() {
  const out = ps(
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Orchestra.exe' } | " +
      "ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, [string]$_.CommandLine }",
  );
  // Main app process: no Chromium --type=, no script argument (the daemon and its workers
  // run Orchestra.exe as Node with a .js entry point).
  return (out ? out.split(/\r?\n/) : []).filter((line) => !/--type=|\.js\b/.test(line));
}
function allRelevantProcesses() {
  return ps(
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Orchestra|Setup' } | " +
      "ForEach-Object { $c = [string]$_.CommandLine; if ($c.Length -gt 220) { $c = $c.Substring(0,220) + '...' }; '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $c }",
  );
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

// ---------------------------------------------------------------- app lifecycle
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
function launch(exe, feedPath) {
  spawn(exe, [], {
    env: { ...process.env, ...appEnv(feedPath) },
    stdio: "ignore",
    detached: true,
  }).unref();
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
    // nothing on CDP
  }
  await waitFor("app to exit", async () => mainProcesses().length === 0, 30_000).catch(
    () => undefined,
  );
  try {
    execFileSync("taskkill", ["/IM", "Orchestra.exe", "/T", "/F"], { stdio: "ignore" });
  } catch {
    // none left
  }
  await sleep(3000);
}

/**
 * One update: installed `from` is launched against `feedPath` (announcing `to`), the
 * overlay reaches "pronto", the test clicks "Installa e riavvia", then watches for the
 * installer's own relaunch of `to` — process list + main.log, never helped by the test.
 */
async function updateCase(label, from, to, feedPath) {
  const exe = expectedExe;
  launch(exe, feedPath);
  const page = await waitFor(`${label}: Orchestra page`, pageTarget, 120_000);
  const fromVersion = await waitFor(
    `${label}: app version from the page`,
    async () => evaluate(page, "window.orchestraDesktop && window.orchestraDesktop.version"),
    30_000,
    500,
  ).catch(() => "unknown");
  const overlay = await waitFor(`${label}: update overlay`, overlayTarget, 180_000);
  await waitFor(
    `${label}: overlay 'Aggiornamento pronto'`,
    async () => {
      const title = await evaluate(overlay, "document.getElementById('title').textContent");
      if (title === "Aggiornamento non riuscito") {
        throw new Error(await evaluate(overlay, "document.getElementById('error').textContent"));
      }
      return title === "Aggiornamento pronto";
    },
    600_000,
    500,
  );
  await shot(overlay, `${label}-1-overlay-ready.png`);
  desktopShot(`${label}-1-overlay-ready-desktop.png`);
  record(
    `${label}: ${fromVersion} shows the blocking overlay for ${to}`,
    fromVersion === from,
    `app reported ${fromVersion}`,
  );

  const logBefore = logText().length;
  const oldPids = new Set(mainProcesses().map((line) => line.split(" ")[0]));
  const clickedAt = Date.now();
  await evaluate(overlay, "document.getElementById('install').click(), true");
  const watch = path.join(OUT, `${label}-process-watch.log`);
  const seen = new Set();
  let relaunchedAt = null;
  let relaunchLine = null;
  while (Date.now() - clickedAt < 180_000) {
    const now = Math.round((Date.now() - clickedAt) / 100) / 10;
    for (const line of allRelevantProcesses().split(/\r?\n/).filter(Boolean)) {
      const key = line.split(" ").slice(0, 3).join(" ");
      if (!seen.has(key)) {
        seen.add(key);
        appendFileSync(watch, `t+${now}s NEW ${line}\n`);
      }
    }
    const fresh = mainProcesses().filter((line) => !oldPids.has(line.split(" ")[0]));
    const loggedNew = logText().slice(logBefore).includes(`currentVersion: '${to}'`);
    if (fresh.length > 0 && loggedNew) {
      relaunchedAt = Date.now() - clickedAt;
      relaunchLine = fresh[0];
      break;
    }
    await sleep(500);
  }
  const exes = installedExes();
  const version = existsSync(exe) ? fileVersion(exe) : "missing";
  const entries = uninstallEntries();
  writeFileSync(path.join(OUT, `${label}-uninstall-entries.txt`), entries.join("\n"));
  desktopShot(`${label}-2-after-install-desktop.png`);
  record(
    `${label}: ${to} installed in the same folder`,
    version.startsWith(to) && exes.length === 1 && exes[0].toLowerCase() === exe.toLowerCase(),
    `exe ${exe} ProductVersion=${version}; Orchestra.exe found under Programs: ${exes.join(", ") || "none"}`,
  );
  record(
    `${label}: one entry in Installed apps (Uninstall)`,
    entries.length === 1 && entries[0].includes(to),
    entries.join(" || ") || "none",
  );
  record(
    `${label}: Orchestra ${to} back on its own within ${RELAUNCH_BUDGET_MS / 1000} s`,
    relaunchedAt !== null && relaunchedAt <= RELAUNCH_BUDGET_MS,
    relaunchedAt === null
      ? `no new Orchestra main process logging ${to} within 180 s; main processes now: ${mainProcesses().join(" || ") || "none"}`
      : `${relaunchedAt} ms after the click: ${relaunchLine.slice(0, 200)}`,
  );
  if (relaunchedAt !== null) {
    await sleep(5000);
    const running = mainProcesses();
    record(
      `${label}: exactly one Orchestra after the relaunch`,
      running.length === 1,
      `${running.length}: ${running.join(" || ").slice(0, 300)}`,
    );
    desktopShot(`${label}-3-relaunched-desktop.png`);
  }
  await closeApp();
}

// ---------------------------------------------------------------- run
let exitCode = 0;
try {
  // Case A: migration from the published assisted installer.
  execFileSync(path.join(WORK, "installer-published.exe"), ["/S"], { stdio: "inherit" });
  await waitFor("published install", async () => existsSync(expectedExe), 60_000);
  const before = uninstallEntries();
  writeFileSync(path.join(OUT, "A-uninstall-entries-before.txt"), before.join("\n"));
  record(
    `A: published ${PUBLISHED} (assisted) installed`,
    fileVersion(expectedExe).startsWith(PUBLISHED) && before.length === 1,
    `ProductVersion=${fileVersion(expectedExe)}; Uninstall: ${before.join(" || ")}`,
  );
  await updateCase("A-migration", PUBLISHED, NEW, "/updates-a/");

  // Case B: steady state, one-click NEW -> NEXT. If A left no NEW, install it fresh.
  if (!fileVersion(expectedExe).startsWith(NEW)) {
    execFileSync(path.join(WORK, "installer-new.exe"), ["/S"], { stdio: "inherit" });
    await sleep(5000);
    await closeApp();
    record(
      `B: ${NEW} installed by the test (A did not leave it)`,
      fileVersion(expectedExe).startsWith(NEW),
      fileVersion(expectedExe),
    );
  }
  await updateCase("B-steady", NEW, NEXT, "/updates-b/");
} catch (error) {
  record("run", false, String(error?.stack ?? error));
} finally {
  for (const file of logFiles()) copyFileSync(file, path.join(OUT, "Orchestra-main.log"));
  const daemonLog = path.join(paseoHome, "daemon.log");
  if (existsSync(daemonLog)) copyFileSync(daemonLog, path.join(OUT, "daemon.log"));
  try {
    writeFileSync(
      path.join(OUT, "application-events.txt"),
      ps(
        "Get-WinEvent -LogName Application -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'Orchestra' } | Format-List TimeCreated, ProviderName, Id, Message | Out-String -Width 300",
      ),
    );
  } catch {
    // no event log access
  }
  writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const summary = [
    "| step | result | detail |",
    "|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.step} | ${r.ok ? "PASS" : "FAIL"} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 400)} |`,
    ),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Orchestra Windows updater e2e\n\n${summary}\n`,
    );
  }
  exitCode = results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
  server.close();
}
process.exit(exitCode);

// Figmenta fork: a ~/.paseo/config.json that points figmenta-sessions at an OLD copy of the
// plugin (0.3.0, as Desktop 0.8.1 left it) must end with the daemon running the plugin
// this app ships. Three cases, each on an isolated HOME / PASEO_HOME / userData and a
// free port (never 6767), with no window and no dialog (the warning is recorded):
//   1. cold start: the seed repoints the entry, the daemon Orchestra launches loads it;
//   2. a daemon an earlier Orchestra launched with the old plugin: restarted, once;
//   3. a desktop-managed daemon Orchestra did not launch: warned about, never restarted;
//   4. (macOS) a daemon an Orchestra <= 1.3.15 left, with no launch marker: recognised from
//      its executable inside an `Orchestra*.app/Contents/` bundle, and restarted.
// Run with `npm run test:e2e:plugin-repoint` (builds dist first).
import { once } from "node:events";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";
import { savePersistedConfig } from "@getpaseo/server/configuration";
import {
  readDaemonInstance,
  startDaemonInstance,
  stopDaemonInstance,
} from "@getpaseo/server/daemon-control";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const bundledPlugin = path.join(repo, "packages/desktop/figmenta-plugin");
const bundledVersion = JSON.parse(
  await readFile(path.join(bundledPlugin, "package.json"), "utf8"),
).version;
const root = await mkdtemp(path.join(tmpdir(), "orchestra plugin repoint "));
const home = path.join(root, "paseo");
const oldPlugin = path.join(root, "Orchestra 0.8.1/plugins/figmenta-sessions");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("PASEO_") && key !== "ELECTRON_RUN_AS_NODE",
  ),
);
env.HOME = root;
env.USERPROFILE = root;
env.PASEO_HOME = home;
env.ORCHESTRA_E2E_KEEP_LOCATION = "1";

const server = net.createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
assert.ok(port !== 6767 && port !== 6768);

// The old copy: the same plugin labelled 0.3.0, with zod resolvable as in a packaged app.
await cp(bundledPlugin, oldPlugin, { recursive: true });
const oldPackage = JSON.parse(await readFile(path.join(oldPlugin, "package.json"), "utf8"));
await writeFile(
  path.join(oldPlugin, "package.json"),
  `${JSON.stringify({ ...oldPackage, version: "0.3.0" }, null, 2)}\n`,
);
await mkdir(path.join(oldPlugin, "node_modules"), { recursive: true });
await symlink(path.join(repo, "node_modules/zod"), path.join(oldPlugin, "node_modules/zod"));

function writeStaleConfig() {
  savePersistedConfig(home, {
    daemon: {
      listen: `127.0.0.1:${port}`,
      relay: { enabled: false },
      cors: { allowedOrigins: ["https://orchestra.figmenta.site"] },
    },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
    pluginsEnabled: true,
    plugins: { "figmenta-sessions": { source: "directory", path: oldPlugin, enabled: true } },
  });
}

const main = path.join(root, "main.cjs");
const dist = path.join(repo, "packages/desktop/dist");
await writeFile(
  main,
  `const { app } = require("electron");
app.setPath("userData", ${JSON.stringify(path.join(root, "user-data"))});
if (app.dock) app.dock.hide();
app.whenReady().then(() => {
  global.manager = require(${JSON.stringify(path.join(dist, "daemon/daemon-manager.js"))});
  global.seed = require(${JSON.stringify(path.join(dist, "figmenta/orchestra-daemon-seed.js"))});
  global.warnings = [];
});`,
);

let desktop = null;
async function openDesktop() {
  desktop = await electron.launch({ args: ["--no-sandbox", main], env });
  await expect
    .poll(() => desktop.evaluate(() => Boolean(global.seed)), { timeout: 10_000 })
    .toBe(true);
  await desktop.evaluate(() =>
    global.manager
      .createDaemonCommandHandlers()
      .patch_desktop_settings({ daemon: { keepRunningAfterQuit: true } }),
  );
}
async function closeDesktop() {
  if (!desktop) return;
  const exited = once(desktop.process(), "exit");
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await exited;
  desktop = null;
}
/** What main.ts does at boot: seed, start (or reuse), verify. Warnings are recorded. */
async function orchestraBoot() {
  return desktop.evaluate(async (_, pluginPath) => {
    await global.seed.seedOrchestraDaemonConfig({ pluginPath });
    const status = await global.manager.startDaemon();
    const check = await global.seed.verifyOrchestraDaemonSeed({
      listen: status.listen,
      pluginPath,
      warn: (warning) => global.warnings.push(warning),
    });
    return { check, warnings: global.warnings };
  }, bundledPlugin);
}
function pluginLs() {
  const out = execFileSync(
    process.execPath,
    [path.join(repo, "packages/cli/bin/paseo"), "plugin", "ls", "--json"],
    { env, encoding: "utf8" },
  );
  return JSON.parse(out);
}
function show(label, list) {
  const entry = list.find((item) => item.id === "figmenta-sessions");
  const version = JSON.parse(readFileSync(path.join(entry.path, "package.json"), "utf8")).version;
  console.log(`${label}: paseo plugin ls --json ->`, JSON.stringify(entry));
  console.log(`${label}: version at that path -> ${version}`);
  return { ...entry, version };
}
async function stopAny() {
  const instance = await readDaemonInstance(home);
  if (!instance) return;
  await stopDaemonInstance(home, {
    instance,
    timeoutMs: 15_000,
    requestShutdown: async (ready) => {
      execFileSync(
        process.execPath,
        [path.join(repo, "packages/cli/bin/paseo"), "daemon", "stop", "--host", ready.listen],
        { env },
      );
    },
  });
}
async function configuredPath() {
  const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
  return config.plugins["figmenta-sessions"].path;
}

try {
  console.log(`isolated root: ${root}`);
  console.log(`port: ${port}; bundled plugin ${bundledVersion} at ${bundledPlugin}`);

  // 1. Cold start (the reported case: after a reboot nothing is listening).
  writeStaleConfig();
  await openDesktop();
  const cold = await orchestraBoot();
  console.log("1. check:", JSON.stringify(cold.check));
  assert.equal(await configuredPath(), bundledPlugin);
  assert.equal(cold.check.action, "ok");
  assert.equal(cold.warnings.length, 0);
  assert.equal(show("1. after", pluginLs()).version, bundledVersion);
  await desktop.evaluate(() => global.manager.stopDesktopDaemon("quit"));
  await closeDesktop();
  console.log("PASS 1: cold start repoints the entry and the daemon loads the bundled plugin");

  // 2. A daemon an earlier Orchestra launched, still on the old plugin.
  writeStaleConfig();
  await openDesktop();
  await desktop.evaluate(() => global.manager.startDaemon());
  const leftover = await readDaemonInstance(home);
  assert.equal(show("2. before", pluginLs()).version, "0.3.0");
  await closeDesktop();
  process.kill(leftover.pid, 0);
  await openDesktop();
  const restarted = await orchestraBoot();
  console.log("2. check:", JSON.stringify(restarted.check));
  const fresh = await readDaemonInstance(home);
  assert.notEqual(fresh.pid, leftover.pid, "the leftover daemon was not restarted");
  assert.equal(restarted.check.action, "ok");
  assert.equal(restarted.check.restarted, true);
  assert.equal(restarted.warnings.length, 0);
  assert.equal(show("2. after", pluginLs()).version, bundledVersion);
  await desktop.evaluate(() => global.manager.stopDesktopDaemon("quit"));
  await closeDesktop();
  console.log("PASS 2: a leftover Orchestra daemon on plugin 0.3.0 is restarted, once, silently");

  // 3. A desktop-managed daemon Orchestra did not launch (a personal Paseo's): left alone.
  writeStaleConfig();
  await unlink(path.join(home, "orchestra-daemon.json")).catch(() => {});
  const foreign = await startDaemonInstance({
    home,
    command: process.execPath,
    args: [path.join(repo, "packages/server/dist/scripts/supervisor-entrypoint.js")],
    env,
    mode: "deployment",
    desktopManaged: true,
    timeoutMs: 30_000,
  });
  assert.equal(show("3. before", pluginLs()).version, "0.3.0");
  await openDesktop();
  const warned = await orchestraBoot();
  console.log("3. check:", JSON.stringify(warned.check));
  console.log("3. warnings:", JSON.stringify(warned.warnings));
  assert.equal((await readDaemonInstance(home)).pid, foreign.instance.pid);
  process.kill(foreign.instance.pid, 0);
  assert.equal(warned.check.owner, "foreign");
  assert.equal(warned.check.action, "warn");
  assert.deepEqual(
    warned.warnings.map((w) => w.kind),
    ["plugin-outdated"],
  );
  // The config is repointed all the same: the next start of that daemon loads the bundled one.
  assert.equal(await configuredPath(), bundledPlugin);
  await closeDesktop();
  console.log("PASS 3: a daemon Orchestra did not launch is warned about and never restarted");
  await stopAny();

  // 4. A daemon an Orchestra <= 1.3.15 launched: no marker, and the supervisor retitles
  // itself ("Paseo Supervisor"), so only its executable says it is Orchestra's. The old
  // Orchestra is a clone of the Electron app renamed into an `Orchestra*.app` bundle.
  if (process.platform === "darwin") {
    writeStaleConfig();
    await unlink(path.join(home, "orchestra-daemon.json")).catch(() => {});
    const electronBinary = createRequire(import.meta.url)("electron");
    const electronApp = electronBinary.slice(0, electronBinary.indexOf(".app/") + ".app".length);
    const oldApp = path.join(root, "Orchestra 1.3.15.app");
    execFileSync("cp", ["-cR", electronApp, oldApp]);
    const oldBinary = path.join(oldApp, electronBinary.slice(electronApp.length + 1));
    const old = await startDaemonInstance({
      home,
      command: oldBinary,
      args: [path.join(repo, "packages/server/dist/scripts/supervisor-entrypoint.js")],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      mode: "deployment",
      desktopManaged: true,
      timeoutMs: 30_000,
    });
    const title = execFileSync("ps", ["-o", "command=", "-p", String(old.instance.pid)], {
      encoding: "utf8",
    }).trim();
    console.log(`4. ps -o command= -> ${JSON.stringify(title)}`);
    assert.equal(show("4. before", pluginLs()).version, "0.3.0");
    await openDesktop();
    const legacy = await orchestraBoot();
    console.log("4. check:", JSON.stringify(legacy.check));
    assert.notEqual((await readDaemonInstance(home)).pid, old.instance.pid);
    assert.equal(legacy.check.action, "ok");
    assert.equal(legacy.check.restarted, true);
    assert.equal(legacy.warnings.length, 0);
    assert.equal(show("4. after", pluginLs()).version, bundledVersion);
    await desktop.evaluate(() => global.manager.stopDesktopDaemon("quit"));
    await closeDesktop();
    console.log(
      "PASS 4: a marker-less daemon from an Orchestra bundle is recognised and restarted",
    );
  } else {
    console.log("SKIP 4: the Orchestra-bundle executable case is macOS-only");
  }

  // The app log of the three boots: the repoint and the restart, as main.ts would log them.
  const logs = execFileSync("find", [root, "-name", "*.log", "-path", "*Logs*"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
    .split(/\n(?=\[\d{4}-)/)
    .filter((entry) => entry.includes("[orchestra]"));
  for (const entry of logs) console.log(`log: ${entry.replace(/\s+/g, " ")}`);
  assert.ok(logs.some((entry) => entry.includes("plugin entry moved to the bundled copy")));
  assert.ok(
    logs.some(
      (entry) =>
        entry.includes("older Orchestra plugin, restarting") &&
        entry.includes("owner: 'orchestra'") &&
        entry.includes("loadedVersion: '0.3.0'"),
    ),
  );
  if (process.platform === "darwin") {
    assert.ok(
      logs.some(
        (entry) =>
          entry.includes("older Orchestra plugin, restarting") &&
          entry.includes("owner: 'orchestra'") &&
          entry.includes("Orchestra 1.3.15.app/Contents/"),
      ),
      "case 4 was not classified from its executable",
    );
  }
} finally {
  await closeDesktop().catch(() => {});
  await stopAny().catch((error) => console.error("cleanup: could not stop the daemon", error));
  await rm(root, { recursive: true, force: true });
}

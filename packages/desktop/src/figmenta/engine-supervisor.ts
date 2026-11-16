// Orchestra Desktop 1.3.21 — engine supervisor (contract contratto-1321 §4.1, §4.3).
//
// One loop owns the engine on 127.0.0.1:<port>: before every launch it asks the port who
// is there and classifies the supervisor holding it (orchestra.ts classifyEngineHolder);
// it reuses our own engine or another Orchestra's, replaces an installed Paseo's, leaves
// anything else alone; it checks health every 10 s and restarts our own engine after
// three failures, with a 2/5/15/30/60 s backoff that never ends while the app lives.
// No dialog, no system notification: the state goes to the page (engine-status.ts).
//
// The process-level edges (clock, HTTP probes, pid lock, executable, stops) are `ops`,
// injectable so the tests run without network or processes.

import { readFileSync } from "node:fs";
import path from "node:path";
import { readDaemonInstance, resolvePaseoHome } from "@getpaseo/server/daemon-control";
import {
  forceStopOwnEngine,
  isProcessRunning,
  killProcessTreeWindows,
  listChildPids,
  ownedLaunchInstance,
  readOrchestraLaunchMarker,
  stopEngineViaBundledCli,
  stopForeignEngine,
  type ForeignStopOutcome,
} from "../daemon/daemon-manager.js";
import { processExecutable } from "./orchestra-daemon-seed.js";
import { classifyEngineHolder, type EngineHolderRule } from "./orchestra.js";
import type {
  CreateEngineSupervisor,
  EngineReason,
  EngineState1321,
  EngineStatus1321,
  EngineSupervisor,
  EngineSupervisorDeps,
} from "./engine-status.js";

export const DEFAULT_ENGINE_PORT = 6767;
export const HEALTH_INTERVAL_MS = 10_000;
export const HEALTH_FAILURES_FOR_FAULT = 3;
export const FAILED_ATTEMPTS_FOR_ERROR = 3;
export const ERROR_AFTER_MS = 120_000;
export const RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
export const FOREIGN_PORT_RELEASE_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;
const PORT_POLL_MS = 250;

/** What `GET /api/status` on the port says: nobody there (connection refused), or someone. */
export type PortProbe =
  | { kind: "free" }
  | { kind: "busy"; serverId: string | null; version: string | null };

/** The live pid lock (`~/.paseo/paseo.pid`) of the supervisor S, null when absent, dead,
 * or from an earlier boot (`isPidLockOwnerRunning`). */
export interface EngineLock {
  pid: number;
  startedAt: string;
  serverId: string | null;
}

interface Instance {
  pid: number;
  startedAt: string;
}

export interface EngineSupervisorOps {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** `daemon.listen` from the Paseo config, default 6767. */
  port(): number;
  probeStatus(port: number): Promise<PortProbe>;
  probeHealth(port: number): Promise<boolean>;
  readLock(): Promise<EngineLock | null>;
  readMarker(): { pid?: unknown; startedAt?: unknown } | null;
  /** The instance this process launched (rule 0), null when none. */
  ownedLaunch(): Instance | null;
  readExecutable(pid: number): string | null;
  /** `paseo daemon stop --force` on our engine (rules 0 and 2) only. */
  forceStopOwn(instance: Instance): Promise<boolean>;
  /** (a) and (b) of the foreign stop (daemon-manager stopForeignEngine). */
  stopForeign(pid: number): Promise<ForeignStopOutcome>;
}

// ---------------------------------------------------------------------------
// Real edges
// ---------------------------------------------------------------------------

function paseoHome(): string {
  return resolvePaseoHome(process.env);
}

/** The port of `daemon.listen` in `<PASEO_HOME>/config.json` (`host:port`), else 6767. */
export function readEnginePort(home: string = paseoHome()): number {
  try {
    const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf-8")) as {
      daemon?: { listen?: unknown };
    };
    const listen = config?.daemon?.listen;
    if (typeof listen === "string") {
      const match = /:(\d{1,5})$/.exec(listen.trim());
      const port = match ? Number(match[1]) : NaN;
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  } catch {
    // No config, or one that does not parse: the default port.
  }
  return DEFAULT_ENGINE_PORT;
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    const record = current as { code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof record.code === "string") codes.push(record.code);
    if (Array.isArray(record.errors)) codes.push(...record.errors.flatMap(errorCodes));
    current = record.cause;
  }
  return codes;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export async function probeEngineStatus(port: number): Promise<PortProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    let body: { serverId?: unknown; version?: unknown } | null = null;
    try {
      body = (await response.json()) as { serverId?: unknown; version?: unknown };
    } catch {
      body = null;
    }
    return {
      kind: "busy",
      serverId: stringOrNull(body?.serverId),
      version: stringOrNull(body?.version),
    };
  } catch (error) {
    // Only a refused connection is a free port; a timeout or a reset is someone there.
    return errorCodes(error).includes("ECONNREFUSED")
      ? { kind: "free" }
      : { kind: "busy", serverId: null, version: null };
  }
}

export async function probeEngineHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body?.status === "ok";
  } catch {
    return false;
  }
}

function defaultOps(): EngineSupervisorOps {
  const setTimer = (callback: () => void, ms: number): unknown => setTimeout(callback, ms);
  return {
    now: () => Date.now(),
    setTimer,
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    port: () => readEnginePort(),
    probeStatus: probeEngineStatus,
    probeHealth: probeEngineHealth,
    readLock: async () => {
      const lock = await readDaemonInstance(paseoHome());
      return lock
        ? { pid: lock.pid, startedAt: lock.startedAt, serverId: lock.serverId ?? null }
        : null;
    },
    readMarker: () => readOrchestraLaunchMarker(),
    ownedLaunch: () => ownedLaunchInstance(),
    readExecutable: (pid) => processExecutable(pid),
    forceStopOwn: (instance) => forceStopOwnEngine(instance),
    stopForeign: (pid) =>
      stopForeignEngine(pid, {
        platform: process.platform,
        cliStop: stopEngineViaBundledCli,
        isAlive: isProcessRunning,
        readExecutable: processExecutable,
        killTree: killProcessTreeWindows,
        signal: (target, signal) => {
          process.kill(target, signal);
        },
        childPids: listChildPids,
        sleep: (ms) => new Promise((resolve) => setTimer(() => resolve(undefined), ms)),
        log: () => {},
      }),
  };
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

type AttemptResult =
  | { ok: true; own: boolean; instance: Instance | null }
  | { ok: false; detail: EngineReason; immediateError: boolean }
  | { ok: "abandoned" };

function sameInstance(a: Instance | null, b: Instance | null): boolean {
  if (!a || !b) return a === b;
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

function isOwnRule(rule: EngineHolderRule): boolean {
  return rule === 0 || rule === 2;
}

export function createEngineSupervisorWith(
  deps: EngineSupervisorDeps,
  overrides: Partial<EngineSupervisorOps> = {},
): EngineSupervisor {
  const ops: EngineSupervisorOps = { ...defaultOps(), ...overrides };
  const iso = () => new Date(ops.now()).toISOString();
  const port = ops.port();

  let state: EngineState1321 = "starting";
  let detail: EngineReason | null = "starting";
  let since = iso();
  let version: string | null = null;
  let serverId: string | null = null;
  let foreignStoppedAt: string | null = null;

  let started = false;
  let stopped = false;
  let attemptInFlight = false;
  let timer: unknown = null;
  let errorDeadline: unknown = null;
  let failedAttempts = 0;
  let backoffStep = 0;
  let firstFailureAt: number | null = null;
  let healthFailures = 0;
  let monitored: { own: boolean; instance: Instance | null } | null = null;

  const listeners = new Set<(status: EngineStatus1321) => void>();
  let lastEmitted = "";

  function snapshot(): EngineStatus1321 {
    return {
      state,
      version,
      target: null,
      port,
      serverId,
      managed: true,
      detail,
      notesDir: null,
      since,
      foreignStoppedAt,
    };
  }

  function emit(): void {
    const status = snapshot();
    const key = JSON.stringify(status);
    if (key === lastEmitted) return;
    lastEmitted = key;
    for (const listener of listeners) {
      try {
        listener(status);
      } catch (error) {
        deps.log("engine supervisor: status listener failed", { error: String(error) });
      }
    }
  }

  function setState(next: EngineState1321, nextDetail: EngineReason | null): void {
    if (next !== state) {
      state = next;
      since = iso();
    }
    detail = nextDetail;
    emit();
  }

  function clearTimer(): void {
    if (timer !== null) ops.clearTimer(timer);
    timer = null;
  }

  function schedule(ms: number, step: () => Promise<void>): void {
    clearTimer();
    if (stopped) return;
    timer = ops.setTimer(() => {
      timer = null;
      void step();
    }, ms);
  }

  function clearErrorDeadline(): void {
    if (errorDeadline !== null) ops.clearTimer(errorDeadline);
    errorDeadline = null;
  }

  /** 120 s without `running` since the first fault: `error`, even mid-attempt. */
  function armErrorDeadline(): void {
    if (errorDeadline !== null || firstFailureAt === null || stopped) return;
    const left = Math.max(0, firstFailureAt + ERROR_AFTER_MS - ops.now());
    errorDeadline = ops.setTimer(() => {
      errorDeadline = null;
      if (stopped || state !== "starting") return;
      setState("error", detail === "starting" || detail === null ? "restart_failed" : detail);
    }, left);
  }

  function nextBackoff(): number {
    const ms = RESTART_BACKOFF_MS[Math.min(backoffStep, RESTART_BACKOFF_MS.length - 1)];
    backoffStep += 1;
    return ms;
  }

  function fail(reason: EngineReason, immediateError: boolean): void {
    failedAttempts += 1;
    if (firstFailureAt === null) firstFailureAt = ops.now();
    version = null;
    serverId = null;
    monitored = null;
    const toError =
      immediateError ||
      state === "error" ||
      failedAttempts >= FAILED_ATTEMPTS_FOR_ERROR ||
      ops.now() - firstFailureAt >= ERROR_AFTER_MS;
    setState(toError ? "error" : "starting", reason);
    if (!toError) armErrorDeadline();
    const delay = nextBackoff();
    deps.log("engine supervisor: attempt failed", {
      reason,
      failedAttempts,
      state,
      retryInMs: delay,
    });
    schedule(delay, attempt);
  }

  async function waitPortFree(ms: number): Promise<boolean> {
    const deadline = ops.now() + ms;
    for (;;) {
      if ((await ops.probeStatus(port)).kind === "free") return true;
      if (stopped || ops.now() >= deadline) return false;
      await new Promise((resolve) => ops.setTimer(() => resolve(undefined), PORT_POLL_MS));
    }
  }

  function classify(lock: EngineLock): { rule: EngineHolderRule; executable: string | null } {
    const base = { lock, ownedLaunch: ops.ownedLaunch(), marker: ops.readMarker() };
    const ownRule = classifyEngineHolder({ ...base, executable: null });
    if (isOwnRule(ownRule)) return { rule: ownRule, executable: null };
    const executable = ops.readExecutable(lock.pid);
    return { rule: classifyEngineHolder({ ...base, executable }), executable };
  }

  /** Is the live lock our own (rules 0 and 2) supervisor, alive with nothing on the port? */
  async function stuckOwnSupervisor(): Promise<EngineLock | null> {
    const lock = await ops.readLock();
    if (!lock) return null;
    const rule = classifyEngineHolder({
      lock,
      ownedLaunch: ops.ownedLaunch(),
      marker: ops.readMarker(),
      executable: null,
    });
    if (!isOwnRule(rule)) return null;
    return (await ops.probeStatus(port)).kind === "free" ? lock : null;
  }

  async function launchOwn(): Promise<AttemptResult> {
    try {
      await deps.startOwnEngine();
    } catch (error) {
      deps.log("engine supervisor: launch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (stopped) return { ok: "abandoned" };
    if (await ops.probeHealth(port)) {
      const lock = await ops.readLock();
      return { ok: true, own: true, instance: lock ?? ops.ownedLaunch() };
    }
    if (stopped) return { ok: "abandoned" };
    const stuck = await stuckOwnSupervisor();
    if (stuck) {
      deps.log("engine supervisor: our supervisor holds no port, force-stopping it", {
        pid: stuck.pid,
      });
      await ops.forceStopOwn(stuck);
      return { ok: false, detail: "stuck_supervisor", immediateError: false };
    }
    return { ok: false, detail: "restart_failed", immediateError: false };
  }

  async function replaceForeign(
    lock: EngineLock,
    executable: string | null,
  ): Promise<AttemptResult> {
    deps.log("engine supervisor: a Paseo engine holds the port, stopping it", {
      pid: lock.pid,
      executable,
    });
    const outcome = await ops.stopForeign(lock.pid);
    if (stopped) return { ok: "abandoned" };
    if (outcome !== "stopped" || !(await waitPortFree(FOREIGN_PORT_RELEASE_MS))) {
      deps.log("engine supervisor: the foreign engine was not stopped", { pid: lock.pid, outcome });
      return { ok: false, detail: "foreign_stop_failed", immediateError: true };
    }
    if (stopped) return { ok: "abandoned" };
    foreignStoppedAt = iso();
    detail = "foreign_replaced";
    emit();
    return launchOwn();
  }

  async function runAttempt(): Promise<AttemptResult> {
    const probe = await ops.probeStatus(port);
    if (stopped) return { ok: "abandoned" };
    if (probe.kind === "free") return launchOwn();

    const lock = await ops.readLock();
    if (!lock || !lock.serverId || lock.serverId !== probe.serverId) {
      deps.log("engine supervisor: the port is held by something without our pid lock", {
        lockPid: lock?.pid ?? null,
        lockServerId: lock?.serverId ?? null,
        portServerId: probe.serverId,
      });
      return { ok: false, detail: "port_busy_other", immediateError: true };
    }

    const { rule, executable } = classify(lock);
    deps.log("engine supervisor: engine on the port classified", {
      pid: lock.pid,
      rule,
      executable,
    });
    switch (rule) {
      case 0:
      case 2: {
        if (await ops.probeHealth(port)) return { ok: true, own: true, instance: lock };
        if (stopped) return { ok: "abandoned" };
        await ops.forceStopOwn(lock);
        if (stopped) return { ok: "abandoned" };
        return launchOwn();
      }
      case 3:
      case 4:
        if (await ops.probeHealth(port)) return { ok: true, own: false, instance: lock };
        return { ok: false, detail: "health_failed", immediateError: true };
      case 5:
        return replaceForeign(lock, executable);
      default:
        return { ok: false, detail: "port_busy_other", immediateError: true };
    }
  }

  async function enterRunning(own: boolean, instance: Instance | null): Promise<void> {
    const beforeSeed = ops.ownedLaunch();
    const seeded = await deps.verifySeed();
    if (stopped) return;
    if (!sameInstance(beforeSeed, ops.ownedLaunch())) {
      // The seed check restarted our engine (outdated plugin): one of our attempts.
      failedAttempts += 1;
      deps.log("engine supervisor: the seed check restarted the engine", { failedAttempts });
      instance = (await ops.readLock()) ?? ops.ownedLaunch();
    }
    if (!seeded) {
      if (own) {
        fail("seed_failed", true);
        return;
      }
      deps.log("engine supervisor: the reused Orchestra engine runs without our seed");
    }
    const probe = await ops.probeStatus(port);
    if (stopped) return;
    version = probe.kind === "busy" ? probe.version : null;
    serverId = probe.kind === "busy" ? probe.serverId : null;
    monitored = { own, instance };
    failedAttempts = 0;
    backoffStep = 0;
    firstFailureAt = null;
    healthFailures = 0;
    clearErrorDeadline();
    setState("running", null);
    schedule(HEALTH_INTERVAL_MS, healthTick);
  }

  async function attempt(): Promise<void> {
    if (stopped || attemptInFlight) return;
    attemptInFlight = true;
    clearTimer();
    try {
      let result: AttemptResult;
      try {
        result = await runAttempt();
      } catch (error) {
        deps.log("engine supervisor: attempt threw", {
          error: error instanceof Error ? error.message : String(error),
        });
        result = { ok: false, detail: "restart_failed", immediateError: false };
      }
      if (stopped || result.ok === "abandoned") return;
      if (result.ok) await enterRunning(result.own, result.instance);
      else fail(result.detail, result.immediateError);
    } finally {
      attemptInFlight = false;
    }
  }

  async function healthTick(): Promise<void> {
    if (stopped) return;
    const healthy = await ops.probeHealth(port);
    if (stopped) return;
    if (healthy) {
      healthFailures = 0;
      schedule(HEALTH_INTERVAL_MS, healthTick);
      return;
    }
    healthFailures += 1;
    if (healthFailures < HEALTH_FAILURES_FOR_FAULT) {
      schedule(HEALTH_INTERVAL_MS, healthTick);
      return;
    }
    // Fault: three failed checks in a row (30 s).
    healthFailures = 0;
    const faulted = monitored;
    monitored = null;
    deps.log("engine supervisor: the engine stopped answering", { own: faulted?.own ?? null });
    if (!faulted?.own) {
      // Another Orchestra's engine: never stopped; the next attempt classifies it again.
      await attempt();
      return;
    }
    firstFailureAt = ops.now();
    failedAttempts = 0;
    backoffStep = 0;
    version = null;
    serverId = null;
    let reason: EngineReason = "health_failed";
    const lock = await ops.readLock();
    if (stopped) return;
    if (lock && sameInstance(lock, faulted.instance)) {
      if ((await ops.probeStatus(port)).kind === "free") reason = "stuck_supervisor";
      await ops.forceStopOwn(lock);
    }
    if (stopped) return;
    setState("starting", reason);
    armErrorDeadline();
    await attempt();
  }

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      emit();
      await attempt();
    },
    stop() {
      stopped = true;
      clearTimer();
      clearErrorDeadline();
    },
    status: snapshot,
    onChange(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    async restartNow() {
      if (stopped || !started || state === "running") return false;
      backoffStep = 0;
      if (!attemptInFlight) void attempt();
      return true;
    },
  };
}

export const createEngineSupervisor: CreateEngineSupervisor = (deps) =>
  createEngineSupervisorWith(deps);

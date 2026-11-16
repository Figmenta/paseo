// Orchestra Desktop 1.3.21 — the seam between the engine supervisor (engine-supervisor.ts)
// and the shell (main.ts, preload.ts). Contract: DMS/OS/Orchestra/App desktop/contratto-1321.md §3, §4, §8.
// Written by the director before dispatch: shape and names are fixed; the body of
// createEngineSupervisor belongs to engine-supervisor.ts.

/** The states the 1.3.21 shell sends (a subset of the web's EngineState). */
export type EngineState1321 = "starting" | "running" | "error";

/** The only reason codes; `null` while running. */
export type EngineReason =
  | "starting"
  | "health_failed"
  | "restart_failed"
  | "stuck_supervisor"
  | "seed_failed"
  | "foreign_replaced"
  | "port_busy_other"
  | "foreign_stop_failed";

/** `window.orchestraDesktop.engine` and the `detail` of `orchestra-desktop:engine`. Every
 *  field always present; empty = null, never "". */
export interface EngineStatus1321 {
  state: EngineState1321;
  version: string | null;
  target: null;
  port: number;
  serverId: string | null;
  managed: true;
  detail: EngineReason | null;
  notesDir: null;
  /** ISO 8601 UTC of the last change of `state`. */
  since: string;
  /** ISO 8601 UTC of the last foreign engine this app stopped in this run, else null. */
  foreignStoppedAt: string | null;
}

export const ENGINE_STATUS_CHANNEL = "orchestra-desktop:engine";
export const ENGINE_STATUS_GET_CHANNEL = "orchestra-desktop:engine:get";
export const ENGINE_RESTART_CHANNEL = "orchestra-desktop:engine:restart";

export interface EngineSupervisor {
  /** Classify what holds the port, replace a foreign engine, start ours, begin health checks. */
  start(): Promise<void>;
  /** Stop the health timer (the engine itself is stopped by quit-lifecycle). */
  stop(): void;
  status(): EngineStatus1321;
  onChange(cb: (status: EngineStatus1321) => void): () => void;
  /** Reset the backoff and try now; true = an attempt started. */
  restartNow(): Promise<boolean>;
}

/** Filled by engine-supervisor.ts (cantiere A1); main.ts (A2) only imports this. */
export interface EngineSupervisorDeps {
  /** The existing launcher: daemon-manager's start of our engine with the prepared environment. */
  startOwnEngine(): Promise<void>;
  /** The existing seed check (orchestra-daemon-seed.ts verifyOrchestraDaemonSeed); false = failed. */
  verifySeed(): Promise<boolean>;
  log(message: string, extra?: Record<string, unknown>): void;
}

export type CreateEngineSupervisor = (deps: EngineSupervisorDeps) => EngineSupervisor;

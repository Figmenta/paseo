// Figmenta fork: which Paseo server Orchestra launches when NO daemon is listening.
//
// Orchestra bundles its own @getpaseo/server, and so does an installed Paseo Desktop.
// Whichever app starts first owns :6767 for the whole session, so an Orchestra that
// launches its own, older server shadows the newer one Paseo.app ships (2026-09-27:
// Orchestra 0.8.0 took :6767 with a daemon that did not know the newest models). When
// Orchestra has to START a daemon, it therefore starts the newest server available on the
// machine. Reusing a daemon that is already listening is untouched by this module.
//
// Pure: candidates are discovered by the Electron side (runtime-paths.ts) and handed in.

export type DaemonRuntimeSource = "bundled" | "paseo-app";

export interface DaemonRuntimeCandidate {
  source: DaemonRuntimeSource;
  /** Version of the @getpaseo/server package this runtime would run. */
  version: string;
}

import { compareVersions } from "./semver.js";

export { compareVersions };

/**
 * The runtime to launch: the newest server version wins; on a tie, or when a version
 * cannot be read as semver, Orchestra's own bundled server wins — it is the one this
 * build was tested with, and it is always present.
 */
export function pickDaemonRuntime<T extends DaemonRuntimeCandidate>(
  bundled: T,
  others: readonly T[],
): T {
  let best = bundled;
  for (const candidate of others) {
    if (compareVersions(candidate.version, best.version) === 1) {
      best = candidate;
    }
  }
  return best;
}

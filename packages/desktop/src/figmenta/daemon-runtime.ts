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

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(raw: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    raw.trim(),
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Semver precedence: -1 when a < b, 1 when a > b, 0 when equal. A release outranks its
 * own prereleases (0.9.3 > 0.9.3-beta.2). Returns null when either side is not semver.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  for (let index = 0; index < 3; index += 1) {
    const diff = left.core[index] - right.core[index];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const diff = comparePrereleaseIdentifier(leftId, rightId);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

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

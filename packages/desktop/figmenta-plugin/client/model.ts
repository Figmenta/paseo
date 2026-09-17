/**
 * Pure derivation layer: daemon payloads in, render-ready rows out.
 *
 * Kept free of React and of react-native so the grouping, ordering and
 * labelling rules can be read (and tested) without a renderer.
 */

/** Visual family of a session state. Maps to a theme token at render time. */
export type SessionTone = "running" | "attention" | "idle" | "danger" | "muted";

export interface AgentLike {
  readonly id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly cwd: string;
  readonly workspaceId?: string | undefined;
  readonly title: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUserMessageAt: string | null;
  readonly pendingPermissions: readonly unknown[];
  readonly requiresAttention?: boolean | undefined;
  readonly attentionReason?: "finished" | "error" | "permission" | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly providerUnavailable?: boolean | undefined;
}

export interface PlacementLike {
  readonly projectKey: string;
  readonly projectName: string;
  readonly workspaceName?: string | null | undefined;
}

export interface SessionRow {
  readonly agentId: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly tone: SessionTone;
  readonly providerLabel: string;
  readonly workspaceLabel: string;
  /** Epoch milliseconds of the most recent signal we have for this session. */
  readonly lastActivityAt: number;
}

export interface SessionGroup {
  readonly key: string;
  readonly title: string;
  /** Project name, shown only when it differs from the group title. */
  readonly subtitle: string | null;
  readonly rows: readonly SessionRow[];
  readonly lastActivityAt: number;
}

export type SessionListItem =
  | { readonly kind: "group"; readonly key: string; readonly group: SessionGroup }
  | { readonly kind: "session"; readonly key: string; readonly row: SessionRow };

/** One directory entry as the daemon returns it, plus the placement we last saw. */
export interface SessionEntry {
  readonly agent: AgentLike;
  readonly placement: PlacementLike | null;
}

const MAX_TITLE_CHARS = 72;

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Last time anything moved: a user turn, or any snapshot change. */
export function lastActivityOf(agent: AgentLike): number {
  return Math.max(toEpoch(agent.updatedAt), toEpoch(agent.lastUserMessageAt), toEpoch(agent.createdAt));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The agent's own title, else the first line of whatever named it, truncated. */
export function titleOf(agent: AgentLike): string {
  const explicit = agent.title ? collapseWhitespace(agent.title) : "";
  if (explicit.length > 0) {
    return explicit.length > MAX_TITLE_CHARS ? `${explicit.slice(0, MAX_TITLE_CHARS - 1)}…` : explicit;
  }
  const folder = agent.cwd.split("/").filter(Boolean).pop();
  return folder ? `Untitled session in ${folder}` : "Untitled session";
}

/**
 * `provider` arrives as `provider/model` on live sessions, while `model` is the
 * resolved model id. Show the runtime first, then the model, without repeating it.
 */
export function providerLabelOf(agent: AgentLike): string {
  const slash = agent.provider.indexOf("/");
  const runtime = slash === -1 ? agent.provider : agent.provider.slice(0, slash);
  const embedded = slash === -1 ? null : agent.provider.slice(slash + 1);
  const model = agent.model ?? embedded;
  if (!model || model === runtime) return runtime;
  return `${runtime} · ${model}`;
}

/**
 * A pending permission outranks the lifecycle status: the session is stopped
 * and waiting on a human, which `idle` alone would hide.
 */
export function stateOf(agent: AgentLike): { statusLabel: string; tone: SessionTone } {
  if (agent.pendingPermissions.length > 0) return { statusLabel: "waiting", tone: "attention" };
  switch (agent.status) {
    case "running":
      return { statusLabel: "running", tone: "running" };
    case "initializing":
      return { statusLabel: "starting", tone: "muted" };
    case "error":
      return { statusLabel: "error", tone: "danger" };
    case "closed":
      return { statusLabel: "closed", tone: "muted" };
    default:
      break;
  }
  if (agent.requiresAttention) {
    if (agent.attentionReason === "error") return { statusLabel: "failed", tone: "danger" };
    if (agent.attentionReason === "permission") return { statusLabel: "waiting", tone: "attention" };
    return { statusLabel: "finished", tone: "attention" };
  }
  if (agent.providerUnavailable) return { statusLabel: "provider offline", tone: "muted" };
  return { statusLabel: "idle", tone: "idle" };
}

function workspaceLabelOf(entry: SessionEntry): string {
  const placement = entry.placement;
  const name = placement?.workspaceName ?? placement?.projectName ?? null;
  if (name && name.trim().length > 0) return name.trim();
  const folder = entry.agent.cwd.split("/").filter(Boolean).pop();
  return folder ?? entry.agent.cwd;
}

function groupKeyOf(entry: SessionEntry): string {
  return entry.agent.workspaceId ?? entry.placement?.projectKey ?? entry.agent.cwd;
}

export function isArchived(agent: AgentLike): boolean {
  return Boolean(agent.archivedAt);
}

export function toRow(entry: SessionEntry): SessionRow {
  const { statusLabel, tone } = stateOf(entry.agent);
  return {
    agentId: entry.agent.id,
    title: titleOf(entry.agent),
    statusLabel,
    tone,
    providerLabel: providerLabelOf(entry.agent),
    workspaceLabel: workspaceLabelOf(entry),
    lastActivityAt: lastActivityOf(entry.agent),
  };
}

/**
 * Groups by workspace, then orders both the groups and the rows inside them by
 * last activity, newest first.
 *
 * Why grouped and not one flat activity feed: the sidebar this surface sits
 * next to is a workspace list, so the workspace is the coordinate Federico
 * already navigates by. Keeping it as the header preserves that map while
 * making the session — not the workspace — the thing you click. Activity order
 * inside and across groups keeps whatever is live at the top of the scroll.
 */
export function buildGroups(entries: readonly SessionEntry[]): SessionGroup[] {
  const buckets = new Map<string, { title: string; subtitle: string | null; rows: SessionRow[] }>();
  for (const entry of entries) {
    if (isArchived(entry.agent)) continue;
    const key = groupKeyOf(entry);
    const title = workspaceLabelOf(entry);
    const projectName = entry.placement?.projectName ?? null;
    const bucket = buckets.get(key) ?? {
      title,
      subtitle: projectName && projectName !== title ? projectName : null,
      rows: [],
    };
    bucket.rows.push(toRow(entry));
    buckets.set(key, bucket);
  }
  const groups: SessionGroup[] = [];
  for (const [key, bucket] of buckets) {
    const rows = [...bucket.rows].sort(
      (left, right) => right.lastActivityAt - left.lastActivityAt || left.title.localeCompare(right.title),
    );
    groups.push({
      key,
      title: bucket.title,
      subtitle: bucket.subtitle,
      rows,
      lastActivityAt: rows.length > 0 ? rows[0].lastActivityAt : 0,
    });
  }
  groups.sort(
    (left, right) => right.lastActivityAt - left.lastActivityAt || left.title.localeCompare(right.title),
  );
  return groups;
}

/** Flattens groups into one list so a single virtualized list can render both. */
export function toListItems(groups: readonly SessionGroup[]): SessionListItem[] {
  const items: SessionListItem[] = [];
  for (const group of groups) {
    items.push({ kind: "group", key: `group:${group.key}`, group });
    for (const row of group.rows) items.push({ kind: "session", key: `session:${row.agentId}`, row });
  }
  return items;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelative(timestamp: number, now: number): string {
  if (timestamp <= 0) return "—";
  const delta = Math.max(0, now - timestamp);
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

export interface SessionTotals {
  readonly sessions: number;
  /** Sessions with a live process: running, starting, or stopped on a prompt. */
  readonly live: number;
  readonly needAttention: number;
}

export function countSessions(groups: readonly SessionGroup[]): SessionTotals {
  let sessions = 0;
  let live = 0;
  let needAttention = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      sessions += 1;
      if (row.tone === "running") live += 1;
      if (row.tone === "attention") needAttention += 1;
    }
  }
  return { sessions, live, needAttention };
}

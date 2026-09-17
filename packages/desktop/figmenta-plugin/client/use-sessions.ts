import { usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildGroups,
  isArchived,
  lastActivityOf,
  type SessionEntry,
  type SessionGroup,
} from "./model";

/**
 * The SDK surface is reached through `usePaseo()`, so its types are derived
 * from that function rather than imported from `@getpaseo/client`, which is not
 * a module plugin client code is allowed to import.
 */
type PaseoApiLike = ReturnType<typeof usePaseo>;
type AgentsApi = PaseoApiLike["agents"];
type ListOptions = NonNullable<Parameters<AgentsApi["list"]>[0]>;
type ListResult = Awaited<ReturnType<AgentsApi["list"]>>;
type DirectoryEntry = ListResult["entries"][number];
type AgentUpdate = Parameters<Parameters<AgentsApi["subscribe"]>[0]>[0];

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const CLOCK_TICK_MS = 60_000;

const SORT: NonNullable<ListOptions["sort"]> = [{ key: "updated_at", direction: "desc" }];

function toEntry(entry: DirectoryEntry): SessionEntry {
  return { agent: entry.agent, placement: entry.project ?? null };
}

/** Walks the agent directory to the end, so every host workspace is represented. */
async function fetchAll(agents: AgentsApi): Promise<SessionEntry[]> {
  const collected: SessionEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await agents.list({
      filter: { includeArchived: false },
      sort: SORT,
      page: cursor ? { limit: PAGE_LIMIT, cursor } : { limit: PAGE_LIMIT },
    });
    for (const entry of result.entries) collected.push(toEntry(entry));
    const next = result.pageInfo.nextCursor;
    if (!result.pageInfo.hasMore || !next) break;
    cursor = next;
  }
  return collected;
}

export interface SessionsState {
  readonly groups: readonly SessionGroup[];
  readonly loading: boolean;
  readonly error: string | null;
  /** Ticks once a minute so the relative timestamps stay honest while idle. */
  readonly now: number;
  reload(): void;
}

export function useSessions(): SessionsState {
  const paseo = usePaseo();
  const [entries, setEntries] = useState<ReadonlyMap<string, SessionEntry>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);
  const liveIds = useRef(new Set<string>());
  const removedIds = useRef(new Set<string>());

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    liveIds.current = new Set();
    removedIds.current = new Set();
    setLoading(true);
    setError(null);

    const applyUpdate = (update: AgentUpdate) => {
      if (cancelled) return;
      if (update.kind === "remove") {
        removedIds.current.add(update.agentId);
        liveIds.current.delete(update.agentId);
        setEntries((current) => {
          if (!current.has(update.agentId)) return current;
          const next = new Map(current);
          next.delete(update.agentId);
          return next;
        });
        return;
      }
      removedIds.current.delete(update.agent.id);
      liveIds.current.add(update.agent.id);
      setEntries((current) => {
        const next = new Map(current);
        if (isArchived(update.agent)) {
          next.delete(update.agent.id);
          return next;
        }
        // An update without a placement is a state change, not a move: keep the
        // workspace we already knew rather than dropping the row's grouping.
        const placement = update.project ?? current.get(update.agent.id)?.placement ?? null;
        next.set(update.agent.id, { agent: update.agent, placement });
        return next;
      });
    };

    const unsubscribe = paseo.agents.subscribe(applyUpdate);

    fetchAll(paseo.agents)
      .then((loaded) => {
        if (cancelled) return undefined;
        setEntries((current) => {
          const next = new Map(current);
          for (const entry of loaded) {
            const id = entry.agent.id;
            if (removedIds.current.has(id)) continue;
            const existing = next.get(id);
            // A live update that landed mid-fetch is newer than the page we read.
            if (existing && liveIds.current.has(id) && lastActivityOf(existing.agent) >= lastActivityOf(entry.agent)) {
              continue;
            }
            next.set(id, entry);
          }
          const loadedIds = new Set(loaded.map((entry) => entry.agent.id));
          for (const id of [...next.keys()]) {
            if (!loadedIds.has(id) && !liveIds.current.has(id)) next.delete(id);
          }
          return next;
        });
        setLoading(false);
        return undefined;
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [paseo, reloadToken]);

  const groups = useMemo(() => buildGroups([...entries.values()]), [entries]);

  return { groups, loading, error, now, reload };
}

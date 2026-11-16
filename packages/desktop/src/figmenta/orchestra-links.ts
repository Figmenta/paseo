// Figmenta fork (contratto notes-site §10, contratto-1321 §4.6): the `orchestra:` deep links
// of Orchestra Desktop. Two forms:
// - `orchestra://notes/<slug>`: the routing page of notes.figmenta.site sends a shared note
//   there, and the app opens it at `/notes?slug=<slug>` on the Orchestra origin;
// - `orchestra://maestro` and `orchestra://maestro/<id>`: the app opens `/maestro` or
//   `/maestro/<id>` (never `/maestro/mail` nor `/maestro/confirm`, as the web refuses them).
// Every other `orchestra:` URL is ignored. Pure: main.ts does the logging and the navigation.

export const ORCHESTRA_LINK_SCHEME = "orchestra";

/** Note slug, the backend's rule (`app/notes/site_rules.py`, contract §5.1). */
const SLUG = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const SLUG_RE = new RegExp(`^${SLUG}$`);
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;
// Matched on the raw string, nothing decoded: host `notes` exactly, one path segment, and
// no userinfo, port, query or fragment — not even an empty `?` or `#`. The scheme is
// compared case-insensitively (RFC 3986 §3.1), the rest is exact.
const NOTE_LINK_RE = new RegExp(`^([A-Za-z][A-Za-z0-9+.-]*)://notes/(${SLUG})$`);
const NOTE_ROUTE_RE = new RegExp(`^/notes\\?slug=(${SLUG})$`);
/** A Maestro id: the web's path segment rule (`desktopLinks.ts` ORCHESTRA_LINK_RULES.segment). */
const MAESTRO_ID = "[A-Za-z0-9_-]{1,64}";
const MAESTRO_ID_RE = new RegExp(`^${MAESTRO_ID}$`);
// Same strictness as the note form: host `maestro` exactly, at most one path segment, no
// trailing slash, userinfo, port, query or fragment.
const MAESTRO_LINK_RE = new RegExp(`^([A-Za-z][A-Za-z0-9+.-]*)://maestro(?:/(${MAESTRO_ID}))?$`);
const MAESTRO_ROUTE_RE = new RegExp(`^/maestro(?:/(${MAESTRO_ID}))?$`);
/** The web's `forbiddenSeg2.maestro`: pages a link must never open. */
const FORBIDDEN_MAESTRO_IDS: ReadonlySet<string> = new Set(["mail", "confirm"]);

export type OrchestraLink = { kind: "note"; slug: string } | { kind: "maestro"; id: string | null };

export function isNoteSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function schemeOf(value: string): string | null {
  return SCHEME_RE.exec(value)?.[1]?.toLowerCase() ?? null;
}

/** Is this an `orchestra:` URL, valid or not? */
export function isOrchestraLink(value: string): boolean {
  return schemeOf(value) === ORCHESTRA_LINK_SCHEME;
}

/** A Maestro id a link may open: the segment rule, minus the pages the web refuses. */
export function isMaestroId(id: string): boolean {
  return MAESTRO_ID_RE.test(id) && !FORBIDDEN_MAESTRO_IDS.has(id);
}

export function parseOrchestraLink(url: string): OrchestraLink | null {
  const note = NOTE_LINK_RE.exec(url);
  if (note) {
    if (note[1]!.toLowerCase() !== ORCHESTRA_LINK_SCHEME) return null;
    return { kind: "note", slug: note[2]! };
  }
  const maestro = MAESTRO_LINK_RE.exec(url);
  if (!maestro || maestro[1]!.toLowerCase() !== ORCHESTRA_LINK_SCHEME) return null;
  const id = maestro[2] ?? null;
  if (id !== null && FORBIDDEN_MAESTRO_IDS.has(id)) return null;
  return { kind: "maestro", id };
}

/** The first argv entry that is a valid link (Windows and Linux pass the URL in argv). */
export function parseOrchestraLinkFromArgv(argv: string[]): OrchestraLink | null {
  for (const arg of argv) {
    const link = parseOrchestraLink(arg);
    if (link) return link;
  }
  return null;
}

/** The first argv entry that is an `orchestra:` URL, valid or not. */
export function findOrchestraLinkArg(argv: string[]): string | null {
  return argv.find(isOrchestraLink) ?? null;
}

/**
 * What the log says about a link it ignores: its scheme and host, never the whole URL
 * (contract §10). `URL.host` leaves out any userinfo.
 */
export function ignoredLinkFields(url: string): { scheme: string | null; host: string | null } {
  let host: string | null = null;
  try {
    host = new URL(url).host || null;
  } catch {
    host = null;
  }
  return { scheme: schemeOf(url), host };
}

/** The Orchestra route of a note. Throws on a slug that is not valid: it never builds another route. */
export function notePath(slug: string): string {
  if (!isNoteSlug(slug)) throw new Error("notePath: invalid note slug");
  return `/notes?slug=${slug}`;
}

/** The slug of a route built by `notePath`, or null for any other route. */
export function noteRouteSlug(route: string | null | undefined): string | null {
  if (typeof route !== "string") return null;
  return NOTE_ROUTE_RE.exec(route)?.[1] ?? null;
}

/** The Orchestra route of Maestro. Throws on an id a link may not open: it never builds another route. */
export function maestroPath(id: string | null): string {
  if (id === null) return "/maestro";
  if (!isMaestroId(id)) throw new Error("maestroPath: invalid Maestro id");
  return `/maestro/${id}`;
}

/** The Orchestra route a valid link opens. */
export function orchestraLinkPath(link: OrchestraLink): string {
  return link.kind === "note" ? notePath(link.slug) : maestroPath(link.id);
}

/** The link behind a route built by `orchestraLinkPath`, or null for any other route. */
export function orchestraLinkFromRoute(route: string | null | undefined): OrchestraLink | null {
  const slug = noteRouteSlug(route);
  if (slug !== null) return { kind: "note", slug };
  if (typeof route !== "string") return null;
  const match = MAESTRO_ROUTE_RE.exec(route);
  if (!match) return null;
  const id = match[1] ?? null;
  if (id !== null && FORBIDDEN_MAESTRO_IDS.has(id)) return null;
  return { kind: "maestro", id };
}

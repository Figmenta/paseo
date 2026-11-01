// Figmenta fork (contratto notes-site §10): the `orchestra:` deep links of Orchestra
// Desktop. The one form is `orchestra://notes/<slug>`: the routing page of
// notes.figmenta.site sends a shared note there, and the app opens it at
// `/notes?slug=<slug>` on the Orchestra origin. Every other `orchestra:` URL is ignored.
// Pure: main.ts does the logging and the navigation.

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

export interface OrchestraLink {
  kind: "note";
  slug: string;
}

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

export function parseOrchestraLink(url: string): OrchestraLink | null {
  const match = NOTE_LINK_RE.exec(url);
  if (!match || match[1]!.toLowerCase() !== ORCHESTRA_LINK_SCHEME) return null;
  return { kind: "note", slug: match[2]! };
}

/** The first argv entry that is a valid note link (Windows and Linux pass the URL in argv). */
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

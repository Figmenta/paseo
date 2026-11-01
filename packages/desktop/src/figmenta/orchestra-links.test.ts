import { describe, expect, it } from "vitest";

import {
  findOrchestraLinkArg,
  ignoredLinkFields,
  isNoteSlug,
  isOrchestraLink,
  notePath,
  noteRouteSlug,
  parseOrchestraLink,
  parseOrchestraLinkFromArgv,
} from "./orchestra-links.js";
import {
  DEFAULT_ORCHESTRA_URL,
  isOrchestraOrigin,
  orchestraNoteUrl,
  orchestraWindowUrl,
} from "./orchestra.js";

const SLUG_64 = `a${"b".repeat(62)}c`;

describe("parseOrchestraLink", () => {
  it.each([
    ["orchestra://notes/cn-dashboard", "cn-dashboard"],
    ["orchestra://notes/a", "a"],
    ["orchestra://notes/7", "7"],
    ["orchestra://notes/n-0123456789ab", "n-0123456789ab"],
    ["orchestra://notes/a--b", "a--b"],
    [`orchestra://notes/${SLUG_64}`, SLUG_64],
    // The scheme is case-insensitive (RFC 3986 §3.1); host and slug are not.
    ["ORCHESTRA://notes/cn-dashboard", "cn-dashboard"],
  ])("accepts %s", (url, slug) => {
    expect(parseOrchestraLink(url)).toEqual({ kind: "note", slug });
  });

  it.each([
    ["uppercase in the slug", "orchestra://notes/CN-dashboard"],
    ["underscore", "orchestra://notes/cn_dashboard"],
    ["dot-dot segment", "orchestra://notes/.."],
    ["dots in the slug", "orchestra://notes/a..b"],
    ["extra path segment", "orchestra://notes/cn/extra"],
    ["trailing slash", "orchestra://notes/cn/"],
    ["double slash before the slug", "orchestra://notes//cn"],
    ["query", "orchestra://notes/cn?x=1"],
    ["empty query", "orchestra://notes/cn?"],
    ["hash", "orchestra://notes/cn#top"],
    ["empty hash", "orchestra://notes/cn#"],
    ["userinfo", "orchestra://user@notes/cn"],
    ["userinfo with password", "orchestra://user:pw@notes/cn"],
    ["port", "orchestra://notes:8080/cn"],
    ["other host", "orchestra://note/cn"],
    ["uppercase host", "orchestra://NOTES/cn"],
    ["no slug", "orchestra://notes/"],
    ["no path", "orchestra://notes"],
    ["no authority", "orchestra:notes/cn"],
    ["empty authority", "orchestra:///notes/cn"],
    ["leading hyphen", "orchestra://notes/-cn"],
    ["trailing hyphen", "orchestra://notes/cn-"],
    ["slug of 65 characters", `orchestra://notes/${SLUG_64}d`],
    ["percent-encoded slug", "orchestra://notes/c%6E"],
    ["encoded traversal", "orchestra://notes/cn%2F..%2Fx"],
    ["leading space", " orchestra://notes/cn"],
    ["trailing newline", "orchestra://notes/cn\n"],
    ["https scheme", "https://notes/cn"],
    ["paseo scheme", "paseo://notes/cn"],
    ["paseo agent link", "paseo://h/server-1/agent/agent-1"],
    ["notes host URL", "https://notes.figmenta.site/cn.html"],
    ["lookalike scheme", "orchestrax://notes/cn"],
    ["empty string", ""],
  ])("rejects %s", (_label, url) => {
    expect(parseOrchestraLink(url)).toBeNull();
  });
});

describe("isOrchestraLink", () => {
  it("is true for any orchestra: URL, valid or not", () => {
    expect(isOrchestraLink("orchestra://notes/cn")).toBe(true);
    expect(isOrchestraLink("orchestra://notes/CN?x=1")).toBe(true);
    expect(isOrchestraLink("Orchestra:whatever")).toBe(true);
  });

  it("is false for other schemes and non-URLs", () => {
    expect(isOrchestraLink("paseo://h/s/agent/a")).toBe(false);
    expect(isOrchestraLink("orchestrax://notes/cn")).toBe(false);
    expect(isOrchestraLink("--orchestra://notes/cn")).toBe(false);
    expect(isOrchestraLink("C:\\Users\\me\\project")).toBe(false);
    expect(isOrchestraLink("")).toBe(false);
  });
});

describe("parseOrchestraLinkFromArgv", () => {
  it("finds the link a Windows protocol launch passes", () => {
    expect(
      parseOrchestraLinkFromArgv([
        "C:\\Users\\me\\AppData\\Local\\Programs\\Orchestra\\Orchestra.exe",
        "orchestra://notes/cn-dashboard",
      ]),
    ).toEqual({ kind: "note", slug: "cn-dashboard" });
  });

  it("skips switches and anything that is not a valid note link", () => {
    expect(
      parseOrchestraLinkFromArgv([
        "/opt/Orchestra/orchestra",
        "--no-sandbox",
        "orchestra://notes/BAD",
        "paseo://h/s/agent/a",
        "orchestra://notes/good-one",
      ]),
    ).toEqual({ kind: "note", slug: "good-one" });
  });

  it("is null without a note link", () => {
    expect(parseOrchestraLinkFromArgv(["Orchestra.exe"])).toBeNull();
    expect(parseOrchestraLinkFromArgv(["Orchestra.exe", "--updated"])).toBeNull();
    expect(parseOrchestraLinkFromArgv(["Orchestra.exe", "orchestra://notes/a_b"])).toBeNull();
    expect(parseOrchestraLinkFromArgv([])).toBeNull();
  });
});

describe("findOrchestraLinkArg", () => {
  it("returns the first orchestra: argument even when it is not a valid note link", () => {
    expect(findOrchestraLinkArg(["Orchestra.exe", "orchestra://notes/a_b"])).toBe(
      "orchestra://notes/a_b",
    );
  });

  it("is null without one", () => {
    expect(findOrchestraLinkArg(["Orchestra.exe", "paseo://h/s/agent/a", "--updated"])).toBeNull();
  });
});

describe("ignoredLinkFields", () => {
  it("keeps the scheme and host only: no userinfo, path, query or fragment", () => {
    const fields = ignoredLinkFields("orchestra://user:secret@elsewhere/x/y?token=abc#frag");
    expect(fields).toEqual({ scheme: "orchestra", host: "elsewhere" });
    expect(JSON.stringify(fields)).not.toMatch(/secret|token|abc|frag|\/x/);
  });

  it("is null where there is nothing to read", () => {
    expect(ignoredLinkFields("orchestra:opaque")).toEqual({ scheme: "orchestra", host: null });
    expect(ignoredLinkFields("not a url")).toEqual({ scheme: null, host: null });
  });
});

describe("notePath and noteRouteSlug", () => {
  it("builds the Orchestra route of a note and reads it back", () => {
    expect(notePath("cn-dashboard")).toBe("/notes?slug=cn-dashboard");
    expect(noteRouteSlug(notePath("cn-dashboard"))).toBe("cn-dashboard");
  });

  it.each(["", "CN", "a_b", "a&next=https://evil.test", "../x", "a/b", `${SLUG_64}d`])(
    "never builds a route from the invalid slug %j",
    (slug) => {
      expect(isNoteSlug(slug)).toBe(false);
      expect(() => notePath(slug)).toThrow("invalid note slug");
    },
  );

  it.each([
    null,
    undefined,
    "",
    "/h/server-1/agent/agent-1",
    "/notes?slug=cn&next=/x",
    "/notes?slug=CN",
    "/notes?slug=",
    "/notes/?slug=cn",
    "https://orchestra.figmenta.site/notes?slug=cn",
  ])("reads no note from the route %j", (route) => {
    expect(noteRouteSlug(route)).toBeNull();
  });
});

describe("orchestraNoteUrl", () => {
  it("puts the note route on the Orchestra origin", () => {
    expect(orchestraNoteUrl("cn-dashboard", DEFAULT_ORCHESTRA_URL)).toBe(
      "https://orchestra.figmenta.site/notes?slug=cn-dashboard",
    );
  });

  it("never doubles the slash and never keeps a path of the configured URL", () => {
    expect(orchestraNoteUrl("x", "https://orchestra.example.test/")).toBe(
      "https://orchestra.example.test/notes?slug=x",
    );
    const nested = orchestraNoteUrl("x", "https://orchestra.example.test:8443/base/");
    expect(nested).toBe("https://orchestra.example.test:8443/notes?slug=x");
    expect(isOrchestraOrigin(nested, "https://orchestra.example.test:8443/base/")).toBe(true);
  });

  it("refuses an invalid slug", () => {
    expect(() => orchestraNoteUrl("a/../../evil", DEFAULT_ORCHESTRA_URL)).toThrow();
  });
});

describe("orchestraWindowUrl", () => {
  const home = "https://orchestra.example.test";

  it("opens the note of a note route", () => {
    expect(orchestraWindowUrl(notePath("cn-dashboard"), home)).toBe(
      "https://orchestra.example.test/notes?slug=cn-dashboard",
    );
  });

  it("opens the Orchestra home for no route and for any other route, as before", () => {
    expect(orchestraWindowUrl(null, home)).toBe(home);
    expect(orchestraWindowUrl(undefined, home)).toBe(home);
    expect(orchestraWindowUrl("/h/server-1/agent/agent-1", home)).toBe(home);
    expect(orchestraWindowUrl("/notes?slug=cn&next=https://evil.test", home)).toBe(home);
    expect(orchestraWindowUrl("https://evil.test/notes?slug=cn", home)).toBe(home);
  });
});

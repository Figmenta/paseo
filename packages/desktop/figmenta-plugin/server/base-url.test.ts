import { describe, expect, it } from "vitest";
import { assertAllowedBaseUrl, normalizeAllowedBaseUrl, UntrustedBaseUrlError } from "./base-url";

describe("normalizeAllowedBaseUrl", () => {
  it.each([
    ["https://orchestra.figmenta.site", "https://orchestra.figmenta.site"],
    ["https://orchestra.figmenta.site/", "https://orchestra.figmenta.site"],
    ["https://ORCHESTRA.figmenta.site/", "https://orchestra.figmenta.site"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:6344", "http://127.0.0.1:6344"],
    [" http://localhost:3000 ", "http://localhost:3000"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeAllowedBaseUrl(input)).toBe(expected);
  });

  it.each([
    "http://orchestra.figmenta.site", // production must be TLS
    "https://orchestra.figmenta.site.evil.tld",
    "https://evil.tld",
    "https://orchestra.figmenta.site@evil.tld",
    "https://user:pass@orchestra.figmenta.site",
    "https://orchestra.figmenta.site/../evil",
    "https://orchestra.figmenta.site?next=evil",
    "http://10.0.0.5:3000",
    "http://127.0.0.1.evil.tld:3000",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("refuses %s", (input) => {
    expect(normalizeAllowedBaseUrl(input)).toBeNull();
  });
});

describe("assertAllowedBaseUrl", () => {
  it("returns the normalized URL", () => {
    expect(assertAllowedBaseUrl("https://orchestra.figmenta.site/")).toBe(
      "https://orchestra.figmenta.site",
    );
  });
  it("throws on anything else", () => {
    expect(() => assertAllowedBaseUrl("https://evil.tld")).toThrow(UntrustedBaseUrlError);
  });
});

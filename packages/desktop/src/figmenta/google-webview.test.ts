import { describe, expect, it } from "vitest";

import {
  guestPermissionPolicy,
  isGoogleDocsWebviewSrc,
  isGoogleWebviewNavigation,
  systemBrowserTarget,
} from "./google-webview.js";

describe("guestPermissionPolicy", () => {
  it.each(["fullscreen", "clipboard-sanitized-write"])("grants %s", (permission) => {
    expect(guestPermissionPolicy(permission)).toBe(true);
  });

  it.each([
    "media",
    "geolocation",
    "notifications",
    "clipboard-read",
    "midi",
    "midiSysex",
    "pointerLock",
    "keyboardLock",
    "openExternal",
    "display-capture",
    "hid",
    "serial",
    "usb",
    "storage-access",
    "top-level-storage-access",
    "unknown",
  ])("refuses %s", (permission) => {
    expect(guestPermissionPolicy(permission)).toBe(false);
  });
});

describe("isGoogleDocsWebviewSrc", () => {
  it.each([
    "https://docs.google.com/document/d/abc/edit",
    "https://docs.google.com/presentation/d/abc/edit",
    "https://DOCS.google.com/document/d/abc/edit",
  ])("admits %s", (src) => {
    expect(isGoogleDocsWebviewSrc(src)).toBe(true);
  });

  it.each([
    ["no src", undefined],
    ["an empty src", ""],
    ["about:blank", "about:blank"],
    ["plain http", "http://docs.google.com/document/d/abc/edit"],
    ["another Google host", "https://drive.google.com/file/d/abc/view"],
    ["the sign-in host", "https://accounts.google.com/"],
    ["a non-Google site", "https://evil.example/document/d/abc/edit"],
    ["a look-alike host", "https://docs.google.com.evil.example/document/d/abc/edit"],
    ["a non-default port", "https://docs.google.com:8443/document/d/abc/edit"],
    ["a DMS page", "https://dms.figmenta.site/drive/v2/nodes/abc"],
    ["a javascript: URL", "javascript:alert(1)"],
  ])("refuses %s", (_label, src) => {
    expect(isGoogleDocsWebviewSrc(src)).toBe(false);
  });
});

describe("isGoogleWebviewNavigation", () => {
  it.each([
    "https://docs.google.com/document/d/abc/edit",
    "https://accounts.google.com/v3/signin/identifier?continue=x",
  ])("keeps the top frame on %s", (url) => {
    expect(isGoogleWebviewNavigation(url)).toBe(true);
  });

  it.each([
    "http://accounts.google.com/",
    "https://www.google.com/url?q=https://evil.example",
    "https://evil.example/",
    "https://accounts.google.com.evil.example/",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isGoogleWebviewNavigation(url)).toBe(false);
  });
});

describe("systemBrowserTarget", () => {
  it.each(["https://example.com/a", "http://example.com/a"])("hands %s over", (url) => {
    expect(systemBrowserTarget(url)).toBe(url);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "about:blank", "mailto:a@b.c", "x"])(
    "keeps %s",
    (url) => {
      expect(systemBrowserTarget(url)).toBeNull();
    },
  );
});

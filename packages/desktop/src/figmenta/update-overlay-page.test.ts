import { describe, expect, it } from "vitest";
import { UPDATE_OVERLAY_PAGE_HTML, updateOverlayPageUrl } from "./update-overlay-page";

// Federico, 2026-09-28: the fork's own UI copy is English. The update screen is the one
// every user sees on every release, so its copy is pinned here.
describe("update overlay page", () => {
  it("is an English page", () => {
    expect(UPDATE_OVERLAY_PAGE_HTML).toContain('<html lang="en">');
    expect(UPDATE_OVERLAY_PAGE_HTML).toContain("<title>Updating Orchestra</title>");
  });

  it("carries the English labels for every phase", () => {
    for (const text of [
      ">Install and restart</button>",
      ">Retry</button>",
      '"Updating Orchestra"',
      '"Update ready"',
      '"Update failed"',
      '"Installing update"',
      "Check your connection and try again.",
      "Orchestra is not in the Applications folder",
    ]) {
      expect(UPDATE_OVERLAY_PAGE_HTML).toContain(text);
    }
  });

  it("has no Italian copy left", () => {
    for (const word of [
      "Aggiornamento",
      "Installa",
      "Riprova",
      "riavvia",
      "scaricare",
      "Applicazioni",
      "versione",
    ]) {
      expect(UPDATE_OVERLAY_PAGE_HTML).not.toContain(word);
    }
  });

  it("is served as a self-contained data: URL", () => {
    const url = updateOverlayPageUrl();
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length))).toBe(
      UPDATE_OVERLAY_PAGE_HTML,
    );
  });
});

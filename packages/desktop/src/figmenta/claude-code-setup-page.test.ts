import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_SETUP_PAGE_HTML, claudeCodeSetupPageUrl } from "./claude-code-setup-page";

// The first screen a new Windows user sees (T-3083, zero setup): English copy, pinned here.
describe("Claude Code setup page", () => {
  it("is an English page that loads nothing from anywhere", () => {
    expect(CLAUDE_CODE_SETUP_PAGE_HTML).toContain('<html lang="en">');
    expect(CLAUDE_CODE_SETUP_PAGE_HTML).toContain("default-src 'none'");
  });

  it("carries the English copy for every phase and component", () => {
    for (const text of [
      "Setting up Claude Code…",
      "Orchestra runs your agents with Claude Code.",
      "Unpacking Git Bash, which Claude Code uses on Windows.",
      '"Claude Code is not set up"',
      '"Git Bash is not set up"',
      "Starting Orchestra…",
      "Restarting the engine…",
      ">Try again</button>",
    ]) {
      expect(CLAUDE_CODE_SETUP_PAGE_HTML).toContain(text);
    }
  });

  it("a failure says Orchestra opens anyway and where Try again lives once the window is closed", () => {
    expect(CLAUDE_CODE_SETUP_PAGE_HTML).toContain(
      "Orchestra opens without it: Maestro cannot start sessions until Claude Code is set up. Close this window to go on, and try again later from the File menu.",
    );
    expect(CLAUDE_CODE_SETUP_PAGE_HTML).not.toMatch(/quit/i);
  });

  it("shows the end of the installer's output, where it says why it stopped", () => {
    expect(CLAUDE_CODE_SETUP_PAGE_HTML).toContain("error.scrollTop = error.scrollHeight;");
  });

  it("has no Italian copy", () => {
    for (const word of ["Installazione", "Riprova", "Avvio", "installando", "Chiudi"]) {
      expect(CLAUDE_CODE_SETUP_PAGE_HTML).not.toContain(word);
    }
  });

  it("is served as a self-contained data: URL", () => {
    const url = claudeCodeSetupPageUrl();
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length))).toBe(
      CLAUDE_CODE_SETUP_PAGE_HTML,
    );
  });
});

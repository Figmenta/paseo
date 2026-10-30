import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ORCHESTRA_URL } from "./orchestra.js";
import {
  createRevealHandler,
  isOrchestraTopFrame,
  nodeRevealFs,
  parseRevealInput,
  registerReveal,
  resolveVaultPath,
  REVEAL_CHANNEL,
  type RevealDeps,
  type RevealEvent,
  type RevealInput,
} from "./reveal.js";

// A real directory tree, so realpath and symlinks are the filesystem's own. On macOS the temp
// directory is itself behind a symlink (/var -> /private/var): the root's real path differs from
// the path the person chose, which is the case resolveVaultPath has to get right.
//
//   <base>/vault/ROOT/notes/a.md
//   <base>/vault/DMS/OS/b.md
//   <base>/vault/ROOT/link-out.md -> <base>/outside/secret.md
//   <base>/vault/ROOT/link-in.md  -> <base>/vault/DMS/OS/b.md
//   <base>/outside/secret.md
//   <base>/vault-evil/c.md
//   <base>/vault-link -> <base>/vault
let base: string;
let vault: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "orchestra-reveal-"));
  vault = path.join(base, "vault");
  await mkdir(path.join(vault, "ROOT", "notes"), { recursive: true });
  await mkdir(path.join(vault, "DMS", "OS"), { recursive: true });
  await mkdir(path.join(base, "outside"), { recursive: true });
  await mkdir(path.join(base, "vault-evil"), { recursive: true });
  await writeFile(path.join(vault, "ROOT", "notes", "a.md"), "a");
  await writeFile(path.join(vault, "DMS", "OS", "b.md"), "b");
  await writeFile(path.join(base, "outside", "secret.md"), "s");
  await writeFile(path.join(base, "vault-evil", "c.md"), "c");
  await symlink(path.join(base, "outside", "secret.md"), path.join(vault, "ROOT", "link-out.md"));
  await symlink(path.join(vault, "DMS", "OS", "b.md"), path.join(vault, "ROOT", "link-in.md"));
  await symlink(vault, path.join(base, "vault-link"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function input(partial: Partial<RevealInput>): RevealInput {
  return { path: null, rel: null, raw: "x.md", ...partial };
}

async function real(...segments: string[]): Promise<string> {
  return realpath(path.join(...segments));
}

describe("resolveVaultPath", () => {
  it("takes an absolute path under the root", async () => {
    const abs = path.join(vault, "ROOT", "notes", "a.md");
    await expect(
      resolveVaultPath(input({ path: abs, raw: abs }), vault, nodeRevealFs),
    ).resolves.toEqual({
      abs: await real(vault, "ROOT", "notes", "a.md"),
    });
  });

  it("refuses an absolute path outside the root when nothing else points into the vault", async () => {
    const abs = path.join(base, "outside", "secret.md");
    await expect(
      resolveVaultPath(input({ path: abs, raw: abs }), vault, nodeRevealFs),
    ).resolves.toEqual({
      reason: "outside_vault",
    });
  });

  it("does not take a sibling folder whose name only starts like the root", async () => {
    const abs = path.join(base, "vault-evil", "c.md");
    await expect(
      resolveVaultPath(input({ path: abs, raw: abs }), vault, nodeRevealFs),
    ).resolves.toEqual({
      reason: "outside_vault",
    });
  });

  it("falls back to root/rel when the daemon's absolute path is not under this root", async () => {
    const result = await resolveVaultPath(
      input({ path: "/home/daemon/vault/ROOT/notes/a.md", rel: "ROOT/notes/a.md", raw: "a.md" }),
      vault,
      nodeRevealFs,
    );
    expect(result).toEqual({ abs: await real(vault, "ROOT", "notes", "a.md") });
  });

  it("resolves a raw ROOT/… or DMS/… path under the root", async () => {
    await expect(
      resolveVaultPath(input({ raw: "ROOT/notes/a.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ abs: await real(vault, "ROOT", "notes", "a.md") });
    await expect(
      resolveVaultPath(input({ raw: "DMS/OS/b.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ abs: await real(vault, "DMS", "OS", "b.md") });
  });

  it("does not take a raw relative path outside ROOT/ and DMS/", async () => {
    await expect(
      resolveVaultPath(input({ raw: "notes/a.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ reason: "outside_vault" });
  });

  it("refuses any `..` segment instead of normalizing it", async () => {
    // Written by hand: path.join would normalize the `..` away before the call.
    const escape = `${vault}/ROOT/../../outside/secret.md`;
    await expect(
      resolveVaultPath(input({ path: escape, raw: "secret.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ reason: "bad_path" });
    await expect(
      resolveVaultPath(input({ rel: "ROOT/../../outside/secret.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ reason: "bad_path" });
    await expect(
      resolveVaultPath(input({ raw: "ROOT/../../outside/secret.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ reason: "bad_path" });
    await expect(
      resolveVaultPath(input({ rel: "ROOT\\..\\..\\outside\\secret.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ reason: "bad_path" });
  });

  it("ignores `..` in a raw link text that is not used as a vault path", async () => {
    const abs = path.join(vault, "ROOT", "notes", "a.md");
    await expect(
      resolveVaultPath(input({ path: abs, raw: "../notes/a.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ abs: await real(vault, "ROOT", "notes", "a.md") });
  });

  it("refuses an absolute rel", async () => {
    await expect(
      resolveVaultPath(
        input({ rel: path.join(vault, "ROOT", "notes", "a.md") }),
        vault,
        nodeRevealFs,
      ),
    ).resolves.toEqual({ reason: "bad_path" });
  });

  it("refuses a symlink inside the vault that points outside it", async () => {
    await expect(
      resolveVaultPath(input({ rel: "ROOT/link-out.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ reason: "outside_vault" });
    const abs = path.join(vault, "ROOT", "link-out.md");
    await expect(
      resolveVaultPath(input({ path: abs, raw: abs }), vault, nodeRevealFs),
    ).resolves.toEqual({ reason: "outside_vault" });
  });

  it("follows a symlink that stays inside the vault and reveals its target", async () => {
    await expect(
      resolveVaultPath(input({ raw: "ROOT/link-in.md" }), vault, nodeRevealFs),
    ).resolves.toEqual({ abs: await real(vault, "DMS", "OS", "b.md") });
  });

  it("answers not_found for a file that does not exist under the root", async () => {
    await expect(
      resolveVaultPath(
        input({
          path: path.join(vault, "ROOT", "missing.md"),
          rel: "ROOT/missing.md",
          raw: "ROOT/missing.md",
        }),
        vault,
        nodeRevealFs,
      ),
    ).resolves.toEqual({ reason: "not_found" });
  });

  it("accepts a root chosen through a symlink, with paths written either way", async () => {
    const linkRoot = path.join(base, "vault-link");
    await expect(
      resolveVaultPath(
        input({ path: path.join(vault, "ROOT", "notes", "a.md") }),
        linkRoot,
        nodeRevealFs,
      ),
    ).resolves.toEqual({ abs: await real(vault, "ROOT", "notes", "a.md") });
    await expect(
      resolveVaultPath(
        input({ path: path.join(linkRoot, "ROOT", "notes", "a.md") }),
        linkRoot,
        nodeRevealFs,
      ),
    ).resolves.toEqual({ abs: await real(vault, "ROOT", "notes", "a.md") });
  });

  it("answers no_vault when the root is relative or gone", async () => {
    await expect(
      resolveVaultPath(input({ raw: "ROOT/notes/a.md" }), "vault", nodeRevealFs),
    ).resolves.toEqual({ reason: "no_vault" });
    await expect(
      resolveVaultPath(input({ raw: "ROOT/notes/a.md" }), path.join(base, "gone"), nodeRevealFs),
    ).resolves.toEqual({ reason: "no_vault" });
  });

  it("uses the injected filesystem only", async () => {
    const fs = {
      realpath: vi.fn(async (target: string) => target),
      exists: vi.fn(async (target: string) => target === "/v/ROOT/a.md"),
    };
    await expect(resolveVaultPath(input({ raw: "ROOT/a.md" }), "/v", fs)).resolves.toEqual({
      abs: "/v/ROOT/a.md",
    });
    expect(fs.exists).toHaveBeenCalledWith("/v/ROOT/a.md");
  });
});

describe("parseRevealInput", () => {
  it("accepts the contract's shape", () => {
    expect(parseRevealInput({ path: "/a/b.md", rel: null, raw: "b.md" })).toEqual({
      path: "/a/b.md",
      rel: null,
      raw: "b.md",
    });
    expect(parseRevealInput({ path: null, rel: "ROOT/b.md", raw: "ROOT/b.md" })).toEqual({
      path: null,
      rel: "ROOT/b.md",
      raw: "ROOT/b.md",
    });
  });

  it.each([
    ["a string", "ROOT/a.md"],
    ["null", null],
    ["an array", ["ROOT/a.md"]],
    ["a missing raw", { path: null, rel: null }],
    ["a missing path", { rel: null, raw: "a.md" }],
    ["a numeric path", { path: 7, rel: null, raw: "a.md" }],
    ["an empty raw", { path: null, rel: null, raw: "" }],
    ["an empty rel", { path: null, rel: "", raw: "a.md" }],
    ["a NUL byte", { path: "/v/a\0.md", rel: null, raw: "a.md" }],
    ["an overlong path", { path: `/${"a".repeat(5000)}`, rel: null, raw: "a.md" }],
  ])("refuses %s", (_label, value) => {
    expect(parseRevealInput(value)).toBeNull();
  });
});

function event(overrides: {
  url?: string;
  parent?: unknown;
  type?: string;
  noFrame?: boolean;
}): RevealEvent {
  return {
    sender: { getType: () => overrides.type ?? "window" },
    senderFrame: overrides.noFrame
      ? null
      : { parent: overrides.parent ?? null, url: overrides.url ?? `${ORCHESTRA_URL}/notes` },
  };
}

describe("isOrchestraTopFrame", () => {
  it("accepts Orchestra's top frame in an app window", () => {
    expect(isOrchestraTopFrame(event({}))).toBe(true);
  });

  it.each([
    ["a subframe of the Orchestra page", event({ parent: { url: ORCHESTRA_URL } })],
    ["another origin's top frame", event({ url: "https://evil.example/notes" })],
    [
      "an Orchestra look-alike host",
      event({ url: "https://orchestra.figmenta.site.evil.example/" }),
    ],
    ["a <webview> guest on the Orchestra origin", event({ type: "webview" })],
    ["a destroyed frame", event({ noFrame: true })],
  ])("refuses %s", (_label, candidate) => {
    expect(isOrchestraTopFrame(candidate)).toBe(false);
  });
});

describe("createRevealHandler", () => {
  function deps(root: string | null, chosen: string | null = null) {
    let stored = root;
    const result = {
      getVaultRoot: vi.fn(async () => stored),
      saveVaultRoot: vi.fn(async (next: string) => {
        stored = next;
      }),
      chooseVaultRoot: vi.fn(async () => chosen),
      showItemInFolder: vi.fn(),
    } satisfies RevealDeps;
    return result;
  }

  it("rejects a caller that is not Orchestra's top frame and touches nothing", async () => {
    const d = deps(vault);
    const handler = createRevealHandler(d);
    for (const caller of [
      event({ parent: { url: ORCHESTRA_URL } }),
      event({ url: "https://evil.example/" }),
      event({ type: "webview" }),
      event({ noFrame: true }),
    ]) {
      await expect(
        handler(caller, { path: null, rel: null, raw: "ROOT/notes/a.md" }),
      ).rejects.toThrow(REVEAL_CHANNEL);
    }
    expect(d.getVaultRoot).not.toHaveBeenCalled();
    expect(d.chooseVaultRoot).not.toHaveBeenCalled();
    expect(d.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals a vault file for Orchestra's top frame", async () => {
    const d = deps(vault);
    const result = await createRevealHandler(d)(event({}), {
      path: null,
      rel: null,
      raw: "ROOT/notes/a.md",
    });
    expect(result).toEqual({ ok: true });
    expect(d.showItemInFolder).toHaveBeenCalledWith(await real(vault, "ROOT", "notes", "a.md"));
  });

  it("answers bad_path for malformed input without asking for a vault", async () => {
    const d = deps(null, vault);
    await expect(createRevealHandler(d)(event({}), { raw: 7 })).resolves.toEqual({
      ok: false,
      reason: "bad_path",
    });
    expect(d.chooseVaultRoot).not.toHaveBeenCalled();
  });

  it("asks for the vault the first time and keeps the choice", async () => {
    const d = deps(null, vault);
    const handler = createRevealHandler(d);
    await expect(
      handler(event({}), { path: null, rel: null, raw: "DMS/OS/b.md" }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(d.saveVaultRoot).toHaveBeenCalledWith(vault);
    await handler(event({}), { path: null, rel: null, raw: "DMS/OS/b.md" });
    expect(d.chooseVaultRoot).toHaveBeenCalledTimes(1);
  });

  it("answers no_vault when the person cancels the picker, and saves nothing", async () => {
    const d = deps(null, null);
    await expect(
      createRevealHandler(d)(event({}), { path: null, rel: null, raw: "ROOT/notes/a.md" }),
    ).resolves.toEqual({ ok: false, reason: "no_vault" });
    expect(d.saveVaultRoot).not.toHaveBeenCalled();
    expect(d.showItemInFolder).not.toHaveBeenCalled();
  });

  it("asks again when the saved root is no longer a folder", async () => {
    const d = deps(path.join(base, "moved-away"), vault);
    await expect(
      createRevealHandler(d)(event({}), { path: null, rel: null, raw: "ROOT/notes/a.md" }),
    ).resolves.toEqual({ ok: true });
    expect(d.chooseVaultRoot).toHaveBeenCalledTimes(1);
    expect(d.saveVaultRoot).toHaveBeenCalledWith(vault);
  });

  it("opens one picker for clicks that arrive while it is open", async () => {
    let pick: (value: string | null) => void = () => {};
    const d = deps(null);
    d.chooseVaultRoot.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          pick = resolve;
        }),
    );
    const handler = createRevealHandler(d);
    const first = handler(event({}), { path: null, rel: null, raw: "ROOT/notes/a.md" });
    const second = handler(event({}), { path: null, rel: null, raw: "DMS/OS/b.md" });
    await vi.waitFor(() => expect(d.chooseVaultRoot).toHaveBeenCalledTimes(1));
    pick(vault);
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(d.chooseVaultRoot).toHaveBeenCalledTimes(1);
  });

  it("does not reveal a file outside the vault", async () => {
    const d = deps(vault);
    const abs = path.join(base, "outside", "secret.md");
    await expect(
      createRevealHandler(d)(event({}), { path: abs, rel: null, raw: abs }),
    ).resolves.toEqual({
      ok: false,
      reason: "outside_vault",
    });
    expect(d.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe("registerReveal", () => {
  it("registers the handler on the reveal channel", () => {
    const handle = vi.fn();
    registerReveal(
      { handle },
      {
        getVaultRoot: async () => null,
        saveVaultRoot: async () => {},
        chooseVaultRoot: async () => null,
        showItemInFolder: () => {},
      },
    );
    expect(handle).toHaveBeenCalledWith(REVEAL_CHANNEL, expect.any(Function));
  });
});

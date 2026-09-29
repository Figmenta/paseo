import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Figmenta fork: the build-time half of Git Bash on Windows (scripts/figmenta-portable-git.js):
// the pinned PortableGit goes into resources/git/ with the manifest the app reads.

interface Pinned {
  version: string;
  tag: string;
  assets: Record<string, { file: string; sha256: string }>;
}
interface Options {
  cacheDir?: string;
  fetch?: typeof fetch;
  pinned?: Pinned;
}
const script = createRequire(import.meta.url)("../../scripts/figmenta-portable-git.js") as {
  PORTABLE_GIT: Pinned;
  MANIFEST_NAME: string;
  portableGitAsset(arch: string, pinned?: Pinned): { file: string; sha256: string; url: string };
  ensurePortableGitCached(arch: string, options?: Options): Promise<string>;
  bundlePortableGit(
    resourcesDir: string,
    arch: string,
    options?: Options,
  ): Promise<{ version: string; file: string; sha256: string }>;
};

const CONTENT = Buffer.from("MZ fake PortableGit self-extractor");
const FAKE: Pinned = {
  version: "9.9.9",
  tag: "v9.9.9.windows.1",
  assets: {
    x64: {
      file: "PortableGit-9.9.9-64-bit.7z.exe",
      sha256: createHash("sha256").update(CONTENT).digest("hex"),
    },
  },
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "orchestra-portable-git-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function serving(body: Buffer, status = 200) {
  return vi.fn(async () => new Response(status === 200 ? body : "nope", { status }));
}

describe("figmenta-portable-git", () => {
  it("pins Git for Windows 2.56.0 PortableGit by the SHA-256 in its release notes", () => {
    expect(script.PORTABLE_GIT.version).toBe("2.56.0");
    expect(script.portableGitAsset("x64")).toEqual({
      file: "PortableGit-2.56.0-64-bit.7z.exe",
      sha256: "eceb5e061aa90df2f69ddd3e90f0030e1b8037a7829934bc40e4be1caa1accc1",
      version: "2.56.0",
      url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.1/PortableGit-2.56.0-64-bit.7z.exe",
    });
    expect(script.portableGitAsset("arm64").sha256).toBe(
      "edd9bd32aefa5d2bd4b938c38c18ceca306a7f6b29a6951cd6a4bb16d9d28d8f",
    );
    expect(() => script.portableGitAsset("ia32")).toThrow("no pinned build");
  });

  it("bundles the archive and the manifest the app reads, replacing an older bundle", async () => {
    const resources = tempDir();
    const cacheDir = tempDir();
    await script.bundlePortableGit(resources, "x64", {
      cacheDir,
      fetch: serving(CONTENT),
      pinned: { ...FAKE, assets: { x64: { file: "old.7z.exe", sha256: FAKE.assets.x64.sha256 } } },
    });
    const manifest = await script.bundlePortableGit(resources, "x64", {
      cacheDir,
      fetch: serving(CONTENT),
      pinned: FAKE,
    });

    const gitDir = path.join(resources, "git");
    expect(readdirSync(gitDir).sort()).toEqual([script.MANIFEST_NAME, FAKE.assets.x64.file].sort());
    expect(script.MANIFEST_NAME).toBe("portable-git.json");
    expect(JSON.parse(readFileSync(path.join(gitDir, "portable-git.json"), "utf8"))).toEqual(
      manifest,
    );
    expect(manifest).toEqual({
      version: "9.9.9",
      file: FAKE.assets.x64.file,
      sha256: FAKE.assets.x64.sha256,
    });
    expect(readFileSync(path.join(gitDir, FAKE.assets.x64.file))).toEqual(CONTENT);
  });

  it("uses a cached archive whose hash matches, without downloading", async () => {
    const cacheDir = tempDir();
    writeFileSync(path.join(cacheDir, FAKE.assets.x64.file), CONTENT);
    const fetchImpl = serving(CONTENT);
    await script.ensurePortableGitCached("x64", { cacheDir, fetch: fetchImpl, pinned: FAKE });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads again over a cached archive whose hash does not match", async () => {
    const cacheDir = tempDir();
    writeFileSync(path.join(cacheDir, FAKE.assets.x64.file), "tampered");
    const fetchImpl = serving(CONTENT);
    const file = await script.ensurePortableGitCached("x64", {
      cacheDir,
      fetch: fetchImpl,
      pinned: FAKE,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readFileSync(file)).toEqual(CONTENT);
  });

  it("refuses a download with the wrong hash and leaves nothing behind", async () => {
    const cacheDir = tempDir();
    await expect(
      script.ensurePortableGitCached("x64", {
        cacheDir,
        fetch: serving(Buffer.from("something else")),
        pinned: FAKE,
      }),
    ).rejects.toThrow(/SHA-256 .* expected/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it("fails the build on an HTTP error", async () => {
    const cacheDir = tempDir();
    await expect(
      script.ensurePortableGitCached("x64", {
        cacheDir,
        fetch: serving(CONTENT, 404),
        pinned: FAKE,
      }),
    ).rejects.toThrow("HTTP 404");
    expect(existsSync(path.join(cacheDir, FAKE.assets.x64.file))).toBe(false);
  });

  it("is wired into afterPack for Windows builds only", () => {
    const source = readFileSync(path.resolve(__dirname, "../../scripts/after-pack.js"), "utf8");
    expect(source).toMatch(
      /if \(platform === "win32"\) \{\s*await bundlePortableGit\(resourcesDirFor\(context\.appOutDir, platform\), arch\);/,
    );
  });
});

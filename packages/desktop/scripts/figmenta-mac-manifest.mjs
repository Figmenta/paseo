// Figmenta fork: the macOS update manifest (latest-mac.yml) of a signed release.
//
//   node figmenta-mac-manifest.mjs zips-only <in.yml> <out.yml>
//       keep only the .zip entries: the updater downloads zips, and the dmgs are
//       re-signed/stapled after electron-builder hashed them, so their sha512/size in
//       the manifest would be stale.
//   node figmenta-mac-manifest.mjs verify <latest-mac.yml> <release-dir>
//       every file listed (and the top-level path) exists with that size and sha512.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dump, load } from "js-yaml";

function sha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function zipsOnly(input, output) {
  const manifest = load(readFileSync(input, "utf8"));
  const files = (manifest.files ?? []).filter((file) => file.url.endsWith(".zip"));
  if (files.length === 0) throw new Error(`no .zip entry in ${input}`);
  if (!String(manifest.path).endsWith(".zip")) throw new Error(`top-level path is not a zip`);
  writeFileSync(output, dump({ ...manifest, files }, { lineWidth: -1, noRefs: true }));
}

function verify(manifestPath, dir) {
  const manifest = load(readFileSync(manifestPath, "utf8"));
  const entries = [...(manifest.files ?? [])];
  entries.push({ url: manifest.path, sha512: manifest.sha512 });
  let failures = 0;
  for (const entry of entries) {
    const file = path.join(dir, entry.url);
    let problem = null;
    try {
      if (entry.size !== undefined && statSync(file).size !== entry.size) problem = "size";
      else if (sha512(file) !== entry.sha512) problem = "sha512";
    } catch {
      problem = "missing";
    }
    console.log(`manifest: ${entry.url} ${problem ? `MISMATCH (${problem})` : "ok"}`);
    if (problem) failures += 1;
  }
  if (!entries.some((entry) => entry.url.includes("arm64"))) {
    console.log("manifest: no arm64 entry");
    failures += 1;
  }
  if (!entries.some((entry) => entry.url.includes("x64"))) {
    console.log("manifest: no x64 entry");
    failures += 1;
  }
  if (failures) throw new Error(`${failures} manifest problem(s) in ${manifestPath}`);
}

const [, , mode, a, b] = process.argv;
if (mode === "zips-only" && a && b) zipsOnly(a, b);
else if (mode === "verify" && a && b) verify(a, b);
else {
  console.error("usage: figmenta-mac-manifest.mjs zips-only <in> <out> | verify <yml> <dir>");
  process.exit(2);
}

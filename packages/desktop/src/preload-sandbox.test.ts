import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { REVEAL_CHANNEL } from "./figmenta/reveal.js";

// The preload runs inside Electron's sandbox and is tsc-compiled (not bundled), so at
// runtime it may only load Electron's sandbox allowlist. Any other module (local or
// third-party) emits a require() that the sandbox rejects synchronously, aborting the
// preload before contextBridge.exposeInMainWorld runs and leaving window.orchestraDesktop
// undefined. That regression (0.1.108, #2103) is what this test guards against.
const SANDBOX_ALLOWLIST = new Set(["electron"]);

const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.ts");
// Figmenta fork: the mandatory-update screen has its own sandboxed preload.
const updateOverlayPreloadPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "figmenta",
  "update-overlay-preload.ts",
);
// ... and so has the "Setting up Claude Code" window.
const claudeCodeSetupPreloadPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "figmenta",
  "claude-code-setup-preload.ts",
);

// Collect every module specifier that survives to emitted JavaScript as a runtime load.
// Type-only imports/exports are erased by tsc and are therefore ignored.
function runtimeModuleSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "preload.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const specifiers: string[] = [];

  const record = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  };

  const isTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
    const clause = node.importClause;
    if (!clause) {
      // Side-effect import: `import "./x.js"` — always a runtime load.
      return false;
    }
    if (clause.isTypeOnly) {
      return true;
    }
    const bindings = clause.namedBindings;
    // `import { type A, type B } from "x"` erases entirely; a default or namespace
    // binding, or any value-named binding, keeps the module at runtime.
    return (
      clause.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyImport(node)) {
        record(node.moduleSpecifier);
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

describe("preload sandbox safety", () => {
  it.each([
    ["preload.ts", preloadPath],
    ["figmenta/update-overlay-preload.ts", updateOverlayPreloadPath],
    ["figmenta/claude-code-setup-preload.ts", claudeCodeSetupPreloadPath],
  ])("%s only loads Electron's sandbox allowlist at runtime", (_name, filePath) => {
    const source = readFileSync(filePath, "utf8");
    const disallowed = runtimeModuleSpecifiers(source).filter(
      (specifier) => !SANDBOX_ALLOWLIST.has(specifier),
    );
    expect(disallowed).toEqual([]);
  });

  // Figmenta fork: the browser-profile partition assertion went with the bridge — the
  // Orchestra preload exposes no browser surface, so there is nothing to keep in sync.
});

// Figmenta fork: what the remote Orchestra page can reach through preload.ts, pinned. The
// page gets the read-only `window.orchestraDesktop` (built with executeInMainWorld) and ONE
// callable global, `orchestraDesktopActions`, whose only IPC is the reveal channel
// (contratto notes-maestro §10.5). Anything added here is a new door into the app from a
// remote origin: this test fails until that is decided and the expectation updated with it.
function preloadIpcSurface(source: string): { exposed: string[]; ipc: string[] } {
  const sourceFile = ts.createSourceFile("preload.ts", source, ts.ScriptTarget.Latest, true);
  const constants = new Map<string, string>();
  const collectConstants = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      constants.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collectConstants);
  };
  collectConstants(sourceFile);

  const text = (node: ts.Expression | undefined): string => {
    if (node && ts.isStringLiteralLike(node)) return node.text;
    if (node && ts.isIdentifier(node)) return constants.get(node.text) ?? `<${node.text}>`;
    return "<dynamic>";
  };
  const exposed: string[] = [];
  const ipc: string[] = [];
  const collectCalls = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const owner = node.expression.expression.text;
      const method = node.expression.name.text;
      if (owner === "contextBridge" && method === "exposeInMainWorld") {
        exposed.push(text(node.arguments[0]));
      }
      if (owner === "ipcRenderer") {
        ipc.push(`${method} ${text(node.arguments[0])}`);
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(sourceFile);
  return { exposed: exposed.sort(), ipc: ipc.sort() };
}

describe("preload surface", () => {
  it("exposes only orchestraDesktopActions, whose only call is the reveal channel", () => {
    expect(preloadIpcSurface(readFileSync(preloadPath, "utf8"))).toEqual({
      exposed: ["orchestraDesktopActions"],
      ipc: [
        `invoke ${REVEAL_CHANNEL}`,
        "on orchestra-desktop:claude-code",
        "sendSync orchestra-desktop:claude-code:get",
      ],
    });
  });
});

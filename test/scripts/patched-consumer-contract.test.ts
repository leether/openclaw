import { createHash } from "node:crypto";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPackageTree } from "../../scripts/fork-linux/patched-consumer-contract.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const dirs: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(() => cleanupTempDirs(dirs));

function fixture() {
  const root = makeTempDir(dirs, "patched-consumer-contract-");
  const body = JSON.stringify({
    name: "@a2ui/web_core",
    version: "0.11.0",
    dependencies: { zod: "4.6.6" },
  });
  const manifest = `${body}\n`;
  writeFileSync(path.join(root, "package.json"), manifest, { mode: 0o644 });
  writeFileSync(path.join(root, "index.js"), "export const version = 4;\n", { mode: 0o644 });
  const entries: [string, string][] = [
    ["index.js", "export const version = 4;\n"],
    ["package.json", manifest],
  ];
  const mode = (file: string) => `0o${(statSync(path.join(root, file)).mode & 0o777).toString(8)}`;
  const expected = {
    name: "@a2ui/web_core",
    version: "0.11.0",
    fileCount: 2,
    targetTreeSha256: sha(
      JSON.stringify(
        entries.map(([file, text]) => [file, sha(text), Buffer.byteLength(text), mode(file)]),
      ),
    ),
    packageJsonVariants: [manifest, body].map((text) => ({
      sha256: sha(text),
      bytes: Buffer.byteLength(text),
      mode: mode("package.json"),
    })),
  };
  return { root, expected, body };
}

describe("patched package content contract", () => {
  it("accepts the exact published bytes and the one explicitly recorded pnpm newline variant", () => {
    const { root, expected, body } = fixture();
    const first = verifyPackageTree(root, expected);
    writeFileSync(path.join(root, "package.json"), body);
    const second = verifyPackageTree(root, expected);
    expect(first.targetTreeSha256).toBe(second.targetTreeSha256);
    expect(first.rawTreeSha256).not.toBe(second.rawTreeSha256);
  });

  it("separates dependency links and generated shims from published package files", () => {
    const { root, expected } = fixture();
    mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", ".bin", "synthetic"), "shim");
    const report = verifyPackageTree(root, expected);
    expect(report.files).toBe(2);
    expect(report.excludedInstallationMetadata).toEqual(["node_modules"]);
  });

  it("rejects otherwise equivalent JSON with unreviewed bytes", () => {
    const { root, expected, body } = fixture();
    writeFileSync(path.join(root, "package.json"), `${body}\n\n`);
    expect(() => verifyPackageTree(root, expected)).toThrow("Unreviewed package.json bytes");
  });

  it.each(["changed", "additional", "symlink"])("rejects %s runtime content", (kind) => {
    const { root, expected } = fixture();
    if (kind === "changed")
      writeFileSync(path.join(root, "index.js"), "export const version = 3;\n");
    if (kind === "additional") writeFileSync(path.join(root, "legacy.js"), "legacy");
    if (kind === "symlink") symlinkSync("index.js", path.join(root, "linked.js"));
    expect(() => verifyPackageTree(root, expected)).toThrow();
  });
});

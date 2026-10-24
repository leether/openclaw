import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_NPM_CONTRACT,
  deriveBundledNpmArtifact,
  readBundledNpmPackageArchive,
  verifyBundledNpmArtifact,
  verifyBundledNpmPackageFiles,
} from "../../scripts/lib/package-bundled-npm.mts";

type Fixture = { path: string; text?: string; type?: string; mode?: number; link?: string };

function checksum(header: Buffer) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

// Independent minimal USTAR fixture encoder; it does not use the production writer.
function archive(entries: Fixture[], change?: (bytes: Buffer) => void) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const content = Buffer.from(entry.text ?? "{}");
    header.write(entry.path, 0, 100, "ascii");
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write(entry.link ?? "", 157, 100, "ascii");
    header.write("ustar\x0000", 257, 8, "ascii");
    checksum(header);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const bytes = Buffer.concat(blocks);
  change?.(bytes);
  return gzipSync(bytes);
}

const npmManifest = JSON.stringify({ name: "npm", version: "12.2.1" });
const undiciManifest = JSON.stringify({ name: "undici", version: "6.29.1" });

describe("bounded npm derivation archive reader", () => {
  it("reads canonical files and retains executable modes and binary bytes", () => {
    const files = readBundledNpmPackageArchive(
      archive([
        { path: "package/package.json", text: npmManifest },
        { path: "package/bin/npm-cli.js", text: "\0\u0001test", mode: 0o755 },
      ]),
    );
    expect(files.map((file) => file.path)).toEqual(["bin/npm-cli.js", "package.json"]);
    expect(files[0]?.mode).toBe(0o755);
    expect(Buffer.from(files[0]?.content ?? [])).toEqual(Buffer.from("\0\u0001test"));
  });

  it.each([
    "package/../outside",
    "/package/file",
    "package//file",
    "package/./file",
    "package/C:/file",
    "package/foo\\bar",
    "elsewhere/file",
  ])("rejects noncanonical path %s", (entryPath) => {
    expect(() => readBundledNpmPackageArchive(archive([{ path: entryPath }]))).toThrow(
      /package path|package root/,
    );
  });

  it.each(["1", "2", "5", "x", "g", "L", "K"])("rejects type %s", (type) => {
    expect(() => readBundledNpmPackageArchive(archive([{ path: "package/file", type }]))).toThrow(
      "unsupported tar entry type or link",
    );
  });

  it("rejects a link target even on a regular entry", () => {
    expect(() =>
      readBundledNpmPackageArchive(archive([{ path: "package/file", link: "another" }])),
    ).toThrow("unsupported tar entry type or link");
  });

  it("rejects duplicate paths and file/directory collisions", () => {
    expect(() =>
      readBundledNpmPackageArchive(archive([{ path: "package/a" }, { path: "package/a" }])),
    ).toThrow("duplicate package path");
    expect(() =>
      readBundledNpmPackageArchive(archive([{ path: "package/a" }, { path: "package/a/b" }])),
    ).toThrow("file/directory path collision");
  });

  it("rejects checksum, padding and trailing data corruption independently", () => {
    expect(() =>
      readBundledNpmPackageArchive(archive([{ path: "package/a" }], (bytes) => (bytes[0] = 88))),
    ).toThrow("tar checksum mismatch");
    expect(() =>
      readBundledNpmPackageArchive(archive([{ path: "package/a" }], (bytes) => (bytes[514] = 1))),
    ).toThrow("truncated entry or nonzero padding");
    expect(() =>
      readBundledNpmPackageArchive(
        archive([{ path: "package/a" }], (bytes) => (bytes[bytes.length - 1] = 1)),
      ),
    ).toThrow("invalid tar trailing blocks");
  });

  it("rejects missing end markers and truncated blocks", () => {
    const bytes = gunzipSync(archive([{ path: "package/a" }]));
    expect(() => readBundledNpmPackageArchive(gzipSync(bytes.subarray(0, -1024)))).toThrow(
      "missing tar end markers",
    );
    expect(() => readBundledNpmPackageArchive(gzipSync(bytes.subarray(0, -1)))).toThrow(
      "truncated tar block",
    );
  });

  it("rejects unsupported modes and non-octal numeric encoding", () => {
    expect(() =>
      readBundledNpmPackageArchive(archive([{ path: "package/a", mode: 0o4755 }])),
    ).toThrow("unsupported file mode");
    expect(() =>
      readBundledNpmPackageArchive(
        archive([{ path: "package/a" }], (bytes) => {
          bytes[124] = 0xb0;
          checksum(bytes.subarray(0, 512));
        }),
      ),
    ).toThrow("invalid tar numeric encoding");
  });

  it("enforces compressed, declared file and inventory count bounds", () => {
    expect(() => readBundledNpmPackageArchive(Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow(
      "compressed archive bound",
    );
    expect(() =>
      readBundledNpmPackageArchive(
        archive([{ path: "package/a" }], (bytes) => {
          bytes.write(`${(1024 * 1024 + 1).toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
          checksum(bytes.subarray(0, 512));
        }),
      ),
    ).toThrow("tar entry bound");
    expect(() =>
      readBundledNpmPackageArchive(
        archive(Array.from({ length: 4097 }, (_, index) => ({ path: `package/f${index}` }))),
      ),
    ).toThrow("tar entry bound");
  });
});

describe("fixed npm derivation authority", () => {
  it("rejects synthetic inputs instead of accepting self-reported provenance", () => {
    expect(() =>
      deriveBundledNpmArtifact({
        npmTarball: archive([{ path: "package/package.json", text: npmManifest }]),
        undiciTarball: archive([{ path: "package/package.json", text: undiciManifest }]),
      }),
    ).toThrow("official input integrity mismatch");
  });

  it("rejects missing or wrong identities before checking the fixed tree", () => {
    expect(() => verifyBundledNpmPackageFiles({ files: [] })).toThrow("missing package identity");
    expect(() =>
      verifyBundledNpmPackageFiles({
        files: [{ path: "package.json", mode: 0o644, content: Buffer.from(undiciManifest) }],
      }),
    ).toThrow("unexpected package identity");
  });

  it("rejects correct version labels without the complete reviewed bytes", () => {
    expect(() =>
      verifyBundledNpmPackageFiles({
        files: [
          { path: "package.json", mode: 0o644, content: Buffer.from(npmManifest) },
          {
            path: "node_modules/undici/package.json",
            mode: 0o644,
            content: Buffer.from(undiciManifest),
          },
        ],
      }),
    ).toThrow("derived package tree mismatch");
  });
});

// Explicit qualification input, never an automatic download or a local absolute-path fallback.
const officialFixtureDir = process.env.OPENCLAW_NPM_BUNDLE_OFFICIAL_FIXTURE_DIR;
describe.skipIf(!officialFixtureDir)("verified official npm and Undici inputs", () => {
  it("derives deterministically, preserves all unrelated files, and rejects a changed final tree", () => {
    if (!officialFixtureDir) {
      throw new Error("Official npm fixture directory is required");
    }
    const inputs = {
      npmTarball: readFileSync(path.join(officialFixtureDir, "npm-12.2.1.tgz")),
      undiciTarball: readFileSync(path.join(officialFixtureDir, "undici-6.29.1.tgz")),
    };
    const first = deriveBundledNpmArtifact(inputs);
    const second = deriveBundledNpmArtifact(inputs);
    expect(first.tarball.equals(second.tarball)).toBe(true);
    expect(first.provenance.derivedTreeSha256).toBe(BUNDLED_NPM_CONTRACT.derivedTreeSha256);
    expect(first.provenance.unchangedOutsideUndiciCount).toBe(1808);
    expect(first.provenance.files).toHaveLength(1984);
    expect(first.integrity).not.toBe(BUNDLED_NPM_CONTRACT.npmIntegrity);
    expect(verifyBundledNpmArtifact({ ...inputs, derivedTarball: first.tarball }).sha256).toBe(
      createHash("sha256").update(first.tarball).digest("hex"),
    );
    const original = readBundledNpmPackageArchive(inputs.npmTarball).filter(
      (file) => !file.path.startsWith("node_modules/undici/"),
    );
    const final = readBundledNpmPackageArchive(first.tarball);
    expect(final.filter((file) => !file.path.startsWith("node_modules/undici/"))).toEqual(original);
    expect(() => verifyBundledNpmPackageFiles({ files: final.slice(1) })).toThrow(
      "derived package tree mismatch",
    );
    const changed = final.map((file) =>
      file.path === "README.md"
        ? { path: file.path, mode: file.mode, content: Buffer.from("changed") }
        : file,
    );
    expect(() => verifyBundledNpmPackageFiles({ files: changed })).toThrow(
      "derived package tree mismatch",
    );
  });
});

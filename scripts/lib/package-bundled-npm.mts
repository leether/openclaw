import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

// This is one reviewed derivation, not an override mechanism for arbitrary npm bundles.
export const BUNDLED_NPM_CONTRACT = Object.freeze({
  version: "npm-12.2.1-undici-6.29.1-v1",
  npmVersion: "12.2.1",
  undiciVersion: "6.29.1",
  npmIntegrity:
    "sha512-bKCmFRVT/BB+YPEYbZwQ1XUI3N5t4xKSpU1MxOjo7z3iWzKBJ0ZXRC1xFdEN+TC7N5TdywaBzf2dMXGJq/e2PQ==",
  undiciIntegrity:
    "sha512-EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA==",
  derivedTreeSha256: "2b8be283c3b742ccbff3502578002b36c1f5f2d7a7b43e304d1c758c6480c150",
  originalFiles: 1942,
  derivedFiles: 1984,
  unchangedOutsideUndiciFiles: 1808,
});
export const NPM_BUNDLE_INTEGRITY = BUNDLED_NPM_CONTRACT.npmIntegrity;
export const NPM_BUNDLE_DERIVATION_ID = BUNDLED_NPM_CONTRACT.version;

const BLOCK = 512;
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4096;
const UNDICI_PREFIX = "node_modules/undici/";
const USTAR_MAGIC = Buffer.from("ustar\x0000", "ascii");

export type BundledNpmPackageFile = { path: string; mode: number; content: Uint8Array };
export type BundledNpmFileProof = { path: string; bytes: number; mode: number; sha256: string };
export type BundledNpmInputs = { npmTarball: Buffer; undiciTarball: Buffer };
export type BundledNpmProvenance = {
  contract: typeof BUNDLED_NPM_CONTRACT.version;
  officialInputs: { npmIntegrity: string; undiciIntegrity: string };
  derivedTreeSha256: string;
  files: BundledNpmFileProof[];
  unchangedOutsideUndiciCount: number;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function fail(reason: string): never {
  throw new Error(`Bundled npm artifact: ${reason}`);
}

function canonicalPath(value: string): string {
  if (
    !value ||
    value.length > 255 ||
    !/^[\x21-\x7e]+$/.test(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("noncanonical package path");
  }
  return value;
}

function octal(field: Buffer): number {
  if (field.some((value) => value !== 0 && value !== 32 && (value < 48 || value > 55))) {
    fail("invalid tar numeric encoding");
  }
  const value = field
    .toString("ascii")
    .replace(/[\0 ]+$/g, "")
    .trimStart();
  if (!/^[0-7]+$/.test(value)) {
    fail("invalid tar numeric field");
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) {
    fail("unsafe tar numeric field");
  }
  return parsed;
}

function textField(field: Buffer): string {
  const nul = field.indexOf(0);
  if (nul !== -1 && field.subarray(nul).some((value) => value !== 0)) {
    fail("nonzero bytes after tar name terminator");
  }
  const bytes = nul === -1 ? field : field.subarray(0, nul);
  if (bytes.some((value) => value < 0x21 || value > 0x7e)) {
    fail("unsupported tar name encoding");
  }
  return bytes.toString("ascii");
}

function validateFiles(files: Iterable<BundledNpmPackageFile>): BundledNpmPackageFile[] {
  const seen = new Set<string>();
  const result: BundledNpmPackageFile[] = [];
  let totalBytes = 0;
  for (const entry of files) {
    canonicalPath(entry.path);
    if (seen.has(entry.path)) {
      fail("duplicate package path");
    }
    if (entry.mode !== 0o644 && entry.mode !== 0o755) {
      fail("unsupported file mode");
    }
    if (!(entry.content instanceof Uint8Array) || entry.content.byteLength > MAX_FILE_BYTES) {
      fail("file content bound");
    }
    totalBytes += entry.content.byteLength;
    if (result.length >= MAX_FILES || totalBytes > MAX_CONTENT_BYTES) {
      fail("package inventory bound");
    }
    seen.add(entry.path);
    result.push({ path: entry.path, mode: entry.mode, content: Buffer.from(entry.content) });
  }
  result.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const entry of result) {
    const parts = entry.path.split("/");
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/"))) {
        fail("file/directory path collision");
      }
      parts.pop();
    }
  }
  return result;
}

// Structural reader only. Authority comes from the fixed-input/fixed-tree verifiers below.
// Both reviewed upstream tarballs contain only USTAR regular files: no PAX, longname,
// links or directory records are needed or accepted by this narrow derivation.
export function readBundledNpmPackageArchive(tarball: Buffer): BundledNpmPackageFile[] {
  if (tarball.length === 0 || tarball.length > MAX_COMPRESSED_BYTES) {
    fail("compressed archive bound");
  }
  const tar = gunzipSync(tarball, { maxOutputLength: MAX_ARCHIVE_BYTES });
  if (tar.length % BLOCK !== 0) {
    fail("truncated tar block");
  }
  const entries: BundledNpmPackageFile[] = [];
  let offset = 0;
  let ended = false;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((value) => value === 0)) {
      if (tar.length - offset < 2 * BLOCK || tar.subarray(offset).some((value) => value !== 0)) {
        fail("invalid tar trailing blocks");
      }
      ended = true;
      break;
    }
    const checksum = header.reduce(
      (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
      0,
    );
    if (octal(header.subarray(148, 156)) !== checksum) {
      fail("tar checksum mismatch");
    }
    if (!header.subarray(257, 265).equals(USTAR_MAGIC)) {
      fail("unsupported tar format");
    }
    if (header[156] !== 48 || header.subarray(157, 257).some((value) => value !== 0)) {
      fail("unsupported tar entry type or link");
    }
    const prefix = textField(header.subarray(345, 500));
    const name = textField(header.subarray(0, 100));
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (!fullPath.startsWith("package/")) {
      fail("entry outside package root");
    }
    const entryPath = canonicalPath(fullPath.slice("package/".length));
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    if (size > MAX_FILE_BYTES || entries.length >= MAX_FILES) {
      fail("tar entry bound");
    }
    const start = offset + BLOCK;
    const end = start + size;
    const paddedEnd = start + Math.ceil(size / BLOCK) * BLOCK;
    if (paddedEnd > tar.length || tar.subarray(end, paddedEnd).some((value) => value !== 0)) {
      fail("truncated entry or nonzero padding");
    }
    entries.push({ path: entryPath, mode, content: tar.subarray(start, end) });
    offset = paddedEnd;
  }
  if (!ended) {
    fail("missing tar end markers");
  }
  return validateFiles(entries);
}

function fileProofs(files: BundledNpmPackageFile[]): BundledNpmFileProof[] {
  return files.map((file) => ({
    path: file.path,
    bytes: file.content.byteLength,
    mode: file.mode,
    sha256: sha256(file.content),
  }));
}

function assertIdentity(
  files: BundledNpmPackageFile[],
  path: string,
  name: string,
  version: string,
) {
  const entry = files.find((file) => file.path === path);
  if (!entry) {
    fail("missing package identity");
  }
  const value: unknown = JSON.parse(Buffer.from(entry.content).toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    !("version" in value) ||
    value.name !== name ||
    value.version !== version
  ) {
    fail("unexpected package identity");
  }
}

export function verifyBundledNpmPackageFiles(params: { files: Iterable<BundledNpmPackageFile> }): {
  derivedTreeSha256: string;
  files: BundledNpmFileProof[];
} {
  const files = validateFiles(params.files);
  assertIdentity(files, "package.json", "npm", BUNDLED_NPM_CONTRACT.npmVersion);
  assertIdentity(
    files,
    `${UNDICI_PREFIX}package.json`,
    "undici",
    BUNDLED_NPM_CONTRACT.undiciVersion,
  );
  const proofs = fileProofs(files);
  const derivedTreeSha256 = sha256(Buffer.from(JSON.stringify(proofs)));
  if (
    files.length !== BUNDLED_NPM_CONTRACT.derivedFiles ||
    derivedTreeSha256 !== BUNDLED_NPM_CONTRACT.derivedTreeSha256
  ) {
    fail("derived package tree mismatch");
  }
  return { derivedTreeSha256, files: proofs };
}

function putOctal(header: Buffer, offset: number, width: number, value: number) {
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length >= width) {
    fail("tar numeric overflow");
  }
  header.write(`${text}\0`, offset, width, "ascii");
}

function writeArchive(files: BundledNpmPackageFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const fullPath = `package/${file.path}`;
    let name = fullPath;
    let prefix = "";
    if (name.length > 100) {
      const separator = fullPath.lastIndexOf("/");
      prefix = fullPath.slice(0, separator);
      name = fullPath.slice(separator + 1);
    }
    if (name.length > 100 || prefix.length > 155) {
      fail("path cannot be represented as USTAR");
    }
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, "ascii");
    header.write(prefix, 345, 155, "ascii");
    putOctal(header, 100, 8, file.mode);
    putOctal(header, 108, 8, 0);
    putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, file.content.byteLength);
    putOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    USTAR_MAGIC.copy(header, 257);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(
      header,
      Buffer.from(file.content),
      Buffer.alloc((BLOCK - (file.content.byteLength % BLOCK)) % BLOCK),
    );
  }
  blocks.push(Buffer.alloc(2 * BLOCK));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function deriveBundledNpmArtifact(inputs: BundledNpmInputs): {
  tarball: Buffer;
  integrity: string;
  sha256: string;
  provenance: BundledNpmProvenance;
} {
  if (
    inputs.npmTarball.length > MAX_COMPRESSED_BYTES ||
    inputs.undiciTarball.length > MAX_COMPRESSED_BYTES ||
    integrity(inputs.npmTarball) !== BUNDLED_NPM_CONTRACT.npmIntegrity ||
    integrity(inputs.undiciTarball) !== BUNDLED_NPM_CONTRACT.undiciIntegrity
  ) {
    fail("official input integrity mismatch");
  }
  const npmFiles = readBundledNpmPackageArchive(inputs.npmTarball);
  const undiciFiles = readBundledNpmPackageArchive(inputs.undiciTarball);
  assertIdentity(npmFiles, "package.json", "npm", BUNDLED_NPM_CONTRACT.npmVersion);
  assertIdentity(npmFiles, `${UNDICI_PREFIX}package.json`, "undici", "6.29.0");
  assertIdentity(undiciFiles, "package.json", "undici", BUNDLED_NPM_CONTRACT.undiciVersion);
  const unchanged = npmFiles.filter((file) => !file.path.startsWith(UNDICI_PREFIX));
  if (
    npmFiles.length !== BUNDLED_NPM_CONTRACT.originalFiles ||
    unchanged.length !== BUNDLED_NPM_CONTRACT.unchangedOutsideUndiciFiles
  ) {
    fail("official input inventory mismatch");
  }
  const files = validateFiles([
    ...unchanged,
    ...undiciFiles.map((file) => ({
      path: `${UNDICI_PREFIX}${file.path}`,
      mode: file.mode,
      content: file.content,
    })),
  ]);
  const proof = verifyBundledNpmPackageFiles({ files });
  const tarball = writeArchive(files);
  return {
    tarball,
    integrity: integrity(tarball),
    sha256: sha256(tarball),
    provenance: {
      contract: BUNDLED_NPM_CONTRACT.version,
      officialInputs: {
        npmIntegrity: BUNDLED_NPM_CONTRACT.npmIntegrity,
        undiciIntegrity: BUNDLED_NPM_CONTRACT.undiciIntegrity,
      },
      ...proof,
      unchangedOutsideUndiciCount: unchanged.length,
    },
  };
}

export function verifyBundledNpmArtifact(params: BundledNpmInputs & { derivedTarball: Buffer }): {
  integrity: string;
  sha256: string;
  provenance: BundledNpmProvenance;
} {
  const expected = deriveBundledNpmArtifact(params);
  verifyBundledNpmPackageFiles({ files: readBundledNpmPackageArchive(params.derivedTarball) });
  if (!params.derivedTarball.equals(expected.tarball)) {
    fail("derived archive is not the deterministic artifact");
  }
  return {
    integrity: expected.integrity,
    sha256: expected.sha256,
    provenance: expected.provenance,
  };
}

// Owns the exact, source-verifiable npm derivative used by canonical core packs.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveNpmRunner } from "../npm-runner.mts";
import { hasUnjoinedWork, runManagedCommand } from "./managed-child-process.mts";
import {
  deriveBundledNpmArtifact,
  NPM_BUNDLE_DERIVATION_ID,
  verifyBundledNpmArtifact,
  verifyBundledNpmPackageFiles,
} from "./package-bundled-npm.mts";
import { isRecord } from "./record-shared.mjs";

export const NPM_RUNTIME_DERIVATION = NPM_BUNDLE_DERIVATION_ID;
const INPUTS = [
  { file: "npm-12.2.1.tgz", url: "https://registry.npmjs.org/npm/-/npm-12.2.1.tgz" },
  { file: "undici-6.29.1.tgz", url: "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz" },
];
const DERIVED_FILE = "npm-derived.tgz";
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;

function entryExists(filename: string) {
  try {
    lstatSync(filename);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function usesNpmRuntimeDerivation(manifest: unknown) {
  if (!isRecord(manifest) || manifest.openclawBundledNpmDerivation === undefined) {
    return false;
  }
  if (
    manifest.openclawBundledNpmDerivation !== NPM_RUNTIME_DERIVATION ||
    !isRecord(manifest.dependencies) ||
    manifest.dependencies.npm !== "12.2.1" ||
    !Array.isArray(manifest.bundleDependencies) ||
    !manifest.bundleDependencies.includes("npm")
  ) {
    throw new Error("Invalid exact npm runtime derivation contract");
  }
  return true;
}

function readArchive(filename: string) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES || stat.size === 0) {
    throw new Error(`Invalid bounded npm runtime archive: ${path.basename(filename)}`);
  }
  return readFileSync(filename);
}

function realDirectory(parent: string, name: string) {
  const target = path.join(parent, name);
  mkdirSync(target, { recursive: true });
  if (!lstatSync(target).isDirectory() || realpathSync(target) !== target) {
    throw new Error(`npm runtime artifact directory must not be a symlink: ${name}`);
  }
  return target;
}

type NpmRuntimeFetchCommand = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
};

export type EnsureNpmRuntimeArtifactOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

async function runFetchCommand(command: NpmRuntimeFetchCommand) {
  const overflow = new AbortController();
  const signal = command.signal
    ? AbortSignal.any([command.signal, overflow.signal])
    : overflow.signal;
  let outputBytes = 0;
  try {
    const code = await runManagedCommand({
      bin: command.command,
      args: command.args,
      cwd: command.cwd,
      env: command.env,
      shell: command.shell,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: command.timeoutMs,
      timeoutKillGraceMs: 1_000,
      abortKillGraceMs: 1_000,
      signalKillGraceMs: 1_000,
      cleanupDrainTimeoutMs: 2_000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal,
      onReady(child) {
        // Drain but never retain or print registry/npm output or inherited config.
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("data", (chunk: Buffer) => {
            outputBytes += chunk.length;
            if (outputBytes > command.maxOutputBytes && !overflow.signal.aborted) {
              overflow.abort(new Error("npm runtime fetch output limit exceeded"));
            }
          });
        }
      },
    });
    command.signal?.throwIfAborted();
    overflow.signal.throwIfAborted();
    if (code !== 0) {
      throw new Error(`npm runtime fetch failed with exit ${code}`);
    }
  } catch (error) {
    // Cleanup uncertainty takes precedence over the earlier output/cancel cause.
    if (overflow.signal.aborted && !hasUnjoinedWork(error)) {
      throw new Error("npm runtime fetch output limit exceeded", { cause: error });
    }
    throw error;
  }
}

function selectedCache(packageDir: string) {
  const root = realpathSync(packageDir);
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (!usesNpmRuntimeDerivation(manifest)) {
    return undefined;
  }
  return {
    root,
    target: path.join(root, ".artifacts", "npm-runtime-derivation", NPM_RUNTIME_DERIVATION),
  };
}

function verifyCache(directory: string) {
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) {
    throw new Error("Invalid npm runtime cache directory");
  }
  const npmTarball = readArchive(path.join(directory, INPUTS[0]!.file));
  const undiciTarball = readArchive(path.join(directory, INPUTS[1]!.file));
  const tarball = readArchive(path.join(directory, DERIVED_FILE));
  const verified = verifyBundledNpmArtifact({ derivedTarball: tarball, npmTarball, undiciTarball });
  const provenanceFile = path.join(directory, "provenance.json");
  const provenanceStat = lstatSync(provenanceFile);
  if (
    !provenanceStat.isFile() ||
    provenanceStat.size === 0 ||
    provenanceStat.size > 2 * 1024 * 1024
  ) {
    throw new Error("Invalid bounded npm runtime provenance file");
  }
  const provenance: unknown = JSON.parse(readFileSync(provenanceFile, "utf8"));
  if (!isDeepStrictEqual(provenance, verified.provenance)) {
    throw new Error("npm runtime provenance differs from verified archives");
  }
  return { ...verified, tarball, npmTarball, undiciTarball };
}

/** Cache-only synchronous owner: lock generation/materialization never starts downloads. */
export function prepareNpmRuntimeArtifact(packageDir: string, _env?: NodeJS.ProcessEnv) {
  const selected = selectedCache(packageDir);
  if (!selected) {
    return undefined;
  }
  const { root, target } = selected;
  if (!entryExists(target)) {
    throw new Error(
      "npm runtime cache is missing; await ensureNpmRuntimeArtifact before synchronous packaging",
    );
  }
  const result = verifyCache(target);
  return {
    ...result,
    artifact: {
      name: "npm",
      version: "12.2.1",
      spec: `file:./${path.relative(root, path.join(target, DERIVED_FILE)).replaceAll(path.sep, "/")}`,
      integrity: result.integrity,
    },
  };
}

/** Publish only a verified immutable tuple after both managed fetches have joined. */
export async function ensureNpmRuntimeArtifact(
  packageDir: string,
  options: EnsureNpmRuntimeArtifactOptions = {},
) {
  options.signal?.throwIfAborted();
  const selected = selectedCache(packageDir);
  if (!selected) {
    return undefined;
  }
  if (entryExists(selected.target)) {
    return prepareNpmRuntimeArtifact(packageDir);
  }
  const artifacts = realDirectory(selected.root, ".artifacts");
  const parent = realDirectory(artifacts, "npm-runtime-derivation");
  const temporary = mkdtempSync(path.join(parent, ".prepare-"));
  let joined = true;
  try {
    const env = options.env ?? process.env;
    for (const { file, url } of INPUTS) {
      options.signal?.throwIfAborted();
      const invocation = resolveNpmRunner({
        npmArgs: [
          "pack",
          url,
          "--ignore-scripts",
          "--workspaces=false",
          "--pack-destination",
          temporary,
        ],
        env,
      });
      await runFetchCommand({
        command: invocation.command,
        args: invocation.args,
        cwd: temporary,
        env: {
          ...(invocation.env ?? env),
          npm_config_fetch_retries: "0",
          npm_config_fetch_timeout: "30000",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
        shell: invocation.shell,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
        signal: options.signal,
      });
      options.signal?.throwIfAborted();
      readArchive(path.join(temporary, file));
    }
    const derived = deriveBundledNpmArtifact({
      npmTarball: readArchive(path.join(temporary, INPUTS[0]!.file)),
      undiciTarball: readArchive(path.join(temporary, INPUTS[1]!.file)),
    });
    writeFileSync(path.join(temporary, DERIVED_FILE), derived.tarball, { flag: "wx" });
    writeFileSync(
      path.join(temporary, "provenance.json"),
      `${JSON.stringify(derived.provenance, null, 2)}\n`,
      { flag: "wx" },
    );
    verifyCache(temporary);
    options.signal?.throwIfAborted();
    // Another producer may have published this immutable tuple. Validate it,
    // never replace it with our temporary tree or remove its recovery evidence.
    if (!entryExists(selected.target)) {
      try {
        renameSync(temporary, selected.target);
      } catch (error) {
        if (!entryExists(selected.target)) {
          throw error;
        }
      }
    }
    return prepareNpmRuntimeArtifact(packageDir);
  } catch (error) {
    joined = !hasUnjoinedWork(error);
    throw error;
  } finally {
    if (joined) {
      rmSync(temporary, { force: true, recursive: true });
    }
  }
}

export function readNpmRuntimeFiles(root: string) {
  if (!lstatSync(root).isDirectory()) {
    throw new Error("npm runtime package root must be a real directory");
  }
  // A platform temp parent may be an alias (/var -> /private/var on macOS).
  // Reject a symlink package itself, then walk its canonical parent spelling.
  const canonicalRoot = realpathSync(root);
  const files: Array<{ path: string; mode: number; content: Buffer }> = [];
  let total = 0;
  let entries = 0;
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(canonicalRoot, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      entries += 1;
      if (entries > 8192 || name.length > 255) {
        throw new Error("npm runtime directory tree exceeded its bound");
      }
      if (entry.isDirectory()) {
        walk(name);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Non-regular npm runtime package entry: ${name}`);
      }
      const filename = path.join(canonicalRoot, name);
      const stat = lstatSync(filename);
      total += stat.size;
      if (files.length >= 4096 || stat.size > 8 * 1024 * 1024 || total > 32 * 1024 * 1024) {
        throw new Error("npm runtime file tree exceeded its bound");
      }
      files.push({ path: name, mode: stat.mode & 0o777, content: readFileSync(filename) });
    }
  };
  walk("");
  return files;
}

/** Called only under the existing canonical package lifecycle lock. */
export function prepareBundledNpmRuntime(
  packageDir: string,
  onCleanupFailure: (error: Error) => void = () => {},
) {
  const prepared = prepareNpmRuntimeArtifact(packageDir);
  if (!prepared) {
    return async () => {};
  }
  // Argument checks and non-derived packs also run from dependency-free harnesses.
  const { x: extractTar } = createRequire(import.meta.url)("tar") as typeof import("tar");
  const modules = realDirectory(realpathSync(packageDir), "node_modules");
  const installed = path.join(modules, "npm");
  const backup = path.join(modules, ".openclaw-npm-runtime-backup");
  if (entryExists(backup)) {
    throw new Error("npm runtime recovery backup already exists; refuse replacement");
  }
  const original = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  if (original.name !== "npm" || original.version !== "12.2.1") {
    throw new Error("npm runtime packing requires the frozen npm@12.2.1 installation");
  }
  const staging = mkdtempSync(path.join(modules, ".openclaw-npm-runtime-stage-"));
  let moved = false;
  let materialized = false;
  const restore = async () => {
    if (materialized) {
      verifyBundledNpmPackageFiles({ files: readNpmRuntimeFiles(installed) });
      rmSync(installed, { recursive: true });
      materialized = false;
    }
    if (moved) {
      renameSync(backup, installed);
      moved = false;
    }
    rmSync(staging, { recursive: true, force: true });
  };
  try {
    extractTar({ cwd: staging, strip: 1, sync: true, strict: true }).end(prepared.tarball);
    verifyBundledNpmPackageFiles({ files: readNpmRuntimeFiles(staging) });
    renameSync(installed, backup);
    moved = true;
    renameSync(staging, installed);
    materialized = true;
    return restore;
  } catch (error) {
    // Preserve the existing installation even if preparation failed partway through.
    try {
      if (!materialized && moved) {
        renameSync(backup, installed);
        moved = false;
      }
      rmSync(staging, { recursive: true, force: true });
    } catch (cleanupError) {
      const failure = new AggregateError(
        [error, cleanupError],
        "npm runtime preparation and recovery failed",
      );
      onCleanupFailure(failure);
      throw failure;
    }
    throw error;
  }
}

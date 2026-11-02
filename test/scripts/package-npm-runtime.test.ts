import { ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { c as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pure owner has separate fixed-official-input tests. These fixtures exercise
// actual filesystem staging/recovery without downloading packages or mutating a store.
const state = vi.hoisted(() => ({
  failStageMove: false,
  derivedTarball: undefined as Buffer | undefined,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync(source: string, target: string) {
      if (
        state.failStageMove &&
        source.includes(".openclaw-npm-runtime-stage-") &&
        target.endsWith("/npm")
      ) {
        state.failStageMove = false;
        throw new Error("synthetic stage move failure");
      }
      return fs.renameSync(source, target);
    },
  };
});
vi.mock("../../scripts/lib/package-bundled-npm.mts", () => ({
  NPM_BUNDLE_DERIVATION_ID: "npm-12.2.1-undici-6.29.1-v1",
  deriveBundledNpmArtifact: vi.fn(() => {
    if (!state.derivedTarball) {
      throw new Error("fixture must reuse verified cache");
    }
    return { tarball: state.derivedTarball, provenance: { synthetic: true } };
  }),
  verifyBundledNpmArtifact: vi.fn(() => ({
    integrity: "sha512-synthetic",
    provenance: { synthetic: true },
  })),
  verifyBundledNpmPackageFiles: vi.fn(
    ({ files }: { files: Array<{ path: string; content: Buffer }> }) => {
      if (
        files.length !== 2 ||
        !files.some((file) => file.path === "reviewed" && file.content.toString() === "derived")
      ) {
        throw new Error("synthetic tree drift");
      }
    },
  ),
}));
vi.mock("../../scripts/npm-runner.mts", () => ({
  resolveNpmRunner: vi.fn(({ npmArgs }: { npmArgs: string[] }) => ({
    command: "synthetic-npm-never-executed",
    args: npmArgs,
    shell: false,
  })),
}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(),
}));

import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { verifyBundledNpmArtifact } from "../../scripts/lib/package-bundled-npm.mts";
import {
  NPM_RUNTIME_DERIVATION,
  ensureNpmRuntimeArtifact,
  prepareBundledNpmRuntime,
  prepareNpmRuntimeArtifact,
  readNpmRuntimeFiles,
  usesNpmRuntimeDerivation,
} from "../../scripts/lib/package-npm-runtime.mts";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";

const roots: string[] = [];
beforeEach(() => {
  state.failStageMove = false;
  state.derivedTarball = undefined;
  vi.clearAllMocks();
  vi.mocked(runManagedCommand).mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "npm-runtime-lifecycle-")));
  roots.push(root);
  const manifest = {
    name: "synthetic-core",
    dependencies: { npm: "12.2.1" },
    bundleDependencies: ["npm"],
    openclawBundledNpmDerivation: NPM_RUNTIME_DERIVATION,
  };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  const modules = path.join(root, "node_modules");
  const original = path.join(root, "original-npm");
  mkdirSync(modules);
  mkdirSync(original);
  writeFileSync(
    path.join(original, "package.json"),
    JSON.stringify({ name: "npm", version: "12.2.1" }),
  );
  writeFileSync(path.join(original, "reviewed"), "original");
  symlinkSync("../original-npm", path.join(modules, "npm"), "junction");
  const packed = path.join(root, "source", "package");
  mkdirSync(packed, { recursive: true });
  writeFileSync(
    path.join(packed, "package.json"),
    JSON.stringify({ name: "npm", version: "12.2.1" }),
  );
  writeFileSync(path.join(packed, "reviewed"), "derived");
  const cache = path.join(root, ".artifacts/npm-runtime-derivation", NPM_RUNTIME_DERIVATION);
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "npm-12.2.1.tgz"), "official npm placeholder");
  writeFileSync(path.join(cache, "undici-6.29.1.tgz"), "official undici placeholder");
  writeFileSync(path.join(cache, "provenance.json"), JSON.stringify({ synthetic: true }));
  createTar(
    {
      cwd: path.dirname(packed),
      file: path.join(cache, "npm-derived.tgz"),
      sync: true,
      gzip: true,
    },
    ["package"],
  );
  return { root, modules, original, cache, manifest };
}

describe("exact npm runtime materialization lifecycle", () => {
  it.each(["missing", "changed-file", "symlink", "oversize"])(
    "rejects %s provenance before materialization or cache reuse",
    async (mutation) => {
      const { root, cache, modules, original } = fixture();
      const provenance = path.join(cache, "provenance.json");
      rmSync(provenance);
      if (mutation === "changed-file") {
        const expected = { files: [{ path: "index.js", mode: 0o644, sha256: "verified" }] };
        const verified = {
          integrity: "sha512-synthetic",
          provenance: expected,
        } as ReturnType<typeof verifyBundledNpmArtifact>;
        vi.mocked(verifyBundledNpmArtifact)
          .mockReturnValueOnce(verified)
          .mockReturnValueOnce(verified);
        writeFileSync(
          provenance,
          JSON.stringify({ files: [{ ...expected.files[0], sha256: "changed" }] }),
        );
      } else if (mutation === "symlink") {
        const outside = path.join(original, "provenance.json");
        writeFileSync(outside, JSON.stringify({ synthetic: true }));
        symlinkSync(outside, provenance);
      } else if (mutation === "oversize") {
        writeFileSync(provenance, Buffer.alloc(2 * 1024 * 1024 + 1));
      }
      expect(() => prepareBundledNpmRuntime(root)).toThrow();
      await expect(ensureNpmRuntimeArtifact(root)).rejects.toThrow();
      expect(runManagedCommand).not.toHaveBeenCalled();
      expect(readlinkSync(path.join(modules, "npm"))).toBe("../original-npm");
      expect(existsSync(path.join(modules, ".openclaw-npm-runtime-backup"))).toBe(false);
    },
  );
  it("keeps an unselected frozen manifest unchanged and rejects unknown tuples", () => {
    expect(usesNpmRuntimeDerivation({ dependencies: { npm: "12.1.0" } })).toBe(false);
    expect(() => usesNpmRuntimeDerivation({ openclawBundledNpmDerivation: "other" })).toThrow(
      "exact npm",
    );
    const { manifest } = fixture();
    expect(() => usesNpmRuntimeDerivation({ ...manifest, bundleDependencies: [] })).toThrow(
      "exact npm",
    );
  });
  it("restores the original symlink and package bytes after packing; cleanup is idempotent", async () => {
    const { root, modules, original } = fixture();
    const cleanup = prepareBundledNpmRuntime(root);
    expect(readFileSync(path.join(modules, "npm/reviewed"), "utf8")).toBe("derived");
    expect(readFileSync(path.join(original, "reviewed"), "utf8")).toBe("original");
    expect(() => prepareBundledNpmRuntime(root)).toThrow("backup already exists");
    await cleanup();
    await cleanup();
    expect(readlinkSync(path.join(modules, "npm"))).toBe("../original-npm");
    expect(readFileSync(path.join(modules, "npm/reviewed"), "utf8")).toBe("original");
    expect(existsSync(path.join(modules, ".openclaw-npm-runtime-backup"))).toBe(false);
  });
  it("restores the original after a partial materialization failure", () => {
    const { root, modules } = fixture();
    state.failStageMove = true;
    expect(() => prepareBundledNpmRuntime(root)).toThrow("stage move failure");
    expect(readlinkSync(path.join(modules, "npm"))).toBe("../original-npm");
    expect(readFileSync(path.join(modules, "npm/reviewed"), "utf8")).toBe("original");
  });
  it("preserves both trees when the staged runtime changes before recovery", async () => {
    const { root, modules } = fixture();
    const cleanup = prepareBundledNpmRuntime(root);
    writeFileSync(path.join(modules, "npm/reviewed"), "concurrent change");
    await expect(cleanup()).rejects.toThrow("tree drift");
    expect(readFileSync(path.join(modules, "npm/reviewed"), "utf8")).toBe("concurrent change");
    expect(readFileSync(path.join(modules, ".openclaw-npm-runtime-backup/reviewed"), "utf8")).toBe(
      "original",
    );
  });
  it("rejects a wrong installed npm before touching its source", () => {
    const { root, original, modules } = fixture();
    writeFileSync(
      path.join(original, "package.json"),
      JSON.stringify({ name: "npm", version: "12.1.0" }),
    );
    expect(() => prepareBundledNpmRuntime(root)).toThrow("frozen npm@12.2.1");
    expect(readlinkSync(path.join(modules, "npm"))).toBe("../original-npm");
  });
  it("refuses symlink caches and package trees", () => {
    const { root, cache, original, modules } = fixture();
    rmSync(cache, { recursive: true });
    symlinkSync(original, cache, "junction");
    expect(() => prepareNpmRuntimeArtifact(root)).toThrow("cache directory");
    expect(() => readNpmRuntimeFiles(path.join(modules, "npm"))).toThrow("real directory");
  });
});

// These mock only the existing managed process owner: they assert selection,
// publication and failure ordering, not a new claim of real child-tree teardown.
describe("asynchronous npm cache preparation", () => {
  function coldFixture() {
    const value = fixture();
    state.derivedTarball = readFileSync(path.join(value.cache, "npm-derived.tgz"));
    rmSync(value.cache, { recursive: true });
    return value;
  }
  function recordFetch(options: Parameters<typeof runManagedCommand>[0]) {
    expect(options.bin).toBe("synthetic-npm-never-executed");
    expect(options.requireProcessTreeExit).toBe(true);
    expect(options.timeoutForceKillOnLeaderExit).toBe(true);
    expect(options.timeoutMs).toBe(60_000);
    expect(options.timeoutKillGraceMs).toBe(1_000);
    expect(options.abortKillGraceMs).toBe(1_000);
    expect(options.signalKillGraceMs).toBe(1_000);
    expect(options.cleanupDrainTimeoutMs).toBe(2_000);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    const url = options.args?.[1];
    const filenames = new Map([
      ["https://registry.npmjs.org/npm/-/npm-12.2.1.tgz", "npm-12.2.1.tgz"],
      ["https://registry.npmjs.org/undici/-/undici-6.29.1.tgz", "undici-6.29.1.tgz"],
    ]);
    const filename = filenames.get(url ?? "");
    if (!filename || !options.cwd) {
      throw new Error("unexpected fixed fetch input");
    }
    expect(options.args).toEqual([
      "pack",
      url,
      "--ignore-scripts",
      "--workspaces=false",
      "--pack-destination",
      options.cwd,
    ]);
    writeFileSync(path.join(options.cwd, filename), "synthetic official input");
  }
  function privatePreparations(cache: string) {
    return readdirSync(path.dirname(cache)).filter((name) => name.startsWith(".prepare-"));
  }
  it("synchronous materialization and lock preparation never download on a missing cache", () => {
    const { root, modules } = coldFixture();
    expect(() => prepareNpmRuntimeArtifact(root)).toThrow("await ensureNpmRuntimeArtifact");
    expect(() => prepareBundledNpmRuntime(root)).toThrow("await ensureNpmRuntimeArtifact");
    expect(resolveNpmRunner).not.toHaveBeenCalled();
    expect(runManagedCommand).not.toHaveBeenCalled();
    expect(readlinkSync(path.join(modules, "npm"))).toBe("../original-npm");
  });
  it("valid cache reuse does not launch a command", async () => {
    const { root } = fixture();
    expect(await ensureNpmRuntimeArtifact(root)).toMatchObject({ artifact: { name: "npm" } });
    expect(resolveNpmRunner).not.toHaveBeenCalled();
    expect(runManagedCommand).not.toHaveBeenCalled();
  });
  it("awaits both managed commands before verifying and publishing, preserving the original tree", async () => {
    const { root, cache, modules } = coldFixture();
    const urls: string[] = [];
    vi.mocked(runManagedCommand).mockImplementation(async (options) => {
      expect(existsSync(cache)).toBe(false);
      expect(verifyBundledNpmArtifact).not.toHaveBeenCalled();
      recordFetch(options);
      urls.push(options.args![1]!);
      return 0;
    });
    const result = await ensureNpmRuntimeArtifact(root);
    expect(urls).toEqual([
      "https://registry.npmjs.org/npm/-/npm-12.2.1.tgz",
      "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz",
    ]);
    expect(result?.artifact.integrity).toBe("sha512-synthetic");
    expect(privatePreparations(cache)).toEqual([]);
    expect(readlinkSync(path.join(modules, "npm"))).toBe("../original-npm");
  });
  it("pre-cancellation launches nothing", async () => {
    const { root, cache } = coldFixture();
    const controller = new AbortController();
    controller.abort(new Error("cancel before preparation"));
    await expect(ensureNpmRuntimeArtifact(root, { signal: controller.signal })).rejects.toThrow(
      "cancel before preparation",
    );
    expect(resolveNpmRunner).not.toHaveBeenCalled();
    expect(runManagedCommand).not.toHaveBeenCalled();
    expect(existsSync(cache)).toBe(false);
    expect(privatePreparations(cache)).toEqual([]);
  });
  it("cancellation observed when the first managed command joins prevents the second fetch and publication", async () => {
    const { root, cache, modules } = coldFixture();
    const controller = new AbortController();
    vi.mocked(runManagedCommand).mockImplementation(async (options) => {
      recordFetch(options);
      controller.abort(new Error("cancel after joined fetch"));
      return 0;
    });
    await expect(ensureNpmRuntimeArtifact(root, { signal: controller.signal })).rejects.toThrow(
      "cancel after joined fetch",
    );
    expect(runManagedCommand).toHaveBeenCalledOnce();
    expect(existsSync(cache)).toBe(false);
    expect(privatePreparations(cache)).toEqual([]);
    expect(readlinkSync(path.join(modules, "npm"))).toBe("../original-npm");
  });
  it.each([143, 7])(
    "refuses managed signal/failure exit %i without publishing a cache",
    async (code) => {
      const { root, cache } = coldFixture();
      vi.mocked(runManagedCommand).mockResolvedValue(code);
      await expect(ensureNpmRuntimeArtifact(root)).rejects.toThrow(
        `fetch failed with exit ${code}`,
      );
      expect(runManagedCommand).toHaveBeenCalledOnce();
      expect(existsSync(cache)).toBe(false);
      expect(privatePreparations(cache)).toEqual([]);
    },
  );
  it("joins an output-limit cancellation before removing the private directory", async () => {
    const { root, cache } = coldFixture();
    let rejectAfterJoin: (reason: Error) => void = () => {
      throw new Error("managed command not ready");
    };
    let directory = "";
    vi.mocked(runManagedCommand).mockImplementation((options) => {
      directory = options.cwd!;
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      options.onReady?.(child);
      child.stdout.emit("data", Buffer.alloc(600 * 1024));
      child.stderr.emit("data", Buffer.alloc(600 * 1024));
      expect(options.signal?.aborted).toBe(true);
      child.stdout.destroy();
      child.stderr.destroy();
      return new Promise<number>((_resolve, reject) => {
        rejectAfterJoin = reject;
      });
    });
    const preparing = ensureNpmRuntimeArtifact(root);
    const rejected = expect(preparing).rejects.toThrow("fetch output limit exceeded");
    expect(existsSync(directory)).toBe(true);
    expect(existsSync(cache)).toBe(false);
    rejectAfterJoin(new Error("managed abort joined"));
    await rejected;
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(cache)).toBe(false);
  });
  it("retains the real timeout failure and does not publish after the owner joins", async () => {
    const { root, cache } = coldFixture();
    const failure = Object.assign(new Error("Managed command timed out after 60000ms"), {
      code: "ETIMEDOUT",
    });
    vi.mocked(runManagedCommand).mockRejectedValue(failure);
    await expect(ensureNpmRuntimeArtifact(root)).rejects.toBe(failure);
    expect(existsSync(cache)).toBe(false);
    expect(privatePreparations(cache)).toEqual([]);
  });
  it("preserves private inputs when the existing owner cannot prove tree teardown", async () => {
    const { root, cache } = coldFixture();
    const failure = Object.assign(new Error("managed tree not joined"), {
      processTreeState: "indeterminate",
    });
    vi.mocked(runManagedCommand).mockRejectedValue(failure);
    await expect(ensureNpmRuntimeArtifact(root)).rejects.toBe(failure);
    expect(existsSync(cache)).toBe(false);
    expect(privatePreparations(cache)).toHaveLength(1);
  });
  it("failed second fetch and invalid official inputs never publish", async () => {
    const { root, cache } = coldFixture();
    vi.mocked(runManagedCommand)
      .mockImplementationOnce(async (options) => {
        recordFetch(options);
        return 0;
      })
      .mockRejectedValueOnce(new Error("second fetch failed"));
    await expect(ensureNpmRuntimeArtifact(root)).rejects.toThrow("second fetch failed");
    expect(privatePreparations(cache)).toEqual([]);
    vi.mocked(runManagedCommand).mockImplementation(async (options) => {
      recordFetch(options);
      return 0;
    });
    vi.mocked(verifyBundledNpmArtifact).mockImplementationOnce(() => {
      throw new Error("wrong official SRI");
    });
    await expect(ensureNpmRuntimeArtifact(root)).rejects.toThrow("wrong official SRI");
    expect(existsSync(cache)).toBe(false);
    expect(privatePreparations(cache)).toEqual([]);
  });
});

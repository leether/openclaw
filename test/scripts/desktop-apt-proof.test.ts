import { describe, expect, it } from "vitest";
import { desktopAptProof } from "../../scripts/lib/desktop-apt-proof.mts";

describe("public desktop APT diagnostics", () => {
  it("retains observed stages without copying repository URLs, paths, or arbitrary output", () => {
    const log = Buffer.from(
      [
        "Reading package lists...",
        "Get:1 https://user:secret@private.invalid/repo fixture 1.2 [1 kB]",
        "Preparing to unpack /private/fixture/package.deb ...",
        "Unpacking fixture ...",
        "Setting up fixture ...",
        "Processing triggers for fixture ...",
        "Authorization: Bearer private-token",
        "\u001b[31mprivate-ansi-secret\u001b[0m",
        "Waiting for cache lock: /private/fixture/lock",
      ].join("\n"),
    );
    const proof = desktopAptProof("apt-install", log, log.length);
    expect(proof.recentStages.map((entry) => entry.stage)).toEqual([
      "package-lists",
      "download",
      "prepare-unpack",
      "unpack",
      "configure",
      "triggers",
      "lock-wait",
    ]);
    expect(proof).toMatchObject({
      unknownLines: 2,
      lastObservedStage: "lock-wait",
      omittedInputBytes: 0,
    });
    expect(proof.unknownSha256).toMatch(/^[a-f0-9]{64}$/u);
    const published = JSON.stringify(proof);
    for (const forbidden of [
      "secret",
      "private",
      "fixture",
      "Authorization",
      "https://",
      "\u001b",
    ]) {
      expect(published).not.toContain(forbidden);
    }
    expect(proof.interpretation).toContain("not a root-cause finding");
  });

  it("keeps only the last 32 fixed stage labels and reports input and stage omissions", () => {
    const log = Buffer.from(`${"Get:1 untrusted-location\n".repeat(60)}E: failed\n`);
    const proof = desktopAptProof("apt-update", log, log.length + 100);
    expect(proof).toMatchObject({
      lines: 61,
      counts: { download: 60, "package-error": 1 },
      omittedStages: 29,
      omittedInputBytes: 100,
      lastObservedStage: "package-error",
    });
    expect(proof.recentStages).toHaveLength(32);
    expect(proof.recentStages[0]).toEqual({ line: 30, stage: "download" });
    expect(Buffer.byteLength(JSON.stringify(proof, null, 2))).toBeLessThanOrEqual(16 * 1024);
  });

  it("hashes oversized and unknown records within the existing 8 MiB capture budget", () => {
    const log = Buffer.alloc(8 * 1024 ** 2, 120);
    const proof = desktopAptProof("apt-install", log, log.length);
    expect(proof).toMatchObject({
      lines: 1,
      unknownLines: 1,
      oversizedLines: 1,
      recentStages: [],
      lastObservedStage: null,
    });
    const changed = Buffer.from(log);
    changed[0] = 121;
    expect(desktopAptProof("apt-install", changed, changed.length).unknownSha256).not.toBe(
      proof.unknownSha256,
    );
    expect(() => desktopAptProof("apt-install", log, log.length - 1)).toThrow();
    expect(() =>
      desktopAptProof("apt-install", Buffer.alloc(log.length + 1), log.length + 1),
    ).toThrow();
  });
});

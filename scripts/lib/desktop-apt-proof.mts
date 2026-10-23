import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const stages = [
  ["package-lists", /^Reading package lists/u],
  ["dependency-tree", /^Building dependency tree/u],
  ["state-information", /^Reading state information/u],
  ["download", /^Get:\d+\s/u],
  ["cached-index", /^Hit:\d+\s/u],
  ["ignored-fetch", /^Ign:\d+\s/u],
  ["fetch-error", /^Err:\d+\s/u],
  ["fetch-complete", /^Fetched \d/u],
  ["select-package", /^Selecting previously unselected package /u],
  ["prepare-unpack", /^Preparing to unpack /u],
  ["unpack", /^Unpacking /u],
  ["configure", /^Setting up /u],
  ["triggers", /^Processing triggers for /u],
  ["lock-wait", /^(?:Waiting for cache lock:|E: Could not get lock )/u],
  [
    "network-error",
    /(?:Temporary failure resolving|Could not resolve|Connection timed out|Could not connect to)/u,
  ],
  ["package-error", /^(?:E: |dpkg: error)/u],
] as const;
type Stage = (typeof stages)[number][0];

/** Only fixed labels, counts, and hashes leave the private APT log. */
export function desktopAptProof(
  label: "apt-update" | "apt-install",
  log: Buffer,
  observedBytes: number,
) {
  assert(label === "apt-update" || label === "apt-install");
  assert(log.length <= 8 * 1024 ** 2, "Desktop APT input exceeds the existing log budget");
  assert(Number.isSafeInteger(observedBytes) && observedBytes >= log.length);
  const counts = new Map<Stage, number>();
  const recentStages: Array<{ line: number; stage: Stage }> = [];
  const unknownHash = createHash("sha256");
  let lines = 0;
  let unknownLines = 0;
  let oversizedLines = 0;
  let omittedStages = 0;
  for (let start = 0; start < log.length;) {
    const newline = log.indexOf(10, start);
    const end = newline < 0 ? log.length : newline + 1;
    const line = log.subarray(start, end);
    start = end;
    lines += 1;
    // Large records are counted and hashed, never decoded or published.
    const oversized = line.length > 4096;
    const text = oversized ? "" : line.toString("utf8").trim();
    const stage = oversized ? undefined : stages.find(([, pattern]) => pattern.test(text))?.[0];
    if (stage) {
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
      recentStages.push({ line: lines, stage });
      if (recentStages.length > 32) {
        recentStages.shift();
        omittedStages += 1;
      }
    } else {
      unknownLines += 1;
      oversizedLines += Number(oversized);
      unknownHash.update(String(line.length)).update(":").update(line);
    }
  }
  const result = {
    version: 1,
    label,
    interpretation:
      "Observed output labels in arrival order; the last label is not a root-cause finding",
    capturedBytes: log.length,
    observedBytes,
    omittedInputBytes: observedBytes - log.length,
    lines,
    unknownLines,
    oversizedLines,
    unknownSha256: unknownHash.digest("hex"),
    counts: Object.fromEntries(counts),
    recentStages,
    omittedStages,
    lastObservedStage: recentStages.at(-1)?.stage ?? null,
  };
  assert(Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 <= 16 * 1024);
  return result;
}

import { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBounded } from "../../scripts/fork-linux/msal/processes.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

const scenario = "azure-certificate";
const digest = createHash("sha256").update("synthetic-private-message").digest("hex");
const diagnostic = {
  schema: "msal-consumer-scenario-v1",
  passed: false,
  scenario,
  failure: { name: "AssertionError", messageSha256: digest },
};
const children: ChildProcess[] = [];
beforeEach(() => vi.mocked(spawn).mockReset());
afterEach(() => {
  for (const child of children.splice(0)) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.emit("close", null, "SIGKILL");
  }
});

function start(options: { maxBytes?: number } = {}) {
  const child = Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  children.push(child);
  vi.mocked(spawn).mockReturnValueOnce(child);
  const result = runBounded(["scenario.mjs", "/synthetic", scenario], "/synthetic", options);
  return {
    child,
    result,
    close(exitCode: number | null = 1, signal: NodeJS.Signals | null = null) {
      children.splice(children.indexOf(child), 1);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode, signal);
    },
  };
}

describe("MSAL bounded failure diagnostics", () => {
  it("retains only the fixed failure fields after nonzero exit and keeps the proof failed", async () => {
    const fixture = start();
    fixture.child.stdout.write(
      JSON.stringify({
        ...diagnostic,
        message: "synthetic-private-message",
        token: "synthetic-private-token",
        cases: [{ details: "synthetic-private-context" }],
        failure: { ...diagnostic.failure, message: "synthetic-private-message" },
      }),
    );
    fixture.close();
    const result = await fixture.result;
    expect(result).toMatchObject({
      passed: false,
      exitCode: 1,
      signal: null,
      failure: null,
      closed: true,
      proof: null,
      failureDiagnostic: diagnostic,
    });
    expect(result.failureDiagnostic).toEqual(diagnostic);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|token|details|cases/u);
  });

  it("normalizes arbitrary error names to other", async () => {
    const fixture = start();
    fixture.child.stdout.write(
      JSON.stringify({
        ...diagnostic,
        failure: { ...diagnostic.failure, name: "synthetic-private-error-name" },
      }),
    );
    fixture.close();
    const result = await fixture.result;
    expect(result.passed).toBe(false);
    expect(result.failureDiagnostic).toEqual({
      ...diagnostic,
      failure: { ...diagnostic.failure, name: "other" },
    });
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["unknown schema", JSON.stringify({ ...diagnostic, schema: "private-schema" })],
    ["success claim", JSON.stringify({ ...diagnostic, passed: true })],
    ["different known scenario", JSON.stringify({ ...diagnostic, scenario: "azure-secret" })],
    ["unknown scenario", JSON.stringify({ ...diagnostic, scenario: "private-scenario" })],
    ["missing failure", JSON.stringify({ ...diagnostic, failure: null })],
    ["missing name", JSON.stringify({ ...diagnostic, failure: { messageSha256: digest } })],
    [
      "short hash",
      JSON.stringify({ ...diagnostic, failure: { name: "Error", messageSha256: "a".repeat(63) } }),
    ],
    [
      "nonhex hash",
      JSON.stringify({ ...diagnostic, failure: { name: "Error", messageSha256: "z".repeat(64) } }),
    ],
    [
      "hash with trailing newline",
      JSON.stringify({ ...diagnostic, failure: { name: "Error", messageSha256: `${digest}\n` } }),
    ],
    ["multiple documents", `${JSON.stringify(diagnostic)}\n${JSON.stringify(diagnostic)}`],
  ])("does not publish %s as a qualified failure diagnostic", async (_name, output) => {
    const fixture = start();
    fixture.child.stdout.write(output);
    fixture.close();
    expect(await fixture.result).toMatchObject({
      passed: false,
      exitCode: 1,
      proof: null,
      failureDiagnostic: null,
    });
  });

  it.each([
    [null, "SIGKILL"],
    [2, null],
  ] as const)("does not qualify other exit/signal outcomes (%s, %s)", async (code, signal) => {
    const fixture = start();
    fixture.child.stdout.write(JSON.stringify(diagnostic));
    fixture.close(code, signal);
    expect(await fixture.result).toMatchObject({
      passed: false,
      proof: null,
      failureDiagnostic: null,
    });
  });

  it("does not lend valid JSON to an output-limit failure", async () => {
    const fixture = start({ maxBytes: 256 });
    fixture.child.stdout.write(JSON.stringify(diagnostic));
    fixture.child.stderr.write("x".repeat(256));
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGKILL");
    fixture.close();
    expect(await fixture.result).toMatchObject({
      passed: false,
      failure: "output-limit",
      proof: null,
      failureDiagnostic: null,
    });
  });

  it("does not lend valid JSON to a spawn-error failure", async () => {
    const fixture = start();
    fixture.child.stdout.write(JSON.stringify(diagnostic));
    fixture.child.emit("error", new Error("synthetic-private-spawn-error"));
    fixture.close();
    expect(await fixture.result).toMatchObject({
      passed: false,
      failure: "spawn-error",
      proof: null,
      failureDiagnostic: null,
    });
  });

  it("preserves successful JSON and invalid-JSON outcomes", async () => {
    const success = start();
    success.child.stdout.write(JSON.stringify({ passed: true, scenario }));
    success.close(0);
    expect(await success.result).toMatchObject({
      passed: true,
      proof: { passed: true, scenario },
      failureDiagnostic: null,
    });
    const invalid = start();
    invalid.child.stdout.write("not-json");
    invalid.close(0);
    expect(await invalid.result).toMatchObject({
      passed: false,
      failure: "invalid-json",
      proof: null,
      failureDiagnostic: null,
    });
  });
});

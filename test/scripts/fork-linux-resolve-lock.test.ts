import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const entry = resolve("scripts/fork-linux/resolve-lock.py");
function check(before: object, after: object, changed: string[], staged: string[] = []) {
  const payload = JSON.stringify({ before, after, changed, staged });
  return spawnSync(
    "python3",
    [
      "-c",
      `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('lock_proof',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value=json.loads(sys.argv[2])
module.assert_lock_only(value['before'],value['after'],value['changed'],value['staged'])`,
      entry,
      payload,
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
  );
}

describe("fork lock candidate boundary", () => {
  const original = {
    "package.json": "manifest",
    "pnpm-lock.yaml": "old",
    "patches/one.patch": "patch",
  };
  it("accepts only a newly resolved lock, with unchanged tracked inputs", () => {
    expect(
      check(original, { ...original, "pnpm-lock.yaml": "new" }, ["pnpm-lock.yaml"]).status,
    ).toBe(0);
  });
  it.each(["package.json", "patches/one.patch"])("rejects changed resolver input %s", (name) => {
    expect(check(original, { ...original, [name]: "changed" }, [name]).status).not.toBe(0);
  });
  it("rejects an added input or changed non-input source", () => {
    expect(
      check(original, { ...original, "extensions/new/package.json": "new" }, []).status,
    ).not.toBe(0);
    expect(check(original, original, ["src/owner.ts"]).status).not.toBe(0);
  });
  it("rejects a staged lock even when only the permitted path changed", () => {
    expect(check(original, original, ["pnpm-lock.yaml"], ["pnpm-lock.yaml"]).status).not.toBe(0);
  });
  it.each(["removed", "empty", "active", "process-left", "different-epoch", "different-group"])(
    "validates the kernel scope completion: %s",
    (mode) => {
      const before = { cgroup: "/scope", dev: 1, inode: 2 };
      const state = {
        LoadState: mode === "removed" ? "not-found" : "loaded",
        ActiveState: mode === "active" ? "active" : "inactive",
        SubState: mode === "active" ? "running" : "dead",
        ControlGroup: mode === "different-group" ? "/other" : "/scope",
      };
      const payload = JSON.stringify({
        before,
        state,
        remaining: mode === "process-left" ? [123] : [],
        identity: mode === "removed" ? null : { dev: 1, inode: mode === "different-epoch" ? 3 : 2 },
      });
      const result = spawnSync(
        "python3",
        [
          "-c",
          `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('lock_proof',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
p=json.loads(sys.argv[2])
module.assert_scope_finished(p['before'],p['state'],p['remaining'],p['identity'])`,
          entry,
          payload,
        ],
        { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
      );
      if (mode === "removed" || mode === "empty") {
        expect(result.status).toBe(0);
      } else {
        expect(result.status).not.toBe(0);
      }
    },
  );
  it("keeps manual lock resolution separate from default qualification", () => {
    const workflow = YAML.parse(readFileSync(".github/workflows/fork-linux-package.yml", "utf8"));
    expect(workflow.on.workflow_dispatch.inputs.mode).toMatchObject({
      type: "choice",
      options: ["qualify", "resolve-lock"],
      default: "qualify",
    });
    expect(workflow.jobs.qualify.if).toContain("inputs.mode != 'resolve-lock'");
    expect(workflow.jobs["resolve-lock"].if).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow.jobs["resolve-lock"].if).toContain("inputs.mode == 'resolve-lock'");
    const commands = workflow.jobs["resolve-lock"].steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(commands).toContain("--property=MemoryMax=4G --property=MemorySwapMax=0");
    expect(commands).toContain("--property=TasksMax=256 --property=OOMPolicy=kill");
    expect(commands).toContain("--property=RuntimeMaxSec=600");
    expect(commands).not.toMatch(/git (?:commit|push)|qualify-package\.sh/);
    expect(
      workflow.jobs.qualify.steps.some(
        (step: { name?: string }) => step.name === "Preserve bounded synthetic diagnostics",
      ),
    ).toBe(true);
    expect(
      workflow.jobs["resolve-lock"].steps.some(
        (step: { name?: string }) => step.name === "Preserve bounded synthetic diagnostics",
      ),
    ).toBe(false);
  });

  it("publishes only the four private-verifier inputs and preserves the remaining evidence", () => {
    const workflow = YAML.parse(readFileSync(".github/workflows/fork-linux-package.yml", "utf8"));
    type Upload = { name: string; if: string; with: { path: string; "retention-days": number } };
    const steps: Upload[] = workflow.jobs.qualify.steps;
    const qualified = steps.find(
      (step) => step.name === "Upload qualified package and offline runtime",
    );
    const diagnostics = steps.find(
      (step) => step.name === "Preserve bounded synthetic diagnostics",
    );
    expect(qualified).toBeDefined();
    expect(diagnostics).toBeDefined();
    const root = "${{ env.FORK_ARTIFACT_DIR }}";
    const inputs = [
      "qualification.json",
      "openclaw-linux-x64-runtime.tar.gz",
      "node-verification/node-v24.22.0-linux-x64.tar.xz",
      "node-verification/node-v24.22.1-linux-x64.tar.xz",
    ].map((file) => `${root}/${file}`);
    expect(qualified?.if).toBe("success()");
    expect(qualified?.with.path.trim().split("\n")).toEqual(inputs);
    expect(qualified?.with["retention-days"]).toBe(90);
    const preserved = diagnostics?.with.path.trim().split("\n") ?? [];
    expect(diagnostics?.if).toBe("always()");
    expect(diagnostics?.with["retention-days"]).toBe(90);
    expect(preserved).toContain(root);
    // All non-input evidence, including browser state and SHA256SUMS, stays in
    // the diagnostic artifact. The checksum inventory spans both artifacts.
    expect(preserved.filter((pattern) => pattern.startsWith("!"))).toEqual(
      inputs.map((file) => `!${file}`),
    );
  });
});

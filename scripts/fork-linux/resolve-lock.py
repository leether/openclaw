#!/usr/bin/env python3
"""Export a normally resolved lock candidate; never install, commit, or qualify it."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import selectors
import re
import subprocess
import sys
import time

OUTPUT_LIMIT = 2 * 1024**2


def scope_state(unit):
    assert re.fullmatch(r"fork-lock-[0-9]+-[0-9]+\.scope", unit)
    result = subprocess.run(["systemctl", "--user", "show", unit, "--property=LoadState,ActiveState,SubState,ControlGroup,MemoryMax,MemorySwapMax,TasksMax"],
                            capture_output=True, text=True, timeout=5)
    assert len(result.stdout) + len(result.stderr) <= 32768
    state = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    assert result.returncode == 0 or (result.returncode == 4 and state.get("LoadState") == "not-found")
    return state


def current_scope():
    unit = os.environ["FORK_LOCK_UNIT"]
    state = scope_state(unit)
    assert state["LoadState"] == "loaded" and state["ActiveState"] == "active"
    group = state["ControlGroup"]
    assert group.endswith("/" + unit)
    assert Path("/proc/self/cgroup").read_text().strip() == "0::" + group
    directory = Path("/sys/fs/cgroup") / group.lstrip("/")
    assert directory.resolve() == directory
    stat = directory.stat()
    limits = {name: (directory / name).read_text().strip() for name in ("memory.max", "memory.swap.max", "pids.max")}
    assert limits == {"memory.max": str(4 * 1024**3), "memory.swap.max": "0", "pids.max": "256"}
    return {"unit": unit, "cgroup": group, "dev": stat.st_dev, "inode": stat.st_ino, "limits": limits}


def assert_scope_finished(before, state, remaining, identity):
    assert state.get("LoadState") in ("loaded", "not-found")
    assert state.get("ActiveState") in ("inactive", "failed")
    assert state.get("SubState") in ("dead", "failed")
    assert remaining == []
    if identity is not None:
        assert identity == {"dev": before["dev"], "inode": before["inode"]}
    if state["LoadState"] == "loaded":
        assert state.get("ControlGroup") in ("", before["cgroup"])


def git(*args):
    return subprocess.check_output(["git", *args], timeout=10).decode().strip()


def digest(file):
    value = Path(file)
    assert value.is_file() and not value.is_symlink(), file
    assert value.stat().st_size <= 32 * 1024**2, file
    data = value.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def input_snapshot():
    paths = git("ls-files", "-z").split("\0")
    selected = [name for name in paths if name and (
        Path(name).name == "package.json" or name.startswith("patches/") or
        name in ("pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs")
    )]
    result = {name: digest(name) for name in sorted(selected)}
    assert sum(item["bytes"] for item in result.values()) <= 128 * 1024**2
    return result


def assert_lock_only(before, after, changed, staged=()):
    assert set(before) == set(after), "Resolver changed the input path set"
    assert all(before[key] == after[key] for key in before if key != "pnpm-lock.yaml"), \
        "Resolver changed a manifest, configuration, or patch"
    assert set(changed) <= {"pnpm-lock.yaml"}, "Resolver changed a non-lock tracked file"
    assert not staged, "Resolver changed the index"


def main():
    root = Path.cwd()
    out = Path(os.environ["FORK_ARTIFACT_DIR"])
    expected = os.environ["QUALIFIED_SHA"]
    assert sys.platform == "linux"
    assert git("rev-parse", "HEAD") == expected
    assert not git("status", "--porcelain", "--untracked-files=no"), "Checkout must start clean"
    assert subprocess.check_output(["node", "--version"], timeout=10).decode().strip() == "v24.22.1"
    assert subprocess.check_output(["pnpm", "--version"], timeout=10).decode().strip() == "12.5.1"
    temp = Path(os.environ["RUNNER_TEMP"]) / "fork-lock-resolver"
    temp.mkdir()
    out.mkdir(parents=True, exist_ok=True)
    scope = current_scope()
    (out / "scope-before.json").write_text(json.dumps(scope, indent=2) + "\n")
    before = input_snapshot()
    (out / "inputs-before.json").write_text(json.dumps(before, indent=2) + "\n")
    command = ["pnpm", "install", "--lockfile-only", "--no-frozen-lockfile", "--ignore-scripts",
               "--store-dir", str(temp / "store"), "--state-dir", str(temp / "state"),
               "--fetch-timeout=10000", "--network-concurrency=4", "--reporter=append-only"]
    env = {**os.environ, "XDG_CACHE_HOME": str(temp / "cache"), "NODE_OPTIONS": "--max-old-space-size=3072"}
    log = out / "resolver.log"
    started = time.monotonic()
    failure = None
    child = None

    def stop():
        if child is None:
            return
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        # The leader returning does not prove its process group has settled.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)

    def interrupted(signum, _frame):
        raise RuntimeError(f"Resolver interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        with log.open("xb") as stream:
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     env=env, start_new_session=True)
            written = 0
            with selectors.DefaultSelector() as poller:
                poller.register(child.stdout, selectors.EVENT_READ)
                while poller.get_map() or child.poll() is None:
                    if time.monotonic() - started >= 570:
                        raise RuntimeError("Resolver wall budget exceeded")
                    if shutil.disk_usage(root).free < 6 * 1024**3:
                        raise RuntimeError("Resolver disk floor reached")
                    for key, _ in poller.select(0.1):
                        data = os.read(key.fd, 65536)
                        if not data:
                            poller.unregister(key.fileobj)
                            continue
                        stream.write(data[:OUTPUT_LIMIT - written])
                        written += len(data)
                        if written > OUTPUT_LIMIT:
                            raise RuntimeError("Resolver output budget exceeded; log truncated")
            child.wait(timeout=5)
            if child.returncode != 0:
                raise RuntimeError(f"pnpm resolver exited {child.returncode}")
    except Exception as error:
        failure = str(error)[:2000]
    finally:
        stop()
        if child is not None:
            child.stdout.close()
    directory = Path("/sys/fs/cgroup") / scope["cgroup"].lstrip("/")
    deadline = time.monotonic() + 2
    while True:
        remaining = [int(value) for value in (directory / "cgroup.procs").read_text().split()]
        if remaining == [os.getpid()]:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Resolver cgroup retains another process after cleanup")
        time.sleep(0.02)
    after = input_snapshot()
    (out / "inputs-after.json").write_text(json.dumps(after, indent=2) + "\n")
    changed = git("diff", "HEAD", "--name-only", "-z").split("\0")
    changed = [name for name in changed if name]
    try:
        assert_lock_only(before, after, changed, git("diff", "--cached", "--name-only").splitlines())
        assert git("rev-parse", "HEAD") == expected
        assert log.stat().st_size <= OUTPUT_LIMIT
    except AssertionError as error:
        failure = failure or str(error)
    # Preserve failed output too, explicitly unqualified. No tool commits it.
    shutil.copyfile("pnpm-lock.yaml", out / "candidate-pnpm-lock.yaml")
    report = {
        "schema": "fork-lock-candidate-v1", "passed": failure is None,
        "qualificationPassed": False, "failure": failure,
        "source": {"commit": expected, "tree": git("rev-parse", "HEAD^{tree}")},
        "node": "24.22.1", "pnpm": "12.5.1", "argv": command,
        "exitCode": child.returncode if child is not None else None,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "changedTrackedPaths": changed, "inputsBefore": digest(out / "inputs-before.json"),
        "inputsAfter": digest(out / "inputs-after.json"), "log": digest(log),
        "candidate": digest(out / "candidate-pnpm-lock.yaml"),
        "scope": scope, "onlyResolverRemainedBeforeExit": True,
        "limits": {"memoryBytes": 4 * 1024**3, "swapBytes": 0, "pids": 256,
                   "scopeSeconds": 600, "resolverSeconds": 570, "outputBytes": OUTPUT_LIMIT},
        "nextGate": "Review dependency diff, then commit the accepted lock and run frozen installation and full qualification",
    }
    (out / "resolver-result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "exitCode": report["exitCode"], "failure": failure}))
    return 0 if report["passed"] else 1


def finalize(unit, exit_code):
    out = Path(os.environ["FORK_ARTIFACT_DIR"])
    out.mkdir(parents=True, exist_ok=True)
    failure = None
    final = {}
    try:
        before = json.loads((out / "scope-before.json").read_text())
        assert before["unit"] == unit
        state = scope_state(unit)
        directory = Path("/sys/fs/cgroup") / before["cgroup"].lstrip("/")
        identity = None
        remaining = []
        if directory.exists():
            assert directory.resolve() == directory
            stat = directory.stat()
            identity = {"dev": stat.st_dev, "inode": stat.st_ino}
            remaining = [int(value) for value in (directory / "cgroup.procs").read_text().split()]
        assert_scope_finished(before, state, remaining, identity)
        final = {"passed": True, "unit": unit, "state": state, "cgroupRemoved": identity is None,
                 "remainingPids": remaining, "identity": identity}
    except Exception as error:
        failure = str(error)[:2000]
        final = {"passed": False, "unit": unit, "failure": failure}
    (out / "scope-final.json").write_text(json.dumps(final, indent=2) + "\n")
    raw = out / "resolver-result.json"
    report = json.loads(raw.read_text()) if raw.exists() else {
        "schema": "fork-lock-candidate-v1", "passed": False,
        "failure": "Resolver did not publish a completion receipt", "qualificationPassed": False,
    }
    report["scopeExitCode"] = exit_code
    report["scopeFinal"] = digest(out / "scope-final.json")
    report["scopeFinalPassed"] = final["passed"]
    report["passed"] = report["passed"] and final["passed"] and exit_code == 0
    report["failure"] = report.get("failure") or failure
    (out / "resolution.json").write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        code = finalize(sys.argv[2], int(sys.argv[3])) if sys.argv[1:2] == ["--finalize"] else main()
    except Exception as error:
        out = Path(os.environ["FORK_ARTIFACT_DIR"])
        out.mkdir(parents=True, exist_ok=True)
        name = "resolution.json" if sys.argv[1:2] == ["--finalize"] else "resolver-result.json"
        (out / name).write_text(json.dumps({"schema": "fork-lock-candidate-v1", "passed": False,
            "qualificationPassed": False, "failure": str(error)[:2000]}, indent=2) + "\n")
        code = 1
    sys.exit(code)

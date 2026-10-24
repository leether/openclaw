#!/usr/bin/env python3
"""Retain bounded cgroup observations from outside the qualification scope."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time

unit, output = sys.argv[1:]
if not re.fullmatch(r"fork-linux-[0-9]+-[0-9]+\.scope", unit):
    raise SystemExit("invalid qualification scope")
destination = Path(output)
destination.parent.mkdir(parents=True, exist_ok=True)
stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())
report = {"schemaVersion": 1, "unit": unit, "observations": 0, "unavailable": 0}
deadline = time.monotonic() + 6650
while time.monotonic() < deadline:
    try:
        state = subprocess.run(
            ["systemctl", "--user", "show", unit, "--no-pager",
             "--property=ControlGroup,ActiveState,SubState,Result,MemoryCurrent,MemoryPeak"],
            capture_output=True, text=True, timeout=3, check=True,
        ).stdout
        if len(state) > 16384:
            raise ValueError("scope state exceeds limit")
        fields = dict(line.split("=", 1) for line in state.splitlines() if "=" in line)
        report["lastUnitState"] = fields
        group = fields.get("ControlGroup", "")
        if group.startswith("/") and group.endswith("/" + unit) and ".." not in group.split("/"):
            counters = {}
            for name in ("memory.current", "memory.peak", "memory.max", "memory.events",
                         "memory.events.local", "memory.swap.max", "pids.current", "pids.max"):
                file = Path("/sys/fs/cgroup") / group.lstrip("/") / name
                try:
                    with file.open() as source:
                        value = source.read(4097)
                    if len(value) > 4096:
                        raise ValueError("cgroup counter exceeds limit")
                    counters[name] = value.strip()
                except FileNotFoundError:
                    pass
            if counters:
                report["lastCgroupObservation"] = {"at": time.time(), "counters": counters}
                report["observations"] += 1
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report["unavailable"] += 1
        report["lastErrorType"] = type(error).__name__
    report["sampledAt"] = time.time()
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    os.replace(temporary, destination)
    if stop.is_set():
        break
    stop.wait(2)

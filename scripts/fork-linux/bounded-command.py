#!/usr/bin/env python3
"""Run one CI child group with disk, output-file, CPU and wall limits."""
import os
import resource
import shutil
import signal
import subprocess
import sys
import time

seconds = int(sys.argv[1])
command = sys.argv[2:]
if not command or not 1 <= seconds <= 3600:
    raise SystemExit("invalid bounded command")
minimum_free = 6 * 1024**3
if shutil.disk_usage(os.getcwd()).free < minimum_free:
    raise SystemExit("CI disk guard: less than 6 GiB available before command")


def child_limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024**3, 4 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (seconds * 4, seconds * 4))


child = subprocess.Popen(command, start_new_session=True, preexec_fn=child_limits)
stopped = False


def stop_group():
    global stopped
    if stopped:
        return
    stopped = True
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            break
        if sig == signal.SIGTERM:
            time.sleep(2)
    child.wait()


def interrupted(signum, _frame):
    stop_group()
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
deadline = time.monotonic() + seconds
try:
    while child.poll() is None:
        if time.monotonic() >= deadline:
            raise RuntimeError("CI command wall-clock limit reached")
        if shutil.disk_usage(os.getcwd()).free < minimum_free:
            raise RuntimeError("CI disk guard: less than 6 GiB available")
        time.sleep(1)
    result = child.wait()
finally:
    # Join descendants even if the group leader returned before them.
    stop_group()
raise SystemExit(result if result >= 0 else 128 - result)

#!/usr/bin/env python3
"""Exact-path userns permission for one exclusive, disposable GitHub Linux job.

Never changes sysctls, installs a setuid helper, or accepts arbitrary policy text.
A failed or uncertain retirement retains the profile and its root-owned receipt.
This is not a sandbox against another privileged writer in the same CI job.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import uuid

ROOT = Path('/run')
PROC = Path('/proc')
PREFIX = 'openclaw-canvas-'
SETTINGS = Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
PROFILES = Path('/sys/kernel/security/apparmor/profiles')
PARSER = '/usr/sbin/apparmor_parser'


def read_small(file, cap=32768):
    with open(file, 'rb') as stream:
        data = stream.read(cap + 1)
    if len(data) > cap:
        raise ValueError('bounded read exceeded: ' + str(file))
    return data.decode().strip()


def binary_identity(file):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+/chrome', str(file)):
        raise ValueError('unsafe Chromium path')
    path = Path(file)
    if str(path) != str(file) or '..' in path.parts or path.resolve() != path:
        raise ValueError('noncanonical Chromium path')
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError('symlink component')
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_mode & 0o6000:
        raise ValueError('regular non-setuid executable required')
    if not 0 < before.st_size <= 512 * 1024**2 or not before.st_mode & 0o100:
        raise ValueError('invalid executable size/mode')
    fingerprint = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mode, value.st_uid, value.st_mtime_ns, value.st_ctime_ns)
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        if fingerprint(os.fstat(stream.fileno())) != fingerprint(before):
            raise ValueError('executable changed before open')
        for chunk in iter(lambda: stream.read(1024**2), b''):
            digest.update(chunk)
        after = os.fstat(stream.fileno())
    if fingerprint(before) != fingerprint(after) or fingerprint(after) != fingerprint(path.stat()):
        raise ValueError('executable changed during hash')
    return dict(path=str(path), dev=str(before.st_dev), inode=str(before.st_ino),
                bytes=before.st_size, mode=stat.S_IMODE(before.st_mode),
                uid=before.st_uid, sha256=digest.hexdigest())


def policy_text(name, executable):
    if not re.fullmatch(PREFIX + r'[a-f0-9]{32}', name):
        raise ValueError('invalid unique profile')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+/chrome', executable) or '..' in Path(executable).parts:
        raise ValueError('policy path injection')
    return f'abi <abi/4.0>,\nprofile {name} "{executable}" flags=(unconfined) {{\n  userns,\n}}\n'


def profile_entries():
    return read_small(PROFILES, 1024**2).splitlines()


def loaded(name):
    return [x for x in profile_entries() if x.startswith(name + ' (')]


def parser(action, file):
    result = subprocess.run([PARSER, '--skip-cache', action, str(file)],
                            timeout=8, capture_output=True, check=False)
    if len(result.stdout) + len(result.stderr) > 8192:
        raise RuntimeError('parser output limit')
    if result.returncode:
        raise RuntimeError('apparmor_parser failed: ' + result.stderr.decode(errors='replace')[:2000])


def write_new(file, value):
    with open(file, 'x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    os.chmod(file, 0o644)


def owner_receipt(directory):
    directory = Path(directory)
    if directory.parent != ROOT or not re.fullmatch(PREFIX + r'[a-f0-9]{32}', directory.name):
        raise ValueError('invalid owner directory')
    for file in [ROOT, directory, directory / 'receipt.json', directory / 'profile']:
        s = file.lstat()
        if stat.S_ISLNK(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise ValueError('unsafe root-owned receipt')
    receipt = json.loads(read_small(directory / 'receipt.json'))
    if receipt['profile'] != directory.name or receipt['schemaVersion'] != 1:
        raise ValueError('owner mismatch')
    content = read_small(directory / 'profile') + '\n'
    if content != policy_text(directory.name, receipt['executable']['path']):
        raise ValueError('changed profile')
    if hashlib.sha256(content.encode()).hexdigest() != receipt['policySha256']:
        raise ValueError('changed profile hash')
    return directory, receipt


def matching_processes(receipt):
    pids = sorted(x for x in PROC.iterdir() if x.name.isdecimal())
    if len(pids) > 4096:
        raise ValueError('process inventory cap')
    matches = []
    for process in pids:
        try:
            # Non-dumpable user processes may have root-owned /proc inodes.
            # Read the actual label/executable across all UIDs; never filter on inode ownership.
            try:
                label = read_small(process / 'attr/apparmor/current', 8192)
            except OSError as error:
                if error.errno != errno.EINVAL:
                    raise
                status = read_small(process / 'status')
                kernel = [x.split(':', 1)[1].strip() for x in status.splitlines() if x.startswith('Kthread:')]
                if kernel != ['1']:
                    raise ValueError('non-kernel process label unavailable') from error
                try:
                    os.readlink(process / 'exe')
                except FileNotFoundError:
                    continue  # Exact kernel-thread status plus no executable, not an inode UID guess.
                raise ValueError('kernel-thread executable unexpectedly present')
            try:
                executable = os.readlink(process / 'exe')
            except FileNotFoundError:
                executable = ''  # Zombie/racing exit; label is still checked.
            if (label.startswith(receipt['profile'] + ' ') or
                    label.startswith(receipt['profile'] + '//') or
                    executable.removesuffix(' (deleted)') == receipt['executable']['path']):
                matches.append(int(process.name))
        except FileNotFoundError:
            if process.exists():
                raise ValueError('live process label unavailable')
        # Permission/unknown reads fail closed, never count as an empty inventory.
    return matches


def retirement_failure(directory, error):
    # Fixed classifications and authenticated metadata only; no raw parser/error output.
    result = dict(schemaVersion=1, passed=False, retirementState='unconfirmed',
                  failureClass=type(error).__name__ if type(error).__name__ in
                  ['ValueError', 'RuntimeError', 'OSError', 'PermissionError', 'FileNotFoundError', 'TimeoutExpired'] else 'Exception',
                  profileState='unknown', ownerReceiptVerified=False)
    try:
        _, receipt = owner_receipt(directory)
        result.update(ownerReceiptVerified=True, profile=receipt['profile'],
                      executable=receipt['executable'], policySha256=receipt['policySha256'],
                      loadAttempted=receipt['loadAttempted'])
        present = loaded(receipt['profile'])
        result['profileState'] = 'loaded' if len(present) == 1 else 'absent' if not present else 'unknown'
    except Exception:
        pass  # Preserve the original failure; absence of a receipt is never a pass.
    return result


def retire(directory):
    directory, receipt = owner_receipt(directory)
    identity = binary_identity(receipt['executable']['path'])
    if identity != receipt['executable'] or read_small(SETTINGS) != receipt['usernsRestriction']:
        raise ValueError('executable or global policy drift; retaining profile')
    active = matching_processes(receipt)
    if active:
        raise ValueError('owned Chromium processes still present; retaining profile')
    done = directory / 'retired.json'
    if done.exists():
        if loaded(receipt['profile']):
            raise ValueError('retired profile unexpectedly present')
        return json.loads(read_small(done))
    present = loaded(receipt['profile'])
    if len(present) != 1:
        raise ValueError('profile state uncertain; retaining owner')
    parser('-R', directory / 'profile')
    if loaded(receipt['profile']):
        raise ValueError('profile unload not confirmed')
    if read_small(SETTINGS) != receipt['usernsRestriction']:
        raise ValueError('global policy changed during retirement')
    result = dict(schemaVersion=1, passed=True, profile=receipt['profile'],
                  processesAbsentBeforeUnload=True, profileAbsent=True,
                  globalPolicyUnchanged=True, executable=identity,
                  scope='exclusive disposable runner; root-owned recovery files retained')
    write_new(done, result)
    return result


def prepare(executable, run_id, attempt):
    if not run_id.isdecimal() or not attempt.isdecimal():
        raise ValueError('explicit hosted run identity required')
    uid = int(os.environ['SUDO_UID'])
    if uid == 0 or pwd.getpwuid(uid).pw_name != 'runner':
        raise ValueError('GitHub hosted runner UID required')
    if 'VERSION_ID="24.04"' not in read_small('/etc/os-release'):
        raise ValueError('only Ubuntu 24.04 qualified')
    if read_small('/sys/module/apparmor/parameters/enabled') != 'Y':
        raise ValueError('AppArmor unavailable')
    if read_small('/proc/self/attr/apparmor/current') != 'unconfined':
        raise ValueError('refuse to replace existing caller confinement')
    restriction = read_small(SETTINGS)
    if restriction != '1':
        raise ValueError('unexpected global userns policy; no fallback')
    identity = binary_identity(executable)
    home = pwd.getpwuid(uid).pw_dir
    if not re.fullmatch(re.escape(home) + r'/\.cache/ms-playwright/chromium-[0-9]+/chrome-linux64/chrome', executable):
        raise ValueError('only default managed Playwright Chromium permitted')
    if identity['uid'] != uid:
        raise ValueError('unexpected browser owner')
    name = PREFIX + uuid.uuid4().hex
    directory = ROOT / name
    directory.mkdir(mode=0o755)
    content = policy_text(name, executable)
    (directory / 'profile').write_text(content)
    os.chmod(directory / 'profile', 0o644)
    receipt = dict(schemaVersion=1, profile=name, runnerUid=uid, runId=run_id, attempt=attempt,
                   executable=identity, policySha256=hashlib.sha256(content.encode()).hexdigest(),
                   usernsRestriction=restriction, loadAttempted=True,
                   assumption='trusted exclusive secretless disposable GitHub job; no concurrent privileged or same-UID writer')
    write_new(directory / 'receipt.json', receipt)  # Before a potentially partial kernel load.
    print(str(directory), flush=True)  # Recovery authority survives a failed prepare.
    if loaded(name):
        raise ValueError('profile collision')
    parser('-a', directory / 'profile')
    if len(loaded(name)) != 1 or read_small(SETTINGS) != restriction:
        raise ValueError('profile admission or global-policy readback failed')
    if binary_identity(executable) != identity:
        raise ValueError('browser drift on admission')
    write_new(directory / 'loaded.json', dict(passed=True, profile=name, globalPolicyUnchanged=True))


def main():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('disposable Linux root prerequisite only')
    if sys.argv[1] == 'prepare' and len(sys.argv) == 5:
        prepare(*sys.argv[2:])
    elif sys.argv[1] == 'retire' and len(sys.argv) == 3:
        try:
            result = retire(sys.argv[2])
        except Exception as error:
            print(json.dumps(retirement_failure(sys.argv[2], error)), flush=True)
            raise SystemExit(1)
        print(json.dumps(result))
    else:
        raise ValueError('unsupported operation')


if __name__ == '__main__':
    main()

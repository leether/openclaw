"""Offline failure-order tests. No sudo, AppArmor, browser, network or LIVE."""
import errno
import importlib.util
import json
from pathlib import Path
import tempfile
import io
from contextlib import redirect_stdout
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import sys

spec = importlib.util.spec_from_file_location('owner', sys.argv[1])
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
name = owner.PREFIX + 'a' * 32
executable = '/home/runner/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'


class Tests(unittest.TestCase):
    def test_exact_permission_only(self):
        self.assertEqual(owner.policy_text(name, executable), f'abi <abi/4.0>,\nprofile {name} "{executable}" flags=(unconfined) {{\n  userns,\n}}\n')

    def test_policy_injection_rejected(self):
        for path in ['/tmp/*/chrome', '/tmp/a"/chrome', '/tmp/a\n/chrome', '/tmp/../chrome', '/tmp/aa{b}/chrome', '/tmp/a/chrome\x00']:
            with self.assertRaises(ValueError): owner.policy_text(name, path)
        for profile in ['chrome', '../escape', name + '\nuserns,']:
            with self.assertRaises(ValueError): owner.policy_text(profile, executable)

    def test_real_regular_identity_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw).resolve()
            file = directory / 'chrome'
            file.write_bytes(b'synthetic')
            file.chmod(0o755)
            first = owner.binary_identity(str(file))
            self.assertEqual(first, owner.binary_identity(str(file)))
            other = directory / 'other'; other.mkdir()
            (other / 'chrome').symlink_to(file)
            with self.assertRaises(ValueError): owner.binary_identity(str(other / 'chrome'))
            # Some macOS temporary mounts clear setuid; validate without granting it.
            with patch.object(Path, 'stat', return_value=SimpleNamespace(st_mode=0o104755)):
                with self.assertRaises(ValueError): owner.binary_identity(str(file))

    def process_fixture(self, label=None, kernel='0', executable_error=None, label_error=None):
        with tempfile.TemporaryDirectory() as raw:
            proc = Path(raw)
            process = proc / '55'; process.mkdir()
            (process / 'attr/apparmor').mkdir(parents=True)
            (process / 'attr/apparmor/current').write_text(label or name + ' (unconfined)')
            (process / 'status').write_text('Kthread: ' + kernel + '\n')
            actual_read = owner.read_small
            def read(file, *args):
                if str(file).endswith('/current') and label_error: raise label_error
                return actual_read(file, *args)
            with patch.object(owner, 'PROC', proc), \
                 patch.object(owner, 'read_small', side_effect=read), \
                 patch.object(owner.os, 'readlink', side_effect=executable_error, return_value=executable), \
                 patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=0)):
                return owner.matching_processes(dict(profile=name, runnerUid=1001, executable={'path': executable}))

    def test_root_owned_proc_inode_does_not_hide_live_runner_profile(self):
        self.assertEqual(self.process_fixture(executable_error=FileNotFoundError()), [55])
        self.assertEqual(self.process_fixture(label='unconfined'), [55])

    def test_label_less_kernel_thread_requires_exact_status_and_no_exe(self):
        self.assertEqual(self.process_fixture(kernel='1', label_error=OSError(errno.EINVAL, 'kernel'), executable_error=FileNotFoundError()), [])
        for args in [dict(kernel='0', executable_error=FileNotFoundError()), dict(kernel='1')]:
            with self.assertRaises(ValueError): self.process_fixture(label_error=OSError(errno.EINVAL, 'unknown'), **args)

    def test_live_process_unknown_label_blocks_inventory(self):
        for error in [PermissionError(), FileNotFoundError()]:
            with self.assertRaises((PermissionError, ValueError)):
                self.process_fixture(label_error=error)

    def test_retirement_failure_retains_verified_partial_admission(self):
        receipt = dict(profile=name, executable={'path': executable}, policySha256='a' * 64, loadAttempted=True)
        with patch.object(owner, 'owner_receipt', return_value=(Path('/run') / name, receipt)), \
             patch.object(owner, 'loaded', return_value=[name + ' (unconfined)']):
            result = owner.retirement_failure('/run/' + name, RuntimeError('private raw diagnostic'))
        self.assertFalse(result['passed']); self.assertTrue(result['loadAttempted'])
        self.assertTrue(result['ownerReceiptVerified']); self.assertEqual(result['profileState'], 'loaded')
        self.assertNotIn('private', json.dumps(result))

    def test_failed_retire_cli_exports_failure_and_exits_nonzero(self):
        output = io.StringIO()
        with patch.object(owner.sys, 'platform', 'linux'), \
             patch.object(owner.os, 'geteuid', return_value=0), \
             patch.object(owner.sys, 'argv', ['owner', 'retire', '/run/' + name]), \
             patch.object(owner, 'retire', side_effect=RuntimeError('raw-private-error')), \
             patch.object(owner, 'owner_receipt', side_effect=PermissionError()), redirect_stdout(output):
            with self.assertRaises(SystemExit) as error: owner.main()
        self.assertEqual(error.exception.code, 1)
        result = json.loads(output.getvalue()); self.assertFalse(result['passed'])
        self.assertEqual(result['profileState'], 'unknown'); self.assertFalse(result['ownerReceiptVerified'])
        self.assertNotIn('raw-private', output.getvalue())

    def retire_fixture(self, active=None, drift=False, parser_error=False, absent_after=False, already=False):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            receipt = dict(profile=name, executable={'path': executable, 'sha256': 'a'}, usernsRestriction='1')
            retired = dict(passed=True, profileAbsent=True)
            if already: (directory / 'retired.json').write_text(json.dumps(retired))
            operations = []
            def read(file, *args):
                return json.dumps(retired) if str(file).endswith('retired.json') else '1'
            def invoke(*args):
                operations.append('unload')
                if parser_error: raise RuntimeError('parser failed')
            def scan(*args):
                operations.append('scan')
                if isinstance(active, Exception): raise active
                return active or []
            calls = [[]] if already else [[name + ' (unconfined)'], [name + ' (unconfined)'] if absent_after else []]
            with patch.object(owner, 'owner_receipt', return_value=(directory, receipt)), \
                 patch.object(owner, 'binary_identity', return_value={} if drift else receipt['executable']), \
                 patch.object(owner, 'read_small', side_effect=read), \
                 patch.object(owner, 'matching_processes', side_effect=scan), \
                 patch.object(owner, 'loaded', side_effect=calls), \
                 patch.object(owner, 'parser', side_effect=invoke):
                try:
                    result = owner.retire(directory)
                    return result, operations, (directory / 'retired.json').exists(), None
                except Exception as error:
                    return None, operations, (directory / 'retired.json').exists(), error

    def test_worker_failure_still_requires_empty_before_unload(self):
        result, calls, written, error = self.retire_fixture()
        self.assertIsNone(error); self.assertTrue(result['passed']); self.assertTrue(written)
        self.assertEqual(calls, ['scan', 'unload'])

    def test_unjoined_or_unreadable_owner_refuses_unload(self):
        for active in [[44], PermissionError('unknown')]:
            _, calls, written, error = self.retire_fixture(active=active)
            self.assertIsNotNone(error); self.assertEqual(calls, ['scan']); self.assertFalse(written)

    def test_drift_does_not_unload(self):
        _, calls, written, error = self.retire_fixture(drift=True)
        self.assertIsNotNone(error); self.assertEqual(calls, []); self.assertFalse(written)

    def test_partial_or_failed_retirement_keeps_recovery(self):
        for args in [dict(parser_error=True), dict(absent_after=True)]:
            _, calls, written, error = self.retire_fixture(**args)
            self.assertIsNotNone(error); self.assertEqual(calls, ['scan', 'unload']); self.assertFalse(written)

    def test_repeat_retirement_reads_but_does_not_unload_twice(self):
        result, calls, written, error = self.retire_fixture(already=True)
        self.assertIsNone(error); self.assertTrue(result['passed']); self.assertTrue(written)
        self.assertEqual(calls, ['scan'])

    def test_untrusted_receipt_directory_refused_before_read(self):
        for path in ['/tmp/arbitrary', '/run/../tmp/' + name, '/run/openclaw-canvas-wrong']:
            with self.assertRaises(ValueError): owner.owner_receipt(path)

    def test_host_context_refused_before_policy_load(self):
        with patch.object(owner.os, 'geteuid', return_value=1000):
            with self.assertRaises(ValueError): owner.main()

suite = unittest.defaultTestLoader.loadTestsFromTestCase(Tests)
result = unittest.TextTestRunner(verbosity=1).run(suite)
print(json.dumps(dict(passed=result.wasSuccessful(), tests=result.testsRun, failures=len(result.failures), errors=len(result.errors))))
sys.exit(0 if result.wasSuccessful() else 1)

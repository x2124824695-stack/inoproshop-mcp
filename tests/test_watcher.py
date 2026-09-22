"""Fault injection for the actual worker functions; no IDE or PLC access."""
import ast
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
import uuid
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src/scripts/watcher.py'


class Event:
    def __init__(self, initial): self.signaled = initial
    def Set(self): self.signaled = True
    def WaitOne(self):
        if not self.signaled: raise AssertionError('Completion event was stranded')


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mcp-watcher-中文-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'commands').mkdir(); (self.root / 'results').mkdir()
        # Load production functions without starting the .NET background thread.
        tree = ast.parse(SOURCE.read_text(encoding='utf8'))
        tree.body = tree.body[:-1]
        self.env = {'unicode': str}
        exec(compile(tree, str(SOURCE), 'exec'), self.env)
        self.env.update(IPC_BASE_DIR=str(self.root), COMMANDS_DIR=str(self.root/'commands'),
                        RESULTS_DIR=str(self.root/'results'), SESSION_TOKEN='token', ManualResetEvent=Event)
        self.calls = 0
        def dispatch(fn):
            self.calls += 1
            fn()
        self.env['se'] = types.SimpleNamespace(system=types.SimpleNamespace(execute_on_primary_thread=dispatch))
        net = types.ModuleType('System.IO')
        net.File = types.SimpleNamespace(Move=os.rename, Replace=lambda a,b,c: os.replace(a,b))
        self.modules = patch.dict(sys.modules, {'System.IO': net})
        self.modules.start(); self.addCleanup(self.modules.stop)

    def command(self, source, **overrides):
        request_id = str(uuid.uuid4())
        script = self.root/'commands'/(request_id+'.py')
        script.write_text(source, encoding='utf8')
        data = dict(requestId=request_id, sessionToken='token', deadline=time.time()*1000+10000,
                    scriptPath=str(script), **overrides)
        name = request_id+'.command.json'
        (self.root/'commands'/name).write_text(json.dumps(data), encoding='utf8')
        return request_id, name

    def result(self, request_id):
        return json.loads((self.root/'results'/(request_id+'.result.json')).read_text(encoding='utf8'))

    def test_chinese_result_roundtrip_and_stdout_restored(self):
        rid, name = self.command("print('去核完成 中文轴')\nprint('SCRIPT_SUCCESS')")
        stdout, stderr = sys.stdout, sys.stderr
        self.env['process_command'](name)
        result = self.result(rid)
        self.assertTrue(result['success']); self.assertIn('中文轴', result['output'])
        self.assertIs(sys.stdout, stdout); self.assertIs(sys.stderr, stderr)
        self.assertGreater(result['timestamp'], 10**12)
        self.assertFalse((self.root/'commands'/(rid+'.running.json')).exists())

    def test_unicode_exception_returns_failure_once(self):
        rid, name = self.command("raise ValueError('中文变量读取失败')")
        self.env['process_command'](name); self.env['process_command'](name)
        self.assertFalse(self.result(rid)['success'])
        self.assertIn('中文变量读取失败', self.result(rid)['error'])
        self.assertEqual(self.calls, 1)

    def test_broken_exception_string_does_not_strand_completion(self):
        rid, name = self.command("class Bad(Exception):\n def __str__(self): raise UnicodeError('bad formatter')\nraise Bad('中文错误')")
        self.env['process_command'](name)
        self.assertFalse(self.result(rid)['success']); self.assertIn('中文错误', self.result(rid)['error'])

    def test_write_failure_keeps_claim_and_never_reexecutes(self):
        rid, name = self.command("print('SCRIPT_SUCCESS')")
        def fail(_): raise OSError('disk full')
        self.env['publish'] = fail
        with self.assertRaises(OSError): self.env['process_command'](name)
        self.env['process_command'](name)
        self.assertEqual(self.calls, 1)
        self.assertTrue((self.root/'commands'/(rid+'.running.json')).exists())
        self.assertFalse((self.root/'commands'/name).exists())

    def test_nonzero_exit_cannot_be_overridden_by_success_marker(self):
        rid, name = self.command("print('SCRIPT_SUCCESS')\nsys.exit(1)")
        self.env['process_command'](name)
        self.assertFalse(self.result(rid)['success'])

    def test_missing_success_marker_is_failure(self):
        rid, name = self.command("print('just a log')")
        self.env['process_command'](name)
        self.assertFalse(self.result(rid)['success'])

    def test_deadline_or_token_rejects_without_dispatch(self):
        for key, value in [('deadline', 1), ('sessionToken', 'wrong'), ('scriptPath', '../elsewhere.py')]:
            rid, name = self.command("print('SCRIPT_SUCCESS')")
            file = self.root/'commands'/name
            data = json.loads(file.read_text(encoding='utf8')); data[key] = value
            file.write_text(json.dumps(data), encoding='utf8')
            self.env['process_command'](name)
            self.assertFalse(self.result(rid)['success'])
        self.assertEqual(self.calls, 0)

    def test_dispatch_exception_keeps_unknown_even_if_callback_was_queued(self):
        queued = []
        def ambiguous(fn):
            queued.append(fn)
            raise RuntimeError('callback may already be queued')
        self.env['se'].system.execute_on_primary_thread = ambiguous
        rid, name = self.command("print('SCRIPT_SUCCESS')")
        self.env['process_command'](name)
        self.assertTrue((self.root/'commands'/(rid+'.running.json')).exists())
        self.assertFalse((self.root/'results'/(rid+'.result.json')).exists())
        queued[0]()
        self.env['process_command'](name)
        self.assertEqual(len(queued), 1)


if __name__ == '__main__': unittest.main()

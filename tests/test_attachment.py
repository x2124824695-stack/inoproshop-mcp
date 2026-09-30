"""Existing-IDE bootstrap boundaries, without opening an IDE or project."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src/scripts/attach_session.py'


class AttachmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mcp-attach-中文-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = str(self.root / '测试.project')
        self.exe = str(self.root / 'InoProShop.exe')
        self.prepared = dict(identity='identity', token='token', projectFilePath=self.project)
        (self.root / 'attachment.json').write_text(json.dumps(self.prepared), encoding='utf8')
        self.params = dict(IPC_BASE_DIR=str(self.root), SESSION_TOKEN='token', SESSION_ID='identity',
                           CODESYS_PATH=self.exe, PROJECT_FILE_PATH=self.project, WATCHER_VERSION='1.1.0')
        self.primary = types.SimpleNamespace(path=self.project)
        self.current = types.SimpleNamespace(Id=123, MainModule=types.SimpleNamespace(FileName=self.exe))
        self.live = False
        def get_pid(_):
            if self.live:
                return self.current
            raise ValueError('not running')
        net = types.ModuleType('System.Diagnostics')
        net.Process = types.SimpleNamespace(GetCurrentProcess=lambda: self.current, GetProcessById=get_pid)
        se = types.SimpleNamespace(projects=types.SimpleNamespace(primary=self.primary))
        self.se = se
        self.modules = patch.dict(sys.modules, {'System.Diagnostics': net, 'scriptengine': se})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def run_bootstrap(self):
        def replace(m):
            return self.params[m[1]].replace('\\', '\\\\').replace('"', '\\"')
        source = re.sub(r'\{([A-Z][A-Z0-9_]*)\}', replace, SOURCE.read_text(encoding='utf8'))
        env = {}
        exec(compile(source, str(SOURCE), 'exec'), env)
        return env

    def test_same_project_prepares_metadata_without_saving_or_opening(self):
        env = self.run_bootstrap()
        self.assertEqual(env['_attach_metadata']['pid'], 123)
        self.assertTrue(env['_attach_metadata']['attached'])
        self.assertFalse((self.root / 'session.json').exists())

    def test_wrong_project_and_missing_project_fail(self):
        self.primary.path = str(self.root / 'other.project')
        with self.assertRaisesRegex(RuntimeError, 'already be primary'):
            self.run_bootstrap()
        self.se.projects.primary = None
        with self.assertRaisesRegex(RuntimeError, 'already be primary'):
            self.run_bootstrap()

    def test_wrong_executable_fails(self):
        self.current.MainModule.FileName = str(self.root / 'other.exe')
        with self.assertRaisesRegex(RuntimeError, 'configured InoProShop'):
            self.run_bootstrap()

    def test_obsolete_script_fails(self):
        self.prepared['token'] = 'new-token'
        (self.root / 'attachment.json').write_text(json.dumps(self.prepared), encoding='utf8')
        with self.assertRaisesRegex(RuntimeError, 'obsolete'):
            self.run_bootstrap()

    def test_duplicate_watcher_refused(self):
        (self.root / 'session.json').write_text(json.dumps(dict(pid=123)), encoding='utf8')
        self.live = True
        with self.assertRaisesRegex(RuntimeError, 'duplicate bootstrap'):
            self.run_bootstrap()

    def test_dead_metadata_does_not_block_attachment(self):
        (self.root / 'session.json').write_text(json.dumps(dict(pid=123)), encoding='utf8')
        self.assertEqual(self.run_bootstrap()['_attach_metadata']['pid'], 123)


if __name__ == '__main__':
    unittest.main()

# -*- coding: utf-8 -*-
"""Actual bundled IronPython runtime, mocked ScriptEngine; never opens a PLC project."""
from __future__ import unicode_literals
import sys, os, json, types, time
from System.Threading import ManualResetEvent

with open(os.path.join(FIXTURE_DIR, 'fixtures.json'), 'rb') as f:
    fixtures = json.loads(f.read().decode('utf-8'))

# Compile the complete production watcher, but omit its startup block at run
# time. Use the actual .NET File API and threading event in process_command.
compile(fixtures['watcher'], '<watcher>', 'exec')
watcher_source = fixtures['watcher'].rsplit('\ntry:\n    for directory', 1)[0]
watch = {}
exec(watcher_source, watch)
for folder in ('commands', 'results'):
    os.makedirs(os.path.join(FIXTURE_DIR, folder))
watch['ManualResetEvent'] = ManualResetEvent

class SystemMock(object):
    calls = 0
    def execute_on_primary_thread(self, fn):
        self.calls += 1
        fn()

mock = types.ModuleType('scriptengine')
mock.system = SystemMock()
sys.modules['scriptengine'] = mock
watch['se'] = mock

def run_request(number, code):
    rid = '00000000-0000-0000-0000-%012d' % number
    script = os.path.join(FIXTURE_DIR, 'commands', rid+'.py')
    with open(script, 'wb') as f: f.write(code.encode('utf-8'))
    command = {'requestId': rid, 'sessionToken': 'fixture', 'scriptPath': script, 'deadline': time.time()*1000+10000}
    name = rid+'.command.json'
    with open(os.path.join(FIXTURE_DIR, 'commands', name), 'wb') as f:
        f.write(json.dumps(command, ensure_ascii=False).encode('utf-8'))
    watch['process_command'](name)
    watch['process_command'](name)
    with open(os.path.join(FIXTURE_DIR, 'results', rid+'.result.json'), 'rb') as f:
        return json.loads(f.read().decode('utf-8'))

good = run_request(1, "print(u'\u53bb\u6838\u4e2d\u6587')\nprint('SCRIPT_SUCCESS')")
assert good['success'] and u'\u53bb\u6838' in good['output']
bad = run_request(2, "raise ValueError(u'\u4e2d\u6587\u9519\u8bef')")
assert not bad['success'] and u'\u4e2d\u6587' in bad['error']
nonzero = run_request(3, "print('SCRIPT_SUCCESS')\nsys.exit(1)")
assert not nonzero['success']
assert mock.system.calls == 3

class Text(object):
    def __init__(self, text): self.text = text
class Node(object):
    textual_declaration = Text(u'VAR \u4e2d\u6587\u8f74: BOOL; END_VAR')
    textual_implementation = Text(u'vb_\u53bb\u6838\u62cd\u7167\u5b8c\u6210 := TRUE;')
    def get_name(self): return u'ST06_\u53bb\u6838'
    def get_children(self, recursive): return []
class Project(object):
    def get_children(self, recursive): return [Node()]

def run_query(source):
    capture = watch['OutputCapture']()
    original = sys.stdout
    try:
        sys.stdout = capture
        env = {'require_project_open': lambda _: Project(), 'PROJECT_FILE_PATH': u'C:/\u4e2d\u6587/\u5de5\u7a0b.project'}
        try:
            watch['_do_exec'](source, env)
        except SystemExit as e:
            assert e.code == 0, capture.getvalue()
    finally:
        sys.stdout = original
    return capture.getvalue()

out = run_query(fixtures['search'])
data = json.loads(out.split('### RESULT_JSON ###\n')[1].split('\n### END_RESULT_JSON ###')[0])
assert data['count'] == 2 and data['complete'] and data['hits'][0]['path'] == Node().get_name(), repr(data)
out = run_query(fixtures['bulk'])
data = json.loads(out.split('### ALL_POU_CODE_START ###\n')[1].split('\n### ALL_POU_CODE_END ###')[0])
assert len(data) == 1 and data[0]['implementation'] == Node.textual_implementation.text
print('PASS: bundled IronPython ' + sys.version.split()[0] + '; watcher success/error/nonzero/no replay; Chinese search and bulk read')

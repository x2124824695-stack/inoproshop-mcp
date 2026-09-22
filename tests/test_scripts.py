"""Host-independent script behavior tests. CPython mocks do not certify IronPython/SP11."""
import ast
import contextlib
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import types
import unittest
import tempfile
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'src' / 'scripts'

def render(name, params):
    def sub(m):
        text = str(params[m[1]])
        return text.replace('\\', '\\\\').replace('"', '\\"').replace("'", "\\'").replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
    return re.sub(r'\{([A-Z][A-Z0-9_]*)\}', sub, (SCRIPTS / name).read_text(encoding='utf8'))

def run_script(name, params, env, module=None):
    class Capture(io.StringIO):
        _mcp_unicode_output = True
    output = Capture()
    env = {'unicode': str, '_to_unicode': str, **env}
    with patch.dict(sys.modules, {'scriptengine': module or types.ModuleType('scriptengine')}), contextlib.redirect_stdout(output):
        try:
            exec(compile(render(name, params), name, 'exec'), env)
            code = 0
        except SystemExit as e:
            code = e.code
    return code, output.getvalue()

class Text:
    def __init__(self, text, fail_on=None): self.text, self.fail_on = text, fail_on
    def replace(self, text):
        if text == self.fail_on: raise RuntimeError('Injected editor failure')
        self.text = text

class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.obj = types.SimpleNamespace(textual_declaration=Text('old declaration'), textual_implementation=Text('old implementation'))
        self.saves = 0
        self.project = types.SimpleNamespace(save=self.save)
        self.env = {'PROJECT_FILE_PATH':'test.project', 'ensure_project_open':lambda _:self.project,
                    'find_object_by_path_robust':lambda *args:self.obj}
        self.params = {'POU_FULL_PATH':'Application/P','DECLARATION_CONTENT':'new declaration',
            'IMPLEMENTATION_CONTENT':'中文 {UPDATE_IMPL}', 'UPDATE_DECL':'1','UPDATE_IMPL':'1','EXPECTED_HASH':''}
    def save(self): self.saves += 1
    def test_write_readback_and_save(self):
        code, output = run_script('set_pou_code.py', self.params, self.env)
        self.assertEqual(code,0); self.assertIn('SCRIPT_SUCCESS',output)
        self.assertEqual(self.obj.textual_implementation.text,'中文 {UPDATE_IMPL}');self.assertEqual(self.saves,1)
    def test_partial_failure_rolls_back_both_sections(self):
        self.obj.textual_implementation.fail_on = self.params['IMPLEMENTATION_CONTENT']
        code, output = run_script('set_pou_code.py', self.params, self.env)
        self.assertEqual(code,1); self.assertNotIn('SCRIPT_SUCCESS',output)
        self.assertEqual(self.obj.textual_declaration.text,'old declaration')
        self.assertEqual(self.obj.textual_implementation.text,'old implementation')
    def test_missing_editor_never_reports_success(self):
        del self.obj.textual_implementation
        code, output = run_script('set_pou_code.py', self.params, self.env)
        self.assertEqual(code,1);self.assertEqual(self.saves,0);self.assertNotIn('SCRIPT_SUCCESS',output)
    def test_stale_hash_blocks_all_writes(self):
        code, output = run_script('set_pou_code.py',{**self.params,'EXPECTED_HASH':'0'*64},self.env)
        self.assertEqual(code,1);self.assertIn('STALE_WRITE',output);self.assertEqual(self.saves,0)
        self.assertEqual(self.obj.textual_declaration.text,'old declaration')
    def test_matching_hash_and_explicit_empty_implementation(self):
        digest=hashlib.sha256(b'old declaration\0old implementation').hexdigest()
        params={**self.params,'EXPECTED_HASH':digest,'IMPLEMENTATION_CONTENT':'','UPDATE_DECL':'0'}
        code,_=run_script('set_pou_code.py',params,self.env)
        self.assertEqual(code,0);self.assertEqual(self.obj.textual_implementation.text,'')
        self.assertEqual(self.obj.textual_declaration.text,'old declaration')
    def test_save_failure_rolls_back_in_memory(self):
        def fail_first():
            self.saves+=1
            if self.saves==1: raise RuntimeError('disk full')
        self.project.save=fail_first
        code,output=run_script('set_pou_code.py',self.params,self.env)
        self.assertEqual(code,1);self.assertIn('disk full',output)
        self.assertEqual(self.obj.textual_declaration.text,'old declaration')
    def test_strict_path_does_not_find_wrong_descendant(self):
        env={};exec((SCRIPTS/'find_object_by_path.py').read_text(encoding='utf8'),env)
        root=types.SimpleNamespace(get_children=lambda _:[],get_name=lambda:'Root',find=lambda *a:[self.obj])
        self.assertIsNone(env['find_object_by_path_robust'](root,'Missing'))

    def test_create_project_preserves_existing_target(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'target.project'
            source = Path(folder) / 'AM600.project'
            target.write_bytes(b'original')
            source.write_bytes(b'template')
            params = {'TEMPLATE_MODE':'path','TEMPLATE_PROJECT_PATH':str(source),
                      'TEMPLATE_NAME':'','PROJECT_FILE_PATH':str(target)}
            code, output = run_script('create_project.py', params, {})
            self.assertEqual(code, 1)
            self.assertIn('refusing to overwrite', output)
            self.assertEqual(target.read_bytes(), b'original')

    def test_chinese_library_manager_is_found(self):
        library = types.SimpleNamespace(get_name=lambda: 'Standard')
        manager = types.SimpleNamespace(get_name=lambda: '库管理器', get_children=lambda _: [library])
        project = types.SimpleNamespace(find=lambda name, _: [manager] if name == '库管理器' else [],
                                        get_children=lambda _: [manager])
        code, output = run_script('list_project_libraries.py', {},
                                  {'PROJECT_FILE_PATH':'test.project',
                                   'ensure_project_open':lambda _:project})
        self.assertEqual(code, 0)
        self.assertIn('Standard', output)

    def test_missing_library_manager_is_error_not_empty_success(self):
        project = types.SimpleNamespace(find=lambda *args: [], get_children=lambda _: [])
        code, output = run_script('list_project_libraries.py', {},
                                  {'PROJECT_FILE_PATH':'test.project',
                                   'ensure_project_open':lambda _:project})
        self.assertEqual(code, 1)
        self.assertIn('SCRIPT_ERROR', output)

    def test_pou_rename_updates_task_call(self):
        class Node:
            def __init__(self, name, children=None, **flags):
                self.value, self.children = name, children or []
                self.__dict__.update(flags)
            def get_name(self): return self.value
            def set_name(self, value): self.value = value
            def get_children(self, recursive):
                return self.children + ([node for child in self.children
                                         for node in child.get_children(True)] if recursive else [])
        call = Node('POU1')
        task = Node('MainTask', [call], is_task=True)
        app = Node('Application', [task])
        pou = Node('POU1', is_pou=True)
        project = types.SimpleNamespace(save=self.save)
        code, output = run_script('rename_object.py', {'OBJECT_PATH':'Application/POU1', 'NEW_NAME':'PLC_PRG'},
                                  {'PROJECT_FILE_PATH':'test.project', 'ensure_project_open':lambda _:project,
                                   'find_object_by_path_robust':lambda _, path, __:app if path == 'Application' else pou})
        self.assertEqual(code, 0)
        self.assertEqual(pou.get_name(), 'PLC_PRG')
        self.assertEqual(call.get_name(), 'PLC_PRG')
        self.assertIn('Task calls updated: 1', output)

    def test_pou_rename_rolls_back_when_task_call_rejects_change(self):
        class Node:
            def __init__(self, value, children=None):
                self.value, self.children = value, children or []
            def get_name(self): return self.value
            def set_name(self, value):
                if self is call and value == 'PLC_PRG':
                    raise RuntimeError('task call refused rename')
                self.value = value
            def get_children(self, recursive):
                return self.children + ([node for child in self.children
                                         for node in child.get_children(True)] if recursive else [])
        call = Node('POU1')
        task = Node('MainTask', [call]); task.is_task = True
        app = Node('Application', [task])
        pou = Node('POU1'); pou.is_pou = True
        project = types.SimpleNamespace(save=self.save)
        code, output = run_script('rename_object.py', {'OBJECT_PATH':'Application/POU1', 'NEW_NAME':'PLC_PRG'},
                                  {'PROJECT_FILE_PATH':'test.project', 'ensure_project_open':lambda _:project,
                                   'find_object_by_path_robust':lambda _, path, __:app if path == 'Application' else pou})
        self.assertEqual(code, 1)
        self.assertEqual(pou.get_name(), 'POU1')
        self.assertEqual(call.get_name(), 'POU1')
        self.assertIn('task call refused rename', output)

    def test_shutdown_save_reports_real_failure(self):
        failing = types.SimpleNamespace(path='test.project', save=lambda: (_ for _ in ()).throw(RuntimeError('disk full')))
        module = types.ModuleType('scriptengine')
        module.projects = types.SimpleNamespace(primary=failing)
        code, output = run_script('save_primary_for_shutdown.py', {}, {}, module)
        self.assertEqual(code, 1)
        self.assertIn('disk full', output)

class OnlineTests(unittest.TestCase):
    def setUp(self):
        self.calls=[]
        self.project=object()
        self.online=types.SimpleNamespace(is_logged_in=True,
          get_prepared_expressions=lambda:[],
          set_prepared_value=lambda *a:self.calls.append(('prepare',a)),
          write_prepared_values=lambda:self.calls.append(('write',)),
          force_prepared_values=lambda:self.calls.append(('force',)),
          login=lambda *a:self.calls.append(('login',a)))
        self.env={'PROJECT_FILE_PATH':'p.project','ensure_project_open':lambda _:self.project,
          'ensure_online_connection':lambda _:(self.online,object()),'select_online_application':lambda _:object(),'with_executor':lambda f,*a:f(*a)}
        self.module=types.ModuleType('scriptengine')
        self.module.OnlineChangeOption=types.SimpleNamespace(Force='online-only',Never='full',Keep='keep')
    def test_normal_write_never_forces(self):
        code,_=run_script('write_variable.py',{'VARIABLE_PATH':'PLC_PRG.x','VARIABLE_VALUE':'TRUE'},self.env,self.module)
        self.assertEqual(code,0);self.assertIn(('write',),self.calls);self.assertNotIn(('force',),self.calls)
        self.assertEqual(self.calls[-1],('prepare',('PLC_PRG.x',None)))
    def test_prepared_values_from_another_editor_are_not_committed(self):
        self.online.get_prepared_expressions=lambda:['Other.output']
        code,_=run_script('write_variable.py',{'VARIABLE_PATH':'x','VARIABLE_VALUE':'1'},self.env,self.module)
        self.assertEqual(code,1);self.assertEqual(self.calls,[])
    def test_no_write_api_does_not_fall_back_to_force(self):
        del self.online.write_prepared_values
        code,_=run_script('write_variable.py',{'VARIABLE_PATH':'x','VARIABLE_VALUE':'1'},self.env,self.module)
        self.assertEqual(code,1);self.assertEqual(self.calls,[])
    def test_download_enums_follow_official_meaning(self):
        for mode,expected in [('online_change','online-only'),('full','full')]:
            self.calls=[]
            code,_=run_script('download_to_device.py',{'MODE':mode},self.env,self.module)
            self.assertEqual(code,0);self.assertEqual(self.calls,[('login',(expected,False))])
    def test_rejected_online_change_is_not_retried_as_full(self):
        def rejected(*args): self.calls.append(args);raise RuntimeError('unsupported')
        self.online.login=rejected
        code,_=run_script('download_to_device.py',{'MODE':'online_change'},self.env,self.module)
        self.assertEqual(code,1);self.assertEqual(len(self.calls),1)
    def test_connect_uses_keep_only(self):
        code,_=run_script('connect_to_device.py',{'IP_ADDRESS':'','GATEWAY_NAME':''},self.env,self.module)
        self.assertEqual(code,0);self.assertEqual(self.calls,[('login',('keep',False))])

class SearchTests(unittest.TestCase):
    def search(self, text, **params):
        results = []
        node = types.SimpleNamespace(get_name=lambda:'ST06_去核', get_children=lambda _:[],
            textual_declaration=Text(''), textual_implementation=Text(text))
        if params.pop('broken_children', False):
            def broken(_): raise RuntimeError('子节点读取失败')
            node.get_children = broken
        project = types.SimpleNamespace(get_children=lambda _:[node])
        values = dict(PATTERN='去核',USE_REGEX='1',CASE_SENSITIVE='1',INCLUDE_DECL='0',INCLUDE_IMPL='1',MAX_HITS='10')
        values.update(params)
        code, output = run_script('search_code.py', values, dict(PROJECT_FILE_PATH='中文.project',
            ensure_project_open=lambda _:project, emit_result=results.append))
        return code, results, output

    def test_chinese_hit_and_exact_limit_is_not_truncated(self):
        code, results, _ = self.search('去核 := TRUE;', MAX_HITS='1')
        self.assertEqual(code,0); self.assertEqual(results[0]['count'],1)
        self.assertTrue(results[0]['complete']); self.assertFalse(results[0]['truncated'])

    def test_limit_proves_an_extra_match_exists(self):
        _, results, _ = self.search('去核 去核',MAX_HITS='1')
        self.assertTrue(results[0]['truncated']); self.assertFalse(results[0]['complete'])

    def test_traversal_errors_are_visible_with_zero_hits(self):
        _, results, _ = self.search('x := TRUE;',broken_children=True)
        self.assertEqual(results[0]['count'],0); self.assertFalse(results[0]['complete'])
        self.assertIn('子节点',results[0]['read_errors'][0]['error'])

    def test_literal_metacharacters_and_invalid_regex(self):
        code, results, _ = self.search('去核[0]',PATTERN='去核[0]',USE_REGEX='0')
        self.assertEqual(code,0); self.assertEqual(results[0]['count'],1)
        code, results, _ = self.search('x',PATTERN='[')
        self.assertEqual(code,1); self.assertEqual(results,[])

class SyntaxTests(unittest.TestCase):
    def test_all_python_templates_parse(self):
        for p in SCRIPTS.glob('*.py'):
            # Templates contain placeholders inside strings; Python 3 parsing
            # catches syntax regressions, but is not an IronPython 2.7 runtime test.
            with self.subTest(file=p.name): ast.parse(p.read_text(encoding='utf8'))

if __name__=='__main__': unittest.main()

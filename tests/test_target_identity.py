"""Offline regression tests for unambiguous online/simulation targets."""
import contextlib
import io
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'src/scripts'


class TargetIdentityTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.engine = types.ModuleType('scriptengine')
        self.engine.OnlineChangeOption = types.SimpleNamespace(Keep='keep')
        self.engine.online = types.SimpleNamespace(gateways=[], create_online_application=lambda app: self.online)
        self.online = types.SimpleNamespace(login=self.login)
        self.app = types.SimpleNamespace(is_application=True, get_name=lambda: 'Application')
        self.device = types.SimpleNamespace(get_gateway=lambda: 'g1',
            set_gateway_and_address=lambda *a: self.calls.append(('address', a)))
        self.children = [self.device, self.app]
        self.project = types.SimpleNamespace(active_application=None, get_children=lambda _: self.children,
                                             save=lambda: self.calls.append(('save',)))
        self.env = {'unicode':str, 'PROJECT_FILE_PATH':'mock.project',
                    'ensure_project_open':lambda _:self.project}
        exec((SCRIPTS/'ensure_online_connection.py').read_text(encoding='utf8'), self.env)
        self.env['with_executor'] = lambda fn,*args:fn(*args)

    def login(self, *args):
        self.calls.append(('login',args))

    def run_template(self, name, params):
        source = (SCRIPTS/name).read_text(encoding='utf8')
        for key,value in params.items():
            source = source.replace('{'+key+'}', value)
        out = io.StringIO()
        with patch.dict(sys.modules, {'scriptengine':self.engine}), contextlib.redirect_stdout(out):
            try:
                exec(compile(source,name,'exec'),self.env)
            except SystemExit as e:
                return e.code,out.getvalue()
        return 0,out.getvalue()

    def gateway(self, nodes):
        def scan():
            self.calls.append(('scan',))
            return [types.SimpleNamespace(address=a,device_name=n) for a,n in nodes]
        self.engine.online.gateways=[types.SimpleNamespace(guid='g1',name='Gateway-1',perform_network_scan=scan)]

    def resolve(self,address=None):
        with patch.dict(sys.modules, {'scriptengine':self.engine}):
            return self.env['resolve_device_address'](self.project,address)

    def test_sole_application_accepted(self):
        self.assertIs(self.env['select_online_application'](self.project),self.app)

    def test_explicit_active_application_accepted_with_multiple_apps(self):
        self.children.append(types.SimpleNamespace(is_application=True))
        self.project.active_application=self.app
        self.assertIs(self.env['select_online_application'](self.project),self.app)

    def test_multiple_apps_without_active_refused(self):
        self.children.append(types.SimpleNamespace(is_application=True))
        with self.assertRaisesRegex(RuntimeError,'TARGET_AMBIGUOUS'):
            self.env['select_online_application'](self.project)
        self.assertIsNone(self.project.active_application)

    def test_no_application_refused(self):
        self.children=[self.device]
        with self.assertRaisesRegex(RuntimeError,'TARGET_AMBIGUOUS'):
            self.env['select_online_application'](self.project)

    def test_scan_requires_explicit_address(self):
        self.gateway([('0301.BAD0','Device')])
        with self.assertRaisesRegex(RuntimeError,'TARGET_REQUIRED'):self.resolve()
        self.assertEqual(self.calls,[])

    def test_single_wrong_scan_node_refused(self):
        self.gateway([('0301.BAD0','Device')])
        with self.assertRaisesRegex(RuntimeError,'TARGET_AMBIGUOUS'):self.resolve('0301.CAFE')
        self.assertEqual(self.calls,[('scan',)])

    def test_multiple_same_type_nodes_are_not_identity(self):
        self.gateway([('0301.BAD0','Device'),('0301.BAD1','Device')])
        with self.assertRaisesRegex(RuntimeError,'TARGET_AMBIGUOUS'):self.resolve('192.168.1.100')
        self.assertEqual(self.calls,[('scan',)])

    def test_exact_unique_node_accepted(self):
        self.gateway([('0301.BAD0','Other'),('0301.CAFE','Device')])
        self.assertEqual(self.resolve('0301.cafe'),'0301.CAFE')
        self.assertEqual(self.calls[-1],('address',('Gateway-1','0301.CAFE')))

    def test_duplicate_exact_addresses_refused(self):
        self.gateway([('0301.CAFE','A'),('0301.CAFE','B')])
        with self.assertRaisesRegex(RuntimeError,'TARGET_AMBIGUOUS'):self.resolve('0301.CAFE')
        self.assertEqual(self.calls,[('scan',)])

    def test_resolver_multiple_devices_refused(self):
        self.children.append(self.device)
        with self.assertRaisesRegex(RuntimeError,'TARGET_AMBIGUOUS'):self.resolve('0301.CAFE')
        self.assertEqual(self.calls,[])

    def test_connect_preserves_ip_without_scanning(self):
        self.gateway([('0301.BAD0','WrongPLC')])
        code,out=self.run_template('connect_to_device.py',{'IP_ADDRESS':'192.168.1.100','GATEWAY_NAME':'Gateway-1'})
        self.assertEqual(code,0,out)
        self.assertEqual(self.calls,[('address',('Gateway-1','192.168.1.100')),('login',('keep',False))])

    def test_connect_ambiguous_apps_has_no_address_or_login(self):
        self.children.append(types.SimpleNamespace(is_application=True))
        code,out=self.run_template('connect_to_device.py',{'IP_ADDRESS':'192.168.1.100','GATEWAY_NAME':''})
        self.assertEqual(code,1,out)
        self.assertIn('TARGET_AMBIGUOUS',out)
        self.assertEqual(self.calls,[])

    def test_connect_ambiguous_devices_has_no_address_or_login(self):
        self.children.append(self.device)
        code,out=self.run_template('connect_to_device.py',{'IP_ADDRESS':'192.168.1.100','GATEWAY_NAME':''})
        self.assertEqual(code,1,out)
        self.assertEqual(self.calls,[])

    def test_native_ip_failure_is_not_retried(self):
        def fail(*args):
            self.calls.append(('login',args))
            raise RuntimeError('No route to host')
        self.online.login=fail
        code,out=self.run_template('connect_to_device.py',{'IP_ADDRESS':'192.168.1.100','GATEWAY_NAME':''})
        self.assertEqual(code,1,out)
        self.assertIn('No route to host',out)
        self.assertEqual(sum(c[0]=='login' for c in self.calls),1)
        self.assertFalse(any(c[0]=='scan' for c in self.calls))

    def simulation_device(self,name):
        device=types.SimpleNamespace(get_name=lambda:name,is_simulation_mode=False)
        def set_mode(value):
            self.calls.append(('simulation',name,value))
            device.is_simulation_mode=value
        device.set_simulation_mode=set_mode
        return device

    def test_simulation_single_device_accepted(self):
        self.children=[self.simulation_device('PLC_A')]
        code,out=self.run_template('set_simulation_mode.py',{'ENABLE':'true'})
        self.assertEqual(code,0,out)
        self.assertIn(('simulation','PLC_A',True),self.calls)

    def test_simulation_no_device_refused(self):
        self.children=[]
        code,out=self.run_template('set_simulation_mode.py',{'ENABLE':'true'})
        self.assertEqual(code,1,out)
        self.assertEqual(self.calls,[])

    def test_simulation_multiple_devices_refused_even_named_device(self):
        self.children=[self.simulation_device('Device'),self.simulation_device('PLC_B')]
        code,out=self.run_template('set_simulation_mode.py',{'ENABLE':'true'})
        self.assertEqual(code,1,out)
        self.assertIn('TARGET_AMBIGUOUS',out)
        self.assertEqual(self.calls,[])


if __name__=='__main__':
    unittest.main()

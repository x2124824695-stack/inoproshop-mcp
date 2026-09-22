"""Persistent IPC worker. Claims requests before dispatch; never replays them."""
import sys
import os
import time
import traceback
import json
import re

IPC_BASE_DIR = "{IPC_BASE_DIR}"
COMMANDS_DIR = os.path.join(IPC_BASE_DIR, "commands")
RESULTS_DIR = os.path.join(IPC_BASE_DIR, "results")
WATCHER_VERSION = "{WATCHER_VERSION}"
SESSION_TOKEN = "{SESSION_TOKEN}"
POLL_INTERVAL = 50


def safe_text(value):
    try:
        if isinstance(value, unicode):
            return value
        if isinstance(value, bytes):
            return value.decode('utf-8', 'replace')
        return unicode(value)
    except BaseException:
        try:
            return u' '.join(safe_text(a) for a in value.args)
        except BaseException:
            return u'<unprintable error>'


def error_text(error):
    message = u'%s: %s' % (safe_text(type(error).__name__), safe_text(error))
    try:
        return message + u'\n' + safe_text(traceback.format_exc())
    except BaseException:
        return message


def _log(msg):
    try:
        with open(os.path.join(IPC_BASE_DIR, 'watcher.log'), 'ab') as f:
            f.write((u'[%f] %s\n' % (time.time(), safe_text(msg))).encode('utf-8'))
    except BaseException:
        pass


def atomic_write(file_path, content):
    tmp_path = file_path + '.tmp'
    with open(tmp_path, 'wb') as f:
        f.write(safe_text(content).encode('utf-8'))
        f.flush()
        os.fsync(f.fileno())
    # Readers must never see a partial result or a remove/rename gap.
    from System.IO import File
    if os.path.exists(file_path):
        File.Replace(tmp_path, file_path, None)
    else:
        File.Move(tmp_path, file_path)


def publish(result):
    # IronPython's ensure_ascii=True encoder can fail for unicode input.
    atomic_write(os.path.join(RESULTS_DIR, result['requestId'] + '.result.json'),
                 json.dumps(result, ensure_ascii=False))


class OutputCapture:
    encoding = 'utf-8'
    _mcp_unicode_output = True

    def __init__(self):
        self._buffer = []

    def write(self, text):
        self._buffer.append(safe_text(text))

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        pass

    def getvalue(self):
        return u''.join(self._buffer)


def has_marker(output, name):
    return any(line == name or line.startswith(name + ':') for line in output.splitlines())


def _do_exec(code, globs):
    # Module-level exec is required by IronPython 2.7.
    exec(code, globs)


def process_command(command_file):
    if not re.match(r'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\.command\.json$', command_file):
        raise ValueError('Invalid command filename')
    request_id = command_file[:-len('.command.json')]
    command_path = os.path.join(COMMANDS_DIR, command_file)
    claimed_path = os.path.join(COMMANDS_DIR, request_id + '.running.json')
    result_path = os.path.join(RESULTS_DIR, request_id + '.result.json')
    script_path = os.path.join(COMMANDS_DIR, request_id + '.py')
    if os.path.exists(claimed_path) or os.path.exists(result_path):
        return
    if not os.path.exists(command_path):
        return
    os.rename(command_path, claimed_path)
    # Failures retain .running.json. Polling never dispatches claimed records.
    result = {'requestId': request_id, 'success': False, 'output': u'',
              'error': u'', 'timestamp': time.time() * 1000}
    try:
        with open(claimed_path, 'rb') as f:
            command = json.loads(f.read().decode('utf-8'))
        if command.get('sessionToken') != SESSION_TOKEN or command.get('requestId') != request_id:
            raise ValueError('Session token or request identity mismatch')
        if time.time() * 1000 > command.get('deadline', 0):
            raise ValueError('Command expired before execution; not applied')
        if os.path.normcase(os.path.abspath(command.get('scriptPath', ''))) != os.path.normcase(os.path.abspath(script_path)):
            raise ValueError('Script path must match session request')
        with open(script_path, 'rb') as f:
            script_code = f.read().decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
    except BaseException as e:
        result['error'] = u'Read error: ' + error_text(e)
        publish(result)
        retire(claimed_path, script_path)
        return

    done = ManualResetEvent(False)

    def execute_on_ui():
        old_stdout, old_stderr = sys.stdout, sys.stderr
        capture = OutputCapture()
        exit_ok = False
        try:
            sys.stdout = sys.stderr = capture
            if time.time() * 1000 > command.get('deadline', 0):
                raise RuntimeError('Command expired before UI execution; not applied')
            _do_exec(script_code, {'__builtins__': __builtins__, 'sys': sys, 'os': os,
                                  'time': time, 'traceback': traceback, 'shutil': __import__('shutil')})
            exit_ok = True
        except SystemExit as e:
            exit_ok = e.code is None or e.code == 0
            if not exit_ok:
                result['error'] = u'Script exited: ' + safe_text(e.code)
        except BaseException as e:
            result['error'] = error_text(e)
        finally:
            sys.stdout, sys.stderr = old_stdout, old_stderr
            try:
                result['output'] = capture.getvalue()
                result['success'] = exit_ok and has_marker(result['output'], 'SCRIPT_SUCCESS') and not has_marker(result['output'], 'SCRIPT_ERROR')
                if not result['success'] and not result['error']:
                    result['error'] = u'Script did not report verified success'
                result['timestamp'] = time.time() * 1000
            finally:
                done.Set()

    try:
        se.system.execute_on_primary_thread(execute_on_ui)
    except BaseException as e:
        # Callback may already be queued. Keep UNKNOWN instead of unlocking.
        _log(u'Marshal outcome unknown: ' + error_text(e))
        return
    # Node timeout is not cancellation. Wait for actual completion.
    done.WaitOne()
    publish(result)
    retire(claimed_path, script_path)


def retire(*paths):
    for item in paths:
        try:
            os.remove(item)
        except OSError:
            pass


def worker():
    _log('Worker started')
    while not _stop_event.WaitOne(POLL_INTERVAL):
        try:
            stop_path = os.path.join(IPC_BASE_DIR, 'terminate.signal')
            if os.path.exists(stop_path):
                with open(stop_path, 'rb') as f:
                    stop = json.loads(f.read().decode('utf-8'))
                if stop.get('sessionToken') == SESSION_TOKEN:
                    break
            for name in sorted(os.listdir(COMMANDS_DIR)):
                if name.endswith('.command.json'):
                    process_command(name)
                    break
        except BaseException as e:
            _log(u'Worker error: ' + error_text(e))
    retire(os.path.join(IPC_BASE_DIR, 'ready.signal'))


try:
    for directory in (COMMANDS_DIR, RESULTS_DIR):
        if not os.path.exists(directory):
            os.makedirs(directory)
    import clr
    import scriptengine as se
    from System.Threading import Thread, ThreadStart, ManualResetEvent
    _stop_event = ManualResetEvent(False)
    t = Thread(ThreadStart(worker))
    t.IsBackground = True
    atomic_write(os.path.join(IPC_BASE_DIR, 'ready.signal'), json.dumps({
        'version': WATCHER_VERSION, 'sessionToken': SESSION_TOKEN,
        'pid': os.getpid(), 'timestamp': time.time() * 1000}, ensure_ascii=False))
    t.Start()
    import System
    System.GC.KeepAlive(t)
    print('[WATCHER] Ready v%s' % WATCHER_VERSION)
except BaseException as e:
    _log(u'Watcher startup failed: ' + error_text(e))
    retire(os.path.join(IPC_BASE_DIR, 'ready.signal'))
    raise

"""Validate the existing IDE before installing a watcher. No project writes."""
import os
import json
import time
import scriptengine as se
from System.Diagnostics import Process

_attach_dir = "{IPC_BASE_DIR}"
_attach_token = "{SESSION_TOKEN}"
_attach_identity = "{SESSION_ID}"
_attach_exe = "{CODESYS_PATH}"
_attach_project = "{PROJECT_FILE_PATH}"


def _attach_normalize(value):
    return os.path.normcase(os.path.abspath(value))


with open(os.path.join(_attach_dir, 'attachment.json'), 'rb') as _f:
    _prepared = json.loads(_f.read().decode('utf-8'))
if (_prepared.get('identity') != _attach_identity or
        _prepared.get('token') != _attach_token or
        _attach_normalize(_prepared.get('projectFilePath', '')) != _attach_normalize(_attach_project)):
    raise RuntimeError('Attachment script is obsolete or does not match the prepared session.')

_process = Process.GetCurrentProcess()
if _attach_normalize(_process.MainModule.FileName) != _attach_normalize(_attach_exe):
    raise RuntimeError('Attachment must run in the configured InoProShop executable.')
_primary = se.projects.primary
if _primary is None or _attach_normalize(_primary.path) != _attach_normalize(_attach_project):
    raise RuntimeError('The requested project must already be primary; attachment will not open or switch projects.')

_meta_path = os.path.join(_attach_dir, 'session.json')
if os.path.exists(_meta_path):
    with open(_meta_path, 'rb') as _f:
        _old_meta = json.loads(_f.read().decode('utf-8'))
    _live = None
    try:
        _live = Process.GetProcessById(int(_old_meta.get('pid', 0)))
    except Exception:
        pass
    if _live is not None:
        raise RuntimeError('A live watcher session already exists; refusing duplicate bootstrap.')

# The watcher publishes this only after its startup prerequisites have succeeded.
_attach_metadata = dict(pid=int(_process.Id), token=_attach_token, identity=_attach_identity,
                        version="{WATCHER_VERSION}", startedAt=time.time()*1000,
                        attached=True)

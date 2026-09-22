import sys, scriptengine as script_engine, traceback
VARIABLE_PATH = "{VARIABLE_PATH}"
VARIABLE_VALUE = "{VARIABLE_VALUE}"
try:
    project = ensure_project_open(PROJECT_FILE_PATH)
    online_app, app = ensure_online_connection(project)
    if not getattr(online_app, 'is_logged_in', False): raise RuntimeError("Connect first")
    required = ('set_prepared_value', 'write_prepared_values', 'get_prepared_expressions')
    if not all(hasattr(online_app, name) for name in required):
        raise TypeError("Target does not expose verified one-shot write API; forcing is never a fallback")
    prepared = list(with_executor(online_app.get_prepared_expressions))
    if prepared: raise RuntimeError("Existing prepared values must be resolved in the IDE before this write")
    try:
        with_executor(online_app.set_prepared_value, VARIABLE_PATH, VARIABLE_VALUE)
        with_executor(online_app.write_prepared_values)
    finally:
        with_executor(online_app.set_prepared_value, VARIABLE_PATH, None)
    print("SCRIPT_SUCCESS: Value written once (not forced)")
    sys.exit(0)
except Exception as e:
    print("SCRIPT_ERROR: %s" % e)
    sys.exit(1)

import sys, scriptengine as script_engine, traceback
MODE = "{MODE}"
try:
    project = ensure_project_open(PROJECT_FILE_PATH)
    online_app, app = ensure_online_connection(project)
    if not hasattr(script_engine, 'OnlineChangeOption'): raise TypeError("OnlineChangeOption unavailable; refusing implicit download")
    # Official CODESYS semantics: Force = online change only; Never = full download.
    if MODE == 'online_change': option = script_engine.OnlineChangeOption.Force
    elif MODE == 'full': option = script_engine.OnlineChangeOption.Never
    else: raise ValueError("Explicit online_change or full mode required")
    with_executor(online_app.login, option, False)
    print("SCRIPT_SUCCESS: Download completed; boot application was not changed")
    sys.exit(0)
except Exception as e:
    print("SCRIPT_ERROR: Download failed (no escalation/retry): %s" % e)
    sys.exit(1)

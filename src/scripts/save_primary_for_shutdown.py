import sys
import scriptengine as script_engine

try:
    # This session works on the primary project. Saving every open IDE project
    # can fail on an unrelated project after the requested one was saved.
    primary = script_engine.projects.primary
    if primary is None:
        print("SCRIPT_SUCCESS: No primary project open; watcher may stop.")
    else:
        project_path = getattr(primary, 'path', '<unknown>')
        primary.save()
        print("SCRIPT_SUCCESS: Primary project saved: %s" % project_path)
    sys.exit(0)
except Exception as error:
    print("SCRIPT_ERROR: Primary project save failed: %s" % error)
    sys.exit(1)

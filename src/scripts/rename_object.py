import sys, scriptengine as script_engine, os, traceback

OBJECT_PATH = "{OBJECT_PATH}"
NEW_NAME = "{NEW_NAME}"

try:
    print("DEBUG: rename_object script: ObjectPath='%s', NewName='%s', Project='%s'" % (OBJECT_PATH, NEW_NAME, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not OBJECT_PATH: raise ValueError("Object path empty.")
    if not NEW_NAME: raise ValueError("New name empty.")

    # Find the target object
    target_object = find_object_by_path_robust(primary_project, OBJECT_PATH, "target object")
    if not target_object:
        raise ValueError("Object not found at path: %s" % OBJECT_PATH)

    old_name = getattr(target_object, 'get_name', lambda: OBJECT_PATH)()
    target_type = type(target_object).__name__
    print("DEBUG: Found target object: %s (Type: %s)" % (old_name, target_type))

    def rename(node, new_name):
        if hasattr(node, 'set_name'):
            node.set_name(new_name)
        elif hasattr(node, 'rename'):
            node.rename(new_name)
        else:
            raise TypeError("Object '%s' does not support rename." % node.get_name())
        if node.get_name() != new_name:
            raise RuntimeError("Rename readback mismatch: %s" % new_name)

    # A POU's task-call node is a separate project object. Updating only the
    # POU leaves MainTask pointing at the old name even when compilation passes.
    calls = []
    path_parts = OBJECT_PATH.replace('\\', '/').split('/')
    looks_like_pou = (getattr(target_object, 'is_pou', False)
                      or hasattr(target_object, 'textual_declaration')
                      or 'pou' in target_type.lower())
    if looks_like_pou and 'Application' in path_parts:
        app_path = '/'.join(path_parts[:path_parts.index('Application') + 1])
        application = find_object_by_path_robust(primary_project, app_path, "application")
        if application is None:
            raise RuntimeError("Cannot locate application for task-call synchronization.")
        for node in application.get_children(True):
            if not (getattr(node, 'is_task', False) or hasattr(node, 'interval')):
                continue
            for call in node.get_children(False):
                if call.get_name() == old_name:
                    calls.append(call)

    changed = []
    try:
        changed.append(target_object)
        rename(target_object, NEW_NAME)
        for call in calls:
            changed.append(call)
            rename(call, NEW_NAME)
        primary_project.save()
    except Exception:
        # Restore all renamed nodes before reporting failure. If rollback
        # fails, report both errors so the operator knows to inspect the IDE.
        failure = traceback.format_exc()
        rollback_errors = []
        for node in reversed(changed):
            try:
                rename(node, old_name)
            except Exception as rollback_error:
                rollback_errors.append(str(rollback_error))
        try:
            primary_project.save()
        except Exception as rollback_error:
            rollback_errors.append(str(rollback_error))
        raise RuntimeError("Rename failed: %s; rollback errors: %s" %
                           (failure, ', '.join(rollback_errors) or 'none'))

    print("Object Renamed: '%s' -> '%s'" % (old_name, NEW_NAME))
    print("Object Type: %s" % target_type)
    print("Path: %s" % OBJECT_PATH)
    print("Task calls updated: %d" % len(calls))
    print("SCRIPT_SUCCESS: Object renamed successfully.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error renaming object '%s' in project '%s': %s\n%s" % (OBJECT_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

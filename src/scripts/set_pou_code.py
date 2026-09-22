import sys, scriptengine as script_engine, traceback, hashlib
POU_FULL_PATH = "{POU_FULL_PATH}"
DECLARATION_CONTENT = """{DECLARATION_CONTENT}"""
IMPLEMENTATION_CONTENT = """{IMPLEMENTATION_CONTENT}"""
EXPECTED_HASH = "{EXPECTED_HASH}"
UPDATE_DECL_FLAG = "{UPDATE_DECL}"
UPDATE_IMPL_FLAG = "{UPDATE_IMPL}"

try:
    project = ensure_project_open(PROJECT_FILE_PATH)
    obj = find_object_by_path_robust(project, POU_FULL_PATH, "POU")
    if obj is None: raise ValueError("POU not found at exact path")
    old_decl = _to_unicode(obj.textual_declaration.text) if hasattr(obj, 'textual_declaration') else u""
    old_impl = _to_unicode(obj.textual_implementation.text) if hasattr(obj, 'textual_implementation') else u""
    current_hash = hashlib.sha256((old_decl + u"\0" + old_impl).encode('utf-8')).hexdigest()
    if EXPECTED_HASH and current_hash != EXPECTED_HASH:
        raise ValueError("STALE_WRITE: POU changed since read; read it again before editing")
    changes = []
    for flag, attr, content in ((UPDATE_DECL_FLAG, 'textual_declaration', DECLARATION_CONTENT),
                                (UPDATE_IMPL_FLAG, 'textual_implementation', IMPLEMENTATION_CONTENT)):
        if flag == '1':
            part = getattr(obj, attr, None)
            if part is None or not hasattr(part, 'replace'): raise TypeError("Unsupported code section: " + attr)
            changes.append((part, _to_unicode(part.text), _to_unicode(content)))
    if not changes: raise ValueError("No code sections supplied")
    try:
        for part, old, new in changes:
            part.replace(new)
            if _to_unicode(part.text).replace('\r\n','\n') != new.replace('\r\n','\n'):
                raise RuntimeError("READBACK_MISMATCH: code was not stored as requested")
        project.save()
    except Exception:
        original_error = traceback.format_exc()
        rollback_errors = []
        for part, old, new in reversed(changes):
            try: part.replace(old)
            except Exception as e: rollback_errors.append(str(e))
        try: project.save()
        except Exception as e: rollback_errors.append(str(e))
        raise RuntimeError("Write failed; rollback errors=%s; cause=%s" % (rollback_errors, original_error))
    print("SCRIPT_SUCCESS: Code written, read back and saved")
    sys.exit(0)
except Exception as e:
    print("SCRIPT_ERROR: %s" % e)
    sys.exit(1)

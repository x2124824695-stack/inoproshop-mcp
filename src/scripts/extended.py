import sys, json, hashlib, traceback
import scriptengine as script_engine
ACTION = "{ACTION}"
ARGS = json.loads("""{ARGS_JSON}""")

def exact(project, path):
    obj = find_object_by_path_robust(project, path, "object")
    if obj is None: raise ValueError("Object not found at exact path: " + path)
    return obj

def name(obj):
    return _to_unicode(obj.get_name())

def task_info(t):
    item = {'name': name(t)}
    for attr in ('interval', 'interval_unit', 'priority', 'kind_of_task'):
        if hasattr(t, attr): item[attr] = _to_unicode(unicode(getattr(t, attr)))
    item['pous'] = [unicode(p) for p in t.pous] if hasattr(t, 'pous') else None
    return item

def task_config(project):
    app = exact(project, ARGS.get('applicationPath', 'Application'))
    matches = [c for c in app.get_children(False) if getattr(c, 'is_task_configuration', False)]
    if not matches:
        matches = [c for c in app.get_children(False) if hasattr(c, 'create_task')]
    if len(matches) != 1: raise TypeError("Cannot identify one task configuration on this target")
    return matches[0]

def protected(obj):
    return any(getattr(obj, k, False) for k in ('is_application', 'is_device', 'is_task_configuration', 'is_task'))

try:
    mutation = ACTION in ('move', 'create_task', 'set_task')
    project = ensure_project_open(PROJECT_FILE_PATH) if mutation else require_project_open(PROJECT_FILE_PATH)
    result = None
    if ACTION == 'structure':
        result = {'nodes': [], 'truncated': False}
        def visit(obj, parent, depth):
            if len(result['nodes']) >= ARGS['maxNodes']:
                result['truncated'] = True
                return
            current = parent + '/' + name(obj) if parent else name(obj)
            result['nodes'].append({'path': current, 'type': type(obj).__name__})
            children = list(obj.get_children(False))
            if depth >= ARGS['maxDepth']:
                if children: result['truncated'] = True
                return
            for child in children: visit(child, current, depth + 1)
        for root in project.get_children(False): visit(root, '', 1)
    elif ACTION == 'code':
        obj = exact(project, ARGS['pouPath'])
        decl = _to_unicode(obj.textual_declaration.text) if hasattr(obj, 'textual_declaration') else u''
        impl = _to_unicode(obj.textual_implementation.text) if hasattr(obj, 'textual_implementation') else u''
        result = {'path': ARGS['pouPath'], 'declaration': decl, 'implementation': impl,
                  'hash': hashlib.sha256((decl + u'\0' + impl).encode('utf-8')).hexdigest()}
    elif ACTION == 'move':
        old_path = ARGS['objectPath'].replace('\\', '/').strip('/')
        new_path = ARGS['newParentPath'].replace('\\', '/').strip('/')
        if '/' not in old_path or new_path == old_path or new_path.startswith(old_path + '/'):
            raise ValueError('Invalid move target or top-level object')
        obj, parent = exact(project, old_path), exact(project, new_path)
        if protected(obj): raise ValueError('Cannot move system/device/task object')
        if any(name(c) == name(obj) for c in parent.get_children(False)): raise ValueError('Destination name already exists')
        old_parent = exact(project, old_path.rsplit('/', 1)[0])
        try:
            obj.move(parent, -1)
            if not any(c == obj for c in parent.get_children(False)): raise RuntimeError('Move readback failed')
            project.save()
        except Exception:
            obj.move(old_parent, -1)
            project.save()
            raise
        result = {'oldPath': old_path, 'newPath': new_path + '/' + name(obj)}
    elif ACTION == 'params':
        obj = exact(project, ARGS['devicePath'])
        if not hasattr(obj, 'connectors'): raise TypeError('Device connector API unavailable')
        result = []
        for connector in obj.connectors:
            if not hasattr(connector, 'host_parameters'): continue
            for p in connector.host_parameters:
                result.append({'connector': unicode(getattr(connector, 'connector_id', '')),
                    'id': unicode(getattr(p, 'identifier', getattr(p, 'id', ''))), 'name': unicode(getattr(p, 'name', '')),
                    'value': unicode(getattr(p, 'value', ''))})
        if not result: raise TypeError('No readable host parameters exposed by target')
    elif ACTION == 'tasks':
        result = [task_info(t) for t in task_config(project).get_children(False) if getattr(t, 'is_task', hasattr(t, 'interval'))]
    elif ACTION in ('create_task', 'set_task'):
        interval, unit, priority = ARGS.get('interval'), ARGS.get('intervalUnit'), ARGS.get('priority')
        if (interval is None) != (unit is None): raise ValueError('interval and intervalUnit must be supplied together')
        if interval is not None and float(interval) <= 0: raise ValueError('interval must be positive')
        if ACTION == 'set_task' and interval is None and priority is None: raise ValueError('No changes supplied')
        tc = task_config(project)
        matches = [t for t in tc.get_children(False) if name(t) == ARGS['taskName']]
        if ACTION == 'create_task' and matches: raise ValueError('Task already exists')
        if ACTION == 'set_task' and len(matches) != 1: raise ValueError('Task not uniquely found')
        t = tc.create_task(ARGS['taskName']) if ACTION == 'create_task' else matches[0]
        if t is None: raise RuntimeError('Task API returned None')
        before = {}
        try:
            if ACTION == 'create_task':
                if not hasattr(script_engine, 'KindOfTask'):
                    raise TypeError('Cyclic task kind API unavailable on target')
                t.kind_of_task = script_engine.KindOfTask.Cyclic
            if interval is not None and hasattr(script_engine, 'KindOfTask') and t.kind_of_task != script_engine.KindOfTask.Cyclic:
                raise ValueError('Interval changes are only supported for cyclic tasks')
            updates = {}
            if interval is not None: updates.update({'interval_unit': unit, 'interval': interval})
            if priority is not None: updates['priority'] = str(priority)
            for attr in updates: before[attr] = getattr(t, attr)
            for attr in ('interval_unit','interval','priority'):
                if attr in updates:
                    setattr(t, attr, updates[attr])
                    if unicode(getattr(t, attr)) != unicode(updates[attr]): raise RuntimeError('Task readback mismatch: ' + attr)
            project.save()
        except Exception:
            if ACTION == 'create_task': t.remove()
            else:
                for attr, value in before.items(): setattr(t, attr, value)
            project.save()
            raise
        result = task_info(t)
    else:
        raise ValueError('Unknown action')
    emit_result(result)
    print('SCRIPT_SUCCESS: Operation verified')
    sys.exit(0)
except Exception as e:
    print('SCRIPT_ERROR: %s' % e)
    sys.exit(1)

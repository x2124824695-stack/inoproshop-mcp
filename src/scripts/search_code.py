import sys, scriptengine as script_engine, os, traceback, re

PATTERN = "{PATTERN}"
USE_REGEX = "{USE_REGEX}"  # "1" / "0"
CASE_SENSITIVE = "{CASE_SENSITIVE}"  # "1" / "0"
INCLUDE_DECL = "{INCLUDE_DECL}"  # "1" / "0"
INCLUDE_IMPL = "{INCLUDE_IMPL}"  # "1" / "0"
MAX_HITS_STR = "{MAX_HITS}"  # numeric string


def _compile_pattern(pattern_text, use_regex, case_sensitive):
    flags = re.UNICODE | (0 if case_sensitive else re.IGNORECASE)
    if use_regex:
        return re.compile(pattern_text, flags)
    # Plain-text search: escape any regex metachars so the literal string matches.
    return re.compile(re.escape(pattern_text), flags)


try:
    print("DEBUG: search_code: pattern='%s' regex=%s case=%s decl=%s impl=%s max=%s" %
          (PATTERN, USE_REGEX, CASE_SENSITIVE, INCLUDE_DECL, INCLUDE_IMPL, MAX_HITS_STR))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not PATTERN:
        raise ValueError("Search pattern empty.")

    use_regex = (USE_REGEX == "1")
    case_sensitive = (CASE_SENSITIVE == "1")
    include_decl = (INCLUDE_DECL == "1")
    include_impl = (INCLUDE_IMPL == "1")
    max_hits = int(MAX_HITS_STR) if MAX_HITS_STR else 1000
    if not 1 <= max_hits <= 10000:
        raise ValueError('maxHits must be between 1 and 10000')
    if not include_decl and not include_impl:
        raise ValueError('At least one source section must be selected')

    try:
        rx = _compile_pattern(PATTERN, use_regex, case_sensitive)
    except re.error as rx_err:
        raise ValueError("Invalid regex '%s': %s" % (PATTERN, rx_err))

    hits = []
    truncated = False
    # Track POU/object nodes whose body has no textual_implementation - these
    # are graphical languages (LD, FBD, CFC) that the textual search can't reach.
    skipped_graphical = []
    read_errors = []
    limits = {'truncated': False, 'visited': 0}

    def _scan(text, section, path):
        # Walks a body line-by-line. Lines stay 1-indexed for editor parity.
        if text is None:
            return
        text_u = _to_unicode(text)
        line_no = 0
        for line in text_u.splitlines():
            line_no += 1
            for m in rx.finditer(line):
                if len(hits) >= max_hits:
                    limits['truncated'] = True
                    return
                hits.append({
                    u"path": _to_unicode(path),
                    u"section": section,
                    u"line": line_no,
                    u"col": m.start() + 1,
                    u"text": line.rstrip(),
                    u"match": m.group(0),
                })

    def _walk(obj, path_prefix, depth=0):
        # Same traversal pattern get_all_pou_code uses, but inline-matching to
        # avoid hauling the entire project source out to the Node side just
        # to grep it again.
        if limits['truncated']:
            return
        limits['visited'] += 1
        if limits['visited'] > 10000 or depth > 64:
            limits['truncated'] = True
            return
        obj_name = _to_unicode(getattr(obj, 'get_name', lambda: '?')())
        current_path = "%s/%s" % (path_prefix, obj_name) if path_prefix else obj_name

        scanned_decl = False
        scanned_impl = False

        if include_decl and hasattr(obj, 'textual_declaration'):
            try:
                td = obj.textual_declaration
                if td and hasattr(td, 'text') and td.text:
                    _scan(td.text, u"declaration", current_path)
                    scanned_decl = True
            except Exception as e:
                read_errors.append({'path': current_path, 'section': 'declaration', 'error': _to_unicode(e)})

        if include_impl and hasattr(obj, 'textual_implementation'):
            try:
                ti = obj.textual_implementation
                if ti and hasattr(ti, 'text') and ti.text:
                    _scan(ti.text, u"implementation", current_path)
                    scanned_impl = True
            except Exception as e:
                read_errors.append({'path': current_path, 'section': 'implementation', 'error': _to_unicode(e)})

        # Heuristic: if the node looks like a POU (has either textual_*
        # attribute) but neither yielded text, it's a graphical body we can't
        # search. Report it so callers know coverage is incomplete.
        looks_like_pou = hasattr(obj, 'textual_declaration') or hasattr(obj, 'textual_implementation')
        if looks_like_pou and include_impl and not scanned_impl and hasattr(obj, 'textual_implementation'):
            skipped_graphical.append(_to_unicode(current_path))

        try:
            for child in obj.get_children(False):
                if limits['truncated']:
                    break
                _walk(child, current_path, depth + 1)
        except Exception as e:
            read_errors.append({'path': current_path, 'section': 'children', 'error': _to_unicode(e)})

    try:
        for child in primary_project.get_children(False):
            _walk(child, "")
            if limits['truncated']:
                break
    except Exception as e:
        read_errors.append({'path': '', 'section': 'children', 'error': _to_unicode(e)})

    truncated = limits['truncated']

    emit_result({
        u"hits": hits,
        u"count": len(hits),
        u"truncated": truncated,
        u"pattern": _to_unicode(PATTERN),
        u"regex": use_regex,
        u"case_sensitive": case_sensitive,
        u"skipped_graphical": skipped_graphical,
        u"skipped_graphical_count": len(skipped_graphical),
        u"read_errors": read_errors,
        u"complete": not (truncated or read_errors or skipped_graphical),
        u"visited_nodes": limits['visited'],
    })
    print("Total hits: %d (truncated=%s)" % (len(hits), truncated))
    print("SCRIPT_SUCCESS: search_code complete.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error in search_code for project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)

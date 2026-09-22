import sys, scriptengine as script_engine, os, traceback

IP_ADDRESS = "{IP_ADDRESS}"
GATEWAY_NAME = "{GATEWAY_NAME}"

try:
    print("DEBUG: connect_to_device: Project='%s' IP='%s' Gateway='%s'" % (
        PROJECT_FILE_PATH, IP_ADDRESS, GATEWAY_NAME))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    # Validate application identity before any gateway/address mutation.
    select_online_application(primary_project)

    if IP_ADDRESS:
        # The current tool has no devicePath parameter. Refuse multi-device
        # projects rather than changing the first device in traversal order.
        devices = [child for child in primary_project.get_children(True)
                   if hasattr(child, 'set_gateway_and_address')]
        if len(devices) != 1:
            raise RuntimeError(
                "TARGET_AMBIGUOUS: Explicit IP configuration requires exactly "
                "one device; found %d. Configure the intended device in the "
                "IDE and omit ipAddress." % len(devices)
            )
        gw = GATEWAY_NAME or "Gateway-1"
        devices[0].set_gateway_and_address(gw, IP_ADDRESS)
        # Preserve the exact requested IP. If native login cannot route it,
        # report that error. Never scan and substitute another node address.

    online_app, target_app = ensure_online_connection(primary_project)
    app_name = getattr(target_app, 'get_name', lambda: "Unknown")()

    if not hasattr(online_app, 'login'):
        raise TypeError("Online application does not support login().")

    # CODESYS V3 login signature is `login(OnlineChangeOption, bool)`.
    # Enum values on `scriptengine.OnlineChangeOption` are Force, Keep,
    # Never, Try. The 2nd arg controls whether differently-named
    # applications already on the PLC are deleted (False = keep them).
    # Call via with_executor so the scripting executor lifecycle is
    # driven, otherwise login can also hit "Stack empty" the same way
    # create_online_application does.
    print("DEBUG: Calling login...")
    if hasattr(script_engine, 'OnlineChangeOption'):
        with_executor(
            online_app.login,
            script_engine.OnlineChangeOption.Keep,
            False,
        )
        print("DEBUG: Logged in (OnlineChangeOption.Keep, keep_foreign=False).")
    else:
        # Older CODESYS SPs without the public OnlineChangeOption enum.
        raise TypeError("Keep-only login unavailable; refusing implicit code download")

    state = "connected"
    if hasattr(online_app, 'application_state'):
        try:
            state = str(with_executor(lambda: online_app.application_state))
        except Exception:
            pass

    print("Connected to device for application: %s" % app_name)
    print("Application State: %s" % state)
    print("SCRIPT_SUCCESS: Connected to device successfully.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error connecting to device for project %s: %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)

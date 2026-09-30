# 1.1.2：接入已经打开的 InoProShop

旧版常驻模式只能连接由 MCP 启动的 watcher，无法接入手动打开的 IDE。后台模式每次调用都会创建独立进程，读取工具却要求当前进程已经打开工程，导致“先打开、再读取”的两次调用无法共享上下文。

本次修复新增 `prepare_existing_session` 和 `attach_codesys`。准备步骤生成本地接入脚本；脚本在目标 IDE 中校验可执行文件和当前工程，之后启动 watcher。连接步骤核对会话 identity、token、协议版本和 PID，读取仍使用原有代码工具。

`--attach-existing` 会关闭自动启动，并阻止 `launch_codesys` 创建另一个窗口。与 `--read-only` 同时使用时不注册 `open_project`，避免读取过程中打开或切换工程。已有会话的未知请求、所有权锁和重复启动保护继续生效。后台读取在启动进程之前返回处理提示，避免反复冷启动后才报“未打开工程”。

接入脚本必须在目标 IDE 会话里执行一次。此后相同配置的 MCP 服务可以重新连接，无需再次运行脚本。仅启动外部 MCP 进程无法凭空取得另一 IDE 内的 ScriptEngine 对象。

验证包括 TypeScript 检查、真实 stdio 握手、接入身份与重复连接回归、Python 故障注入，以及厂商提供的 IronPython 语法和 Unicode 回归。实际 InoProShop 常驻会话的 `open_project` 和 `get_all_pou_code` 已成功执行；手动打开窗口的接入过程尚未完成端到端验证。

工程文件、工程源码、设备信息、本地接入脚本和读取结果不包含在此次提交中。

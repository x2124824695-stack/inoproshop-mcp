# InoProShop MCP Improved 1.1

面向汇川 InoProShop 的本地 stdio MCP 服务。它以用户提供的常驻版源码为主体，合并了 LIMIT-LMT 单文件版中有价值的工程读取、对象移动和任务配置能力，并修复了会造成误报、重复执行或在线操作升级的问题。

1.1 已通过 TypeScript、stdio 协议、故障注入和模拟 ScriptEngine 测试，并使用本机 InoProShop 自带的 IronPython 2.7.7 验证中文检索、全量读取和 Watcher 执行。此次验证没有启动 IDE 或连接 PLC；实际 ScriptEngine API、主线程调度和设备接口仍需按 [VALIDATION.md](VALIDATION.md) 验收。具体修复见 [AUDIT_1.1.md](AUDIT_1.1.md)。

## 核心行为

- 常驻 UI + 文件 IPC；MCP 初始化不等待 IDE 冷启动。
- exe、Profile、工作区和固定协议命名空间共同标识会话；同一会话只允许一个 MCP 服务持有。升级仍查找原会话，发现旧版活跃 Watcher 时拒绝另开 IDE。
- 所有工具串行执行。命令超时只代表结果未知，不会被当成取消，也不会自动重试；`get_command_status` 核对后用 `recover_session` 解锁。
- 工程路径限制在 `--workspace` 中，并解析既有父目录的真实路径，阻止 `..` 和目录联接逃逸。
- 修改已有工程文件前生成磁盘备份；审计日志不记录代码、密码或工具结果。
- `set_pou_code` 支持 `expectedHash` 乐观锁，写后读回校验；编辑或保存失败时回滚声明与实现。
- 编译结果必须取得结构化诊断；`fatal` 和 `error` 都返回失败，诊断缺失或严重级别未知时也失败。
- 中文脚本统一使用 UTF-8。模板参数只插值一轮，ST 中类似 `{UPDATE_IMPL}` 的文本不会被二次替换。
- 在线工具默认不注册；任意 IronPython 默认不注册。

## 环境

- Windows 10/11
- Node.js 18 或更高
- 已安装的 InoProShop 及准确的 Profile 名称
- 需要在线工具时，先在仿真环境或隔离台架完成目标版本验收

项目不再内置可能错误的 InoProShop 版本和安装路径。必须显式配置 `--codesys-path`、`--codesys-profile` 和 `--workspace`。

## 安装与构建

```powershell
npm ci --ignore-scripts
npm run check
```

`npm run check` 先检查并构建当前源码，再执行 Node/stdio 和 Python 故障注入测试，避免 stdio 测试误用旧 dist。测试不会启动 InoProShop。

## MCP 配置

把 [config/mcp.example.json](config/mcp.example.json) 复制为 Claude Code 项目根目录的 `.mcp.json`，替换三个绝对路径和实际 Profile：

```json
{
  "mcpServers": {
    "inoproshop": {
      "command": "node",
      "args": [
        "D:/path/to/inoproshop-mcp/dist/bin.js",
        "--codesys-path", "C:/path/to/InoProShop.exe",
        "--codesys-profile", "你的实际 Profile",
        "--workspace", "D:/PLC/Workspace"
      ]
    }
  }
}
```

Claude Code 可用 `claude mcp list` 或会话内 `/mcp` 检查连接。项目级 `.mcp.json` 首次使用时会要求信任该服务。

常用启动选项：

| 参数 | 行为 |
|---|---|
| `--no-auto-launch` | MCP 先连接，之后显式调用 `launch_codesys` |
| `--read-only` | 检查、显式启动/打开工程、已完成请求的恢复确认；退出时不保存工程 |
| `--enable-online` | 注册 PLC 连接、读取、写入、下载、启停和监视工具 |
| `--enable-python` | 注册 `eval_python`；仅限可信开发环境 |
| `--mode headless` | 每次命令启动无 UI 实例；不允许在线工具，中文已改为 UTF-8 |
| `--no-keep-alive` | 非只读模式退出时保存工程并停止 watcher；只读模式忽略此保存行为 |
| `--timeout 60000` | 默认命令结果等待时间，最小 1000 ms |

不要同时给同一个 exe/Profile/工作区启动多个 MCP 服务。服务会通过所有权文件拒绝第二个实例，不会杀掉用户正在使用的 IDE。

## 推荐工作流

1. `get_codesys_status`，确认 watcher 已就绪。
2. `open_project`，显式打开工作区内工程。
3. `get_project_structure`，用 `maxDepth` 和 `maxNodes` 控制输出。
4. `get_pou_code`，取得声明、实现和 `hash`。
5. `set_pou_code`，把上一步 `hash` 作为 `expectedHash`；服务会备份、写入、读回并保存。
6. `compile_project`；只在结构化诊断确认没有 fatal/error 时视为通过。
7. 再次 `get_pou_code` 或 `get_all_pou_code` 检查最终内容。

如果命令超时：

1. 不要重复原命令。
2. 调用 `get_command_status`。
3. 状态为 `completed` 时检查返回结果和工程；确认后调用 `recover_session`，参数 `{ "acknowledge": true }`。
4. 状态持续为 `unknown` 时，在 IDE 中检查工程和运行状态，再决定是否重启服务。

重启服务不会清除未知状态，也不会重新执行请求。若结果文件无法生成，必须人工核对工程和请求是否完成；`recover_session` 不允许强制解锁未知结果。

## 1.0 升级到 1.1

替换 MCP 文件并重启 MCP 服务即可加载 Node 端改进；IDE 中已运行的旧 Watcher 不会被热替换。新服务会识别并拒绝接管旧版 Watcher，同时保留状态核对功能。先处理未决结果，按现场流程保存并关闭旧 MCP 所属 IDE，再调用 `launch_codesys` 加载新版 Watcher。不要手动删除 `uncertain.json` 或重发未决命令。

## 结构化结果

所有工具保留原 `content` 文本，并提供 `structuredContent`：`schemaVersion`、`ok`、`tool`、`requestId`、`result`，失败时还有 `error.message`。这里的 `requestId` 是工具调用审计 ID；超时请求的 IPC ID 在 `get_command_status` 的 `result.requestId` 中。

```javascript
const response = await client.callTool({name: 'search_code', arguments: args});
if (response.isError) throw new Error(response.structuredContent.error.message);
const data = response.structuredContent.result;
// data.hits, count, truncated, complete, read_errors, skipped_graphical
```

检索结果的 `complete=false` 表示命中截断、图形语言未覆盖或节点读取失败；此时零命中不能证明工程里不存在引用。全量代码读取遇到遍历失败会明确报错，不再静默忽略。

## 在线工具的语义

只有加 `--enable-online` 才会注册在线工具。

- `connect_to_device` 使用 `OnlineChangeOption.Keep`，只连接已有应用，不隐式下载。
- `write_variable` 调用 `write_prepared_values()`，只写一次；发现其他已准备值时拒绝执行，绝不退化成强制变量。
- `download_to_device` 默认 `online_change`，对应官方 `OnlineChangeOption.Force`（强制只做在线修改，不能则失败）。
- `mode=full` 对应官方 `OnlineChangeOption.Never`（禁止在线修改，执行完整下载），并要求 `confirmFullDownload=true`。
- 在线修改失败不会自动升级为完整下载；下载工具不会顺带改写启动应用。
- `monitor_variables` 单次最多阻塞 UI 主线程 1 秒；长时间监控应由客户端分批调用。

在线写值、下载、启动和停止会影响真实控制器。先完成 [VALIDATION.md](VALIDATION.md) 中的仿真和隔离台架测试，再用于生产设备。

## 合并后的工具

默认提供项目、POU、DUT/GVL、库、设备配置、编译、归档、任务配置、状态和恢复工具。改进版新增或替换了以下关键接口：

- `get_project_structure`：有深度和节点上限的结构化对象树。
- `get_pou_code`：精确路径读取并返回 SHA-256。
- `move_object`：拒绝系统节点、重名目标和移动到自身子树。
- `get_device_params`：结构化读取连接器的 host parameters，不支持时明确失败。
- `get_task_config`：同时返回周期原值与单位，不假定固定为微秒。
- `create_task`、`set_task_config`：只处理循环任务，写后读回；失败时删除新任务或恢复旧字段。
- `get_capabilities`：返回本次启动实际注册的工具和安全开关。

完整列表由 `get_capabilities` 返回。工具注册成功只说明 MCP 端提供该接口，不代表目标 InoProShop/SP/设备描述符已实机验证。

## 与两份来源的取舍

RAR 常驻版适合作为主架构：源码完整、UI 可交互、具备在线和库/设备工具。GitHub 单文件版每次工具调用启动并杀掉一个 InoProShop 进程，适合简单离线任务，但速度、工程锁和未保存状态处理较弱。改进版保留常驻架构，并吸收单文件版的任务配置、对象移动、工程结构、单 POU 读取和设备参数读取；没有合并 GitHub 版的任意 `probe_api/customCode`，因为 `eval_python` 已被单独开关并默认关闭。

## 已知边界

- Python 模板使用 Python 3 做语法和模拟行为测试；这不是 IronPython 2.7/SP11 的完整兼容证明。
- 工程磁盘备份无法捕获尚未保存到磁盘的所有 IDE 状态；`set_pou_code` 另有对象级内存回滚。
- CODESYS 私有 `_executor` 反射兼容层仍依赖厂商内核实现，必须实机验收。
- 设备描述符、EtherCAT/PDO/I/O 映射能力因设备包而异；工具会失败关闭，不会把 API 不可用解释为成功。
- `shutdown_codesys` 保存项目并停止 watcher，但不会强杀或自动关闭 IDE。

## 许可与来源

本项目沿用 MIT License。第三方来源与改动说明见 [NOTICE.md](NOTICE.md)。


## Public preview and known limitations

This repository is a maintained derivative, not a claim of authorship of the upstream projects. Original attribution is retained in LICENSE and NOTICE.md. Vendor tools and SDKs are not redistributed.

The latest installed target-selection fixes have 43 passing Python mock tests. Physical PLC validation remains pending. The separate unfinished mutation-fix drafts are not included here.

Known issues still under review:
- Textual symbol rename may affect string literals and miss case-insensitive references.
- Device-parameter and I/O mapping writers need stronger readback mismatch handling.
- Headless timeout uncertainty is not persisted across server restarts.

Use offline copies for evaluation. These unresolved paths are not described as production-validated.

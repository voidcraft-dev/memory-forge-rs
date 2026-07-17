# Memory Forge 内嵌终端实施方案

> 状态：设计阶段  
> 目标分支：`feature/embedded-terminal`  
> 首期平台：Windows 10/11（ConPTY）  
> 后续平台：macOS / Linux（Unix PTY）

## 1. 背景与目标

Memory Forge 当前可以从会话详情取得 `resume` / `fork` 命令，并在外部 CMD、PowerShell、Windows Terminal 或其他终端中启动。现有流程仍包含明显的上下文切换：

1. 在 Memory Forge 中查找历史会话。
2. 点击打开外部终端，或复制命令。
3. 切换到另一个窗口继续与 Codex、Grok Build、Claude 等 CLI 交互。
4. 完成后再切回 Memory Forge 管理会话。

本功能的目标是在 Memory Forge 会话详情中直接运行交互式 CLI：

- 一键在应用内部恢复或分支当前会话。
- 自动使用会话原始工作目录和已有 Resume/Fork 命令。
- 支持全屏 TUI、ANSI 颜色、光标、键盘、中文输入法、滚动和选择。
- 在“会话记录”和“终端”之间切换时不离开 Memory Forge。
- 保留现有外部终端能力，作为用户偏好和故障回退方案。

## 2. 非目标

首期不尝试完成以下功能：

- 不把 Windows Terminal 的原生窗口句柄通过 `SetParent` 强行嵌入 WebView。
- 不重新实现 Shell、Codex、Grok Build 或 Claude CLI。
- 不实现远程终端、SSH、跨设备同步或浏览器访问。
- 不在首期实现 tmux 级别的终端复用和持久化快照。
- 不默认保存完整终端输出到数据库。
- 不移除或替换现有外部终端启动逻辑。

## 3. 技术决策

### 3.1 总体架构

```text
React / xterm.js
  │  输入、resize、停止
  │  输出、状态、退出
  ▼
Tauri IPC / Channel
  ▼
Rust EmbeddedTerminalManager
  ▼
portable-pty
  ▼
Windows ConPTY / Unix PTY
  ▼
cmd、PowerShell、Codex、Grok Build、Claude 等子进程
```

### 3.2 前端终端模拟器

采用官方 `@xterm/xterm`：

- VS Code、Paseo、Tabby、JupyterLab 等成熟产品正在使用。
- 支持常见 ANSI/VT 控制序列、alternate screen、鼠标、CJK、Emoji 和 IME。
- 核心零依赖，并提供官方 addon。

首期 addon：

- `@xterm/addon-fit`：根据容器尺寸计算 rows/cols。
- `@xterm/addon-search`：终端内容搜索，可首期隐藏 UI、保留扩展点。
- `@xterm/addon-web-links`：识别 HTTP/HTTPS 链接。

版本策略：

- 锁定精确版本，不使用宽松 `^` 自动升级。
- 开发 Spike 优先验证包含 2026 年 dispose 修复的 `6.1.x beta`。
- 若使用 beta，必须固定到已验证版本并通过内存回归测试；稳定版包含相同修复后再迁移。
- 首期使用默认 Canvas/DOM 路径，不启用 WebGL addon，避免 GPU Context 生命周期增加复杂度。

### 3.3 Rust PTY

采用 `portable-pty = 0.9.0`：

- 来自 WezTerm 项目。
- Windows 使用 ConPTY，macOS/Linux 使用原生 PTY。
- 支持 spawn、读写、resize、等待退出和终止子进程。
- 与当前 Rust/Tauri 技术栈匹配，不需要引入 Node sidecar。

注意事项：

- `portable-pty` 是同步 I/O 接口，reader/waiter 不能阻塞 Tauri 主线程。
- 使用专用工作线程和有界 channel 传送数据。
- Cargo audit 可能报告其串口相关传递依赖的历史 advisory；内嵌本地 PTY 不走串口路径，但仍需记录、评估并跟踪上游。

### 3.4 不直接依赖第三方 Tauri PTY 插件

`Tnze/tauri-plugin-pty` 可作为最小连接示例，但首期不直接依赖：

- 项目仍明确标记为 Developing。
- 尚无正式 Release，用户量和维护验证有限。
- Memory Forge 需要自己的会话生命周期、安全策略、输出限流和错误回退。

实现时可以参考其 API 形态，但核心状态由 Memory Forge 自己管理。

## 4. 与现有代码的集成

### 4.1 保留的能力

- `src-tauri/src/terminal.rs`：继续负责外部终端启动。
- `launch_session_terminal`：继续作为“在外部终端打开”的后备入口。
- `sessionDetail.commands.resume` / `fork`：继续作为可信的命令来源。
- `sessionDetail.cwd`：继续作为 PTY 初始工作目录。
- 设置页现有“首选终端”：继续控制外部终端，不与内嵌 Shell 混用。

### 4.2 新增模块建议

Rust：

```text
src-tauri/src/embedded_terminal.rs
  EmbeddedTerminalManager
  EmbeddedTerminalSession
  TerminalStartRequest
  TerminalEvent
  start / write / resize / stop / dispose_all
```

前端：

```text
src/features/terminal/
  embedded-terminal-panel.tsx
  terminal-toolbar.tsx
  terminal-tab-strip.tsx
  terminal-viewport.tsx
  use-terminal-session.ts
  terminal-types.ts
  terminal-theme.ts
```

API：

```text
src/features/desktop/api.ts
  startEmbeddedTerminal
  writeEmbeddedTerminal
  resizeEmbeddedTerminal
  stopEmbeddedTerminal
```

## 5. Rust 会话模型

建议状态：

```rust
enum TerminalStatus {
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
}
```

每个终端实例至少保存：

- `terminal_id`
- `session_key`（Memory Forge 会话标识）
- `command_kind`（resume / fork / shell）
- `cwd`
- PTY master
- stdin writer
- child / child killer
- 当前 rows / cols
- started_at
- 状态和退出码
- reader/waiter 的取消信号
- 有界输出缓冲和批处理器

全局由 Tauri managed state 保存：

```text
EmbeddedTerminalManager
  └─ HashMap<TerminalId, EmbeddedTerminalSession>
```

任何退出路径都必须最终从 HashMap 移除会话并释放资源。

## 6. IPC 协议草案

### 6.1 启动

```ts
interface StartEmbeddedTerminalRequest {
  sessionKey: string;
  command: string;
  commandKind: "resume" | "fork" | "shell";
  cwd: string | null;
  cols: number;
  rows: number;
}

interface EmbeddedTerminalStarted {
  terminalId: string;
  status: "running";
  cwd: string;
  processId?: number;
}
```

Rust 必须重新校验：

- command 非空且长度受限。
- cwd 存在、是目录并可访问。
- 首期只接受由已加载会话详情返回的 Resume/Fork 命令。
- cols/rows 位于合理范围内。

### 6.2 输出事件

```ts
type EmbeddedTerminalEvent =
  | { type: "output"; terminalId: string; sequence: number; data: string }
  | { type: "title"; terminalId: string; title: string }
  | { type: "exit"; terminalId: string; exitCode: number | null }
  | { type: "error"; terminalId: string; message: string };
```

输出传输需要满足：

- 保留 ANSI 控制序列。
- 正确处理跨 chunk 的 UTF-8 字符。
- 持续输出时按约 5–10ms 或最大字节数合并批次。
- 保证 output、error、exit 的顺序。
- 不为每个 PTY read 单独触发 React render。

若字符串传输无法可靠保留字节边界，则改为 base64 或字节数组，并在前端转换为 `Uint8Array` 交给 xterm。

### 6.3 输入、resize 与停止

```ts
writeEmbeddedTerminal(terminalId: string, data: string): Promise<void>

resizeEmbeddedTerminal(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void>

stopEmbeddedTerminal(
  terminalId: string,
  force: boolean,
): Promise<void>
```

要求：

- `Ctrl+C` 等控制字符原样发送到 PTY。
- resize 相同尺寸不重复发送，并做短时间节流。
- 普通停止先尝试软终止；超时后允许强制结束进程树。
- 应用退出时必须停止所有仍受 Memory Forge 管理的子进程。

## 7. 生命周期

```text
Idle
  └─ Start → Starting
                 ├─ success → Running
                 │              ├─ child exit → Exited
                 │              ├─ stop → Stopping → Exited
                 │              └─ fatal I/O → Failed
                 └─ failure → Failed
```

首期行为：

- “会话记录/终端”视觉切换不得销毁正在运行的 xterm 和 PTY。
- 用户关闭终端页签时，如果子进程仍运行，需要确认。
- 子进程自然退出后保留最后输出和退出码，用户可“重新启动”或关闭页签。
- 页面组件卸载时必须释放前端 listener/addon/observer；是否停止 PTY由明确的产品动作决定，不能依赖组件卸载隐式判断。
- 应用退出、窗口真正退出或崩溃恢复路径需要清理子进程，避免孤儿 Codex/Grok 进程。

首期不承诺应用重启后恢复仍运行的终端。

## 8. UI/UX 规格

### 8.1 推荐布局

会话详情主区域增加内容模式：

```text
┌─────────────────────────────────────────────────────────┐
│ 会话标题 / 平台 / 项目                                  │
│ [会话记录] [终端：Resume ●] [+]                         │
├─────────────────────────────────────────────────────────┤
│ ● 运行中 | F:\workspace\project                         │
│ Codex Resume        外部打开   重启   停止               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│                  xterm 终端视口                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

首期建议使用“主区域页签切换”，而不是底部小抽屉：

- AI CLI 的 TUI 需要足够宽度和高度。
- 避免会话长文本和终端同时渲染造成额外性能压力。
- 左侧会话列表保持不变，用户仍知道自己在哪个会话。

后续可增加左右分屏或底部可拖动面板。

### 8.2 操作入口

现有终端菜单调整为：

- `内嵌恢复会话`
- `在外部终端恢复`
- `复制恢复命令`
- 若平台支持 Fork：对应三项 Fork 操作

内嵌入口应为首选操作，但不能删除外部入口。

### 8.3 工具栏

显示：

- 运行状态点：starting / running / exited / failed。
- 命令类型：Resume / Fork / Shell。
- 当前工作目录，可截断并提供 tooltip。
- “在外部终端打开”。
- “重启”。
- “停止/强制停止”。
- “关闭终端页签”。

### 8.4 键盘与选择

- 点击终端区域后聚焦。
- `Ctrl+C`：有选择文本时复制；没有选择时发送 SIGINT/control-C。
- `Ctrl+Shift+C`：复制。
- `Ctrl+Shift+V`：粘贴。
- `Ctrl+F`：终端内搜索（可在第二阶段开放）。
- 鼠标滚轮：终端 scrollback。
- 浏览器/应用全局快捷键不得抢占终端必需按键。
- 中文 IME 组合输入不能被全局 keydown 提前发送。

### 8.5 状态页面

Gemini UI 必须提供以下可视状态：

- 未启动：说明文字和“内嵌恢复”按钮。
- 启动中：轻量 loading，不遮挡整个应用。
- 运行中：完整终端。
- 已退出：显示退出码、重新启动和关闭操作。
- 启动失败：错误摘要、复制命令、外部终端打开。
- 强制停止确认。

## 9. Gemini UI 交付边界

Gemini 可以修改：

- 会话详情中的终端入口和内容页签。
- `src/features/terminal/` 下的纯前端 UI 组件。
- 终端工具栏、状态页、响应式布局和主题样式。
- 必要的中英文 i18n 文案。
- 使用 mock 数据演示 starting/running/exited/error 状态。

Gemini 不应修改：

- Rust 代码、Cargo 依赖和 PTY 生命周期。
- Tauri commands/events 的最终实现。
- 现有平台适配器返回的 Resume/Fork 命令。
- 会话数据解析、编辑、导入导出功能。
- GitHub workflow、版本号和发布配置。

UI 组件不得直接散落调用 `invoke()`；所有后端调用由后续 hook/API 层接入。

建议 UI 契约：

```ts
type TerminalUiStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed";

interface EmbeddedTerminalPanelProps {
  status: TerminalUiStatus;
  title: string;
  platformName: string;
  commandKind: "resume" | "fork" | "shell";
  cwd: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  onStart: () => void;
  onStop: () => void;
  onForceStop: () => void;
  onRestart: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
  children?: React.ReactNode; // 后续由 Codex 注入真实 xterm viewport
}
```

Gemini 提交前要求：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- 不加入另一套 UI 框架。
- 遵循现有主题、间距、字体和图标体系。
- 不提交真实 PTY 假实现。
- 提供桌面宽屏和窄窗口截图，展示全部状态。

## 10. 性能预算

首期最低门槛：

- 普通键盘输入到本地回显应无可感知延迟，目标 p50 `< 25ms`。
- 连续大量输出时主 UI 仍能点击和切换，不能长时间白屏或冻结。
- 输出合并窗口不超过约 10ms，首个空闲后 chunk 立即发送。
- 单终端 scrollback 默认不超过 10,000 行。
- 单终端待发送输出队列必须有上限；达到上限应施加背压或合并，不能无限增长。
- resize 只在 rows/cols 变化时发送。
- React 不保存不断增长的完整终端文本。

压力测试：

- 短命令频繁回显。
- 2MB 连续输出。
- 10万行文本输出。
- 长时间运行的 Codex/Grok TUI。
- 快速连续 resize。
- 开关终端 50 次后的 JS heap、GPU 和 Rust 会话数量。

## 11. 内存和资源清理

前端关闭必须执行：

- `Terminal.dispose()`。
- dispose 所有 addon。
- dispose `onData` / `onSelectionChange` / `onTitleChange` 等订阅。
- disconnect `ResizeObserver`。
- remove Tauri listeners / Channel callbacks。
- 清除 debounce、throttle 和 timeout。
- 清空对 DOM host、Terminal、addon 的引用。

Rust 关闭必须执行：

- 标记取消并停止 reader/waiter。
- 关闭 stdin writer 和 PTY master。
- 终止或等待 child。
- 必要时结束 Windows 子进程树。
- 从 manager map 移除 session。
- 丢弃输出队列和 sender。
- 只发送一次最终 exit 状态。

首期默认不启用 WebGL。若后续开启，必须单独验证 GPU Context 在关闭终端后能够释放。

## 12. 安全要求

- 内嵌终端等同于本地命令执行能力，入口必须是明确用户操作。
- 不从 URL、Markdown、会话正文或导入文件中自动执行命令。
- 首期只执行平台适配器生成的 Resume/Fork 命令。
- cwd 必须是已有目录，不允许空字节或非法路径。
- 不将命令通过手工拼接重新包进另一层 shell，尽量使用可执行文件和参数列表。
- 如果平台当前只提供完整 shell 字符串，需要明确固定 Shell 并集中处理转义。
- 错误日志不得记录 token、完整环境变量或认证信息。
- 终端输出默认仅在本地内存中存在。
- 粘贴多行内容时可选显示 bracketed paste / 风险确认，但不阻塞首期。

## 13. 兼容性

Windows 首期验证：

- Windows 10 1903+ 和 Windows 11。
- CMD 与 PowerShell 作为启动 Shell。
- Codex、Grok Build、Claude、OpenCode、Pi 的已有 Resume/Fork 命令。
- 中文路径、空格路径、盘符切换和 UNC 路径。
- UTF-8、中文 IME、Emoji、宽字符对齐。
- alternate screen、光标移动和 Ctrl+C。

macOS/Linux 后续沿用 `portable-pty`，但需单独验证默认 Shell、登录环境、PATH 和信号处理。

## 14. 错误与回退

任何内嵌启动失败都应提供：

1. 简洁错误信息。
2. `在外部终端打开`。
3. `复制命令`。
4. `重试`。

以下情况不应导致 Memory Forge 崩溃：

- 命令不存在。
- cwd 被删除或无权限。
- PTY 创建失败。
- 子进程立即退出。
- 输出 reader 意外断开。
- 前端组件在启动过程中卸载。
- 应用退出时终端仍在运行。

## 15. 实施阶段

### Phase 0：UI 设计与契约

- Gemini 按第 8、9 节完成 UI。
- 使用 mock 状态，不接真实 PTY。
- Codex 审查组件边界、主题、一致性和可接入性。

### Phase 1：Windows 单终端 MVP

- 引入 xterm.js 和 addon-fit。
- 引入 portable-pty。
- 新增 Rust terminal manager 与 Tauri API。
- 从 Resume/Fork 入口启动真实 PTY。
- 输入、输出、resize、退出、停止完整闭环。
- 保留外部终端回退。

### Phase 2：稳定性

- 输出合并和有界队列。
- 生命周期与进程树清理。
- 压力测试、内存回归和错误恢复。
- 中文、宽字符、alternate screen、快捷键测试。

### Phase 3：体验增强

- 多终端页签。
- 搜索、链接、复制优化。
- 后台运行状态与会话列表标记。
- 外部/内嵌默认方式设置。

### Phase 4：跨平台

- macOS PTY。
- Linux PTY。
- 对应打包和 CI 验证。

## 16. 验收标准

功能：

- 任一支持命令的会话可以一键在应用内部 Resume。
- 若支持 Fork，可以一键内嵌 Fork。
- cwd 正确，命令无需复制。
- Codex/Grok 等交互式 TUI 可以输入、滚动和取消。
- 终端尺寸变化后内容布局正确。
- 子进程退出后 UI 显示退出状态。
- 失败时可以无缝转为外部终端。

质量：

- `cargo test --locked` 通过。
- `npm run typecheck` 通过。
- `npm run build` 通过。
- Windows Release 构建通过。
- 连续创建并关闭 50 个终端后，Rust manager 无残留 session。
- 前端 heap 中无持续增长的 Terminal、addon、observer 和 listener 实例。
- 10万行输出不会造成应用永久无响应。
- 关闭应用后没有由 Memory Forge 启动的孤儿终端进程。

## 17. 参考实现

- xterm.js：<https://github.com/xtermjs/xterm.js>
- xterm.js Demo：<https://xtermjs.org/>
- portable-pty：<https://docs.rs/portable-pty>
- WezTerm：<https://github.com/wezterm/wezterm>
- Paseo terminal pane：<https://github.com/getpaseo/paseo/blob/main/packages/app/src/components/terminal-pane.tsx>
- Paseo terminal runtime：<https://github.com/getpaseo/paseo/blob/main/packages/app/src/terminal/runtime/terminal-emulator-runtime.ts>
- Paseo 性能说明：<https://github.com/getpaseo/paseo/blob/main/docs/terminal-performance.md>
- JET Pilot Tauri 终端：<https://github.com/unxsist/jet-pilot/blob/main/src/views/Shell.vue>
- JET Pilot Rust PTY：<https://github.com/unxsist/jet-pilot/blob/main/src-tauri/src/shell.rs>
- Tauri PTY 最小示例：<https://github.com/Tnze/tauri-plugin-pty/tree/main/examples/vanilla>
- VS Code WebGL 释放修复：<https://github.com/microsoft/vscode/pull/279579>
- xterm.js dispose 修复：<https://github.com/xtermjs/xterm.js/pull/5817>

## 18. 协作方式

建议提交顺序：

1. 本文档作为共同规格。
2. Gemini 在 `feature/embedded-terminal` 完成纯 UI 提交。
3. Codex 审查 Gemini 改动并修复集成问题。
4. Codex 实现 xterm、Rust PTY、IPC、生命周期和性能控制。
5. Codex 完成自动测试、人工视觉验收和 Windows 打包。
6. 用户确认后再决定版本号、合并和发布。

所有提交继续使用：

```text
voidcraft-dev <246403070+voidcraft-dev@users.noreply.github.com>
```

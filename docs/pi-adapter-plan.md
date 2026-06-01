# Pi Coding Agent 适配器实现规划

## 一、结论与难度评估

Pi 适配可行，整体难度为 **中低**。

原因：
- 会话落盘是 JSONL，和 Claude / Codex 的扫描方式接近。
- 官方文档明确描述了 session v3 格式、entry 类型和消息内容块。
- 本机样本已验证路径、header、message、toolCall、toolResult、thinking 等核心形态。
- 主要复杂点是 Pi 的 session entries 是树结构，不是单纯线性日志。

建议第一版目标：
- 支持会话列表、详情、搜索、收藏/归档、打开终端。
- 支持普通 user/assistant 文本块编辑。
- 支持 thinking 展示为只读块。
- 支持 toolCall/toolResult 展示为工具调用块。
- 暂不实现 Pi 分支树切换 UI，只展示当前主链或按文件顺序的可读时间线。

预估工作量：

| 范围 | 难度 | 预估 |
|------|------|------|
| 只读列表 + 详情 | 低 | 0.5-1 天 |
| 搜索 + thinking/tool 展示 | 中低 | 1-1.5 天 |
| 安全编辑文本消息 | 中 | 1 天 |
| 完整分支树 UI | 中高 | 后续单独做 |

---

## 二、数据格式分析

### 2.1 目录结构

默认目录：

```text
~/.pi/agent/
├── settings.json
├── models.json
├── auth.json
├── extensions/
├── npm/
└── sessions/
    └── --<cwd-path>--/
        └── {timestamp}_{session_uuid}.jsonl
```

Windows 本机样例：

```text
C:\Users\<user>\.pi\agent\sessions\
└── --F--workspace-project--\
    └── 2026-06-01T16-48-15-428Z_019e8416-0243-74bf-9d1a-f32bf7b05fb9.jsonl
```

Pi 文档说明：

```text
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

其中 `<path>` 是工作目录路径转换后的目录名，实际 cwd 以 session header 中的 `cwd` 为准。

### 2.2 配置目录来源

默认：

```text
~/.pi/agent
```

可被环境变量覆盖：

```text
PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR
```

第一版建议：

1. 设置项只暴露 `pi_home`，默认 `~/.pi/agent`。
2. 若 `PI_CODING_AGENT_DIR` 存在，可作为默认候选。
3. 暂不单独暴露 `PI_CODING_AGENT_SESSION_DIR`，但适配器内部可优先读取该 env 作为 sessions root。

### 2.3 Session Header

第一行是 session header：

```json
{
  "type": "session",
  "version": 3,
  "id": "019e8416-0243-74bf-9d1a-f32bf7b05fb9",
  "timestamp": "2026-06-01T16:48:15.428Z",
  "cwd": "F:\\workspace\\project"
}
```

可能包含：

```json
{
  "parentSession": "/path/to/original/session.jsonl"
}
```

### 2.4 Entry 基础结构

除 header 外，entry 通常具备：

```json
{
  "type": "message",
  "id": "5af4b1fe",
  "parentId": "59494959",
  "timestamp": "2026-06-01T16:48:23.684Z"
}
```

重要点：
- `id` 是 entry id，不等于 session id。
- `parentId` 形成树结构。
- 同一文件内可能存在分支，不能简单假设所有 entry 都在当前链上。

### 2.5 常见 Entry 类型

| type | 说明 | 第一版处理 |
|------|------|------------|
| `session` | header 元数据 | 读取 session id / cwd / started_at |
| `message` | 对话消息 | 核心解析 |
| `model_change` | 模型切换 | 作为 source_meta 或只读系统事件 |
| `thinking_level_change` | thinking 等级切换 | 作为 source_meta 或只读系统事件 |
| `compaction` | 上下文压缩摘要 | 展示为只读 summary |
| `branch_summary` | 分支摘要 | 展示为只读 summary |
| `custom` | 扩展状态，不进上下文 | 默认忽略 |
| `custom_message` | 扩展注入消息 | 展示为 custom / system 只读块 |
| `label` | entry 标签 | 暂不接入 Memory Forge 标签系统 |
| `session_info` | 会话名 | 用作 display_title 优先来源 |

### 2.6 Message 角色

`type="message"` 的 `message.role` 常见值：

| role | 说明 | 第一版处理 |
|------|------|------------|
| `user` | 用户输入 | 可编辑文本块 |
| `assistant` | 模型回复 | 文本可编辑，thinking/toolCall 只读 |
| `toolResult` | 工具结果 | 合并到对应 toolCall 或展示为工具输出 |
| `bashExecution` | bash 执行记录 | 可映射为 tool block |
| `custom` | 扩展消息 | 只读展示 |
| `branchSummary` | 分支摘要消息 | 只读展示 |
| `compactionSummary` | 压缩摘要消息 | 只读展示 |

### 2.7 内容块格式

用户消息：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "你好" }
  ],
  "timestamp": 1780332503681
}
```

助手消息：

```json
{
  "role": "assistant",
  "content": [
    { "type": "thinking", "thinking": "Brief intro." },
    { "type": "toolCall", "id": "tooluse_xxx", "name": "bash", "arguments": { "command": "ls" } },
    { "type": "text", "text": "完成。" }
  ],
  "api": "openai-responses",
  "provider": "custom-openai",
  "model": "gpt-5.5",
  "usage": { "...": "..." },
  "stopReason": "stop"
}
```

工具结果：

```json
{
  "role": "toolResult",
  "toolCallId": "tooluse_xxx",
  "toolName": "bash",
  "content": [
    { "type": "text", "text": "output" }
  ],
  "isError": false
}
```

---

## 三、关键差异点

| 项目 | Claude / Codex / Gemini | Pi |
|------|--------------------------|----|
| 会话文件 | JSONL 或 JSON | JSONL |
| 根目录 | 平台固定路径 | `~/.pi/agent/sessions`，可 env 覆盖 |
| session id | 文件或 payload | header `id` |
| cwd 来源 | payload / metadata | header `cwd` |
| 消息入口 | 各平台自定义 | `type="message"` + `message.role` |
| 内容结构 | 平台差异大 | typed content blocks |
| 工具调用 | Codex function_call / Claude tool_use | assistant `toolCall` + `toolResult` |
| thinking | Claude/Gemini 各自格式 | assistant content `type="thinking"` |
| 分支 | 多数线性 | `id`/`parentId` 树结构 |
| 会话名 | 多数从首条消息推断 | `session_info.name` 优先 |

---

## 四、需要修改的文件清单

### 4.1 新增文件

| 文件 | 说明 |
|------|------|
| `src-tauri/src/platforms/pi.rs` | Pi 适配器实现 |
| `docs/pi-adapter-plan.md` | 本规划文档 |

### 4.2 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src-tauri/src/platforms/mod.rs` | `pub mod pi;`，`get_adapter()` 加 `"pi"` 分支，`build_commands()` 加 resume |
| `src-tauri/src/session_service.rs` | `dashboard_summary()` 平台数组加 `"pi"` |
| `src-tauri/src/settings.rs` | `AppSettings` / `AppSettingsPatch` 加 `pi_home: Option<String>` |
| `src/features/desktop/types.ts` | `DesktopSettings` / patch 加 `piHome` |
| `src/features/desktop/i18n.ts` | 加 `platformPi`、`piHome` 等 key |
| `src/app/routes/settings.tsx` | 平台显示列表加 Pi；平台路径区块加 `PathRow` |
| `src/components/layout/shell-layout.tsx` | sidebar 加 Pi 入口 |
| `src/app/routes/dashboard.tsx` | dashboard platformMeta 加 Pi |
| `src/features/session/session-list.tsx` | 平台颜色 / 首字母展示加 Pi |

---

## 五、适配器实现设计

### 5.1 会话 Key 设计

推荐：

```text
{project_dir_name}::{file_stem}
```

例：

```text
--F--workspace-project--::2026-06-01T16-48-15-428Z_019e8416-0243-74bf-9d1a-f32bf7b05fb9
```

理由：
- 能稳定定位文件。
- 不依赖 cwd 反向编码。
- 文件名中已经包含 session uuid。

`session_id` 使用 header `id`。

### 5.2 list_sessions 逻辑

```text
1. 确定 pi_home：
   a. settings.pi_home
   b. PI_CODING_AGENT_DIR
   c. ~/.pi/agent
2. 确定 sessions_root：
   a. PI_CODING_AGENT_SESSION_DIR
   b. {pi_home}/sessions
3. 递归扫描 sessions_root 下 *.jsonl
4. 对每个文件快速读取：
   a. 第一行 session header：id / cwd / timestamp
   b. session_info.name：若存在，作为 display_title
   c. 第一条 user 文本或 assistant 文本作为 preview
   d. 最后一条 entry timestamp 或文件 mtime 作为 updated_at
5. 按 updated_at 降序排序
6. 应用 alias_map / limit / offset
```

性能策略：
- list 阶段用 BufReader 逐行扫描，不全量反序列化大文件。
- preview 找到后仍继续轻量扫描 timestamp / session_info，不解析大 content 的完整 pretty JSON。

### 5.3 当前链选择策略

Pi session 是树，不是线性链。第一版建议：

1. 建立 `id -> entry` 和 `parentId -> children`。
2. 找当前 leaf：
   - 优先选择文件中最后一个有 `id` 的 entry。
   - 如果后续发现 Pi 文件记录显式 leaf 字段，再切换为官方 leaf。
3. 从 leaf 反向沿 parentId 回到 root，反转后得到当前链。
4. 详情页只展示当前链。

降级策略：
- 如果 parentId 缺失或链断裂，回退为文件顺序展示可解析 entry。

### 5.4 get_session_detail 逻辑

```text
1. 从 session_key 定位 jsonl 文件
2. 读取 header 获取 session_id / cwd
3. 解析 entries，选择当前链
4. 转换为 TimelineBlock[]：
   - user text content -> role="user"，editable=true
   - assistant text content -> role="assistant"，editable=true
   - assistant thinking content -> role="thinking"，editable=false
   - assistant toolCall -> 暂存 ToolCallBlock
   - toolResult -> 通过 toolCallId 合并到对应 ToolCallBlock
   - compaction / branch_summary -> role="system" 或 "summary"，editable=false
5. commands 使用 build_commands("pi", session_id)
```

### 5.5 toolCall 展示策略

Pi 的 toolCall 位于 assistant content，toolResult 是单独 message。

转换方案：

```text
assistant content toolCall:
  -> ToolCallBlock {
       id: toolCall.id,
       name: toolCall.name,
       kind: "pi-tool",
       input: JSON.stringify(arguments),
       status: "pending" | "success" | "error"
     }

toolResult:
  -> 找到 toolCallId 相同的 ToolCallBlock
  -> output = content text / pretty JSON
  -> status = isError ? "error" : "success"
```

如果找不到对应 toolCall：
- 生成一个孤立 ToolCallBlock，挂到前一个 assistant block。
- 或生成只读 `toolResult` TimelineBlock。

### 5.6 update_message 逻辑

只允许编辑文本内容：

```text
edit_target = {session_key}::{entry_id}::{content_index}::text
```

更新步骤：

```text
1. 定位 jsonl 文件
2. 逐行读取并保留原始行
3. 找到 type="message" 且 id == entry_id
4. 校验 message.role in ["user", "assistant"]
5. 校验 message.content[content_index].type == "text"
6. 修改 text = new_content
7. 同步 message.timestamp / entry.timestamp 可选更新为当前时间
8. 逐行写回
```

第一版不编辑：
- thinking
- toolCall
- toolResult
- custom/custom_message
- compaction/branch_summary

原因：这些内容参与 Pi 上下文、工具链和签名字段，盲改会增加恢复风险。

### 5.7 content_search 逻辑

```text
1. 定位文件
2. 解析当前链或按文件顺序扫描
3. 搜索 user/assistant text、thinking、tool input/output
4. 返回 ContentMatch
```

建议：
- 普通搜索默认包含 user/assistant text。
- tool output 可能很大，作为匹配项但 snippet 限长。

---

## 六、设置项

### 6.1 后端 settings

```rust
// settings.rs - AppSettings
#[serde(default)]
pub pi_home: Option<String>, // 默认: ~/.pi/agent 或 PI_CODING_AGENT_DIR
```

```rust
// settings.rs - AppSettingsPatch
pub pi_home: Option<Option<String>>,
```

默认解析：

```text
settings.pi_home
  -> env PI_CODING_AGENT_DIR
  -> home/.pi/agent
```

sessions root 解析：

```text
env PI_CODING_AGENT_SESSION_DIR
  -> {pi_home}/sessions
```

### 6.2 前端 PathRow

```tsx
<PathRow
  label={t("piHome")}
  defaultHint="~/.pi/agent"
  pickMode="directory"
  value={snapshot.settings.piHome ?? ""}
  onSave={(v) => updateSettings({ piHome: v || null })}
/>
```

### 6.3 平台显示

`visiblePlatforms` 增加可选项：

```text
pi
```

默认是否显示：
- 建议第一版不加入默认 visiblePlatforms，和 Gemini/Kiro IDE 一样由用户在设置中勾选。
- 如果检测到 `~/.pi/agent/sessions` 存在，可后续做自动提示。

---

## 七、i18n Key 清单

| Key | 中文 | English |
|-----|------|---------|
| `platformPi` | Pi | Pi |
| `piHome` | Pi 数据目录 | Pi Data Directory |

如果按平台 id 统一展示，也可补充：

| Key | 中文 | English |
|-----|------|---------|
| `platform.pi` | Pi Coding Agent | Pi Coding Agent |

---

## 八、命令集成

`build_commands("pi", session_id)` 建议：

```rust
let mut m = HashMap::new();
m.insert("resume".into(), format!("pi --session {session_id}"));
m.insert("continue".into(), "pi --continue".into());
```

注意：
- Pi 支持 `--session <path|id>`，可用 session uuid 恢复。
- 如果 cwd 不同，Pi 的 session lookup 可能受 session dir 和项目路径影响；更稳的是后续支持用 session 文件路径：

```text
pi --session "{absolute_jsonl_path}"
```

第一版可在 `commands` 里同时提供：

```text
resumeById
resumeByPath
```

---

## 九、实现顺序

1. **样本固化**：从本机复制 2-3 个脱敏 Pi jsonl 到测试 fixture。
2. **`pi.rs` 只读解析**：实现 list/detail，支持 header/message/session_info。
3. **当前链选择**：实现 parentId 链路恢复，断链回退文件顺序。
4. **tool/thinking 展示**：thinking 独立块，toolCall/toolResult 合并。
5. **注册平台**：`mod.rs`、`session_service.rs`、前端 sidebar/dashboard/settings/i18n。
6. **搜索**：普通文本 + thinking + tool input/output。
7. **编辑**：仅 text content，严格校验 edit_target。
8. **测试**：Rust 单测覆盖 JSONL 解析、tree chain、tool 合并、编辑写回。

---

## 十、测试用例建议

### 10.1 基础会话

```jsonl
{"type":"session","version":3,"id":"s1","timestamp":"2026-06-01T16:48:15.428Z","cwd":"F:\\workspace\\demo"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-01T16:48:16.000Z","message":{"role":"user","content":[{"type":"text","text":"你好"}],"timestamp":1780332496000}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-06-01T16:48:17.000Z","message":{"role":"assistant","content":[{"type":"text","text":"你好！"}],"api":"openai-responses","provider":"test","model":"gpt","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1780332497000}}
```

验收：
- list 能显示 cwd、preview、updated_at。
- detail 有 2 个 blocks。
- user/assistant text 可编辑。

### 10.2 thinking + tool

```jsonl
{"type":"session","version":3,"id":"s2","timestamp":"2026-06-01T16:48:15.428Z","cwd":"F:\\workspace\\demo"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-01T16:48:16.000Z","message":{"role":"user","content":[{"type":"text","text":"列目录"}],"timestamp":1780332496000}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-06-01T16:48:17.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Need list files."},{"type":"toolCall","id":"tc1","name":"bash","arguments":{"command":"ls"}}],"api":"anthropic-messages","provider":"local","model":"claude","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1780332497000}}
{"type":"message","id":"tr1","parentId":"a1","timestamp":"2026-06-01T16:48:18.000Z","message":{"role":"toolResult","toolCallId":"tc1","toolName":"bash","content":[{"type":"text","text":"Cargo.toml\nsrc"}],"isError":false,"timestamp":1780332498000}}
```

验收：
- thinking 块只读。
- toolCall 显示 input。
- toolResult 合并为 output。

### 10.3 分支链

构造：

```text
u1 -> a1 -> u2 -> a2
       \-> branch_summary -> u3 -> a3
```

验收：
- 默认展示最后 leaf 所在链。
- 断链时不 panic，回退文件顺序。

---

## 十一、已知风险 & 待确认

| 风险 | 说明 | 处理方案 |
|------|------|----------|
| 分支语义 | Pi 支持树结构，Memory Forge 当前没有分支 UI | 第一版只展示当前 leaf 链；后续再做 tree UI |
| 编辑破坏签名 | assistant text 可能带 `textSignature` 或 provider response metadata | 只改 `text`，保留其它字段；编辑后能否被 Pi 原生安全恢复需实测 |
| tool output 很大 | `toolResult.content` 可能包含长输出或二进制乱码 | 列表不读 output；详情限长展示，必要时加 lazy load |
| 自定义扩展消息 | `custom/custom_message` 结构由扩展定义 | 默认只读，source_meta 保留原始 entry |
| env session dir | `PI_CODING_AGENT_SESSION_DIR` 可能让 sessions 不在 pi_home 下 | 适配器优先读取 env |
| Windows 路径编码 | session 目录名不可逆且可能变动 | 不从目录名推 cwd，以 header.cwd 为准 |
| 版本迁移 | Pi 会自动迁移旧 session 到 v3，但我们直接读文件不会触发迁移 | 支持 v3 为主；v1/v2 样本不足时只做 best-effort |
| 隐私风险 | tool input/output 可能含密钥、文件内容 | UI 维持现有本地只读模型；导出功能需复用敏感内容提示 |

---

## 十二、是否值得做

值得做，但不建议从“配置 Pi LLM provider”切入。

Memory Forge 更适合集成的是 Pi 的 **session 历史、工具调用、thinking、恢复命令**：

- Pi provider 配置属于 Pi 自己的运行配置，和 Memory Forge 的会话管理边界不完全一致。
- Pi session 格式清晰，适合作为 Memory Forge 的新平台适配器。
- 有了 Pi adapter 后，Memory Forge 可以统一看 Claude / Codex / OpenCode / Gemini / Pi 的历史记录，价值更直接。

推荐结论：

```text
Phase 1: Pi session viewer + search + resume command
Phase 2: toolCall/toolResult 精细展示
Phase 3: 安全文本编辑
Phase 4: 分支树 UI / session_info / label 深度集成
```

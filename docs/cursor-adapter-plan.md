# Cursor 适配器实现规划

## 一、数据格式分析

### 1.1 目录结构

```
Windows: %APPDATA%\Cursor\User\
macOS:   ~/Library/Application Support/Cursor/User/
Linux:   ~/.config/Cursor/User/
├── globalStorage/
│   └── state.vscdb                    # 全局 DB — 对话内容 + 中央索引 (Cursor 3.0+)
└── workspaceStorage/
    ├── {workspace-id-1}/
    │   ├── workspace.json             # 映射工作区到项目路径
    │   └── state.vscdb                # 工作区 DB — 聊天列表 (≤2.6)
    └── ...
```

### 1.2 Cursor 3.0 架构变化 (2026年4月)

Cursor 3.0 做了破坏性迁移，从去中心化变为集中式：

| 版本 | 架构 | 聊天索引位置 |
|------|------|-------------|
| ≤2.6 | 去中心化，每个工作区独立管理 | `workspaceStorage/{id}/state.vscdb` → `composer.composerData` |
| 3.0+ | 集中式，统一管理 | `globalStorage/state.vscdb` → `composer.composerHeaders` |

### 1.3 全局 DB 的数据结构

`state.vscdb` 有两张表：`ItemTable`（VSCode 标准 KV）和 `cursorDiskKV`（Cursor 专用 KV，value 为 TEXT）。

**ItemTable 中的 Cursor 相关 key：**

| Key | 内容 |
|-----|------|
| `composer.composerHeaders` | 所有会话的索引列表（`allComposers[]`） |

**cursorDiskKV 中的 key 模式：**

| Key 模式 | 内容 |
|----------|------|
| `composerData:{composerId}` | 单个会话的元数据 + 消息顺序列表 |
| `bubbleId:{composerId}:{bubbleId}` | 单条消息的完整内容 |
| `checkpointId:{composerId}:{checkpointId}` | 工作区状态快照（agent 恢复必需） |
| `agentKv:blob:{hash}` | agent 模式的 blob 数据 |

### 1.4 数据结构详解

**`ItemTable` 中的 `composer.composerHeaders`（会话索引）：**
```json
{
  "allComposers": [
    {
      "composerId": "edb7af5d-4371-4e3a-b574-4c27e44e11dd",
      "name": "Celebratory expression",
      "createdAt": 1776141470160,
      "lastUpdatedAt": 1776147812601,
      "unifiedMode": "agent",
      "forceMode": "edit",
      "subtitle": "Read npm-install.log",
      "isArchived": false,
      "isDraft": false,
      "contextUsagePercent": 31.8
    }
  ]
}
```

**`cursorDiskKV` 中的 `composerData:{composerId}`（单个会话）：**
```json
{
  "_v": 14,
  "composerId": "d3330e21-991e-4cec-b21b-3942323185d3",
  "text": "",
  "richText": "{\"root\":{...}}",
  "fullConversationHeadersOnly": [
    { "bubbleId": "c3264e5f-cd03-4879-9465-b8406fccda48", "type": 1 },
    { "bubbleId": "1f314b9d-313f-44aa-9f1b-9fc952339af1", "type": 2 },
    { "bubbleId": "7c1d8589-fa86-4e68-9098-bbcaabe11423", "type": 1 }
  ],
  "hasLoaded": true
}
```

消息顺序由 `fullConversationHeadersOnly[]` 维护，需按顺序逐个去 `cursorDiskKV` 查 `bubbleId:{composerId}:{bubbleId}`。

### 1.5 bubbleId 消息格式

**用户消息（type: 1）：**
```json
{
  "_v": 3,
  "type": 1,
  "bubbleId": "c3264e5f-cd03-4879-9465-b8406fccda48",
  "text": "你好",
  "richText": "{\"root\":{\"children\":[{\"children\":[{\"text\":\"你好\"}]}]}}",
  "createdAt": "2026-04-13T09:15:03.230Z",
  "unifiedMode": 2,
  "checkpointId": "0bea9f2e-6363-4cd0-b74d-8a82b47d2cc6",
  "context": { "fileSelections": [], "folderSelections": [], ... },
  "modelInfo": { "modelName": "gpt-5.4" }
}
```

**助手消息（type: 2）：**
```json
{
  "_v": 3,
  "type": 2,
  "bubbleId": "1f314b9d-313f-44aa-9f1b-9fc952339af1",
  "text": "助手回复内容",
  "createdAt": "2026-04-13T09:15:05.425Z",
  "unifiedMode": 2,
  "turnDurationMs": 4217,
  "tokenCount": { "inputTokens": 0, "outputTokens": 0 }
}
```

**关键字段说明：**
- `type: 1` = 用户消息，`type: 2` = 助手消息（**无** `author.role` 字段）
- 消息内容统一在 `text` 字段（纯文本）
- `richText` 是 Lexical 富文本 JSON，仅用户消息有，编辑时需同步更新
- `createdAt` 是 ISO 8601 字符串（**非**毫秒时间戳）
- `checkpointId` 仅用户消息有，agent 模式恢复时需要

### 1.6 Agent Transcripts (可选数据源)

`cursor-agent` CLI 还有另一套纯文本转录文件，更接近 Claude Code 风格：

```
~/.cursor/projects/<project-id>/agent-transcripts/<uuid>.txt
```

转录格式：
```
user: <user_query>...</user_query>
A: <assistant_response>
[Thinking] ... reasoning blocks ...
[Tool call] ToolName
  indented args
[Tool result] ToolName
```

### 1.7 关键差异点（对比现有适配器）

| 项目 | Claude / Codex / Kiro / Gemini | Cursor |
|------|-------------------------------|--------|
| 存储格式 | JSONL 或 JSON 纯文本 | **SQLite KV** |
| Mental Model | `session = one JSON file` | `session = multiple DB keys` |
| 消息组织 | 直接在单一文件 | **composerHeaders 索引 + 逐条 bubbleId** |
| 消息角色区分 | `role` 字符串 | **`type` 数字（1=user, 2=assistant）** |
| 时间戳格式 | 毫秒整数 | **ISO 8601 字符串** |
| 恢复机制 | `--resume <session_id>` | 依赖 `checkpointId` 完整性 |

---

## 二、需要修改的文件清单

### 2.1 新增文件

| 文件 | 说明 |
|------|------|
| `src-tauri/src/platforms/cursor.rs` | Cursor 适配器实现 |

### 2.2 修改文件

| 文件 | 改动内容 |
|------|---------|
| `src-tauri/src/platforms/mod.rs` | 注册 `CursorPlatform`，加 `"cursor"` 分支和 `build_commands()` |
| `src-tauri/src/session_service.rs` | `dashboard_summary()` 循环加 `"cursor"` |
| `src-tauri/src/settings.rs` | 加 `cursor_home: Option<String>` |
| `src/features/desktop/types.ts` | 加 `cursorHome` |
| `src/app/routes/settings.tsx` | 加 `PathRow`（`pickMode="directory"`） |
| `src/features/desktop/i18n.ts` | 加 `cursorHomePath` 等 i18n key |

---

## 三、适配器实现设计

### 3.1 技术选型

**rusqlite** — 项目后端已使用 rusqlite，可直接复用。

```rust
pub struct CursorPlatform {
    db_path: PathBuf,
}

impl CursorPlatform {
    pub fn new(cursor_home: PathBuf) -> Self {
        Self {
            db_path: cursor_home.join("globalStorage").join("state.vscdb"),
        }
    }
}
```

### 3.2 会话 Key 设计

```
{composer_id}
// 例：d3330e21-991e-4cec-b21b-3942323185d3
```

composerId 本身是全局唯一的 UUID，直接用即可，无需加前缀。

### 3.3 list_sessions 逻辑

```
1. 确定 db_path（优先 settings.cursor_home，否则平台默认路径）
2. 连接 SQLite（只读模式）
3. 从 ItemTable 读取 composer.composerHeaders，解析 allComposers[]
4. 对每个 composer：
   - composerId、name、createdAt、lastUpdatedAt 直接从 composerHeaders 取
   - preview：查 composerData:{composerId} 的 fullConversationHeadersOnly[0]，
     再查对应 bubbleId 的 text 字段（截断 120 字符）
5. 按 lastUpdatedAt 降序排列
6. 应用 alias_map、limit、offset
```

### 3.4 get_session_detail 逻辑

```
1. 从 session_key 取 composer_id
2. 查 cursorDiskKV WHERE key='composerData:{composer_id}'
3. 解析 fullConversationHeadersOnly[] 获取有序消息列表
4. 按顺序查每个 bubbleId:{composer_id}:{bubbleId}
5. 转换为 TimelineBlock[]：
   - type=1 → role="user",      content = text
   - type=2 → role="assistant", content = text
6. edit_target = {composer_id}::{bubble_id}
7. cwd：从 composerData 或 checkpointId 中提取（待确认字段）
```

### 3.5 update_message 逻辑

```
1. 解析 edit_target：composer_id + bubble_id
2. 查 cursorDiskKV WHERE key='bubbleId:{composer_id}:{bubble_id}'
3. 解析 JSON，记录旧 text 作为 old_content
4. 更新 text = new_content
5. 若 type=1（用户消息），同步更新 richText 中的文本节点
6. 写回：UPDATE cursorDiskKV SET value=? WHERE key=?
7. 返回 old_content
```

### 3.6 消息映射

| Cursor bubbleId 字段 | TimelineBlock 字段 | 说明 |
|---------------------|-------------------|------|
| `text` | `content` | 纯文本内容 |
| `type` | `role` | 1=user, 2=assistant |
| `createdAt` | `source_meta` | ISO 8601 字符串 |
| `bubbleId` | `id` | 消息唯一 ID |
| `checkpointId` | `source_meta` | 仅用户消息有，agent 恢复用 |

---

## 四、实现阶段规划

### Phase 1: 数据探索 ✅（已完成）

- [x] 确认两张表：`ItemTable` + `cursorDiskKV`
- [x] 确认 `composer.composerHeaders` 在 `ItemTable`
- [x] 确认 `composerData` / `bubbleId` / `checkpointId` 在 `cursorDiskKV`
- [x] 确认消息格式：`type` 区分角色，`text` 存内容，`createdAt` 是 ISO 字符串

### Phase 2: 基础读取 (2-3 天)

- [ ] 创建 `cursor.rs` 骨架
- [ ] 实现 `list_sessions()` — 列出会话
- [ ] 实现 `get_session_detail()` — 获取会话详情
- [ ] 实现 `content_search()` — 搜索支持

### Phase 3: 编辑支持 (2-3 天)

- [ ] 实现 `update_message()` — 修改 text + richText
- [ ] 处理写入失败的情况（数据损坏保护）

### Phase 4: 前端集成 (1-2 天)

- [ ] 前端添加 cursor 平台选项
- [ ] 设置页面添加 cursor_home 配置

---

## 五、已知挑战与应对策略

| 挑战 | 说明 | 处理方案 |
|------|------|---------|
| richText 同步 | 编辑用户消息时需同步更新 Lexical 富文本 JSON | 解析 richText，找到文本节点更新；或直接清空 richText 让 Cursor 重建 |
| cwd 来源不明 | bubbleId 中没有明显的 cwd 字段 | 从 checkpointId 数据或 workspaceStorage 的 workspace.json 关联 |
| 数据库锁 | Cursor 运行时 state.vscdb 可能被锁 | 以只读模式打开（`SQLITE_OPEN_READONLY`），写入时先关闭 Cursor |
| 3.0 迁移兼容 | 旧版数据在 workspaceStorage，新版在 globalStorage | 先实现 3.0+，旧版兼容后续再加 |
| cursor-agent transcript | 路径格式未在本机验证 | 实现前先确认 `~/.cursor/projects/` 是否真实存在 |

---

## 六、推荐实现策略

### 方案 A: MVP（只读）

| 功能 | 可行性 |
|------|--------|
| 列出会话 | ✓ |
| 查看详情 | ✓ |
| 搜索会话 | ✓ |
| 编辑消息 | ✗ |

### 方案 B: 标准版（推荐）

| 功能 | 可行性 | 备注 |
|------|--------|------|
| 列出会话 | ✓ | |
| 查看详情 | ✓ | |
| 搜索会话 | ✓ | |
| 编辑消息 | ✓ | 需同步更新 richText |
| agent 会话恢复 | △ | 依赖 checkpointId 完整性 |

---

## 七、附录

### 7.1 Windows 路径参考

```
%APPDATA%\Cursor\User\globalStorage\state.vscdb
%APPDATA%\Cursor\User\workspaceStorage\
~\.cursor\                              # cursor-agent 数据（待确认）
```

### 7.2 i18n Key 清单

| Key | 中文 | English |
|-----|------|---------|
| `cursorHomePath` | Cursor 数据目录 | Cursor Home Path |
| `platform.cursor` | Cursor | Cursor |

### 7.3 相关资源

- [Cursor Fan — Managing Chat History](https://cursor.fan/tutorial/HowTo/manage-cursor-chat-history/)
- [Cursaves — How Cursor Stores Chat Data](https://github.com/Callum-Ward/cursaves/blob/main/docs/how-cursor-stores-chats.md)
- [vibe-replay — What Does Cursor Store](https://vibe-replay.com/blog/cursor-local-storage/)

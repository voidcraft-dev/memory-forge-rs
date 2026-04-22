# Trae / Trae CN 适配器实现规划

## 一、版本差异

| 项目 | Trae（国际版） | Trae CN（国内版） |
|------|--------------|----------------|
| AppData 路径 | `%APPDATA%\Trae\` | `%APPDATA%\Trae CN\` |
| 数据格式 | **完全相同** | **完全相同** |
| 实现方式 | 同一适配器，路径不同 | 同一适配器，路径不同 |

两个版本数据格式完全一致，可以用同一套适配器代码，通过不同的 `base_path` 参数区分。

---

## 二、数据格式分析

### 2.1 目录结构

```
%APPDATA%\Trae\                          (或 Trae CN\)
├── User\
│   └── workspaceStorage\
│       └── {workspace_hash}\            # 每个工作区一个文件夹（MD5 hash）
│           ├── workspace.json           # 工作区路径信息
│           └── state.vscdb              # SQLite 数据库，存储聊天记录
└── ModularData\
    └── ai-agent\
        └── database.db                  # 加密数据库（无法直接读取）
```

**核心数据源：** `workspaceStorage/{hash}/state.vscdb`

### 2.2 workspace.json 格式

```json
{
  "folder": "file:///f%3A/workspace/akt20250515/sl-app"
}
```

URL 编码的工作区路径，需 URL decode 后去掉 `file:///` 前缀。

### 2.3 state.vscdb 关键字段

SQLite 数据库，表名 `ItemTable`，结构 `(key TEXT, value TEXT)`。

聊天相关的 key：

| Key | 说明 | 大小 |
|-----|------|------|
| `memento/icube-ai-agent-storage` | **主要聊天数据**，包含所有会话和消息 | 可达 700KB+ |
| `ChatStore` | UI 状态（消息高度等），不含消息内容 | 小 |
| `icube-ai-agent-storage-input-history` | 输入历史记录 | 中 |

### 2.4 `memento/icube-ai-agent-storage` 数据结构

```json
{
  "currentSessionId": "68302619eadbed83163f2693",
  "list": [
    {
      "sessionId": "68302619eadbed83163f2693",
      "title": "会话标题（通常是第一条用户消息）",
      "name": "同 title",
      "type": "builder",
      "createdAt": 1747985945000,
      "updatedAt": 1747987789000,
      "hasMore": false,
      "isCurrent": true,
      "nextPageToken": "79",
      "messages": [ ... ]
    }
  ]
}
```

### 2.5 消息格式

每条消息（`messages[]` 中的元素）：

```json
{
  "agentMessageId": "6830262fd1ebbe79eeac6fee",
  "userMessageId": null,
  "turnId": "6830262fd1ebbe79eeac6fee",
  "role": "user",
  "content": "用户消息内容",
  "parsedQuery": "清理后的消息内容（去掉文件引用等）",
  "turnIndex": 1,
  "agentMessageType": "general",
  "agentType": "builder",
  "timestamp": 1747985967000,
  "isHistory": true,
  "multiMedia": "",
  "revertEnable": true,
  "traceId": "2e94a07b3f19566e4b0a80d810eef34a"
}
```

**助手消息额外字段：**
```json
{
  "role": "assistant",
  "content": "",
  "status": "completed",
  "agentTaskContent": "{ proposal: '...', proposalReasoningContent: '', guideline: '' }",
  "meta": "{ references: [], searchReferenceData: '', docReferences: [], mentionedDocs: [] }"
}
```

### 2.6 关键观察

- `role` 只有 `"user"` 和 `"assistant"` 两种
- 用户消息：`content` 是完整消息（含文件引用），`parsedQuery` 是清理后的纯文本
- 助手消息：`content` 通常为空字符串，实际内容在 `agentTaskContent.proposal` 中
- `turnId` 将 user 和 assistant 消息配对（同一轮对话共享同一 `turnId`）
- `timestamp` 是毫秒时间戳
- `sessionId` 格式：24位十六进制字符串（MongoDB ObjectId 格式）

---

## 三、需要修改的文件清单

### 3.1 新增文件

| 文件 | 说明 |
|------|------|
| `src-tauri/src/platforms/trae.rs` | Trae / Trae CN 适配器（共用） |

### 3.2 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src-tauri/src/platforms/mod.rs` | 注册 `TraePlatform`，加 `"trae"` 和 `"trae-cn"` 分支 |
| `src-tauri/src/session_service.rs` | `dashboard_summary()` 循环加 `"trae"` 和 `"trae-cn"` |
| `src-tauri/src/settings.rs` | 加 `trae_home` 和 `trae_cn_home` 字段 |
| `src/features/desktop/types.ts` | 加 `traeHome` 和 `traeCnHome` |
| `src/app/routes/settings.tsx` | 加两个 `PathRow` |
| `src/features/desktop/i18n/` | 加相关 i18n key |

---

## 四、适配器实现设计

### 4.1 会话 Key 设计

```
{workspace_hash}::{session_id}
// 例：7845acc6504f4c859d47de2a8c785f2c::68302619eadbed83163f2693
```

### 4.2 list_sessions 逻辑

```
1. 确定 base_path（trae_home 或 trae_cn_home，默认 %APPDATA%\Trae 或 Trae CN）
2. 扫描 base_path/User/workspaceStorage/ 下所有子目录
3. 对每个工作区目录：
   a. 读取 workspace.json 获取 cwd（URL decode）
   b. 打开 state.vscdb
   c. 查询 memento/icube-ai-agent-storage
   d. 解析 JSON，遍历 list[]
   e. 每个 session 生成 SessionListItem：
      - session_key = {hash}::{sessionId}
      - title = session.title（截断）
      - preview = messages[0].parsedQuery（截断 120 字符）
      - updated_at = session.updatedAt（毫秒转字符串）
      - cwd = workspace 路径
4. 合并所有工作区的会话，按 updatedAt 降序排列
5. 应用 alias_map、limit、offset
```

### 4.3 get_session_detail 逻辑

```
1. 从 session_key 解析 workspace_hash + session_id
2. 打开 {base_path}/User/workspaceStorage/{workspace_hash}/state.vscdb
3. 读取 memento/icube-ai-agent-storage，找到 sessionId 匹配的 session
4. 读取 workspace.json 获取 cwd
5. 遍历 messages[]，转换为 TimelineBlock[]：
   - role="user"      → content = parsedQuery（优先）或 content
   - role="assistant" → content = agentTaskContent.proposal（优先）或 content
6. edit_target 格式：{session_key}::{agentMessageId}::{role}
```

### 4.4 update_message 逻辑

```
1. 解析 edit_target：workspace_hash + session_id + agentMessageId + role
2. 打开 state.vscdb
3. 读取 memento/icube-ai-agent-storage
4. 找到对应 session → 找到对应 message（by agentMessageId）
5. 更新：
   - user:      parsedQuery = new_content, content = new_content
   - assistant: agentTaskContent.proposal = new_content
6. 更新 session.updatedAt = 当前时间戳（毫秒）
7. 写回 state.vscdb（UPDATE ItemTable SET value=? WHERE key='memento/icube-ai-agent-storage'）
```

---

## 五、设置项

### 5.1 新增 settings 字段

```rust
// settings.rs
#[serde(default)]
pub trae_home: Option<String>,     // 默认: %APPDATA%\Trae\User\workspaceStorage
#[serde(default)]
pub trae_cn_home: Option<String>,  // 默认: %APPDATA%\Trae CN\User\workspaceStorage
```

### 5.2 默认路径

- Windows Trae: `%APPDATA%\Trae\User\workspaceStorage`
- Windows Trae CN: `%APPDATA%\Trae CN\User\workspaceStorage`
- macOS Trae: `~/Library/Application Support/Trae/User/workspaceStorage`（待确认）

---

## 六、i18n Key 清单

| Key | 中文 | English |
|-----|------|---------|
| `traeHomePath` | Trae 数据目录 | Trae Home Path |
| `traeCnHomePath` | Trae CN 数据目录 | Trae CN Home Path |
| `platform.trae` | Trae | Trae |
| `platform.trae-cn` | Trae CN | Trae CN |

---

## 七、实现顺序

1. **`settings.rs`** — 加 `trae_home` / `trae_cn_home`
2. **`trae.rs`** — 核心适配器（`TraePlatform { workspace_storage_dir, platform_name }`）
3. **`platforms/mod.rs`** — 注册两个平台
4. **`session_service.rs`** — dashboard 加两个平台
5. **前端 types.ts** — 加类型
6. **前端 settings.tsx** — 加 PathRow
7. **i18n** — 加翻译 key

---

## 八、已知风险 & 待确认

| 风险 | 说明 | 处理方案 |
|------|------|----------|
| 助手消息 content 为空 | `content` 字段通常为空，实际内容在 `agentTaskContent` | 优先读 `agentTaskContent.proposal`，fallback 到 `content` |
| `agentTaskContent` 格式 | 观察到是 PowerShell 对象格式字符串，实际可能是 JSON 字符串 | 尝试 JSON parse，失败则正则提取 `proposal` 字段 |
| 大 JSON 性能 | 单个 workspace 的 `memento/icube-ai-agent-storage` 可达 700KB+ | list 时只读 session 元数据，detail 时全量读取 |
| 数据库锁 | Trae 运行时 state.vscdb 可能被锁 | 以只读模式打开（`SQLITE_OPEN_READONLY`） |
| macOS 路径 | 未确认 macOS 的数据路径 | 先实现 Windows，macOS 待测试 |
| `hasMore: true` 的会话 | 部分会话有分页（`nextPageToken`），消息不完整 | 当前只读已加载的消息，不做分页请求 |

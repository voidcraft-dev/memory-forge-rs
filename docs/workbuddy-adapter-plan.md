# WorkBuddy 适配器实现规划

## 一、结论与范围

WorkBuddy（腾讯 CodeBuddy 系桌面端，本机 V5.9.3）适配可行，难度 **中低**。

- 会话索引是普通 SQLite（`workbuddy.db`），未加密；
- 本地会话正文是 JSONL（Claude Code 风格），未加密；
- 云端会话（`transport = 'cloud'`）本地只有元数据，正文不落盘。

第一版目标：

- 会话列表（仅本地会话，即本地存在 JSONL 正文的会话）
- 本地会话详情：用户 / 助手 / 思考 / 工具调用
- 本地会话文本编辑（user / assistant / reasoning）
- 搜索（标题、目录、正文）

不展示云端会话（本机只有元数据，没有正文，见第四节）。

不做：云端 API 拉取正文（需要登录态，且不属于纯本地工具的范围）。

## 二、数据格式

默认目录：`~/.workbuddy`（Windows 为 `C:\Users\<user>\.workbuddy`）

```text
~/.workbuddy/
├── workbuddy.db                  # SQLite，会话元数据
├── projects/
│   └── <cwd 编码目录>/
│       └── <sessionId>.jsonl     # 本地会话正文
├── traces/                       # 调试 trace（不做数据源）
└── memory/                       # 助手自维护记忆（不解析）
```

### 2.1 workbuddy.db `sessions` 表（关键字段）

| 字段 | 说明 |
|------|------|
| `id` | 会话 ID（雪花 ID 或 UUID） |
| `title` / `custom_title` | 标题，优先 `custom_title` |
| `cwd` | 工作目录（本地会话才有） |
| `status` | `completed` / `Pending` 等 |
| `created_at` / `updated_at` / `last_activity_at` | 毫秒时间戳 |
| `deleted_at` | `-1` 或 `NULL` 表示未删除 |
| `transport` | `local` 或 `cloud` |
| `conversation_origin` | `workbuddy-app` / `workbuddy-mp` 等 |
| `is_playground` | 1 表示普通会话，不用于过滤 |

### 2.2 本地会话 JSONL

`projects/<目录>/<sessionId>.jsonl`，每行一个 JSON 对象：

| `type` | 说明 |
|--------|------|
| `session-meta` | 会话元信息，忽略 |
| `message` | `role` 为 `user` / `assistant`，`content` 是数组 |
| `reasoning` | `rawContent[]`，元素 `type = reasoning_text` |
| `ai-title` | 自动标题，忽略（列表标题用 DB） |
| `file-history-snapshot` | 文件快照，忽略 |

`message.content[]` 元素：

- `input_text` / `output_text` / `text`：正文；用户消息常把真实提问包在
  `<user_query>…</user_query>` 里，前面还有大段 `<system-reminder>` 上下文；
- `tool_use` / `function_call`：工具调用（`id`、`name`、`input`）；
- `tool_result` / `function_call_output`：工具结果（`tool_use_id`/`call_id`、`content`）。

示例（省略上下文）：

```json
{"type":"message","role":"assistant","content":[{"type":"output_text","text":"嗨。"}]}
{"type":"reasoning","rawContent":[{"type":"reasoning_text","text":"用户在打招呼…"}]}
```

## 三、适配器设计

### 3.1 会话 key

直接使用 `sessions.id`，不编码路径；详情时通过扫描 `projects/*/<id>.jsonl` 定位正文。

### 3.2 list_sessions

```sql
SELECT id, title, custom_title, cwd, last_activity_at, updated_at, transport
FROM sessions
WHERE deleted_at IS NULL OR deleted_at = -1
ORDER BY COALESCE(last_activity_at, updated_at) DESC
```

- **只返回本地存在 `<id>.jsonl` 的会话**；云端会话（`transport = 'cloud'`）与丢失正文的
  本地会话一律隐藏，`total` 也按过滤后的数量计算
- `display_title`：alias > custom_title > title > id
- `updated_at`：取 `last_activity_at`，否则 `updated_at`（毫秒字符串）
- `editable`：`transport = 'local'` 且能找回 JSONL（过滤后即为 `true`）
- `preview`：标题

`list_session_keys` 用同样的查询并做同样过滤，`sort_key` 为毫秒时间戳。

### 3.3 get_session_detail

1. 从 DB 取标题、cwd；
2. `transport = 'cloud'` 或找不到 JSONL → 返回空 blocks；
3. 逐行解析 JSONL：
   - `message` / `user`：`input_text` / `text` → `role=user`，内容提取 `<user_query>`；
   - `message` / `assistant`：`output_text` / `text` → `role=assistant`；
   - `reasoning`：`rawContent[]` 的 `reasoning_text` → `role=thinking`；
   - `tool_use` / `function_call` → 挂到同消息最近的助手块，没有则生成仅工具块；
   - `tool_result` / `function_call_output` → 按 id 合并到已有工具调用；
4. `source_meta` 记录 `lineIndex`、`contentIndex`、`createdAt`、`transport`。

### 3.4 编辑目标格式

沿用 Claude 适配器的四段式：

```text
<jsonl 绝对路径>::<lineIndex>::<contentIndex>::<field>
```

`field` 取值：

- `text`：`content[contentIndex].text`
- `user_query`：只替换 `content[contentIndex].text` 里 `<user_query>…</user_query>` 的内部
  （保留 system-reminder 上下文）；没有标签时退化为整段替换
- `reasoning`：`rawContent[contentIndex].text`（`contentIndex` 指 rawContent 下标）

写回方式：读全文件 → 改目标行 → 逐行序列化 → 临时文件 + rename 覆盖。

### 3.5 搜索

- `matches_query`：标题 / cwd / 正文任一命中
- `content_search`：遍历 JSONL，把用户提问、助手正文、reasoning、工具名 / 输入 / 输出作为可搜文本，
  返回 `ContentMatch { snippet, match_index, role }`
- 只搜索本地会话（云会话已从列表隐藏）

## 四、云端会话处理

本机实测 11 条会话中 10 条为 `transport = 'cloud'`（来源 `workbuddy-app` / `workbuddy-mp`）。
它们的正文只在云端，本地无缓存，强行展示只会得到空对话。适配器策略：**直接隐藏**。

- 列表 / 搜索 / 仪表盘计数都只包含本地会话；
- 云端会话不出现在任何入口，也不可编辑；
- `get_session_detail` 对云端 ID 仍返回空 blocks（防御性行为，正常 UI 不会触达）。

## 五、需要修改的文件

| 文件 | 改动 |
|------|------|
| `src-tauri/src/platforms/workbuddy.rs` | 新增适配器 + 单元测试 |
| `src-tauri/src/platforms/mod.rs` | 注册模块、`get_adapter`、`build_commands` |
| `src-tauri/src/settings.rs` | 新增 `workbuddy_home` |
| `src-tauri/src/session_service.rs` | dashboard 平台清单加 `workbuddy` |
| `src/features/desktop/types.ts` | `workbuddyHome`、`Platform` 联合类型 |
| `src/features/desktop/api.ts` | 默认设置 |
| `src/features/desktop/i18n.ts` | `platformWorkbuddy`、`workbuddyHome`（中英） |
| `src/app/routes/settings.tsx` | 平台开关 + 路径行 |
| `src/components/layout/shell-layout.tsx` | 侧边栏入口 |
| `src/app/routes/dashboard.tsx` | 总览卡片 |
| `src/features/session/session-list.tsx` | 颜色 / 字母 / 平台名 |
| `src/app/routes/terminal-sessions.tsx` | 终端会话平台配置 |
| `README.md` | 支持平台表（中英） |

## 六、风险与待确认

| 风险 | 处理 |
|------|------|
| 工具消息格式未见样本 | 同时兼容 Claude 风格（`tool_use`/`tool_result`）与 Codex 风格（`function_call`/`function_call_output`） |
| 用户消息被 system-reminder 包裹 | 提取 `<user_query>`；编辑时只替换标签内部 |
| 云会话无正文 | 从列表、搜索、统计中隐藏 |
| `projects` 目录编码规则可能变化 | 不依赖编码规则，按 `<sessionId>.jsonl` 扫描定位 |
| 数据库被 WorkBuddy 占用 | 只读打开；写入仅针对 JSONL |
| 会话标题在 DB 中可能为空 | 回退到 session id / `ai-title` |

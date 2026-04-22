# Gemini CLI 适配器实现规划

## 一、数据格式分析

### 1.1 目录结构

```
~/.gemini/
├── projects.json              # 项目路径 → 项目名映射
├── settings.json              # Gemini CLI 自身设置
├── google_accounts.json       # 登录账号信息
├── installation_id            # 安装 ID
├── tmp/                       # 活跃会话（主要数据来源）
│   └── {project_name}/
│       ├── .project_root      # 实际工作目录路径（纯文本）
│       ├── logs.json          # 用户消息摘要日志
│       └── chats/
│           └── session-{datetime}-{hash8}.json
└── history/                   # 归档会话（结构相同，目前多为空）
    └── {project_name}/
        ├── .project_root
        └── chats/
            └── session-{datetime}-{hash8}.json
```

### 1.2 projects.json 格式

```json
{
  "projects": {
    "c:\\users\\administrator": "administrator",
    "e:\\workspace\\20260402\\mvp": "mvp"
  }
}
```

用于将会话文件夹名映射回真实工作目录路径。

### 1.3 Session JSON 格式

文件名规律：`session-{YYYY-MM-DDTHH-MM}-{uuid8}.json`

```json
{
  "sessionId": "3a99d85e-92fd-4c76-ae9f-62b92345cdf3",
  "projectHash": "37b865...",
  "startTime": "2026-04-22T01:30:43.939Z",
  "lastUpdated": "2026-04-22T01:34:11.985Z",
  "kind": "main",
  "messages": [ ... ]
}
```

### 1.4 消息格式（两种形态）

**用户消息**（content 为数组）：
```json
{
  "id": "4aee7ba2-16af-4608-91fe-0e7a2589ffd1",
  "timestamp": "2026-04-22T01:30:51.211Z",
  "type": "user",
  "content": [{ "text": "你好" }]
}
```

**Gemini 回复**（content 为字符串）：
```json
{
  "id": "0d128b72-e4aa-4bcd-b7fc-7c08ff40cf9c",
  "timestamp": "2026-04-22T01:30:54.098Z",
  "type": "gemini",
  "content": "你好！我是 Gemini CLI...",
  "thoughts": [
    { "subject": "Defining My Capabilities", "description": "..." }
  ],
  "tokens": {
    "input": 12777, "output": 33, "cached": 0,
    "thoughts": 63, "tool": 0, "total": 12873
  },
  "model": "gemini-3-flash-preview"
}
```

### 1.5 关键差异点（对比现有适配器）

| 项目 | Claude / Codex / Kiro | Gemini |
|------|-----------------------|--------|
| 文件格式 | JSONL（逐行） | **单个 JSON 文件** |
| 项目组织 | 根目录递归扫描 | **projects.json 映射 + 双目录（tmp/history）** |
| user content | 各有差异 | **始终为 `[{text}]` 数组** |
| assistant content | 各有差异 | **始终为字符串** |
| CWD 来源 | JSONL 行内字段 | **`.project_root` 纯文本文件** |
| 思考链 | Claude 有 thinking block | **`thoughts[]` 独立字段** |
| 工具调用 | 有（tool_use/tool_result）| **当前会话样本未见，待确认** |

---

## 二、需要修改的文件清单

### 2.1 新增文件

| 文件 | 说明 |
|------|------|
| `src-tauri/src/platforms/gemini.rs` | 核心适配器实现 |

### 2.2 修改文件

| 文件 | 改动内容 |
|------|----------|
| `src-tauri/src/platforms/mod.rs` | 注册 `GeminiAdapter`，在 `get_adapter()` 加 `"gemini"` 分支 |
| `src-tauri/src/settings.rs` | `AppSettings` 加 `gemini_home: Option<String>`；`AppSettingsPatch` 同步新增 |
| `src/features/desktop/types.ts` | `DesktopSettings` / `DesktopSettingsPatch` 加 `geminiHome` |
| `src/app/routes/settings.tsx` | 平台路径区块加 `PathRow`（`pickMode="directory"`） |
| `src/features/desktop/i18n/` 相关文件 | 加 `geminiHomePath` 等 i18n key |

---

## 三、适配器实现设计

### 3.1 会话 Key 设计

```
{project_name}::{filename_stem}
// 例：mvp::session-2026-04-22T01-30-3a99d85e
```

- `project_name` 来自目录名（与 `projects.json` 对应）
- `filename_stem` 去掉 `.json` 后缀

### 3.2 list_sessions 逻辑

```
1. 确定 gemini_home（优先 settings.gemini_home，否则 ~/.gemini）
2. 读取 projects.json，建立 project_name → project_path 映射
3. 扫描 tmp/{project}/.project_root → 获取 cwd
4. 扫描 tmp/{project}/chats/*.json + history/{project}/chats/*.json
5. 快速读取每个文件的 startTime / lastUpdated / messages[0]（preview）
6. 按 lastUpdated 降序排列
7. 应用 alias_map、limit、offset
```

### 3.3 get_session_detail 逻辑

```
1. 从 session_key 解析 project_name + filename_stem
2. 在 tmp 和 history 中定位文件
3. 读取 .project_root 获取 cwd
4. 解析 messages[]，转换为 TimelineBlock[]：
   - type="user"   → role=User,    content = messages[n].content[0].text
   - type="gemini" → role=Assistant, content = messages[n].content（字符串）
   - 若 thoughts 非空 → 额外插入 role=Thinking block
5. edit_target 格式：{session_key}::{message_id}::{field}
   - field = "text"（user）或 "content"（gemini）
```

### 3.4 update_message 逻辑

```
1. 解析 edit_target：session_key + message_id + field
2. 定位 JSON 文件
3. 读取 JSON → 找到 messages 中 id == message_id 的条目
4. 按 field 更新：
   - user:   messages[i].content[0].text = new_content
   - gemini: messages[i].content = new_content
5. 更新 lastUpdated 为当前时间
6. 写回文件（serde_json::to_string_pretty）
```

### 3.5 thoughts 的展示策略

thoughts 作为独立 TimelineBlock 插入，role 为 `"thinking"`，紧跟在 gemini 消息之前（与 Claude 思考链保持一致体验）。thoughts 不可编辑（只读展示）。

---

## 四、设置项

### 4.1 新增 settings 字段

```rust
// settings.rs - AppSettings
#[serde(default)]
pub gemini_home: Option<String>,   // 默认: ~/.gemini
```

默认行为：使用 `dirs::home_dir()` + `/.gemini`。

### 4.2 前端 PathRow 配置

```tsx
<PathRow
  label={t("geminiHomePath")}
  defaultHint="~/.gemini"
  pickMode="directory"
  value={snapshot.settings.geminiHome ?? ""}
  onSave={(v) => updateSettings({ geminiHome: v || null })}
/>
```

---

## 五、i18n Key 清单

需在中英文资源文件中新增：

| Key | 中文 | English |
|-----|------|---------|
| `geminiHomePath` | Gemini 数据目录 | Gemini Home Path |
| `platform.gemini` | Google Gemini CLI | Google Gemini CLI |

---

## 六、实现顺序

1. **`settings.rs`** — 加 `gemini_home` 字段（最先，其他都依赖它）
2. **`gemini.rs`** — 核心适配器
3. **`platforms/mod.rs`** — 注册适配器
4. **前端 types.ts** — 加类型
5. **前端 settings.tsx** — 加 PathRow
6. **i18n** — 加翻译 key
7. **验收测试** — 在本机跑，确认两个 project 的会话都能正常列出和展示

---

## 七、已知风险 & 待确认

| 风险 | 说明 | 处理方案 |
|------|------|----------|
| 工具调用消息 | 当前样本未见 functionCall，格式未知 | 遇到 unknown type 跳过，不 panic |
| `history/` 何时写入 | 目前为空，可能是长期归档行为 | 同时扫描两个目录，空目录无副作用 |
| Windows 路径分隔符 | `projects.json` 用 `\\`，需规范化 | `Path::new()` 自动处理 |
| 大文件性能 | JSON 全量读取（vs JSONL 早退出） | 先只读顶层字段做 list，detail 时再全量 |

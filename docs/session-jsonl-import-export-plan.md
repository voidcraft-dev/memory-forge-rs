# Session JSONL 导入导出规划

Date: 2026-06-03

Implementation status (2026-07-13):

- Raw JSONL export implemented for Claude Code, Codex, and Pi.
- Import probe and confirmation preview implemented.
- Safe copy import implemented with same-file detection and automatic conflict rename.
- CLI resume compatibility still needs real-world verification on all three platforms.

## Summary

本规划只覆盖 **Claude Code CLI、Codex、Pi** 三个平台的原始会话 JSONL 导入/导出。

推荐先做一个边界清晰的 MVP：

- 导出：从当前 session 的原始存储位置复制 `.jsonl` 文件。
- 导入：选择一个同平台 `.jsonl` 文件，校验格式后复制到本机对应平台的 session 目录。
- 不做 Markdown 导入。
- 不做跨平台转换。
- 不做 OpenCode 导入导出。
- 不保证导入后在另一台机器上 100% 可继续 resume，只保证原始记录可被 Memory Forge 识别和浏览；在原 CLI 可 resume 是目标，但需要按平台验证。

这个方向整体难度为 **小到中等**。复杂度主要来自目标路径选择、重复 session 冲突、跨机器 `cwd` 不存在、以及各 CLI 对 resume 的格式完整性要求。

## Decision

第一版只支持平台原生 JSONL。

| Platform | First Version | Difficulty | Reason |
| --- | --- | --- | --- |
| Claude Code CLI | Yes | Low-Medium | 原始会话就是 `.jsonl`，当前适配器已直接读取 `.claude/projects/**/*.jsonl`。 |
| Codex | Yes | Low-Medium | 原始会话就是 `.jsonl`，当前适配器已直接读取 `.codex/sessions/**/*.jsonl`。 |
| Pi | Yes | Low-Medium | 原始会话就是 `.jsonl`，当前适配器已直接读取 `.pi/agent/sessions/**/*.jsonl`。 |
| OpenCode | No | Medium-High | 原始会话存储在 SQLite `opencode.db`，需要复制关联表数据，不适合放入第一版。 |

## Non-Goals

第一版明确不做：

- 从 Markdown 反向导入 session。
- 将 Claude JSONL 转为 Codex JSONL，或任意跨平台格式转换。
- 重建 tool call、reasoning、usage、timestamp 等丢失字段。
- 修改导入文件里的 `cwd`、`sessionId`、`parentId` 等原始内容。
- 覆盖已有同名 session，除非用户显式选择 overwrite。
- OpenCode SQLite session 导入。

## Current Code Shape

当前项目没有把 session 存入 Memory Forge 自己的统一会话库，而是按平台直接读取原始数据源：

- Claude：`src-tauri/src/platforms/claude.rs`
  - 扫描 `claude_home/projects/**/*.jsonl`
  - `session_key` 是原始文件路径
- Codex：`src-tauri/src/platforms/codex.rs`
  - 扫描 `codex_home/sessions/**/*.jsonl`
  - `session_key` 是原始文件路径
- Pi：`src-tauri/src/platforms/pi.rs`
  - 扫描 `pi_home/sessions/**/*.jsonl`
  - `session_key` 是 `{projectKey}::{stem}`

当前 Markdown 导出在前端 `src/features/session/session-detail.tsx` 里完成，导出的内容来自统一后的 `SessionDetail.blocks`。这条路径只适合可读文本归档，不适合作为导入源。

## Product Behavior

### Raw JSONL Export

在 session 详情页的导出菜单中增加：

- `导出 Markdown`
- `导出原始 JSONL`

导出原始 JSONL 时：

1. 根据当前 `platform` 和 `sessionKey` 找到原始文件。
2. 生成默认文件名。
3. 通过保存对话框选择目标路径。
4. 复制原始 `.jsonl` 文件到目标位置。

推荐默认文件名：

| Platform | Default File Name |
| --- | --- |
| Claude | `claude-{sessionId}.jsonl` |
| Codex | `codex-{sessionId}.jsonl` |
| Pi | `pi-{sessionId}.jsonl` |

导出不应该重新序列化 JSONL，避免改变字段顺序、未知字段、空格、以及 CLI 可能依赖的细节。

### Raw JSONL Import

在平台页或 session 列表页增加 `导入 JSONL` 操作。

导入流程：

1. 用户选择平台：Claude / Codex / Pi。
2. 用户选择 `.jsonl` 文件。
3. 后端读取前若干行和末尾若干行，判断是否符合目标平台格式。
4. 从文件中提取：
   - session id
   - cwd
   - timestamp 或文件时间
   - 可选 title / preview
5. 计算目标目录和目标文件名。
6. 检查冲突。
7. 复制文件。
8. 刷新当前平台列表并选中新导入 session。

导入成功后的状态提示应该明确：

- 已导入到哪个平台。
- 是否检测到 `cwd` 不存在。
- 是否使用了重命名后的目标文件名。

## Platform Details

### Claude Code CLI

当前读取路径：

```text
{claude_home}/projects/**/*.jsonl
```

默认 home：

```text
~/.claude
```

可从 JSONL 行中提取：

- `sessionId`
- `cwd`
- `timestamp`
- `message.role`
- `message.content`

导入目标路径建议：

```text
{claude_home}/projects/{projectKey}/{sessionId}.jsonl
```

`projectKey` 策略：

1. 优先从导入文件中的 `cwd` 生成 Claude 项目目录名。
2. 如果无法生成或 `cwd` 为空，放入 `projects/imported/`。
3. 如果目标文件冲突，默认生成 `{sessionId}-imported-{timestamp}.jsonl`。

需要验证的问题：

- Claude Code CLI 的 project 目录命名规则是否始终可从 `cwd` 推导。
- 导入到 `projects/imported/` 后 Memory Forge 可以浏览，但 Claude CLI 是否能 resume。
- `claude --resume {sessionId}` 是否只依赖 `sessionId`，还是也依赖项目目录映射。

### Codex

当前读取路径：

```text
{codex_home}/sessions/**/*.jsonl
```

默认 home：

```text
~/.codex
```

可从 JSONL 行中提取：

- `payload.id`
- `payload.cwd`
- `payload.timestamp`
- `payload.type`
- `payload.role`
- `payload.content`

导入目标路径建议：

```text
{codex_home}/sessions/{YYYY}/{MM}/{DD}/{sessionId}.jsonl
```

日期来源优先级：

1. JSONL 中第一条可用 timestamp。
2. JSONL 文件修改时间。
3. 当前日期。

冲突处理：

- 如果目标路径不存在，直接复制。
- 如果同路径存在且内容相同，提示“已存在”并可直接选中。
- 如果同路径存在但内容不同，默认重命名为 `{sessionId}-imported-{timestamp}.jsonl`。

需要验证的问题：

- `codex resume {sessionId}` 对文件名和目录日期是否有硬性要求。
- `payload.id` 多次出现时应该使用第一个还是最后一个。
- 新旧 Codex JSONL schema 是否都能通过当前 parser。

### Pi

当前读取路径：

```text
{pi_home}/sessions/**/*.jsonl
```

默认 home：

```text
~/.pi/agent
```

环境变量：

```text
PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR
```

可从 JSONL 行中提取：

- `type: "session"`
- `id`
- `cwd`
- `timestamp`
- `type: "session_info"` 的 `name`
- `message.role`
- `message.content`

导入目标路径建议：

```text
{pi_sessions_root}/{projectKey}/{timestamp}_{sessionId}.jsonl
```

`projectKey` 策略：

1. 优先从 `cwd` 生成 Pi project key。
2. 如果 `cwd` 为空，使用 `imported`。

Pi 当前详情页已有按路径恢复命令：

```text
pi --session "{path}"
```

因此 Pi 的导入容错相对更高。即使 session id resume 不稳定，路径 resume 也可能可用。

需要验证的问题：

- Pi project key 的生成规则是否需要完全匹配 CLI 原生规则。
- 文件名中的时间戳格式是否影响 CLI resume。
- `current_chain_indices` 依赖 parentId 链，导入文件必须保持原样。

## Backend API Plan

建议新增 Tauri commands：

```rust
session_export_raw_jsonl(platform: String, session_key: String, output_path: String) -> Result<RawJsonlExportResult, String>
session_import_raw_jsonl(platform: String, input_path: String, conflict_policy: ImportConflictPolicy) -> Result<RawJsonlImportResult, String>
session_probe_jsonl_import(platform: String, input_path: String) -> Result<RawJsonlImportPreview, String>
```

建议数据结构：

```rust
pub struct RawJsonlImportPreview {
    pub platform: String,
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    pub preview: String,
    pub detected_at: String,
    pub target_path: String,
    pub conflict: Option<RawJsonlConflict>,
    pub warnings: Vec<String>,
}

pub struct RawJsonlImportResult {
    pub platform: String,
    pub session_key: String,
    pub session_id: String,
    pub target_path: String,
    pub warnings: Vec<String>,
}

pub enum ImportConflictPolicy {
    Rename,
    Overwrite,
    SkipIfSame,
}
```

实现上建议增加一个独立模块：

```text
src-tauri/src/session_transfer.rs
```

该模块只负责：

- 解析和校验 JSONL。
- 推导目标路径。
- 复制文件。
- 返回导入预览和结果。

不要把导入逻辑塞进前端，也不要让前端拼平台目录。

## Validation Rules

基础校验：

- 文件扩展名建议为 `.jsonl`，但最终以内容为准。
- 文件非空。
- 至少有一行可解析为 JSON object。
- 行数过大时不需要全量预览，但最终复制前可以做完整 parse 或抽样 parse。

平台识别建议：

| Platform | Required Signal |
| --- | --- |
| Claude | 任意行存在 `sessionId` 或 `message.role`，且无 `payload.type` 包装。 |
| Codex | 任意行存在 `payload.type`。 |
| Pi | 任意行存在 `type: "session"` 或 `message` object，并且 top-level `type` 为 Pi 风格。 |

警告而非失败：

- `cwd` 为空。
- `cwd` 在本机不存在。
- timestamp 缺失。
- session id 缺失，使用文件名 stem。
- 文件平台特征较弱，只能低置信度识别。

必须失败：

- 文件不存在。
- 文件无法读取。
- 没有任何有效 JSONL 行。
- 目标平台与文件格式明显不匹配。
- 目标路径逃逸出平台 session 根目录。

## Conflict Policy

默认策略：`Rename`。

冲突判断：

1. 目标路径不存在：直接导入。
2. 目标路径存在且内容 hash 相同：返回已存在结果。
3. 目标路径存在但内容不同：
   - 默认重命名。
   - UI 可提供 overwrite，但需要二次确认。

重命名格式：

```text
{originalStem}-imported-{YYYYMMDDHHMMSS}.jsonl
```

## Security

导入导出涉及本机文件读写，需要注意：

- 目标路径必须限制在对应平台 session 根目录下。
- 不允许通过导入文件内容控制任意写入路径。
- 复制前使用 canonicalize 或等价逻辑确认路径边界。
- 不自动执行导入文件里的任何命令。
- UI 需要提示 JSONL 可能包含敏感信息，例如本地路径、命令输出、tool result、环境上下文。

## Frontend Plan

### Export UI

在现有导出弹层中增加第二个按钮：

- `下载 Markdown (.md)`
- `下载原始 JSONL (.jsonl)`

如果当前平台不支持 raw JSONL 导出，按钮禁用并显示原因。

### Import UI

在 session list 顶部工具栏增加：

- `导入 JSONL`

交互：

1. 点击后打开文件选择。
2. 后端返回 `RawJsonlImportPreview`。
3. 显示预览确认：
   - platform
   - session id
   - cwd
   - target path
   - warnings
   - conflict 状态
4. 用户确认后执行导入。
5. 刷新列表，选中导入 session。

## Test Plan

Rust 单元测试：

- Claude JSONL probe 能识别 session id 和 cwd。
- Codex JSONL probe 能识别 payload id 和 cwd。
- Pi JSONL probe 能识别 session id、title、cwd。
- 目标路径推导不会逃逸 session root。
- 冲突时 rename 生效。
- 相同文件 hash 时返回 already exists。

集成测试或手工测试：

- 从另一台机器导出的 Claude JSONL 可导入并显示。
- 从另一台机器导出的 Codex JSONL 可导入并显示。
- 从另一台机器导出的 Pi JSONL 可导入并显示。
- 导入后刷新、搜索、详情页渲染正常。
- 导入后 CLI resume 行为分别验证：
  - `claude --resume {sessionId}`
  - `codex resume {sessionId}`
  - `pi --session "{path}"`

## Rollout Plan

### Phase 1: Raw Export

先实现原始 JSONL 导出。

原因：

- 不改变平台目录。
- 风险低。
- 可以先让用户把其他机器的原始文件拿到手。

### Phase 2: Import Preview

实现 probe 和预览，不真正复制。

原因：

- 可以验证三种 JSONL 识别和目标路径推导。
- UI 可以先把冲突、warnings 展示清楚。

### Phase 3: Import Copy

实现实际复制和刷新列表。

默认只允许 `Rename` 和 `SkipIfSame`，先不开放 overwrite。

### Phase 4: CLI Resume Verification

分别验证三个平台导入后的 resume 行为。

如果某个平台只能 Memory Forge 浏览但 CLI resume 不稳定，需要在 UI 中明确标记。

## Open Questions

- Claude project directory key 是否必须完全匹配 Claude Code CLI 自己生成的目录名？
- Codex `sessions/{YYYY}/{MM}/{DD}` 日期目录是否影响 `codex resume` 查找？
- Pi project key 是否影响 `pi --session {sessionId}`，还是只要路径 resume 可用即可？
- 是否需要导出一个带 manifest 的 zip 包，记录原始平台、session key、源文件名、hash？
- 是否允许用户导入到自定义 project/cwd，而不是使用 JSONL 内的 cwd？

## Recommendation

建议按以下顺序实现：

1. Claude / Codex / Pi raw JSONL export。
2. Claude / Codex / Pi import preview。
3. Claude / Codex / Pi import copy with rename conflict policy。
4. 单独验证 CLI resume。

不要在第一版加入 Markdown 导入、跨平台转换和 OpenCode SQLite 导入。这样能快速覆盖“把其他机器上的 session 导入到本机浏览”的核心需求，同时把高风险部分留到后续版本。

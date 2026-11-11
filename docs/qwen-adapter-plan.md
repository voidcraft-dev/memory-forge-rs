# Qwen Code 适配器

## 数据位置

`~/.qwen/projects/<encoded-cwd>/chats/`

- `<session-id>.jsonl`：会话事件流
- `<session-id>.title.json`：标题（`displayName`）和更新时间
- `<session-id>.runtime.json`：启动时的 `work_dir`、版本等

`<encoded-cwd>` 由工作目录编码而来（如 `e--workspace-20260402`）。可在设置页覆盖 `~/.qwen`。

## JSONL 事件

每行一个 JSON 对象，关键字段：

- `type`：`user` / `assistant` / `tool_result` / `system`
- `provenance`：真实用户输入为 `real_user`，助手为 `assistant_output`
- `timestamp`：ISO 8601
- `cwd`：工作目录
- `message.parts`：Gemini 风格内容块

内容块：

- `{ "text": "...", "thought": true }` → 思考
- `{ "text": "..." }` → 正文
- `{ "functionCall": { "id", "name", "args" } }` → 工具调用
- `{ "functionResponse": { "id", "name", "response" } }` → 工具结果（记录类型为 `tool_result`）
- `system` 记录（如 `memory_catalog_snapshot`、遥测）不展示

## 适配器行为

- 列表：标题优先取 `.title.json`，更新时间取标题 sidecar 的 `updatedAt`，没有则用文件 mtime；`cwd` 取 `.runtime.json` 的 `work_dir` 或首行 `cwd`。
- 详情：用户消息仅保留 `provenance == "real_user"`（或无 provenance）的记录；助手正文、思考分别成块；`functionCall` 作为工具块挂到同条助手的最后一个正文块，`functionResponse` 按 id 合并输出。
- 编辑：`<project>::<stem>::<line>::<part>::text|thought`，整文件逐行改写，未知字段保持不变。
- 搜索：用户/助手/思考/工具名、参数和输出均可命中。
- 会话 key：`<project>::<session-id>`，无恢复命令。

## 测试

`cargo test --bin memory-forge platforms::qwen`，覆盖列表/详情、用户与思考编辑、搜索。

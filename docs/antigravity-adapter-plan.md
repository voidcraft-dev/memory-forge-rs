# Antigravity 适配器（只读）

Antigravity（反重力 IDE）把会话索引和可读转录分开存放：

- `~/.gemini/antigravity/conversation_summaries.db`
  - `conversation_summaries` 表：`conversation_id`、`title`、`preview`、`step_count`、`last_modified_time`、`workspace_uris`、`parent_conversation_id`、`nesting_depth`
- `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/`
  - `transcript_full.jsonl`：完整转录（优先）
  - `transcript.jsonl`：截断版转录

每个会话还有 `conversations/<id>.db`，其中 `steps.step_payload` 为 protobuf 二进制。为避免写坏原始数据，本适配器**只读**：支持列表、详情和搜索，不提供编辑/擦除。

## 转录事件

每行一个 JSON：

- `step_index`、`source`（`USER_EXPLICIT` / `MODEL` / `SYSTEM`）、`type`、`created_at`
- `USER_INPUT`：用户输入，正文包在 `<USER_REQUEST>...</USER_REQUEST>` 中，后面可能跟 `<ADDITIONAL_METADATA>`；展示时只取请求正文
- `PLANNER_RESPONSE`：助手回复，可能含 `thinking`、`content`、`tool_calls[]`
- `GENERIC`：工具执行结果，紧跟在对应工具调用之后（`step_index` 连续）
- `CHECKPOINT` / `SYSTEM_MESSAGE` / `ERROR_MESSAGE`：系统事件，不展示

工具调用字段为 `{ name, args }`，没有独立 id。适配器把 `step_index + 1` 且类型为 `GENERIC` 的下一步内容作为该调用的输出；多工具调用或结果缺失时只保留输入。

## 适配器行为

- 列表：只展示顶层会话（`parent_conversation_id` 为空、`nesting_depth = 0`），且必须存在转录文件；标题优先 `title`，其次 `preview`，再退回首条用户请求。
- 工作目录：解析 `workspace_uris` 的 `file://` URI（支持 `%3A` / `%5C` 编码）。
- 时间：`last_modified_time` 形如 `2026-08-21 08:00:53.1234567+00:00`，统一转 RFC 3339。
- 详情：用户消息、思考、助手正文、工具调用与输出；所有块 `editable = false`。
- 搜索：正文、思考、工具名/参数、工具输出。
- 会话 key：`<conversation-id>`，无恢复命令。

## 测试

`cargo test --bin memory-forge platforms::antigravity`，覆盖列表（过滤子代理）、详情工具结果映射、搜索与只读校验。

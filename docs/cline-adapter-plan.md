# Cline 适配器

## 数据位置

Cline 4.x（VS Code 扩展 `saoudrizwan.claude-dev`）把会话放在：

`~/.cline/data/sessions/<session-id>/`

- `<session-id>.json`：元数据，含 `cwd`、`prompt`、`metadata.title`、模型与 token 统计
- `<session-id>.messages.json`：对话消息，含 `updated_at`、`messages[]`

同一目录还可能有子代理的 `*.messages.json`，适配器只读取主文件。设置页可覆盖 `~/.cline`。

> 旧版 Cline 使用 VS Code `globalStorage/saoudrizwan.claude-dev/tasks/`，当前安装的 4.1.26 已迁移到 `~/.cline`，因此只适配新路径。

## 消息格式

`messages[]` 元素：

```json
{ "id": "...", "role": "user|assistant", "ts": 1794368159522, "content": [ ... ] }
```

`content[]` 块类型：

- `text`：正文。用户文本通常包在 `<user_input mode="act">...</user_input>` 中，展示时剥离，编辑时保留外层标签。
- `reasoning` / `thinking`：思考过程。
- `tool-call`：`{ toolCallId, toolName, input }`。
- `tool-result`：`{ toolCallId, toolName, output, isError }`。
- 其他（`image`、`file` 等）暂不展示。

## 适配器行为

- 列表：标题取 `metadata.title`，退回 `prompt`；更新时间取 messages 文件的 `updated_at`，没有则用文件 mtime；`cwd` 取元数据。
- 详情：用户/助手正文、思考分别成块；工具调用挂到同条助手的最后一个正文块，工具结果按 `toolCallId` 合并输出；孤立结果单独成块。
- 编辑：`<session-id>::<message-index>::<content-index>::text|reasoning`，改写 messages JSON 并刷新 `updated_at`。
- 搜索：正文、思考、工具名/参数/输出均可命中。
- 会话 key：`<session-id>`，无恢复命令。

## 测试

`cargo test --bin memory-forge platforms::cline`，覆盖列表/详情、用户包装标签保留、工具结果合并、搜索。

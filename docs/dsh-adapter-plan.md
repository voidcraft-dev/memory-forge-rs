# DeepSeek Harness 适配器实现说明

## 一、结论与范围

DeepSeek Harness（`dsh`）的会话日志是追加写入的 zstd 压缩 JSONL，明文、可完整解析和改写。

第一版目标：

- 新增平台入口 **DeepSeek Harness**（默认 `~/.dsh`，可配置）
- 列表：标题 / 工作目录 / 更新时间 / 首条用户消息预览
- 详情：用户消息、助手消息、思考过程、工具调用与结果
- 编辑：用户文本、助手文本、思考文本，写回后 `dsh` 继续会话即可生效
- 搜索：标题 / 目录 / 正文 / 工具输出

不做：`user/message` 中的系统注入消息（时间上下文、技能目录、运行时上下文、后台任务通知、
审批策略变更等）不展示、不编辑。

## 二、数据格式

```text
~/.dsh\
├── sessions\
│   └── <encoded-cwd>\
│       └── <session-id>\
│           ├── session.v4.jsonl.zstd   # 当前格式，事件日志
│           └── session.jsonl.zstd      # 旧格式（适配器兼容读取）
└── storages\
    ├── workspace.json                  # 工作区 / 归档 / 置顶
    └── session_projcache.json          # 列表缓存（标题可能为 null）
```

每行一个事件：

```jsonc
{"type": "session", "version": 4, "id": "session-…", "cwd": "E:\\work", "createdAt": 1790739895523}
{"type": "agent/inbox/spliced", "seq": 1, "time": …, "data": {"inserted": [<message>]}}
{"type": "user/message", "seq": 1, "time": …, "data": <message>}
{"type": "assistant/message", "seq": 2, "time": …, "data": {"message": <message>}}
{"type": "tool/call", …}          // 工具调用同时内嵌在 assistant.message.content
{"type": "tool/result", "seq": 3, "data": {"message": {"toolCallId": "call-1", …}}}
{"type": "session/title", "seq": 4, "data": {"title": "…"}}
```

消息结构：

```jsonc
{
  "role": "user | assistant | tool",
  "id": "uuid",
  "source": {"kind": "user | model | tool | time-context | …"},
  "content": [
    {"type": "text", "text": "…"},
    {"type": "reasoning", "text": "…"},
    {"type": "tool-call", "id": "call-1", "name": "read", "arguments": "{…}"},
    {"type": "image", "attachment": {…}}
  ]
}
```

会话 key：`<encoded-cwd>/<session-id>`（目录名即会话 ID，可能带 `session-` 前缀）。

## 三、适配器设计

- 平台 ID：`dsh`
- 扫描 `sessions/*/*/session.v4.jsonl.zstd`，旧格式回退到 `session.jsonl.zstd`
- 列表：只流式解压前 512 KB，从中提取 `session.cwd`、最后一个 `session/title`、
  首条真实用户消息预览；更新时间取文件 mtime，不读完整日志
- 真实用户消息过滤：`role == "user"` 且 `source.kind == "user"`；
  `user/message` 与 `agent/inbox/spliced` 会重复出现，按消息 `id` 去重
- 详情：完整解压后按事件顺序展开
  - 用户文本 → 用户块（可编辑）
  - 助手 `text` → 助手块（可编辑）
  - 助手 `reasoning` → 思考块（可编辑）
  - 助手 `tool-call` → 工具调用；`tool/result` 按 `toolCallId` 合并输出
- 编辑目标：`<session_key>::<message_id>::<content_index>::text|thinking`
- 写回：同一条消息的 `user/message` 与 `agent/inbox/spliced` 副本一并修改，
  再整体重新压缩写回
- 搜索：标题 / 目录 / 正文 / 工具输入输出

## 四、验证

- 真实库：6 个会话、标题与目录解析正常、详情 15 个块
- 单元测试：列表/详情、用户消息双副本编辑、思考编辑、搜索
- `cargo test` 94 项通过

## 五、风险

| 风险 | 处理 |
|------|------|
| 日志正在追加写入 | 与其他 JSONL 平台一致：整文件读改写；`dsh` 侧为追加，冲突概率低 |
| 同一用户消息存在两份副本 | 按 `id` 去重展示，编辑时两份都更新 |
| 系统注入消息干扰阅读 | 仅展示 `source.kind == "user"` 的用户消息 |
| 大日志（数 MB） | 列表只读前 512 KB；完整解压仅在打开详情/编辑时发生 |
| 事件结构随版本变化 | 只依赖 `type` / `data.message.content` / `toolCallId` 等稳定字段，未知字段原样保留 |
| 旧版 `session.jsonl.zstd` | 作为回退路径支持读取 |

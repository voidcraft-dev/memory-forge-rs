# Zed 适配器实现说明

## 一、结论与范围

Zed 编辑器的 Agent 面板会话可以完整接入：会话索引和正文都在一个明文 SQLite 库里，
正文是 zstd 压缩的 JSON，未加密、可直接读写。

第一版目标：

- 新增平台入口 **Zed**（默认 `%LOCALAPPDATA%\Zed`，可配置）
- 列表：标题 / 目录 / 更新时间
- 详情：用户消息、助手消息、思考过程、工具调用与结果
- 编辑：用户文本、助手文本、思考文本，写回后 Zed 继续对话即可生效
- 搜索：标题 / 目录 / 正文 / 工具输出

不做：Zed 的协作/云端历史；非 `threads` 表的数据。

## 二、数据格式

```text
%LOCALAPPDATA%\Zed\
└── threads\
    └── threads.db        # SQLite（明文）
```

`threads` 表关键字段：

| 字段 | 说明 |
|------|------|
| `id` | 线程 UUID |
| `summary` | 列表标题 |
| `updated_at` / `created_at` | ISO-8601 字符串 |
| `data_type` | 目前恒为 `zstd` |
| `data` | zstd 压缩的线程 JSON |
| `folder_paths` | 工作目录（多路径以换行分隔） |

线程 JSON 关键结构：

```jsonc
{
  "title": "…",
  "messages": [
    {"User":  {"id": "…", "content": [{"Text": "…"}, {"Image": {…}}]}},
    {"Agent": {
      "content": [
        {"Text": "…"},
        {"Thinking": {"text": "…"}},
        {"ToolUse": {"id": "call-1", "name": "read", "raw_input": "{…}"}}
      ],
      "tool_results": {"call-1": {"is_error": false, "content": [{"Text": "…"}]}}
    }}
  ]
}
```

## 三、适配器设计

- 平台 ID：`zed`
- 会话 key：`threads.id`
- 列表：`SELECT id, summary, updated_at, folder_paths FROM threads ORDER BY updated_at DESC`
- 详情：读取并解压 `data`，按消息顺序展开为块
  - `User.Text` → 用户块（可编辑）
  - `Agent.Text` → 助手块（可编辑）
  - `Agent.Thinking` → 思考块（可编辑）
  - `Agent.ToolUse` → 工具调用，挂到最近的助手块；`tool_results` 按 `callId` 合并输出
- 编辑目标：`<thread_id>::<message_index>::<content_index>::text|thinking`
- 写回：解压 → 修改 JSON → 重新 zstd 压缩（level 3）→ `UPDATE threads SET data_type='zstd', data=?`
- 搜索：标题 / 目录 + 解压后的文本与工具输出

## 四、验证

- 真实库：37 条线程，全部 `data_type='zstd'`，schema 与实现一致
- 单元测试：列表/详情、用户消息编辑（保持 zstd）、全文搜索
- `cargo test` 94 项通过

## 五、风险

| 风险 | 处理 |
|------|------|
| Zed 升级改 JSON 结构 | 只依赖 `messages` / `content` / `tool_results` 稳定结构，未知字段原样保留 |
| 线程正在写入 | SQLite 自带事务；写入后 Zed 重新打开线程即可看到修改 |
| 大线程（10 MB+） | 仅在打开详情/编辑时解压，列表不解压 |
| zstd 帧无内容大小 | 使用流式解码 `zstd::stream::decode_all`，兼容两种帧 |

# Qoder CN 适配器实现说明

## 一、结论与范围

Qoder CN（`com.qodercn.app`）的 Agent 会话是明文的 Claude Code 风格 JSONL，可直接解析和改写，
适配器复用现有 `ClaudePlatform`。

第一版目标：

- 新增平台入口 **Qoder CN**（默认 `~/.qoder-cn`，可配置）
- 列表：标题（取首条用户消息）、目录、更新时间
- 详情：用户 / 助手 / 思考 / 工具调用与结果 / 图片占位
- 编辑：用户文本、助手文本、思考文本
- 搜索：标题、目录、正文、工具输出

不做：云端会话、附件原文件下载、Qoder 自己的 UI 状态（`chat-session-turn-payload-buffer.sqlite` 等缓存库）。

## 二、数据格式

```text
~/.qoder-cn\
└── projects\
    └── <encoded-cwd>\
        └── <session-id>.jsonl     # 会话事件日志（明文）
```

每行一个事件，与 Claude Code 基本一致：

| 事件 `type` | 说明 |
|---|---|
| `user` / `assistant` | 消息，含 `uuid`、`timestamp`、`cwd`、`sessionId`、`message` |
| `attachment` | 技能目录等附件上下文 |
| `runtime-config` | 模型与推理配置 |
| `active-leaf` | 当前分支叶子节点 |
| `last-prompt` | 最近一次用户输入 |
| `workspace-directories` | 工作目录 |

消息内容块：

```jsonc
{"type": "text", "text": "…"}
{"type": "thinking", "thinking": "…"}
{"type": "tool_use", "id": "call_…", "name": "Read", "input": {…}}
{"type": "tool_result", "tool_use_id": "call_…", "content": "…"}
{"type": "image", "source": {"type": "url", "url": "…"}}
```

## 三、适配器设计

- 平台 ID：`qoder-cn`
- 会话 key：`projects/<encoded-cwd>/<session-id>.jsonl` 的完整路径（与 Claude 适配器一致）
- 解析：直接复用 `ClaudePlatform::new(~/.qoder-cn)`，其 `projects_root` 正好指向 Qoder 的会话目录
- 外壳适配器 `QoderPlatform` 只做三件事：
  1. 把返回结果里的 `platform` 改成 `qoder-cn`
  2. 用首条用户消息生成可读标题（Qoder 不落盘标题，UI 里的名字是它自己生成的）
  3. 其余列表 / 详情 / 编辑 / 搜索 / 内容索引全部委托给 Claude 适配器
- 编辑目标与写回逻辑沿用 Claude 的四段式格式，直接修改对应 JSONL 行

## 四、验证

- 真实数据：`~/.qoder-cn/projects` 下已有会话，`user` / `assistant` / `thinking` / `tool_use` / `tool_result` / `image` 均能解析
- 单元测试：列表与详情、用户消息编辑、搜索
- `cargo test` 通过

## 五、风险

| 风险 | 处理 |
|------|------|
| Qoder 升级改动 JSONL 结构 | 结构目前与 Claude Code 一致，未知字段原样保留；若分离再独立实现 |
| 会话标题不在文件中 | 用首条用户消息前 60 字作为标题，别名优先级更高 |
| 工具结果为字符串或数组 | Claude 适配器已同时兼容两种形式 |
| 会话运行中被写入 | 与 Claude 平台一致：整文件读改写，`qoder` 侧为追加写入，冲突概率低 |
| 图片是远程 URL | 仅显示 `[图片]` 占位，不下载 |

# Cindy 适配器实现规划（国内版 / 国际版）

## 一、结论与范围

Cindy（桌面 AI 编程助手）国内版与国际版都可接入，数据结构一致、均未加密：

- 会话索引在明文 SQLite `cindy-local-v1.db`；
- 真正的 agent 上下文在 `pi-agent-home/sessions/*.jsonl`（Pi v3 格式）；
- `cc` 类型会话的正文在用户标准 `~/.claude/projects/...`，已由 Claude Code 平台覆盖；
- `codex` 类型会话本次不处理。

第一版目标：

- 新增两个平台入口：**Cindy**（`%APPDATA%\Cindy`）与 **Cindy 国际版**（`%APPDATA%\CindyGlobal`）
- 列表/标题/目录/时间来自 DB，只展示 `agent_kind = 'pi'` 且正文存在的会话
- 详情与编辑落到 Pi JSONL：用户 / 助手 / 思考 / 工具调用
- 隐藏 Cindy 自动注入的 `[UI language]` 系统提示，编辑时保留

不做：`cc` / `codex` 会话（前者已在 Claude 平台，后者暂不接入）；云端数据同步。

## 二、数据格式

```text
%APPDATA%\Cindy\                 # 国内版
%APPDATA%\CindyGlobal\           # 国际版
├── cindy-local-v1.db            # SQLite，会话索引 + UI 消息镜像（旧格式）
├── cindy-<cuid>.db              # 每个登录档案/设备一个库，会话可能只在这里
├── pi-agent-home/
│   └── sessions/
│       └── <timestamp>_<uuid>.jsonl   # Pi v3 会话，agent 真正 resume 的数据源
├── claude-code/                 # 内置 Claude Code 二进制
├── codex-home/                  # 内置 Codex
└── pi/ ...
```

**适配器会扫描目录下所有 `cindy-*.db`（排除 `.bak`）并按会话 ID 去重**，
取 `last_activity_at` 最新的那条。只读打开，互不干扰。

### 2.1 `sessions` 表（关键字段）

| 字段 | 说明 |
|------|------|
| `id` | Cindy 会话 ID（UUID） |
| `title` | 会话标题 |
| `working_dir` | 工作目录 |
| `model` / `effort` / `permission_mode` | 模型与权限配置 |
| `status` | `active` / `archived` / `deleted` |
| `agent_kind` | `pi` / `cc` / `codex` |
| `sdk_session_id` | 底层 agent 会话定位：pi 为 JSONL 绝对路径，cc 为 Claude 会话 UUID |
| `created_at` / `updated_at` / `last_activity_at` | 毫秒时间戳 |
| `list_preview` | 列表预览文本 |

### 2.2 `messages` 表（仅作参考，不作为正文来源）

`role` 取值：`user` / `assistant` / `thinking` / `tool_use` / `tool_result` / `ask_user` / `error` / `context_rebuild` / `agent_switch`。
`content` 为 JSON 或纯文本。该表是 Cindy 的 UI 镜像，**修改它不会影响 resume 后 AI 的记忆**，因此适配器不写这张表。

### 2.3 Pi 会话 JSONL

`type`：`session` / `model_change` / `thinking_level_change` / `message`。
`message.role`：`system` / `user` / `assistant` / `toolResult`。

Cindy 会在每个会话首条用户消息前附加一段：

```text
[UI language] System note appended each turn. ...\n\n<用户真实输入>
```

适配器在展示时剔除该前缀；写回时只替换 `\n\n` 之后的用户正文，前缀原样保留。

## 三、适配器设计

- 平台 ID：`cindy` / `cindy-global`
- 会话 key：`sessions.id`
- 正文定位：`sdk_session_id`；若为空或文件不存在，回退到 `pi-agent-home/sessions/<stem>.jsonl`
- Pi 解析复用现有 `PiPlatform`：把它的会话根指向 `pi-agent-home`，键为 `sessions::<stem>`，
  `path_for_key` 会解析到 `pi-agent-home/sessions/<stem>.jsonl`
- 列表过滤：`status != 'deleted'`、`agent_kind = 'pi'`、正文文件存在
- 详情：Pi 解析出的 blocks，用户块去掉 `[UI language]` 前缀
- 编辑目标：沿用 Pi 的四段式 `<key>::<entryId>::<contentIndex>::text`
- 编辑写回：用户消息保留 `[UI language]` 前缀，只替换用户正文；助手消息整段替换
- 搜索：标题 / 工作目录 + JSONL 全文；`content_search` 复用 Pi 实现

## 四、国内版 / 国际版差异

| | 国内版 | 国际版 |
|---|---|---|
| 数据目录 | `%APPDATA%\Cindy` | `%APPDATA%\CindyGlobal` |
| 本机会话 | 93（pi 70 / cc 22） | 14（pi 11 / cc 2 / codex 1） |
| 多档案库 | 无 | 另有 5 条 pi 会话分散在 `cindy-<cuid>.db`，合并后 pi 共 16 条 |

两版结构完全一致，适配器只有数据目录和平台名称不同。国际版早期 DB 的表结构更精简
（没有 `last_activity_at` / `list_preview`），适配器按列名读取并回退，兼容两种 schema。

## 五、需要修改的文件

| 文件 | 改动 |
|------|------|
| `src-tauri/src/platforms/cindy.rs` | 新增适配器 + 单元测试 |
| `src-tauri/src/platforms/mod.rs` | 注册模块、`get_adapter`、`build_commands` |
| `src-tauri/src/settings.rs` | 新增 `cindy_home` / `cindy_global_home` |
| `src-tauri/src/session_service.rs` | dashboard 平台清单 |
| `src/**` 前端 | 平台类型、默认设置、i18n、设置页、侧边栏、总览卡片、会话列表、终端分组 |
| `README.md` | 支持平台表（中英） |

## 六、风险与待确认

| 风险 | 处理 |
|------|------|
| Cindy 升级改动 DB 字段 | 只依赖稳定字段，正文按 `sdk_session_id` 定位 |
| Pi 会话目录是扁平的 | 复用 Pi 适配器时把会话根指向 `pi-agent-home`，不改 Pi 代码 |
| 用户消息带 `[UI language]` 前缀 | 展示时剔除，编辑时保留前缀只替换正文 |
| DB 是 UI 镜像，不能改 | 编辑只写 JSONL，保证 resume 生效 |
| cc 会话不重复展示 | 由 Claude Code 平台负责 |
| 会话运行中 JSONL 被占用 | 与 Pi 适配器一致：整文件读改写，Cindy 侧写入为追加，冲突概率低 |

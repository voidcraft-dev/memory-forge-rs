# Windsurf 适配器实现规划

## 一、数据格式分析

### 1.1 目录结构

```
Windows:
~\.codeium\windsurf\                    # Windsurf 核心数据目录
├── cascade\
│   └── {session-uuid}.pb              # Cascade 会话数据（Protobuf，加密）
├── database\
│   └── {hash}\                        # 本地数据库（空目录，待确认）
├── brain\                             # AI 上下文数据
├── code_tracker\                      # 代码追踪
├── context_state\                     # 上下文状态
├── memories\
│   └── global_rules.md               # 全局规则
├── windsurf\
│   └── workflows\                    # 工作流配置
├── user_settings.pb                   # 用户设置（Protobuf）
└── installation_id                    # 安装 ID

%APPDATA%\Windsurf\User\               # VSCode 标准存储（UI 状态，无聊天内容）
├── globalStorage\
│   └── state.vscdb                   # 全局 KV（仅 UI 状态）
└── workspaceStorage\
    └── {hash}\
        └── state.vscdb               # 工作区 KV（仅 UI 状态）
```

### 1.2 关键发现：Cascade 数据是 Protobuf 格式

`~/.codeium/windsurf/cascade/{uuid}.pb` 是 Windsurf Cascade 会话的核心数据文件。

**文件特征：**
- 扩展名 `.pb`，标准 Protobuf 二进制格式
- 文件头字节：`40 7B D3 BE D0 3D 40 82 B6 57 C8 90 DC 08 D0 3F`（非标准 Protobuf magic，可能有加密或自定义封装）
- 无法直接用 `protoc` 解码（缺少 `.proto` schema）
- 文件名即会话 UUID：`bade1860-e3de-4537-8d8d-bab51c96a6e9.pb`

### 1.3 VSCode 侧存储（无聊天内容）

`%APPDATA%\Windsurf\User\globalStorage\state.vscdb` 中与 Windsurf 相关的 key：

| Key | 内容 |
|-----|------|
| `windsurf.cascadeViewContainerId.state.hidden` | UI 面板状态 |
| `chat.ChatSessionStore.index` | `{"version":1,"entries":{}}` — 始终为空 |
| `chat.participantNameRegistry` | 模型名称注册表 |
| `chat.modelsControl` | 模型控制配置 |

**结论：VSCode 侧不存储聊天内容，仅存 UI 状态。**

### 1.4 与其他平台的对比

| 项目 | Claude/Kiro/Gemini | Cursor | Trae | Windsurf |
|------|-------------------|--------|------|---------|
| 存储格式 | JSON/JSONL 明文 | SQLite JSON | SQLite JSON | **Protobuf 二进制** |
| 可直接读取 | ✅ | ✅ | ✅ | ❌ |
| 需要 schema | 否 | 否 | 否 | **是** |

---

## 二、实现可行性评估

### 2.1 障碍

**核心障碍：Protobuf 无 schema**

Windsurf 的 `.pb` 文件是 Protobuf 格式，但：
1. 没有公开的 `.proto` schema 文件
2. 文件头不是标准 Protobuf magic bytes，可能有自定义封装或加密
3. 无法通过 `protoc --decode_raw` 直接解析出有意义的结构

### 2.2 可能的突破方向

**方案 A：逆向 Protobuf schema（高难度）**
- 使用 `protoc --decode_raw` 尝试解析原始字段
- 结合 Windsurf 的 Electron 应用 JS 代码（`app.asar`）寻找 proto 定义
- 路径：`%LOCALAPPDATA%\Programs\Windsurf\resources\app.asar`
- 难度：高，且 Windsurf 可能混淆了 JS 代码

**方案 B：监听 Windsurf API（中难度）**
- Windsurf 基于 VSCode，可能有内部 API 或 IPC 通道
- 通过 VSCode 扩展 API 拦截 Cascade 数据
- 难度：中，需要深入了解 Windsurf 扩展架构

**方案 C：等待社区逆向（低成本）**
- 关注 GitHub 上的 Windsurf 相关开源项目
- 已有人在研究 Windsurf 数据格式（如 windsurf-export 等工具）
- 成本低，但时间不确定

### 2.3 当前结论

**Windsurf 暂时无法实现适配器**，原因：
- 核心数据是 Protobuf 二进制，无公开 schema
- 文件头异常，可能有加密层
- 没有可读的 JSON/SQLite 备用数据源

---

## 三、后续调研方向

### 3.1 逆向 app.asar

```powershell
# Windsurf 安装目录
$windsurfApp = "$env:LOCALAPPDATA\Programs\Windsurf\resources\app.asar"
# 使用 asar 工具解包
npx asar extract app.asar app_extracted
# 搜索 proto 相关代码
grep -r "cascade" app_extracted --include="*.js" -l
grep -r "\.proto\|protobuf\|CascadeSession" app_extracted --include="*.js" -l
```

### 3.2 使用 protoc --decode_raw

```bash
# 尝试原始解码（不需要 schema）
protoc --decode_raw < bade1860-e3de-4537-8d8d-bab51c96a6e9.pb
```

如果文件头不是标准 Protobuf（`0A` 开头），需要先跳过自定义头部。

### 3.3 关注的开源项目

- 搜索 GitHub：`windsurf cascade export` / `codeium windsurf history`
- 关注 Windsurf 官方是否提供导出功能

---

## 四、数据路径参考

| 平台 | 路径 |
|------|------|
| Windows | `~\.codeium\windsurf\cascade\` |
| macOS | `~/.codeium/windsurf/cascade/` |
| Linux | `~/.codeium/windsurf/cascade/` |

---

## 五、总结

Windsurf 的 Cascade 会话数据存储在 `~/.codeium/windsurf/cascade/{uuid}.pb`，是 **Protobuf 二进制格式**，目前无法直接读取。

**建议：暂缓实现，等待以下任一条件满足：**
1. 社区成功逆向出 Protobuf schema
2. Windsurf 官方提供数据导出 API
3. 通过逆向 `app.asar` 找到 proto 定义

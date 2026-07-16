# Issues #3 / #4 / #5 实施规划

Date: 2026-07-13

Status: implemented; automated verification complete, platform CLI resume verification remains manual.

## Scope

本轮实现以下三个公开 Issue：

- #3：从其他机器导入原始 session JSONL。
- #4：删除单条修改记录，或清空当前会话的修改记录。
- #5：限制 Markdown 导出的内容范围，避免长会话导出后难以查找。

## Decisions

### #4 修改记录删除

- 删除记录只影响 Memory Forge 自己的审计记录，不回滚原始会话文件。
- 支持单条删除和清空当前会话两种操作。
- 后端必须按 `id + platform + session_key` 校验归属，恢复操作使用相同校验。
- 所有删除操作需要二次确认。

### #5 Markdown 导出范围

- 保留“全部内容”。
- 增加“最近 20 / 50 / 100 条”。
- 增加“从指定日期开始”。
- `TimelineBlock` 增加可选 `createdAt`；适配器有原始时间时必须传递，没有时间的块在日期过滤时不导出。
- 最近 N 条按最终可导出的块计算，兼容没有时间戳的平台。

### #3 原始 JSONL 导入导出

第一版仅支持 Claude Code、Codex、Pi：

- 原始导出只复制文件，不重新序列化。
- 导入分为 probe 和 commit 两步；用户确认预览后才写入平台目录。
- 默认冲突策略为：内容相同则返回已存在；内容不同则添加 `-imported-{timestamp}` 后缀。
- 不开放覆盖已有文件。
- 导入目标始终由后端推导，前端不能提供目标目录。
- 目标路径必须位于对应平台 session 根目录中。
- 导入后保证 Memory Forge 可以发现和浏览；CLI resume 作为尽力支持，不作跨机器绝对保证。

## Backend Work

1. `database.rs`
   - 删除指定 edit log。
   - 清空指定 session 的 edit logs。
   - 按归属读取 edit log。
2. `session_transfer.rs`
   - 定位原始 session 文件。
   - JSONL 格式识别和元数据提取。
   - 目标路径推导、边界校验、hash 冲突判断和安全复制。
3. `main.rs`
   - 暴露 edit log 删除命令。
   - 暴露 raw JSONL export / probe / import 命令。
4. Platform adapters
   - 向 `TimelineBlock.createdAt` 传递可获得的消息时间。

## Frontend Work

1. 修改记录面板增加单条删除和清空按钮。
2. 导出菜单增加范围选择、日期输入和原始 JSONL 导出按钮。
3. Session list 工具栏为 Claude / Codex / Pi 增加“导入 JSONL”。
4. 导入操作显示平台、session id、cwd、目标路径、冲突状态和警告，再由用户确认。

## Tests

- Edit log 删除必须验证 session 归属。
- Claude / Codex / Pi probe 能识别基础元数据。
- 目标路径不能逃逸 session 根目录。
- 相同文件识别为 already exists。
- 不同内容冲突自动重命名。
- `cargo test --locked`。
- `npm run build`。

## Non-Goals

- Markdown 导入。
- 跨平台 session 格式转换。
- OpenCode SQLite 导入导出。
- 导入时修改原始 `cwd`、session id 或 parent 链。
- 自动执行或恢复导入 session 中记录的命令。

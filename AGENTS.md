# AGENTS.md

## Git 身份

本仓库的提交一律使用 VoidCraft 身份，不要用本机全局 git 配置里的身份：

```
VoidCraft <246403070+voidcraft-dev@users.noreply.github.com>
```

只对本次提交生效，不要修改 git config：

```
git -c user.name="VoidCraft" -c user.email="246403070+voidcraft-dev@users.noreply.github.com" commit ...
```

提交信息沿用历史风格：`feat: ...` / `fix: ...` / `chore(release): vX.Y.Z ...`，正文用中文。

## 常用命令

- 后端测试：`cargo test --manifest-path src-tauri/Cargo.toml`
- 前端类型检查：`npm run typecheck`
- 开发运行（Tauri 桌面窗口）：`npm run tauri dev`

## 发版

1. 改版本号（5 处）：`package.json`、`package-lock.json`（2 处）、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`，提交 `chore(release): vX.Y.Z <说明>`。
2. 打 tag `vX.Y.Z` 并推送 main 与 tag。

`.github/workflows/release.yml` 会在推送 `v*` tag 时自动构建 Windows / macOS / Linux 全平台安装包并创建 Release。
前提是仓库设置里启用了 GitHub Actions（v3.6.0 至 v3.9.0 期间曾被关闭，推 tag 没有触发构建，2026-11-22 已重新开启）。

Actions 不可用时改为本地打包（仅 Windows）：

1. `npm run tauri build -- --bundles nsis,msi`
2. 把 `src-tauri/target/release/memory-forge.exe` 单独压成 `Memory.Forge_X.Y.Z_x64-portable.zip`
3. `gh release create vX.Y.Z --title "Memory Forge vX.Y.Z" --notes-file <说明> --latest` 上传 setup.exe、msi、portable.zip

## 新增平台适配器

参考 `feat: 新增 CodeBuddy 会话适配器`（f3b8cbd）改动的文件清单：`src-tauri/src/platforms/<name>.rs`、`platforms/mod.rs`（`get_adapter` 与 `build_commands`）、`settings.rs`、`session_service.rs`（`DASHBOARD_PLATFORM_NAMES`）、`terminal.rs`（命令白名单），以及前端 `types.ts`、`api.ts`、`i18n.ts`、`settings.tsx`、`dashboard.tsx`、`shell-layout.tsx`、`session-list.tsx`、`terminal-sessions.tsx`、`new-session-dialog.tsx`、README。

## 编辑与校验注意

- `src/` 下源码是 CRLF 换行（`core.autocrlf=true`），改文件时保持 CRLF；Git Bash 里的 `sed -i` 会把整文件转成 LF，别用。
- `npx biome check src` 在 main 上就有约 1100 条存量问题（属性排序、块语句等风格规则），校验时按文件对比改动前后的数量，不要追求清零。
- 前端没有测试框架；`npm run typecheck` 加 `npx vite build --outDir <临时目录>` 是最低限度的验证，不要把构建产物写进仓库的 `dist/`。

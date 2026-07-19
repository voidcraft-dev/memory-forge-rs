import type { LocaleId } from "@/features/desktop/types";

export type MessageKey =
  // App
  | "appName"
  | "appNameEn"
  // Nav
  | "dashboard"
  | "settings"
  | "prompts"
  | "about"
  | "terminalSessions"
  // Platforms
  | "platforms"
  | "platformClaude"
  | "platformCodex"
  | "platformCursor"
  | "platformOpencode"
  | "platformKiro"
  | "platformKiroIde"
  | "platformPi"
  | "platformGrok"
  // Dashboard
  | "welcomeTitle"
  | "welcomeDesc"
  | "totalSessions"
  | "sevenDayTrend"
  | "memoryManipulation"
  | "memoryManipulationDesc"
  | "openSettings"
  // Settings
  | "themeSection"
  | "themeSectionDesc"
  | "languageSection"
  | "languageSectionDesc"
  | "desktopBehavior"
  | "desktopBehaviorDesc"
  | "closeBehavior"
  | "closeBehaviorDesc"
  | "launchOnStartup"
  | "launchOnStartupDesc"
  | "reduceMotion"
  | "reduceMotionDesc"
  | "terminalSection"
  | "terminalSectionDesc"
  | "preferredTerminal"
  | "terminalCmd"
  | "terminalPowerShell"
  | "terminalWindowsTerminal"
  | "terminalMacTerminal"
  | "terminalITerm2"
  | "terminalAlacritty"
  | "terminalKitty"
  | "terminalGhostty"
  | "terminalWezTerm"
  | "terminalKaku"
  | "terminalGnomeTerminal"
  | "terminalKonsole"
  | "terminalXfceTerminal"
  | "currentTheme"
  | "currentLanguage"
  | "runtime"
  | "configDir"
  | "configFile"
  | "dataDir"
  | "dbPath"
  | "trayReady"
  | "trayUnavailable"
  | "autostartUnavailable"
  | "saveSuccess"
  | "saveError"
  | "loading"
  | "ready"
  | "runtimeTauri"
  | "runtimeWebPreview"
  | "runtimeRemote"
  | "remoteReadOnly"
  | "remoteServer"
  | "remoteReadOnlyHint"
  | "mobileBackToSessions"
  | "remoteAccessTitle"
  | "remoteAccessToken"
  | "remoteConnect"
  | "remoteAccessInvalid"
  | "remoteSection"
  | "remoteSectionDesc"
  | "remoteMode"
  | "remoteLoopback"
  | "remoteLan"
  | "remoteAllowEdits"
  | "remoteAllowEditsDesc"
  | "remoteAllowTerminal"
  | "remoteAllowTerminalDesc"
  | "remotePort"
  | "remoteRestart"
  | "remoteRunning"
  | "remoteStopped"
  | "remoteCopyLink"
  | "remoteLinkCopied"
  | "remoteShowQr"
  | "remoteQrTitle"
  | "remoteQrDescription"
  | "remoteQrSecret"
  | "remoteOpenNavigation"
  | "remoteCloseNavigation"
  | "remoteSessions"
  | "remoteOnline"
  | "remoteCompanion"
  | "remoteLocalConnection"
  | "remoteWorkspaces"
  | "remoteSourceOnHost"
  | "remoteEditsEnabled"
  | "remoteRevisionProtected"
  | "remoteRecentSessions"
  | "remoteRevisionHistory"
  | "remoteRevised"
  | "remoteShowThinking"
  | "remoteHideThinking"
  | "remoteCollapseContent"
  | "remoteExpandContent"
  | "remoteSessionCount"
  | "remoteTerminalPromptPlaceholder"
  | "remoteTerminalSend"
  | "remoteTerminalKeys"
  | "remoteTerminalControl"
  | "remoteTerminalControlHint"
  | "remoteOpenTerminal"
  | "remoteTerminalResumeHint"
  | "remoteTerminalForkHint"
  | "remoteTerminalHistoryTruncated"
  | "remoteTerminalInputFailed"
  | "toggleOn"
  | "toggleOff"
  // Prompts
  | "promptLibrary"
  | "promptSubtitle"
  | "searchPlaceholder"
  | "allTags"
  | "totalPrompts"
  | "totalUses"
  | "totalTags"
  | "createNew"
  | "editPrompt"
  | "promptName"
  | "namePlaceholder"
  | "promptContent"
  | "contentPlaceholder"
  | "presetTags"
  | "selectedTags"
  | "customTagPlaceholder"
  | "save"
  | "create"
  | "cancel"
  | "copy"
  | "copied"
  | "usedCount"
  | "empty"
  | "emptyHint"
  | "createFirst"
  | "importExport"
  | "exportJSON"
  | "importJSON"
  | "importSuccess"
  | "importFailed"
  // About
  | "aboutTitle"
  | "aboutDesc"
  | "localFirst"
  | "editMemory"
  | "multiPlatform"
  | "auditLog"
  | "sessionAlias"
  | "darkLightTheme"
  // Update
  | "checkUpdate"
  | "checking"
  | "upToDate"
  | "updateAvailable"
  | "latestVersion"
  | "downloadUpdate"
  | "releaseNotes"
  | "checkFailed"
  // Session
  | "session.sessions"
  | "session.search"
  | "session.noSessions"
  | "session.justNow"
  | "session.untitled"
  | "session.noPreview"
  | "session.selectToView"
  | "session.selectFromList"
  | "session.alias"
  | "session.setAlias"
  | "session.save"
  | "session.refresh"
  | "session.refreshed"
  | "session.editLog"
  | "session.editMessage"
  | "session.editWarning"
  | "session.editThisMessage"
  | "session.enterContent"
  | "session.saveChanges"
  | "session.saveFailed"
  | "session.revisionConflict"
  | "session.aliasSaved"
  | "session.aliasSaveFailed"
  | "session.messageSaved"
  | "session.refreshFailed"
  | "session.editorTitle"
  | "session.editorHelper"
  | "session.closeEditor"
  | "session.cancel"
  | "session.copied"
  | "session.openWorkspace"
  | "session.chooseEditor"
  | "session.workspaceOpened"
  | "session.workspaceOpenFailed"
  | "session.openTerminal"
  | "session.terminalOpened"
  | "session.terminalOpenFailed"
  | "session.filter.all"
  | "session.filter.user"
  | "session.filter.assistant"
  | "session.filter.thinking"
  | "session.totalMessages"
  | "session.export"
  | "session.exported"
  | "session.exportOptions"
  | "session.exportRange"
  | "session.exportAll"
  | "session.exportRecent"
  | "session.exportSince"
  | "session.exportMarkdown"
  | "session.exportRawJsonl"
  | "session.exportingRaw"
  | "session.rawExported"
  | "session.importJsonl"
  | "session.importTitle"
  | "session.importSubtitle"
  | "session.importConfirm"
  | "session.importing"
  | "session.imported"
  | "session.importedRenamed"
  | "session.importExists"
  | "session.importConflictSame"
  | "session.importConflictDifferent"
  | "session.importWarnings"
  | "session.includeToolCalls"
  | "session.erase"
  | "session.eraseConfirm"
  | "session.restore"
  | "session.restoreConfirm"
  // Edit Log
  | "editLog.title"
  | "editLog.collapse"
  | "editLog.readonlyTrace"
  | "editLog.noRecords"
  | "editLog.afterEditHint"
  | "editLog.recordCount"
  | "editLog.before"
  | "editLog.after"
  | "editLog.expand"
  | "editLog.viewDetail"
  | "editLog.traceTitle"
  | "editLog.traceDesc"
  | "editLog.delete"
  | "editLog.deleteConfirm"
  | "editLog.clear"
  | "editLog.clearConfirm"
  | "editLog.deleted"
  | "sidebar.collapse"
  | "sidebar.expand"
  | "sidebar.dragHint"
  | "sidebar.dragLabel"
  | "sidebar.enableToReorder"
  | "sidebar.showPlatform"
  | "sidebar.hidePlatform"
  | "sidebarSection"
  | "sidebarSectionDesc"
  | "platformPaths"
  | "platformPathsDesc"
  | "claudeHomePath"
  | "codexHomePath"
  | "codexProjectRootPath"
  | "cursorHomePath"
  | "opencodePath"
  | "kiroHome"
  | "kiroIdeHome"
  | "geminiHome"
  | "platformGemini"
  | "grokHome"
  | "piHome"
  | "pathPlaceholder"
  | "pathSaved"
  | "defaultPath"
  | "session.loadMore"
  | "session.favorite"
  | "session.unfavorite"
  | "session.archive"
  | "session.unarchive"
  | "session.archived"
  | "session.archiveView"
  | "session.sessionsView"
  | "session.noArchivedSessions"
  | "session.archiveConfirm"
  | "session.selectMode"
  | "session.exitSelect"
  | "session.selectAll"
  | "session.invertSelection"
  | "session.selectedCount"
  | "session.batchArchive"
  | "session.batchUnarchive"
  | "session.batchFavorite"
  | "session.batchUnfavorite"
  | "session.batchArchived"
  | "session.batchUnarchived"
  | "session.batchFavorited"
  | "session.batchUnfavorited"
  | "session.batchFailed"
  | "session.noSelection"
  // Terminal UI
  | "terminal.sessionRecord"
  | "terminal.tabTitle"
  | "terminal.resumeEmbedded"
  | "terminal.resumeExternal"
  | "terminal.copyResumeCmd"
  | "terminal.forkEmbedded"
  | "terminal.forkExternal"
  | "terminal.copyForkCmd"
  | "terminal.status.idle"
  | "terminal.status.starting"
  | "terminal.status.running"
  | "terminal.status.stopping"
  | "terminal.status.exited"
  | "terminal.status.failed"
  | "terminal.btn.restart"
  | "terminal.btn.stop"
  | "terminal.btn.forceStop"
  | "terminal.btn.confirmForceStop"
  | "terminal.btn.cancel"
  | "terminal.btn.openExternal"
  | "terminal.btn.close"
  | "terminal.btn.maximize"
  | "terminal.btn.restoreLayout"
  | "terminal.menu.rename"
  | "terminal.menu.copyCommand"
  | "terminal.renameHint"
  | "terminal.forceStopDesc"
  | "terminal.idle.title"
  | "terminal.idle.desc"
  | "terminal.idle.btn"
  | "terminal.starting.title"
  | "terminal.exited.title"
  | "terminal.failed.title"
  | "terminal.failed.retry"
  | "terminal.failed.copy"
  | "terminal.failed.external"
  | "terminal.cwd"
  | "terminal.tabs.maxWarning"
  | "terminal.tabsLabel"
  | "terminal.viewportLabel"
  | "terminal.closeRunningTitle"
  | "terminal.closeRunningDesc"
  | "terminal.workspace.title"
  | "terminal.workspace.subtitle"
  | "terminal.workspace.collection"
  | "terminal.workspace.emptyTitle"
  | "terminal.workspace.emptyDesc"
  | "terminal.workspace.runningCount"
  | "terminal.workspace.openedAt"
  | "terminal.workspace.source"
  | "terminal.workspace.externalFailed";

const messages: Record<LocaleId, Record<MessageKey, string>> = {
  "zh-CN": {
    appName: "记忆锻造",
    appNameEn: "Memory Forge",
    dashboard: "总览",
    settings: "设置",
    prompts: "提示词库",
    about: "关于",
    terminalSessions: "会话",
    platforms: "平台",
    platformClaude: "Claude",
    platformCodex: "Codex",
    platformCursor: "Cursor",
    platformOpencode: "OpenCode",
    platformKiro: "Kiro CLI",
    platformKiroIde: "Kiro IDE",
    platformPi: "Pi",
    platformGrok: "Grok Build",
    welcomeTitle: "停止重开，直接编辑。",
    welcomeDesc: "AI 对话走偏了？别重新开始 — 直接改掉历史记录。注入上下文、纠正错误、删除废话，然后无缝继续对话。",
    totalSessions: "总会话数",
    sevenDayTrend: "7天趋势",
    memoryManipulation: "记忆操控",
    memoryManipulationDesc: "编辑 AI 对话历史中的任意消息。注入上下文、删除噪音、纠正 AI 的错误假设 — 然后无缝继续会话。",
    openSettings: "去看设置",
    themeSection: "主题系统",
    themeSectionDesc: "选择适合你的工作风格的主题。",
    languageSection: "语言切换",
    languageSectionDesc: "支持中英双语，结构上可继续扩展。",
    desktopBehavior: "桌面行为",
    desktopBehaviorDesc: "控制窗口关闭、开机自启等桌面行为。",
    closeBehavior: "关闭时最小化到托盘",
    closeBehaviorDesc: "窗口关闭后保留后台常驻，适合常驻型工具。",
    launchOnStartup: "开机自动启动",
    launchOnStartupDesc: "让应用跟随系统启动。",
    reduceMotion: "减少动画",
    reduceMotionDesc: "对低性能设备更友好。",
    terminalSection: "首选终端",
    terminalSectionDesc: "恢复会话时使用的终端应用。",
    preferredTerminal: "终端应用",
    terminalCmd: "命令提示符",
    terminalPowerShell: "PowerShell",
    terminalWindowsTerminal: "Windows Terminal",
    terminalMacTerminal: "Terminal.app",
    terminalITerm2: "iTerm2",
    terminalAlacritty: "Alacritty",
    terminalKitty: "Kitty",
    terminalGhostty: "Ghostty",
    terminalWezTerm: "WezTerm",
    terminalKaku: "Kaku",
    terminalGnomeTerminal: "GNOME Terminal",
    terminalKonsole: "Konsole",
    terminalXfceTerminal: "Xfce Terminal",
    currentTheme: "当前主题",
    currentLanguage: "当前语言",
    runtime: "运行环境",
    configDir: "配置目录",
    configFile: "配置文件",
    dataDir: "数据目录",
    dbPath: "数据库路径",
    trayReady: "托盘可用",
    trayUnavailable: "托盘不可用",
    autostartUnavailable: "当前环境不支持开机自启",
    saveSuccess: "设置已保存",
    saveError: "设置保存失败",
    loading: "加载中...",
    ready: "已就绪",
    runtimeTauri: "原生桌面",
    runtimeWebPreview: "网页预览",
    runtimeRemote: "局域网远程",
    remoteReadOnly: "只读远程",
    remoteServer: "远程主机",
    remoteReadOnlyHint: "当前连接只开放查看与审计，原始数据仍保存在主机。",
    mobileBackToSessions: "返回会话列表",
    remoteAccessTitle: "连接记忆锻造主机",
    remoteAccessToken: "访问令牌",
    remoteConnect: "连接",
    remoteAccessInvalid: "令牌无效或主机暂时不可用",
    remoteSection: "手机远程",
    remoteSectionDesc: "控制本机服务的监听范围、端口和远程写入权限。",
    remoteMode: "访问范围",
    remoteLoopback: "仅本机",
    remoteLan: "局域网",
    remoteAllowEdits: "允许远程编辑",
    remoteAllowEditsDesc: "手机编辑与复原均执行 revision 冲突保护并写入审计日志。",
    remoteAllowTerminal: "允许远程终端",
    remoteAllowTerminalDesc: "手机可以恢复或分支会话，并控制主机上的内嵌 CLI 进程。不会接受任意 shell 命令。",
    remotePort: "服务端口",
    remoteRestart: "重启服务",
    remoteRunning: "服务运行中",
    remoteStopped: "服务未运行",
    remoteCopyLink: "复制手机链接",
    remoteLinkCopied: "手机链接已复制",
    remoteShowQr: "手机扫码",
    remoteQrTitle: "扫描连接主机",
    remoteQrDescription: "使用手机相机或浏览器扫描，直接打开记忆锻造远程页面。",
    remoteQrSecret: "二维码包含访问令牌，只在可信设备上扫描，请勿截图或公开分享。",
    remoteOpenNavigation: "打开平台导航",
    remoteCloseNavigation: "关闭平台导航",
    remoteSessions: "最近会话",
    remoteOnline: "已连接",
    remoteCompanion: "局域网伴侣",
    remoteLocalConnection: "局域网连接",
    remoteWorkspaces: "工作区",
    remoteSourceOnHost: "数据保存在主机",
    remoteEditsEnabled: "可编辑连接",
    remoteRevisionProtected: "版本保护已启用",
    remoteRecentSessions: "最近会话",
    remoteRevisionHistory: "版本时间线",
    remoteRevised: "已修订",
    remoteShowThinking: "展开思考过程",
    remoteHideThinking: "收起思考过程",
    remoteCollapseContent: "收起完整内容",
    remoteExpandContent: "展开完整内容",
    remoteSessionCount: "共 {count} 个会话",
    remoteTerminalPromptPlaceholder: "输入给 AI 的消息...",
    remoteTerminalSend: "发送",
    remoteTerminalKeys: "终端控制键",
    remoteTerminalControl: "远程终端已启用",
    remoteTerminalControlHint: "进程运行在主机，手机可随时重连",
    remoteOpenTerminal: "打开主机终端",
    remoteTerminalResumeHint: "继续原会话与完整上下文",
    remoteTerminalForkHint: "从当前会话创建独立分支",
    remoteTerminalHistoryTruncated: "[Memory Forge] 较早的终端输出已从主机缓冲区清理",
    remoteTerminalInputFailed: "发送失败，连接恢复后重试",
    toggleOn: "开启",
    toggleOff: "关闭",
    promptLibrary: "提示词库",
    promptSubtitle: "保存、管理常用提示词，一键复制",
    searchPlaceholder: "搜索提示词...",
    allTags: "全部",
    totalPrompts: "提示词总数",
    totalUses: "使用总次数",
    totalTags: "标签数",
    createNew: "新建",
    editPrompt: "编辑提示词",
    promptName: "名称",
    namePlaceholder: "输入提示词名称",
    promptContent: "内容",
    contentPlaceholder: "输入提示词内容...",
    presetTags: "预设标签",
    selectedTags: "已选标签",
    customTagPlaceholder: "输入自定义标签，回车添加",
    save: "保存",
    create: "创建",
    cancel: "取消",
    copy: "复制",
    copied: "已复制",
    usedCount: "使用 {count} 次",
    empty: "还没有提示词",
    emptyHint: "点击新建按钮创建你的第一个提示词",
    createFirst: "创建第一个",
    importExport: "导入/导出",
    exportJSON: "导出 JSON",
    importJSON: "导入 JSON",
    importSuccess: "成功导入 {count} 个提示词",
    importFailed: "导入失败",
    aboutTitle: "关于记忆锻造",
    aboutDesc: "本地 AI 会话管理工具，让你改写 AI 记忆，精准操控对话历史。",
    localFirst: "100% 本地运行",
    editMemory: "记忆操控",
    multiPlatform: "多平台统一",
    auditLog: "修改追溯",
    sessionAlias: "会话别名",
    darkLightTheme: "暗色/亮色主题",
    checkUpdate: "检查更新",
    checking: "检查中...",
    upToDate: "已是最新版本",
    updateAvailable: "有新版本可用",
    latestVersion: "最新版本",
    downloadUpdate: "下载更新",
    releaseNotes: "更新说明",
    checkFailed: "检查失败",
    "session.sessions": "会话",
    "session.search": "搜索会话...",
    "session.noSessions": "暂无会话",
    "session.justNow": "刚刚",
    "session.untitled": "无标题",
    "session.noPreview": "无预览",
    "session.selectToView": "选择一个会话查看",
    "session.selectFromList": "从左侧列表选择",
    "session.alias": "别名",
    "session.setAlias": "设置会话别名",
    "session.save": "保存",
    "session.refresh": "刷新",
    "session.refreshed": "已刷新",
    "session.editLog": "修改记录",
    "session.editMessage": "编辑消息",
    "session.editWarning": "修改消息会直接影响 AI 的上下文记忆，请谨慎操作。",
    "session.editThisMessage": "编辑此消息",
    "session.enterContent": "输入内容...",
    "session.saveChanges": "保存修改",
    "session.saveFailed": "保存失败",
    "session.revisionConflict": "会话内容已在其他位置更新。为避免覆盖，本次修改未保存；请重新打开编辑器确认最新内容。",
    "session.aliasSaved": "别名已保存",
    "session.aliasSaveFailed": "别名保存失败",
    "session.messageSaved": "修改已保存",
    "session.refreshFailed": "刷新失败，请稍后重试",
    "session.editorTitle": "右侧编辑器",
    "session.editorHelper": "右侧编辑不会遮挡对话内容。保存后会立即写回历史记录。",
    "session.closeEditor": "关闭编辑器",
    "session.cancel": "取消",
    "session.copied": "已复制",
    "session.openWorkspace": "打开",
    "session.chooseEditor": "选择编辑器",
    "session.workspaceOpened": "已打开工作目录",
    "session.workspaceOpenFailed": "打开工作目录失败",
    "session.openTerminal": "打开终端",
    "session.terminalOpened": "已打开终端",
    "session.terminalOpenFailed": "打开终端失败，已复制命令",
    "session.filter.all": "全部",
    "session.filter.user": "用户",
    "session.filter.assistant": "助手",
    "session.filter.thinking": "思考",
    "session.totalMessages": "共 {count} 条消息",
    "session.export": "导出",
    "session.exported": "已导出",
    "session.exportOptions": "配置导出选项",
    "session.exportRange": "内容范围",
    "session.exportAll": "全部",
    "session.exportRecent": "最近 {count}",
    "session.exportSince": "起始日期",
    "session.exportMarkdown": "下载 Markdown (.md)",
    "session.exportRawJsonl": "导出原始 JSONL (.jsonl)",
    "session.exportingRaw": "正在复制…",
    "session.rawExported": "原始 Session JSONL 已导出",
    "session.importJsonl": "导入原始 Session JSONL",
    "session.importTitle": "确认导入 Session JSONL",
    "session.importSubtitle": "识别 → 检查 → 导入",
    "session.importConfirm": "确认导入",
    "session.importing": "正在导入…",
    "session.imported": "Session JSONL 已导入",
    "session.importedRenamed": "Session 已导入并自动重命名",
    "session.importExists": "Session 已存在，已定位到原记录",
    "session.importConflictSame": "目标中已有完全相同的文件，将直接定位到现有 Session。",
    "session.importConflictDifferent": "目标中存在不同内容的同名文件，导入时会自动重命名，不会覆盖原文件。",
    "session.importWarnings": "注意事项",
    "session.includeToolCalls": "包含工具调用历史",
    "session.erase": "擦除此消息",
    "session.eraseConfirm": "确定擦除这条消息的内容吗？此操作不可撤销。",
    "session.restore": "复原",
    "session.restoreConfirm": "确定复原这条消息到修改前的内容吗？复原也会记录在修改记录中。",
    "editLog.title": "修改记录",
    "editLog.collapse": "收起",
    "editLog.readonlyTrace": "只读审计日志",
    "editLog.noRecords": "暂无修改记录",
    "editLog.afterEditHint": "编辑消息后，修改记录会出现在这里",
    "editLog.recordCount": "{count} 条记录",
    "editLog.before": "修改前",
    "editLog.after": "修改后",
    "editLog.expand": "展开",
    "editLog.viewDetail": "查看详情",
    "editLog.traceTitle": "修改追溯",
    "editLog.traceDesc": "每次编辑都会记录原始内容和新内容，支持 diff 对比。",
    "editLog.delete": "删除记录",
    "editLog.deleteConfirm": "确定删除这条修改记录吗？删除后将无法再用它恢复内容。",
    "editLog.clear": "清空记录",
    "editLog.clearConfirm": "确定清空当前会话的全部修改记录吗？此操作不会撤销已经修改的内容。",
    "editLog.deleted": "修改记录已删除",
    "sidebar.collapse": "收起菜单",
    "sidebar.expand": "展开菜单",
    "sidebar.dragHint": "拖动排序，或按 ↑ / ↓ 调整",
    "sidebar.dragLabel": "{platform}，当前优先级 {priority}。拖动排序，或使用上下方向键调整。",
    "sidebar.enableToReorder": "启用后可调整顺序",
    "sidebar.showPlatform": "显示 {platform}",
    "sidebar.hidePlatform": "隐藏 {platform}",
    sidebarSection: "菜单显示与排序",
    sidebarSectionDesc: "选择侧边栏中的平台与会话入口；拖动已启用项目可调整优先级。总览/提示词/设置/关于始终显示。",
    "platformPaths": "平台路径",
    "platformPathsDesc": "自定义各平台的数据目录。留空则使用默认路径。",
    "claudeHomePath": "Claude 数据目录",
    "codexHomePath": "Codex 数据目录",
    "codexProjectRootPath": "Codex 项目根目录",
    "cursorHomePath": "Cursor 数据目录",
    "opencodePath": "OpenCode 数据库路径",
    "kiroHome": "Kiro 主目录路径",
    "kiroIdeHome": "Kiro IDE 数据目录",
    "geminiHome": "Gemini 数据目录",
    "platformGemini": "Gemini CLI",
    "grokHome": "Grok Build 数据目录",
    "piHome": "Pi 数据目录",
    "pathPlaceholder": "留空使用默认路径",
    "pathSaved": "路径已保存",
    "defaultPath": "默认: {path}",
    "session.loadMore": "加载更多 (剩余 {count} 条)",
    "session.favorite": "收藏",
    "session.unfavorite": "取消收藏",
    "session.archive": "归档",
    "session.unarchive": "取消归档",
    "session.archived": "已归档",
    "session.archiveView": "归档",
    "session.sessionsView": "会话",
    "session.noArchivedSessions": "暂无归档会话",
    "session.archiveConfirm": "确定归档这个会话吗？归档后不会在列表中显示，可以在归档视图中恢复。",
    "session.selectMode": "多选",
    "session.exitSelect": "退出多选",
    "session.selectAll": "全选",
    "session.invertSelection": "反选",
    "session.selectedCount": "已选 {count}",
    "session.batchArchive": "批量归档",
    "session.batchUnarchive": "批量取消归档",
    "session.batchFavorite": "批量收藏",
    "session.batchUnfavorite": "批量取消收藏",
    "session.batchArchived": "已归档 {count} 个会话",
    "session.batchUnarchived": "已恢复 {count} 个会话",
    "session.batchFavorited": "已收藏 {count} 个会话",
    "session.batchUnfavorited": "已取消收藏 {count} 个会话",
    "session.batchFailed": "批量操作失败",
    "session.noSelection": "未选中任何会话",
    // Terminal UI
    "terminal.sessionRecord": "会话记录",
    "terminal.tabTitle": "终端: {kind}",
    "terminal.resumeEmbedded": "内嵌恢复会话",
    "terminal.resumeExternal": "在外部终端恢复",
    "terminal.copyResumeCmd": "复制恢复命令",
    "terminal.forkEmbedded": "内嵌分支会话",
    "terminal.forkExternal": "在外部终端分支",
    "terminal.copyForkCmd": "复制分支命令",
    "terminal.status.idle": "未启动",
    "terminal.status.starting": "正在启动",
    "terminal.status.running": "运行中",
    "terminal.status.stopping": "正在停止",
    "terminal.status.exited": "已退出",
    "terminal.status.failed": "启动失败",
    "terminal.btn.restart": "重启",
    "terminal.btn.stop": "停止",
    "terminal.btn.forceStop": "强制停止",
    "terminal.btn.confirmForceStop": "确认强制停止？",
    "terminal.btn.cancel": "取消",
    "terminal.btn.openExternal": "外部打开",
    "terminal.btn.close": "关闭会话",
    "terminal.btn.maximize": "最大化终端工作区",
    "terminal.btn.restoreLayout": "恢复应用布局",
    "terminal.menu.rename": "重命名终端会话",
    "terminal.menu.copyCommand": "复制终端命令",
    "terminal.renameHint": "双击重命名",
    "terminal.forceStopDesc": "强制停止会立即终止当前终端进程，尚未保存的命令状态可能丢失。",
    "terminal.idle.title": "终端尚未启动",
    "terminal.idle.desc": "在内嵌终端中恢复此会话。支持交互式命令行、ANSI 颜色与光标控制。",
    "terminal.idle.btn": "启动内嵌终端",
    "terminal.starting.title": "正在准备终端环境...",
    "terminal.exited.title": "终端子进程已退出，退出码: {code}",
    "terminal.failed.title": "启动终端失败",
    "terminal.failed.retry": "重新启动",
    "terminal.failed.copy": "复制命令",
    "terminal.failed.external": "外部打开",
    "terminal.cwd": "当前目录",
    "terminal.tabs.maxWarning": "这个历史会话打开的终端已达上限",
    "terminal.tabsLabel": "终端会话列表",
    "terminal.viewportLabel": "交互式内嵌终端",
    "terminal.closeRunningTitle": "关闭正在运行的终端？",
    "terminal.closeRunningDesc": "关闭会话会立即停止其中正在运行的命令，此操作无法撤销。",
    "terminal.workspace.title": "终端会话",
    "terminal.workspace.subtitle": "集中管理已打开的内嵌终端。切换到其他页面时，运行中的命令不会停止。",
    "terminal.workspace.collection": "会话集合",
    "terminal.workspace.emptyTitle": "还没有打开终端会话",
    "terminal.workspace.emptyDesc": "进入任意历史会话，从终端菜单选择“内嵌恢复”或“内嵌分支”，这里就会自动接管。",
    "terminal.workspace.runningCount": "{running}/{total} 运行中",
    "terminal.workspace.openedAt": "打开于 {time}",
    "terminal.workspace.source": "来源：{platform}",
    "terminal.workspace.externalFailed": "外部终端启动失败，命令已复制到剪贴板。",
  },
  en: {
    appName: "Memory Forge",
    appNameEn: "Memory Forge",
    dashboard: "Overview",
    settings: "Settings",
    prompts: "Prompt Library",
    terminalSessions: "Sessions",
    about: "About",
    platforms: "Platforms",
    platformClaude: "Claude",
    platformCodex: "Codex",
    platformCursor: "Cursor",
    platformOpencode: "OpenCode",
    platformKiro: "Kiro CLI",
    platformKiroIde: "Kiro IDE",
    platformPi: "Pi",
    platformGrok: "Grok Build",
    welcomeTitle: "Stop resetting. Start editing.",
    welcomeDesc: "AI went off track? Don't restart — edit the history directly. Inject context, fix errors, remove noise, then seamlessly continue.",
    totalSessions: "Total Sessions",
    sevenDayTrend: "7-Day Trend",
    memoryManipulation: "Memory Manipulation",
    memoryManipulationDesc: "Edit any message in AI conversation history. Inject context, remove noise, fix AI's wrong assumptions — then seamlessly continue.",
    openSettings: "Open Settings",
    themeSection: "Theme System",
    themeSectionDesc: "Choose a theme that fits your workflow.",
    languageSection: "Language",
    languageSectionDesc: "Supports Chinese and English, extensible.",
    desktopBehavior: "Desktop Behavior",
    desktopBehaviorDesc: "Control window close, autostart, and other desktop behaviors.",
    closeBehavior: "Close to tray",
    closeBehaviorDesc: "Keep the app resident when the main window is closed.",
    launchOnStartup: "Launch on startup",
    launchOnStartupDesc: "Let the app follow system startup.",
    reduceMotion: "Reduce motion",
    reduceMotionDesc: "Better for lower-powered machines.",
    terminalSection: "Preferred Terminal",
    terminalSectionDesc: "Terminal app used when resuming sessions.",
    preferredTerminal: "Terminal app",
    terminalCmd: "Command Prompt",
    terminalPowerShell: "PowerShell",
    terminalWindowsTerminal: "Windows Terminal",
    terminalMacTerminal: "Terminal.app",
    terminalITerm2: "iTerm2",
    terminalAlacritty: "Alacritty",
    terminalKitty: "Kitty",
    terminalGhostty: "Ghostty",
    terminalWezTerm: "WezTerm",
    terminalKaku: "Kaku",
    terminalGnomeTerminal: "GNOME Terminal",
    terminalKonsole: "Konsole",
    terminalXfceTerminal: "Xfce Terminal",
    currentTheme: "Current theme",
    currentLanguage: "Current language",
    runtime: "Runtime",
    configDir: "Config directory",
    configFile: "Config file",
    dataDir: "Data directory",
    dbPath: "Database path",
    trayReady: "Tray ready",
    trayUnavailable: "Tray unavailable",
    autostartUnavailable: "Autostart not available",
    saveSuccess: "Settings saved",
    saveError: "Failed to save settings",
    loading: "Loading...",
    ready: "Ready",
    runtimeTauri: "Native desktop",
    runtimeWebPreview: "Web preview",
    runtimeRemote: "LAN remote",
    remoteReadOnly: "Read-only remote",
    remoteServer: "Remote host",
    remoteReadOnlyHint: "This connection is read-only. Source data stays on the host.",
    mobileBackToSessions: "Back to sessions",
    remoteAccessTitle: "Connect to Memory Forge",
    remoteAccessToken: "Access token",
    remoteConnect: "Connect",
    remoteAccessInvalid: "The token is invalid or the host is unavailable",
    remoteSection: "Phone remote",
    remoteSectionDesc: "Control the daemon scope, port, and remote write permission.",
    remoteMode: "Access scope",
    remoteLoopback: "This device",
    remoteLan: "Local network",
    remoteAllowEdits: "Allow remote edits",
    remoteAllowEditsDesc: "Phone edits and restores use revision protection and are written to the audit log.",
    remoteAllowTerminal: "Allow remote terminal",
    remoteAllowTerminalDesc: "The phone can resume or fork a session and control its host CLI process. Arbitrary shell commands are rejected.",
    remotePort: "Service port",
    remoteRestart: "Restart service",
    remoteRunning: "Service running",
    remoteStopped: "Service stopped",
    remoteCopyLink: "Copy phone link",
    remoteLinkCopied: "Phone link copied",
    remoteShowQr: "Scan with phone",
    remoteQrTitle: "Scan to connect",
    remoteQrDescription: "Scan with your phone camera or browser to open Memory Forge Remote.",
    remoteQrSecret: "This QR code contains the access token. Scan it only on trusted devices and do not share screenshots.",
    remoteOpenNavigation: "Open platform navigation",
    remoteCloseNavigation: "Close platform navigation",
    remoteSessions: "Recent sessions",
    remoteOnline: "Connected",
    remoteCompanion: "LAN companion",
    remoteLocalConnection: "Local network",
    remoteWorkspaces: "Workspaces",
    remoteSourceOnHost: "Data stays on the host",
    remoteEditsEnabled: "Editable connection",
    remoteRevisionProtected: "Revision protection on",
    remoteRecentSessions: "Recent sessions",
    remoteRevisionHistory: "Revision timeline",
    remoteRevised: "Revised",
    remoteShowThinking: "Show reasoning",
    remoteHideThinking: "Hide reasoning",
    remoteCollapseContent: "Collapse full content",
    remoteExpandContent: "Expand full content",
    remoteSessionCount: "{count} sessions",
    remoteTerminalPromptPlaceholder: "Message the AI...",
    remoteTerminalSend: "Send",
    remoteTerminalKeys: "Terminal control keys",
    remoteTerminalControl: "Remote terminal enabled",
    remoteTerminalControlHint: "The process stays on the host and can be reconnected",
    remoteOpenTerminal: "Open host terminal",
    remoteTerminalResumeHint: "Continue the original session and context",
    remoteTerminalForkHint: "Create an independent branch from this session",
    remoteTerminalHistoryTruncated: "[Memory Forge] Earlier terminal output has left the host buffer",
    remoteTerminalInputFailed: "Send failed. Retry after the connection recovers.",
    toggleOn: "On",
    toggleOff: "Off",
    promptLibrary: "Prompt Library",
    promptSubtitle: "Save, manage & copy frequently used prompts",
    searchPlaceholder: "Search prompts...",
    allTags: "All",
    totalPrompts: "Total Prompts",
    totalUses: "Total Uses",
    totalTags: "Tags",
    createNew: "New",
    editPrompt: "Edit Prompt",
    promptName: "Name",
    namePlaceholder: "Enter prompt name",
    promptContent: "Content",
    contentPlaceholder: "Enter prompt content...",
    presetTags: "Preset Tags",
    selectedTags: "Selected Tags",
    customTagPlaceholder: "Type custom tag, press Enter",
    save: "Save",
    create: "Create",
    cancel: "Cancel",
    copy: "Copy",
    copied: "Copied",
    usedCount: "Used {count} times",
    empty: "No prompts yet",
    emptyHint: "Click the button to create your first prompt",
    createFirst: "Create First",
    importExport: "Import/Export",
    exportJSON: "Export JSON",
    importJSON: "Import JSON",
    importSuccess: "Successfully imported {count} prompts",
    importFailed: "Import failed",
    aboutTitle: "About Memory Forge",
    aboutDesc: "Local AI session manager — edit AI's memory, take control of conversation history.",
    localFirst: "100% Local",
    editMemory: "Memory Manipulation",
    multiPlatform: "Multi-platform",
    auditLog: "Audit Trail",
    sessionAlias: "Session Aliases",
    darkLightTheme: "Dark/Light Theme",
    checkUpdate: "Check for Updates",
    checking: "Checking...",
    upToDate: "Already up to date",
    updateAvailable: "New version available",
    latestVersion: "Latest version",
    downloadUpdate: "Download Update",
    releaseNotes: "Release Notes",
    checkFailed: "Check failed",
    "session.sessions": "Sessions",
    "session.search": "Search sessions...",
    "session.noSessions": "No sessions",
    "session.justNow": "Just now",
    "session.untitled": "Untitled",
    "session.noPreview": "No preview",
    "session.selectToView": "Select a session to view",
    "session.selectFromList": "Choose from the left panel",
    "session.alias": "Alias",
    "session.setAlias": "Set session alias",
    "session.save": "Save",
    "session.refresh": "Refresh",
    "session.refreshed": "Refreshed",
    "session.editLog": "Edit Log",
    "session.editMessage": "Edit Message",
    "session.editWarning": "Editing messages directly affects AI's context memory. Proceed with caution.",
    "session.editThisMessage": "Edit this message",
    "session.enterContent": "Enter content...",
    "session.saveChanges": "Save Changes",
    "session.saveFailed": "Save failed",
    "session.revisionConflict": "This session changed elsewhere. Your edit was not saved; reopen the editor and review the latest content before trying again.",
    "session.aliasSaved": "Alias saved",
    "session.aliasSaveFailed": "Failed to save alias",
    "session.messageSaved": "Changes saved",
    "session.refreshFailed": "Refresh failed, please try again",
    "session.editorTitle": "Editor",
    "session.editorHelper": "Edit on the right without covering the conversation. Saves write back to history immediately.",
    "session.closeEditor": "Close editor",
    "session.cancel": "Cancel",
    "session.copied": "Copied",
    "session.openWorkspace": "Open",
    "session.chooseEditor": "Choose editor",
    "session.workspaceOpened": "Workspace opened",
    "session.workspaceOpenFailed": "Failed to open workspace",
    "session.openTerminal": "Open terminal",
    "session.terminalOpened": "Terminal opened",
    "session.terminalOpenFailed": "Failed to open terminal; command copied",
    "session.filter.all": "All",
    "session.filter.user": "User",
    "session.filter.assistant": "Assistant",
    "session.filter.thinking": "Thinking",
    "session.totalMessages": "{count} messages",
    "session.export": "Export",
    "session.exported": "Exported",
    "session.exportOptions": "Export options",
    "session.exportRange": "Content range",
    "session.exportAll": "All",
    "session.exportRecent": "Last {count}",
    "session.exportSince": "Start date",
    "session.exportMarkdown": "Download Markdown (.md)",
    "session.exportRawJsonl": "Export raw JSONL (.jsonl)",
    "session.exportingRaw": "Copying…",
    "session.rawExported": "Raw session JSONL exported",
    "session.importJsonl": "Import raw session JSONL",
    "session.importTitle": "Confirm session JSONL import",
    "session.importSubtitle": "Probe → Review → Import",
    "session.importConfirm": "Import session",
    "session.importing": "Importing…",
    "session.imported": "Session JSONL imported",
    "session.importedRenamed": "Session imported with a conflict-safe filename",
    "session.importExists": "Session already exists and has been selected",
    "session.importConflictSame": "An identical file already exists. The existing session will be selected.",
    "session.importConflictDifferent": "A different file has the same target name. The import will be renamed and the existing file will not be overwritten.",
    "session.importWarnings": "Important notes",
    "session.includeToolCalls": "Include tool history",
    "session.erase": "Erase Message",
    "session.eraseConfirm": "Are you sure you want to erase this message? This cannot be undone.",
    "session.restore": "Restore",
    "session.restoreConfirm": "Restore this message to its previous content? The restore will also be recorded in the edit log.",
    "editLog.title": "Edit Log",
    "editLog.collapse": "Collapse",
    "editLog.readonlyTrace": "Read-only audit trail",
    "editLog.noRecords": "No records yet",
    "editLog.afterEditHint": "Edit log entries will appear here after editing messages",
    "editLog.recordCount": "{count} records",
    "editLog.before": "Before",
    "editLog.after": "After",
    "editLog.expand": "Expand",
    "editLog.viewDetail": "View detail",
    "editLog.traceTitle": "Edit Trace",
    "editLog.traceDesc": "Each edit records the original and new content with diff comparison.",
    "editLog.delete": "Delete record",
    "editLog.deleteConfirm": "Delete this edit record? You will no longer be able to restore content from it.",
    "editLog.clear": "Clear logs",
    "editLog.clearConfirm": "Clear every edit record for this session? Existing message changes will not be reverted.",
    "editLog.deleted": "Edit record deleted",
    "sidebar.collapse": "Collapse",
    "sidebar.expand": "Expand",
    "sidebar.dragHint": "Drag to reorder, or press ↑ / ↓",
    "sidebar.dragLabel": "{platform}, priority {priority}. Drag to reorder, or use the up and down arrow keys.",
    "sidebar.enableToReorder": "Enable to reorder",
    "sidebar.showPlatform": "Show {platform}",
    "sidebar.hidePlatform": "Hide {platform}",
    sidebarSection: "Menu Visibility & Order",
    sidebarSectionDesc: "Choose platforms and the terminal sessions entry shown in the sidebar. Drag enabled items to set priority. Dashboard, Prompts, Settings & About are always visible.",
    "platformPaths": "Platform Paths",
    "platformPathsDesc": "Customize data directories for each platform. Leave empty to use defaults.",
    "claudeHomePath": "Claude Home Directory",
    "codexHomePath": "Codex Home Directory",
    "codexProjectRootPath": "Codex Project Root",
    "cursorHomePath": "Cursor Data Directory",
    "opencodePath": "OpenCode Database Path",
    "kiroHome": "Kiro Home Path",
    "kiroIdeHome": "Kiro IDE Data Directory",
    "geminiHome": "Gemini Home Directory",
    "platformGemini": "Gemini CLI",
    "grokHome": "Grok Build Home Directory",
    "piHome": "Pi Data Directory",
    "pathPlaceholder": "Leave empty for default",
    "pathSaved": "Path saved",
    "defaultPath": "Default: {path}",
    "session.loadMore": "Load more ({count} remaining)",
    "session.favorite": "Favorite",
    "session.unfavorite": "Unfavorite",
    "session.archive": "Archive",
    "session.unarchive": "Unarchive",
    "session.archived": "Archived",
    "session.archiveView": "Archive",
    "session.sessionsView": "Sessions",
    "session.noArchivedSessions": "No archived sessions",
    "session.archiveConfirm": "Archive this session? It will be hidden from the list but can be restored from the archive view.",
    "session.selectMode": "Select",
    "session.exitSelect": "Exit",
    "session.selectAll": "Select all",
    "session.invertSelection": "Invert",
    "session.selectedCount": "{count} selected",
    "session.batchArchive": "Archive",
    "session.batchUnarchive": "Unarchive",
    "session.batchFavorite": "Favorite",
    "session.batchUnfavorite": "Unfavorite",
    "session.batchArchived": "Archived {count} session(s)",
    "session.batchUnarchived": "Restored {count} session(s)",
    "session.batchFavorited": "Favorited {count} session(s)",
    "session.batchUnfavorited": "Unfavorited {count} session(s)",
    "session.batchFailed": "Batch operation failed",
    "session.noSelection": "No sessions selected",
    // Terminal UI
    "terminal.sessionRecord": "History",
    "terminal.tabTitle": "Terminal: {kind}",
    "terminal.resumeEmbedded": "Resume Session (Embedded)",
    "terminal.resumeExternal": "Resume in External Terminal",
    "terminal.copyResumeCmd": "Copy Resume Command",
    "terminal.forkEmbedded": "Fork Session (Embedded)",
    "terminal.forkExternal": "Fork in External Terminal",
    "terminal.copyForkCmd": "Copy Fork Command",
    "terminal.status.idle": "Idle",
    "terminal.status.starting": "Starting",
    "terminal.status.running": "Running",
    "terminal.status.stopping": "Stopping",
    "terminal.status.exited": "Exited",
    "terminal.status.failed": "Failed",
    "terminal.btn.restart": "Restart",
    "terminal.btn.stop": "Stop",
    "terminal.btn.forceStop": "Force Stop",
    "terminal.btn.confirmForceStop": "Confirm Force Stop?",
    "terminal.btn.cancel": "Cancel",
    "terminal.btn.openExternal": "Open External",
    "terminal.btn.close": "Close Session",
    "terminal.btn.maximize": "Maximize Terminal Workspace",
    "terminal.btn.restoreLayout": "Restore App Layout",
    "terminal.menu.rename": "Rename Terminal Session",
    "terminal.menu.copyCommand": "Copy Terminal Command",
    "terminal.renameHint": "Double-click to rename",
    "terminal.forceStopDesc": "Force stop immediately terminates the terminal process. Unsaved command state may be lost.",
    "terminal.idle.title": "Terminal Idle",
    "terminal.idle.desc": "Restore this session in an embedded terminal. Supports interactive CLI, ANSI colors, and cursor controls.",
    "terminal.idle.btn": "Start Embedded Terminal",
    "terminal.starting.title": "Preparing terminal environment...",
    "terminal.exited.title": "Terminal child process exited with code: {code}",
    "terminal.failed.title": "Failed to start terminal",
    "terminal.failed.retry": "Restart",
    "terminal.failed.copy": "Copy Command",
    "terminal.failed.external": "Open Externally",
    "terminal.cwd": "Working Dir",
    "terminal.tabs.maxWarning": "This history session has reached its terminal limit",
    "terminal.tabsLabel": "Terminal session list",
    "terminal.viewportLabel": "Interactive embedded terminal",
    "terminal.closeRunningTitle": "Close the running terminal?",
    "terminal.closeRunningDesc": "Closing this session immediately stops its running command. This cannot be undone.",
    "terminal.workspace.title": "Terminal Sessions",
    "terminal.workspace.subtitle": "Manage opened embedded terminals in one place. Running commands continue when you visit other pages.",
    "terminal.workspace.collection": "Session Collection",
    "terminal.workspace.emptyTitle": "No terminal sessions yet",
    "terminal.workspace.emptyDesc": "Open any history session and choose Embedded Resume or Embedded Fork from its terminal menu. It will appear here automatically.",
    "terminal.workspace.runningCount": "{running}/{total} running",
    "terminal.workspace.openedAt": "Opened at {time}",
    "terminal.workspace.source": "Source: {platform}",
    "terminal.workspace.externalFailed": "Could not open an external terminal. The command was copied to the clipboard.",
  },
};

export function translate(locale: LocaleId, key: MessageKey): string {
  return messages[locale]?.[key] ?? messages.en[key] ?? key;
}

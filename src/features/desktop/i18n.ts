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
  | "platformZcode"
  | "platformWorkbuddy"
  | "platformCindy"
  | "platformCindyGlobal"
  | "platformZed"
  | "platformDsh"
  | "platformQoderCn"
  | "platformQwen"
  | "platformCline"
  | "platformAntigravity"
  | "platformCodebuddy"
  | "platformDevin"
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
  | "session.searchIndexing"
  | "session.searchIndexIncomplete"
  | "session.noSessions"
  | "session.justNow"
  | "session.hoursAgo"
  | "session.daysAgo"
  | "session.untitled"
  | "session.noPreview"
  | "session.subagents"
  | "session.expandSubagents"
  | "session.collapseSubagents"
  | "session.orphanedSubagent"
  | "session.agentDepth"
  | "session.agentRole"
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
  | "session.eraseToolCall"
  | "session.eraseToolCallConfirm"
  | "session.toolCallErased"
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
  | "zcodeHome"
  | "workbuddyHome"
  | "cindyHome"
  | "cindyGlobalHome"
  | "zedHome"
  | "dshHome"
  | "qoderCnHome"
  | "qwenHome"
  | "clineHome"
  | "antigravityHome"
  | "codebuddyHome"
  | "devinHome"
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
  | "terminal.workspace.externalFailed"
  | "terminal.new.title"
  | "terminal.new.desc"
  | "terminal.new.launcher"
  | "terminal.new.cwd"
  | "terminal.new.cwdPlaceholder"
  | "terminal.new.browse"
  | "terminal.new.start"
  | "terminal.new.starting"
  | "terminal.new.cancel"
  | "terminal.new.limit"
  // HUD & Bilingual UI
  | "hud.nav.workbench"
  | "hud.nav.radar"
  | "hud.nav.arsenal"
  | "hud.cmdPaletteHint"
  | "hud.toggleLight"
  | "hud.toggleDark"
  | "hud.toggleTerminal"
  | "hud.winMinimize"
  | "hud.winMaximize"
  | "hud.winRestore"
  | "hud.winClose"
  | "hud.safeWriteBadge"
  | "hud.activeAdapters"
  | "hud.copyCwdHint"
  | "hud.contextLoad"
  | "hud.ptyCount"
  | "hud.ptyTitle"
  | "hud.newTerminal"
  | "hud.collapse"
  | "hud.ptyEmptyHint"
  | "hud.cmdPlaceholder"
  | "hud.cmdNoMatch"
  | "hud.cmdResume"
  | "hud.cmdNewPty"
  | "hud.cmdSwitchLight"
  | "hud.cmdSwitchDark"
  | "hud.cmdGoWorkbench"
  | "hud.cmdGoRadar"
  | "hud.cmdGoPrompts"
  | "hud.cmdGoSettings"
  | "hud.allWorkspaces"
  | "hud.idlePlatforms"
  | "hud.idlePlatformsHint"
  | "hud.groupToday"
  | "hud.groupEarlier"
  | "hud.readOnly"
  | "hud.subagentsCount"
  | "hud.importTargetPlatform"
  | "hud.doubleClickEditHint"
  | "hud.loadOutputs"
  | "hud.locateSpike"
  | "hud.liveVerify"
  | "hud.moreTerminalOpts"
  | "hud.resumeGroup"
  | "hud.forkGroup"
  | "hud.dnaTitle"
  | "hud.dnaHint"
  | "hud.emptyTape"
  | "hud.filterSpike"
  | "hud.rangeSelected"
  | "hud.rangeTokens"
  | "hud.rangeEraseBtn"
  | "hud.rangeErasing"
  | "hud.rangeExportBtn"
  | "hud.forgedStamp"
  | "hud.spikeStamp"
  | "hud.editMemory"
  | "hud.revertOriginal"
  | "hud.eraseShort"
  | "hud.toolArgs"
  | "hud.toolOutput"
  | "hud.toolError"
  | "hud.ghostOriginalTitle"
  | "hud.safeBackupTag"
  | "hud.insertFromPrompts"
  | "hud.noSavedPrompts"
  | "hud.collapseThinking"
  | "hud.expandThinking"
  | "hud.collapseLong"
  | "hud.expandLong"
  | "hud.emptyFrame"
  | "hud.noFramesInSession"
  | "hud.noMatchingFilter"
  | "hud.showAllFrames"
  | "hud.previewTools"
  | "hud.previewEmpty"
  | "hud.cleanSessionToast"
  | "hud.batchEraseTitle"
  | "hud.batchEraseDesc"
  | "hud.batchErasedToast"
  | "hud.revertedToast"
  | "hud.safeWriteGuarantee"
  | "hud.radarSubtitle"
  | "hud.enterWorkbench"
  | "hud.kpiPlatformsTitle"
  | "hud.kpiPlatformsSub"
  | "hud.kpiPlatformsDesc"
  | "hud.kpiSessionsTitle"
  | "hud.kpiSessionsDesc"
  | "hud.kpiTrendTitle"
  | "hud.kpiTrendDesc"
  | "hud.kpiPtyTitle"
  | "hud.kpiPtyBtn"
  | "hud.matrixTitle"
  | "hud.matrixBadge"
  | "hud.workspacesTitle"
  | "hud.recentSessionsTitle"
  | "hud.recentCount"
  | "hud.promptsSummary"
  | "hud.deletePromptTitle"
  | "hud.deletePromptDesc"
  | "hud.viewPrompt"
  | "hud.vaultKeyTitle"
  | "hud.unlock"
  | "hud.settingsSubtitle"
  | "hud.aboutAndUpdate"
  | "hud.themeDualDesc"
  | "hud.adapterEnableDesc"
  | "hud.backToSettings"
  | "hud.diagnosticsTitle"
  | "hud.sealedReadOnly"
  | "hud.sealedReadOnlyHint"
  | "hud.systemTagCollapsed"
  | "hud.systemTagCollapse"
  | "hud.ctxCopyCwd"
  | "hud.ctxCopySessionId"
  | "hud.ctxNoResumeCmd"
  | "hud.ctxCopyMessage"
  | "hud.ctxSaveAsPrompt"
  | "hud.ctxSavedAsPrompt"
  | "hud.locateInSidebar"
  | "hud.sidebarHoverHint"
  | "hud.closeTab"
  | "hud.pinnedSection"
  | "hud.projectsSection"
  | "hud.ungroupedSessions"
  | "hud.toolVerbRead"
  | "hud.toolVerbEdit"
  | "hud.toolVerbWrite"
  | "hud.toolVerbRun"
  | "hud.toolVerbSearch"
  | "hud.toolVerbFind"
  | "hud.toolVerbList"
  | "hud.toolVerbTodo"
  | "hud.toolVerbCall"
  | "hud.filesChangedSummary"
  | "hud.tabRename"
  | "hud.tabDoubleClickHint"
  | "hud.tabPin"
  | "hud.tabUnpin"
  | "hud.tabCloseOthers"
  | "hud.tabCloseRight"
  | "hud.clearWorkspaceFilter"
  | "hud.workspaceFilterEmpty"
  | "hud.unsavedDraft"
  | "hud.confirm"
  | "hud.editLogOnlyBadge"
  | "hud.editLogOnlyGuarantee"
  | "hud.batchEraseDescNoBackup"
  | "hud.batchErasePartial"
  | "hud.sessionLoadFailed"
  | "hud.vaultWrongKey";

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
    platformZcode: "ZCode",
    platformWorkbuddy: "WorkBuddy",
    platformCindy: "Cindy",
    platformCindyGlobal: "Cindy 国际版",
    platformZed: "Zed",
    platformDsh: "DeepSeek Harness",
    platformQoderCn: "Qoder CN",
    platformQwen: "Qwen Code",
    platformCline: "Cline",
    platformAntigravity: "Antigravity",
    platformCodebuddy: "CodeBuddy",
    platformDevin: "Devin",
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
    "session.searchIndexing": "正在后台建立搜索索引（{indexed}/{total}），当前结果可能不完整",
    "session.searchIndexIncomplete": "搜索索引尚未完成，当前结果可能不完整",
    "session.noSessions": "暂无会话",
    "session.justNow": "刚刚",
    "session.hoursAgo": "{count} 小时前",
    "session.daysAgo": "{count} 天前",
    "session.untitled": "无标题",
    "session.noPreview": "无预览",
    "session.subagents": "子代理",
    "session.expandSubagents": "展开子代理",
    "session.collapseSubagents": "收起子代理",
    "session.orphanedSubagent": "未关联子代理",
    "session.agentDepth": "层级",
    "session.agentRole": "角色",
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
    "session.eraseToolCall": "擦除工具调用",
    "session.eraseToolCallConfirm": "确定擦除这条工具调用吗？名称、输入、输出、错误和状态都会从 OpenCode 会话中删除，可通过修改记录复原。",
    "session.toolCallErased": "工具调用已擦除",
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
    "zcodeHome": "ZCode 主目录路径",
    "workbuddyHome": "WorkBuddy 数据目录",
    "cindyHome": "Cindy 数据目录",
    "cindyGlobalHome": "Cindy 国际版数据目录",
    "zedHome": "Zed 数据目录",
    "dshHome": "DeepSeek Harness 数据目录",
    "qoderCnHome": "Qoder CN 数据目录",
    "qwenHome": "Qwen Code 数据目录",
    "clineHome": "Cline 数据目录",
    "antigravityHome": "Antigravity 数据目录（只读）",
    "codebuddyHome": "CodeBuddy 数据目录",
    "devinHome": "Devin CLI / Desktop 数据目录（含 sessions.db）",
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
    "terminal.workspace.emptyDesc": "点击“新建会话”直接启动终端或 AI CLI，也可以进入历史会话选择“内嵌恢复”或“内嵌分支”。",
    "terminal.workspace.runningCount": "{running}/{total} 运行中",
    "terminal.workspace.openedAt": "打开于 {time}",
    "terminal.workspace.source": "来源：{platform}",
    "terminal.workspace.externalFailed": "外部终端启动失败，命令已复制到剪贴板。",
    "terminal.new.title": "新建会话",
    "terminal.new.desc": "选择一个终端或 AI CLI，指定工作目录后，直接在应用内打开交互式会话。",
    "terminal.new.launcher": "启动方式",
    "terminal.new.cwd": "工作目录",
    "terminal.new.cwdPlaceholder": "留空则使用应用当前目录",
    "terminal.new.browse": "选择目录",
    "terminal.new.start": "启动",
    "terminal.new.starting": "正在启动…",
    "terminal.new.cancel": "取消",
    "terminal.new.limit": "无法创建更多终端，请先关闭一些会话。",
    "hud.nav.workbench": "工作台",
    "hud.nav.radar": "总览",
    "hud.nav.arsenal": "提示词库",
    "hud.cmdPaletteHint": "搜索与快捷指令 (Ctrl+K)",
    "hud.toggleLight": "切换为浅色模式",
    "hud.toggleDark": "切换为深色模式",
    "hud.toggleTerminal": "展开/收起底部终端 (Ctrl+`)",
    "hud.winMinimize": "最小化",
    "hud.winMaximize": "最大化",
    "hud.winRestore": "向下还原",
    "hud.winClose": "关闭",
    "hud.safeWriteBadge": "安全写回 (.bak)",
    "hud.activeAdapters": "{count} 个活跃平台",
    "hud.copyCwdHint": "点击复制工作目录: {cwd}",
    "hud.contextLoad": "上下文",
    "hud.ptyCount": "{count} 终端",
    "hud.ptyTitle": "内嵌终端",
    "hud.newTerminal": "新建终端",
    "hud.collapse": "收起",
    "hud.ptyEmptyHint": "在上方改写历史消息后点击「同屏唤醒验证」，或直接新建交互式 CLI 会话。",
    "hud.cmdPlaceholder": "输入指令、跳转会话或切换主题...",
    "hud.cmdNoMatch": "无匹配指令或会话",
    "hud.cmdResume": "同屏恢复当前会话 ({cmd})",
    "hud.cmdNewPty": "新建内嵌终端会话",
    "hud.cmdSwitchLight": "切换为「钛白工程（浅色）」主题",
    "hud.cmdSwitchDark": "切换为「曜石熔金（深色）」主题",
    "hud.cmdGoWorkbench": "前往：会话工作台",
    "hud.cmdGoRadar": "前往：全局总览",
    "hud.cmdGoPrompts": "前往：提示词库",
    "hud.cmdGoSettings": "前往：系统设置",
    "hud.allWorkspaces": "全部项目工程",
    "hud.idlePlatforms": "+{count} 静默",
    "hud.idlePlatformsHint": "其余 {count} 个已启用平台暂无会话，已自动收纳",
    "hud.groupToday": "今日活跃",
    "hud.groupEarlier": "更早记录",
    "hud.readOnly": "只读",
    "hud.subagentsCount": "↳ {count} 个子代理",
    "hud.importTargetPlatform": "导入目标平台",
    "hud.doubleClickEditHint": "双击任意对话内容可原地无弹窗改写记忆",
    "hud.loadOutputs": "加载输出 ({count})",
    "hud.locateSpike": "定位噪音峰",
    "hud.liveVerify": "同屏唤醒验证",
    "hud.moreTerminalOpts": "更多终端恢复与分支选项",
    "hud.resumeGroup": "恢复会话",
    "hud.forkGroup": "分支会话",
    "hud.dnaTitle": "时序频谱",
    "hud.dnaHint": "#01 ──▶ #{count} · 点击跳转 / 拖拽框选",
    "hud.emptyTape": "空会话",
    "hud.filterSpike": "噪音峰",
    "hud.rangeSelected": "已框选 #{start} ~ #{end}",
    "hud.rangeTokens": "共约 {tokens} tokens",
    "hud.rangeEraseBtn": "批量擦除选中内容",
    "hud.rangeErasing": "清理中...",
    "hud.rangeExportBtn": "仅导出选中区间",
    "hud.forgedStamp": "已改写 · v{count}",
    "hud.spikeStamp": "噪音峰 {tokens}",
    "hud.editMemory": "改写",
    "hud.revertOriginal": "回滚原版",
    "hud.eraseShort": "擦除",
    "hud.toolArgs": "调用参数",
    "hud.toolOutput": "执行输出",
    "hud.toolError": "错误信息",
    "hud.ghostOriginalTitle": "修改前原文参照（上下游对话不遮挡）",
    "hud.safeBackupTag": "自动备份 (.bak)",
    "hud.insertFromPrompts": "+ 插入提示词",
    "hud.noSavedPrompts": "提示词库暂无内容",
    "hud.collapseThinking": "▴ 收起思考过程",
    "hud.expandThinking": "◈ 已折叠思考过程 ({count} 字符) · 点击展开",
    "hud.collapseLong": "收起长内容",
    "hud.expandLong": "展开完整内容 ({count}k 字符)",
    "hud.emptyFrame": "（此条消息内容已擦除为空）",
    "hud.noFramesInSession": "此会话暂无对话消息记录",
    "hud.noMatchingFilter": "当前筛选条件下无匹配消息",
    "hud.showAllFrames": "显示全部 ({count})",
    "hud.previewTools": "执行工具: {tools}",
    "hud.previewEmpty": "（空内容）",
    "hud.cleanSessionToast": "当前会话上下文干净，无高噪峰值",
    "hud.batchEraseTitle": "批量擦除 #{start} ~ #{end}",
    "hud.batchEraseDesc": "将清空选中的 {count} 条可编辑消息内容（自动保留修改记录与 .bak 备份），确认执行吗？",
    "hud.batchErasedToast": "已批量清理 {count} 条消息噪音",
    "hud.revertedToast": "已从审计记录回滚为原始消息",
    "hud.safeWriteGuarantee": "安全写回保障：仅原地替换被编辑消息行，其余行逐字节保留并自动生成 .bak 备份。",
    "hud.radarSubtitle": "跨平台本地会话态势总览",
    "hud.enterWorkbench": "进入会话工作台",
    "hud.kpiPlatformsTitle": "接入平台源",
    "hud.kpiPlatformsSub": "有数据 / {total} 启用",
    "hud.kpiPlatformsDesc": "零数据平台自动收纳，保持工作台清爽",
    "hud.kpiSessionsTitle": "本地总会话",
    "hud.kpiSessionsDesc": "100% 本地原文件直读 · 逐字节安全写回",
    "hud.kpiTrendTitle": "近 7 日活跃",
    "hud.kpiTrendDesc": "跨平台最近活跃会话分布",
    "hud.kpiPtyTitle": "常驻内嵌终端",
    "hud.kpiPtyBtn": "打开底部同屏终端舱",
    "hud.matrixTitle": "全平台本地探测矩阵（点击直达）",
    "hud.matrixBadge": "纯本地零云端",
    "hud.workspacesTitle": "高频项目工程直达",
    "hud.recentSessionsTitle": "最近活跃会话直达",
    "hud.recentCount": "{count} 条",
    "hud.promptsSummary": "共 {count} 条提示词 · 累计调用 {uses} 次",
    "hud.deletePromptTitle": "删除提示词",
    "hud.deletePromptDesc": "确定要从提示词库删除此条目吗？",
    "hud.viewPrompt": "查看",
    "hud.vaultKeyTitle": "输入解锁口令",
    "hud.unlock": "解锁",
    "hud.settingsSubtitle": "系统与本地平台适配器设置",
    "hud.aboutAndUpdate": "关于与检查更新",
    "hud.themeDualDesc": "提供深色与浅色两套高对比精密配色。",
    "hud.adapterEnableDesc": "启用或禁用需要扫描的 AI 平台适配器（拖拽可调整排序）。",
    "hud.backToSettings": "返回设置",
    "hud.diagnosticsTitle": "本地运行环境与路径诊断",
    "hud.sealedReadOnly": "签名只读",
    "hud.sealedReadOnlyHint": "该平台对此消息/思考块带有签名校验保护，修改会导致恢复会话报错，因此保持只读",
    "hud.systemTagCollapsed": "⚙ 系统注入块 <{tag}> ({count} 字符) · 点击展开",
    "hud.systemTagCollapse": "▴ 收起 <{tag}>",
    "hud.ctxCopyCwd": "复制工作目录路径",
    "hud.ctxCopySessionId": "复制会话 ID",
    "hud.ctxNoResumeCmd": "该平台暂不支持命令行恢复",
    "hud.ctxCopyMessage": "复制整条消息内容",
    "hud.ctxSaveAsPrompt": "存入本地提示词库",
    "hud.ctxSavedAsPrompt": "已存入提示词库",
    "hud.locateInSidebar": "在侧栏中定位当前会话",
    "hud.sidebarHoverHint": "点击固定展开侧栏 · 鼠标移上可临时预览",
    "hud.closeTab": "关闭页签",
    "hud.pinnedSection": "置顶",
    "hud.projectsSection": "项目",
    "hud.ungroupedSessions": "未归属目录",
    "hud.toolVerbRead": "读取",
    "hud.toolVerbEdit": "编辑",
    "hud.toolVerbWrite": "写入",
    "hud.toolVerbRun": "运行",
    "hud.toolVerbSearch": "搜索",
    "hud.toolVerbFind": "查找",
    "hud.toolVerbList": "列目录",
    "hud.toolVerbTodo": "更新待办",
    "hud.toolVerbCall": "调用",
    "hud.filesChangedSummary": "本轮涉及 {count} 个文件改动",
    "hud.tabRename": "重命名",
    "hud.tabDoubleClickHint": "双击",
    "hud.tabPin": "固定页签",
    "hud.tabUnpin": "取消固定",
    "hud.tabCloseOthers": "关闭其他",
    "hud.tabCloseRight": "关闭右侧",
    "hud.clearWorkspaceFilter": "清除项目过滤",
    "hud.workspaceFilterEmpty": "当前列表中没有这个项目的会话（可加载更多或清除过滤）",
    "hud.unsavedDraft": "有未保存的改写草稿，切回此页签会自动恢复",
    "hud.confirm": "确认",
    "hud.editLogOnlyBadge": "可从修改记录回滚",
    "hud.editLogOnlyGuarantee": "该平台直接写入数据库，不生成 .bak 备份；每次修改都会记入修改记录，可在这里逐条回滚。",
    "hud.batchEraseDescNoBackup": "将清空选中的 {count} 条可编辑消息内容。该平台写回不生成 .bak 备份，只能通过修改记录逐条回滚，确认执行吗？",
    "hud.batchErasePartial": "已擦除 {erased}/{total} 条，其余未执行：{error}",
    "hud.sessionLoadFailed": "无法加载该会话（可能已被删除或移动），可关闭此页签",
    "hud.vaultWrongKey": "口令不对",
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
    platformZcode: "ZCode",
    platformWorkbuddy: "WorkBuddy",
    platformCindy: "Cindy",
    platformCindyGlobal: "Cindy Global",
    platformZed: "Zed",
    platformDsh: "DeepSeek Harness",
    platformQoderCn: "Qoder CN",
    platformQwen: "Qwen Code",
    platformCline: "Cline",
    platformAntigravity: "Antigravity",
    platformCodebuddy: "CodeBuddy",
    platformDevin: "Devin",
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
    "session.searchIndexing": "Building search index in background ({indexed}/{total}); results may be incomplete",
    "session.searchIndexIncomplete": "Search index is not complete; results may be incomplete",
    "session.noSessions": "No sessions",
    "session.justNow": "Just now",
    "session.hoursAgo": "{count}h ago",
    "session.daysAgo": "{count}d ago",
    "session.untitled": "Untitled",
    "session.noPreview": "No preview",
    "session.subagents": "Subagents",
    "session.expandSubagents": "Expand subagents",
    "session.collapseSubagents": "Collapse subagents",
    "session.orphanedSubagent": "Unlinked subagent",
    "session.agentDepth": "Depth",
    "session.agentRole": "Role",
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
    "session.eraseToolCall": "Erase tool call",
    "session.eraseToolCallConfirm": "Erase this tool call? Its name, input, output, error, and status will be removed from the OpenCode session. You can restore it from the edit log.",
    "session.toolCallErased": "Tool call erased",
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
    "zcodeHome": "ZCode Home Path",
    "workbuddyHome": "WorkBuddy Data Directory",
    "cindyHome": "Cindy Data Directory",
    "cindyGlobalHome": "Cindy Global Data Directory",
    "zedHome": "Zed Data Directory",
    "dshHome": "DeepSeek Harness Data Directory",
    "qoderCnHome": "Qoder CN Data Directory",
    "qwenHome": "Qwen Code Data Directory",
    "clineHome": "Cline Data Directory",
    "antigravityHome": "Antigravity Data Directory (read-only)",
    "codebuddyHome": "CodeBuddy Data Directory",
    "devinHome": "Devin CLI / Desktop Data Directory (contains sessions.db)",
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
    "terminal.workspace.emptyDesc": "Click New Session to launch a terminal or AI CLI directly, or open a history session and choose Embedded Resume / Embedded Fork.",
    "terminal.workspace.runningCount": "{running}/{total} running",
    "terminal.workspace.openedAt": "Opened at {time}",
    "terminal.workspace.source": "Source: {platform}",
    "terminal.workspace.externalFailed": "Could not open an external terminal. The command was copied to the clipboard.",
    "terminal.new.title": "New Session",
    "terminal.new.desc": "Pick a terminal or AI CLI and a working directory to open an interactive session inside the app.",
    "terminal.new.launcher": "Launcher",
    "terminal.new.cwd": "Working Directory",
    "terminal.new.cwdPlaceholder": "Leave empty to use the app working directory",
    "terminal.new.browse": "Choose folder",
    "terminal.new.start": "Start",
    "terminal.new.starting": "Starting…",
    "terminal.new.cancel": "Cancel",
    "terminal.new.limit": "Could not create another terminal. Close some sessions first.",
    "hud.nav.workbench": "Workbench",
    "hud.nav.radar": "Overview",
    "hud.nav.arsenal": "Prompts",
    "hud.cmdPaletteHint": "Search & Commands (Ctrl+K)",
    "hud.toggleLight": "Switch to Light Mode",
    "hud.toggleDark": "Switch to Dark Mode",
    "hud.toggleTerminal": "Toggle Terminal Panel (Ctrl+`)",
    "hud.winMinimize": "Minimize",
    "hud.winMaximize": "Maximize",
    "hud.winRestore": "Restore",
    "hud.winClose": "Close",
    "hud.safeWriteBadge": "Safe Write (.bak)",
    "hud.activeAdapters": "{count} active",
    "hud.copyCwdHint": "Click to copy working directory: {cwd}",
    "hud.contextLoad": "Context",
    "hud.ptyCount": "{count} PTY",
    "hud.ptyTitle": "Terminal",
    "hud.newTerminal": "New Terminal",
    "hud.collapse": "Collapse",
    "hud.ptyEmptyHint": "Edit messages above and click Resume & Verify, or launch a new interactive CLI session.",
    "hud.cmdPlaceholder": "Type a command, jump to session, or switch theme...",
    "hud.cmdNoMatch": "No matching commands or sessions",
    "hud.cmdResume": "Resume active session in panel ({cmd})",
    "hud.cmdNewPty": "New embedded terminal session",
    "hud.cmdSwitchLight": "Switch to Braun Titanium (Light) theme",
    "hud.cmdSwitchDark": "Switch to Chrono Obsidian (Dark) theme",
    "hud.cmdGoWorkbench": "Go to: Session Workbench",
    "hud.cmdGoRadar": "Go to: Overview",
    "hud.cmdGoPrompts": "Go to: Prompt Library",
    "hud.cmdGoSettings": "Go to: Settings",
    "hud.allWorkspaces": "All Projects",
    "hud.idlePlatforms": "+{count} idle",
    "hud.idlePlatformsHint": "{count} enabled platforms with 0 sessions are hidden",
    "hud.groupToday": "Today",
    "hud.groupEarlier": "Earlier",
    "hud.readOnly": "RO",
    "hud.subagentsCount": "↳ {count} subagents",
    "hud.importTargetPlatform": "Target platform",
    "hud.doubleClickEditHint": "Double-click any message to edit in place without modals",
    "hud.loadOutputs": "Load outputs ({count})",
    "hud.locateSpike": "Locate Spike",
    "hud.liveVerify": "Resume & Verify",
    "hud.moreTerminalOpts": "More resume & fork options",
    "hud.resumeGroup": "Resume Session",
    "hud.forkGroup": "Fork Session",
    "hud.dnaTitle": "Timeline",
    "hud.dnaHint": "#01 ──▶ #{count} · Click to jump / Drag to select",
    "hud.emptyTape": "Empty session",
    "hud.filterSpike": "Spikes",
    "hud.rangeSelected": "Selected #{start} ~ #{end}",
    "hud.rangeTokens": "~{tokens} tokens",
    "hud.rangeEraseBtn": "Erase Selected",
    "hud.rangeErasing": "Erasing...",
    "hud.rangeExportBtn": "Export Range",
    "hud.forgedStamp": "Edited · v{count}",
    "hud.spikeStamp": "Spike {tokens}",
    "hud.editMemory": "Edit",
    "hud.revertOriginal": "Revert",
    "hud.eraseShort": "Erase",
    "hud.toolArgs": "Arguments",
    "hud.toolOutput": "Output",
    "hud.toolError": "Error",
    "hud.ghostOriginalTitle": "Original Reference (surrounding context stays visible)",
    "hud.safeBackupTag": "Auto Backup (.bak)",
    "hud.insertFromPrompts": "+ Insert Prompt",
    "hud.noSavedPrompts": "No saved prompts yet",
    "hud.collapseThinking": "▴ Collapse thinking",
    "hud.expandThinking": "◈ Thinking collapsed ({count} chars) · Click to expand",
    "hud.collapseLong": "Show less",
    "hud.expandLong": "Show full ({count}k chars)",
    "hud.emptyFrame": "(Message content erased)",
    "hud.noFramesInSession": "No messages in this session",
    "hud.noMatchingFilter": "No messages match the current filter",
    "hud.showAllFrames": "Show all ({count})",
    "hud.previewTools": "Tools: {tools}",
    "hud.previewEmpty": "(Empty)",
    "hud.cleanSessionToast": "Session context is clean — no token spikes detected",
    "hud.batchEraseTitle": "Batch Erase #{start} ~ #{end}",
    "hud.batchEraseDesc": "Clear content of {count} editable messages in the selected range? (Audit logs and .bak backups are preserved.)",
    "hud.batchErasedToast": "Cleared noise from {count} messages",
    "hud.revertedToast": "Reverted message from audit log",
    "hud.safeWriteGuarantee": "Safe Write Guarantee: Only the edited message line is replaced; every other line is preserved byte-for-byte with automatic .bak backups.",
    "hud.radarSubtitle": "Cross-Platform Local Session Overview",
    "hud.enterWorkbench": "Open Workbench",
    "hud.kpiPlatformsTitle": "Mounted Platforms",
    "hud.kpiPlatformsSub": "active / {total} enabled",
    "hud.kpiPlatformsDesc": "Zero-session platforms are tucked away automatically",
    "hud.kpiSessionsTitle": "Total Sessions",
    "hud.kpiSessionsDesc": "100% local file access · byte-exact write-back",
    "hud.kpiTrendTitle": "7-Day Activity",
    "hud.kpiTrendDesc": "Recent active session distribution",
    "hud.kpiPtyTitle": "Embedded Terminals",
    "hud.kpiPtyBtn": "Open bottom terminal panel",
    "hud.matrixTitle": "Local Platform Matrix (click to open)",
    "hud.matrixBadge": "100% Local",
    "hud.workspacesTitle": "Active Project Workspaces",
    "hud.recentSessionsTitle": "Recent Active Sessions",
    "hud.recentCount": "{count} items",
    "hud.promptsSummary": "{count} prompts · {uses} total uses",
    "hud.deletePromptTitle": "Delete Prompt",
    "hud.deletePromptDesc": "Delete this prompt from your local library?",
    "hud.viewPrompt": "View",
    "hud.vaultKeyTitle": "Enter Vault Passphrase",
    "hud.unlock": "Unlock",
    "hud.settingsSubtitle": "System & Local Adapter Configuration",
    "hud.aboutAndUpdate": "About & Updates",
    "hud.themeDualDesc": "Clean dark and light high-contrast precision themes.",
    "hud.adapterEnableDesc": "Enable or disable AI platform adapters (drag to reorder priority).",
    "hud.backToSettings": "Back to Settings",
    "hud.diagnosticsTitle": "Local Runtime Diagnostics",
    "hud.sealedReadOnly": "Signed · RO",
    "hud.sealedReadOnlyHint": "This platform attaches a cryptographic signature to this block; modifying it would break session resume.",
    "hud.systemTagCollapsed": "⚙ System Injected <{tag}> ({count} chars) · Click to expand",
    "hud.systemTagCollapse": "▴ Collapse <{tag}>",
    "hud.ctxCopyCwd": "Copy Working Directory",
    "hud.ctxCopySessionId": "Copy Session ID",
    "hud.ctxNoResumeCmd": "CLI resume is not supported for this platform",
    "hud.ctxCopyMessage": "Copy Full Message",
    "hud.ctxSaveAsPrompt": "Save to Prompt Library",
    "hud.ctxSavedAsPrompt": "Saved to Prompt Library",
    "hud.locateInSidebar": "Locate active session in sidebar",
    "hud.sidebarHoverHint": "Click to dock sidebar · Hover to peek",
    "hud.closeTab": "Close tab",
    "hud.pinnedSection": "Pinned",
    "hud.projectsSection": "Projects",
    "hud.ungroupedSessions": "Other Sessions",
    "hud.toolVerbRead": "Read",
    "hud.toolVerbEdit": "Edit",
    "hud.toolVerbWrite": "Write",
    "hud.toolVerbRun": "Run",
    "hud.toolVerbSearch": "Search",
    "hud.toolVerbFind": "Find",
    "hud.toolVerbList": "List",
    "hud.toolVerbTodo": "Todo",
    "hud.toolVerbCall": "Call",
    "hud.filesChangedSummary": "{count} files touched in this turn",
    "hud.tabRename": "Rename",
    "hud.tabDoubleClickHint": "DblClick",
    "hud.tabPin": "Pin Tab",
    "hud.tabUnpin": "Unpin Tab",
    "hud.tabCloseOthers": "Close Others",
    "hud.tabCloseRight": "Close to the Right",
    "hud.clearWorkspaceFilter": "Clear project filter",
    "hud.workspaceFilterEmpty": "No sessions for this project in the current list (load more or clear the filter)",
    "hud.unsavedDraft": "Unsaved edit draft — restored when you return to this tab",
    "hud.confirm": "Confirm",
    "hud.editLogOnlyBadge": "Revertible via edit log",
    "hud.editLogOnlyGuarantee": "This platform writes straight to its database without .bak backups; every change is recorded in the edit log and can be reverted here one by one.",
    "hud.batchEraseDescNoBackup": "This clears {count} editable messages. This platform keeps no .bak backup, so changes can only be reverted one by one from the edit log. Continue?",
    "hud.batchErasePartial": "Erased {erased}/{total}; the rest was skipped: {error}",
    "hud.sessionLoadFailed": "Could not load this session (it may have been deleted or moved). You can close this tab.",
    "hud.vaultWrongKey": "Wrong passphrase",
  },
};

export function translate(locale: LocaleId, key: MessageKey): string {
  return messages[locale]?.[key] ?? messages.en[key] ?? key;
}

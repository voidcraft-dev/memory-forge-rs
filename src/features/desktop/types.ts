// ─── Desktop ───

export type ThemeId =
  | "chrono"
  | "braun"
  | "graphite"
  | "linen"
  | "porcelain"
  | "ocean"
  | "ember"
  | "twilight";
export type LocaleId = "zh-CN" | "en";

export type DesktopSettings = {
  theme: ThemeId;
  locale: LocaleId;
  closeToTrayOnClose: boolean;
  launchOnStartup: boolean;
  reduceMotion: boolean;
  claudeHome: string | null;
  codexHome: string | null;
  codexProjectRoot: string | null;
  cursorHome: string | null;
  opencodePath: string | null;
  kiroHome: string | null;
  kiroIdeHome: string | null;
  geminiHome: string | null;
  grokHome: string | null;
  piHome: string | null;
  zcodeHome: string | null;
  workbuddyHome: string | null;
  cindyHome: string | null;
  cindyGlobalHome: string | null;
  zedHome: string | null;
  dshHome: string | null;
  qoderCnHome: string | null;
  qwenHome: string | null;
  clineHome: string | null;
  antigravityHome: string | null;
  codebuddyHome: string | null;
  devinHome: string | null;
  preferredTerminal: string | null;
  visiblePlatforms: string[];
  navigationItems: string[];
};

export type DesktopSettingsPatch = Partial<DesktopSettings>;

export type DesktopSnapshot = {
  appName: string;
  version: string;
  runtime: "tauri" | "web-preview";
  configDir: string;
  configFile: string;
  dataDir: string;
  dbPath: string;
  trayAvailable: boolean;
  autostartSupported: boolean;
  backupWritePlatforms?: string[];
  settings: DesktopSettings;
};

// ─── Session ───

export type Platform = "claude" | "codex" | "cursor" | "opencode" | "kiro" | "kiro-ide" | "gemini" | "grok" | "pi" | "zcode" | "workbuddy" | "cindy" | "cindy-global" | "zed" | "dsh" | "qoder-cn" | "qwen" | "cline" | "antigravity" | "codebuddy" | "devin";

export type ContentMatch = {
  snippet: string;
  matchIndex: number;
  role: string;
};

export type ToolCallBlock = {
  id: string;
  name: string;
  kind: string;
  status: string;
  input?: string | null;
  output?: string | null;
  error?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  sourceMeta: Record<string, unknown>;
};

export type Session = {
  platform: string;
  sessionKey: string;
  sessionId: string;
  displayTitle: string;
  aliasTitle: string;
  preview: string;
  updatedAt: string;
  cwd: string;
  editable: boolean;
  contentMatches?: ContentMatch[];
  totalContentMatches?: number;
  favorite?: boolean;
  sourceLabel?: string;
  agentGroup?: {
    parentSessionId?: string | null;
    depth?: number | null;
    nickname?: string | null;
    role?: string | null;
    path?: string | null;
    orphaned?: boolean;
    children?: Session[];
  } | null;
};

export type TimelineBlock = {
  id: string;
  role: "user" | "assistant" | "thinking";
  content: string;
  editable: boolean;
  editTarget: string;
  sourceMeta: Record<string, unknown>;
  createdAt?: string | null;
  toolCalls?: ToolCallBlock[];
};

export type SessionDetail = {
  platform: string;
  sessionKey: string;
  sessionId: string;
  title: string;
  aliasTitle: string;
  cwd: string;
  commands: Record<string, string>;
  blocks: TimelineBlock[];
};

export type EditorTarget = {
  id: string;
  label: string;
};

export type SessionListResult = {
  total: number;
  items: Session[];
  searchIndex: {
    supported: boolean;
    running: boolean;
    indexed: number;
    total: number;
  };
};

export type RawJsonlImportPreview = {
  platform: string;
  sessionId: string;
  cwd: string;
  title: string;
  preview: string;
  detectedAt: string;
  sourcePath: string;
  targetPath: string;
  conflict: "same" | "different" | null;
  warnings: string[];
};

export type RawJsonlImportResult = {
  platform: string;
  sessionKey: string;
  sessionId: string;
  targetPath: string;
  alreadyExists: boolean;
  renamed: boolean;
  warnings: string[];
};

export type RawJsonlExportResult = {
  platform: string;
  sourcePath: string;
  outputPath: string;
  bytes: number;
};

export type PlatformSummary = {
  platform: string;
  count: number;
  latest: string;
  items: Session[];
};

export type EraseTarget = {
  editTarget: string;
  expectedContent: string;
};

export type BatchEraseResult = {
  erased: number;
  total: number;
  error: string | null;
};

export type EditLogEntry = {
  id: number;
  editTarget: string;
  oldContent: string;
  newContent: string;
  createdAt: string;
};

export type SessionStatus = {
  tone: "success" | "error";
  message: string;
};

export type DashboardSummary = {
  platforms: PlatformSummary[];
  trend: Array<{ day: string; count: number }>;
  recentSessions: Session[];
};

// ─── Update ───

export type UpdateInfo = {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  publishedAt: string;
};

// ─── Prompt ───

export type PromptItem = {
  id: number;
  name: string;
  content: string;
  tags: string;  // comma-separated from Rust
  useCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PromptCreateInput = {
  name: string;
  content: string;
  tags: string[];
};

export type PromptUpdateInput = {
  name?: string;
  content?: string;
  tags?: string[];
};

// ─── App State ───

export type OpenSessionTab = {
  platform: string;
  sessionKey: string;
  title: string;
  pinned?: boolean;
  cwd?: string;
};

export type EditingBlock = {
  id: string;
  content: string;
  role: string;
  originalContent: string;
  platform?: string;
  sessionKey?: string;
};

export type AppState = {
  currentPlatform: string;
  selectedSessionPlatform: string | null;
  workspaceFilter: string;
  sessions: Session[];
  selectedSessionKey: string | null;
  sessionDetail: SessionDetail | null;
  dashboard: DashboardSummary | null;
  roleFilter: "all" | "user" | "assistant" | "thinking" | "spike";
  searchQuery: string;
  editingBlock: EditingBlock | null;
  editDrafts: Record<string, EditingBlock>;
  editLog: EditLogEntry[];
  showEditLog: boolean;
  sessionStatus: SessionStatus | null;
  mobileSidebarOpen: boolean;
  showArchived: boolean;
  ptyBayOpen: boolean;
  ptyBayMaximized: boolean;
  commandPaletteOpen: boolean;
  railCollapsed: boolean;
  railHoverPeek: boolean;
  locateRequestNonce: number;
  openSessionTabs: OpenSessionTab[];
};

export type AppAction =
  | { type: "setCurrentPlatform"; payload: string }
  | { type: "setSelectedSessionPlatform"; payload: string | null }
  | { type: "setWorkspaceFilter"; payload: string }
  | { type: "setSessions"; payload: Session[] }
  | { type: "updateSession"; payload: { sessionKey: string; updates: Partial<Session> } }
  | { type: "setSelectedSessionKey"; payload: string | null }
  | { type: "selectSession"; payload: { platform: string; sessionKey: string } }
  | { type: "setSessionDetail"; payload: SessionDetail | null }
  | { type: "setDashboard"; payload: DashboardSummary | null }
  | { type: "setRoleFilter"; payload: "all" | "user" | "assistant" | "thinking" | "spike" }
  | { type: "setSearchQuery"; payload: string }
  | { type: "setEditingBlock"; payload: EditingBlock | null }
  | { type: "clearEditingBlock"; payload: { id: string; sessionKey?: string } }
  | { type: "setEditLog"; payload: EditLogEntry[] }
  | { type: "setShowEditLog"; payload: boolean }
  | { type: "setSessionStatus"; payload: SessionStatus | null }
  | { type: "setMobileSidebarOpen"; payload: boolean }
  | { type: "setShowArchived"; payload: boolean }
  | { type: "setPtyBayOpen"; payload: boolean }
  | { type: "setPtyBayMaximized"; payload: boolean }
  | { type: "setCommandPaletteOpen"; payload: boolean }
  | { type: "setRailCollapsed"; payload: boolean }
  | { type: "setRailHoverPeek"; payload: boolean }
  | { type: "requestLocateSession" }
  | { type: "upsertSessionTab"; payload: OpenSessionTab }
  | { type: "togglePinSessionTab"; payload: { platform: string; sessionKey: string } }
  | { type: "closeSessionTab"; payload: { platform: string; sessionKey: string } }
  | { type: "closeOtherSessionTabs"; payload: { platform: string; sessionKey: string } }
  | { type: "closeRightSessionTabs"; payload: { platform: string; sessionKey: string } };

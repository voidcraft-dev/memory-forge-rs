// ─── Desktop ───

export type ThemeId = "graphite" | "linen" | "porcelain" | "ocean" | "ember";
export type LocaleId = "zh-CN" | "en";

export type DesktopSettings = {
  theme: ThemeId;
  locale: LocaleId;
  closeToTrayOnClose: boolean;
  launchOnStartup: boolean;
  reduceMotion: boolean;
  claudeHome: string | null;
  codexHome: string | null;
  opencodePath: string | null;
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
  settings: DesktopSettings;
};

// ─── Session ───

export type Platform = "claude" | "codex" | "opencode";

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
};

export type TimelineBlock = {
  id: string;
  role: "user" | "assistant" | "thinking";
  content: string;
  editable: boolean;
  editTarget: string;
  sourceMeta: Record<string, unknown>;
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

export type SessionListResult = {
  total: number;
  items: Session[];
};

export type PlatformSummary = {
  platform: string;
  count: number;
  latest: string;
  items: Session[];
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

export type AppState = {
  currentPlatform: string;
  sessions: Session[];
  selectedSessionKey: string | null;
  sessionDetail: SessionDetail | null;
  dashboard: DashboardSummary | null;
  roleFilter: "all" | "user" | "assistant" | "thinking";
  searchQuery: string;
  editingBlock: { id: string; content: string; role: string; originalContent: string } | null;
  editLog: EditLogEntry[];
  showEditLog: boolean;
  sessionStatus: SessionStatus | null;
  mobileSidebarOpen: boolean;
};

export type AppAction =
  | { type: "setCurrentPlatform"; payload: string }
  | { type: "setSessions"; payload: Session[] }
  | { type: "updateSession"; payload: { sessionKey: string; updates: Partial<Session> } }
  | { type: "setSelectedSessionKey"; payload: string | null }
  | { type: "setSessionDetail"; payload: SessionDetail | null }
  | { type: "setDashboard"; payload: DashboardSummary | null }
  | { type: "setRoleFilter"; payload: "all" | "user" | "assistant" | "thinking" }
  | { type: "setSearchQuery"; payload: string }
  | { type: "setEditingBlock"; payload: { id: string; content: string; role: string; originalContent: string } | null }
  | { type: "setEditLog"; payload: EditLogEntry[] }
  | { type: "setShowEditLog"; payload: boolean }
  | { type: "setSessionStatus"; payload: SessionStatus | null }
  | { type: "setMobileSidebarOpen"; payload: boolean };

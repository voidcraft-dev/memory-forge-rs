import { invoke } from "@tauri-apps/api/core";
import type {
  DashboardSummary,
  DesktopSettingsPatch,
  DesktopSnapshot,
  EditorTarget,
  EditLogEntry,
  PromptCreateInput,
  PromptItem,
  PromptUpdateInput,
  RawJsonlExportResult,
  RawJsonlImportPreview,
  RawJsonlImportResult,
  RemoteServerStatus,
  SessionDetail,
  SessionListResult,
  UpdateInfo,
} from "@/features/desktop/types";
import type {
  EditMessageMutation,
  RemoteBootstrap,
  RemoteCapabilities,
  RestoreMessageMutation,
} from "@/features/remote/protocol";

const STORAGE_KEY = "memory-forge.snapshot";
const API_BASE = "/api/v1";
const REMOTE_DEVICE_ID_KEY = "memory-forge.remote-device-id";
const REMOTE_ACCESS_TOKEN_KEY = "memory-forge.remote-access-token";

let webRemoteCapabilities: RemoteCapabilities | null = null;

const defaultSettings = {
  theme: "porcelain" as const,
  locale: "zh-CN" as const,
  closeToTrayOnClose: true,
  launchOnStartup: false,
  reduceMotion: false,
  claudeHome: null,
  codexHome: null,
  codexProjectRoot: null,
  cursorHome: null,
  opencodePath: null,
  kiroHome: null,
  kiroIdeHome: null,
  geminiHome: null,
  grokHome: null,
  piHome: null,
  preferredTerminal: null,
  visiblePlatforms: ["claude", "codex", "opencode", "grok", "pi"] as string[],
  navigationItems: [
    "claude",
    "codex",
    "terminal-sessions",
    "opencode",
    "grok",
    "pi",
  ] as string[],
  remoteBindMode: "loopback" as const,
  remotePort: 7331,
  remoteMutationsEnabled: false,
};

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isSessionRevisionConflict(error: unknown) {
  if (typeof error === "string") {
    return error.includes("SESSION_REVISION_CONFLICT");
  }
  if (error instanceof Error) {
    return error.message.includes("SESSION_REVISION_CONFLICT");
  }
  try {
    return JSON.stringify(error).includes("SESSION_REVISION_CONFLICT");
  } catch {
    return false;
  }
}

function defaultWebSnapshot(): DesktopSnapshot {
  webRemoteCapabilities = null;
  return {
    appName: "Memory Forge",
    version: "3.0.0",
    runtime: "web-preview",
    configDir: "browser://local-storage",
    configFile: "browser://local-storage/settings.json",
    dataDir: "browser://cache",
    dbPath: "browser://cache/memory-forge.db",
    trayAvailable: false,
    autostartSupported: false,
    settings: defaultSettings,
  };
}

function remoteWebSnapshot(bootstrap: RemoteBootstrap): DesktopSnapshot {
  const local = readWebSnapshot();
  webRemoteCapabilities = bootstrap.capabilities;
  const availablePlatforms = bootstrap.platforms
    .filter((platform) => platform.available)
    .map((platform) => platform.id);
  const availableSet = new Set(availablePlatforms);
  const navigationItems = (local.settings.navigationItems ?? []).filter(
    (item) => item === "terminal-sessions"
      ? bootstrap.capabilities.terminal
      : availableSet.has(item),
  );
  const nextNavigationItems = navigationItems.length > 0
    ? navigationItems
    : availablePlatforms.slice(0, 6);

  return {
    ...local,
    appName: "Memory Forge",
    version: bootstrap.serverVersion,
    runtime: "remote-web",
    configDir: `remote://${bootstrap.serverName}`,
    configFile: "remote://bootstrap",
    dataDir: `remote://${bootstrap.serverId}`,
    dbPath: "remote://daemon",
    trayAvailable: false,
    autostartSupported: false,
    remote: bootstrap,
    settings: {
      ...local.settings,
      visiblePlatforms: availablePlatforms,
      navigationItems: nextNavigationItems,
    },
  };
}

function readWebSnapshot() {
  if (typeof window === "undefined") return defaultWebSnapshot();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultWebSnapshot();
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopSnapshot>;
    const defaults = defaultWebSnapshot();
    const snapshot: DesktopSnapshot = {
      ...defaults,
      ...parsed,
      settings: {
        ...defaultSettings,
        ...parsed.settings,
      },
    };
    webRemoteCapabilities = snapshot.runtime === "remote-web"
      ? snapshot.remote?.capabilities ?? null
      : null;
    return snapshot;
  } catch {
    return defaultWebSnapshot();
  }
}

function writeWebSnapshot(snapshot: DesktopSnapshot) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

// ─── Desktop ───

export async function loadDesktopSnapshot(): Promise<DesktopSnapshot> {
  if (!isTauriRuntime()) {
    try {
      const response = await fetch(`${API_BASE}/bootstrap`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (response.ok) {
        const envelope = (await response.json()) as {
          data?: RemoteBootstrap;
        };
        if (envelope.data?.capabilities && envelope.data.serverId) {
          const snapshot = remoteWebSnapshot(envelope.data);
          writeWebSnapshot(snapshot);
          return snapshot;
        }
      }
    } catch {
      // A standalone browser preview has no daemon. Keep the local preview fallback.
    }
    const snapshot = defaultWebSnapshot();
    writeWebSnapshot(snapshot);
    return snapshot;
  }
  return invoke<DesktopSnapshot>("app_bootstrap");
}

export async function updateDesktopSettings(
  patch: DesktopSettingsPatch
): Promise<DesktopSnapshot> {
  if (!isTauriRuntime()) {
    const current = readWebSnapshot();
    const next = { ...current, settings: { ...current.settings, ...patch } };
    writeWebSnapshot(next);
    return next;
  }
  return invoke<DesktopSnapshot>("app_settings_set", { patch });
}

export async function getRemoteServerStatus(): Promise<RemoteServerStatus> {
  if (!isTauriRuntime()) {
    throw new Error("Remote server status is only available in the desktop app");
  }
  return invoke<RemoteServerStatus>("remote_server_status");
}

export async function restartRemoteServer(): Promise<RemoteServerStatus> {
  if (!isTauriRuntime()) {
    throw new Error("Remote server restart is only available in the desktop app");
  }
  return invoke<RemoteServerStatus>("remote_server_restart");
}

// ─── Prompt API ───

// Web fallback storage for prompts
const PROMPTS_STORAGE_KEY = "memory-forge.prompts";

function readWebPrompts(): PromptItem[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(PROMPTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeWebPrompts(prompts: PromptItem[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PROMPTS_STORAGE_KEY, JSON.stringify(prompts));
}

let webPromptId = Date.now();

export async function listPrompts(
  search?: string,
  tag?: string
): Promise<PromptItem[]> {
  if (!isTauriRuntime()) {
    let prompts = readWebPrompts();
    if (search) {
      const q = search.toLowerCase();
      prompts = prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.content.toLowerCase().includes(q)
      );
    }
    if (tag) {
      prompts = prompts.filter((p) =>
        p.tags.split(",").some((t) => t.trim() === tag)
      );
    }
    return prompts;
  }
  return invoke<PromptItem[]>("prompt_list", { search: search ?? null, tag: tag ?? null });
}

export async function createPrompt(
  input: PromptCreateInput
): Promise<PromptItem> {
  if (!isTauriRuntime()) {
    const prompts = readWebPrompts();
    const now = new Date().toISOString();
    const newPrompt: PromptItem = {
      id: ++webPromptId,
      name: input.name,
      content: input.content,
      tags: input.tags.join(","),
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    prompts.unshift(newPrompt);
    writeWebPrompts(prompts);
    return newPrompt;
  }
  return invoke<PromptItem>("prompt_create", { input });
}

export async function updatePrompt(
  id: number,
  input: PromptUpdateInput
): Promise<PromptItem> {
  if (!isTauriRuntime()) {
    const prompts = readWebPrompts();
    const idx = prompts.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error("Prompt not found");
    const updated = {
      ...prompts[idx],
      ...Object.fromEntries(
        Object.entries(input).filter(([_, v]) => v !== undefined)
      ),
      tags: input.tags ? input.tags.join(",") : prompts[idx].tags,
      updatedAt: new Date().toISOString(),
    } as PromptItem;
    prompts[idx] = updated;
    writeWebPrompts(prompts);
    return updated;
  }
  return invoke<PromptItem>("prompt_update", { id, input });
}

export async function deletePrompt(id: number): Promise<void> {
  if (!isTauriRuntime()) {
    const prompts = readWebPrompts().filter((p) => p.id !== id);
    writeWebPrompts(prompts);
    return;
  }
  return invoke("prompt_delete", { id });
}

export async function incrementPromptUse(
  id: number
): Promise<PromptItem> {
  if (!isTauriRuntime()) {
    const prompts = readWebPrompts();
    const idx = prompts.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error("Prompt not found");
    prompts[idx].useCount++;
    prompts[idx].updatedAt = new Date().toISOString();
    writeWebPrompts(prompts);
    return prompts[idx];
  }
  return invoke<PromptItem>("prompt_use", { id });
}

export async function exportPrompts(): Promise<PromptItem[]> {
  if (!isTauriRuntime()) return readWebPrompts();
  return invoke<PromptItem[]>("prompt_export");
}

export async function importPrompts(
  prompts: PromptCreateInput[]
): Promise<number> {
  if (!isTauriRuntime()) {
    const existing = readWebPrompts();
    let count = 0;
    for (const p of prompts) {
      const now = new Date().toISOString();
      existing.unshift({
        id: ++webPromptId,
        name: p.name,
        content: p.content,
        tags: p.tags.join(","),
        useCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      count++;
    }
    writeWebPrompts(existing);
    return count;
  }
  return invoke<number>("prompt_import", { prompts });
}

// ─── Session API ───

// In web-preview mode, sessions come from the Python backend via HTTP
// In Tauri mode, sessions come from Rust commands

function remoteDeviceId() {
  if (typeof window === "undefined") return "web-preview";
  const existing = window.localStorage.getItem(REMOTE_DEVICE_ID_KEY);
  if (existing) return existing;
  const value = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(REMOTE_DEVICE_ID_KEY, value);
  return value;
}

function captureRemoteAccessToken() {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const tokenFromHash = new URLSearchParams(hash).get("token")?.trim();
  if (tokenFromHash) {
    window.localStorage.setItem(REMOTE_ACCESS_TOKEN_KEY, tokenFromHash);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return tokenFromHash;
  }
  return window.localStorage.getItem(REMOTE_ACCESS_TOKEN_KEY);
}

export function hasRemoteAccessToken() {
  return Boolean(captureRemoteAccessToken());
}

export function setRemoteAccessToken(token: string) {
  if (typeof window === "undefined") return;
  const trimmed = token.trim();
  if (trimmed) window.localStorage.setItem(REMOTE_ACCESS_TOKEN_KEY, trimmed);
  else window.localStorage.removeItem(REMOTE_ACCESS_TOKEN_KEY);
}

function remoteMutationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `mutation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function assertRemoteCapability(capability: keyof RemoteCapabilities) {
  if (webRemoteCapabilities !== null && webRemoteCapabilities[capability] !== true) {
    throw new Error(`REMOTE_CAPABILITY_UNAVAILABLE:${capability}`);
  }
}

function rejectUnsupportedRemoteOperation(capability: string) {
  if (webRemoteCapabilities !== null) {
    throw new Error(`REMOTE_CAPABILITY_UNAVAILABLE:${capability}`);
  }
}

export function isRemoteCapabilityUnavailable(error: unknown) {
  return typeof error === "string"
    ? error.includes("REMOTE_CAPABILITY_UNAVAILABLE")
    : error instanceof Error && error.message.includes("REMOTE_CAPABILITY_UNAVAILABLE");
}

export interface StartEmbeddedTerminalRequest {
  terminalId: string;
  sessionKey: string;
  command: string;
  commandKind: "resume" | "fork" | "shell";
  cwd: string | null;
  cols: number;
  rows: number;
}

export interface EmbeddedTerminalStarted {
  terminalId: string;
  cwd: string;
  processId?: number | null;
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const accessToken = captureRemoteAccessToken();
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": remoteMutationId(),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...options?.headers,
    },
  });
  if (!response.ok) {
    type RemoteErrorDetail = { code?: string; message?: string; currentRevision?: string };
    let detail: RemoteErrorDetail | undefined;
    try {
      const body = (await response.json()) as { error?: RemoteErrorDetail };
      detail = body.error;
    } catch {
      // Fall back to the HTTP status when a proxy returns a non-JSON error page.
    }
    const error = new Error(
      detail?.code
        ? `${detail.code}: ${detail.message ?? `HTTP ${response.status}`}`
        : `HTTP ${response.status}`,
    ) as Error & { code?: string; currentRevision?: string };
    error.code = detail?.code;
    error.currentRevision = detail?.currentRevision;
    throw error;
  }
  const data = await response.json();
  return data.data ?? data;
}

export const api = {
  // Dashboard
  async getDashboard(): Promise<DashboardSummary> {
    if (isTauriRuntime()) {
      return invoke<DashboardSummary>("dashboard_summary");
    }
    return fetchJSON<DashboardSummary>(`${API_BASE}/dashboard`);
  },

  // Sessions
  async getSessions(platform: string, q: string = "", limit?: number, offset?: number, showArchived?: boolean): Promise<SessionListResult> {
    if (isTauriRuntime()) {
      return invoke<SessionListResult>("session_list", {
        platform,
        query: q || null,
        limit: limit ?? null,
        offset: offset ?? null,
        showArchived: showArchived ?? false,
      });
    }
    const params = new URLSearchParams({ platform });
    if (q) params.set("q", q);
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    if (showArchived !== undefined) params.set("showArchived", String(showArchived));
    return fetchJSON<SessionListResult>(`${API_BASE}/sessions?${params}`);
  },

  async getSessionDetail(platform: string, sessionKey: string): Promise<SessionDetail> {
    if (isTauriRuntime()) {
      return invoke<SessionDetail>("session_detail", { platform, sessionKey });
    }
    const params = new URLSearchParams({ platform, sessionKey });
    return fetchJSON<SessionDetail>(`${API_BASE}/session-detail?${params}`);
  },

  async getExecutionOutput(platform: string, sessionKey: string, editTarget: string): Promise<string> {
    if (isTauriRuntime()) {
      return invoke<string>("session_execution_output", { platform, sessionKey, editTarget });
    }
    throw new Error("Execution output loading is not supported in web preview");
  },

  async getExecutionOutputs(platform: string, sessionKey: string, editTargets: string[]): Promise<Record<string, string>> {
    if (isTauriRuntime()) {
      return invoke<Record<string, string>>("session_execution_outputs", { platform, sessionKey, editTargets });
    }
    throw new Error("Execution output loading is not supported in web preview");
  },

  async launchSessionTerminal(command: string, cwd?: string | null): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("launch_session_terminal", { command, cwd: cwd ?? null });
    }
    throw new Error("Terminal launch is not supported in web preview");
  },

  async startEmbeddedTerminal(
    request: StartEmbeddedTerminalRequest
  ): Promise<EmbeddedTerminalStarted> {
    if (isTauriRuntime()) {
      return invoke<EmbeddedTerminalStarted>("start_embedded_terminal", { request });
    }
    throw new Error("Embedded terminals are only available in the desktop app");
  },

  async writeEmbeddedTerminal(
    terminalId: string,
    data: string,
    binary = false
  ): Promise<void> {
    if (isTauriRuntime()) {
      return invoke<void>("write_embedded_terminal", { terminalId, data, binary });
    }
    throw new Error("Embedded terminals are only available in the desktop app");
  },

  async resizeEmbeddedTerminal(
    terminalId: string,
    cols: number,
    rows: number
  ): Promise<void> {
    if (isTauriRuntime()) {
      return invoke<void>("resize_embedded_terminal", { terminalId, cols, rows });
    }
    throw new Error("Embedded terminals are only available in the desktop app");
  },

  async stopEmbeddedTerminal(terminalId: string, force: boolean): Promise<void> {
    if (isTauriRuntime()) {
      return invoke<void>("stop_embedded_terminal", { terminalId, force });
    }
    throw new Error("Embedded terminals are only available in the desktop app");
  },

  async listEditorTargets(): Promise<EditorTarget[]> {
    if (isTauriRuntime()) {
      return invoke<EditorTarget[]>("list_editor_targets");
    }
    return [];
  },

  async openPathInEditor(editorId: string, path: string): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("open_path_in_editor", { editorId, path });
    }
    throw new Error("Opening editors is not supported in web preview");
  },

  async setAlias(platform: string, sessionKey: string, title: string) {
    if (isTauriRuntime()) {
      return invoke("session_set_alias", { platform, sessionKey, title });
    }
    rejectUnsupportedRemoteOperation("sessionMetadata");
    const encodedKey = encodeURIComponent(sessionKey);
    return fetchJSON(`${API_BASE}/platforms/${platform}/sessions/${encodedKey}/alias`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  },

  async editMessage(platform: string, messageId: string, content: string, sessionKey: string, expectedRevision: string) {
    if (isTauriRuntime()) {
      return invoke("session_edit_message", { platform, messageId, content, sessionKey, expectedRevision });
    }
    assertRemoteCapability("sessionEdit");
    const mutation: EditMessageMutation = {
      deviceId: remoteDeviceId(),
      mutationId: remoteMutationId(),
      platform,
      sessionKey,
      messageId,
      content,
      expectedRevision,
    };
    return fetchJSON(`${API_BASE}/mutations/session-edit`, {
      method: "POST",
      body: JSON.stringify(mutation),
    });
  },

  async getEditLog(platform: string, sessionKey: string): Promise<EditLogEntry[]> {
    if (isTauriRuntime()) {
      return invoke<EditLogEntry[]>("session_edit_log", { platform, sessionKey });
    }
    const params = new URLSearchParams({ platform, sessionKey });
    return fetchJSON<EditLogEntry[]>(`${API_BASE}/edit-log?${params}`);
  },

  async restoreMessage(platform: string, editLogId: number, sessionKey: string, expectedRevision: string) {
    if (isTauriRuntime()) {
      return invoke("session_restore_message", { platform, editLogId, sessionKey, expectedRevision });
    }
    assertRemoteCapability("sessionEdit");
    const mutation: RestoreMessageMutation = {
      deviceId: remoteDeviceId(),
      mutationId: remoteMutationId(),
      platform,
      sessionKey,
      editLogId,
      expectedRevision,
    };
    return fetchJSON(`${API_BASE}/mutations/session-restore`, {
      method: "POST",
      body: JSON.stringify(mutation),
    });
  },

  async deleteEditLog(platform: string, editLogId: number, sessionKey: string): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("session_delete_edit_log", { platform, editLogId, sessionKey });
    }
    throw new Error("Edit log deletion is not supported in web preview");
  },

  async clearEditLogs(platform: string, sessionKey: string): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("session_clear_edit_logs", { platform, sessionKey });
    }
    throw new Error("Edit log deletion is not supported in web preview");
  },

  async exportRawJsonl(platform: string, sessionKey: string, outputPath: string): Promise<RawJsonlExportResult> {
    if (isTauriRuntime()) {
      return invoke<RawJsonlExportResult>("session_export_raw_jsonl", { platform, sessionKey, outputPath });
    }
    throw new Error("Raw JSONL export is only available in the desktop app");
  },

  async probeJsonlImport(platform: string, inputPath: string): Promise<RawJsonlImportPreview> {
    if (isTauriRuntime()) {
      return invoke<RawJsonlImportPreview>("session_probe_jsonl_import", { platform, inputPath });
    }
    throw new Error("Raw JSONL import is only available in the desktop app");
  },

  async importRawJsonl(platform: string, inputPath: string): Promise<RawJsonlImportResult> {
    if (isTauriRuntime()) {
      return invoke<RawJsonlImportResult>("session_import_raw_jsonl", {
        platform,
        inputPath,
        conflictPolicy: "rename",
      });
    }
    throw new Error("Raw JSONL import is only available in the desktop app");
  },

  async toggleFlag(platform: string, sessionKey: string, flag: string): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("session_toggle_flag", { platform, sessionKey, flag });
    }
    rejectUnsupportedRemoteOperation("sessionMetadata");
    return false;
  },

  async batchSetFlag(platform: string, sessionKeys: string[], flag: string, set: boolean): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("session_batch_set_flag", { platform, sessionKeys, flag, set });
    }
    rejectUnsupportedRemoteOperation("sessionMetadata");
    return 0;
  },

  async checkUpdate(): Promise<UpdateInfo> {
    if (isTauriRuntime()) {
      return invoke<UpdateInfo>("check_update");
    }
    return {
      hasUpdate: false,
      currentVersion: "3.0.0",
      latestVersion: "3.0.0",
      releaseUrl: "",
      releaseNotes: "",
      publishedAt: "",
    };
  },
};

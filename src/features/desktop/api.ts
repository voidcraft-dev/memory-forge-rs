import { invoke } from "@tauri-apps/api/core";
import type {
  DashboardSummary,
  DesktopSettingsPatch,
  DesktopSnapshot,
  EditLogEntry,
  PromptCreateInput,
  PromptItem,
  PromptUpdateInput,
  Session,
  SessionDetail,
  SessionListResult,
  UpdateInfo,
} from "@/features/desktop/types";

const STORAGE_KEY = "memory-forge.snapshot";

const defaultSettings = {
  theme: "porcelain" as const,
  locale: "zh-CN" as const,
  closeToTrayOnClose: true,
  launchOnStartup: false,
  reduceMotion: false,
  claudeHome: null,
  codexHome: null,
  opencodePath: null,
};

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function defaultWebSnapshot(): DesktopSnapshot {
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

function readWebSnapshot() {
  if (typeof window === "undefined") return defaultWebSnapshot();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultWebSnapshot();
  try {
    return JSON.parse(raw) as DesktopSnapshot;
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
    const snapshot = readWebSnapshot();
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

const API_BASE = "/api";

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data.data ?? data;
}

export const api = {
  // Dashboard
  async getDashboard(): Promise<DashboardSummary> {
    if (isTauriRuntime()) {
      return invoke<DashboardSummary>("dashboard_summary");
    }
    return fetchJSON<DashboardSummary>(`${API_BASE}/dashboard/summary`);
  },

  // Sessions
  async getSessions(platform: string, q: string = "", limit?: number, offset?: number): Promise<SessionListResult> {
    if (isTauriRuntime()) {
      return invoke<SessionListResult>("session_list", {
        platform,
        query: q || null,
        limit: limit ?? null,
        offset: offset ?? null,
      });
    }
    const params = q ? `?q=${encodeURIComponent(q)}` : "";
    const items = await fetchJSON<Session[]>(`${API_BASE}/platforms/${platform}/sessions${params}`);
    return { total: items.length, items };
  },

  async getSessionDetail(platform: string, sessionKey: string): Promise<SessionDetail> {
    if (isTauriRuntime()) {
      return invoke<SessionDetail>("session_detail", { platform, sessionKey });
    }
    const encodedKey = encodeURIComponent(sessionKey);
    const data = await fetchJSON<{ detail: SessionDetail }>(
      `${API_BASE}/platforms/${platform}/session-detail/${encodedKey}`
    );
    return data.detail ?? data;
  },

  async setAlias(platform: string, sessionKey: string, title: string) {
    if (isTauriRuntime()) {
      return invoke("session_set_alias", { platform, sessionKey, title });
    }
    const encodedKey = encodeURIComponent(sessionKey);
    return fetchJSON(`${API_BASE}/platforms/${platform}/sessions/${encodedKey}/alias`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  },

  async editMessage(platform: string, messageId: string, content: string, sessionKey: string) {
    if (isTauriRuntime()) {
      return invoke("session_edit_message", { platform, messageId, content, sessionKey });
    }
    return fetchJSON(`${API_BASE}/platforms/${platform}/messages/${encodeURIComponent(messageId)}/edit`, {
      method: "POST",
      body: JSON.stringify({ content, sessionKey }),
    });
  },

  async getEditLog(platform: string, sessionKey: string): Promise<EditLogEntry[]> {
    if (isTauriRuntime()) {
      return invoke<EditLogEntry[]>("session_edit_log", { platform, sessionKey });
    }
    const encodedKey = encodeURIComponent(sessionKey);
    return fetchJSON<EditLogEntry[]>(`${API_BASE}/platforms/${platform}/sessions/${encodedKey}/edit-log`);
  },

  async restoreMessage(platform: string, editLogId: number, sessionKey: string) {
    if (isTauriRuntime()) {
      return invoke("session_restore_message", { platform, editLogId, sessionKey });
    }
    throw new Error("Restore not supported in web preview");
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

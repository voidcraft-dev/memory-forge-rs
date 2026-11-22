import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { loadDesktopSnapshot, updateDesktopSettings } from "@/features/desktop/api";
import { getThemeSpec, resolveHudTheme } from "@/features/desktop/catalog";
import { type MessageKey, translate } from "@/features/desktop/i18n";
import type {
  AppAction,
  AppState,
  DesktopSettingsPatch,
  DesktopSnapshot,
  EditingBlock,
  LocaleId,
  OpenSessionTab,
  Session,
  ThemeId,
} from "@/features/desktop/types";

const OPEN_TABS_STORAGE_KEY = "memory-forge.open-tabs";
const MAX_OPEN_TABS = 12;

export function sessionTabKey(platform: string, sessionKey: string): string {
  return `${platform}::${sessionKey}`;
}

function orderPinnedFirst(tabs: OpenSessionTab[]): OpenSessionTab[] {
  const pinned = tabs.filter((t) => t.pinned);
  const rest = tabs.filter((t) => !t.pinned);
  return [...pinned, ...rest];
}

function capTabs(
  tabs: OpenSessionTab[],
  protectedKeys: Set<string>
): OpenSessionTab[] {
  const next = [...tabs];
  while (next.length > MAX_OPEN_TABS) {
    const evictIdx = next.findIndex(
      (t) =>
        !(t.pinned || protectedKeys.has(sessionTabKey(t.platform, t.sessionKey)))
    );
    if (evictIdx < 0) break;
    next.splice(evictIdx, 1);
  }
  return next;
}

function loadInitialTabs(): OpenSessionTab[] {
  try {
    const raw = localStorage.getItem(OPEN_TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (x): x is OpenSessionTab =>
        Boolean(x && typeof x.platform === "string" && typeof x.sessionKey === "string")
    );
    return capTabs(orderPinnedFirst(valid), new Set());
  } catch {
    return [];
  }
}

function saveTabsToStorage(tabs: OpenSessionTab[]) {
  try {
    localStorage.setItem(OPEN_TABS_STORAGE_KEY, JSON.stringify(orderPinnedFirst(tabs)));
  } catch {}
}

const initialAppState: AppState = {
  currentPlatform: "all",
  selectedSessionPlatform: null,
  workspaceFilter: "all",
  sessions: [],
  selectedSessionKey: null,
  sessionDetail: null,
  dashboard: null,
  roleFilter: "all",
  searchQuery: "",
  editingBlock: null,
  editDrafts: {},
  editLog: [],
  showEditLog: false,
  sessionStatus: null,
  mobileSidebarOpen: false,
  showArchived: false,
  ptyBayOpen: false,
  ptyBayMaximized: false,
  commandPaletteOpen: false,
  railCollapsed: false,
  railHoverPeek: false,
  locateRequestNonce: 0,
  openSessionTabs: loadInitialTabs(),
};

function updateSessionTree(
  sessions: Session[],
  sessionKey: string,
  updates: Partial<Session>
): Session[] {
  return sessions.map((session) => {
    const updated =
      session.sessionKey === sessionKey ? { ...session, ...updates } : session;
    const children = updated.agentGroup?.children;
    if (!children?.length) return updated;
    return {
      ...updated,
      agentGroup: {
        ...updated.agentGroup,
        children: updateSessionTree(children, sessionKey, updates),
      },
    };
  });
}

export function isDirtyEdit(edit: EditingBlock | null): edit is EditingBlock {
  return Boolean(edit && edit.content !== edit.originalContent);
}

function activeTabKey(state: AppState): string | null {
  const platform = state.selectedSessionPlatform ?? state.sessionDetail?.platform;
  return platform && state.selectedSessionKey
    ? sessionTabKey(platform, state.selectedSessionKey)
    : null;
}

function protectedTabKeys(state: AppState, ...extra: Array<string | null>) {
  const keys = new Set(Object.keys(state.editDrafts));
  for (const key of [activeTabKey(state), ...extra]) {
    if (key) keys.add(key);
  }
  return keys;
}

function switchSelection(
  state: AppState,
  platform: string | null,
  sessionKey: string | null
): Pick<
  AppState,
  "selectedSessionPlatform" | "selectedSessionKey" | "editingBlock" | "editDrafts"
> {
  const fromKey = activeTabKey(state);
  const toKey = platform && sessionKey ? sessionTabKey(platform, sessionKey) : null;
  if (fromKey === toKey) {
    return {
      selectedSessionPlatform: platform,
      selectedSessionKey: sessionKey,
      editingBlock: state.editingBlock,
      editDrafts: state.editDrafts,
    };
  }
  const editDrafts = { ...state.editDrafts };
  const current = state.editingBlock;
  if (isDirtyEdit(current)) {
    const draftKey =
      current.platform && current.sessionKey
        ? sessionTabKey(current.platform, current.sessionKey)
        : fromKey;
    if (draftKey) editDrafts[draftKey] = current;
  }
  const restored = toKey ? (editDrafts[toKey] ?? null) : null;
  if (toKey) delete editDrafts[toKey];
  return {
    selectedSessionPlatform: platform,
    selectedSessionKey: sessionKey,
    editingBlock: restored,
    editDrafts,
  };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "setCurrentPlatform": {
      if (state.currentPlatform === action.payload) return state;
      return {
        ...state,
        currentPlatform: action.payload,
        sessionStatus: null,
      };
    }
    case "setSelectedSessionPlatform":
      return { ...state, selectedSessionPlatform: action.payload };
    case "setWorkspaceFilter":
      return { ...state, workspaceFilter: action.payload };
    case "setSessions":
      return { ...state, sessions: action.payload };
    case "updateSession":
      return {
        ...state,
        sessions: updateSessionTree(
          state.sessions,
          action.payload.sessionKey,
          action.payload.updates
        ),
      };
    case "setSelectedSessionKey":
      return {
        ...state,
        ...switchSelection(
          state,
          action.payload ? state.selectedSessionPlatform : null,
          action.payload
        ),
        sessionStatus: null,
      };
    case "selectSession": {
      const { platform, sessionKey } = action.payload;
      const key = sessionTabKey(platform, sessionKey);
      const switched = switchSelection(state, platform, sessionKey);
      const exists = state.openSessionTabs.some(
        (t) => sessionTabKey(t.platform, t.sessionKey) === key
      );
      let nextTabs = state.openSessionTabs;
      if (!exists) {
        const found = state.sessions.find(
          (s) => s.platform === platform && s.sessionKey === sessionKey
        );
        const fallbackTitle =
          found?.aliasTitle || found?.displayTitle || sessionKey.slice(0, 8);
        nextTabs = capTabs(
          [...state.openSessionTabs, { platform, sessionKey, title: fallbackTitle }],
          new Set([key, ...Object.keys(switched.editDrafts)])
        );
        saveTabsToStorage(nextTabs);
      }
      return {
        ...state,
        ...switched,
        sessionStatus: null,
        railHoverPeek: false,
        openSessionTabs: nextTabs,
      };
    }
    case "setSessionDetail": {
      const detail = action.payload;
      if (!detail) return { ...state, sessionDetail: null };
      if (detail.sessionKey !== state.selectedSessionKey) return state;
      const bestTitle = detail.aliasTitle || detail.title || detail.sessionId;
      const idx = state.openSessionTabs.findIndex(
        (t) =>
          t.platform === detail.platform && t.sessionKey === detail.sessionKey
      );
      if (idx < 0) return { ...state, sessionDetail: detail };
      const nextTabs = state.openSessionTabs.map((t, i) =>
        i === idx ? { ...t, title: bestTitle, cwd: detail.cwd } : t
      );
      saveTabsToStorage(nextTabs);
      return { ...state, sessionDetail: detail, openSessionTabs: nextTabs };
    }
    case "setDashboard":
      return { ...state, dashboard: action.payload };
    case "setRoleFilter":
      return { ...state, roleFilter: action.payload };
    case "setSearchQuery":
      return { ...state, searchQuery: action.payload };
    case "setEditingBlock":
      return { ...state, editingBlock: action.payload };
    case "clearEditingBlock": {
      const current = state.editingBlock;
      if (
        !current ||
        current.id !== action.payload.id ||
        (action.payload.sessionKey &&
          current.sessionKey &&
          current.sessionKey !== action.payload.sessionKey)
      ) {
        return state;
      }
      return { ...state, editingBlock: null };
    }
    case "setEditLog":
      return { ...state, editLog: action.payload };
    case "setShowEditLog":
      return { ...state, showEditLog: action.payload };
    case "setSessionStatus":
      return { ...state, sessionStatus: action.payload };
    case "setMobileSidebarOpen":
      return { ...state, mobileSidebarOpen: action.payload };
    case "setShowArchived":
      return {
        ...state,
        ...switchSelection(state, null, null),
        showArchived: action.payload,
        sessionDetail: null,
      };
    case "setPtyBayOpen":
      return {
        ...state,
        ptyBayOpen: action.payload,
        ptyBayMaximized: action.payload ? state.ptyBayMaximized : false,
      };
    case "setPtyBayMaximized":
      return {
        ...state,
        ptyBayOpen: action.payload ? true : state.ptyBayOpen,
        ptyBayMaximized: action.payload,
      };
    case "setCommandPaletteOpen":
      return { ...state, commandPaletteOpen: action.payload };
    case "setRailCollapsed":
      return {
        ...state,
        railCollapsed: action.payload,
        railHoverPeek: false,
      };
    case "setRailHoverPeek":
      return {
        ...state,
        railHoverPeek: state.railCollapsed ? action.payload : false,
      };
    case "requestLocateSession":
      return {
        ...state,
        railCollapsed: false,
        railHoverPeek: false,
        locateRequestNonce: state.locateRequestNonce + 1,
      };
    case "upsertSessionTab": {
      const exists = state.openSessionTabs.some(
        (t) =>
          t.platform === action.payload.platform &&
          t.sessionKey === action.payload.sessionKey
      );
      const nextTabs = exists
        ? state.openSessionTabs.map((t) =>
            t.platform === action.payload.platform &&
            t.sessionKey === action.payload.sessionKey
              ? { ...t, title: action.payload.title }
              : t
          )
        : capTabs(
            [...state.openSessionTabs, action.payload],
            protectedTabKeys(
              state,
              sessionTabKey(action.payload.platform, action.payload.sessionKey)
            )
          );
      saveTabsToStorage(nextTabs);
      return { ...state, openSessionTabs: nextTabs };
    }
    case "togglePinSessionTab": {
      const nextTabs = orderPinnedFirst(
        state.openSessionTabs.map((t) =>
          t.platform === action.payload.platform &&
          t.sessionKey === action.payload.sessionKey
            ? { ...t, pinned: !t.pinned }
            : t
        )
      );
      saveTabsToStorage(nextTabs);
      return { ...state, openSessionTabs: nextTabs };
    }
    case "closeSessionTab": {
      const idx = state.openSessionTabs.findIndex(
        (t) =>
          t.platform === action.payload.platform &&
          t.sessionKey === action.payload.sessionKey
      );
      const nextTabs = state.openSessionTabs.filter(
        (t) =>
          !(
            t.platform === action.payload.platform &&
            t.sessionKey === action.payload.sessionKey
          )
      );
      saveTabsToStorage(nextTabs);
      const wasActive =
        state.selectedSessionPlatform === action.payload.platform &&
        state.selectedSessionKey === action.payload.sessionKey;
      if (!wasActive) return { ...state, openSessionTabs: nextTabs };
      const fallback = nextTabs[Math.min(idx, nextTabs.length - 1)] ?? null;
      return {
        ...state,
        ...switchSelection(
          state,
          fallback?.platform ?? null,
          fallback?.sessionKey ?? null
        ),
        openSessionTabs: nextTabs,
        sessionDetail: fallback ? state.sessionDetail : null,
      };
    }
    case "closeOtherSessionTabs": {
      const nextTabs = state.openSessionTabs.filter(
        (t) =>
          t.pinned ||
          (t.platform === action.payload.platform &&
            t.sessionKey === action.payload.sessionKey)
      );
      saveTabsToStorage(nextTabs);
      return {
        ...state,
        ...switchSelection(
          state,
          action.payload.platform,
          action.payload.sessionKey
        ),
        openSessionTabs: nextTabs,
      };
    }
    case "closeRightSessionTabs": {
      const pivot = state.openSessionTabs.findIndex(
        (t) =>
          t.platform === action.payload.platform &&
          t.sessionKey === action.payload.sessionKey
      );
      if (pivot < 0) return state;
      const nextTabs = state.openSessionTabs.filter(
        (t, idx) => idx <= pivot || t.pinned
      );
      saveTabsToStorage(nextTabs);
      const activeStillOpen = nextTabs.some(
        (t) =>
          t.platform === state.selectedSessionPlatform &&
          t.sessionKey === state.selectedSessionKey
      );
      return activeStillOpen
        ? { ...state, openSessionTabs: nextTabs }
        : {
            ...state,
            ...switchSelection(
              state,
              action.payload.platform,
              action.payload.sessionKey
            ),
            openSessionTabs: nextTabs,
          };
    }
    default:
      return state;
  }
}

type DesktopContextValue = {
  snapshot: DesktopSnapshot | null;
  resolvedTheme: "chrono" | "braun";
  loading: boolean;
  saving: boolean;
  notice: string | null;
  error: string | null;
  settings: DesktopSnapshot["settings"] | null;
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  refresh: () => Promise<void>;
  updateSettings: (patch: DesktopSettingsPatch) => Promise<void>;
  setTheme: (theme: ThemeId) => Promise<void>;
  toggleTheme: () => Promise<void>;
  setLocale: (locale: LocaleId) => Promise<void>;
  setCloseToTrayOnClose: (enabled: boolean) => Promise<void>;
  setLaunchOnStartup: (enabled: boolean) => Promise<void>;
  setReduceMotion: (enabled: boolean) => Promise<void>;
};

const GLOBAL_DESKTOP_CTX_KEY = "__MEMORY_FORGE_DESKTOP_CTX__";
const globalStore = globalThis as unknown as Record<
  string,
  React.Context<DesktopContextValue | null> | undefined
>;
const DesktopContext =
  globalStore[GLOBAL_DESKTOP_CTX_KEY] ??
  (globalStore[GLOBAL_DESKTOP_CTX_KEY] =
    createContext<DesktopContextValue | null>(null));

export function DesktopProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const noticeTimerRef = useRef<number | null>(null);

  const locale = snapshot?.settings.locale ?? "zh-CN";
  const resolvedTheme = resolveHudTheme(snapshot?.settings.theme);

  const t = useMemo(
    () => (key: MessageKey, params?: Record<string, string | number>) => {
      let msg = translate(locale, key);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          msg = msg.replace(`{${k}}`, String(v));
        }
      }
      return msg;
    },
    [locale]
  );

  const settings = snapshot?.settings ?? null;

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.reduceMotion = String(
      snapshot?.settings.reduceMotion ?? false
    );
    document.documentElement.lang = locale;
    document.documentElement.style.colorScheme = getThemeSpec(resolvedTheme).mode;
  }, [locale, resolvedTheme, snapshot?.settings.reduceMotion]);

  const setTimedNotice = (value: string | null) => {
    setNotice(value);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    if (!value) return;
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2200);
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadDesktopSnapshot();
      setSnapshot(next);
    } catch (refreshError) {
      const message =
        refreshError instanceof Error ? refreshError.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const updateSettings = async (patch: DesktopSettingsPatch) => {
    setSaving(true);
    setError(null);
    try {
      const next = await updateDesktopSettings(patch);
      setSnapshot(next);
      setTimedNotice(translate(next.settings.locale, "saveSuccess"));
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : "Unknown save error";
      setError(message);
      setTimedNotice(null);
    } finally {
      setSaving(false);
    }
  };

  const value = useMemo<DesktopContextValue>(
    () => ({
      snapshot,
      resolvedTheme,
      loading,
      saving,
      notice,
      error,
      settings,
      state,
      dispatch,
      t,
      refresh,
      updateSettings,
      setTheme: async (theme) => updateSettings({ theme }),
      toggleTheme: async () =>
        updateSettings({ theme: resolvedTheme === "chrono" ? "braun" : "chrono" }),
      setLocale: async (nextLocale) => updateSettings({ locale: nextLocale }),
      setCloseToTrayOnClose: async (enabled) =>
        updateSettings({ closeToTrayOnClose: enabled }),
      setLaunchOnStartup: async (enabled) =>
        updateSettings({ launchOnStartup: enabled }),
      setReduceMotion: async (enabled) =>
        updateSettings({ reduceMotion: enabled }),
    }),
    [snapshot, resolvedTheme, loading, saving, notice, error, settings, state, t]
  );

  return (
    <DesktopContext.Provider value={value}>{children}</DesktopContext.Provider>
  );
}

export function useDesktop() {
  const context = useContext(DesktopContext);
  if (!context) {
    throw new Error("useDesktop must be used inside DesktopProvider");
  }
  return context;
}

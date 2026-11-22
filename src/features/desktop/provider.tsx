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
  LocaleId,
  Session,
  ThemeId,
} from "@/features/desktop/types";

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
  editLog: [],
  showEditLog: false,
  sessionStatus: null,
  mobileSidebarOpen: false,
  showArchived: false,
  ptyBayOpen: false,
  ptyBayMaximized: false,
  commandPaletteOpen: false,
  railCollapsed: false,
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

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "setCurrentPlatform": {
      if (state.currentPlatform === action.payload) return state;
      return {
        ...state,
        currentPlatform: action.payload,
        selectedSessionKey: null,
        selectedSessionPlatform: null,
        sessionDetail: null,
        editLog: [],
        showEditLog: false,
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
        selectedSessionKey: action.payload,
        sessionStatus: null,
      };
    case "selectSession":
      return {
        ...state,
        selectedSessionPlatform: action.payload.platform,
        selectedSessionKey: action.payload.sessionKey,
        editingBlock: null,
        sessionStatus: null,
      };
    case "setSessionDetail":
      return { ...state, sessionDetail: action.payload };
    case "setDashboard":
      return { ...state, dashboard: action.payload };
    case "setRoleFilter":
      return { ...state, roleFilter: action.payload };
    case "setSearchQuery":
      return { ...state, searchQuery: action.payload };
    case "setEditingBlock":
      return { ...state, editingBlock: action.payload };
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
        showArchived: action.payload,
        selectedSessionKey: null,
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
      return { ...state, railCollapsed: action.payload };
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

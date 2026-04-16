import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getThemeSpec } from "@/features/desktop/catalog";
import { loadDesktopSnapshot, updateDesktopSettings } from "@/features/desktop/api";
import { translate, type MessageKey } from "@/features/desktop/i18n";
import type {
  AppAction,
  AppState,
  DesktopSettingsPatch,
  DesktopSnapshot,
  LocaleId,
  ThemeId,
} from "@/features/desktop/types";

const initialAppState: AppState = {
  currentPlatform: "dashboard",
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
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "setCurrentPlatform":
      return {
        ...state,
        currentPlatform: action.payload,
        selectedSessionKey: null,
        sessionDetail: null,
        editLog: [],
        showEditLog: false,
        sessionStatus: null,
      };
    case "setSessions":
      return { ...state, sessions: action.payload };
    case "updateSession":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.sessionKey === action.payload.sessionKey ? { ...s, ...action.payload.updates } : s
        ),
      };
    case "setSelectedSessionKey":
      return { ...state, selectedSessionKey: action.payload, sessionStatus: null };
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
      return { ...state, showArchived: action.payload, selectedSessionKey: null, sessionDetail: null };
    default:
      return state;
  }
}

type DesktopContextValue = {
  snapshot: DesktopSnapshot | null;
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
  setLocale: (locale: LocaleId) => Promise<void>;
  setCloseToTrayOnClose: (enabled: boolean) => Promise<void>;
  setLaunchOnStartup: (enabled: boolean) => Promise<void>;
  setReduceMotion: (enabled: boolean) => Promise<void>;
};

const DesktopContext = createContext<DesktopContextValue | null>(null);

export function DesktopProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const noticeTimerRef = useRef<number | null>(null);

  const locale = snapshot?.settings.locale ?? "zh-CN";
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
    [locale],
  );

  const settings = snapshot?.settings ?? null;

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || !snapshot) return;
    document.documentElement.dataset.theme = snapshot.settings.theme;
    document.documentElement.dataset.reduceMotion = String(snapshot.settings.reduceMotion);
    document.documentElement.lang = snapshot.settings.locale;
    document.documentElement.style.colorScheme = getThemeSpec(snapshot.settings.theme).mode;
  }, [snapshot]);

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
      const message = refreshError instanceof Error ? refreshError.message : "Unknown error";
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
      const message = saveError instanceof Error ? saveError.message : "Unknown save error";
      setError(message);
      setTimedNotice(null);
    } finally {
      setSaving(false);
    }
  };

  const value = useMemo<DesktopContextValue>(
    () => ({
      snapshot,
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
      setLocale: async (nextLocale) => updateSettings({ locale: nextLocale }),
      setCloseToTrayOnClose: async (enabled) => updateSettings({ closeToTrayOnClose: enabled }),
      setLaunchOnStartup: async (enabled) => updateSettings({ launchOnStartup: enabled }),
      setReduceMotion: async (enabled) => updateSettings({ reduceMotion: enabled }),
    }),
    [snapshot, loading, saving, notice, error, state, t],
  );

  return (
    <DesktopContext.Provider value={value}>{children}</DesktopContext.Provider>
  );
}

export function useDesktop() {
  const context = useContext(DesktopContext);
  if (!context) throw new Error("useDesktop must be used inside DesktopProvider");
  return context;
}

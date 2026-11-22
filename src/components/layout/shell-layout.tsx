import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowRightToLine,
  BookOpen,
  ChevronUp,
  Copy,
  ExternalLink,
  Folder,
  LayoutGrid,
  LocateFixed,
  Maximize2,
  Minimize2,
  Minus,
  Moon,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RotateCw,
  Scissors,
  Search,
  Settings,
  Square,
  Sun,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { FloatingMenu } from "@/components/ui/floating-menu";
import { api } from "@/features/desktop/api";
import { isDirtyEdit, useDesktop } from "@/features/desktop/provider";
import { hasBackupWrite } from "@/features/desktop/write-safety";
import type {
  OpenSessionTab,
  Session,
  TimelineBlock,
} from "@/features/desktop/types";
import {
  cleanHumanPreview,
  isUuidLikeTitle,
  PlatformMark,
} from "@/features/session/session-list";
import { EmbeddedTerminalPanel } from "@/features/terminal/embedded-terminal-panel";
import { NewSessionDialog } from "@/features/terminal/new-session-dialog";
import { useTerminal } from "@/features/terminal/terminal-context";
import { terminalTheme } from "@/features/terminal/terminal-theme";
import type { EmbeddedTerminalSession } from "@/features/terminal/terminal-types";
import { TerminalViewport } from "@/features/terminal/terminal-viewport";
import { cn } from "@/lib/utils";

const ACTIVE_PTY_STATUSES = new Set(["starting", "running", "stopping"]);
const IS_MACOS =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
const NON_PLATFORM_ROUTES = new Set([
  "radar",
  "dashboard",
  "prompts",
  "settings",
  "about",
  "terminal-sessions",
]);

export function estimateBlockTokens(block: TimelineBlock): number {
  let chars = block.content?.length ?? 0;
  if (block.toolCalls) {
    for (const tc of block.toolCalls) {
      chars +=
        (tc.input?.length ?? 0) +
        (tc.output?.length ?? 0) +
        (tc.error?.length ?? 0);
    }
  }
  return Math.max(12, Math.ceil(chars / 3.5));
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function normalizeCleanPath(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^\\\\\?\\/, "")
    .replace(/^\/\/\?\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return cleaned.replace(/^([a-z]):\//, (_, drv: string) => `${drv.toUpperCase()}:/`);
}

export function formatWorkspaceShortName(cwd: string): string {
  const normalized = normalizeCleanPath(cwd);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] || normalized || cwd;
}

function formatPtyTabTitle(title: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(title)) {
    return title.split("-")[0];
  }
  return title;
}

export default function ShellLayout() {
  const {
    snapshot,
    resolvedTheme,
    toggleTheme,
    setLocale,
    notice,
    error,
    state,
    dispatch,
    t,
  } = useDesktop();
  const {
    terminals,
    activeTerminalId,
    setActiveTerminal,
    startTerminal,
    restartTerminal,
    stopTerminal,
    closeTerminal,
    renameTerminal,
  } = useTerminal();
  const navigate = useNavigate();
  const location = useLocation();
  const { confirm, dialogProps } = useConfirmDialog();

  const [hasUpdate, setHasUpdate] = useState(false);
  const [newPtyOpen, setNewPtyOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [editingPtyId, setEditingPtyId] = useState<string | null>(null);
  const [editingPtyTitle, setEditingPtyTitle] = useState("");
  const [ptyCtxMenu, setPtyCtxMenu] = useState<{
    x: number;
    y: number;
    term: EmbeddedTerminalSession;
  } | null>(null);
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    tab: OpenSessionTab;
  } | null>(null);
  const [renamingTabKey, setRenamingTabKey] = useState<string | null>(null);
  const [renamingTabDraft, setRenamingTabDraft] = useState("");
  const [isWinMaximized, setIsWinMaximized] = useState(false);
  const [ptyHeight, setPtyHeight] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("memory-forge.pty-height"));
      return Number.isFinite(saved) && saved >= 110 ? saved : 230;
    } catch {
      return 230;
    }
  });
  const [isResizingPty, setIsResizingPty] = useState(false);
  const [ptyNotice, setPtyNotice] = useState<string | null>(null);

  const cmdInputRef = useRef<HTMLInputElement>(null);
  const isTauriApp = isTauri();

  const pathSeg = location.pathname.replace(/^\/+/, "").split("/")[0] || "";
  const isWorkbench = !NON_PLATFORM_ROUTES.has(pathSeg);
  const isRadar = pathSeg === "radar" || pathSeg === "dashboard";
  const isArsenal = pathSeg === "prompts";
  const isConfig = pathSeg === "settings" || pathSeg === "about";

  // Sync window maximize state for frameless caption button icon
  useEffect(() => {
    if (!isTauriApp) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .isMaximized()
      .then(setIsWinMaximized)
      .catch(() => {});
    void win
      .onResized(async () => {
        try {
          setIsWinMaximized(await win.isMaximized());
        } catch {
          // ignore
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [isTauriApp]);

  // Preload dashboard summary once snapshot is ready
  useEffect(() => {
    if (!snapshot || state.dashboard) return;
    let cancelled = false;
    api
      .getDashboard()
      .then((data) => {
        if (!cancelled) dispatch({ type: "setDashboard", payload: data });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dispatch, snapshot, state.dashboard]);

  useEffect(() => {
    api
      .checkUpdate()
      .then((info) => {
        if (info.hasUpdate) setHasUpdate(true);
      })
      .catch(() => {});
  }, []);

  // Global WebView default context-menu shield + instant pointerdown capture dismissal
  useEffect(() => {
    const onGlobalPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-context-menu]")) return;
      setPtyCtxMenu(null);
      setTabCtxMenu(null);
    };
    const onGlobalContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-context-menu]")) {
        setPtyCtxMenu(null);
        setTabCtxMenu(null);
      }
      if (event.defaultPrevented) return;
      if (
        target?.closest(
          'input, textarea, [contenteditable="true"], .xterm'
        )
      ) {
        return;
      }
      const selection = window.getSelection()?.toString()?.trim();
      if (selection) return;
      event.preventDefault();
    };
    const closeMenus = () => {
      setPtyCtxMenu(null);
      setTabCtxMenu(null);
    };
    window.addEventListener("pointerdown", onGlobalPointerDown, true);
    window.addEventListener("contextmenu", onGlobalContextMenu);
    window.addEventListener("blur", closeMenus);
    window.addEventListener("resize", closeMenus);
    document.addEventListener("scroll", closeMenus, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointerdown", onGlobalPointerDown, true);
      window.removeEventListener("contextmenu", onGlobalContextMenu);
      window.removeEventListener("blur", closeMenus);
      window.removeEventListener("resize", closeMenus);
      document.removeEventListener("scroll", closeMenus, { capture: true });
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const target = event.target as HTMLElement | null;
      const inTextField =
        target !== cmdInputRef.current &&
        Boolean(
          target?.closest('input, textarea, select, [contenteditable="true"]')
        );
      if (inTextField && (key === "k" || key === "w" || key === "b")) return;
      if ((event.ctrlKey || event.metaKey) && key === "k") {
        event.preventDefault();
        setCmdQuery("");
        setCmdIndex(0);
        dispatch({
          type: "setCommandPaletteOpen",
          payload: !state.commandPaletteOpen,
        });
      } else if ((event.ctrlKey || event.metaKey) && key === "w") {
        if (state.selectedSessionKey && state.selectedSessionPlatform) {
          const activeTab = state.openSessionTabs.find(
            (x) =>
              x.platform === state.selectedSessionPlatform &&
              x.sessionKey === state.selectedSessionKey
          );
          if (activeTab && !activeTab.pinned) {
            event.preventDefault();
            dispatch({
              type: "closeSessionTab",
              payload: {
                platform: activeTab.platform,
                sessionKey: activeTab.sessionKey,
              },
            });
          }
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key === "`") {
        event.preventDefault();
        dispatch({ type: "setPtyBayOpen", payload: !state.ptyBayOpen });
      } else if ((event.ctrlKey || event.metaKey) && key === "b") {
        event.preventDefault();
        dispatch({ type: "setRailCollapsed", payload: !state.railCollapsed });
      } else if (event.key === "Escape") {
        setTabCtxMenu(null);
        if (state.commandPaletteOpen) {
          dispatch({ type: "setCommandPaletteOpen", payload: false });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    dispatch,
    state.commandPaletteOpen,
    state.openSessionTabs,
    state.ptyBayOpen,
    state.railCollapsed,
    state.selectedSessionKey,
    state.selectedSessionPlatform,
  ]);

  useEffect(() => {
    if (state.commandPaletteOpen) {
      requestAnimationFrame(() => cmdInputRef.current?.focus());
    }
  }, [state.commandPaletteOpen]);

  // Context token telemetry for currently open session
  const sessionTokens = useMemo(() => {
    if (!state.sessionDetail) return 0;
    return state.sessionDetail.blocks.reduce(
      (sum, block) => sum + estimateBlockTokens(block),
      0
    );
  }, [state.sessionDetail]);

  const ctxLitSegments = useMemo(() => {
    if (sessionTokens <= 0) return 0;
    return Math.max(1, Math.min(8, Math.round((sessionTokens / 100_000) * 8)));
  }, [sessionTokens]);

  const activeAdapterCount = useMemo(
    () => (state.dashboard?.platforms ?? []).filter((p) => p.count > 0).length,
    [state.dashboard?.platforms]
  );

  // Embedded PTY list
  const allTerminals = useMemo(
    () =>
      Object.values(terminals)
        .flat()
        .sort((a, b) => b.createdAt - a.createdAt),
    [terminals]
  );

  const selectedTerminal =
    allTerminals.find((item) => item.id === activeTerminalId) ??
    allTerminals[0] ??
    null;

  const runningPtyCount = allTerminals.filter((item) =>
    ACTIVE_PTY_STATUSES.has(item.status)
  ).length;

  useEffect(() => {
    if (selectedTerminal && selectedTerminal.id !== activeTerminalId) {
      setActiveTerminal(selectedTerminal.id);
    } else if (!selectedTerminal && activeTerminalId) {
      setActiveTerminal(null);
    }
  }, [activeTerminalId, selectedTerminal, setActiveTerminal]);

  useEffect(() => {
    if (!ptyNotice) return;
    const timer = window.setTimeout(() => setPtyNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [ptyNotice]);

  const handleOpenExternalPty = async (terminal: EmbeddedTerminalSession) => {
    try {
      await api.launchSessionTerminal(terminal.command, terminal.cwd);
    } catch {
      await navigator.clipboard.writeText(terminal.command).catch(() => {});
      setPtyNotice(t("terminal.workspace.externalFailed"));
    }
  };

  const handleClosePty = async (terminal: EmbeddedTerminalSession) => {
    if (ACTIVE_PTY_STATUSES.has(terminal.status)) {
      const accepted = await confirm({
        title: t("terminal.closeRunningTitle"),
        description: t("terminal.closeRunningDesc"),
        variant: "danger",
      });
      if (!accepted) return;
    }
    await closeTerminal(terminal.sessionKey, terminal.id);
  };

  const handleStopPty = async (terminal: EmbeddedTerminalSession) => {
    if (terminal.status === "stopping") {
      const accepted = await confirm({
        title: t("terminal.btn.confirmForceStop"),
        description: t("terminal.forceStopDesc"),
        variant: "danger",
      });
      if (!accepted) return;
      await stopTerminal(terminal.id, true);
      return;
    }
    if (terminal.status === "starting" || terminal.status === "running") {
      await stopTerminal(terminal.id, false);
    }
  };


  // Command Palette Items
  const commandItems = useMemo(() => {
    const list: Array<{
      id: string;
      label: string;
      hint: string;
      run: () => void;
    }> = [];

    if (state.sessionDetail?.commands?.resume) {
      const cmd = state.sessionDetail.commands.resume;
      list.push({
        id: "act-resume",
        label: t("hud.cmdResume", { cmd }),
        hint: "Resume",
        run: () => {
          const detail = state.sessionDetail;
          if (!detail) return;
          void startTerminal(
            detail.sessionKey,
            "resume",
            cmd,
            detail.cwd || null,
            {
              platform: detail.platform,
              sessionTitle:
                detail.aliasTitle || detail.title || detail.sessionId,
            }
          );
          dispatch({ type: "setPtyBayOpen", payload: true });
        },
      });
    }

    list.push(
      {
        id: "act-new-pty",
        label: t("hud.cmdNewPty"),
        hint: "Terminal",
        run: () => {
          dispatch({ type: "setPtyBayOpen", payload: true });
          setNewPtyOpen(true);
        },
      },
      {
        id: "act-theme",
        label:
          resolvedTheme === "chrono"
            ? t("hud.cmdSwitchLight")
            : t("hud.cmdSwitchDark"),
        hint: "Theme",
        run: () => void toggleTheme(),
      },
      {
        id: "nav-workbench",
        label: t("hud.cmdGoWorkbench"),
        hint: t("hud.nav.workbench"),
        run: () => {
          dispatch({ type: "setCurrentPlatform", payload: "all" });
          navigate("/");
        },
      },
      {
        id: "nav-radar",
        label: t("hud.cmdGoRadar"),
        hint: t("hud.nav.radar"),
        run: () => navigate("/radar"),
      },
      {
        id: "nav-arsenal",
        label: t("hud.cmdGoPrompts"),
        hint: t("hud.nav.arsenal"),
        run: () => navigate("/prompts"),
      },
      {
        id: "nav-settings",
        label: t("hud.cmdGoSettings"),
        hint: t("settings"),
        run: () => navigate("/settings"),
      }
    );

    const candidateSessions: Session[] = [];
    const seen = new Set<string>();
    for (const s of [
      ...state.sessions,
      ...(state.dashboard?.recentSessions ?? []),
    ]) {
      const key = `${s.platform}::${s.sessionKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidateSessions.push(s);
    }

    for (const s of candidateSessions.slice(0, 30)) {
      list.push({
        id: `sess-${s.platform}-${s.sessionKey}`,
        label: `[${s.platform.toUpperCase()}] ${s.aliasTitle || s.displayTitle || s.sessionId}`,
        hint: s.cwd ? formatWorkspaceShortName(s.cwd) : "Session",
        run: () => {
          navigate(`/${s.platform}`);
          setTimeout(() => {
            dispatch({
              type: "selectSession",
              payload: { platform: s.platform, sessionKey: s.sessionKey },
            });
          }, 0);
        },
      });
    }

    const q = cmdQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.hint.toLowerCase().includes(q)
    );
  }, [
    cmdQuery,
    dispatch,
    navigate,
    resolvedTheme,
    startTerminal,
    state.dashboard?.recentSessions,
    state.sessionDetail,
    state.sessions,
    t,
    toggleTheme,
  ]);

  return (
    <div className="grid h-screen w-screen grid-rows-[38px_minmax(0,1fr)] overflow-hidden bg-[var(--bg-void)] text-[var(--text-hi)]">
      {/* Global Toast Notice / Error */}
      {notice && (
        <div className="hud-mono fixed right-6 bottom-9 z-50 flex items-center gap-2 rounded-[5px] border border-[var(--emerald-line)] bg-[var(--bg-panel)] px-3 py-1.5 text-xs text-[var(--emerald-fg)] shadow-2xl">
          <span className="size-1.5 rounded-full bg-[var(--emerald)]" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="hud-mono fixed right-6 bottom-9 z-50 flex items-center gap-2 rounded-[5px] border border-[var(--crimson-line)] bg-[var(--bg-panel)] px-3 py-1.5 text-xs text-[var(--crimson-fg)] shadow-2xl">
          <span className="size-1.5 rounded-full bg-[var(--crimson)]" />
          <span>
            {t("saveError")}: {error}
          </span>
        </div>
      )}

      {/* ==================== 38PX FRAMELESS UNIFIED TITLEBAR (RIN / OPENCODE STYLE) ==================== */}
      <header
        data-tauri-drag-region
        className={cn(
          "z-30 flex h-[38px] min-w-0 items-center border-b border-[var(--line-hair)] bg-[var(--bg-rack)] select-none",
          isTauriApp && IS_MACOS ? "pl-[78px]" : "pl-1.5"
        )}
      >
        {/* Left: Sidebar Toggle (with Hover Peek!) + Locate Button + Adaptive Session TabStrip */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 self-stretch pr-2">
          <button
            type="button"
            onClick={() => {
              if (!isWorkbench) navigate("/");
              else
                dispatch({
                  type: "setRailCollapsed",
                  payload: !state.railCollapsed,
                });
            }}
            onMouseEnter={() => {
              if (isWorkbench && state.railCollapsed) {
                dispatch({ type: "setRailHoverPeek", payload: true });
              }
            }}
            className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
            title={
              state.railCollapsed
                ? t("hud.sidebarHoverHint")
                : `${t("sidebar.collapse")} (Ctrl+B)`
            }
          >
            <PanelLeft className="size-[15px]" />
          </button>

          {state.selectedSessionKey && isWorkbench && (
            <button
              type="button"
              onClick={() => dispatch({ type: "requestLocateSession" })}
              className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              title={t("hud.locateInSidebar")}
            >
              <LocateFixed className="size-[15px]" />
            </button>
          )}

          {/* Rin-Style Adaptive TabStrip (Zero Scrollbar + Flex Shrink + Wheel Scroll!) */}
          {state.openSessionTabs.length > 0 ? (
            <div
              onWheel={(e) => {
                if (e.deltaY !== 0) {
                  e.currentTarget.scrollLeft += e.deltaY;
                }
              }}
              className="no-scrollbar ml-1 flex min-w-0 items-center gap-0.5 overflow-x-auto py-1"
            >
              {state.openSessionTabs.map((tab) => {
                const compKey = `${tab.platform}::${tab.sessionKey}`;
                const hasDraft =
                  Boolean(state.editDrafts[compKey]) ||
                  (isDirtyEdit(state.editingBlock) &&
                    state.editingBlock.platform === tab.platform &&
                    state.editingBlock.sessionKey === tab.sessionKey);
                const tabActive =
                  isWorkbench &&
                  state.selectedSessionKey === tab.sessionKey &&
                  (state.selectedSessionPlatform || tab.platform) ===
                    tab.platform;
                const matchedSession = state.sessions.find(
                  (s) =>
                    s.platform === tab.platform &&
                    s.sessionKey === tab.sessionKey
                );
                const rawTitle =
                  matchedSession?.aliasTitle || tab.title || tab.sessionKey;
                const displayTabTitle = !isUuidLikeTitle(rawTitle)
                  ? normalizeCleanPath(rawTitle)
                  : cleanHumanPreview(matchedSession?.preview).slice(0, 28) ||
                    tab.sessionKey.slice(0, 8);
                const isRenamingThis = renamingTabKey === compKey;

                return (
                  <div
                    key={compKey}
                    onAuxClick={(e) => {
                      if (e.button === 1 && !tab.pinned) {
                        e.preventDefault();
                        dispatch({
                          type: "closeSessionTab",
                          payload: {
                            platform: tab.platform,
                            sessionKey: tab.sessionKey,
                          },
                        });
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setTabCtxMenu({
                        x: e.clientX,
                        y: 38,
                        tab: {
                          ...tab,
                          title: displayTabTitle,
                          cwd: matchedSession?.cwd || tab.cwd,
                        },
                      });
                    }}
                    title={displayTabTitle}
                    className={cn(
                      "group/tab flex h-[27px] max-w-[164px] shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-xs transition-colors",
                      tab.pinned ? "min-w-[78px]" : "min-w-[98px] flex-1",
                      tabActive
                        ? "border border-[var(--line-hair)] bg-[var(--bg-void)] font-medium text-[var(--text-hi)] shadow-2xs"
                        : "text-[var(--text-mid)] hover:bg-[var(--bg-hover)]/75 hover:text-[var(--text-hi)]"
                    )}
                  >
                    <PlatformMark platform={tab.platform} size={12} />

                    {isRenamingThis ? (
                      <input
                        autoFocus
                        className="h-5 min-w-0 flex-1 rounded bg-[var(--bg-panel)] px-1 text-xs text-[var(--text-hi)] outline-none ring-1 ring-[var(--cyan)]"
                        onBlur={async () => {
                          const trimmed = renamingTabDraft.trim();
                          setRenamingTabKey(null);
                          await api
                            .setAlias(tab.platform, tab.sessionKey, trimmed)
                            .catch(() => {});
                          dispatch({
                            type: "updateSession",
                            payload: {
                              sessionKey: tab.sessionKey,
                              updates: { aliasTitle: trimmed },
                            },
                          });
                          dispatch({
                            type: "upsertSessionTab",
                            payload: {
                              ...tab,
                              title: trimmed || displayTabTitle,
                            },
                          });
                        }}
                        onChange={(e) => setRenamingTabDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            setRenamingTabKey(null);
                          }
                        }}
                        value={renamingTabDraft}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          if (!isWorkbench) navigate("/");
                          dispatch({
                            type: "selectSession",
                            payload: {
                              platform: tab.platform,
                              sessionKey: tab.sessionKey,
                            },
                          });
                        }}
                        onDoubleClick={() => {
                          setRenamingTabDraft(displayTabTitle);
                          setRenamingTabKey(compKey);
                        }}
                        className="min-w-0 flex-1 truncate text-left"
                      >
                        {displayTabTitle}
                      </button>
                    )}

                    {hasDraft && (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-[var(--forge)]"
                        title={t("hud.unsavedDraft")}
                      />
                    )}

                    {tab.pinned ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch({
                            type: "togglePinSessionTab",
                            payload: {
                              platform: tab.platform,
                              sessionKey: tab.sessionKey,
                            },
                          });
                        }}
                        className="grid size-4 shrink-0 place-items-center rounded-full text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                        title={t("hud.tabUnpin")}
                      >
                        <Pin className="size-2.5 rotate-45" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch({
                            type: "closeSessionTab",
                            payload: {
                              platform: tab.platform,
                              sessionKey: tab.sessionKey,
                            },
                          });
                        }}
                        className={cn(
                          "size-4 shrink-0 place-items-center rounded-full text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]",
                          tabActive
                            ? "grid opacity-80 hover:opacity-100"
                            : "hidden group-hover/tab:grid"
                        )}
                        title={`${t("hud.closeTab")} (Ctrl+W)`}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => navigate("/")}
              className="ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
            >
              <Scissors className="size-3.5 text-[var(--cyan-fg)]" />
              <span>{t("hud.nav.workbench")}</span>
            </button>
          )}

          {/* Trailing Drag Region */}
          <div data-tauri-drag-region className="min-w-[48px] flex-1 self-stretch" />
        </div>

        {/* Right: Borderless Ghost Utility Icons + Native Window Caption Buttons */}
        <div className="flex h-full shrink-0 items-center">
          <div className="flex items-center gap-0.5 pr-1.5">
            {/* Overview & Prompt Library Ghost Buttons */}
            <button
              type="button"
              onClick={() => navigate(isRadar ? "/" : "/radar")}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs transition-colors",
                isRadar
                  ? "bg-[var(--bg-hover)] font-semibold text-[var(--text-hi)]"
                  : "text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              )}
              title={t("hud.nav.radar")}
            >
              <LayoutGrid className="size-3.5" />
              <span className="hidden lg:inline">{t("hud.nav.radar")}</span>
            </button>

            <button
              type="button"
              onClick={() => navigate(isArsenal ? "/" : "/prompts")}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs transition-colors",
                isArsenal
                  ? "bg-[var(--bg-hover)] font-semibold text-[var(--text-hi)]"
                  : "text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              )}
              title={t("hud.nav.arsenal")}
            >
              <BookOpen className="size-3.5" />
              <span className="hidden lg:inline">{t("hud.nav.arsenal")}</span>
            </button>
            {/* Command Palette Trigger */}
            <button
              type="button"
              onClick={() => {
                setCmdQuery("");
                setCmdIndex(0);
                dispatch({ type: "setCommandPaletteOpen", payload: true });
              }}
              className="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              title={t("hud.cmdPaletteHint")}
            >
              <Search className="size-3.5" />
              <span className="hud-mono hidden text-[10.5px] text-[var(--text-low)] md:inline">
                Ctrl K
              </span>
            </button>

            {/* Audit Drawer Ghost Icon */}
            {state.selectedSessionKey && isWorkbench && (
              <button
                type="button"
                onClick={() =>
                  dispatch({
                    type: "setShowEditLog",
                    payload: !state.showEditLog,
                  })
                }
                className={cn(
                  "relative inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs transition-colors",
                  state.showEditLog || state.editLog.length > 0
                    ? "text-[var(--forge-fg)] hover:bg-[var(--forge-dim)]"
                    : "text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                )}
                title={`${t("editLog.title")} (${state.editLog.length})`}
              >
                <Zap className="size-3.5" />
                {state.editLog.length > 0 && (
                  <span className="hud-mono text-[10.5px] font-bold">
                    {state.editLog.length}
                  </span>
                )}
              </button>
            )}

            {/* Terminal Toggle Ghost Icon */}
            <button
              type="button"
              onClick={() =>
                dispatch({ type: "setPtyBayOpen", payload: !state.ptyBayOpen })
              }
              className={cn(
                "relative grid size-7 place-items-center rounded-[5px] transition-colors",
                state.ptyBayOpen || runningPtyCount > 0
                  ? "text-[var(--emerald-fg)] hover:bg-[var(--emerald-dim)]"
                  : "text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              )}
              title={t("hud.toggleTerminal")}
            >
              <Terminal className="size-3.5" />
              {runningPtyCount > 0 && (
                <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[var(--emerald)]" />
              )}
            </button>

            {/* 1-Click Chinese / English Switch Ghost Button */}
            <button
              type="button"
              onClick={() =>
                void setLocale(
                  snapshot?.settings.locale === "en" ? "zh-CN" : "en"
                )
              }
              className="hud-mono grid h-7 min-w-7 place-items-center rounded-[5px] px-1.5 text-[10.5px] font-bold text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              title={t("languageSection")}
            >
              {snapshot?.settings.locale === "en" ? "中" : "EN"}
            </button>

            {/* Dark / Light Theme Ghost Icon */}
            <button
              type="button"
              onClick={() => void toggleTheme()}
              className="grid size-7 place-items-center rounded-[5px] text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              title={
                resolvedTheme === "chrono"
                  ? t("hud.toggleLight")
                  : t("hud.toggleDark")
              }
            >
              {resolvedTheme === "chrono" ? (
                <Moon className="size-3.5" />
              ) : (
                <Sun className="size-3.5" />
              )}
            </button>

            {/* Settings Ghost Icon */}
            <button
              type="button"
              onClick={() => navigate("/settings")}
              className={cn(
                "relative grid size-7 place-items-center rounded-[5px] transition-colors",
                isConfig
                  ? "bg-[var(--bg-hover)] text-[var(--cyan-fg)]"
                  : "text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              )}
              title={t("settings")}
            >
              <Settings className="size-3.5" />
              {hasUpdate && (
                <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[var(--forge)] animate-pulse" />
              )}
            </button>
          </div>

          {/* Native-Feel Desktop Window Controls (Minimize / Maximize / Close) */}
          {isTauriApp && !IS_MACOS && (
            <div className="flex h-full items-center border-l border-[var(--line-subtle)]">
              <button
                type="button"
                onClick={() => void getCurrentWindow().minimize()}
                className="grid h-full w-[42px] place-items-center text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                title={t("hud.winMinimize")}
              >
                <Minus className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void getCurrentWindow().toggleMaximize()}
                className="grid h-full w-[42px] place-items-center text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                title={
                  isWinMaximized ? t("hud.winRestore") : t("hud.winMaximize")
                }
              >
                {isWinMaximized ? (
                  <Copy className="size-3 rotate-90" />
                ) : (
                  <Square className="size-3" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void getCurrentWindow().close()}
                className="grid h-full w-[44px] place-items-center text-[var(--text-mid)] transition-colors hover:bg-[#e81123] hover:text-white"
                title={t("hud.winClose")}
              >
                <X className="size-4" />
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ==================== MAIN STAGE + UNIFIED BOTTOM TELEMETRY / PTY BAR ==================== */}
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <main
          className={cn(
            "relative min-h-0 min-w-0 flex-1 overflow-hidden",
            state.ptyBayMaximized && "hidden"
          )}
        >
          <Outlet />
        </main>

        {/* Bottom 26px Status Footer (expands into Resizable Live PTY Bay!) */}
        <footer
          style={
            state.ptyBayOpen && !state.ptyBayMaximized
              ? { height: `${ptyHeight}px`, maxHeight: "calc(100vh - 160px)" }
              : undefined
          }
          className={cn(
            "relative flex shrink-0 flex-col overflow-hidden border-t select-none",
            !isResizingPty && "transition-[height] duration-150",
            !state.ptyBayOpen &&
              "h-[26px] border-[var(--line-hair)] bg-[var(--bg-rack)] text-[var(--text-mid)]",
            state.ptyBayOpen &&
              !state.ptyBayMaximized &&
              "border-[var(--line-strong)] bg-[#06080c] text-slate-200",
            state.ptyBayOpen &&
              state.ptyBayMaximized &&
              "h-full flex-1 border-[var(--line-strong)] bg-[#06080c] text-slate-200"
          )}
        >
          {/* VS Code-style Top Resize Sash when PTY Bay is open */}
          {state.ptyBayOpen && !state.ptyBayMaximized && (
            <div
              onDoubleClick={() => {
                setPtyHeight(230);
                try {
                  localStorage.setItem("memory-forge.pty-height", "230");
                } catch {}
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                const sash = e.currentTarget;
                const pointerId = e.pointerId;
                sash.setPointerCapture(pointerId);
                setIsResizingPty(true);
                const prevCursor = document.body.style.cursor;
                const prevSelect = document.body.style.userSelect;
                document.body.style.cursor = "row-resize";
                document.body.style.userSelect = "none";

                let latestH = ptyHeight;
                let finished = false;
                const onMove = (ev: PointerEvent) => {
                  const rawH = window.innerHeight - ev.clientY;
                  if (rawH < 64) {
                    dispatch({ type: "setPtyBayOpen", payload: false });
                    cleanup();
                    return;
                  }
                  const clamped = Math.max(
                    110,
                    Math.min(window.innerHeight - 160, rawH)
                  );
                  latestH = clamped;
                  setPtyHeight(clamped);
                };
                const cleanup = () => {
                  if (finished) return;
                  finished = true;
                  setIsResizingPty(false);
                  document.body.style.cursor = prevCursor;
                  document.body.style.userSelect = prevSelect;
                  try {
                    localStorage.setItem(
                      "memory-forge.pty-height",
                      String(Math.round(latestH))
                    );
                  } catch {}
                  sash.removeEventListener("pointermove", onMove);
                  sash.removeEventListener("pointerup", cleanup);
                  sash.removeEventListener("pointercancel", cleanup);
                  sash.removeEventListener("lostpointercapture", cleanup);
                  if (sash.hasPointerCapture(pointerId)) {
                    sash.releasePointerCapture(pointerId);
                  }
                };
                sash.addEventListener("pointermove", onMove);
                sash.addEventListener("pointerup", cleanup);
                sash.addEventListener("pointercancel", cleanup);
                sash.addEventListener("lostpointercapture", cleanup);
              }}
              className={cn(
                "group absolute inset-x-0 top-0 z-30 h-[5px] cursor-row-resize",
                isResizingPty
                  ? "bg-[var(--cyan)]"
                  : "hover:bg-[var(--cyan)]/80"
              )}
              title={t("hud.ptyResizeHint")}
            />
          )}
          {!state.ptyBayOpen ? (
            /* ---- CALM 26PX STATUS FOOTER (RIN STYLE) ---- */
            <div className="hud-mono flex h-[26px] items-center gap-3 px-3 text-[10.5px]">
              {state.sessionDetail && (
                <span className="inline-flex items-center gap-1.5 text-[var(--emerald-fg)]">
                  <span className="size-1.5 rounded-full bg-[var(--emerald)]" />
                  <span>
                    {hasBackupWrite(snapshot, state.sessionDetail.platform)
                      ? t("hud.safeWriteBadge")
                      : t("hud.editLogOnlyBadge")}
                  </span>
                </span>
              )}

              {activeAdapterCount > 0 && (
                <span className="hidden text-[var(--text-low)] sm:inline">
                  {t("hud.activeAdapters", { count: activeAdapterCount })}
                </span>
              )}

              {state.sessionDetail?.cwd && (
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      state.sessionDetail?.cwd ?? ""
                    )
                  }
                  className="inline-flex min-w-0 items-center gap-1 text-[var(--text-mid)] hover:text-[var(--text-hi)]"
                  title={t("hud.copyCwdHint", {
                    cwd: state.sessionDetail.cwd,
                  })}
                >
                  <Folder className="size-3 shrink-0 text-[var(--cyan-fg)]" />
                  <span className="max-w-[320px] truncate">
                    {state.sessionDetail.cwd}
                  </span>
                </button>
              )}

              {/* Right Side of Footer: CTX Token Load + PTY Drawer Trigger */}
              <div className="ml-auto flex items-center gap-3">
                {state.sessionDetail && (
                  <div className="inline-flex items-center gap-1.5">
                    <span className="text-[var(--text-low)]">
                      {t("hud.contextLoad")}
                    </span>
                    <span className="flex items-center gap-0.5">
                      {Array.from({ length: 8 }).map((_, idx) => {
                        const lit = idx < ctxLitSegments;
                        const tone =
                          sessionTokens > 80_000
                            ? "bg-[var(--crimson)]"
                            : sessionTokens > 40_000
                              ? "bg-[var(--forge)]"
                              : "bg-[var(--cyan)]";
                        return (
                          <span
                            key={idx}
                            className={cn(
                              "h-2 w-[3px] rounded-[1px]",
                              lit ? tone : "bg-[var(--line-hair)]"
                            )}
                          />
                        );
                      })}
                    </span>
                    <strong
                      className={cn(
                        sessionTokens > 80_000
                          ? "text-[var(--crimson-fg)]"
                          : sessionTokens > 40_000
                            ? "text-[var(--forge-fg)]"
                            : "text-[var(--text-hi)]"
                      )}
                    >
                      {formatTokenCount(sessionTokens)} tok
                    </strong>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() =>
                    dispatch({ type: "setPtyBayOpen", payload: true })
                  }
                  className={cn(
                    "inline-flex h-5 items-center gap-1 rounded-[3px] px-1.5 transition-colors hover:bg-[var(--bg-hover)]",
                    runningPtyCount > 0
                      ? "font-semibold text-[var(--emerald-fg)]"
                      : "text-[var(--text-mid)] hover:text-[var(--text-hi)]"
                  )}
                  title={t("hud.toggleTerminal")}
                >
                  <Terminal className="size-3" />
                  <span>{t("hud.ptyCount", { count: allTerminals.length })}</span>
                  <ChevronUp className="size-3 opacity-70" />
                </button>
              </div>
            </div>
          ) : (
            /* ---- EXPANDED LIVE PTY TERMINAL HEADER ---- */
            <div className="flex h-[28px] shrink-0 items-center gap-1.5 border-b border-slate-800/80 bg-[#0b0f17] px-2.5">
              <button
                type="button"
                onClick={() =>
                  dispatch({ type: "setPtyBayOpen", payload: false })
                }
                className="hud-mono flex items-center gap-1.5 text-[10px] font-bold tracking-wider text-emerald-400"
              >
                <Terminal className="size-3" />
                <span>{t("hud.ptyTitle")}</span>
              </button>

              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {allTerminals.map((term) => {
                  const active = term.id === selectedTerminal?.id;
                  const statusDot =
                    terminalTheme.statusConfig[term.status]?.dot ??
                    "bg-slate-500";
                  const shortTitle = formatPtyTabTitle(term.sessionTitle);
                  return (
                    <div
                      key={term.id}
                      className={cn(
                        "hud-mono group flex h-[22px] shrink-0 items-center gap-1.5 rounded-[3px] border px-2 text-[10.5px] transition-colors",
                        active
                          ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-300"
                          : "border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full", statusDot)} />
                      {editingPtyId === term.id ? (
                        <input
                          autoFocus
                          className="w-24 bg-transparent text-[10.5px] text-white outline-none"
                          onBlur={() => {
                            if (editingPtyTitle.trim()) {
                              renameTerminal(term.id, editingPtyTitle.trim());
                            }
                            setEditingPtyId(null);
                          }}
                          onChange={(e) => setEditingPtyTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              if (editingPtyTitle.trim()) {
                                renameTerminal(term.id, editingPtyTitle.trim());
                              }
                              setEditingPtyId(null);
                            } else if (e.key === "Escape") {
                              setEditingPtyId(null);
                            }
                          }}
                          value={editingPtyTitle}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setActiveTerminal(term.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setPtyCtxMenu({
                              x: e.clientX,
                              y: e.clientY,
                              term,
                            });
                          }}
                          onDoubleClick={() => {
                            setEditingPtyId(term.id);
                            setEditingPtyTitle(term.sessionTitle);
                          }}
                          className="max-w-[140px] truncate"
                          title={`${term.command} (${t("terminal.renameHint")})`}
                        >
                          {shortTitle}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleClosePty(term)}
                        className="rounded p-0.5 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
                        title={t("terminal.btn.close")}
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={() => setNewPtyOpen(true)}
                  className="hud-mono inline-flex h-[21px] shrink-0 items-center gap-1 rounded-[3px] border border-slate-700/70 px-1.5 text-[10px] text-slate-300 hover:bg-white/8"
                  title={t("terminal.new.title")}
                >
                  <Plus className="size-2.5" />
                  <span>{t("hud.newTerminal")}</span>
                </button>
              </div>

              {ptyNotice && (
                <span
                  className="hud-mono min-w-0 shrink truncate text-[10px] text-amber-300"
                  role="status"
                  title={ptyNotice}
                >
                  {ptyNotice}
                </span>
              )}
              <div className="hud-mono ml-auto flex shrink-0 items-center gap-1 text-[10px]">
                {selectedTerminal && (
                  <>
                    {["running", "exited", "failed"].includes(
                      selectedTerminal.status
                    ) && (
                      <button
                        type="button"
                        onClick={() =>
                          void restartTerminal(selectedTerminal.id)
                        }
                        className="inline-flex h-[21px] items-center gap-1 rounded-[3px] border border-slate-700/70 px-1.5 text-slate-300 hover:bg-white/8"
                        title={t("terminal.btn.restart")}
                      >
                        <RotateCw className="size-2.5" />
                      </button>
                    )}
                    {ACTIVE_PTY_STATUSES.has(selectedTerminal.status) && (
                      <button
                        type="button"
                        onClick={() => void handleStopPty(selectedTerminal)}
                        className={cn(
                          "inline-flex h-[21px] items-center gap-1 rounded-[3px] border px-1.5",
                          selectedTerminal.status === "stopping"
                            ? "border-rose-500/50 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                            : "border-amber-500/40 text-amber-300 hover:bg-amber-500/15"
                        )}
                        title={
                          selectedTerminal.status === "stopping"
                            ? t("terminal.btn.forceStop")
                            : t("terminal.btn.stop")
                        }
                      >
                        <Square className="size-2.5 fill-current" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleOpenExternalPty(selectedTerminal)}
                      className="inline-flex h-[21px] items-center gap-1 rounded-[3px] border border-slate-700/70 px-1.5 text-slate-300 hover:bg-white/8"
                      title={t("terminal.btn.openExternal")}
                    >
                      <ExternalLink className="size-2.5" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() =>
                    dispatch({
                      type: "setPtyBayMaximized",
                      payload: !state.ptyBayMaximized,
                    })
                  }
                  className="inline-flex h-[21px] items-center gap-1 rounded-[3px] border border-slate-700/70 px-1.5 text-slate-300 hover:bg-white/8"
                  title={
                    state.ptyBayMaximized
                      ? t("terminal.btn.restoreLayout")
                      : t("terminal.btn.maximize")
                  }
                >
                  {state.ptyBayMaximized ? (
                    <Minimize2 className="size-2.5" />
                  ) : (
                    <Maximize2 className="size-2.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    dispatch({ type: "setPtyBayMaximized", payload: false });
                    dispatch({ type: "setPtyBayOpen", payload: false });
                  }}
                  className="inline-flex h-[21px] items-center rounded-[3px] border border-slate-700/70 px-2 text-slate-300 hover:bg-white/8"
                >
                  {t("hud.collapse")}
                </button>
              </div>
            </div>
          )}

          {/* PTY Body (kept mounted so xterm buffers persist; hidden when collapsed) */}
          <div
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden",
              !state.ptyBayOpen && "hidden"
            )}
          >
            {allTerminals.length === 0 ? (
              <div className="flex h-full items-center justify-between gap-4 px-5">
                <div>
                  <p className="hud-mono text-xs font-semibold text-slate-200">
                    {t("terminal.workspace.emptyTitle")}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {t("hud.ptyEmptyHint")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setNewPtyOpen(true)}
                  className="hud-btn hud-btn-emerald shrink-0"
                >
                  <Play className="size-3" />
                  <span>{t("terminal.new.title")}</span>
                </button>
              </div>
            ) : (
              allTerminals.map((term) => {
                const active = term.id === selectedTerminal?.id;
                return (
                  <div
                    key={term.id}
                    className={cn(
                      "h-full min-h-0 w-full flex-col",
                      active ? "flex" : "hidden"
                    )}
                  >
                    <EmbeddedTerminalPanel
                      errorMessage={term.errorMessage}
                      exitCode={term.exitCode}
                      onClose={() => void handleClosePty(term)}
                      onOpenExternal={() => void handleOpenExternalPty(term)}
                      onRestart={() => void restartTerminal(term.id)}
                      onStart={() => void restartTerminal(term.id)}
                      status={term.status}
                    >
                      <TerminalViewport
                        isActive={active && state.ptyBayOpen}
                        terminalId={term.id}
                      />
                    </EmbeddedTerminalPanel>
                  </div>
                );
              })
            )}
          </div>
        </footer>
      </div>

      {/* ==================== COMMAND PALETTE (Ctrl+K) ==================== */}
      {state.commandPaletteOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/65 pt-[11vh] backdrop-blur-[2px]"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              dispatch({ type: "setCommandPaletteOpen", payload: false });
            }
          }}
        >
          <div className="reticle reticle-cyan mx-auto w-[min(580px,92vw)] overflow-hidden rounded-[6px] border border-[var(--cyan-line)] bg-[var(--bg-panel)] shadow-2xl">
            <div className="flex items-center gap-2.5 border-b border-[var(--line-hair)] px-3.5 py-2.5">
              <Search className="size-4 text-[var(--cyan-fg)]" />
              <input
                ref={cmdInputRef}
                className="flex-1 bg-transparent text-sm text-[var(--text-hi)] placeholder:text-[var(--text-low)] outline-none"
                onChange={(e) => {
                  setCmdQuery(e.target.value);
                  setCmdIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCmdIndex((i) =>
                      commandItems.length ? (i + 1) % commandItems.length : 0
                    );
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCmdIndex((i) =>
                      commandItems.length
                        ? (i - 1 + commandItems.length) % commandItems.length
                        : 0
                    );
                  } else if (e.key === "Enter" && commandItems[cmdIndex]) {
                    e.preventDefault();
                    const chosen = commandItems[cmdIndex];
                    dispatch({ type: "setCommandPaletteOpen", payload: false });
                    chosen.run();
                  }
                }}
                placeholder={t("hud.cmdPlaceholder")}
                value={cmdQuery}
              />
              <kbd className="hud-kbd">ESC</kbd>
            </div>
            <div className="max-h-[340px] overflow-y-auto p-1.5">
              {commandItems.length === 0 ? (
                <div className="py-8 text-center text-xs text-[var(--text-low)]">
                  {t("hud.cmdNoMatch")}
                </div>
              ) : (
                commandItems.map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      dispatch({
                        type: "setCommandPaletteOpen",
                        payload: false,
                      });
                      item.run();
                    }}
                    onMouseEnter={() => setCmdIndex(idx)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-[4px] px-2.5 py-2 text-left text-xs transition-colors",
                      idx === cmdIndex
                        ? "bg-[var(--cyan-dim)] text-[var(--cyan-fg)]"
                        : "text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
                    )}
                  >
                    <span className="truncate font-medium">{item.label}</span>
                    <span className="hud-kbd">{item.hint}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Full-Window Click-Catcher Backdrop while any TopBar / PTY menu is open (blocks Tauri drag-region from swallowing clicks!) */}
      {(tabCtxMenu || ptyCtxMenu) && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => {
            setTabCtxMenu(null);
            setPtyCtxMenu(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabCtxMenu(null);
            setPtyCtxMenu(null);
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setTabCtxMenu(null);
            setPtyCtxMenu(null);
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setTabCtxMenu(null);
            setPtyCtxMenu(null);
          }}
        />
      )}

      {/* TopBar Session Tab Right-Click Context Menu (Exact Rin Menu!) */}
      {tabCtxMenu && (
        <FloatingMenu
          className="w-[202px] rounded-[9px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1.5 text-xs text-[var(--text-hi)] shadow-2xl"
          x={tabCtxMenu.x}
          y={tabCtxMenu.y}
        >
          <button
            type="button"
            onClick={() => {
              const target = tabCtxMenu.tab;
              setTabCtxMenu(null);
              if (!isWorkbench) navigate("/");
              dispatch({
                type: "selectSession",
                payload: {
                  platform: target.platform,
                  sessionKey: target.sessionKey,
                },
              });
              setTimeout(() => dispatch({ type: "requestLocateSession" }), 30);
            }}
            className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)]"
          >
            <LocateFixed className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            <span className="truncate">{t("hud.locateInSidebar")}</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              const target = tabCtxMenu.tab;
              setTabCtxMenu(null);
              try {
                const detail =
                  state.sessionDetail?.sessionKey === target.sessionKey
                    ? state.sessionDetail
                    : await api.getSessionDetail(
                        target.platform,
                        target.sessionKey
                      );
                const cmd = detail.commands?.resume;
                if (!cmd) {
                  dispatch({
                    type: "setSessionStatus",
                    payload: { tone: "error", message: t("hud.ctxNoResumeCmd") },
                  });
                  return;
                }
                await navigator.clipboard.writeText(cmd);
                dispatch({
                  type: "setSessionStatus",
                  payload: { tone: "success", message: t("session.copied") },
                });
              } catch {
                dispatch({
                  type: "setSessionStatus",
                  payload: {
                    tone: "error",
                    message: t("hud.copyResumeFailed"),
                  },
                });
              }
            }}
            className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)]"
          >
            <Terminal className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            <span className="truncate">{t("terminal.copyResumeCmd")}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const sk = tabCtxMenu.tab.sessionKey;
              setTabCtxMenu(null);
              void navigator.clipboard.writeText(sk);
            }}
            className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)]"
          >
            <Copy className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            <span className="truncate">{t("hud.ctxCopySessionId")}</span>
          </button>

          {tabCtxMenu.tab.cwd && (
            <button
              type="button"
              onClick={() => {
                const cwd = tabCtxMenu.tab.cwd ?? "";
                setTabCtxMenu(null);
                void navigator.clipboard.writeText(cwd);
              }}
              className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)]"
            >
              <Folder className="size-3.5 shrink-0 text-[var(--text-mid)]" />
              <span className="truncate">{t("hud.ctxCopyCwd")}</span>
            </button>
          )}

          <div className="my-1 border-t border-[var(--line-hair)]" />

          <button
            type="button"
            onClick={() => {
              const target = tabCtxMenu.tab;
              setTabCtxMenu(null);
              setRenamingTabDraft(target.title);
              setRenamingTabKey(`${target.platform}::${target.sessionKey}`);
            }}
            className="flex w-full items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)]"
          >
            <span className="flex items-center gap-2.5 truncate">
              <Pencil className="size-3.5 shrink-0 text-[var(--text-mid)]" />
              <span>{t("hud.tabRename")}</span>
            </span>
            <span className="text-[11px] text-[var(--text-low)]">
              {t("hud.tabDoubleClickHint")}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              const target = tabCtxMenu.tab;
              setTabCtxMenu(null);
              dispatch({
                type: "togglePinSessionTab",
                payload: {
                  platform: target.platform,
                  sessionKey: target.sessionKey,
                },
              });
            }}
            className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)]"
          >
            {tabCtxMenu.tab.pinned ? (
              <PinOff className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            ) : (
              <Pin className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            )}
            <span className="truncate">
              {tabCtxMenu.tab.pinned ? t("hud.tabUnpin") : t("hud.tabPin")}
            </span>
          </button>

          <div className="my-1 border-t border-[var(--line-hair)]" />

          <button
            type="button"
            disabled={Boolean(tabCtxMenu.tab.pinned)}
            onClick={() => {
              const target = tabCtxMenu.tab;
              setTabCtxMenu(null);
              dispatch({
                type: "closeSessionTab",
                payload: {
                  platform: target.platform,
                  sessionKey: target.sessionKey,
                },
              });
            }}
            className="flex w-full items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <span className="flex items-center gap-2.5 truncate">
              <X className="size-3.5 shrink-0 text-[var(--text-mid)]" />
              <span>{t("hud.closeTab")}</span>
            </span>
            <span className="hud-mono text-[11px] text-[var(--text-low)]">
              Ctrl+W
            </span>
          </button>

          <button
            type="button"
            disabled={
              state.openSessionTabs.filter((x) => !x.pinned).length <= 1
            }
            onClick={() => {
              const target = tabCtxMenu.tab;
              setTabCtxMenu(null);
              dispatch({
                type: "closeOtherSessionTabs",
                payload: {
                  platform: target.platform,
                  sessionKey: target.sessionKey,
                },
              });
            }}
            className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <Copy className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            <span className="truncate">{t("hud.tabCloseOthers")}</span>
          </button>

          <button
            type="button"
            disabled={(() => {
              const idx = state.openSessionTabs.findIndex(
                (x) =>
                  x.platform === tabCtxMenu.tab.platform &&
                  x.sessionKey === tabCtxMenu.tab.sessionKey
              );
              return (
                idx < 0 ||
                !state.openSessionTabs.slice(idx + 1).some((x) => !x.pinned)
              );
            })()}
            onClick={() => {
              const target = tabCtxMenu.tab;
              setTabCtxMenu(null);
              dispatch({
                type: "closeRightSessionTabs",
                payload: {
                  platform: target.platform,
                  sessionKey: target.sessionKey,
                },
              });
            }}
            className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <ArrowRightToLine className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            <span className="truncate">{t("hud.tabCloseRight")}</span>
          </button>
        </FloatingMenu>
      )}

      {/* PTY Tab Right-Click Context Menu */}
      {ptyCtxMenu && (
        <FloatingMenu
          className="w-[196px] rounded-[6px] border border-slate-700/90 bg-[#0e131b] p-1 text-xs text-slate-200 shadow-2xl"
          x={ptyCtxMenu.x}
          y={ptyCtxMenu.y}
        >
          <button
            type="button"
            onClick={() => {
              const target = ptyCtxMenu.term;
              setPtyCtxMenu(null);
              setEditingPtyId(target.id);
              setEditingPtyTitle(target.sessionTitle);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left hover:bg-white/8"
          >
            <Pencil className="size-3.5 shrink-0 text-slate-400" />
            <span className="truncate">{t("terminal.menu.rename")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const target = ptyCtxMenu.term;
              setPtyCtxMenu(null);
              void restartTerminal(target.id);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left hover:bg-white/8"
          >
            <RotateCw className="size-3.5 shrink-0 text-emerald-400" />
            <span className="truncate">{t("terminal.btn.restart")}</span>
          </button>
          <button
            type="button"
            disabled={!ACTIVE_PTY_STATUSES.has(ptyCtxMenu.term.status)}
            onClick={() => {
              const target = ptyCtxMenu.term;
              setPtyCtxMenu(null);
              void handleStopPty(target);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left hover:bg-white/8 disabled:opacity-40"
          >
            <Square className="size-3.5 shrink-0 fill-current text-amber-300" />
            <span className="truncate">
              {ptyCtxMenu.term.status === "stopping"
                ? t("terminal.btn.forceStop")
                : t("terminal.btn.stop")}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              const cmd = ptyCtxMenu.term.command;
              setPtyCtxMenu(null);
              void navigator.clipboard.writeText(cmd);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left hover:bg-white/8"
          >
            <Copy className="size-3.5 shrink-0 text-slate-400" />
            <span className="truncate">{t("terminal.menu.copyCommand")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const target = ptyCtxMenu.term;
              setPtyCtxMenu(null);
              void handleOpenExternalPty(target);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left hover:bg-white/8"
          >
            <ExternalLink className="size-3.5 shrink-0 text-cyan-400" />
            <span className="truncate">{t("terminal.btn.openExternal")}</span>
          </button>
          <div className="my-1 border-t border-slate-800" />
          <button
            type="button"
            onClick={() => {
              const target = ptyCtxMenu.term;
              setPtyCtxMenu(null);
              void handleClosePty(target);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-rose-400 hover:bg-rose-500/15"
          >
            <X className="size-3.5 shrink-0" />
            <span className="truncate">{t("terminal.btn.close")}</span>
          </button>
        </FloatingMenu>
      )}

      <NewSessionDialog
        defaultCwd={state.sessionDetail?.cwd ?? null}
        onOpenChange={setNewPtyOpen}
        open={newPtyOpen}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

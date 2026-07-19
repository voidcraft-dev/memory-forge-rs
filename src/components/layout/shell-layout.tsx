import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Info,
  LayoutGrid,
  Menu,
  MousePointer2,
  Settings2,
  X,
  Bot,
  Terminal,
  Code,
  Sparkles,
  Gem,
  Orbit,
  Pi,
  SquareTerminal,
  Wifi,
  Eye,
  KeyRound,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { AppLogo } from "@/components/logo";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useDesktop } from "@/features/desktop/provider";
import { api, hasRemoteAccessToken, setRemoteAccessToken } from "@/features/desktop/api";
import { cn } from "@/lib/utils";
import { Suspense, useState, useEffect } from "react";
import type { MessageKey } from "@/features/desktop/i18n";

const navigation: Array<{
  to: string;
  labelKey: MessageKey;
  icon: LucideIcon;
  navigationId?: string;
}> = [
  { to: "/", labelKey: "dashboard" as const, icon: LayoutGrid },
  { to: "/claude", labelKey: "platformClaude", icon: Bot, navigationId: "claude" },
  { to: "/codex", labelKey: "platformCodex", icon: Terminal, navigationId: "codex" },
  { to: "/terminal-sessions", labelKey: "terminalSessions", icon: SquareTerminal, navigationId: "terminal-sessions" },
  { to: "/cursor", labelKey: "platformCursor", icon: MousePointer2, navigationId: "cursor" },
  { to: "/opencode", labelKey: "platformOpencode", icon: Code, navigationId: "opencode" },
  { to: "/kiro", labelKey: "platformKiro", icon: Sparkles, navigationId: "kiro" },
  { to: "/kiro-ide", labelKey: "platformKiroIde", icon: Sparkles, navigationId: "kiro-ide" },
  { to: "/gemini", labelKey: "platformGemini", icon: Gem, navigationId: "gemini" },
  { to: "/grok", labelKey: "platformGrok", icon: Orbit, navigationId: "grok" },
  { to: "/pi", labelKey: "platformPi", icon: Pi, navigationId: "pi" },
  { to: "/prompts", labelKey: "prompts" as const, icon: BookOpen },
  { to: "/settings", labelKey: "settings" as const, icon: Settings2 },
  { to: "/about", labelKey: "about" as const, icon: Info },
];

export default function ShellLayout() {
  const { snapshot, notice, error, t, isRemote, isReadOnlyRemote, remoteBootstrap, dispatch } = useDesktop();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteAccessReady, setRemoteAccessReady] = useState(false);
  const [remoteAccessChecking, setRemoteAccessChecking] = useState(() => hasRemoteAccessToken());
  const [remoteConnecting, setRemoteConnecting] = useState(false);
  const [remoteTokenError, setRemoteTokenError] = useState(false);

  useEffect(() => {
    if (!snapshot) return;
    if (!isRemote || !remoteBootstrap?.auth.required) {
      setRemoteAccessReady(false);
      setRemoteAccessChecking(false);
      return;
    }
    setRemoteAccessReady(false);
    if (!hasRemoteAccessToken()) {
      setRemoteAccessChecking(false);
      return;
    }
    let cancelled = false;
    setRemoteAccessChecking(true);
    api.getDashboard()
      .then((dashboard) => {
        if (cancelled) return;
        dispatch({ type: "setDashboard", payload: dashboard });
        setRemoteAccessReady(true);
        setRemoteTokenError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRemoteAccessToken("");
        setRemoteAccessReady(false);
        setRemoteTokenError(true);
      })
      .finally(() => {
        if (!cancelled) setRemoteAccessChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch, isRemote, remoteBootstrap?.auth.required, snapshot]);

  const connectRemote = async () => {
    if (!remoteToken.trim()) return;
    setRemoteConnecting(true);
    setRemoteTokenError(false);
    setRemoteAccessToken(remoteToken);
    try {
      const dashboard = await api.getDashboard();
      dispatch({ type: "setDashboard", payload: dashboard });
      setRemoteAccessReady(true);
      setRemoteToken("");
    } catch {
      setRemoteAccessToken("");
      setRemoteTokenError(true);
    } finally {
      setRemoteConnecting(false);
    }
  };

  useEffect(() => {
    const handleToggle = (e: Event) => {
      setTerminalMaximized((e as CustomEvent<boolean>).detail);
    };
    window.addEventListener("toggle-terminal-maximize", handleToggle);
    return () => {
      window.removeEventListener("toggle-terminal-maximize", handleToggle);
    };
  }, []);

  const visibleNavigationOrder = snapshot?.settings?.navigationItems ?? [
    "claude",
    "codex",
    "terminal-sessions",
    "opencode",
    "grok",
    "pi",
  ];
  const visibleNavigation = [
    navigation[0],
    ...visibleNavigationOrder.flatMap((navigationId) => {
      const item = navigation.find((candidate) => candidate.navigationId === navigationId);
      return item ? [item] : [];
    }),
    ...navigation.filter((item) => !item.navigationId && item.to !== "/"),
  ];
  const remoteContentReady = !isRemote
    || remoteBootstrap?.auth.required !== true
    || remoteAccessReady;

  useEffect(() => {
    api.checkUpdate().then(info => {
      if (info.hasUpdate) setHasUpdate(true);
    }).catch(() => {});
  }, []);

  return (
    <div className="bg-shell h-screen overflow-hidden text-foreground">
      <div className="subtle-grid pointer-events-none fixed inset-0" />

      {/* Global Toast Notification for Notices */}
      {notice && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 dark:bg-emerald-950/20 px-5 py-3 text-sm font-semibold text-emerald-600 dark:text-emerald-300 shadow-xl backdrop-blur-xl animate-in fade-in slide-in-from-top-4 duration-300 select-none">
          <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>{notice}</span>
        </div>
      )}

      {error && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 rounded-2xl border border-destructive/20 bg-destructive/10 dark:bg-destructive-950/20 px-5 py-3 text-sm font-semibold text-destructive dark:text-red-300 shadow-xl backdrop-blur-xl animate-in fade-in slide-in-from-top-4 duration-300 select-none">
          <span className="size-2 rounded-full bg-destructive animate-pulse" />
          <span>{t("saveError")}: {error}</span>
        </div>
      )}

      {isRemote && remoteBootstrap?.auth.required && !remoteAccessReady && !remoteAccessChecking && (
        <div
          aria-labelledby="remote-access-title"
          aria-modal="true"
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-5 backdrop-blur-md"
          role="dialog"
        >
          <form
            className="panel-surface w-full max-w-sm rounded-2xl p-5 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              void connectRemote();
            }}
          >
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <KeyRound className="size-5" />
              </span>
              <div className="min-w-0">
                <h2 className="font-semibold text-foreground" id="remote-access-title">{t("remoteAccessTitle")}</h2>
                <p className="mt-0.5 break-words text-xs text-quiet [overflow-wrap:anywhere]">{remoteBootstrap.serverName}</p>
              </div>
            </div>
            <label className="mt-5 block text-xs font-semibold text-quiet" htmlFor="remote-access-token">
              {t("remoteAccessToken")}
            </label>
            <input
              id="remote-access-token"
              type="password"
              autoComplete="off"
              value={remoteToken}
              onChange={(event) => setRemoteToken(event.target.value)}
              className="mt-2 h-11 w-full rounded-xl border border-border/70 bg-background/70 px-3 text-base text-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
              autoFocus
            />
            {remoteTokenError && <p className="mt-2 text-xs text-red-400" role="alert">{t("remoteAccessInvalid")}</p>}
            <button
              type="submit"
              disabled={remoteConnecting || !remoteToken.trim()}
              className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {remoteConnecting && <LoaderCircle className="size-4 animate-spin" />}
              {t("remoteConnect")}
            </button>
          </form>
        </div>
      )}

      {/* Mobile Header */}
      <div className={cn("mobile-topbar lg:hidden fixed top-0 left-0 right-0 z-50 bg-card/90 backdrop-blur-xl border-b border-border/50 flex items-center px-4 gap-3", terminalMaximized && "hidden")}>
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={mobileMenuOpen ? "关闭导航菜单" : "打开导航菜单"}
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 hover:bg-muted transition-colors focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <AppLogo className="size-5" />
          <span className="truncate font-semibold">{t("appName")}</span>
        </div>
        {isRemote && (
          <div className="ml-auto flex min-w-0 max-w-[48%] items-center gap-1.5 rounded-full border border-primary/20 bg-primary/8 px-2.5 py-1 text-[10px] font-semibold text-primary" title={isReadOnlyRemote ? t("remoteReadOnlyHint") : `${t("remoteServer")}: ${remoteBootstrap?.serverName ?? "Memory Forge"}`}>
            {isReadOnlyRemote ? <Eye className="size-3.5 shrink-0" /> : <Wifi className="size-3.5 shrink-0" />}
            <span className="truncate">{remoteBootstrap?.serverName ?? t("runtimeRemote")}</span>
          </div>
        )}
      </div>

      {/* Mobile Overlay */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <div
        className={cn(
          "mobile-shell-grid relative grid h-full gap-2.5 p-2.5 pt-[4.5rem] lg:pt-2.5 transition-[grid-template-columns] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
          terminalMaximized
            ? "lg:grid-cols-1 p-0 gap-0 pt-0 lg:pt-0"
            : sidebarCollapsed
              ? "lg:grid-cols-[68px_minmax(0,1fr)]"
              : "lg:grid-cols-[220px_minmax(0,1fr)]"
        )}
      >
        {/* Sidebar */}
        <aside
          className={cn(
            "mobile-sidebar panel-surface fixed inset-y-2.5 left-2.5 z-50 flex h-[calc(100vh-1.25rem)] w-[220px] flex-col overflow-hidden rounded-[24px] p-5 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] lg:static lg:h-full lg:translate-x-0",
            sidebarCollapsed ? "lg:w-auto lg:p-3" : "lg:w-auto lg:p-5",
            mobileMenuOpen ? "translate-x-0" : "-translate-x-full",
            terminalMaximized ? "hidden lg:hidden" : "flex"
          )}
        >
          <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_70%)]" />
          <div className="relative flex h-full min-h-0 flex-col">
            {/* Logo */}
            <div className={cn("flex items-center", sidebarCollapsed ? "justify-center" : "gap-3")}>
              <div className={cn(
                "flex items-center justify-center overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] select-none border border-white/5 bg-[#1C1917]",
                sidebarCollapsed
                  ? "size-10 rounded-[12px] shadow-md shadow-black/25"
                  : "size-12 rounded-[14px] shadow-lg shadow-black/20"
              )}>
                <AppLogo className={cn("transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]", sidebarCollapsed ? "size-10" : "size-12")} />
              </div>
              {!sidebarCollapsed && (
                <div className="animate-in fade-in slide-in-from-left-2 duration-300">
                  <p className="text-fine uppercase tracking-[0.24em] text-quiet">
                    Memory Forge
                  </p>
                  <h1 className="text-lg font-semibold">{t("appName")}</h1>
                </div>
              )}
            </div>

            {/* Navigation */}
            <nav className={cn("mt-6 space-y-2", sidebarCollapsed && "mt-4 space-y-1.5")}>
              {visibleNavigation.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    end={item.to === "/"}
                    to={item.to}
                    onClick={() => setMobileMenuOpen(false)}
                    title={sidebarCollapsed ? t(item.labelKey) : undefined}
                    className={({ isActive }) =>
                      cn(
                        "group flex items-center rounded-2xl text-sm font-medium transition-all duration-300 relative",
                        sidebarCollapsed
                          ? "justify-center px-2 py-3"
                          : "gap-3 px-4 py-3",
                        isActive
                          ? cn(
                              "theme-chip text-foreground shadow-md shadow-primary/5 border-l-[3px] border-l-primary rounded-l-none",
                              sidebarCollapsed ? "px-2" : "pl-[13px] pr-4"
                            )
                          : "text-quiet hover:bg-white/4 hover:text-foreground"
                      )
                    }
                  >
                    <Icon className="size-4 flex-shrink-0 transition-transform duration-300 group-hover:scale-110" />
                    {!sidebarCollapsed && (
                      <span className="animate-in fade-in slide-in-from-left-1 duration-300">{t(item.labelKey)}</span>
                    )}
                  </NavLink>
                );
              })}
            </nav>

            {/* Collapse Toggle and Version badge in a single, premium row */}
            {!sidebarCollapsed ? (
              <div className="mt-auto pt-4 border-t border-border/20 flex items-center justify-between gap-2">
                {/* Version badge on the left */}
                <button
                  onClick={() => { if (hasUpdate) { navigate("/about"); setMobileMenuOpen(false); } }}
                  className={cn(
                    "h-8 flex items-center gap-1.5 text-[11px] font-mono select-none px-2.5 rounded-xl border transition-all duration-300",
                    hasUpdate
                      ? "bg-amber-500/10 text-amber-400 border-amber-500/25 hover:bg-amber-500/15 cursor-pointer"
                      : "bg-muted/20 text-muted-foreground/50 border-border/10 cursor-default"
                  )}
                  title={hasUpdate ? t("updateAvailable") || "发现新版本！点击查看" : undefined}
                >
                  <span>v{snapshot?.version ?? "3.0.0"}</span>
                  {hasUpdate && <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />}
                </button>

                {/* Collapse button on the right - Enlarge and add text for easier target acquisition */}
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="h-8 px-3.5 rounded-xl flex items-center gap-1.5 text-xs text-quiet hover:bg-white/5 hover:text-foreground border border-border/10 hover:border-border/30 transition-all font-medium cursor-pointer shadow-sm active:scale-95"
                  title={t("sidebar.collapse") || "收起菜单"}
                >
                  <ChevronLeft className="size-3.5" />
                  <span>{t("editLog.collapse") || "收起"}</span>
                </button>
              </div>
            ) : (
              <div className="mt-auto flex flex-col items-center gap-3 pt-4 border-t border-border/20 w-full">
                {/* Expand button - Enlarge width to fill available space (up to 40px) */}
                <button
                  onClick={() => setSidebarCollapsed(false)}
                  className="relative h-8.5 w-full max-w-[40px] rounded-xl flex items-center justify-center text-quiet hover:bg-white/5 hover:text-foreground border border-border/20 hover:border-border/50 transition-all active:scale-95 cursor-pointer"
                  title={t("sidebar.expand") || "展开菜单"}
                >
                  <ChevronRight className="size-4.5" />
                  {hasUpdate && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                    </span>
                  )}
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* Main Content */}
        <main className={cn(
          "panel-surface relative min-h-0 min-w-0 overflow-hidden transition-all duration-500",
          terminalMaximized ? "rounded-none p-0 border-none m-0 h-full w-full bg-background" : "rounded-[24px] p-2 md:p-3"
        )}>
          <Suspense
            fallback={(
              <div className="flex h-full min-h-48 items-center justify-center" role="status" aria-live="polite">
                <div className="relative grid size-12 place-items-center">
                  <AppLogo className="size-8 motion-safe:animate-pulse" />
                  <LoaderCircle className="absolute size-12 animate-spin text-primary/35 motion-reduce:animate-none" />
                </div>
                <span className="sr-only">{t("loading")}</span>
              </div>
            )}
          >
            {remoteContentReady ? (
              <Outlet />
            ) : (
              <div className="flex h-full min-h-48 items-center justify-center" role="status" aria-live="polite">
                <div className="relative grid size-12 place-items-center">
                  <AppLogo className="size-8 motion-safe:animate-pulse" />
                  <LoaderCircle className="absolute size-12 animate-spin text-primary/35 motion-reduce:animate-none" />
                </div>
                <span className="sr-only">{t("loading")}</span>
              </div>
            )}
          </Suspense>
        </main>
      </div>

      <nav className={cn("mobile-bottom-nav lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-card/95 px-2 pt-2 backdrop-blur-2xl", terminalMaximized && "hidden")} aria-label="主导航">
        <div className="mx-auto grid max-w-lg grid-cols-5 gap-1">
          {mobileNavigationItems(visibleNavigation).map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                end={item.to === "/"}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) => cn(
                  "flex min-h-11 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1 text-[10px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary/60",
                  isActive ? "bg-primary/12 text-primary" : "text-quiet hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                <span className="max-w-full truncate">{t(item.labelKey)}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function mobileNavigationItems(
  visibleNavigation: Array<{ to: string; labelKey: MessageKey; icon: LucideIcon; navigationId?: string }>,
) {
  const primaryPlatform = visibleNavigation.find((item) => item.navigationId && item.to !== "/terminal-sessions");
  const secondaryPlatform = visibleNavigation.find(
    (item) => item.navigationId && item.to !== "/terminal-sessions" && item.to !== primaryPlatform?.to,
  );
  const platform = primaryPlatform ?? visibleNavigation.find((item) => item.to === "/terminal-sessions");
  const settings = visibleNavigation.find((item) => item.to === "/settings");
  const prompts = visibleNavigation.find((item) => item.to === "/prompts");
  const terminal = visibleNavigation.find((item) => item.to === "/terminal-sessions");
  const candidates = [
    visibleNavigation[0],
    platform,
    terminal ?? secondaryPlatform,
    prompts,
    settings,
  ].filter((item): item is { to: string; labelKey: MessageKey; icon: LucideIcon; navigationId?: string } => Boolean(item));
  return candidates.filter((item, index) => candidates.findIndex((candidate) => candidate.to === item.to) === index);
}

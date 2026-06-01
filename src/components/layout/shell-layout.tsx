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
  Pi,
} from "lucide-react";
import { AppLogo } from "@/components/logo";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useDesktop } from "@/features/desktop/provider";
import { api } from "@/features/desktop/api";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

const navigation = [
  { to: "/", labelKey: "dashboard" as const, icon: LayoutGrid },
  { to: "/claude", labelKey: "platformClaude" as const, icon: Bot, platformId: "claude" },
  { to: "/codex", labelKey: "platformCodex" as const, icon: Terminal, platformId: "codex" },
  { to: "/cursor", labelKey: "platformCursor" as const, icon: MousePointer2, platformId: "cursor" },
  { to: "/opencode", labelKey: "platformOpencode" as const, icon: Code, platformId: "opencode" },
  { to: "/kiro", labelKey: "platformKiro" as const, icon: Sparkles, platformId: "kiro" },
  { to: "/kiro-ide", labelKey: "platformKiroIde" as const, icon: Sparkles, platformId: "kiro-ide" },
  { to: "/gemini", labelKey: "platformGemini" as const, icon: Gem, platformId: "gemini" },
  { to: "/pi", labelKey: "platformPi" as const, icon: Pi, platformId: "pi" },
  { to: "/prompts", labelKey: "prompts" as const, icon: BookOpen },
  { to: "/settings", labelKey: "settings" as const, icon: Settings2 },
  { to: "/about", labelKey: "about" as const, icon: Info },
];

export default function ShellLayout() {
  const { snapshot, notice, error, t } = useDesktop();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [hasUpdate, setHasUpdate] = useState(false);

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

      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-50 h-14 bg-card/90 backdrop-blur-xl border-b border-border/50 flex items-center px-4 gap-3">
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center hover:bg-muted transition-colors"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
        <div className="flex items-center gap-2">
          <AppLogo className="size-5" />
          <span className="font-semibold">{t("appName")}</span>
        </div>
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
          "relative grid h-full gap-2.5 p-2.5 pt-[4.5rem] lg:pt-2.5 transition-[grid-template-columns] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
          sidebarCollapsed
            ? "lg:grid-cols-[68px_minmax(0,1fr)]"
            : "lg:grid-cols-[220px_minmax(0,1fr)]"
        )}
      >
        {/* Sidebar */}
        <aside
          className={cn(
            "panel-surface fixed inset-y-2.5 left-2.5 z-50 flex h-[calc(100vh-1.25rem)] w-[220px] flex-col overflow-hidden rounded-[24px] p-5 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] lg:static lg:h-full lg:translate-x-0",
            sidebarCollapsed ? "lg:w-auto lg:p-3" : "lg:w-auto lg:p-5",
            mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
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
              {navigation.filter((item) => {
                if (!item.platformId) return true;
                const visible = snapshot?.settings?.visiblePlatforms ?? ["claude", "codex", "cursor", "opencode"];
                return visible.includes(item.platformId);
              }).map((item) => {
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
        <main className="panel-surface relative min-h-0 min-w-0 overflow-hidden rounded-[24px] p-2 md:p-3">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

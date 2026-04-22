import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Info,
  LayoutGrid,
  Menu,
  Settings2,
  X,
  Bot,
  Terminal,
  Code,
  Sparkles,
  Gem,
} from "lucide-react";
import { AppLogo } from "@/components/logo";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useDesktop } from "@/features/desktop/provider";
import { api } from "@/features/desktop/api";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

const navigation = [
  { to: "/", labelKey: "dashboard" as const, icon: LayoutGrid },
  { to: "/claude", labelKey: "platformClaude" as const, icon: Bot },
  { to: "/codex", labelKey: "platformCodex" as const, icon: Terminal },
  { to: "/opencode", labelKey: "platformOpencode" as const, icon: Code },
  { to: "/kiro", labelKey: "platformKiro" as const, icon: Sparkles },
  { to: "/gemini", labelKey: "platformGemini" as const, icon: Gem },
  { to: "/prompts", labelKey: "prompts" as const, icon: BookOpen },
  { to: "/settings", labelKey: "settings" as const, icon: Settings2 },
  { to: "/about", labelKey: "about" as const, icon: Info },
];

export default function ShellLayout() {
  const { snapshot, notice, error, t } = useDesktop();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);

  useEffect(() => {
    api.checkUpdate().then(info => {
      if (info.hasUpdate) setHasUpdate(true);
    }).catch(() => {});
  }, []);

  return (
    <div className="bg-shell h-screen overflow-hidden text-foreground">
      <div className="subtle-grid pointer-events-none fixed inset-0" />

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
          "relative grid h-full gap-4 p-4 pt-[4.5rem] lg:pt-4 transition-[grid-template-columns] duration-300",
          sidebarCollapsed
            ? "lg:grid-cols-[72px_minmax(0,1fr)]"
            : "lg:grid-cols-[290px_minmax(0,1fr)]"
        )}
      >
        {/* Sidebar */}
        <aside
          className={cn(
            "panel-surface fixed inset-y-4 left-4 z-50 flex h-[calc(100vh-2rem)] w-[280px] flex-col overflow-hidden rounded-[32px] p-5 transition-all duration-300 lg:static lg:h-full lg:translate-x-0",
            sidebarCollapsed ? "lg:w-auto lg:p-3" : "lg:w-auto lg:p-6",
            mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.12),transparent_70%)]" />
          <div className="relative flex h-full min-h-0 flex-col">
            {/* Logo */}
            <div className={cn("flex items-center", sidebarCollapsed ? "justify-center" : "gap-3")}>
              <div className="flex size-12 items-center justify-center rounded-2xl ring-soft overflow-hidden">
                <AppLogo className="size-12" />
              </div>
              {!sidebarCollapsed && (
                <div>
                  <p className="text-fine uppercase tracking-[0.24em] text-quiet">
                    Memory Forge
                  </p>
                  <h1 className="text-lg font-semibold">{t("appName")}</h1>
                </div>
              )}
            </div>

            {/* Navigation */}
            <nav className={cn("mt-6 space-y-2", sidebarCollapsed && "mt-4 space-y-1")}>
              {navigation.map((item) => {
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
                        "flex items-center rounded-2xl text-sm transition",
                        sidebarCollapsed
                          ? "justify-center px-2 py-3"
                          : "gap-3 px-4 py-3",
                        isActive
                          ? "theme-chip text-foreground"
                          : "text-quiet hover:bg-white/5 hover:text-foreground"
                      )
                    }
                  >
                    <Icon className="size-4 flex-shrink-0" />
                    {!sidebarCollapsed && t(item.labelKey)}
                  </NavLink>
                );
              })}
            </nav>

            {/* Notices */}
            {!sidebarCollapsed && (
              <div className="mt-6 space-y-3">
                {notice && (
                  <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
                    {notice}
                  </div>
                )}
                {error && (
                  <div className="rounded-2xl border border-destructive/30 bg-destructive/12 px-4 py-3 text-sm text-red-100">
                    {t("saveError")}: {error}
                  </div>
                )}
              </div>
            )}

            {/* Collapse Toggle (desktop only) */}
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="mt-auto hidden lg:flex items-center justify-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-quiet hover:bg-white/5 hover:text-foreground transition"
              title={sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            >
              {sidebarCollapsed ? (
                <ChevronRight className="size-4" />
              ) : (
                <>
                  <ChevronLeft className="size-4" />
                  <span className="text-fine">{t("sidebar.collapse")}</span>
                </>
              )}
            </button>

            {/* Version */}
            {!sidebarCollapsed ? (
              <button
                onClick={() => { if (hasUpdate) { navigate("/about"); setMobileMenuOpen(false); } }}
                className={cn(
                  "mt-3 flex items-center justify-center gap-1.5 text-fine",
                  hasUpdate ? "cursor-pointer text-amber-400 hover:text-amber-300 transition-colors" : "text-quiet cursor-default"
                )}
              >
                <span>v{snapshot?.version ?? "3.0.0"}</span>
                {hasUpdate && <span className="size-2 rounded-full bg-amber-400 animate-pulse" />}
              </button>
            ) : hasUpdate ? (
              <button
                onClick={() => { navigate("/about"); setMobileMenuOpen(false); }}
                className="mt-3 flex justify-center"
                title={t("updateAvailable")}
              >
                <span className="size-2.5 rounded-full bg-amber-400 animate-pulse" />
              </button>
            ) : null}
          </div>
        </aside>

        {/* Main Content */}
        <main className="panel-surface relative min-h-0 min-w-0 overflow-hidden rounded-[32px] p-5 lg:p-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

import {
  BadgeCheck,
  BookOpen,
  Flame,
  Info,
  LayoutGrid,
  Menu,
  Settings2,
  X,
  Bot,
  Terminal,
  Code,
} from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { getThemeSpec } from "@/features/desktop/catalog";
import { useDesktop } from "@/features/desktop/provider";
import { cn } from "@/lib/utils";
import { useState } from "react";

const navigation = [
  { to: "/", labelKey: "dashboard" as const, icon: LayoutGrid },
  { to: "/claude", labelKey: "platformClaude" as const, icon: Bot },
  { to: "/codex", labelKey: "platformCodex" as const, icon: Terminal },
  { to: "/opencode", labelKey: "platformOpencode" as const, icon: Code },
  { to: "/prompts", labelKey: "prompts" as const, icon: BookOpen },
  { to: "/settings", labelKey: "settings" as const, icon: Settings2 },
  { to: "/about", labelKey: "about" as const, icon: Info },
];

export default function ShellLayout() {
  const { snapshot, loading, saving, notice, error, t } = useDesktop();
  const currentTheme = snapshot ? getThemeSpec(snapshot.settings.theme) : null;
  const locale = snapshot?.settings.locale ?? "zh-CN";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
          <Flame className="w-5 h-5 text-primary" />
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

      <div className="relative grid h-full gap-4 p-4 pt-[4.5rem] lg:grid-cols-[290px_minmax(0,1fr)] lg:pt-4">
        {/* Sidebar */}
        <aside
          className={cn(
            "panel-surface fixed inset-y-4 left-4 z-50 flex h-[calc(100vh-2rem)] w-[280px] flex-col overflow-hidden rounded-[32px] p-5 transition-transform duration-300 lg:static lg:h-full lg:w-auto lg:translate-x-0 lg:p-6",
            mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <div className="absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.12),transparent_70%)]" />
          <div className="relative flex h-full min-h-0 flex-col">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary ring-soft">
                <Flame className="size-5" />
              </div>
              <div>
                <p className="text-fine uppercase tracking-[0.24em] text-quiet">
                  Memory Forge
                </p>
                <h1 className="text-lg font-semibold">{t("appName")}</h1>
              </div>
            </div>

            {/* Status */}
            <div className="mt-6 rounded-[24px] border border-border/80 bg-black/10 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-quiet">{t("runtime")}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/14 px-2.5 py-1 text-fine text-primary">
                  <BadgeCheck className="size-3.5" />
                  {loading ? t("loading") : t("ready")}
                </span>
              </div>
            </div>

            {/* Navigation */}
            <nav className="mt-6 space-y-2">
              {navigation.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    end={item.to === "/"}
                    to={item.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition",
                        isActive
                          ? "theme-chip text-foreground"
                          : "text-quiet hover:bg-white/5 hover:text-foreground"
                      )
                    }
                  >
                    <Icon className="size-4" />
                    {t(item.labelKey)}
                  </NavLink>
                );
              })}
            </nav>

            {/* Notices */}
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

            {/* Footer Info */}
            <div className="mt-auto rounded-[24px] border border-border/80 bg-black/10 p-4">
              <div className="flex items-center justify-between">
                <span className="text-fine uppercase tracking-[0.24em] text-quiet">
                  {t("runtime")}
                </span>
                <span className="text-sm">
                  {snapshot?.runtime === "tauri" ? t("runtimeTauri") : t("runtimeWebPreview")}
                </span>
              </div>
              <div className="mt-3 space-y-2 text-sm text-quiet">
                <div className="flex items-center justify-between gap-3">
                  <span>{t("currentTheme")}</span>
                  <span className="text-foreground">
                    {currentTheme?.label[locale] ?? "-"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{t("currentLanguage")}</span>
                  <span className="text-foreground">{snapshot?.settings.locale ?? "-"}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>{snapshot?.trayAvailable ? t("trayReady") : t("trayUnavailable")}</span>
                  <span className="text-foreground">{saving ? "Syncing..." : "Idle"}</span>
                </div>
              </div>
              <p className="mt-3 text-fine text-quiet">v{snapshot?.version ?? "3.0.0"}</p>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="panel-surface relative min-h-0 overflow-hidden rounded-[32px] p-5 lg:p-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
